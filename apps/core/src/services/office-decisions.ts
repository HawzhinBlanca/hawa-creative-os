/**
 * A reviewer's decision on a request-owned draft, and the start of its delivery: the Core actions the
 * Desk's Approve / Request Revision / Reject and Deliver buttons take (ADR-040, ADR-043). Moved here
 * from decisions.routes.ts and delivery.routes.ts, unchanged, by the ADR-040 addendum of 2026-09-30 so
 * that an office member's approval in Telegram (office-telegram-turn.ts) goes through exactly the same
 * checks, receipts, pinned-export proof and signed gateway calls as the Desk's. The routes still do
 * their own authentication, body parsing and role checks before calling these.
 */
import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { parseCompleteRevisionRequest, parseOfficeApprovalProof, type OfficeApprovalProof, type PinnedExport,
  type RejectionCategory, type StructuredRevisionRequest } from '@hawa/domain';
import { withRlsContext, type Database, type Kysely } from '@hawa/db';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import type { DeliverableStore } from './pinned-deliverables.js';
import { workerSigningSecretOf } from './worker-credential.js';
import { acknowledgeLateChange, acknowledgedLateChanges, pendingLateChanges } from './lifecycle-chat-target.js';

/** What a route answers: the JSON body, or a problem (with any extra fields the Desk reads). */
export type OfficeActionAnswer =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; title: string; detail: string; body?: Record<string, unknown> };

const json = (body: Record<string, unknown>, status: number): OfficeActionAnswer => ({ ok: true, status, body });
const fail = (status: number, title: string, detail: string): OfficeActionAnswer => ({ ok: false, status, title, detail });

export interface OwnedDecisionInput {
  tenantId: string; taskId: string; revisionId: string; requestId: string;
  /** The UUID action key (the Desk's Idempotency-Key; derived from the update in Telegram). */
  actionId: string;
  /** The signed-in principal: the database scope and the approval's `decided_by`. */
  auth: { userId: string; role: string };
  /** The office role the decision is made in (already checked by the caller). */
  officeRole: string;
  /** The decision as the Desk sends it; its fingerprint binds a retried action to the same content. */
  body: Record<string, unknown>;
  isOwnedApproval: boolean; isOwnedRejection: boolean;
  revisionRequest: StructuredRevisionRequest | null;
  rejectionCategory: RejectionCategory | null;
  pinIds: string[];
  reviewerSessionHash: string | null;
  /** ADR-040 addendum: the office member's private Telegram chat, when they decided there. */
  telegramChatId?: string;
}

/**
 * Sends one Desk decision (revise, approve with pinned exports, reject) for a request-owned draft
 * through the signed OfficeDecisionGateway. The private RequestLifecycle object owns the state; Core
 * never writes an owned decision here. A lost answer is retried with the same action key.
 */
