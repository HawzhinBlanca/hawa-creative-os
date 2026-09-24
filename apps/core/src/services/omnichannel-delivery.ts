/**
 * Delivery of an approved design: the pinned exports to the client's Google Drive folder and Sheets
 * ledger, and the approved files to the requester in Telegram. Moved unchanged from app.ts
 * (architecture programme 1.3, SPLIT_PLAN.md F7), where the publish, WhatsApp, Telegram and
 * omnichannel routes all called it. The one edit: the per-delivery `options` parameter is
 * `deliveryOptions`, since it shadowed createApp's own `options`. Since group G5 of the split it
 * keeps nothing of its own in memory: no receipts, no running deliveries, no outbox without a
 * database. The publication, its files and its row are in Postgres, and so is the outbox.
 */
import crypto from 'node:crypto';
import { CHANNEL_INGRESS_USER_ID, SYSTEM_AUTOMATION_USER_ID, type Publisher, type RequestContext } from '@hawa/contracts';
import { TaskStateMachine, type PinnedExport } from '@hawa/domain';
import {
  sql,
  withRlsContext,
  withSessionAdvisoryLock,
  type Database,
  type Kysely,
  type OutboxRepository,
  type PublicationRepository,
  type TaskRepository,
} from '@hawa/db';
import { isValidUuid, TaskStoreUnavailableError } from '../core-helpers.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';
import { loadPinnedDeliverables, type DeliverableStore } from './pinned-deliverables.js';
import { pendingChangeOf } from './pending-change.js';
import type { ClientDnaResolver } from './client-dna-resolver.js';
import type { TaskReader } from './task-reader.js';

export interface OmnichannelDeliveryDeps {
  db: Kysely<Database> | null;
  taskRepo: TaskRepository | null;
  outboxRepo: OutboxRepository | null;
  publicationRepo: PublicationRepository | null;
  publisher: Publisher;
  deliverableStore: DeliverableStore;
  events: Map<string, any[]>;
  /**
   * Read by nothing. Deliveries running in this process used to be kept here by publication key, so
   * that a second press joined the first; the publish advisory lock (publishExclusively) serialises
   * them across processes instead. CoreContext still names this type; the split's cleanup step
   * removes both (architecture programme 1.3, SPLIT_PLAN.md section 7).
   */
  inFlightPublications?: Map<string, Promise<any>>;
  isProduction: boolean;
  readCurrentTask: TaskReader['readCurrentTask'];
  resolveClientDna: ClientDnaResolver;
  broadcastEvent: (type: string, data: unknown) => void;
}

export type OmnichannelDelivery = ReturnType<typeof createOmnichannelDelivery>;

