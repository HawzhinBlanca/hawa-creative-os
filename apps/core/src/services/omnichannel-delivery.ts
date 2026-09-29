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
import {
  CHANNEL_INGRESS_USER_ID,
  SYSTEM_AUTOMATION_USER_ID,
  deliveryWorkflowId,
  publicationRequestFromExpectation,
  type PublishRequest,
  type PreparedDelivery,
  type Publisher,
  type RequestContext,
} from '@hawa/contracts';
import { chaosPoint } from '@hawa/observability';
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
import { validatePublicationReceipt } from './publication-receipt-validation.js';
import { PublicationExpectations, PublicationExpectationConflict } from './publication-expectations.js';
import { pendingChangeOf, pendingChangeWords } from './pending-change.js';
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

/** How one delivery runs. `mode: 'workflow'` is the Delivery workflow's prepare step (deliverOmnichannel). */
export interface DeliveryOptions {
  policy?: string;
  designRevisionId?: string;
  approvalId?: string;
  mode?: 'legacy' | 'workflow';
  /** Worker-only proof that RequestLifecycle claimed this exact publication/run. */
  lifecycle?: { requestId: string; requestRev: number; deliveryId: string; run: number };
}

export function createOmnichannelDelivery(deps: OmnichannelDeliveryDeps) {
  const {
    db, taskRepo, publicationRepo, publisher, deliverableStore, events,
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
      // A stored approval still needs its QC evidence: the policy excuses a later edit, not missing QA.
      if ((isProduction || task?.requireQc || (opts as any).requireQc) && !match.qcReportHash) {
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
        async (trx) => {
          const approval = await trx
            .selectFrom('approvals' as any)
            .selectAll()
            .where('task_id', '=', taskId)
            .where('design_revision_id', '=', revisionId)
            .where('decision', '=', 'approved')
            .$if(Boolean(opts.approvalId && isValidUuid(opts.approvalId)), (q: any) => q.where('id', '=', opts.approvalId))
            .orderBy('created_at', 'desc')
            .executeTakeFirst();
          if (!approval) return null;
          // The export can be committed before its QC callback records the next revision. A later
          // capture therefore revokes delivery permission immediately, including the explicit
          // stored-approval policy. Both Core and the Delivery workflow use this lookup.
          const newer = (await sql<{ present: number }>`SELECT 1 AS present FROM hawa.canva_export_bytes
            WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
              AND created_at > ${approval.created_at}::timestamptz LIMIT 1`.execute(trx)).rows[0];
          return newer ? null : approval;
        }
      );
      if (!row) return null;
      if (!opts.allowInvalidated && row.decision_payload?.invalidated === true) {
        return null;
      }
      if (!row.decision_payload?.qcReportHash && !row.qc_run_id) {
        // Task R05: null/unknown QC cannot publish, under any policy. deliver_approved_stored used to
        // skip this too, so an approval with no QA behind it could be delivered (audit #2).
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

  async function currentCanvaSourceForDelivery(
    tenantId: string, taskId: string,
    approval: { approvalId: string; pinnedExports?: PinnedExport[] }
  ): Promise<{ status: number; code: string; message: string } | null> {
    if (!deliverableStore.captureEvidenceRequired) return null;
    if (!deliverableStore.verifyCurrentSource) {
      return { status: 503, code: 'CANVA_DESIGN_CHECK_UNAVAILABLE',
        message: 'The captured export store cannot check the current Canva design; delivery is held' };
    }
    try {
      const checked = await deliverableStore.verifyCurrentSource({ tenantId, taskId,
        approvalId: approval.approvalId,
        artifactIds: approval.pinnedExports?.map(pin => pin.artifactId) ?? [] });
      if (checked.ok) return null;
      return { status: checked.retryable ? 503 : checked.code === 'CANVA_DESIGN_CHANGED' ? 409 : 422,
        code: checked.code, message: checked.message };
    } catch {
      return { status: 503, code: 'CANVA_DESIGN_CHECK_UNAVAILABLE',
        message: 'Canva design version could not be checked; delivery is held for retry' };
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

  const tenantOf = (task: { tenantId?: string } | null | undefined) => (task?.tenantId && isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID);

  /** The task's requesting Telegram chat: the task's own record of it, else its `task.created` event. */
  async function requesterChatOf(task: ({ tenantId?: string; sourcePlatform?: unknown; sourceChannelId?: unknown }) | null | undefined, taskId: string): Promise<string | null> {
    const notification = await import('./delivery-notification.js');
    const tenantId = tenantOf(task);
    return notification.resolveRequesterChat(
      task,
      db && isValidUuid(taskId)
        ? () => withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
            (await sql<{ data: Parameters<typeof notification.requesterChatFromIntake>[0] }>`SELECT data FROM hawa.task_events
              WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND event_type = 'task.created'
              ORDER BY aggregate_version LIMIT 1`.execute(trx)).rows[0]?.data)
        : undefined
    );
  }

  /**
   * Who delivers the task: 'restate' when any of its publications is the Delivery workflow's (slice
   * 2.2); 'core' when Core's own delivery has started one. Before the first effect the task's
   * immutable creation-time pin decides. (A chat-only delivery of an old Telegram task queued the
   * requester's files with no publication row; such a task is pinned 'core', which says the same.) Historical Restate publications override the
   * migrated task default of core.
   * Throws when Postgres cannot be read: the caller must not guess, since either path acting on the
   * other's delivery would send the files a second time.
   */
  async function deliveryExecutorOfTask(task: { tenantId?: string } | undefined, taskId: string): Promise<'core' | 'restate' | null> {
    if (!db || !isValidUuid(taskId)) return null;
    const tenantId = tenantOf(task);
    return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const row = (await sql<{ executor: 'core' | 'restate' }>`SELECT executor FROM hawa.publications
        WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
        ORDER BY (executor = 'restate') DESC, created_at DESC LIMIT 1`.execute(trx)).rows[0];
      if (row) return row.executor;
      const taskPin = (await sql<{ delivery_executor_pin: 'core' | 'restate' }>`
        SELECT delivery_executor_pin FROM hawa.tasks
        WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx)).rows[0];
      return taskPin?.delivery_executor_pin ?? null;
    });
  }

  async function executeOmnichannelPublish(
    taskId: string,
    actor: { type: string; id: string } = { type: 'workflow', id: 'publisher' },
    reason: string = 'Omnichannel campaign published',
    autoApproveFromAwaiting: boolean = false,
    deliveryOptions?: DeliveryOptions
  ) {
    deliveriesInFlight.add(taskId);
    try {
      return await deliverOmnichannel(taskId, actor, reason, autoApproveFromAwaiting, deliveryOptions);
    } finally {
      deliveriesInFlight.delete(taskId);
    }
  }

  /**
   * `mode: 'workflow'` is the Delivery workflow's prepare step (slice 2.2): the Drive and Sheets work
   * only. The task is already PUBLISHING (the publish route moved it when it started the workflow),
   * nothing is written to the outbox (the workflow sends the files itself, through TelegramSender),
   * and neither the task nor the publication is completed here (Core's delivery-finished endpoint
   * does that once the requester has the files). The answer is `{ ok: true, prepared }`.
   *
   * Any other mode is Core's own delivery, which refuses a publication the workflow owns.
   */
  async function deliverOmnichannel(
    taskId: string,
    actor: { type: string; id: string },
    reason: string,
    autoApproveFromAwaiting: boolean,
    deliveryOptions?: DeliveryOptions
  ) {
    const workflowMode = deliveryOptions?.mode === 'workflow';
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
    const ownedDelivery = Boolean(task.requestId && workflowMode &&
      deliveryOptions?.lifecycle?.requestId === task.requestId);
    if (task.requestId && !ownedDelivery) return { ok: false, status: 409, code: 'LIFECYCLE_OWNED',
      message: `RequestLifecycle owns task ${taskId}; Core delivery cannot send it` };
    if (ownedDelivery) {
      if (!db || !publicationRepo || !Number.isInteger(deliveryOptions?.lifecycle?.requestRev) ||
          !Number.isInteger(deliveryOptions?.lifecycle?.run) || !deliveryOptions?.approvalId) {
        return { ok: false, status: 409, code: 'INVALID_LIFECYCLE_DELIVERY',
          message: 'A matching claimed request revision and publication run are required' };
      }
      const claim = await withRlsContext(db, { tenantId: tenantOf(task), userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => ({
        request: await trx.selectFrom('requests').select(['rev', 'stage', 'current_task_id'])
          .where('tenant_id', '=', tenantOf(task)).where('request_id', '=', task.requestId!).executeTakeFirst(),
        publication: await publicationRepo.findByKey(`pub_key_${taskId}_${deliveryOptions.approvalId}`, tenantOf(task), trx),
      }));
      if (Number(claim.request?.rev) !== deliveryOptions.lifecycle!.requestRev ||
          claim.request?.stage !== 'delivering' || claim.request.current_task_id !== taskId ||
          claim.publication?.executor !== 'restate' ||
          Number(claim.publication.executor_run) !== deliveryOptions.lifecycle!.run ||
          Number(claim.publication.executor_finished_run) >= deliveryOptions.lifecycle!.run ||
          deliveryWorkflowId(taskId, deliveryOptions.approvalId, deliveryOptions.lifecycle!.run) !== deliveryOptions.lifecycle!.deliveryId) {
        return { ok: false, status: 409, code: 'LIFECYCLE_DELIVERY_NOT_CURRENT',
          message: 'This workflow run is not the request owner\'s current delivery claim' };
      }
      const change = await pendingChangeOf(db, tenantOf(task), taskId);
      if (change) return { ok: false, status: 409, code: 'CLIENT_CHANGE_PENDING',
        message: 'A client-requested change blocks this approved package' };
    }
    // A change the client asked for blocks delivery whichever path asks. Only the Desk's publish route
    // checked it; publish-omnichannel and the WhatsApp approve link reached here without it and could
    // deliver a version the client had asked to change (audit 2026-09-27 #3). The workflow's own run
    // is checked by RequestLifecycle before it starts.
    if (!workflowMode) {
      // Core's own delivery sends no files to a Telegram requester any more (ADR-135 stage 2d): every
      // Telegram request is RequestLifecycle's, whose Delivery workflow sends them. A Telegram task
      // outside it (made by the old intake, none open when stage 2 shipped) is refused before any
      // effect, rather than archived with its requester never told.
      if (await requesterChatOf(task, taskId)) {
        return { ok: false, status: 409, title: 'Telegram Delivery Retired', code: 'LEGACY_TELEGRAM_DELIVERY_RETIRED',
          message: `Task ${taskId} came from a Telegram chat outside RequestLifecycle; Core no longer sends files to Telegram requesters. Cancel it, and ask the requester to send the request again.` };
      }
      const change = await changeBlockingDelivery(task, taskId);
      if (change === null) {
        return { ok: false, status: 503, title: 'Database Unavailable', code: 'DATABASE_UNAVAILABLE', message: 'Whether the client asked for a change could not be checked; try again' };
      }
      if (change) {
        return { ok: false, status: 409, title: "Changed At The Client's Request", code: 'CHANGE_PENDING', message: `${pendingChangeWords(change)} The approved version was not delivered.` };
      }
    }
    if (workflowMode) {
      // The workflow's own run only: a task delivered already, or taken back, is not delivered again.
      const state = String(task.state || task.status || '').toLowerCase();
      if (state === 'complete') {
        return { ok: false, status: 409, code: 'DELIVERY_ALREADY_COMPLETE', message: `Task ${taskId} is delivered already` };
      }
      if (state !== 'publishing' && state !== 'publish_reconciliation') {
        return { ok: false, status: 409, code: 'NOT_PUBLISHING', message: `Task ${taskId} is '${state}', not being delivered` };
      }
    }

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
    if (ownedDelivery && db && publicationRepo) {
      const recorded = await withRlsContext(db, { tenantId: tenantOf(task), userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        publicationRepo.findByKey(`pub_key_${taskId}_${approval.approvalId}`, tenantOf(task), trx));
      if (!recorded || recorded.package_sha256 !== deliverables.packageHash) {
        return { ok: false, status: 409, code: 'LIFECYCLE_PACKAGE_CHANGED',
          message: 'The approved package no longer matches its claimed publication' };
      }
    }

    const isDeliverApprovedStored = deliveryOptions?.policy === 'deliver_approved_stored';
    const sm = new TaskStateMachine(taskId, isDeliverApprovedStored &&
      !['PUBLISH_RECONCILIATION', 'ARCHIVE_RECONCILIATION'].includes(task.status) ? 'APPROVED' : task.status);

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
    if (!workflowMode && task.status === 'COMPLETE' && publicationRepo && db && isValidUuid(taskId)) {
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

    /**
     * The workflow's answer: what the requester is sent, and what became of the archive. Built from
     * the same payloads Core's own delivery writes to the outbox, so the notice reads the same.
     */
    const preparedAnswer = (
      payload: { files: PreparedDelivery['files']; driveFolderId: string; spreadsheetId: string; sheetsConfirmed: boolean; sheetRowNumber: number | null; sheetProblem: string | null } | null,
      facts: { chatId: string | null; chatOnly: boolean; archived: boolean; sheetsConfirmed: boolean; archiveProblem?: string | null }
    ): { ok: true; prepared: PreparedDelivery } => ({
      ok: true,
      prepared: {
        ok: true,
        taskId,
        publicationKey,
        chatId: facts.chatId,
        title: task.title || null,
        files: payload?.files ?? [],
        chatOnly: facts.chatOnly,
        archived: facts.archived,
        sheetsConfirmed: facts.sheetsConfirmed,
        notice: {
          title: task.title || null,
          files: payload?.files ?? [],
          driveFolderId: payload?.driveFolderId ?? '',
          spreadsheetId: payload?.spreadsheetId ?? '',
          sheetsConfirmed: payload?.sheetsConfirmed ?? facts.sheetsConfirmed,
          sheetRowNumber: payload?.sheetRowNumber ?? null,
          sheetProblem: payload?.sheetProblem ?? null,
          ...(facts.archiveProblem ? { archiveProblem: facts.archiveProblem } : {}),
        },
      },
    });

    const doPublish = async () => {
      // The first lookup and byte read happen before this lock. A capture can commit in that
      // interval, so the publisher must recheck the same approval while capture commits are fenced
      // by publish:${taskId}. This is before a task transition or any provider effect.
      if (db) {
        const current = await findApprovalForDelivery(deliveryTenantId, taskId, task,
          approval.designRevisionId, { approvalId: approval.approvalId, allowInvalidated: isDeliverApprovedStored });
        if (!current || current.approvalId !== approval.approvalId) {
          return { ok: false, status: 422, title: 'Nothing Approved To Deliver',
            code: 'NO_APPROVAL', message: NO_APPROVAL_TO_DELIVER };
        }
        const sourceProblem = await currentCanvaSourceForDelivery(deliveryTenantId, taskId, current);
        if (sourceProblem) return { ok: false, ...sourceProblem };
      }
      // One executor per publication (slice 2.2). Read under the publish lock, which the publish route
      // also takes when it hands a delivery to the workflow, so the answer cannot change under us.
      let priorPublication = false;
      if (publicationRepo && db && isValidUuid(taskId)) {
        const ownerTenant = tenantOf(task);
        let owner: 'core' | 'restate' | null;
        try {
          const recorded = await withRlsContext(db, { tenantId: ownerTenant, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
            publicationRepo.findByKey(publicationKey, ownerTenant, trx));
          priorPublication = Boolean(recorded);
          owner = recorded?.executor ?? await deliveryExecutorOfTask(task, taskId);
        } catch (err) {
          log.error('[core:omnichannel] Could not read who delivers this publication:', err);
          return { ok: false, status: 503, title: 'Database Unavailable', code: 'DATABASE_UNAVAILABLE', message: 'Who delivers this publication could not be read; try again' };
        }
        if (!workflowMode && owner === 'restate') {
          return {
            ok: false,
            status: 409,
            title: 'Delivered By The Workflow',
            code: 'DELIVERY_OWNED_BY_WORKFLOW',
            message: `The delivery of task ${taskId} is run by the Delivery workflow; press Deliver in the Desk to follow or retry it`,
          };
        }
        if (workflowMode && owner !== 'restate') {
          return { ok: false, status: 409, code: 'NOT_OWNED_BY_WORKFLOW', message: `The publication of task ${taskId} is not the workflow's to deliver` };
        }
      }

      if (!workflowMode && autoApproveFromAwaiting && task.status === 'AWAITING_APPROVAL') {
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
      // The workflow's task is PUBLISHING already: the publish route moved it.
      const retryingPublication = task.status === 'PUBLISH_RECONCILIATION' ||
        task.status === 'ARCHIVE_RECONCILIATION' || workflowMode;
      if (!retryingPublication) {
        const trans = sm.transition('PUBLISHING', actor as any, 'Omnichannel publication started');
        if (!trans.ok) {
          return { ok: false, status: 409, message: trans.error.message };
        }

        if (!isDeliverApprovedStored) {
          task.status = 'PUBLISHING';
          events.get(taskId)?.push(trans.value);
        }
      }

      if (taskRepo && db && isValidUuid(taskId) && !retryingPublication) {
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
          return { ok: false as const, status: 503, code: 'PUBLICATION_STATE_NOT_RECORDED',
            message: 'Delivery could not be recorded before the Drive upload; try again' };
        }
      }

      let files = deliverables.files;

      const ctx: RequestContext = {
        tenantId: tenantOf(task),
        taskId,
        actor: actor as any,
        correlationId: crypto.randomUUID(),
        deadline: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: publicationKey,
      };

    // A pre-upload failure can use chat-only delivery only when an earlier attempt cannot have
    // archived the same publication. Credentials or destination may disappear after an upload whose
    // reply was lost; the current failure then proves nothing about the earlier Drive state.
    const failTenantId = isValidUuid(task.tenantId) ? task.tenantId : '00000000-0000-4000-a000-000000000001';
    const holdArchive = async (failure: { status: number; code: string; message: string }) => {
      if (publicationRepo && db && isValidUuid(taskId)) {
        try {
          const recorded = await withRlsContext(db, { tenantId: failTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            const pub = await publicationRepo.findByKey(publicationKey, failTenantId, trx);
            return pub && publicationRepo.markArchiveUnconfirmed({ tenantId: failTenantId,
              publicationId: pub.id, taskId, code: failure.code }, trx);
          });
          if (!recorded) throw new Error('Publication intent was absent or already complete');
        } catch (err) {
          log.error('[core:omnichannel:archive-hold] Could not record uncertain archive:', err);
          return { ok: false as const, status: 503, code: 'ARCHIVE_STATE_UNRECORDED',
            message: 'The Drive outcome could not be recorded; requester delivery remains held' };
        }
      }
      task.status = 'ARCHIVE_RECONCILIATION';
      broadcast('task:publish_reconciliation', { taskId, status: task.status, archiveProblem: failure.code });
      return { ok: false as const, ...failure };
    };
    const failBeforeDrive = async (failure: { status: number; code: string; message: string }) => {
      let archiveMayExist = priorPublication && !workflowMode;
      if (!archiveMayExist && db && isValidUuid(taskId)) {
        try {
          archiveMayExist = await withRlsContext(db, { tenantId: failTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            const result = await sql<{ possible: boolean }>`SELECT EXISTS (
              SELECT 1 FROM hawa.publications p
              WHERE p.tenant_id = ${failTenantId}::uuid AND p.publication_key = ${publicationKey}
                AND (EXISTS (SELECT 1 FROM hawa.drive_upload_reservations r
                      WHERE r.tenant_id = p.tenant_id AND r.publication_id = p.id)
                  OR EXISTS (SELECT 1 FROM hawa.drive_refs d
                      WHERE d.tenant_id = p.tenant_id AND d.publication_id = p.id))
            ) AS possible`.execute(trx);
            return result.rows[0]?.possible === true;
          });
        } catch (err) {
          log.error('[core:omnichannel:archive-history] Could not establish whether a prior upload exists:', err);
          return { ok: false as const, status: 503, code: 'ARCHIVE_HISTORY_UNAVAILABLE',
            message: 'The prior archive state could not be checked; requester delivery is held until it can be reconciled' };
        }
      }
      if (archiveMayExist) {
        return holdArchive({ status: 503, code: 'ARCHIVE_STATE_UNCERTAIN',
          message: `${failure.message}. The archive may already exist from an earlier attempt; requester delivery is held until it is reconciled` });
      }
      if (workflowMode) {
        // The workflow asks again: a database that could not record the intent is not a Drive failure.
        if (failure.code === 'PUBLICATION_INTENT_PERSISTENCE_FAILED') return { ok: false, status: 503, code: failure.code, message: failure.message };
        // The files still go to the requester, as in Core's own delivery; the workflow sends them.
        const archiveProblem = failure.code === 'CREDENTIALS_MISSING' ? 'the office Google account is not connected' : String(failure.code || 'Drive refused the upload');
        const chatId = await requesterChatOf(task, taskId);
        const notification = await import('./delivery-notification.js');
        const chatOnly = notification.buildChatOnlyNotificationPayload({
          taskId, clientId: task.clientId || null, title: task.title || null, chatId, publicationKey, pins: approval.pinnedExports, files, archiveProblem,
        });
        return preparedAnswer(chatOnly, { chatId, chatOnly: true, archived: false, sheetsConfirmed: false, archiveProblem });
      }
      // Core's own delivery sends nothing to a requester (ADR-135 stage 2d: Desk, WhatsApp and
      // webhook tasks have no Telegram chat, and a Telegram task outside RequestLifecycle is refused
      // before any effect). The archive stays failed here (and in Desk) until Drive works.
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
      return { ok: false as const, status: failure.status, code: failure.code, message: failure.message };
    };

    let publicationRequest: PublishRequest = {
      taskId, clientId: task.clientId || DEFAULT_CLIENT_ID, designRevisionId: approval.designRevisionId,
      approvalId: approval.approvalId, publicationKey, packageHash: deliverables.packageHash, files,
      destination: {
        sharedDriveId: client?.destinations?.googleSharedDriveId || client?.productionDestinations?.googleSharedDriveId || '',
        productionRootFolderId: client?.destinations?.productionFolderId || client?.productionDestinations?.googleDriveFolderId || '',
        relativeFolderParts: ['Clients', client?.name || 'Hawa', new Date().getFullYear().toString()],
        spreadsheetId: client?.destinations?.spreadsheetId || client?.productionDestinations?.googleSheetId || '',
        sheetId: client?.destinations?.sheetId ?? -1,
      },
      sheetRow: { taskId, client: task.clientId || DEFAULT_CLIENT_ID, status: 'COMPLETE', publishedAt: new Date().toISOString() },
    };
    const expectationStore = db && isValidUuid(taskId) ? new PublicationExpectations(db) : null;
    try {
      const stored = await expectationStore?.read(ctx.tenantId, publicationKey);
      if (stored) publicationRequest = publicationRequestFromExpectation(stored.original, publicationRequest, stored.sheet);
    } catch {
      return { ok: false, status: 503, code: 'PUBLICATION_EXPECTATION_UNAVAILABLE',
        message: 'The original publication inputs could not be verified; delivery remains held' };
    }
    let targetFolderId = publicationRequest.destination.productionRootFolderId;
    let spreadsheetId = publicationRequest.destination.spreadsheetId;
    let reportingSheetId = publicationRequest.destination.sheetId;
    files = publicationRequest.files;
    if (!targetFolderId || targetFolderId === 'unauthorized_folder' || targetFolderId.includes('audit-invented') || targetFolderId.includes('nonexistent')) {
      return failBeforeDrive({ status: 400, code: 'INVALID_DESTINATION',
        message: `Client '${task.clientId}' has no authorized Google Drive production destination folder configured in Client DNA. Refusing publication to unconfigured destination.` });
    }
    if (!Number.isSafeInteger(reportingSheetId) || reportingSheetId < 0) {
      return failBeforeDrive({ status: 400, code: 'INVALID_SHEET_DESTINATION', message: 'Configure an explicit numeric reporting tab ID in Client DNA before publication.' });
    }

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

    if (expectationStore && dbPub) {
      try {
        publicationRequest = await expectationStore.freeze(ctx.tenantId, dbPub.id, publicationRequest);
        files = publicationRequest.files;
        targetFolderId = publicationRequest.destination.productionRootFolderId;
        spreadsheetId = publicationRequest.destination.spreadsheetId;
        reportingSheetId = publicationRequest.destination.sheetId;
      } catch (error) {
        log.error('[core:publication-expectation:freeze] Durable input freeze failed', error);
        return holdArchive({ status: error instanceof PublicationExpectationConflict ? 409 : 503,
          code: error instanceof PublicationExpectationConflict ? error.message : 'PUBLICATION_EXPECTATION_NOT_RECORDED',
          message: 'The original publication inputs could not be durably confirmed; provider writes and requester delivery remain held' });
      }
    }
    const publishResult: any = await publisher.publish(ctx, publicationRequest);

    if (!publishResult.ok) {
      // A Drive error is not proof that no file reached Drive: an upload can commit before its
      // response is lost, and an earlier file in this package may already be there. Keep the
      // publication pending and let the same key reconcile it before any requester notification.
      if (String(publishResult.error.code).startsWith('DRIVE_')) {
        return holdArchive({
          status: publishResult.error.retryable === false ? 409 : 503,
          code: publishResult.error.code,
          message: `${publishResult.error.message}. Check the Drive publication before sending the approved files`,
        });
      }
      return failBeforeDrive({
        status: publishResult.error.code === 'INVALID_DESTINATION' ? 400 : 422,
        code: publishResult.error.code,
        message: publishResult.error.message,
      });
    }
    if (publishResult.value.state === 'failed' ||
        publishResult.value.driveFiles?.some((file: { verified?: boolean }) => !file.verified)) {
      return holdArchive({ status: 409, code: 'DRIVE_VERIFICATION_FAILED',
        message: 'Drive has not verified every approved file; reconcile the publication before requester delivery' });
    }
    const receiptCheck = validatePublicationReceipt(publishResult.value, {
      publicationKey, taskId, packageHash: deliverables.packageHash, spreadsheetId, sheetId: reportingSheetId ?? 0, files,
    });
    if (!receiptCheck.ok) {
      return holdArchive({ status: 409, code: 'PUBLICATION_RECEIPT_INVALID',
        message: `${receiptCheck.reason}; reconcile the provider result before requester delivery` });
    }
    // The chaos suite kills Core here: the files are in Drive, and nothing of it is recorded yet.
    await chaosPoint('core.delivery.after-drive', { taskId, mode: workflowMode ? 'workflow' : 'core' });

    // COMPLETE only when Drive and Sheets are both confirmed. Files delivered with the Sheets row
    // unconfirmed leave the task in PUBLISH_RECONCILIATION (the database keeps 'publishing'); it used
    // to be marked COMPLETE regardless, and forced to COMPLETE even when the transition was refused.
    const sheetsConfirmed = publishResult.value.state === 'complete';
    const finalStatus = sheetsConfirmed ? 'COMPLETE' : 'PUBLISH_RECONCILIATION';
    if (!workflowMode && task.status !== finalStatus && !sm.canTransitionTo(finalStatus)) {
      return { ok: false, status: 409, message: `Illegal transition from ${task.status} to ${finalStatus}` };
    }

    // The workflow's answer names the files verified in Drive, which the Delivery workflow sends to
    // the requester with each file's Drive link, and the Sheets outcome. Core's own delivery sends
    // nothing to a requester (ADR-135 stage 2d); only the workflow's answer uses this.
    const notification = await import('./delivery-notification.js');
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

    // Provider receipts are recorded durably before the workflow is told to send and before
    // completion.
    if (db && isValidUuid(taskId) && (!publicationRepo || !dbPub)) {
      return holdArchive({ status: 503, code: 'RECEIPTS_NOT_RECORDED',
        message: 'The Drive and Sheets receipts could not be recorded; requester delivery remains held' });
    }
    if (publicationRepo && db && isValidUuid(taskId) && dbPub) {
      try {
        await withRlsContext(db, { tenantId: pubTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          for (const file of publishResult.value.driveFiles || []) {
            await publicationRepo.recordDriveRef({
              tenantId: pubTenantId,
              publicationId: dbPub.id,
              publicationArtifactId: file.artifactId,
              sharedDriveId: publicationRequest.destination.sharedDriveId,
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
              sheetId: publishResult.value.sheet.sheetId,
              taskId,
              rowKey: taskId,
              rowNumber: publishResult.value.sheet.rowNumber,
              expectedHash: publishResult.value.sheet.expectedHash,
              observedHash: publishResult.value.sheet.observedHash,
              metadataId: publishResult.value.sheet.metadataId,
              expectedValues: publishResult.value.sheet.expectedValues,
              expectedRowHash: publishResult.value.sheet.expectedRowHash,
              observedRowHash: publishResult.value.sheet.observedRowHash,
              status: publishResult.value.sheet.synced ? 'synced' : 'pending',
            }, trx);
          }

          if (!workflowMode && !sheetsConfirmed) {
            await sql`UPDATE hawa.publications SET error_class = 'SHEET_UNCONFIRMED',
              error_detail = ${String(publishResult.value.detail?.sheetProblem || 'Sheet row not confirmed').slice(0, 500)},
              updated_at = now() WHERE tenant_id = ${pubTenantId}::uuid AND id = ${dbPub.id}::uuid`.execute(trx);
          } else {
            await sql`UPDATE hawa.publications SET error_class = NULL, error_detail = NULL, updated_at = now()
              WHERE tenant_id = ${pubTenantId}::uuid AND id = ${dbPub.id}::uuid
                AND error_class = 'ARCHIVE_UNCONFIRMED'`.execute(trx);
          }

          // The workflow's publication is completed with its task, by delivery-finished.
          if (sheetsConfirmed && !workflowMode) {
            await publicationRepo.markComplete({
              tenantId: pubTenantId,
              publicationId: dbPub.id,
              taskId,
            }, trx);
          }
        });
      } catch (err) {
        log.error('[core:omnichannel:receipts] Error committing drive/sheet receipts and delivery decision:', err);
        // The first transaction rolled back. Keep the task pending, and retry the same reserved
        // Drive IDs only after recording that its external archive outcome needs reconciliation.
        return holdArchive({ status: 503, code: 'RECEIPTS_NOT_RECORDED',
          message: 'The Drive and Sheets receipts could not be recorded; requester delivery remains held' });
      }
    }

    if (!workflowMode && task.status !== finalStatus) {
      const finishTrans = sm.transition(
        finalStatus,
        actor as any,
        sheetsConfirmed ? reason : `Files delivered; Sheets row not confirmed: ${publishResult.value.detail?.sheetProblem || 'unknown reason'}`
      );
      if (finishTrans.ok) events.get(taskId)?.push(finishTrans.value);
      task.status = finalStatus;
    }

    if (workflowMode) {
      const archived = (publishResult.value.driveFiles || []).some((f: { verified?: boolean }) => f.verified);
      return preparedAnswer(outboxPayload, { chatId: outboxPayload?.chatId ?? (await requesterChatOf(task, taskId)), chatOnly: false, archived, sheetsConfirmed });
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
            ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}#gid=${receipt.sheet.sheetId}&range=A${receipt.sheet.rowNumber}`
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
    // A delivery the Delivery workflow runs is not stranded by a Core restart: the workflow carries on
    // and reports back (slice 2.2). Taking it back to APPROVED here would let a second one start.
    try {
      if ((await deliveryExecutorOfTask(task, taskId)) === 'restate') return 'no';
    } catch (err) {
      log.error('[core:publish] Could not read who delivers this task:', err);
      return 'failed';
    }
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

  /**
   * The Delivery workflow's prepare step: Core's own delivery in workflow mode (deliverOmnichannel),
   * for this publication only. The tenant is the task's; a request naming another is refused.
   */
  async function prepareWorkflowDelivery(taskId: string, request: { tenantId: string; approvalId: string; revisionId?: string;
    policy?: string; lifecycle?: DeliveryOptions['lifecycle'] }) {
    return deliverOmnichannel(taskId, { type: 'workflow', id: 'delivery-workflow' }, 'Delivered by the Delivery workflow', false, {
      mode: 'workflow',
      approvalId: request.approvalId,
      designRevisionId: request.revisionId,
      policy: request.policy,
      lifecycle: request.lifecycle,
    });
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
    requesterChatOf,
    deliveryExecutorOfTask,
    prepareWorkflowDelivery,
  };
}
