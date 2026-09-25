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
  TASK_TRANSITIONED_EVENT,
  deliveryWorkflowId,
  taskTransitioned,
  type DeliveryInput,
  type DeliveryOutcome,
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
import { pendingChangeOf } from './pending-change.js';
import type { ClientDnaResolver } from './client-dna-resolver.js';
import type { TaskReader } from './task-reader.js';
import { recordWorkflowDeliveryIn } from './workflow-delivery-record.js';
import { readTaskLifecycle } from './office-decisions.js';

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
}

/** What the publish route is told when it hands a delivery to the Delivery workflow. */
export type WorkflowDeliveryStart =
  | { ok: true; deliveryId: string; run: number; alreadyRunning: boolean; recorded?: DeliveryOutcome['outcome'] }
  | { ok: true; complete: true; publicationId: string }
  | { ok: false; status: number; code: string; message: string };

/** The code startWorkflowDelivery answers when Core's own delivery already owns the publication. */
export const DELIVERY_OWNED_BY_CORE = 'DELIVERY_OWNED_BY_CORE';

/** What the Delivery workflow reports to Core's delivery-finished endpoint (slice 2.2). */
export interface DeliveryFinishedReport {
  deliveryId: string;
  approvalId: string;
  run: number;
  outcome: DeliveryOutcome;
}

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

  /** Tells the Desk the task moved, in the one task:transitioned shape. */
  const broadcastMove = (taskId: string, from: string, to: string) => {
    try {
      broadcast(TASK_TRANSITIONED_EVENT, taskTransitioned({ taskId, from, to }));
    } catch (err) {
      log.error(`[core:events] Task ${taskId}: ${TASK_TRANSITIONED_EVENT} not sent:`, err instanceof Error ? err.message : err);
    }
  };

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
   * 2.2); 'core' when Core's own delivery has started one, or has queued the requester's files in the
   * outbox (a chat-only delivery can do that with no publication row); null when nothing has started.
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
      return (await coreQueuedFiles(trx, tenantId, taskId)) ? 'core' : null;
    });
  }

  /** Whether Core's own delivery queued the task's files for the requester (a `notify.published` command). */
  async function coreQueuedFiles(trx: Kysely<Database>, tenantId: string, taskId: string, publicationKey?: string): Promise<boolean> {
    const { deliveredNotificationKey } = await import('./delivery-notification.js');
    const rows = publicationKey
      ? (await sql`SELECT 1 FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND command_type = 'notify.published'
          AND idempotency_key = ${deliveredNotificationKey(taskId, publicationKey)} LIMIT 1`.execute(trx)).rows
      : (await sql`SELECT 1 FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND command_type = 'notify.published'
          AND aggregate_id = ${taskId}::uuid LIMIT 1`.execute(trx)).rows;
    return rows.length > 0;
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
    // A task of a request the lifecycle owns is delivered by RequestLifecycle's Delivery workflow
    // (slice 2.4): Core's own delivery refuses it, whoever asks (a chat approval, a script).
    if (!workflowMode && db && isValidUuid(taskId)) {
      let owner: 'core' | 'restate' | null = null;
      try {
        owner = (await readTaskLifecycle(db, tenantOf(task), taskId))?.owner ?? null;
      } catch (err) {
        log.error('[core:omnichannel] Could not read whether the request lifecycle owns this task:', err);
        return { ok: false, status: 503, title: 'Database Unavailable', code: 'DATABASE_UNAVAILABLE', message: 'Who delivers this task could not be read; try again' };
      }
      if (owner === 'restate') {
        return { ok: false, status: 409, title: 'Lifecycle Owned', code: 'LIFECYCLE_OWNED', message: `Task ${taskId} belongs to a request the request lifecycle runs; press Deliver in the Desk` };
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
      // One executor per publication (slice 2.2). Read under the publish lock, which the publish route
      // also takes when it hands a delivery to the workflow, so the answer cannot change under us.
      if (publicationRepo && db && isValidUuid(taskId)) {
        const ownerTenant = tenantOf(task);
        let owner: 'core' | 'restate' | null;
        try {
          owner = (await withRlsContext(db, { tenantId: ownerTenant, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
            publicationRepo.findByKey(publicationKey, ownerTenant, trx)))?.executor ?? null;
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
      const retryingSheetRow = task.status === 'PUBLISH_RECONCILIATION' || workflowMode;
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
    // The chaos suite kills Core here: the files are in Drive, and nothing of it is recorded yet.
    await chaosPoint('core.delivery.after-drive', { taskId, mode: workflowMode ? 'workflow' : 'core' });

    // COMPLETE only when Drive and Sheets are both confirmed. Files delivered with the Sheets row
    // unconfirmed leave the task in PUBLISH_RECONCILIATION (the database keeps 'publishing'); it used
    // to be marked COMPLETE regardless, and forced to COMPLETE even when the transition was refused.
    const sheetsConfirmed = publishResult.value.state === 'complete';
    const finalStatus = sheetsConfirmed ? 'COMPLETE' : 'PUBLISH_RECONCILIATION';
    if (!workflowMode && task.status !== finalStatus) {
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

    // A task made in Desk has no chat to tell; writing the command anyway only dead-lettered it. The
    // workflow sends the files itself (TelegramSender), so nothing goes to the outbox for it.
    if (workflowMode) {
      // Nothing to write to the outbox.
    } else if (outboxPayload && !outboxPayload.chatId) {
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

    if (!workflowMode && sheetsConfirmed && taskRepo && db && isValidUuid(taskId)) {
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
        log.error('[core:omnichannel:receipts] Error persisting drive/sheet receipts:', err);
        // The workflow asks again, and Drive adopts the files it already holds: nothing is uploaded twice.
        if (workflowMode) return { ok: false, status: 503, code: 'RECEIPTS_NOT_RECORDED', message: 'The Drive and Sheets receipts could not be recorded; try again' };
      }
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
   * The publish route's side of a delivery run by the Delivery workflow (slice 2.2, PHASE2_DESIGN.md
   * section 3): the same checks as Core's own delivery (an approval with its pinned exports), then,
   * under the publish lock that Core's own delivery also takes, one transaction that
   * - records the publication as the workflow's (`executor = 'restate'`), creating it if need be,
   * - moves the task APPROVED -> PUBLISHING (a task left PUBLISHING, the Sheets row unconfirmed or an
   *   earlier delivery cut off, stays so: the new run retries the archive, not the files), and
   * - counts the run (`executor_run`), whose number names the workflow key.
   * Then it asks Restate to start that workflow. A run already in flight (started, not reported back)
   * is asked for again under its own key, which Restate answers 409 for: nothing starts twice, and a
   * start whose answer was lost is made good.
   */
  async function startWorkflowDelivery(
    taskId: string,
    request: { actorId: string; chatId: string | null; policy?: string; designRevisionId?: string; approvalId?: string }
  ): Promise<WorkflowDeliveryStart> {
    if (!db || !taskRepo || !publicationRepo || !isValidUuid(taskId)) {
      return { ok: false, status: 503, code: 'DATABASE_REQUIRED', message: 'The Delivery workflow keeps its publication in the database, which is not connected' };
    }
    const ingress = (process.env.RESTATE_INGRESS_URL || '').replace(/\/+$/, '');
    if (!ingress) return { ok: false, status: 503, code: 'RESTATE_NOT_CONFIGURED', message: 'RESTATE_INGRESS_URL is not set, so the Delivery workflow cannot be started' };
    let task: Awaited<ReturnType<typeof readCurrentTask>>;
    try {
      task = await readCurrentTask(taskId);
    } catch (err) {
      if (err instanceof TaskStoreUnavailableError) return { ok: false, status: 503, code: 'DATABASE_UNAVAILABLE', message: err.message };
      throw err;
    }
    if (!task) return { ok: false, status: 404, code: 'TASK_NOT_FOUND', message: 'Task Not Found' };
    const tenantId = tenantOf(task);
    const client = await resolveClientDna(task.clientId, { tenantId });
    const clientSlug = client?.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'client';
    const approval = await findApprovalForDelivery(tenantId, taskId, task, request.designRevisionId || task.latestRevisionId, {
      approvalId: request.approvalId,
      allowInvalidated: request.policy === 'deliver_approved_stored',
    });
    if (!approval) return { ok: false, status: 422, code: 'NO_APPROVAL', message: NO_APPROVAL_TO_DELIVER };
    const deliverables = await loadPinnedDeliverables(
      deliverableStore,
      { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, taskId, filePrefix: clientSlug },
      approval.pinnedExports
    );
    if (!deliverables.ok) return { ok: false, status: 422, code: deliverables.code, message: deliverables.message };
    const publicationKey = `pub_key_${taskId}_${approval.approvalId}`;

    type Claim = { kind: 'complete'; publicationId: string } | { kind: 'running'; run: number } | { kind: 'started'; run: number; from: string }
      | { kind: 'wrong_state'; state: string } | { kind: 'core' };
    let held: Awaited<ReturnType<typeof withSessionAdvisoryLock<Claim>>>;
    try {
      held = await withSessionAdvisoryLock(db, `publish:${taskId}`, () =>
        withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx): Promise<Claim> => {
          let created = false;
          const existing = await publicationRepo.findByKey(publicationKey, tenantId, trx);
          // Core's own delivery queued these files for the requester (a chat-only delivery writes no
          // publication first): it stays Core's, or the requester would get them twice.
          if ((!existing || existing.executor === 'core') && await coreQueuedFiles(trx, tenantId, taskId, publicationKey)) return { kind: 'core' };
          if (!existing) {
            created = true;
            await publicationRepo.createPublication({
              tenantId,
              taskId,
              designRevisionId: approval.designRevisionId,
              approvalId: approval.approvalId,
              publicationKey,
              packageManifest: { files: deliverables.files.map((f) => ({ name: f.filename, sha256: f.sha256, size: f.byteSize })) },
              packageSha256: deliverables.packageHash,
              initialState: 'pending',
            }, trx);
          }
          const pub = (await sql<{ id: string; state: string; executor: string; executor_run: number; executor_finished_run: number }>`
            SELECT id, state::text AS state, executor, executor_run, executor_finished_run FROM hawa.publications
            WHERE tenant_id = ${tenantId}::uuid AND publication_key = ${publicationKey} FOR UPDATE`.execute(trx)).rows[0];
          if (pub.state === 'complete') return { kind: 'complete', publicationId: String(pub.id) };
          // Core's own delivery started this publication (before the chat was on the list): it may
          // have sent the files through the outbox already, so it stays Core's. One owner per fact.
          if (pub.executor === 'core' && !created) return { kind: 'core' };
          if (pub.executor === 'restate' && pub.executor_run > pub.executor_finished_run) return { kind: 'running', run: pub.executor_run };
          const current = await taskRepo.findById(taskId, tenantId, trx);
          const state = String(current?.state || '');
          if (state === 'approved') {
            await taskRepo.transitionState({
              taskId, tenantId, fromState: 'approved', toState: 'publishing', actorType: 'user', actorId: request.actorId,
              reason: 'Delivery started by the Delivery workflow',
            }, trx);
          } else if (state !== 'publishing') {
            return { kind: 'wrong_state', state };
          }
          const run = Number(pub.executor_run) + 1;
          await sql`UPDATE hawa.publications SET executor = 'restate', executor_run = ${run}, updated_at = now()
            WHERE tenant_id = ${tenantId}::uuid AND id = ${pub.id}::uuid`.execute(trx);
          return { kind: 'started', run, from: state };
        })
      );
    } catch (err) {
      log.error('[core:publish:workflow] Could not hand the delivery to the Delivery workflow:', err);
      return { ok: false, status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The delivery could not be recorded; nothing was started. Try again' };
    }
    if (!held.acquired) {
      return { ok: false, status: 409, code: 'PUBLICATION_IN_PROGRESS', message: 'A delivery of this task is running right now; try again in a moment' };
    }
    const claim = held.value;
    if (claim.kind === 'complete') return { ok: true, complete: true, publicationId: claim.publicationId };
    if (claim.kind === 'core') {
      return { ok: false, status: 409, code: DELIVERY_OWNED_BY_CORE, message: `The delivery of task ${taskId} was started by Core; it is finished there` };
    }
    if (claim.kind === 'wrong_state') {
      return { ok: false, status: 409, code: 'NOT_APPROVED', message: `Task ${taskId} is in status '${claim.state}', not 'approved'` };
    }
    if (claim.kind === 'started' && claim.from !== 'publishing') broadcastMove(taskId, claim.from, 'publishing');

    const deliveryId = deliveryWorkflowId(taskId, approval.approvalId, claim.run);
    const officeChatId = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((c) => c.trim()).find(Boolean) || null;
    const input: DeliveryInput = {
      v: 1,
      requestId: taskId,
      deliveryId,
      tenantId,
      taskId,
      approvalId: approval.approvalId,
      revisionId: approval.designRevisionId,
      chatId: request.chatId,
      officeChatId,
      reportTo: 'core',
      run: claim.run,
      ...(request.policy ? { policy: request.policy } : {}),
    };
    try {
      // A workflow runs once per key: Restate answers 409 for a key it has seen, running or finished.
      const res = await fetch(`${ingress}/Delivery/${encodeURIComponent(deliveryId)}/run/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok || res.status === 409) {
        const alreadyRunning = claim.kind === 'running' || res.status === 409;
        if (claim.kind === 'running') {
          // A run that ended without Core hearing of it (Core was away for the hour its report waited)
          // left the task PUBLISHING. Its outcome is the workflow's output: record it now.
          const recorded = await recordFinishedRun(ingress, taskId, tenantId, approval.approvalId, deliveryId, claim.run);
          if (recorded) return { ok: true, deliveryId, run: claim.run, alreadyRunning: false, recorded };
        }
        return { ok: true, deliveryId, run: claim.run, alreadyRunning };
      }
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      log.error(`[core:publish:workflow] Restate refused the Delivery workflow ${deliveryId}: HTTP ${res.status} ${detail}`);
      return { ok: false, status: 503, code: 'DELIVERY_NOT_STARTED', message: `Restate did not start the delivery (HTTP ${res.status}); press Deliver again` };
    } catch (err) {
      log.error(`[core:publish:workflow] Restate did not answer for the Delivery workflow ${deliveryId}:`, err);
      return { ok: false, status: 503, code: 'DELIVERY_NOT_STARTED', message: 'Restate did not answer, so the delivery may not have started; press Deliver again' };
    }
  }

  /**
   * The outcome of a Delivery run Restate has finished, recorded as its report would have been; null
   * while it runs, or when Restate cannot say. Restate keeps a workflow's output for its retention (7 days).
   */
  async function recordFinishedRun(ingress: string, taskId: string, tenantId: string, approvalId: string, deliveryId: string, run: number):
    Promise<DeliveryOutcome['outcome'] | null> {
    let outcome: DeliveryOutcome;
    try {
      const res = await fetch(`${ingress}/restate/workflow/Delivery/${encodeURIComponent(deliveryId)}/output`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      outcome = await res.json() as DeliveryOutcome;
    } catch {
      return null;
    }
    if (!outcome || !['delivered', 'chat_only', 'uncertain', 'failed'].includes(String(outcome.outcome))) return null;
    const recorded = await finishWorkflowDelivery(taskId, tenantId, { deliveryId, approvalId, run, outcome });
    if (!recorded.ok) {
      log.error(`[core:publish:workflow] The finished run ${deliveryId} could not be recorded: ${recorded.code} ${recorded.message}`);
      return null;
    }
    log.warn(`[core:publish:workflow] ${deliveryId} had finished (${outcome.outcome}) without its report reaching Core; recorded now`);
    return outcome.outcome;
  }

  /**
   * The Delivery workflow's prepare step: Core's own delivery in workflow mode (deliverOmnichannel),
   * for this publication only. The tenant is the task's; a request naming another is refused.
   */
  async function prepareWorkflowDelivery(taskId: string, request: { tenantId: string; approvalId: string; revisionId?: string; policy?: string }) {
    return deliverOmnichannel(taskId, { type: 'workflow', id: 'delivery-workflow' }, 'Delivered by the Delivery workflow', false, {
      mode: 'workflow',
      approvalId: request.approvalId,
      designRevisionId: request.revisionId,
      policy: request.policy,
    });
  }

  /**
   * The Delivery workflow's report (slice 2.2; in 2.3 it goes to RequestLifecycle instead). One
   * transaction records the run as finished and moves the task as Core's own delivery did:
   * - archived and the Sheets row confirmed: COMPLETE, with the publication;
   * - archived, the row not confirmed: stays PUBLISHING (PUBLISH_RECONCILIATION), and Deliver retries
   *   the row;
   * - nothing archived (Drive refused, or the prepare step gave up): back to APPROVED, so Deliver can
   *   be pressed again once Drive works. The requester's files are sent once whatever happens.
   * A report for a run already recorded answers 'replayed' and changes nothing.
   */
  async function finishWorkflowDelivery(taskId: string, tenantId: string, report: DeliveryFinishedReport):
    Promise<{ ok: true; status: 'applied' | 'replayed'; taskState: string } | { ok: false; status: number; code: string; message: string }> {
    if (!db || !taskRepo || !publicationRepo || !isValidUuid(taskId) || !isValidUuid(tenantId) || !isValidUuid(report.approvalId)) {
      return { ok: false, status: 422, code: 'INVALID_REPORT', message: 'A delivery report names a task, a tenant and an approval' };
    }
    const outcome = report.outcome;
    let result: { ok: true; status: 'applied' | 'replayed'; taskState: string } | { ok: false; status: number; code: string; message: string };
    try {
      // The same record the request lifecycle's projection writes (recordDelivery, slice 2.4).
      const recorded = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        recordWorkflowDeliveryIn(trx, { tenantId, taskId, approvalId: report.approvalId, deliveryId: report.deliveryId, run: report.run, outcome }));
      result = recorded.ok ? { ok: true, status: recorded.status, taskState: recorded.taskState } : recorded;
    } catch (err) {
      log.error('[core:delivery-finished] Could not record the Delivery workflow\'s report:', err);
      return { ok: false, status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The delivery report could not be recorded; send it again' };
    }
    if (result.ok && result.status === 'applied') {
      if (result.taskState === 'complete') broadcast('task:published', { taskId, status: 'COMPLETE', executor: 'restate' });
      else if (result.taskState === 'publishing') broadcast('task:publish_reconciliation', { taskId, status: 'PUBLISH_RECONCILIATION', executor: 'restate' });
      else if (result.taskState === 'approved') broadcastMove(taskId, 'publishing', 'approved');
    }
    return result;
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
    startWorkflowDelivery,
    prepareWorkflowDelivery,
    finishWorkflowDelivery,
  };
}
