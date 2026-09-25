import { createHash } from 'node:crypto';
import { TaskRepository, PublicationRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { LifecycleProjectionConflict } from './lifecycle-projection.js';
import { assertStoredDeliveryReceipts } from './lifecycle-delivery-projection.js';
import { readRequesterSendEvidenceInTransaction, type RecordedSendStep } from './requester-send-evidence.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validMessageId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

export interface RequesterSendConfirmation {
  tenantId: string;
  taskId: string;
  actor: { userId: string; role: string };
  actionId: string;
  expectedRev: number;
  publicationId: string;
  approvalId: string;
  requesterChatId: string;
  observed: Array<{ sendKey: string; messageId: string }>;
  attested: true;
}

export interface RequesterSendConfirmationResult {
  requestId: string;
  taskId: string;
  publicationId: string;
  stage: 'delivered';
  requestRev: number;
  confirmationSource: 'staff_visible';
  actionId: string;
}

function conflict(code: ConstructorParameters<typeof LifecycleProjectionConflict>[0], message: string): never {
  throw new LifecycleProjectionConflict(code, message);
}

/** An audited human observation; no send is attempted and no sender mark is released. */
export async function confirmRequesterSendVisible(
  db: Kysely<Database>, input: RequesterSendConfirmation,
): Promise<RequesterSendConfirmationResult> {
  if (!['office_admin', 'administrator'].includes(input.actor.role) || !UUID.test(input.actor.userId)) {
    conflict('UNAUTHORIZED_ACTOR', 'An office administrator must confirm the requester chat');
  }
  if (![input.tenantId, input.taskId, input.actionId, input.publicationId, input.approvalId].every((v) => UUID.test(v)) ||
      !Number.isSafeInteger(input.expectedRev) || input.expectedRev < 5 || input.attested !== true ||
      typeof input.requesterChatId !== 'string' || !input.requesterChatId.trim() ||
      !Array.isArray(input.observed) || input.observed.length < 2 || input.observed.length > 100 ||
      input.observed.some((item) => !item || typeof item.sendKey !== 'string' ||
        item.sendKey.length > 200 || !validMessageId(item.messageId))) {
    conflict('INVALID_CONFIRMATION', 'The current publication, chat, revision and observed message IDs are required');
  }
  const observed = [...input.observed].sort((a, b) => a.sendKey.localeCompare(b.sendKey));
  if (new Set(observed.map((item) => item.sendKey)).size !== observed.length ||
      new Set(observed.map((item) => item.messageId)).size !== observed.length) {
    conflict('INVALID_CONFIRMATION', 'Every file and notice must have a distinct send key and message ID');
  }
  const hash = createHash('sha256').update(JSON.stringify({ ...input, observed })).digest('hex');
  return withRlsContext(db, { tenantId: input.tenantId, userId: input.actor.userId,
    role: input.actor.role }, async (trx) => {
    const namedTask = await trx.selectFrom('tasks').select('request_id')
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.taskId).executeTakeFirst();
    if (!namedTask?.request_id) conflict('WRONG_STAGE', 'The named task is not owned by a request');
    const requestId = namedTask.request_id;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${requestId}`}, 0))`.execute(trx);
    const rev = input.expectedRev + 1;
    const key = `${requestId}:${rev}:requesterSendConfirmed:desk:${input.actionId}`;
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', requestId)
      .where('rev', '=', rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== key || receipt.payload_sha256 !== hash) {
        conflict('IDEMPOTENCY_CONFLICT', 'This request revision already records a different action');
      }
      return receipt.result as unknown as RequesterSendConfirmationResult;
    }
    const pub = await trx.selectFrom('publications').selectAll()
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.publicationId)
      .where('task_id', '=', input.taskId).forUpdate().executeTakeFirst();
    const task = await trx.selectFrom('tasks').select(['request_id', 'state', 'version', 'current_design_revision_id'])
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.taskId).forUpdate().executeTakeFirst();
    const request = await trx.selectFrom('requests').select(['rev', 'owner', 'stage', 'current_task_id', 'chat_id'])
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', requestId).executeTakeFirst();
    if (!pub || pub.executor !== 'restate' || pub.error_class !== 'REQUESTER_SEND_UNCONFIRMED' ||
        !['pending', 'drive_complete', 'sheet_pending'].includes(pub.state) ||
        pub.approval_id !== input.approvalId || Number(pub.executor_finished_run) < 1 ||
        Number(pub.executor_run) !== Number(pub.executor_finished_run) ||
        !task || task.request_id !== requestId || task.state !== 'publishing' ||
        task.current_design_revision_id !== pub.design_revision_id ||
        !request || request.owner !== 'restate' || request.stage !== 'delivering' ||
        request.current_task_id !== input.taskId || Number(request.rev) !== input.expectedRev) {
      conflict('WRONG_STAGE', 'The current request, approval or publication no longer needs send reconciliation');
    }
    if (request.chat_id !== input.requesterChatId) {
      conflict('WRONG_CHAT', 'The observed messages must be in the immutable requester chat');
    }
    const latestApproval = await trx.selectFrom('approvals').select(['id', 'decision_payload'])
      .where('tenant_id', '=', input.tenantId).where('task_id', '=', input.taskId)
      .where('decision', '=', 'approved').orderBy('created_at', 'desc').executeTakeFirst();
    if (latestApproval?.id !== input.approvalId || latestApproval.decision_payload?.invalidated === true) {
      conflict('APPROVAL_CHANGED', 'The approved package changed after this delivery attempt');
    }
    const evidenceRead = await readRequesterSendEvidenceInTransaction(trx, { tenantId: input.tenantId,
      userId: input.actor.userId, role: input.actor.role, taskId: input.taskId });
    if (evidenceRead.kind !== 'found' || evidenceRead.evidence.publicationId !== pub.id ||
        evidenceRead.evidence.approvalId !== input.approvalId ||
        evidenceRead.evidence.requesterChatId !== input.requesterChatId) {
      conflict('EVIDENCE_CHANGED', 'The recorded send evidence changed before confirmation');
    }
    const steps: RecordedSendStep[] = [...evidenceRead.evidence.files, evidenceRead.evidence.notice];
    const byKey = new Map(observed.map((item) => [item.sendKey, item.messageId]));
    if (steps.length !== observed.length || steps.some((step) => !byKey.has(step.sendKey))) {
      conflict('INCOMPLETE_OBSERVATION', 'Every approved file and the notice must be observed');
    }
    for (const step of steps) {
      const messageId = byKey.get(step.sendKey);
      if (!messageId || !['sent', 'attempted', 'uncertain'].includes(step.outcome) ||
          (step.outcome === 'sent' && step.messageId && step.messageId !== messageId)) {
        conflict('EVIDENCE_MISMATCH', 'A message is missing, failed, or differs from the Bot API send mark');
      }
    }
    try {
      await assertStoredDeliveryReceipts(trx, input.tenantId, input.taskId, pub, {
        outcome: 'delivered', uncertain: [], archived: true, sheetsConfirmed: true,
        filesSent: evidenceRead.evidence.files.length,
      });
    } catch (error) {
      if (error instanceof Error && /Delivery receipts are unavailable|Verified Drive receipts|A matching confirmed Sheet receipt/.test(error.message)) {
        conflict('EVIDENCE_CHANGED', 'Verified Drive and Sheet receipts no longer match the approved package');
      }
      throw error;
    }
    const observedMessageIds = observed.map((item) => ({ sendKey: item.sendKey, messageId: item.messageId }));
    await new TaskRepository(trx).transitionState({ taskId: input.taskId, tenantId: input.tenantId,
      fromState: 'publishing', toState: 'complete', expectedVersion: Number(task.version),
      actorType: 'user', actorId: input.actor.userId, reason: 'Staff confirmed every approved send visible in requester chat',
      correlationId: input.actionId, data: { confirmationSource: 'staff_visible', requestId,
        publicationId: pub.id, approvalId: input.approvalId, packageSha256: pub.package_sha256,
        requesterChatId: input.requesterChatId, observedMessageIds, expectedRev: input.expectedRev } }, trx);
    await new PublicationRepository(trx).markComplete({ tenantId: input.tenantId,
      publicationId: pub.id, taskId: input.taskId }, trx);
    const advanced = await trx.updateTable('requests').set({ stage: 'delivered', rev, updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', requestId)
      .where('rev', '=', input.expectedRev).returning('request_id').executeTakeFirst();
    if (!advanced) conflict('STALE_REVISION', 'The request changed before staff confirmation committed');
    const result: RequesterSendConfirmationResult = { requestId, taskId: input.taskId,
      publicationId: pub.id, stage: 'delivered', requestRev: rev,
      confirmationSource: 'staff_visible', actionId: input.actionId };
    await trx.insertInto('lifecycle_projections').values({ tenant_id: input.tenantId,
      request_id: requestId, rev, idempotency_key: key, payload_sha256: hash,
      result: result as unknown as Record<string, unknown> }).execute();
    return result;
  });
}
