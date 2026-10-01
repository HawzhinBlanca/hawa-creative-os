import { createHash } from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID, deliveryWorkflowId, type DeliveryInput, type DeliveryOutcome } from '@hawa/contracts';
import { parseOfficeApprovalProof } from '@hawa/domain';
import { signLifecycleDeliveryClaim } from '@hawa/integrations';
import { PublicationRepository, TaskRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { LifecycleProjectionConflict } from './lifecycle-projection.js';
import { loadPinnedDeliverables, type DeliverableStore } from './pinned-deliverables.js';
import { workerSigningSecretOf } from './worker-credential.js';
import { requesterSendsConfirmed } from './requester-send-evidence.js';

const OFFICE_DELIVERY_ROLES = new Set(['art_director', 'creative_director', 'office_admin', 'administrator']);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export interface LifecycleDeliveryStart {
  requestId: string; tenantId: string; taskId: string; revisionId: string; approvalId: string;
  actionId: string; actor: { userId: string; role: string }; reason: string;
  expectedRev: number; rev: number; key: string;
}

export interface LifecycleDeliveryStartResult {
  requestId: string; taskId: string; approvalId: string; actionId: string;
  stage: 'delivering'; rev: number; delivery: DeliveryInput;
}

/** One claim owns the request revision, publication, task transition and workflow input. */
export async function projectLifecycleDeliveryStart(
  db: Kysely<Database>, store: DeliverableStore, input: LifecycleDeliveryStart,
): Promise<LifecycleDeliveryStartResult> {
  if (!OFFICE_DELIVERY_ROLES.has(input.actor.role) || input.rev !== input.expectedRev + 1 ||
      input.expectedRev < 3 || !input.reason.trim() || input.reason.length > 2000) {
    throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR', 'An authorized reviewer and one expected request revision are required');
  }
  const hash = fingerprint(input);
  return withRlsContext(db, { tenantId: input.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${input.requestId}`}, 0))`.execute(trx);
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).where('rev', '=', input.rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== input.key || receipt.payload_sha256 !== hash) {
        throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT', 'This delivery revision has different content or action identity');
      }
      return receipt.result as unknown as LifecycleDeliveryStartResult;
    }
    const request = await trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).executeTakeFirst();
    if (!request || Number(request.rev) !== input.expectedRev) {
      throw new LifecycleProjectionConflict('STALE_REVISION', 'The request is not at the expected delivery revision');
    }
    if (request.owner !== 'restate' || !['approved', 'delivering'].includes(request.stage) ||
        request.current_task_id !== input.taskId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'Only the current approved request may start delivery');
    }
    await sql`SELECT id FROM hawa.tasks WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.taskId}::uuid FOR UPDATE`.execute(trx);
    const task = await new TaskRepository(trx).findById(input.taskId, input.tenantId, trx);
    const expectedState = request.stage === 'approved' ? 'approved' : 'publishing';
    if (task?.request_id !== input.requestId || task.current_design_revision_id !== input.revisionId ||
        task.state !== expectedState) {
      throw new LifecycleProjectionConflict('NOT_CURRENT_DRAFT', 'The task or revision no longer matches this delivery');
    }
    const approval = await trx.selectFrom('approvals').selectAll()
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.approvalId).executeTakeFirst();
    if (!approval || approval.task_id !== input.taskId || approval.design_revision_id !== input.revisionId ||
        approval.decision !== 'approved' || approval.decision_payload?.invalidated === true ||
        approval.decision_payload?.lifecycleRequestId !== input.requestId) {
      throw new LifecycleProjectionConflict('NOT_CURRENT_DRAFT', 'The approval is missing, invalidated or belongs to another draft');
    }
    const latestApproval = await trx.selectFrom('approvals').select('id')
      .where('tenant_id', '=', input.tenantId).where('task_id', '=', input.taskId)
      .where('decision', '=', 'approved').orderBy('created_at', 'desc').executeTakeFirst();
    if (latestApproval?.id !== input.approvalId) {
      throw new LifecycleProjectionConflict('NOT_CURRENT_DRAFT', 'A newer approval superseded this delivery');
    }
    const proof = parseOfficeApprovalProof(approval.decision_payload?.officeApprovalProof);
    if (!proof || !store.captureEvidenceRequired) {
      throw new LifecycleProjectionConflict('APPROVAL_EVIDENCE_CHANGED', 'A request-owned delivery requires the recorded checked-export proof');
    }
    const newer = (await sql<{ present: number }>`SELECT 1 AS present FROM hawa.canva_export_bytes
      WHERE tenant_id = ${input.tenantId}::uuid AND task_id = ${input.taskId}::uuid
        AND created_at > ${approval.created_at}::timestamptz LIMIT 1`.execute(trx)).rows[0];
    if (newer) throw new LifecycleProjectionConflict('APPROVAL_EVIDENCE_CHANGED', 'A later Canva export requires a new approval');
    const pending = (await sql<{ id: string }>`SELECT t.id FROM hawa.tasks t
      JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
      WHERE t.tenant_id = ${input.tenantId}::uuid
        AND o.payload->'studioOptions'->>'parentTaskId' = ${input.taskId}
        AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''
        AND t.state NOT IN ('cancelled', 'rejected', 'failed_operator') LIMIT 1`.execute(trx)).rows[0];
    if (pending) throw new LifecycleProjectionConflict('WRONG_STAGE', 'A client-requested change blocks delivery of this draft');
    const packageFiles = await loadPinnedDeliverables(store, {
      tenantId: input.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, taskId: input.taskId,
      filePrefix: `client-${String(task.client_id).slice(0, 8)}`,
    }, proof.pinnedExports);
    if (!packageFiles.ok) {
      throw new LifecycleProjectionConflict('APPROVAL_EVIDENCE_CHANGED', packageFiles.message);
    }
    const publicationKey = `pub_key_${input.taskId}_${input.approvalId}`;
    const publications = new PublicationRepository(trx);
    let publication = await publications.findByKey(publicationKey, input.tenantId, trx);
    if (!publication) {
      publication = await publications.createPublication({ tenantId: input.tenantId, taskId: input.taskId,
        designRevisionId: input.revisionId, approvalId: input.approvalId, publicationKey,
        packageManifest: { files: packageFiles.files.map((file) => ({ name: file.filename,
          artifactId: file.artifactId, sha256: file.sha256, size: file.byteSize })) },
        packageSha256: packageFiles.packageHash, initialState: 'pending' }, trx);
    } else if (publication.state === 'complete' || publication.executor !== 'restate' || publication.task_id !== input.taskId ||
        publication.approval_id !== input.approvalId || publication.package_sha256 !== packageFiles.packageHash ||
        Number(publication.executor_run) !== Number(publication.executor_finished_run) ||
        publication.error_class === 'REQUESTER_SEND_UNCONFIRMED') {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The existing publication needs reconciliation before another delivery');
    }
    if (task.state === 'approved') {
      await new TaskRepository(trx).transitionState({ taskId: input.taskId, tenantId: input.tenantId,
        fromState: 'approved', toState: 'publishing', actorType: 'user', actorId: input.actor.userId,
        reason: input.reason, data: { requestId: input.requestId, approvalId: input.approvalId } }, trx);
    }
    const run = Number(publication.executor_run) + 1;
    await sql`UPDATE hawa.publications SET executor = 'restate', executor_run = ${run},
      error_class = CASE WHEN error_class = 'ARCHIVE_UNCONFIRMED' THEN error_class ELSE NULL END,
      error_detail = CASE WHEN error_class = 'ARCHIVE_UNCONFIRMED' THEN error_detail ELSE NULL END,
      updated_at = now()
      WHERE tenant_id = ${input.tenantId}::uuid AND id = ${publication.id}::uuid`.execute(trx);
    const advanced = await trx.updateTable('requests').set({ stage: 'delivering', rev: input.rev, updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId)
      .where('rev', '=', input.expectedRev).returning('request_id').executeTakeFirst();
    if (!advanced) throw new LifecycleProjectionConflict('STALE_REVISION', 'The request changed while delivery started');
    const unsignedDelivery: DeliveryInput = { v: 1, requestId: input.requestId, tenantId: input.tenantId,
      taskId: input.taskId, approvalId: input.approvalId, revisionId: input.revisionId,
      deliveryId: deliveryWorkflowId(input.taskId, input.approvalId, run),
      chatId: request.chat_id, officeChatId: (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((c) => c.trim()).find(Boolean) || null,
      reportTo: 'lifecycle', requestRev: input.rev, run };
    const delivery: DeliveryInput = { ...unsignedDelivery,
      claimSignature: signLifecycleDeliveryClaim(workerSigningSecretOf() || '', unsignedDelivery) };
    const result: LifecycleDeliveryStartResult = { requestId: input.requestId, taskId: input.taskId,
      approvalId: input.approvalId, actionId: input.actionId, stage: 'delivering', rev: input.rev, delivery };
    await trx.insertInto('lifecycle_projections').values({ tenant_id: input.tenantId,
      request_id: input.requestId, rev: input.rev, idempotency_key: input.key, payload_sha256: hash,
      result: result as unknown as Record<string, unknown> }).execute();
    return result;
  });
}