export async function decideRequestOwned(deps: { db: Kysely<Database>; deliverableStore: DeliverableStore },
  input: OwnedDecisionInput): Promise<OfficeActionAnswer> {
  const { db, deliverableStore } = deps;
  const { tenantId, taskId, revisionId, requestId, actionId, auth, officeRole, body, isOwnedApproval, isOwnedRejection,
    revisionRequest, rejectionCategory, pinIds, reviewerSessionHash } = input;
  const review = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, async (trx) => ({
    request: await trx.selectFrom('requests').select(['owner', 'rev', 'stage', 'current_task_id'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).executeTakeFirst(),
    receipt: await trx.selectFrom('lifecycle_projections').select(['rev', 'result'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId)
      .where('idempotency_key', 'like', `${requestId}:%:officeDecision:desk:${actionId}`)
      .orderBy('rev', 'desc').executeTakeFirst(),
    prior: await trx.selectFrom('approvals').selectAll().where('tenant_id', '=', tenantId)
      .where('task_id', '=', taskId).where('nonce', '=', `desk:${actionId}`).executeTakeFirst(),
  }));
  if (!review.request || review.request.owner !== 'restate') {
    return fail(409, 'Lifecycle Owner Mismatch',
      'This task does not have an active request owner');
  }
  if (Boolean(review.receipt) !== Boolean(review.prior)) {
    return fail(503, 'Decision Receipt Incomplete', 'The decision and lifecycle receipt disagree; reconcile them before retrying');
  }
  const receiptResult = review.receipt?.result as Record<string, unknown> | undefined;
  if (review.receipt && (receiptResult?.requestId !== requestId || receiptResult?.actionId !== actionId ||
      receiptResult?.taskId !== taskId || receiptResult?.revisionId !== revisionId ||
      receiptResult?.approvalId !== review.prior?.id || receiptResult?.rev !== Number(review.receipt.rev) ||
      receiptResult?.stage !== (isOwnedApproval ? 'approved' : isOwnedRejection ? 'rejected' : 'manual'))) {
    return fail(409, 'Action Key Conflict', 'Idempotency-Key was already used for another lifecycle decision');
  }
  const expectedRev = review.receipt ? Number(review.receipt.rev) - 1 : Number(review.request.rev);
  const decisionRev = expectedRev + 1;
  if (!Number.isInteger(expectedRev) || expectedRev < 2 || Number(review.request.rev) < expectedRev ||
      (!review.receipt && (review.request.stage !== 'in_review' || review.request.current_task_id !== taskId))) {
    return fail(409, 'Stale Lifecycle Decision', 'The request is no longer reviewing this draft; refresh the task');
  }
  const deskRequestFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ taskId, revisionId, actorUserId: auth.userId, body })).digest('hex');
  let approvalProof: OfficeApprovalProof | null = null;
  let eventRole = officeRole;
  let eventReason = isOwnedApproval || isOwnedRejection ? (body.reason as string).trim() : revisionRequest!.comment;
  if (isOwnedApproval) {
    const prior = review.prior;
    if (prior) {
      const saved = prior.decision_payload as Record<string, unknown>;
      if (prior.decision !== 'approved' || prior.design_revision_id !== revisionId ||
          prior.decided_by !== auth.userId || saved.deskRequestFingerprint !== deskRequestFingerprint) {
        return fail(409, 'Action Key Conflict', 'Idempotency-Key was already used for a different decision');
      }
      approvalProof = parseOfficeApprovalProof(saved.officeApprovalProof);
      if (!approvalProof || typeof saved.approverRole !== 'string' || typeof prior.reason !== 'string') {
        return fail(503, 'Decision Receipt Incomplete', 'The committed decision lacks its replay proof; reconcile it before retrying');
      }
      eventRole = saved.approverRole;
      eventReason = prior.reason;
    } else {
      const rev = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, (trx) =>
        trx.selectFrom('design_revisions').select(['task_id', 'neutral_manifest'])
          .where('tenant_id', '=', tenantId).where('id', '=', revisionId).executeTakeFirst());
      const manifest = rev?.neutral_manifest as Record<string, unknown> | null;
      if (!rev || rev.task_id !== taskId || !Array.isArray(manifest?.nodes) || manifest.nodes.length === 0) {
        return fail(422, 'Cannot Approve Empty Design', 'The current revision has no editable design nodes');
      }
      const latestQc = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, (trx) =>
        trx.selectFrom('qc_runs').selectAll().where('tenant_id', '=', tenantId)
          .where('task_id', '=', taskId).where('design_revision_id', '=', revisionId)
          .orderBy('started_at', 'desc').executeTakeFirst());
      if (!latestQc || latestQc.status !== 'passed' || !latestQc.critical_pass) {
        return fail(412, 'QA Verification Required', 'The latest critical QA run must pass before approval');
      }
      let pins: PinnedExport[];
      try {
        const found = await deliverableStore.find(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pinIds);
        const byId = new Map(found.map((item) => [item.artifactId.toLowerCase(), item]));
        if (pinIds.some((id) => !byId.has(id))) {
          return fail(422, 'Export Not Found', 'Every selected export must be stored for this task');
        }
        pins = pinIds.map((id) => byId.get(id)!);
        for (const pin of pins) {
          const bytes = await deliverableStore.read(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pin.artifactId);
          if (!bytes || bytes.length !== pin.byteSize ||
              crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
            return fail(422, 'Export Changed', 'A selected export no longer matches its stored bytes');
          }
        }
      } catch (error) {
        log.warn('[core:approval] Could not read stored exports for lifecycle approval:', error);
        return fail(503, 'Export Store Unavailable', 'Selected export bytes could not be verified; retry the same action');
      }
      const report = latestQc.report as Record<string, unknown> | null;
      let rtlVisualReview: OfficeApprovalProof['rtlVisualReview'];
      if (report?.rtlVisualReviewRequired === true) {
        const visual = body.rtlVisualReview as Record<string, unknown> | undefined;
        if (visual?.confirmed !== true || visual.exportSha256 !== report.exportSha256 ||
            !pins.some((pin) => pin.format === 'png')) {
          return fail(412, 'RTL Visual Review Required',
            'Inspect and select the final PNG, then confirm visual review of the checked export');
        }
        rtlVisualReview = { confirmed: true, exportSha256: String(visual.exportSha256) };
      } else if (body.rtlVisualReview !== undefined) {
        return fail(422, 'Unexpected Visual Review', 'This QA run does not require an RTL visual sign-off');
      }
      approvalProof = parseOfficeApprovalProof({ qcRunId: latestQc.id,
        qcReportHash: latestQc.report_sha256, pinnedExports: pins,
        ...(rtlVisualReview ? { rtlVisualReview } : {}) });
      if (!approvalProof) return fail(422, 'Invalid Approval Proof', 'Stored QA or export evidence is malformed');
    }
  } else if (isOwnedRejection && review.prior) {
    const prior = review.prior;
    const saved = prior.decision_payload as Record<string, unknown>;
    if (prior.decision !== 'rejected' || prior.design_revision_id !== revisionId ||
        prior.decided_by !== auth.userId || prior.reason !== eventReason ||
        saved.rejectionCategory !== rejectionCategory ||
        typeof saved.approverRole !== 'string') {
      return fail(409, 'Action Key Conflict', 'Idempotency-Key was already used for a different decision');
    }
    eventRole = saved.approverRole;
    eventReason = prior.reason;
  } else if (review.prior) {
    const prior = review.prior;
    const saved = prior.decision_payload as Record<string, unknown>;
    const savedRequest = parseCompleteRevisionRequest(saved.revisionRequest);
    if (prior.decision !== 'revision_requested' || prior.design_revision_id !== revisionId ||
        prior.decided_by !== auth.userId || prior.reason !== revisionRequest!.comment ||
        typeof saved.approverRole !== 'string' || !savedRequest ||
        JSON.stringify(savedRequest) !== JSON.stringify(revisionRequest)) {
      return fail(409, 'Action Key Conflict', 'Idempotency-Key was already used for a different decision');
    }
    eventRole = saved.approverRole;
    eventReason = prior.reason;
  }
  if (review.receipt && Number(review.request.rev) > decisionRev) {
    // The request owner has moved past this decision. The committed approval and matching
    // projection receipt are sufficient to answer an exact old-action retry without replaying it.
    return json({ decisionId: review.prior!.id, taskId, designRevisionId: revisionId,
      decision: isOwnedApproval ? 'approved' : isOwnedRejection ? 'rejected' : 'revision_requested',
      actor: { userId: auth.userId, role: eventRole, verifiedServerSide: true },
      requestId, requestRev: decisionRev }, 201);
  }
  const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  const secret = workerSigningSecretOf() || '';
  if (!ingress || !secret) return fail(503, 'Lifecycle Decision Unavailable',
    'The decision gateway is not configured; retry this action later');
  const event = { v: 1 as const, eventId: `desk:${actionId}`, requestId, taskId, revisionId,
    actionId, expectedRev, kind: isOwnedApproval ? 'approve' as const : isOwnedRejection ? 'reject' as const : 'revise' as const,
    actor: { userId: auth.userId, role: eventRole,
      ...(reviewerSessionHash ? { authMethod: 'google_oidc' as const, sessionHash: reviewerSessionHash } : {}),
      ...(input.telegramChatId ? { authMethod: 'telegram_office' as const, telegramChatId: input.telegramChatId } : {}) },
    reason: eventReason,
    ...(isOwnedApproval ? { approvalProof: approvalProof!, deskRequestFingerprint } :
      isOwnedRejection ? { rejectionCategory } : { revisionRequest: revisionRequest! }) };
  const signature = signLifecycleOfficeEvent(secret, event);
  try {
    const response = await fetch(`${ingress}/OfficeDecisionGateway/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && result?.accepted === true && result.requestId === requestId &&
        result.taskId === taskId && result.revisionId === revisionId && result.actionId === actionId &&
        isValidUuid(result.approvalId as string) && result.rev === decisionRev &&
        result.stage === (isOwnedApproval ? 'approved' : isOwnedRejection ? 'rejected' : 'manual')) {
      return json({ decisionId: result.approvalId, taskId, designRevisionId: revisionId,
        decision: isOwnedApproval ? 'approved' : isOwnedRejection ? 'rejected' : 'revision_requested',
        actor: { userId: auth.userId, role: eventRole, verifiedServerSide: true },
        requestId, requestRev: decisionRev }, 201);
    }
    if (response.ok && result?.accepted === false) return fail(409, 'Stale Lifecycle Decision',
      'The request is no longer reviewing this draft; refresh the task');
    if (response.status === 400 || response.status === 409) return fail(409, 'Lifecycle Action Conflict',
      'This action key or draft no longer matches; refresh the task');
    log.warn(`[core:approval] Lifecycle gateway HTTP ${response.status} for request ${requestId}`);
  } catch (error) {
    log.warn(`[core:approval] Lifecycle gateway did not answer for request ${requestId}:`, error);
  }
  return fail(503, 'Lifecycle Decision Uncertain',
    'The decision may have committed. Retry with the same action key; no second decision will be created');
}

export interface OwnedDeliveryInput {
  tenantId: string; taskId: string; requestId: string;
  /** The UUID action key (the Desk's Idempotency-Key; derived from the update in Telegram). */
  actionId: string;
  auth: { userId: string; role: string };
  officeRole: string;
  /** The Desk's body: `approvalId` and `acknowledgeLateChanges` (Telegram update ids), both optional. */
  body: Record<string, unknown>;
  /** The route's path, named in the late-change problem. */
  instance: string;
  /** Recorded as the delivery's reason (the Desk's words when absent). */
  reason?: string;
}

/**
 * Starts delivery of the current request-owned approval through the signed gateway (ADR-043): words
 * the requester sent after the design reached the office hold it until an office member has read
 * them (finding 13), and a replay of a recorded action is answered from its receipt.
 */
export async function startRequestOwnedDelivery(deps: { db: Kysely<Database> }, input: OwnedDeliveryInput): Promise<OfficeActionAnswer> {
  const { db } = deps;
  const { tenantId, taskId, requestId, actionId, auth, officeRole, body } = input;
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
    return fail(409, 'Lifecycle Owner Mismatch', 'This task has no current request-owned approval');
  }
  const approvalId = String(body.approvalId || current.approval.id);
  if (approvalId !== current.approval.id) return fail(409, 'Approval Changed', 'The requested approval is not current');
  const expectedRev = current.receipts ? Number(current.receipts.rev) - 1 : Number(current.request.rev);
  const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  const secret = workerSigningSecretOf() || '';
  if (!ingress || !secret) return fail(503, 'Lifecycle Delivery Unavailable',
    'The signed delivery gateway is not configured; retry this action later');
  // Words the requester sent after the design reached the office hold a new delivery until an
  // office member has read them (finding 13). A replay of an action already recorded is not new.
  if (!current.receipts) {
    const acknowledged = (body.acknowledgeLateChanges as string[] | undefined) ?? [];
    const system = { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
    const late = await withRlsContext(db, system, async (trx) => ({
      pending: await pendingLateChanges(trx, tenantId, requestId),
      done: await acknowledgedLateChanges(trx, tenantId, requestId),
    }));
    const unknown = acknowledged.filter((id) => !late.pending.some((change) => change.updateId === id) &&
      !late.done.includes(id));
    if (unknown.length) return fail(422, 'Unknown Requester Change',
      'An acknowledged change does not belong to this request; refresh the task');
    const unread = late.pending.filter((change) => !acknowledged.includes(change.updateId));
    if (unread.length) {
      return json({ type: 'https://hawa.design/errors/409', title: 'Requester Change Received', status: 409,
        detail: 'The requester sent words after this design reached the office. Read them and acknowledge them before delivering.',
        instance: input.instance, code: 'LATE_REQUESTER_CHANGE', lateChanges: unread }, 409);
    }
    const reading = late.pending.filter((change) => acknowledged.includes(change.updateId));
    if (reading.length) {
      await withRlsContext(db, system, async (trx) => {
        for (const change of reading) {
          await acknowledgeLateChange(trx, tenantId, { requestId, updateId: change.updateId,
            actorUserId: auth.userId, actorRole: officeRole, actionId });
        }
      });
    }
  }
  const event = { v: 1 as const, kind: 'deliver' as const, eventId: `desk:${actionId}`,
    requestId, taskId, revisionId: current.approval.design_revision_id, approvalId, actionId,
    expectedRev, actor: { userId: auth.userId, role: officeRole }, reason: input.reason || 'Deliver approved files' };
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
      return json({ taskId, requestId, deliveryId: result.deliveryId, workflowId: result.deliveryId,
        executor: 'restate', status,
        requestRev: result.rev, acceptedAt: new Date().toISOString() }, result.stage === 'delivering' ? 202 : 200);
    }
    if (response.ok && result?.accepted === false) return fail(409, 'Stale Lifecycle Delivery',
      'The request is no longer approved for this delivery; refresh the task');
    if (response.status === 400 || response.status === 409) return fail(409, 'Lifecycle Action Conflict',
      'This action key, approval or request revision no longer matches; refresh the task');
    log.warn(`[core:publish] Lifecycle gateway HTTP ${response.status} for request ${requestId}`);
  } catch (error) {
    log.warn(`[core:publish] Lifecycle gateway did not answer for request ${requestId}:`, error);
  }
  return fail(503, 'Lifecycle Delivery Uncertain',
    'Delivery may have started. Retry with the same action key; no second workflow will be created');
}
