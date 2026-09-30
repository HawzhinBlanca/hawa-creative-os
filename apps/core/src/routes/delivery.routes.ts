import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID, publicationAwareTaskStatus, isTaskDbState } from '@hawa/contracts';
import { withRlsContext, toApiTaskStatus } from '@hawa/db';
import { buildOutboundReviewDispatch, signLifecycleOfficeEvent } from '@hawa/integrations';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid, COPY_REQUIRED_DETAIL } from '../core-helpers.js';
import { log } from '../logging.js';
import { pendingChangeWords } from '../services/pending-change.js';
import { readPublicationReceipt } from '../services/publication-receipt.js';
import { acknowledgeLateChange, acknowledgedLateChanges, pendingLateChanges } from '../services/lifecycle-chat-target.js';
import { readRequesterSendEvidence } from '../services/requester-send-evidence.js';
import { confirmRequesterSendVisible } from '../services/requester-send-resolution.js';
import { LifecycleProjectionConflict } from '../services/lifecycle-projection.js';
import { startRequestOwnedDelivery } from '../services/office-decisions.js';

/**
 * Delivery of an approved design and what it left behind (architecture programme 1.3, group G5,
 * moved from app.ts): POST publish, GET publication-state, the WhatsApp review dispatch, POST
 * publish-omnichannel and GET publication-receipt. The delivery itself is
 * services/omnichannel-delivery.ts, reached through ctx.delivery; what it left is read from Postgres
 * (services/publication-receipt.ts).
 */