export interface LifecycleDeliveryFinish {
  requestId: string; tenantId: string; taskId: string; approvalId: string; deliveryId: string;
  run: number; outcome: DeliveryOutcome; expectedRev: number; rev: number; key: string;
}

export interface LifecycleDeliveryFinishResult {
  requestId: string; taskId: string; approvalId: string; deliveryId: string;
  stage: 'approved' | 'delivering' | 'delivered'; taskState: 'approved' | 'publishing' | 'complete'; rev: number;
}

/** The worker's booleans are a report, not the evidence that may close the request. */
export async function assertStoredDeliveryReceipts(
  trx: Kysely<Database>, tenantId: string, taskId: string,
  publication: { id: string; package_manifest: Record<string, unknown>; package_sha256: string },
  outcome: DeliveryOutcome,
): Promise<void> {
  if (!outcome.archived && !outcome.sheetsConfirmed) return;
  const recorded = await new PublicationRepository(trx).getPublicationWithRefs(publication.id, tenantId, trx);
  if (!recorded) throw new Error('Delivery receipts are unavailable; retry the same report');
  if (outcome.archived) {
    const files = publication.package_manifest?.files;
    const expected = Array.isArray(files) ? files : [];
    const verified = recorded.driveRefs.filter((ref) => ref.status === 'verified');
    const expectedKeys = expected.map((file: unknown) => {
      if (!file || typeof file !== 'object') return null;
      const item = file as Record<string, unknown>;
      return typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256) &&
        Number.isInteger(item.size) && Number(item.size) > 0
        ? `${item.sha256}:${item.size}` : null;
    }).sort();
    const verifiedKeys = verified.map((ref) => ref.expected_sha256 && ref.verified_at &&
      ref.file_id && ref.folder_id && Number(ref.observed_size) > 0
      ? `${ref.expected_sha256}:${ref.observed_size}` : null).sort();
    if (expected.length === 0 || expectedKeys.length !== verifiedKeys.length ||
        expectedKeys.some((key, index) => key === null || key !== verifiedKeys[index])) {
      throw new Error('Verified Drive receipts do not match the approved delivery package; retry the same report');
    }
  }
  if (outcome.sheetsConfirmed && !recorded.sheetSyncs.some((row) =>
    row.status === 'synced' && row.task_id === taskId && row.row_key === taskId &&
    row.expected_hash === publication.package_sha256 && row.observed_hash === publication.package_sha256 &&
    Number(row.row_number) > 0 && row.synced_at !== null)) {
    throw new Error('A matching confirmed Sheet receipt is unavailable; retry the same report');
  }
}

