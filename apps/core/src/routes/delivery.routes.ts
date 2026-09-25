import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID, lifecycleOwnsChat, publicationAwareTaskStatus, isTaskDbState } from '@hawa/contracts';
import { withRlsContext, toApiTaskStatus } from '@hawa/db';
import { buildOutboundReviewDispatch, signLifecycleOfficeEvent } from '@hawa/integrations';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid, COPY_REQUIRED_DETAIL } from '../core-helpers.js';
import { log } from '../logging.js';
import { pendingChangeWords } from '../services/pending-change.js';
import { readPublicationReceipt } from '../services/publication-receipt.js';
import { DELIVERY_OWNED_BY_CORE } from '../services/omnichannel-delivery.js';

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
    requesterChatOf, deliveryExecutorOfTask, startWorkflowDelivery,
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
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => !['destination', 'approvalId'].includes(key)) ||
          (body.destination !== undefined && body.destination !== 'google_drive') ||
          (body.approvalId !== undefined && !isValidUuid(String(body.approvalId)))) {
        return problem(c, 422, 'Invalid Delivery Request', 'Deliver the current approval to Google Drive with one stable action key');
      }
      if (!db || !taskRepo || !publicationRepo) return problem(c, 503, 'Database Unavailable',
        'Request-owned delivery requires the persistent request ledger');
      const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
      const requestId = task.requestId;
      const current = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, async (trx) => {
        const request = await trx.selectFrom('requests').select(['rev', 'owner', 'stage', 'current_task_id'])
          .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).executeTakeFirst();
        const approval = await trx.selectFrom('approvals').select(['id', 'design_revision_id'])
          .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).where('decision', '=', 'approved')
          .orderBy('created_at', 'desc').executeTakeFirst();
        const receipts = await trx.selectFrom('lifecycle_projections').select(['rev', 'result'])
          .where('tenant_id', '=', tenantId).where('request_id', '=', requestId)
          .where('idempotency_key', 'like', `${requestId}:%:officeDecision:desk:${actionId}`)
          .orderBy('rev', 'desc').executeTakeFirst();
        return { request, approval, receipts };
      });
      if (!current.request || current.request.owner !== 'restate' || current.request.current_task_id !== taskId ||
          !current.approval) {
        return problem(c, 409, 'Lifecycle Owner Mismatch', 'This task has no current request-owned approval');
      }
      const approvalId = String(body.approvalId || current.approval.id);
      if (approvalId !== current.approval.id) return problem(c, 409, 'Approval Changed', 'The requested approval is not current');
      const expectedRev = current.receipts ? Number(current.receipts.rev) - 1 : Number(current.request.rev);
      const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
      const secret = (process.env.HAWA_WORKER_TOKEN || '').trim();
      if (!ingress || !secret) return problem(c, 503, 'Lifecycle Delivery Unavailable',
        'The signed delivery gateway is not configured; retry this action later');
      const event = { v: 1 as const, kind: 'deliver' as const, eventId: `desk:${actionId}`,
        requestId, taskId, revisionId: current.approval.design_revision_id, approvalId, actionId,
        expectedRev, actor: { userId: auth.userId, role: officeRole }, reason: 'Deliver approved files' };
      const signature = signLifecycleOfficeEvent(secret, event);
      try {
        const response = await fetch(`${ingress}/OfficeDecisionGateway/decide`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (response.ok && result?.accepted === true && result.requestId === requestId &&
            result.taskId === taskId && result.approvalId === approvalId && result.actionId === actionId &&
            typeof result.deliveryId === 'string' && Number.isInteger(result.rev) && Number(result.rev) >= 4) {
          const status = result.stage === 'delivered' ? 'COMPLETE'
            : result.stage === 'approved' ? 'DELIVERY_RETRY_REQUIRED' : 'PUBLISHING';
          return c.json({ taskId, requestId, deliveryId: result.deliveryId, workflowId: result.deliveryId,
            executor: 'restate', status,
            requestRev: result.rev, acceptedAt: new Date().toISOString() }, result.stage === 'delivering' ? 202 : 200);
        }
        if (response.ok && result?.accepted === false) return problem(c, 409, 'Stale Lifecycle Delivery',
          'The request is no longer approved for this delivery; refresh the task');
        if (response.status === 400 || response.status === 409) return problem(c, 409, 'Lifecycle Action Conflict',
          'This action key, approval or request revision no longer matches; refresh the task');
        log.warn(`[core:publish] Lifecycle gateway HTTP ${response.status} for request ${requestId}`);
      } catch (error) {
        log.warn(`[core:publish] Lifecycle gateway did not answer for request ${requestId}:`, error);
      }
      return problem(c, 503, 'Lifecycle Delivery Uncertain',
        'Delivery may have started. Retry with the same action key; no second workflow will be created');
    }

    const body = await c.req.json().catch(() => ({}));
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

    // Slice 2.2 (PHASE2_DESIGN.md section 3, ADR-034): a task whose chat is on HAWA_LIFECYCLE_CHATS
    // when Deliver is pressed is delivered by the Restate Delivery workflow, and so is every later
    // press for a publication the workflow already owns, even once its chat is taken off the list.
    // A delivery Core's own path started stays Core's: it may have sent the files already. With the
    // list empty nothing here changes: a publication the workflow owns is still refused by Core's own
    // delivery, under its lock, if the read below could not tell.
    const executor = await deliveryExecutorOfTask(task, taskId).catch((err: unknown) => {
      log.warn('[core:publish] Could not read who delivers this task; Core\'s own delivery checks again under its lock:', err);
      return undefined;
    });
    const requesterChat = executor === 'restate' || (executor === null && process.env.HAWA_LIFECYCLE_CHATS) ? await requesterChatOf(task, taskId) : null;
    const byWorkflow = executor === 'restate' || (executor === null && lifecycleOwnsChat(requesterChat));
    let started: Awaited<ReturnType<typeof startWorkflowDelivery>> | null = null;
    if (byWorkflow) {
      const change = await changeBlockingDelivery(task, taskId);
      if (change === null) return problem(c, 503, 'Database Unavailable', 'Whether the client asked for a change could not be checked; try again');
      if (change) return problem(c, 409, 'Changed At The Client\'s Request', `${pendingChangeWords(change)} The approved version was not delivered.`);
      const status = (task?.status || '').toLowerCase();
      if (status === 'complete') {
        const stored = await storedCompletePublication(task, taskId);
        if (stored) return c.json({ commandId: crypto.randomUUID(), taskId, workflowId: `wf_${taskId}`, publicationId: stored.publicationId, status: 'COMPLETE', receipt: stored, acceptedAt: new Date().toISOString() }, 200);
      }
      if (policy !== 'deliver_approved_stored' && !['approved', 'publishing', 'archive_reconciliation', 'publish_reconciliation'].includes(status)) {
        return problem(c, status === 'awaiting_approval' ? 409 : 422, 'Cannot Publish Unapproved Task', `Task ${taskId} is in status '${status}', not 'approved'`);
      }
      started = await startWorkflowDelivery(taskId, {
        actorId: auth.userId, chatId: requesterChat, policy, designRevisionId: targetRevisionId, approvalId: requestedApprovalId,
      });
    }
    // Core's own delivery had started this publication after all (read under the lock): it finishes it.
    if (started && !started.ok && started.code === DELIVERY_OWNED_BY_CORE) started = null;
    if (started) {
      if (!started.ok) {
        const titles: Record<number, string> = { 404: 'Task Not Found', 409: 'Conflict', 422: 'Nothing Approved To Deliver', 503: 'Delivery Not Started' };
        return problem(c, started.status, titles[started.status] || 'Publication Failed', started.message);
      }
      if ('complete' in started) {
        const stored = await storedCompletePublication(task, taskId);
        return c.json({ commandId: crypto.randomUUID(), taskId, workflowId: `wf_${taskId}`, publicationId: started.publicationId, status: 'COMPLETE', receipt: stored, acceptedAt: new Date().toISOString() }, 200);
      }
      // Accepted, not done: the workflow sends the files and reports back, and the task moves then.
      return c.json({
        commandId: crypto.randomUUID(),
        taskId,
        workflowId: started.deliveryId,
        deliveryId: started.deliveryId,
        executor: 'restate',
        status: started.recorded ? 'DELIVERY_RECORDED' : 'PUBLISHING',
        alreadyDelivering: started.alreadyRunning,
        ...(started.recorded ? { recordedOutcome: started.recorded } : {}),
        acceptedAt: new Date().toISOString(),
      }, 202);
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
      'Publication triggered',
      false,
      { policy, designRevisionId: targetRevisionId, approvalId: requestedApprovalId }
    );

    if (!result.ok) {
      // Drive refused and the approved file went to the requester's chat: the delivery happened and
      // only the archive did not, so it is not reported as an error. The Desk showed a red "Delivery
      // failed" for a file the client had received.
      if ((result as { requesterNotified?: boolean }).requesterNotified) {
        return c.json({
          ok: true,
          status: 'DELIVERED_TO_CHAT_ONLY',
          taskId,
          code: (result as { code?: string }).code || 'ARCHIVE_NOT_WRITTEN',
          message: (result as { message?: string }).message || 'The approved file is queued for the requester in Telegram; the Drive archive is not written.',
          requesterNotified: true,
        }, 202);
      }
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
    let state: 'unstarted' | 'drive_complete' | 'archive_reconciliation' | 'publish_reconciliation' | 'complete' | 'failed' = 'complete';

    if (pubRecord?.error_class === 'ARCHIVE_UNCONFIRMED') {
      state = 'archive_reconciliation';
      actionableRecovery = storedState === 'cancelled'
        ? 'This task was cancelled while the Drive outcome was unresolved. Do not retry requester delivery. An operator must inspect the reserved Drive file identity and apply the office retention policy.'
        : 'Drive may already contain the approved files, but the archive is not verified. Restore Google access if needed, then use Recheck Drive Archive. The same reserved file ID is checked before requester delivery; a continuing conflict needs an operator to inspect Drive.';
    } else if (pubRecord?.executor === 'restate' && pubRecord.error_class === 'REQUESTER_SEND_UNCONFIRMED') {
      state = 'publish_reconciliation';
      actionableRecovery = 'The archive and Sheet row may be ready, but delivery to the requester was not confirmed. Review the Telegram send evidence before resolving this delivery.';
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
      actionableRecovery,
    });
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
    const body = await c.req.json().catch(() => ({}));
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
      { type: 'user', id: 'operator' },
      'Omnichannel publication started',
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