export function registerDeliveryRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    problem,
    db,
    taskRepo,
    outboxRepo,
    publicationRepo,
    tasks,
    readCurrentTask,
    resolveTaskWithFallback,
    resolveClientDna,
    broadcastEvent: broadcast,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };
  const {
    executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery,
    deliveryExecutorOfTask,
  } = ctx.delivery;
  const defaultClientId = DEFAULT_CLIENT_ID;

  /**
   * The task's delivery as Postgres has it (services/publication-receipt.ts), or null when it has
   * none. Throws when the database cannot be read: an answer of "never delivered" then would be false.
   */
  const storedReceipt = (auth: { tenantId?: string; userId?: string; role?: string }, taskId: string) =>
    db && publicationRepo && isValidUuid(taskId)
      ? readPublicationReceipt(db, publicationRepo, {
          tenantId: auth.tenantId || DEFAULT_TENANT_ID,
          userId: auth.userId || SYSTEM_AUTOMATION_USER_ID,
          role: auth.role || 'operator',
        }, taskId)
      : Promise.resolve(null);

  /**
   * Delivering an approval a later edit invalidated (policy deliver_approved_stored) skips the checks
   * that bind a delivery to the current revision. Any signed-in role could ask for it with one body
   * field (audit 2026-09-27 #2): it is an administrator's decision now, and needs a reason, which the
   * delivery records.
   */
  const storedPolicyRefusal = (c: any, auth: { role?: string }, body: any): Response | null => {
    if (body?.policy !== 'deliver_approved_stored') return null;
    if (auth.role !== 'administrator') {
      return problem(c, 403, 'Administrator Required', 'Only an administrator may deliver an approval a later edit invalidated.');
    }
    if (!String(body.reason || '').trim()) {
      return problem(c, 422, 'Reason Required', 'Say why the stored approval is delivered instead of approving the current revision.');
    }
    return null;
  };

  // Publish Task (Gate G: Truthful, Authenticated, Durable Google Workspace Publication)
  registerRoute('post', '/tasks/:taskId/publish', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to trigger publication');
    }

    const taskId = c.req.param('taskId');
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    if (task.requestId) {
      const actionId = c.req.header('Idempotency-Key');
      if (!actionId || !isValidUuid(actionId)) return problem(c, 422, 'Action Key Required',
        'Request-owned delivery needs a UUID Idempotency-Key for safe retry');
      const officeRole = (auth.role || '').toLowerCase().trim();
      if (!['art_director', 'creative_director', 'office_admin', 'administrator'].includes(officeRole)) {
        return problem(c, 403, 'Forbidden', 'An authorized office reviewer must start request-owned delivery');
      }
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => !['destination', 'approvalId', 'acknowledgeLateChanges'].includes(key)) ||
          (body.destination !== undefined && body.destination !== 'google_drive') ||
          (body.approvalId !== undefined && !isValidUuid(String(body.approvalId))) ||
          (body.acknowledgeLateChanges !== undefined && (!Array.isArray(body.acknowledgeLateChanges) ||
            body.acknowledgeLateChanges.length > 50 ||
            (body.acknowledgeLateChanges as unknown[]).some((id: unknown) => typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id))))) {
        return problem(c, 422, 'Invalid Delivery Request', 'Deliver the current approval to Google Drive with one stable action key');
      }
      if (!db || !taskRepo || !publicationRepo) return problem(c, 503, 'Database Unavailable',
        'Request-owned delivery requires the persistent request ledger');
      const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
      const answer = await startRequestOwnedDelivery({ db }, { tenantId, taskId, requestId: task.requestId, actionId,
        auth: { userId: auth.userId, role: auth.role }, officeRole, body, instance: new URL(c.req.url).pathname });
      return answer.ok ? c.json(answer.body, answer.status) : problem(c, answer.status, answer.title, answer.detail);
    }

    const body = await c.req.json().catch(() => ({}));
    const storedRefused = storedPolicyRefusal(c, auth, body);
    if (storedRefused) return storedRefused;
    const policy = body.policy || 'current_task';
    const targetRevisionId = body.designRevisionId || task?.latestRevisionId;
    const requestedApprovalId = body.approvalId;

    // Invariant: B cannot ship using A's approval (CV-15)
    if (body.designRevisionId && task?.latestApproval) {
      if (task.latestApproval.designRevisionId !== targetRevisionId && policy !== 'deliver_approved_stored') {
        return problem(c, 409, 'Conflict', `Revision mismatch: Approval is bound to revision '${task.latestApproval.designRevisionId}', cannot be used to publish target revision '${targetRevisionId}'. B cannot ship using A's approval.`);
      }
      if (task.latestApproval.invalidated && policy !== 'deliver_approved_stored') {
        return problem(c, 409, 'Conflict', 'Previous approval was invalidated by subsequent edits. Re-approval required.');
      }
    }

    if (requestedApprovalId && task?.latestApproval && task.latestApproval.decisionId !== requestedApprovalId && policy !== 'deliver_approved_stored') {
      return problem(c, 409, 'Conflict', `Approval ID mismatch: requested approval '${requestedApprovalId}' does not match active approval.`);
    }

    // ADR-052 pinned the executor at task creation. Stage 2 of ADR-135 removed the Delivery workflow
    // for tasks RequestLifecycle does not own (none was open when it merged: GET
    // /v1/operations/legacy-path, stage2Ready). A task pinned to it, or whose publication it started,
    // is refused here rather than handed to Core's own delivery, which would send its files again.
    const executor = await deliveryExecutorOfTask(task, taskId).catch((err: unknown) => {
      log.warn('[core:publish] Could not read who delivers this task; Core\'s own delivery checks again under its lock:', err);
      return undefined;
    });
    if (executor === 'restate') {
      if ((task?.status || '').toLowerCase() === 'complete') {
        const stored = await storedCompletePublication(task, taskId);
        if (stored) return c.json({ commandId: crypto.randomUUID(), taskId, workflowId: `wf_${taskId}`, publicationId: stored.publicationId, status: 'COMPLETE', receipt: stored, acceptedAt: new Date().toISOString() }, 200);
      }
      return problem(c, 409, 'Delivery Workflow Retired',
        `Task ${taskId} belongs to the legacy Delivery workflow, which ADR-135 removed; an operator must deliver it by hand`);
    }

    let currentStatus = (task?.status || '').toLowerCase();
    const reopened = await reopenInterruptedDelivery(task, taskId, auth.userId);
    if (reopened === 'failed') return problem(c, 503, 'Delivery Not Restarted', 'The interrupted delivery could not be taken back to approved; try again');
    if (reopened === 'reopened') currentStatus = 'approved';
    const change = await changeBlockingDelivery(task, taskId);
    if (change === null) return problem(c, 503, 'Database Unavailable', 'Whether the client asked for a change could not be checked; try again');
    if (change) return problem(c, 409, 'Changed At The Client\'s Request', `${pendingChangeWords(change)} The approved version was not delivered.`);
    const retryingPublication = ['archive_reconciliation', 'publish_reconciliation'].includes(currentStatus);
    if (policy !== 'deliver_approved_stored' && currentStatus !== 'approved' && !retryingPublication) {
      const stored = currentStatus === 'complete' ? await storedCompletePublication(task, taskId) : null;
      if (stored) return c.json({ commandId: crypto.randomUUID(), taskId, workflowId: `wf_${taskId}`, publicationId: stored.publicationId, status: 'COMPLETE', receipt: stored, acceptedAt: new Date().toISOString() }, 200);
      return problem(c, currentStatus === 'awaiting_approval' ? 409 : 422, 'Cannot Publish Unapproved Task', `Task ${taskId} is in status '${currentStatus}', not 'approved'`);
    }

    const result = await executeOmnichannelPublish(
      taskId,
      { type: 'user', id: auth.userId },
      policy === 'deliver_approved_stored' ? `Stored approval delivered by an administrator: ${String(body.reason).trim()}` : 'Publication triggered',
      false,
      { policy, designRevisionId: targetRevisionId, approvalId: requestedApprovalId }
    );

    if (!result.ok) {
      // (A 202 DELIVERED_TO_CHAT_ONLY, the old requester send after a Drive failure, went with
      // ADR-135 stage 2d: Core's own delivery sends nothing to a requester.)
      const status = (result as any).status || 422;
      const title = (result as any).title || (status === 409 ? 'Conflict' : status === 404 ? 'Task Not Found' : 'Publication Failed');
      return problem(c, status, title, (result as any).message || 'The publisher refused the delivery');
    }

    const receipt = result.publicationReceipt || result.receipt;
    const sheetsConfirmed = result.complete !== false && receipt?.state === 'complete';
    const finalStatus = sheetsConfirmed ? 'COMPLETE' : 'PUBLISH_RECONCILIATION';

    return c.json({
      commandId: crypto.randomUUID(),
      taskId,
      workflowId: `wf_${taskId}`,
      publicationId: receipt?.publicationId || `pub_${taskId}`,
      status: finalStatus,
      ...(sheetsConfirmed ? {} : { sheetProblem: receipt?.detail?.sheetProblem ?? result.sheetProblem ?? null }),
      receipt,
      acceptedAt: new Date().toISOString(),
    }, sheetsConfirmed && result.alreadyCompleted ? 200 : 202);
  });

  // Task R07: Actionable query of durable publication state & reconciliation needs
  registerRoute('get', '/tasks/:taskId/publication-state', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const taskId = c.req.param('taskId');
    // The publication, its files and row, and the outbox are only held in Postgres. Without it, or
    // when it cannot be read, there is no state to report: "unstarted" would say nothing was sent.
    if (!db || !publicationRepo) return problem(c, 503, 'Database Unavailable', 'Publication state is only held in the database');

    let pubRecord: any = null;
    let driveRefs: any[] = [];
    let sheetSyncs: any[] = [];
    let outboxCmds: any[] = [];
    let storedState: string | null = null;
    let completionEvidence: { source: 'staff_visible'; actorId: string | null; recordedAt: string } | null = null;

    if (isValidUuid(taskId)) {
      try {
        await withRlsContext(
          db,
          { tenantId: auth.tenantId, userId: auth.userId, role: auth.role },
          async (trx) => {
            pubRecord = await publicationRepo.findByTaskId(taskId, auth.tenantId, trx);
            if (pubRecord) {
              const full = await publicationRepo.getPublicationWithRefs(pubRecord.id, auth.tenantId, trx);
              if (full) {
                driveRefs = full.driveRefs;
                sheetSyncs = full.sheetSyncs;
              }
            }
            if (outboxRepo) {
              outboxCmds = await outboxRepo.findByAggregateId(auth.tenantId, 'task', taskId, trx);
            }
            if (taskRepo) storedState = (await taskRepo.findById(taskId, auth.tenantId, trx))?.state ?? null;
            if (storedState === 'complete') {
              const lastChange = await trx.selectFrom('task_events').select(['actor_id', 'data', 'occurred_at'])
                .where('tenant_id', '=', auth.tenantId).where('task_id', '=', taskId)
                .where('event_type', '=', 'task.state_changed')
                .orderBy('aggregate_version', 'desc').limit(1).executeTakeFirst();
              if (lastChange?.data?.confirmationSource === 'staff_visible') {
                completionEvidence = { source: 'staff_visible', actorId: lastChange.actor_id,
                  recordedAt: lastChange.occurred_at.toISOString() };
              }
            }
          }
        );
      } catch (err) {
        log.error('[core:pub_state:query] DB error:', err);
        return problem(c, 503, 'Database Unavailable', 'The publication state could not be read; try again');
      }
    }

    const task = tasks.get(taskId);
    // The task's own status: the in-memory one, else the stored one (every task after a restart). It
    // used to fall back to 'PENDING', a word no layer knows; with neither, there is no status to report.
    const taskStatus = storedState && isTaskDbState(storedState)
      ? publicationAwareTaskStatus(storedState, { errorClass: pubRecord?.error_class })
      : task?.status
      ?? (pubRecord?.state === 'complete' ? 'COMPLETE' : (pubRecord?.state === 'drive_complete' ? 'PUBLISH_RECONCILIATION' : null));

    // What the delivery recorded in Postgres; a copy this process kept is no longer consulted.
    const hasDriveFiles = driveRefs.length > 0;
    const driveVerified = hasDriveFiles && driveRefs.every((r: any) => r.status === 'verified');

    const hasSheetSync = sheetSyncs.length > 0;
    const sheetSynced = hasSheetSync && sheetSyncs.some((s: any) => s.status === 'synced');

    const notificationCmd = outboxCmds.find((c: any) => c.command_type === 'notify.published');
    const notificationStatus = notificationCmd ? notificationCmd.state : 'not_enqueued';

    let actionableRecovery = 'Publication, sheet sync, and notification completed successfully.';
    let state: 'unstarted' | 'drive_complete' | 'archive_reconciliation' | 'publish_reconciliation' | 'requester_send_reconciliation' | 'complete' | 'failed' = 'complete';

    if (pubRecord?.error_class === 'ARCHIVE_UNCONFIRMED') {
      state = 'archive_reconciliation';
      actionableRecovery = storedState === 'cancelled'
        ? 'This task was cancelled while the Drive outcome was unresolved. Do not retry requester delivery. An operator must inspect the reserved Drive file identity and apply the office retention policy.'
        : 'Drive may already contain the approved files, but the archive is not verified. Restore Google access if needed, then use Recheck Drive Archive. The same reserved file ID is checked before requester delivery; a continuing conflict needs an operator to inspect Drive.';
    } else if (pubRecord?.executor === 'restate' && pubRecord.error_class === 'REQUESTER_SEND_UNCONFIRMED') {
      state = 'requester_send_reconciliation';
      actionableRecovery = 'Requester delivery did not complete or could not be confirmed. An operator must inspect the Telegram chat and send records before resolving it; do not retry delivery or Sheet sync.';
    } else if (!hasDriveFiles) {
      state = 'unstarted';
      actionableRecovery = 'No publication has been initiated. Trigger POST /tasks/:taskId/publish to deliver assets.';
    } else if (!sheetSynced) {
      state = 'publish_reconciliation';
      actionableRecovery = 'Drive files are safely verified, but Sheets row sync is pending or failed. Retry POST /tasks/:taskId/publish: existing Drive files will be preserved and only the Sheets row will be synchronized.';
    } else if (notificationStatus === 'failed') {
      state = 'complete';
      actionableRecovery = 'Task and publication are complete. Telegram notification failed. Use POST /tasks/:taskId/outbox/:commandId/redrive to re-dispatch notification without re-delivering assets.';
    } else if (notificationStatus === 'pending') {
      state = 'complete';
      actionableRecovery = 'Task and publication are complete. Notification is queued for delivery by the outbox worker.';
    } else if (pubRecord?.executor === 'restate' && pubRecord.state === 'complete') {
      state = 'complete';
      actionableRecovery = completionEvidence
        ? 'Archive and Sheet are confirmed. Office staff recorded every approved item visible in the requester chat. A requester read receipt is unavailable.'
        : 'Archive and Sheet are confirmed. The request-owned workflow reported requester sends complete; a requester read receipt is unavailable.';
    }

    return c.json({
      taskId,
      status: taskStatus,
      state,
      driveFiles: {
        verified: driveVerified,
        count: driveRefs.length,
      },
      sheetSync: {
        synced: sheetSynced,
        // pg returns the bigint column as a string; the answer is a number, as the receipt's is.
        rowNumber: sheetSyncs[0]?.row_number != null ? Number(sheetSyncs[0].row_number) : null,
      },
      notification: {
        commandId: notificationCmd?.id || null,
        status: notificationStatus,
        attempts: notificationCmd?.attempts || 0,
        errorMessage: notificationCmd?.error_message || null,
      },
      completionEvidence,
      actionableRecovery,
    });
  });

  // R09: show the stored Telegram attempt marks for one unresolved request-owned publication.
  // A mark is local evidence of a sender attempt, never a requester-read receipt.
  registerRoute('get', '/tasks/:taskId/requester-send-evidence', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator', 'art_director', 'creative_director', 'office_admin'].includes(auth.role)) {
      return problem(c, 403, 'Office Role Required', 'Only authorized office staff may inspect requester send evidence');
    }
    const taskId = c.req.param('taskId');
    if (!isValidUuid(taskId)) return problem(c, 404, 'Task Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable', 'Requester send evidence is held in the database');
    try {
      const result = await readRequesterSendEvidence(db, { tenantId: auth.tenantId,
        userId: auth.userId, role: auth.role, taskId });
      if (result.kind === 'not_found') return problem(c, 404, 'Task Not Found');
      if (result.kind === 'wrong_state') return problem(c, 409, 'No Uncertain Requester Send',
        'This task has no current unresolved request-owned Telegram delivery');
      return c.json(result.evidence);
    } catch (err) {
      log.error('[core:requester-send-evidence] Could not read send marks:', err);
      return problem(c, 503, 'Send Evidence Unavailable', 'The Telegram send records could not be read safely');
    }
  });

  // A staff attestation of exact messages visible in the requester chat. This never sends or
  // releases a Telegram message; inconclusive cases stay in reconciliation.
  registerRoute('post', '/tasks/:taskId/requester-send-confirmation', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return problem(c, 401, 'Authentication Required');
    if (!['office_admin', 'administrator'].includes(auth.role)) {
      return problem(c, 403, 'Office Administrator Required');
    }
    const taskId = c.req.param('taskId');
    if (!isValidUuid(taskId)) return problem(c, 404, 'Task Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable');
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).some((key) =>
      !['actionId', 'expectedRev', 'publicationId', 'approvalId', 'requesterChatId', 'observed', 'attested'].includes(key))) {
      return problem(c, 422, 'Invalid Confirmation', 'Use the current request revision and exact message IDs');
    }
    try {
      const result = await confirmRequesterSendVisible(db, { tenantId: auth.tenantId, taskId,
        actor: { userId: auth.userId, role: auth.role },
        actionId: body.actionId as string, expectedRev: body.expectedRev as number,
        publicationId: body.publicationId as string, approvalId: body.approvalId as string,
        requesterChatId: body.requesterChatId as string,
        observed: body.observed as Array<{ sendKey: string; messageId: string }>,
        attested: body.attested as true });
      return c.json(result);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        const status = error.code === 'INVALID_CONFIRMATION' ? 422 : error.code === 'UNAUTHORIZED_ACTOR' ? 403 : 409;
        return problem(c, status, 'Requester Send Confirmation Refused', error.message);
      }
      log.error('[core:requester-send-confirmation] Could not confirm send:', error);
      return problem(c, 503, 'Confirmation Unavailable', 'The delivery remains unresolved; retry with the same action key');
    }
  });

  // --- Two-Way Outbound Review Dispatch (FR-014, FR-081) ---
  registerRoute('post', '/campaigns/:taskId/dispatch-review', async (c: any) => {
    const taskId = c.req.param('taskId');
    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json().catch(() => ({}));
    // The review goes to this task's client. It used to fall back to whichever client the map listed
    // first, then to a phone number written in this file: a stranger's draft to a stranger's phone.
    const client = await resolveClientDna(task.clientId);
    const recipientPhone = body.phone || (client as any)?.contactChannels?.phone;

    // The client reviews their own copy: a line they did not send is left out of the message, and a
    // task with no headline at all is refused rather than sent with placeholder text.
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const headlineCkb = text(task.headlineCkb) || text(body.headlineCkb);
    const headlineEn = text(task.headlineEn) || text(body.headlineEn);
    if (!headlineCkb && !headlineEn) return problem(c, 422, 'COPY_REQUIRED', COPY_REQUIRED_DETAIL);
    if (!recipientPhone) return problem(c, 422, 'No Review Recipient', 'The client of this task has no review phone number and none was given');

    const dispatch = buildOutboundReviewDispatch({
      taskId,
      clientId: task.clientId || defaultClientId,
      clientName: client?.name || 'Drustee Evidence-First Health',
      recipientPhone,
      headlineCkb,
      headlineEn,
      copyCkb: text(task.copyCkb) || text(body.copyCkb),
      copyEn: text(task.copyEn) || text(body.copyEn),
      brandName: (client as any)?.brandName || client?.name || 'Drustee',
      formats: body.formats || ['feed', 'story', 'square', 'landscape'],
      callbackBaseUrl: body.callbackBaseUrl || process.env.PUBLIC_API_URL || process.env.CORE_URL || 'http://localhost:3001',
    });

    task.outboundDispatch = dispatch;
    task.status = 'AWAITING_APPROVAL';
    broadcast('campaign:dispatched_for_review', { taskId, dispatchId: dispatch.dispatchId, recipientPhone });

    return c.json({
      ok: true,
      dispatch,
    }, 200);
  });

  // --- 4-in-1 Omnichannel Production Outbox Dispatch to Google Drive & Sheets (FR-012, FR-082, CV-15) ---
  registerRoute('post', '/tasks/:taskId/publish-omnichannel', async (c: any) => {
    const taskId = c.req.param('taskId');
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    if (task.requestId) return problem(c, 409, 'LIFECYCLE_OWNED',
      'Deliver this request through RequestLifecycle; the legacy publisher cannot send it');
    const auth = verifyRequestAuth(c);
    const body = await c.req.json().catch(() => ({}));
    const storedRefused = storedPolicyRefusal(c, auth, body);
    if (storedRefused) return storedRefused;
    const policy = body.policy || 'current_task';
    const targetRevisionId = body.designRevisionId;
    const requestedApprovalId = body.approvalId;

    // Invariant: B cannot ship using A's approval (CV-15)
    if (targetRevisionId && task.latestApproval) {
      if (task.latestApproval.designRevisionId !== targetRevisionId && policy !== 'deliver_approved_stored') {
        return problem(c, 409, 'Conflict', `Revision mismatch: Approval is bound to revision '${task.latestApproval.designRevisionId}', cannot be used to publish target revision '${targetRevisionId}'. B cannot ship using A's approval.`);
      }
      if (task.latestApproval.invalidated && policy !== 'deliver_approved_stored') {
        return problem(c, 409, 'Conflict', 'Previous approval was invalidated by subsequent edits. Re-approval required.');
      }
    }

    if (requestedApprovalId && task.latestApproval && task.latestApproval.decisionId !== requestedApprovalId && policy !== 'deliver_approved_stored') {
      return problem(c, 409, 'Conflict', `Approval ID mismatch: requested approval '${requestedApprovalId}' does not match active approval.`);
    }

    let currentStatus = (task.status || '').toLowerCase();
    // Postgres has no state for files delivered with the Sheets row unconfirmed: the task stays
    // 'publishing' there. Its retry used to rely on this process remembering PUBLISH_RECONCILIATION,
    // which a restart or a second process did not; as in POST publish, a delivery that is not running
    // goes back to approved and is delivered again (the Drive files are adopted, not uploaded twice).
    const reopened = await reopenInterruptedDelivery(task, taskId, verifyRequestAuth(c).userId);
    if (reopened === 'failed') return problem(c, 503, 'Delivery Not Restarted', 'The interrupted delivery could not be taken back to approved; try again');
    if (reopened === 'reopened') currentStatus = 'approved';
    // A delivered task answers with what its delivery recorded in Postgres, whichever process made it.
    const existingReceipt = currentStatus === 'complete'
      ? await storedReceipt(verifyRequestAuth(c), taskId).catch((err: unknown) => {
          // The delivery reads the publication row again before it sends anything.
          log.warn('[core:omnichannel] Could not read the stored publication:', err);
          return null;
        })
      : null;
    if (existingReceipt?.state === 'complete') {
      const client = await resolveClientDna(task.clientId);
      const targetFolderId = client?.destinations?.productionFolderId || (client as any)?.productionDestinations?.googleDriveFolderId;
      const spreadsheetId = client?.destinations?.spreadsheetId || (client as any)?.productionDestinations?.googleSheetId || '';
      return c.json({
        ok: true,
        taskId,
        status: 'COMPLETE',
        complete: true,
        // Marked as stored, as a delivery adopted in deliverOmnichannel is: a caller counting
        // deliveries told this one apart from a fresh one only by the marker.
        alreadyCompleted: true,
        publicationReceipt: { ...existingReceipt, detail: { verified: true, filesUploaded: existingReceipt.files.length, alreadyCompleted: true } },
        driveFolderUrl: `https://drive.google.com/drive/folders/${targetFolderId}`,
        sheetRowUrl: spreadsheetId && existingReceipt.sheetRow?.rowNumber ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}#gid=0&range=A${existingReceipt.sheetRow.rowNumber}` : null,
        filesCount: existingReceipt.files.length,
        publishedAt: existingReceipt.completedAt || existingReceipt.sheetRow?.syncedAt || new Date().toISOString(),
      }, 200);
    }
    if (policy !== 'deliver_approved_stored' && currentStatus !== 'approved' &&
        currentStatus !== 'archive_reconciliation' && currentStatus !== 'publish_reconciliation') {
      return problem(c, 409, 'Conflict', `Task ${taskId} is in status '${task.status}', not 'approved'`);
    }

    const result = await executeOmnichannelPublish(
      taskId,
      { type: 'user', id: auth.userId || 'operator' },
      policy === 'deliver_approved_stored' ? `Stored approval delivered by an administrator: ${String(body.reason).trim()}` : 'Omnichannel publication started',
      false,
      { policy, designRevisionId: targetRevisionId, approvalId: requestedApprovalId }
    );
    if (!result.ok) {
      const status = (result as any).status || 500;
      const title = status === 409 ? 'Conflict' : status === 404 ? 'Task Not Found' : 'Publish Error';
      return problem(c, status, title, (result as any).message || 'Publish failed');
    }
    // 202 while the Sheets row is unconfirmed: the files are delivered, the publication is not complete.
    return c.json(result, (result as any).complete === false ? 202 : 200);
  });

  // What the task's latest delivery recorded in Postgres: its confirmed Drive files and Sheets row.
  registerRoute('get', '/tasks/:taskId/publication-receipt', async (c: any) => {
    const taskId = c.req.param('taskId');
    if (!db || !publicationRepo) return problem(c, 503, 'Database Unavailable', 'Publication receipts are only held in the database');
    const receipt = await storedReceipt(verifyRequestAuth(c), taskId).catch((err: unknown) => {
      log.error('[core:pub_receipt:query] DB error:', err);
      return undefined;
    });
    if (receipt === undefined) return problem(c, 503, 'Database Unavailable', 'The publication receipt could not be read; try again');
    if (!receipt) return problem(c, 404, 'Task Not Found', 'No publication receipt found for task');
    return c.json({ ok: true, taskId, receipt }, 200);
  });
}