/** Apply the single Delivery outcome without letting the legacy finished route move an owned task. */
export async function projectLifecycleDeliveryFinish(db: Kysely<Database>, input: LifecycleDeliveryFinish): Promise<LifecycleDeliveryFinishResult> {
  if (input.rev !== input.expectedRev + 1 || input.expectedRev < 4 || !Number.isInteger(input.run) || input.run < 1) {
    throw new LifecycleProjectionConflict('WRONG_STAGE', 'A versioned delivery outcome is required');
  }
  const hash = fingerprint(input);
  return withRlsContext(db, { tenantId: input.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${input.requestId}`}, 0))`.execute(trx);
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).where('rev', '=', input.rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== input.key || receipt.payload_sha256 !== hash) {
        throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT', 'This delivery result differs from the recorded outcome');
      }
      return receipt.result as unknown as LifecycleDeliveryFinishResult;
    }
    const request = await trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).executeTakeFirst();
    if (!request || Number(request.rev) !== input.expectedRev || request.owner !== 'restate' ||
        request.stage !== 'delivering' || request.current_task_id !== input.taskId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'This request is not delivering the named task and revision');
    }
    const publicationKey = `pub_key_${input.taskId}_${input.approvalId}`;
    const pub = (await sql<{ id: string; executor: string; executor_run: number; executor_finished_run: number;
      package_manifest: Record<string, unknown>; package_sha256: string; error_class: string | null }>`SELECT id, executor, executor_run, executor_finished_run, package_manifest, package_sha256, error_class
      FROM hawa.publications WHERE tenant_id = ${input.tenantId}::uuid AND publication_key = ${publicationKey} FOR UPDATE`.execute(trx)).rows[0];
    if (!pub || pub.executor !== 'restate' || Number(pub.executor_run) !== input.run ||
        Number(pub.executor_finished_run) >= input.run ||
        deliveryWorkflowId(input.taskId, input.approvalId, input.run) !== input.deliveryId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The report is not for the current delivery run');
    }
    const taskRepo = new TaskRepository(trx);
    const task = await taskRepo.findById(input.taskId, input.tenantId, trx);
    if (task?.request_id !== input.requestId || task.state !== 'publishing') {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The owned task is no longer publishing');
    }
    await assertStoredDeliveryReceipts(trx, input.tenantId, input.taskId, pub, input.outcome);
    const expectedFiles = Array.isArray(pub.package_manifest?.files) ? pub.package_manifest.files.length : 0;
    const requesterConfirmed = input.outcome.outcome === 'delivered' && input.outcome.uncertain.length === 0 &&
      expectedFiles > 0 && input.outcome.filesSent === expectedFiles;
    let stage: LifecycleDeliveryFinishResult['stage'] = 'delivering';
    let taskState: LifecycleDeliveryFinishResult['taskState'] = 'publishing';
    let errorClass: string | null = null;
    if (input.outcome.archived && input.outcome.sheetsConfirmed && requesterConfirmed) {
      await taskRepo.transitionState({ taskId: input.taskId, tenantId: input.tenantId,
        fromState: 'publishing', toState: 'complete', actorType: 'workflow', actorId: 'delivery-workflow',
        reason: 'Request-owned delivery confirmed', data: { requestId: input.requestId, deliveryId: input.deliveryId } }, trx);
      await new PublicationRepository(trx).markComplete({ tenantId: input.tenantId,
        publicationId: pub.id, taskId: input.taskId }, trx);
      stage = 'delivered'; taskState = 'complete';
    } else if (await chatOnlyDelivered(trx, input, pub, expectedFiles)) {
      // ADR-230: the requester has every file and the notice (Telegram's send marks say so), and only the
      // Drive archive is missing (the office Google account was not connected). The request is delivered;
      // the archive is recorded as pending, not as an unconfirmed send, and the publication stays open
      // for an archive later.
      await closeChatOnlyDelivery(trx, input.tenantId, input.taskId, pub.id, { requestId: input.requestId,
        deliveryId: input.deliveryId, reason: input.outcome.reason ?? null });
      stage = 'delivered'; taskState = 'complete'; errorClass = ARCHIVE_PENDING;
    } else if (pub.error_class === 'ARCHIVE_UNCONFIRMED' && !input.outcome.archived) {
      errorClass = 'ARCHIVE_UNCONFIRMED';
    } else if ((input.outcome.filesSent > 0 && (!input.outcome.archived || !requesterConfirmed)) ||
        input.outcome.uncertain.length > 0 ||
        input.outcome.outcome === 'uncertain' ||
        (input.outcome.outcome === 'failed' && /TELEGRAM|REQUESTER_CHAT|DELIVERABLE_FILES/.test(input.outcome.reason || ''))) {
      errorClass = 'REQUESTER_SEND_UNCONFIRMED';
    } else if (!input.outcome.archived) {
      await taskRepo.transitionState({ taskId: input.taskId, tenantId: input.tenantId,
        fromState: 'publishing', toState: 'approved', actorType: 'workflow', actorId: 'delivery-workflow',
        reason: 'Archive not confirmed; delivery needs another explicit office action',
        data: { requestId: input.requestId, deliveryId: input.deliveryId, outcome: input.outcome.outcome } }, trx);
      stage = 'approved'; taskState = 'approved';
    } else if (!input.outcome.sheetsConfirmed) {
      errorClass = 'SHEET_UNCONFIRMED';
    } else {
      errorClass = 'REQUESTER_SEND_UNCONFIRMED';
    }
    await sql`UPDATE hawa.publications SET executor_finished_run = ${input.run},
      error_class = ${errorClass}, error_detail = ${errorClass ? JSON.stringify(input.outcome).slice(0, 1000) : null},
      updated_at = now() WHERE tenant_id = ${input.tenantId}::uuid AND id = ${pub.id}::uuid`.execute(trx);
    const advanced = await trx.updateTable('requests').set({ stage, rev: input.rev, updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId)
      .where('rev', '=', input.expectedRev).returning('request_id').executeTakeFirst();
    if (!advanced) throw new LifecycleProjectionConflict('STALE_REVISION', 'The request changed during delivery completion');
    const result: LifecycleDeliveryFinishResult = { requestId: input.requestId, taskId: input.taskId,
      approvalId: input.approvalId, deliveryId: input.deliveryId, stage, taskState, rev: input.rev };
    await trx.insertInto('lifecycle_projections').values({ tenant_id: input.tenantId,
      request_id: input.requestId, rev: input.rev, idempotency_key: input.key, payload_sha256: hash,
      result: result as unknown as Record<string, unknown> }).execute();
    return result;
  });
}