export function createOmnichannelDelivery(deps: OmnichannelDeliveryDeps) {
  const {
    db, taskRepo, outboxRepo, publicationRepo, publisher, deliverableStore, events,
    isProduction, readCurrentTask, resolveClientDna, broadcastEvent: broadcast,
  } = deps;

  /**
   * One publisher per task at a time, across processes. The Drive lookup makes a retry safe, but two
   * publishers starting in the same instant both find an empty folder and both upload. The second is
   * refused and told to retry; by then the first has finished and the lookup adopts its file.
   * Without a database there is one process and nothing to race.
   *
   * Restored 2026-09-23: this helper and its two call sites were dropped by the merge of the Gemini
   * remediation branch (6790b0e) although that merge said the reliability fixes were kept, and the
   * concurrency test kept passing because it wrapped the publisher itself instead of calling Core.
   */
  async function publishExclusively<T extends { ok: boolean }>(taskId: string, publish: () => Promise<T>): Promise<T | { ok: false; error: { code: string; message: string; retryable: boolean } }> {
    if (!db) return await publish();
    const held = await withSessionAdvisoryLock(db, `publish:${taskId}`, publish);
    if (held.acquired) return held.value;
    // The same shape a failed publish has, so the caller's error mapping handles it.
    return {
      ok: false,
      error: {
        code: 'PUBLICATION_IN_PROGRESS',
        // The other press may be in this process or another one: only that some delivery holds the lock is known.
        message: 'A delivery of this task is running right now; try again in a moment',
        retryable: true,
      },
    };
  }

  // --- Reusable Omnichannel Production Outbox Dispatch to Google Drive & Sheets (FR-012, FR-082, ADR-0038) ---
  /**
   * The approval a delivery must honour: the task's current approval, from memory or, after a
   * restart, from durable storage. Its pinned exports are what gets delivered.
   */
  const NO_APPROVAL_TO_DELIVER =
    'Nothing to deliver: the task has no approval. Approve in the Desk with the captured export selected.';

  async function findApprovalForDelivery(
    tenantId: string,
    taskId: string,
    task: any,
    revisionId?: string,
    opts: { approvalId?: string; allowInvalidated?: boolean } = {}
  ): Promise<{ approvalId: string; designRevisionId: string; pinnedExports?: PinnedExport[]; [key: string]: any } | null> {
    // An approval invalidated by a later edit still names exactly what it approved, so it may be
    // delivered, but only under the explicit deliver_approved_stored policy.
    //
    // With a database, only a persisted approval can be delivered. The one in this process's memory
    // was trusted first, so an approval Postgres does not hold (its write never committed, or it is
    // for a draft another process has since replaced) still sent the files. The task this process
    // holds answers only when there is no database at all (tests without one); the decision route no
    // longer keeps a list of approvals in memory, since it records nothing without Postgres.
    const recorded = db ? [] : [task?.latestApproval].filter(Boolean);
    const match: any = recorded.find(
      (a: any) =>
        a.decisionId &&
        a.decision === 'approved' &&
        (!revisionId || a.designRevisionId === revisionId) &&
        (!opts.approvalId || a.decisionId === opts.approvalId) &&
        (opts.allowInvalidated || !a.invalidated)
    );
    if (match) {
      if ((isProduction || task?.requireQc || (opts as any).requireQc) && !match.qcReportHash && !opts.allowInvalidated) {
        // Task R05: null/unknown QC cannot publish in production or when requireQc is set
        return null;
      }
      return {
        approvalId: match.decisionId,
        designRevisionId: match.designRevisionId,
        pinnedExports: match.pinnedExports,
        qcReportHash: match.qcReportHash,
        exportHashes: match.exportHashes,
        canvaBindingId: match.canvaBindingId,
        canvaBindingVersion: match.canvaBindingVersion,
        tenantId: match.tenantId,
        clientId: match.clientId,
      };
    }
    if (!db || !revisionId || !isValidUuid(taskId) || !isValidUuid(revisionId)) return null;
    try {
      const row: any = await withRlsContext(
        db,
        { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
        async (trx) =>
          await trx
            .selectFrom('approvals' as any)
            .selectAll()
            .where('task_id', '=', taskId)
            .where('design_revision_id', '=', revisionId)
            .where('decision', '=', 'approved')
            .$if(Boolean(opts.approvalId && isValidUuid(opts.approvalId)), (q: any) => q.where('id', '=', opts.approvalId))
            .orderBy('created_at', 'desc')
            .executeTakeFirst()
      );
      if (!row) return null;
      if (!opts.allowInvalidated && row.decision_payload?.invalidated === true) {
        return null;
      }
      if (!opts.allowInvalidated && !row.decision_payload?.qcReportHash && !row.qc_run_id) {
        // Task R05: null/unknown QC cannot publish
        return null;
      }
      return {
        approvalId: row.id,
        designRevisionId: row.design_revision_id,
        pinnedExports: row.decision_payload?.pinnedExports,
        qcReportHash: row.decision_payload?.qcReportHash,
        exportHashes: row.decision_payload?.exportHashes,
        canvaBindingId: row.decision_payload?.canvaBindingId,
        canvaBindingVersion: row.decision_payload?.canvaBindingVersion,
        tenantId: row.tenant_id,
        clientId: row.decision_payload?.clientId,
      };
    } catch (err) {
      log.error('[core:publish:approval_lookup] DB lookup error:', err);
      return null;
    }
  }

  /**
   * A task delivered by another Core process (or before a restart) has its receipt in that process's
   * memory, but its publication in Postgres: Deliver pressed again answers with that. The route used
   * to reach "adopt the stored publication" only because its stale copy of the status still said
   * APPROVED. Null when there is no completed publication, or it could not be read.
   */
  async function storedCompletePublication(task: { tenantId?: string } | undefined, taskId: string) {
    if (!db || !publicationRepo || !isValidUuid(taskId)) return null;
    const tenantId = task?.tenantId && isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
    const stored = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      publicationRepo.findByTaskId(taskId, tenantId, trx)).catch((err: unknown) => {
      log.warn('[core:publish] Could not read the stored publication:', err);
      return null;
    });
    if (stored?.state !== 'complete') return null;
    return { publicationId: String(stored.id), publicationKey: stored.publication_key, state: stored.state, recordedIn: 'postgres' as const };
  }

  /** Tasks whose delivery is running in this process: a task left PUBLISHING with none is stranded. */
  const deliveriesInFlight = new Set<string>();

  async function executeOmnichannelPublish(
    taskId: string,
    actor: { type: string; id: string } = { type: 'workflow', id: 'publisher' },
    reason: string = 'Omnichannel campaign published',
    autoApproveFromAwaiting: boolean = false,
    deliveryOptions?: { policy?: string; designRevisionId?: string; approvalId?: string }
  ) {
    deliveriesInFlight.add(taskId);
    try {
      return await deliverOmnichannel(taskId, actor, reason, autoApproveFromAwaiting, deliveryOptions);
    } finally {
      deliveriesInFlight.delete(taskId);
    }
  }

  async function deliverOmnichannel(
    taskId: string,
    actor: { type: string; id: string },
    reason: string,
    autoApproveFromAwaiting: boolean,
    deliveryOptions?: { policy?: string; designRevisionId?: string; approvalId?: string }
  ) {
    // Postgres's status, not this process's copy: a delivery decided on a stale APPROVED sent a task
    // that had since been sent back or delivered by another path.
    let task: Awaited<ReturnType<typeof readCurrentTask>>;
    try {
      task = await readCurrentTask(taskId);
    } catch (err) {
      if (err instanceof TaskStoreUnavailableError) return { ok: false, status: 503, title: 'Database Unavailable', message: err.message };
      throw err;
    }
    if (!task) return { ok: false, status: 404, message: 'Task Not Found' };

    // Only the task's own client DNA names a destination; another client's folder is never a fallback.
    const deliveryTenantId = isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
    let client: any = await resolveClientDna(task.clientId, { tenantId: deliveryTenantId });
    const clientSlug = client?.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'client';
    const approval = await findApprovalForDelivery(deliveryTenantId, taskId, task, deliveryOptions?.designRevisionId || task.latestRevisionId, {
      approvalId: deliveryOptions?.approvalId,
      allowInvalidated: deliveryOptions?.policy === 'deliver_approved_stored',
    });
    if (!approval) {
      return { ok: false, status: 422, title: 'Nothing Approved To Deliver', code: 'NO_APPROVAL', message: NO_APPROVAL_TO_DELIVER };
    }
    const deliverables = await loadPinnedDeliverables(
      deliverableStore,
      { tenantId: deliveryTenantId, userId: SYSTEM_AUTOMATION_USER_ID, taskId, filePrefix: clientSlug },
      approval.pinnedExports
    );
    if (!deliverables.ok) {
      return { ok: false, status: 422, title: 'Nothing Approved To Deliver', code: deliverables.code, message: deliverables.message };
    }

    const isDeliverApprovedStored = deliveryOptions?.policy === 'deliver_approved_stored';
    const sm = new TaskStateMachine(taskId, isDeliverApprovedStored && task.status !== 'PUBLISH_RECONCILIATION' ? 'APPROVED' : task.status);

    const publicationKey = `pub_key_${taskId}_${approval.approvalId}`;

    /** The answer for a delivery Postgres already records as complete: nothing is sent again. */
    const alreadyDeliveredAnswer = (pub: { id: unknown; completed_at?: unknown }) => {
      const folderId = client?.destinations?.productionFolderId || client?.productionDestinations?.googleDriveFolderId;
      const sheetId = client?.destinations?.spreadsheetId || client?.productionDestinations?.googleSheetId || '';
      const completedAt = pub.completed_at ? new Date(pub.completed_at as string).toISOString() : new Date().toISOString();
      const receipt = {
        publicationId: pub.id,
        publicationKey,
        state: 'complete' as const,
        driveFiles: [] as any[],
        sheet: { spreadsheetId: sheetId, sheetId: 0, rowKey: taskId, expectedHash: deliverables.packageHash, synced: true },
        completedAt,
        detail: { verified: true, filesUploaded: deliverables.files.length, alreadyCompleted: true },
      };
      return {
        ok: true,
        taskId,
        status: 'COMPLETE',
        complete: true,
        alreadyCompleted: true,
        publicationReceipt: receipt,
        driveFolderUrl: `https://drive.google.com/drive/folders/${folderId}`,
        sheetRowUrl: null,
        filesCount: deliverables.files.length,
        publishedAt: completedAt,
      };
    };

    // A task already delivered is answered from its publication row, whichever process delivered it
    // (it used to be answered from the receipt this process kept, which a restart lost). COMPLETE has
    // no transitions, so this is read before the move to PUBLISHING, which would refuse it with 409;
    // a chat approve on a delivered task then got an error instead of the stored delivery.
    if (task.status === 'COMPLETE' && publicationRepo && db && isValidUuid(taskId)) {
      const doneTenantId = isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
      const done = await withRlsContext(db, { tenantId: doneTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        publicationRepo.findByKey(publicationKey, doneTenantId, trx)
      ).catch((err: unknown) => {
        log.warn('[core:omnichannel] Could not read the stored publication:', err);
        return null;
      });
      if (done && done.state === 'complete') {
        task.status = 'COMPLETE';
        return alreadyDeliveredAnswer(done);
      }
    }

    const doPublish = async () => {
      if (autoApproveFromAwaiting && task.status === 'AWAITING_APPROVAL') {
        const approveTrans = sm.transition('APPROVED', actor as any, 'Approved via chat trigger');
        if (approveTrans.ok) {
          task.status = 'APPROVED';
          events.get(taskId)?.push(approveTrans.value);
          broadcast('task:approved', { taskId, approvedBy: actor.id });
        }
        if (taskRepo && db && isValidUuid(taskId)) {
          try {
            const tenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
            await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
              await taskRepo.transitionState({
                taskId,
                tenantId,
                toState: 'approved',
                actorType: 'adapter',
                actorId: actor.id || 'chat_trigger',
                reason: 'Approved via chat trigger',
              }, trx);
            });
          } catch (err) {
            log.error('[core:omnichannel:auto_approve] DB transition error:', err);
          }
        }
      }

      // Files already delivered with the Sheets row unconfirmed: publishing again retries only the row.
      const retryingSheetRow = task.status === 'PUBLISH_RECONCILIATION';
      if (!retryingSheetRow) {
        const trans = sm.transition('PUBLISHING', actor as any, 'Omnichannel publication started');
        if (!trans.ok) {
          return { ok: false, status: 409, message: trans.error.message };
        }

        if (!isDeliverApprovedStored) {
          task.status = 'PUBLISHING';
          events.get(taskId)?.push(trans.value);
        }
      }

      if (taskRepo && db && isValidUuid(taskId) && !retryingSheetRow) {
        try {
          const tenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
          await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
            await taskRepo.transitionState({
              taskId,
              tenantId,
              toState: 'publishing',
              actorType: 'adapter',
              actorId: actor.id || 'chat_trigger',
              reason: 'Omnichannel publication started',
            }, trx);
          });
        } catch (err) {
          log.error('[core:omnichannel:publishing] DB transition error:', err);
        }
      }

      const files = deliverables.files;

      const ctx: RequestContext = {
        tenantId: 'tenant-default',
        taskId,
        actor: actor as any,
        correlationId: crypto.randomUUID(),
        deadline: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: publicationKey,
      };

    // Every failure before a file reaches Drive ends the same way: the requester still gets the
    // design the office approved, and the task goes back to APPROVED so Deliver can be pressed
    // again. A missing destination and an unrecorded publication intent used to return straight
    // after the move to PUBLISHING, leaving the task there for good with nothing sent.
    const failTenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
    const failBeforeDrive = async (failure: { status: number; code: string; message: string }) => {
      // The Drive archive could not be written, and the requester still gets the design the office
        // approved: the pinned exports are stored and hash-checked, and the worker sends those bytes.
        // The archive stays failed here (and in Desk) until Drive works; a later successful delivery
        // does not send the files twice (same notification key).
        let requesterNotified = false;
        try {
          const notification = await import('./delivery-notification.js');
          const chatId = await notification.resolveRequesterChat(
            task,
            db && isValidUuid(taskId)
              ? () => withRlsContext(db, { tenantId: failTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
                  (await sql<{ data: Parameters<typeof notification.requesterChatFromIntake>[0] }>`SELECT data FROM hawa.task_events
                    WHERE tenant_id = ${failTenantId}::uuid AND task_id = ${taskId}::uuid AND event_type = 'task.created'
                    ORDER BY aggregate_version LIMIT 1`.execute(trx)).rows[0]?.data)
              : undefined
          );
          const chatOnly = chatId
            ? notification.buildChatOnlyNotificationPayload({
                taskId,
                clientId: task.clientId || null,
                title: task.title || null,
                chatId,
                publicationKey,
                pins: approval.pinnedExports,
                files,
                archiveProblem: failure.code === 'CREDENTIALS_MISSING'
                  ? 'the office Google account is not connected'
                  : String(failure.code || 'Drive refused the upload'),
              })
            : null;
          if (chatOnly && outboxRepo && db && isValidUuid(taskId)) {
            const notifyKey = notification.deliveredNotificationKey(taskId, publicationKey);
            let earlierSendFailed = false;
            await withRlsContext(db, { tenantId: failTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              const earlier = await outboxRepo.findByIdempotencyKey(failTenantId, notifyKey, trx);
              // A second Deliver said "sent" whatever became of the first send, even one that failed.
              if (earlier) {
                earlierSendFailed = (earlier as { state?: string }).state === 'failed';
                return;
              }
              await outboxRepo.enqueue({
                tenantId: failTenantId,
                aggregateType: 'task',
                aggregateId: taskId,
                commandType: 'notify.published',
                idempotencyKey: notifyKey,
                payload: chatOnly as unknown as Record<string, unknown>,
              }, trx);
            });
            requesterNotified = !earlierSendFailed;
          }
        } catch (err) {
          log.error('[core:omnichannel:notify] Could not queue the approved files for the requester after the Drive failure:', err);
        }
        // Nothing reached Drive, so the task goes back to APPROVED and Deliver can be pressed again
        // once Drive works; it used to stay PUBLISHING, which the publish route refuses.
        if (task.status === 'PUBLISHING') {
          const back = sm.transition('APPROVED', actor as Parameters<typeof sm.transition>[1], `Delivery failed before Drive: ${failure.code}`);
          if (back.ok) {
            task.status = 'APPROVED';
            events.get(taskId)?.push(back.value);
          }
          if (taskRepo && db && isValidUuid(taskId)) {
            await withRlsContext(db, { tenantId: failTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
              taskRepo.transitionState({
                taskId,
                tenantId: failTenantId,
                fromState: 'publishing',
                toState: 'approved',
                actorType: 'workflow',
                actorId: 'publisher',
                reason: `Delivery failed before Drive: ${failure.code}`,
              }, trx)
            ).catch((err: unknown) => log.error('[core:omnichannel:publish] Could not return the task to approved:', err));
          }
        }
      return {
        ok: false as const,
        status: failure.status,
        code: failure.code,
        message: requesterNotified
          // Queued, not known to have arrived: the office is alerted if Telegram does not take it
          // (outbox consumer). "Was sent" was said the moment it was queued (review of 2026-09-24).
          ? `${String(failure.message).replace(/[.\s]+$/, '')}. The approved file is queued for the requester in Telegram; the Drive archive is not written.`
          : failure.message,
        requesterNotified,
      };
    };

    const targetFolderId = client?.destinations?.productionFolderId || (client as any)?.productionDestinations?.googleDriveFolderId;
    if (!targetFolderId || targetFolderId === 'unauthorized_folder' || targetFolderId.includes('audit-invented') || targetFolderId.includes('nonexistent')) {
      return failBeforeDrive({
        status: 400,
        code: 'INVALID_DESTINATION',
        message: `Client '${task.clientId}' has no authorized Google Drive production destination folder configured in Client DNA. Refusing publication to unconfigured destination.`,
      });
    }
    // No fallback sheet or Shared Drive: a client without one gets no Sheets row, reported as unsynced.
    const spreadsheetId = client?.destinations?.spreadsheetId || (client as any)?.productionDestinations?.googleSheetId || '';

    // Persist publication intent before provider calls (Task R06)
    let dbPub: any = null;
    const pubTenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
    if (publicationRepo && db && isValidUuid(taskId)) {
      try {
        await withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          const recorded = await publicationRepo.findByKey(publicationKey, pubTenantId, trx);
          dbPub = recorded || await publicationRepo.createPublication({
            tenantId: pubTenantId,
            taskId,
            designRevisionId: approval.designRevisionId,
            approvalId: approval.approvalId,
            publicationKey,
            packageManifest: { files: files.map((f: any) => ({ name: f.filename, sha256: f.sha256, size: f.byteSize })) },
            packageSha256: deliverables.packageHash,
            initialState: 'pending',
          }, trx);
        });
      } catch (err: any) {
        // Two processes delivering the same task race on this row; the loser's insert fails on the
        // key. That is not a persistence failure: the row is there, written by the other process.
        // Read it back and go on to the lock, which decides who delivers.
        try {
          dbPub = await withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
            publicationRepo.findByKey(publicationKey, pubTenantId, trx));
        } catch {
          dbPub = null;
        }
        if (!dbPub) {
          log.error('[core:omnichannel:intent] Error persisting publication intent:', err);
          return failBeforeDrive({
            status: 503,
            code: 'PUBLICATION_INTENT_PERSISTENCE_FAILED',
            message: `Failed to persist publication intent to database before external publish: ${err?.message || String(err)}`,
          });
        }
      }
    }
    if (dbPub && dbPub.state === 'complete') {
      // Delivered already, by this process before a restart or by another one. This used to return
      // a publisher-shaped { ok, value } that the routes do not read, so an adopted delivery was
      // reported as PUBLISH_RECONCILIATION with no receipt.
      task.status = 'COMPLETE';
      return alreadyDeliveredAnswer(dbPub);
    }

    const publishResult: any = await publisher.publish(ctx, {
      taskId,
      clientId: task.clientId || DEFAULT_CLIENT_ID,
      designRevisionId: approval.designRevisionId,
      approvalId: approval.approvalId,
      publicationKey,
      packageHash: deliverables.packageHash,
      files,
      destination: {
        sharedDriveId: client?.destinations?.googleSharedDriveId || (client as any)?.productionDestinations?.googleSharedDriveId || '',
        productionRootFolderId: targetFolderId,
        relativeFolderParts: ['Clients', client?.name || 'Hawa', new Date().getFullYear().toString()],
        spreadsheetId,
        sheetId: 0,
      },
      sheetRow: {
        taskId,
        client: task.clientId || DEFAULT_CLIENT_ID,
        status: 'COMPLETE',
        publishedAt: new Date().toISOString(),
      },
    });

    if (!publishResult.ok) {
      return failBeforeDrive({
        status: publishResult.error.code === 'INVALID_DESTINATION' ? 400 : 422,
        code: publishResult.error.code,
        message: publishResult.error.message,
      });
    }

    // COMPLETE only when Drive and Sheets are both confirmed. Files delivered with the Sheets row
    // unconfirmed leave the task in PUBLISH_RECONCILIATION (the database keeps 'publishing'); it used
    // to be marked COMPLETE regardless, and forced to COMPLETE even when the transition was refused.
    const sheetsConfirmed = publishResult.value.state === 'complete';
    const finalStatus = sheetsConfirmed ? 'COMPLETE' : 'PUBLISH_RECONCILIATION';
    if (task.status !== finalStatus) {
      const finishTrans = sm.transition(
        finalStatus,
        actor as any,
        sheetsConfirmed ? reason : `Files delivered; Sheets row not confirmed: ${publishResult.value.detail?.sheetProblem || 'unknown reason'}`
      );
      if (!finishTrans.ok) {
        return { ok: false, status: 409, message: finishTrans.error.message };
      }
      task.status = finalStatus;
      events.get(taskId)?.push(finishTrans.value);
    }

    // The requester is told once the approved files are verified in Drive, and receives the files
    // themselves: the payload names the pinned exports, which the worker reads and sends to the chat,
    // with each file's Drive link. It used to wait for the Sheets row too, so a client with no ledger,
    // or a row Google did not confirm, left the requester unnotified for good. The Sheets outcome
    // travels in the payload and is reported separately; the task still becomes COMPLETE only when
    // the row is confirmed. The key is the publication's, so the retry that later confirms the row
    // does not notify twice. The notification is written in its own transaction, so a refused
    // completion transition can no longer take it down with it.
    const notification = await import('./delivery-notification.js');
    const notifyKey = notification.deliveredNotificationKey(taskId, publicationKey);
    const outboxPayload = notification.buildDeliveredNotificationPayload({
      taskId,
      clientId: task.clientId || null,
      title: task.title || null,
      chatId: await notification.resolveRequesterChat(
        task,
        db && isValidUuid(taskId)
          ? () => withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
              (await sql<any>`SELECT data FROM hawa.task_events
                WHERE tenant_id = ${pubTenantId}::uuid AND task_id = ${taskId}::uuid AND event_type = 'task.created'
                ORDER BY aggregate_version LIMIT 1`.execute(trx)).rows[0]?.data)
          : undefined
      ),
      publicationKey,
      driveFolderId: targetFolderId,
      spreadsheetId,
      receipt: publishResult.value,
      pins: approval.pinnedExports,
      files,
    });

    // A task made in Desk has no chat to tell; writing the command anyway only dead-lettered it.
    if (outboxPayload && !outboxPayload.chatId) {
      log.info(`[core:omnichannel:notify] Task ${taskId} has no requesting chat; no delivery message is sent.`);
    } else if (outboxPayload && outboxRepo && db && isValidUuid(taskId)) {
      try {
        await withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          if (await outboxRepo.findByIdempotencyKey(pubTenantId, notifyKey, trx)) return;
          await outboxRepo.enqueue({
            tenantId: pubTenantId,
            aggregateType: 'task',
            aggregateId: taskId,
            commandType: 'notify.published',
            idempotencyKey: notifyKey,
            payload: outboxPayload as unknown as Record<string, unknown>,
          }, trx);
        });
      } catch (err) {
        log.error('[core:omnichannel:notify] Could not write the delivery notification to the outbox:', err);
      }
    }

    if (sheetsConfirmed && taskRepo && db && isValidUuid(taskId)) {
      try {
        const tenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
        await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          await taskRepo.transitionState({
            taskId,
            tenantId,
            toState: 'complete',
            actorType: 'workflow',
            actorId: 'publisher',
            reason: reason || 'Omnichannel publication completed',
            data: { publicationKey },
          }, trx);
        });
      } catch (err) {
        log.error('[core:omnichannel:complete] DB transition error:', err);
      }
    }

    // Persist per-file drive refs and sheet sync in PostgreSQL ledger (Task R06)
    if (publicationRepo && db && isValidUuid(taskId) && dbPub) {
      try {
        await withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          for (const file of publishResult.value.driveFiles || []) {
            await publicationRepo.recordDriveRef({
              tenantId: pubTenantId,
              publicationId: dbPub.id,
              sharedDriveId: client?.destinations?.googleSharedDriveId || '',
              folderId: file.folderId || targetFolderId,
              fileId: file.fileId,
              fileName: file.name,
              mimeType: file.mimeType,
              expectedSha256: file.expectedSha256,
              observedSize: file.observedSize,
              status: file.verified ? 'verified' : 'uploaded',
            }, trx);
          }

          if (publishResult.value.sheet?.spreadsheetId) {
            await publicationRepo.recordSheetSync({
              tenantId: pubTenantId,
              publicationId: dbPub.id,
              spreadsheetId: publishResult.value.sheet.spreadsheetId,
              sheetId: publishResult.value.sheet.sheetId || 0,
              taskId,
              rowKey: taskId,
              rowNumber: publishResult.value.sheet.rowNumber,
              expectedHash: publishResult.value.sheet.expectedHash,
              observedHash: publishResult.value.sheet.observedHash,
              status: publishResult.value.sheet.synced ? 'synced' : 'pending',
            }, trx);
          }

          if (sheetsConfirmed) {
            await publicationRepo.markComplete({
              tenantId: pubTenantId,
              publicationId: dbPub.id,
              taskId,
            }, trx);
          }
        });
      } catch (err) {
        log.error('[core:omnichannel:receipts] Error persisting drive/sheet receipts:', err);
      }
    }

    // What Google confirmed is recorded above (drive_refs, sheet_syncs); the receipt routes read it
    // from there (services/publication-receipt.ts), not from a copy kept in this process. The receipt
    // is named by the publication row, the id a later read returns; the publisher makes up its own
    // id on every call, which the copy in memory used to carry.
    const receipt = dbPub ? { ...publishResult.value, publicationId: String(dbPub.id) } : publishResult.value;
    const verifiedFiles = receipt.driveFiles.filter((f: any) => f.verified);

    if (!sheetsConfirmed) {
      broadcast('task:publish_reconciliation', { taskId, status: task.status, sheetProblem: receipt.detail?.sheetProblem ?? null });
      return {
        ok: true,
        taskId,
        status: task.status,
        complete: false,
        sheetProblem: receipt.detail?.sheetProblem ?? null,
        publicationReceipt: receipt,
        driveFolderUrl: `https://drive.google.com/drive/folders/${targetFolderId}`,
        sheetRowUrl: null,
        filesCount: verifiedFiles.length,
      };
    }

    broadcast('task:published', { taskId, status: task.status, receipt });
    broadcast('omnichannel:published', { taskId, driveFolderId: targetFolderId, spreadsheetId });

    // Decoupled notification dispatch (FR-051: notification failure shall not roll back publication)
    let notificationDelivered = true;
    let notificationError: string | undefined;
    if (deliveryOptions && (deliveryOptions as any).notifyAdapter) {
      try {
        await (deliveryOptions as any).notifyAdapter(receipt);
      } catch (err: any) {
        notificationDelivered = false;
        notificationError = err?.message || String(err);
        log.warn(`[core:omnichannel:publish] Thread notification failed for task ${taskId}:`, notificationError);
      }
    }

      return {
        ok: true,
        taskId,
        status: task.status,
        complete: true,
        publicationReceipt: receipt,
        driveFolderUrl: `https://drive.google.com/drive/folders/${targetFolderId}`,
        sheetRowUrl:
          spreadsheetId && receipt.sheet.rowNumber !== undefined
            ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}#gid=0&range=A${receipt.sheet.rowNumber}`
            : null,
        filesCount: verifiedFiles.length,
        publishedAt: new Date().toISOString(),
        notificationDelivered,
        notificationError,
      };
    };

    // The lock is taken before any state is written. It used to wrap only the provider call, so
    // two processes had already both moved the task to PUBLISHING and both tried to insert the
    // intent row before one of them was refused, and the loser's cached task was left unpublishable.
    const pubPromise = publishExclusively(taskId, doPublish).then((outcome: any) =>
      outcome && outcome.ok === false && outcome.error?.code === 'PUBLICATION_IN_PROGRESS'
        ? { ok: false, status: 409, code: 'PUBLICATION_IN_PROGRESS', message: outcome.error.message }
        : outcome
    );
    return await pubPromise;
  }

  /**
   * A delivery a restart cut short left the task PUBLISHING, which the publish route refused, and
   * nothing took it back: the approved design could never be delivered (review of 2026-09-24). With no
   * delivery of it running in this process it goes back to APPROVED to be delivered again; files
   * already sent are keyed per command and not sent twice.
   */
  async function reopenInterruptedDelivery(task: { status?: string; tenantId?: string }, taskId: string, userId: string): Promise<'reopened' | 'failed' | 'no'> {
    if (String(task?.status || '').toLowerCase() !== 'publishing' || deliveriesInFlight.has(taskId)) return 'no';
    const machine = new TaskStateMachine(taskId, 'PUBLISHING');
    const back = machine.transition('APPROVED', { type: 'user', id: userId } as Parameters<typeof machine.transition>[1], 'Delivery interrupted; delivered again');
    if (taskRepo && db && isValidUuid(taskId)) {
      const tenant = task.tenantId && isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
      const returned = await withRlsContext(db, { tenantId: tenant, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        taskRepo.transitionState({ taskId, tenantId: tenant, fromState: 'publishing', toState: 'approved', actorType: 'user', actorId: userId, reason: 'Delivery interrupted; delivered again' }, trx)
      ).then(() => true, (err: unknown) => {
        log.error('[core:publish] Could not take an interrupted delivery back to approved:', err);
        return false;
      });
      if (!returned) return 'failed';
    }
    if (back.ok) task.status = 'APPROVED';
    return 'reopened';
  }

  /** A change the client asked for that delivery would leave out (null: it could not be checked). */
  async function changeBlockingDelivery(task: { tenantId?: string }, taskId: string): Promise<{ id: string; state: string; live: boolean } | undefined | null> {
    if (!db || !isValidUuid(taskId)) return undefined;
    const tenant = task.tenantId && isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
    return pendingChangeOf(db, tenant, taskId).catch((err: unknown) => {
      log.warn('[core:publish] Could not check for a change the client asked for:', err);
      return null;
    });
  }

  return {
    NO_APPROVAL_TO_DELIVER,
    findApprovalForDelivery,
    storedCompletePublication,
    deliveriesInFlight,
    executeOmnichannelPublish,
    reopenInterruptedDelivery,
    changeBlockingDelivery,
  };
}
