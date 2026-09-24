import crypto from 'node:crypto';
import { withRlsContext, toApiTaskStatus } from '@hawa/db';
import { buildOutboundReviewDispatch } from '@hawa/integrations';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID } from '../core-context.js';
import { isValidUuid, COPY_REQUIRED_DETAIL } from '../core-helpers.js';
import { log } from '../logging.js';
import { pendingChangeWords } from '../services/pending-change.js';

/**
 * Delivery of an approved design and what it left behind (architecture programme 1.3, group G5,
 * moved from app.ts unchanged): POST publish, GET publication-state, the WhatsApp review dispatch,
 * POST publish-omnichannel and GET publication-receipt. The delivery itself is
 * services/omnichannel-delivery.ts, reached through ctx.delivery.
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
    omnichannelReceipts,
    inFlightPublications,
    inMemoryOutbox,
    readCurrentTask,
    resolveTaskWithFallback,
    resolveClientDna,
    broadcastEvent: broadcast,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };
  const { executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery } = ctx.delivery;
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Publish Task (Gate G: Truthful, Authenticated, Durable Google Workspace Publication)
  registerRoute('post', '/tasks/:taskId/publish', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to trigger publication');
    }

    const taskId = c.req.param('taskId');
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

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

    let currentStatus = (task?.status || '').toLowerCase();
    const reopened = await reopenInterruptedDelivery(task, taskId, auth.userId);
    if (reopened === 'failed') return problem(c, 503, 'Delivery Not Restarted', 'The interrupted delivery could not be taken back to approved; try again');
    if (reopened === 'reopened') currentStatus = 'approved';
    const change = await changeBlockingDelivery(task, taskId);
    if (change === null) return problem(c, 503, 'Database Unavailable', 'Whether the client asked for a change could not be checked; try again');
    if (change) return problem(c, 409, 'Changed At The Client\'s Request', `${pendingChangeWords(change)} The approved version was not delivered.`);
    const retryingSheetRow = currentStatus === 'publish_reconciliation';
    if (policy !== 'deliver_approved_stored' && currentStatus !== 'approved' && !retryingSheetRow) {
      if (currentStatus === 'complete' && omnichannelReceipts.has(taskId)) {
        const existing = omnichannelReceipts.get(taskId);
        return c.json({
          commandId: crypto.randomUUID(),
          taskId,
          workflowId: `wf_${taskId}`,
          publicationId: existing?.receipt?.publicationId || `pub_${taskId}`,
          status: 'COMPLETE',
          receipt: existing?.receipt || existing,
          acceptedAt: new Date().toISOString(),
        }, 200);
      }
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

    const receipt = result.publicationReceipt || result.receipt || omnichannelReceipts.get(taskId)?.receipt;
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

    let pubRecord: any = null;
    let driveRefs: any[] = [];
    let sheetSyncs: any[] = [];
    let outboxCmds: any[] = [];
    let storedState: string | null = null;

    if (db && publicationRepo && isValidUuid(taskId)) {
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
      }
    }

    // In-memory fallback
    const memReceipt = omnichannelReceipts.get(taskId);
    if (outboxCmds.length === 0) {
      outboxCmds = inMemoryOutbox.get(taskId) || [];
    }

    const task = tasks.get(taskId);
    // The task's own status: the in-memory one, else the stored one (every task after a restart). It
    // used to fall back to 'PENDING', a word no layer knows; with neither, there is no status to report.
    const taskStatus = task?.status
      ?? (storedState ? toApiTaskStatus(storedState) : null)
      ?? (pubRecord?.state === 'complete' ? 'COMPLETE' : (pubRecord?.state === 'drive_complete' ? 'PUBLISH_RECONCILIATION' : null));

    const hasDriveFiles = driveRefs.length > 0 || (memReceipt?.files && memReceipt.files.length > 0);
    const driveVerified = hasDriveFiles && (
      driveRefs.length > 0
        ? driveRefs.every((r: any) => r.status === 'verified')
        : (memReceipt?.receipt?.detail?.verified ?? true)
    );

    const hasSheetSync = sheetSyncs.length > 0 || Boolean(memReceipt?.sheetRow);
    const sheetSynced = hasSheetSync && (
      sheetSyncs.length > 0
        ? sheetSyncs.some((s: any) => s.status === 'synced')
        : (memReceipt?.sheetRow?.status === 'COMPLETE' || memReceipt?.receipt?.sheet?.synced)
    );

    const notificationCmd = outboxCmds.find((c: any) => c.command_type === 'notify.published');
    const notificationStatus = notificationCmd ? notificationCmd.state : 'not_enqueued';

    let actionableRecovery = 'Publication, sheet sync, and notification completed successfully.';
    let state: 'unstarted' | 'drive_complete' | 'publish_reconciliation' | 'complete' | 'failed' = 'complete';

    if (!hasDriveFiles) {
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
        count: driveRefs.length || memReceipt?.files?.length || 0,
      },
      sheetSync: {
        synced: sheetSynced,
        rowNumber: sheetSyncs[0]?.row_number ?? memReceipt?.sheetRow?.rowNumber ?? null,
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
    const body = await c.req.json().catch(() => ({}));
    const policy = body.policy || 'current_task';
    const targetRevisionId = body.designRevisionId;
    const requestedApprovalId = body.approvalId;

    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

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

    const currentStatus = (task.status || '').toLowerCase();
    const existingReceipt = omnichannelReceipts.get(taskId);
    if (currentStatus === 'complete' && existingReceipt) {
      const client = await resolveClientDna(task.clientId);
      const targetFolderId = client?.destinations?.productionFolderId || (client as any)?.productionDestinations?.googleDriveFolderId;
      const spreadsheetId = client?.destinations?.spreadsheetId || (client as any)?.productionDestinations?.googleSheetId || '';
      return c.json({
        ok: true,
        taskId,
        status: 'COMPLETE',
        complete: true,
        publicationReceipt: existingReceipt.receipt || existingReceipt,
        driveFolderUrl: `https://drive.google.com/drive/folders/${targetFolderId}`,
        sheetRowUrl: spreadsheetId && existingReceipt.sheetRow?.rowNumber ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}#gid=0&range=A${existingReceipt.sheetRow.rowNumber}` : null,
        filesCount: existingReceipt.files?.length || 1,
        publishedAt: existingReceipt.sheetRow?.syncedAt || new Date().toISOString(),
      }, 200);
    }
    const approvalIdForLookup = requestedApprovalId || task.latestApproval?.decisionId || task.latestApproval?.approvalId;
    const inFlightKey = `pub_key_${taskId}_${approvalIdForLookup}`;
    if (inFlightPublications.has(inFlightKey)) {
      const inFlightRes = await inFlightPublications.get(inFlightKey);
      if (inFlightRes && inFlightRes.ok) {
        return c.json(inFlightRes, inFlightRes.complete === false ? 202 : 200);
      }
    }
    if (policy !== 'deliver_approved_stored' && currentStatus !== 'approved' && currentStatus !== 'publish_reconciliation') {
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

  registerRoute('get', '/tasks/:taskId/publication-receipt', (c: any) => {
    const taskId = c.req.param('taskId');
    const receipt = omnichannelReceipts.get(taskId);
    if (!receipt) return problem(c, 404, 'Task Not Found', 'No publication receipt found for task');
    return c.json({ ok: true, taskId, receipt }, 200);
  });
}