/**
 * ADR-230: a delivery that reached the requester in the chat but was not archived (outcome `chat_only`:
 * Delivery prepared it without Drive, because nothing could be uploaded). Core reads the publication's
 * error class as the archive's state from here: ARCHIVE_PENDING until an archive is written.
 */
export const ARCHIVE_PENDING = 'ARCHIVE_PENDING';

/**
 * Whether a `chat_only` report may close the request: the report says every approved file and the notice
 * were sent and nothing is uncertain, and Core's own stored Telegram send marks agree, file by file. The
 * worker's numbers alone never close it.
 */
async function chatOnlyDelivered(trx: Kysely<Database>, input: Pick<LifecycleDeliveryFinish, 'tenantId' | 'taskId' | 'approvalId' | 'outcome'>,
  pub: { package_manifest: Record<string, unknown> }, expectedFiles: number): Promise<boolean> {
  const outcome = input.outcome;
  if (outcome.outcome !== 'chat_only' || outcome.archived || outcome.uncertain.length > 0 ||
      expectedFiles === 0 || outcome.filesSent !== expectedFiles) return false;
  return requesterSendsConfirmed(trx, input.tenantId, input.taskId, input.approvalId, pub.package_manifest);
}

async function closeChatOnlyDelivery(trx: Kysely<Database>, tenantId: string, taskId: string, publicationId: string,
  data: { requestId: string; deliveryId: string; reason: string | null; repaired?: true }): Promise<void> {
  await new TaskRepository(trx).transitionState({ taskId, tenantId,
    fromState: 'publishing', toState: 'complete', actorType: 'workflow', actorId: 'delivery-workflow',
    reason: 'Delivered to the requester in the chat; the Drive archive is pending',
    data: { ...data, archive: 'pending' } }, trx);
  // The publication is not marked complete: its archive is still to be written. Its error_detail keeps
  // the delivery's report as Core stored it.
  await sql`UPDATE hawa.publications SET error_class = ${ARCHIVE_PENDING}, updated_at = now()
    WHERE tenant_id = ${tenantId}::uuid AND id = ${publicationId}::uuid`.execute(trx);
}

export interface LifecycleDeliveryReconcile {
  requestId: string; tenantId: string; taskId: string; approvalId: string; deliveryId: string; run: number;
  expectedRev: number; rev: number; key: string;
}

export type LifecycleDeliveryReconcileResult = LifecycleDeliveryFinishResult & { reconciled: true };

/**
 * ADR-230 repair: a request whose delivery finished `chat_only` before this change sits in `delivering`
 * (task publishing, error REQUESTER_SEND_UNCONFIRMED). Core reads the report it stored on the
 * publication and its own send marks again; when both say the requester has everything and only the
 * archive is missing, the request is delivered exactly as a new chat-only delivery is. Anything else is
 * refused (NOT_CHAT_ONLY, SENDS_UNCONFIRMED) and left for a person. One revision, one receipt: a second
 * call answers with the first.
 */
export async function reconcileLifecycleChatOnlyDelivery(db: Kysely<Database>,
  input: LifecycleDeliveryReconcile): Promise<LifecycleDeliveryReconcileResult> {
  if (input.rev !== input.expectedRev + 1 || input.expectedRev < 5 || !Number.isInteger(input.run) || input.run < 1 ||
      input.key !== `${input.requestId}:${input.rev}:deliveryReconciled:${input.deliveryId}`) {
    throw new LifecycleProjectionConflict('WRONG_STAGE', 'A versioned delivery repair is required');
  }
  const hash = fingerprint(input);
  return withRlsContext(db, { tenantId: input.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${input.requestId}`}, 0))`.execute(trx);
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).where('rev', '=', input.rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== input.key || receipt.payload_sha256 !== hash) {
        throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT', 'This request revision already records a different action');
      }
      return receipt.result as unknown as LifecycleDeliveryReconcileResult;
    }
    const request = await trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).executeTakeFirst();
    if (!request || Number(request.rev) !== input.expectedRev) {
      throw new LifecycleProjectionConflict('STALE_REVISION', 'The request is not at the expected revision');
    }
    if (request.owner !== 'restate' || request.stage !== 'delivering' || request.current_task_id !== input.taskId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'This request is not delivering the named task');
    }
    const publicationKey = `pub_key_${input.taskId}_${input.approvalId}`;
    const pub = (await sql<{ id: string; executor: string; executor_run: number; executor_finished_run: number;
      package_manifest: Record<string, unknown>; error_class: string | null; error_detail: string | null; state: string }>`
      SELECT id, executor, executor_run, executor_finished_run, package_manifest, error_class, error_detail, state
      FROM hawa.publications WHERE tenant_id = ${input.tenantId}::uuid AND publication_key = ${publicationKey} FOR UPDATE`.execute(trx)).rows[0];
    if (!pub || pub.executor !== 'restate' || Number(pub.executor_run) !== input.run ||
        Number(pub.executor_finished_run) !== input.run || pub.state === 'complete' ||
        deliveryWorkflowId(input.taskId, input.approvalId, input.run) !== input.deliveryId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The delivery run has not finished, or is not this one');
    }
    // The report as Core stored it when the delivery finished (error_detail holds the outcome's JSON).
    let reported: DeliveryOutcome | null = null;
    try { reported = JSON.parse(String(pub.error_detail || 'null')) as DeliveryOutcome; } catch { reported = null; }
    if (pub.error_class !== 'REQUESTER_SEND_UNCONFIRMED' || reported?.outcome !== 'chat_only' || !Array.isArray(reported.uncertain)) {
      throw new LifecycleProjectionConflict('NOT_CHAT_ONLY', 'The recorded delivery did not end chat-only; a person must reconcile it');
    }
    const task = await new TaskRepository(trx).findById(input.taskId, input.tenantId, trx);
    if (task?.request_id !== input.requestId || task.state !== 'publishing') {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The owned task is no longer publishing');
    }
    const expectedFiles = Array.isArray(pub.package_manifest?.files) ? pub.package_manifest.files.length : 0;
    if (!(await chatOnlyDelivered(trx, { tenantId: input.tenantId, taskId: input.taskId, approvalId: input.approvalId,
      outcome: reported }, pub, expectedFiles))) {
      throw new LifecycleProjectionConflict('SENDS_UNCONFIRMED', 'Telegram\'s send marks do not show every file and the notice sent');
    }
    await closeChatOnlyDelivery(trx, input.tenantId, input.taskId, pub.id, { requestId: input.requestId,
      deliveryId: input.deliveryId, reason: reported.reason ?? null, repaired: true });
    const advanced = await trx.updateTable('requests').set({ stage: 'delivered', rev: input.rev, updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId)
      .where('rev', '=', input.expectedRev).returning('request_id').executeTakeFirst();
    if (!advanced) throw new LifecycleProjectionConflict('STALE_REVISION', 'The request changed during the repair');
    const result: LifecycleDeliveryReconcileResult = { requestId: input.requestId, taskId: input.taskId,
      approvalId: input.approvalId, deliveryId: input.deliveryId, stage: 'delivered', taskState: 'complete',
      rev: input.rev, reconciled: true };
    await trx.insertInto('lifecycle_projections').values({ tenant_id: input.tenantId,
      request_id: input.requestId, rev: input.rev, idempotency_key: input.key, payload_sha256: hash,
      result: result as unknown as Record<string, unknown> }).execute();
    return result;
  });
}
