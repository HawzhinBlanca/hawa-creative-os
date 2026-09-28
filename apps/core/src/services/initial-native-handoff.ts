import { createHash } from 'node:crypto';
import { sql, TaskRepository, type Database, type Kysely } from '@hawa/db';
import { nativeRevisionIntent, validReviewedRevisionCopy } from '@hawa/domain';
import { isServiceUserId } from '@hawa/contracts';
import { CanvaFlowError } from './canva-flow-error.js';
import { savedDesignCopy } from './saved-design-copy.js';
import { initialManualOrigin, lockNativeRecovery, type NativeActorScope } from './lifecycle-native-scope.js';
import { confirmNativeRevisionCopy, latestRevisionCopy } from './native-revision-handoff.js';

/**
 * ADR-126: owner-controlled native journey for an initial manual RequestLifecycle request.
 * There is no parent design. The office links this request's own separate native design and
 * confirms its exact final text; the confirmation is human testimony, never approval.
 */
type Db = Kysely<Database>;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const instruction = 'Design this request in Canva, link that separate design to the task and confirm its exact final text before capture. The request owner submits the captured design for review.';

export interface InitialCopyConfirmation {
  schemaVersion: 1;
  requestKey: string;
  requestHash: string;
  basisSha256: string;
  copy: string[];
  requestId: string;
  bindingId: string;
  bindingVersion: number;
  designId: string;
  clientId: string;
  separateDesign: 'operator_reviewed';
}

export async function latestInitialCopy(db: Db, tenantId: string, taskId: string) {
  const row = (await sql<{ id: string; data: { initialNativeCopy: InitialCopyConfirmation }; actor_id: string | null }>`
    SELECT id,data,actor_id FROM hawa.task_events WHERE tenant_id=${tenantId}::uuid AND task_id=${taskId}::uuid
      AND actor_type='user' AND data->'initialNativeCopy'->>'schemaVersion'='1'
    ORDER BY aggregate_version DESC LIMIT 1`.execute(db)).rows[0];
  if (!row?.actor_id || isServiceUserId(row.actor_id)) return undefined;
  return { id: row.id, ...row.data.initialNativeCopy };
}

/**
 * The confirmation that governs capture for this task. The two kinds are exclusive by construction:
 * a revision confirmation needs a parent intent and an initial one needs its absence.
 */
export async function latestNativeCopy(db: Db, tenantId: string, taskId: string) {
  const revision = await latestRevisionCopy(db, tenantId, taskId);
  if (revision) return { kind: 'revision' as const, id: revision.id, copy: revision.copy, confirmation: revision };
  const initial = await latestInitialCopy(db, tenantId, taskId);
  return initial ? { kind: 'initial' as const, id: initial.id, copy: initial.copy, confirmation: initial } : undefined;
}

async function initialTask(db: Db, tenantId: string, taskId: string) {
  return (await sql<{ client_id: string | null; request_id: string | null; state: string; version: number; description: string; source: unknown }>`
    SELECT t.client_id,t.request_id,t.state,t.version,t.description,
      (SELECT e.data FROM hawa.task_events e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id
       AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
    FROM hawa.tasks t WHERE t.tenant_id=${tenantId}::uuid AND t.id=${taskId}::uuid`.execute(db)).rows[0];
}

/** Undefined unless the task is the root of a request opened for manual design without a run. */
export async function nativeInitialHandoff(db: Db, tenantId: string, taskId: string) {
  const task = await initialTask(db, tenantId, taskId);
  if (!task?.request_id || nativeRevisionIntent(task.source) || !await initialManualOrigin(db, tenantId, task.request_id, taskId)) return undefined;
  if (!task.client_id) return { required: true as const, available: false as const, kind: 'initial' as const, lifecycleOwned: true as const,
    message: 'This request has no client. A native design can be linked only within a client scope.' };
  const binding = (await sql<{ id: string; version: number; canva_design_id: string }>`SELECT id,version,canva_design_id
    FROM hawa.canva_bindings WHERE tenant_id=${tenantId}::uuid AND task_id=${taskId}::uuid
      AND client_id=${task.client_id}::uuid AND status='bound' AND direction_name='primary'`.execute(db)).rows[0];
  const basis = { taskId, clientId: task.client_id, requestId: task.request_id, bindingId: binding?.id ?? null,
    bindingVersion: binding?.version ?? null, designId: binding?.canva_design_id ?? null };
  const basisSha256 = digest(basis);
  const confirmed = await latestInitialCopy(db, tenantId, taskId);
  let copy: string[] = [];
  try { copy = savedDesignCopy(task.source, task.description).copy; } catch { /* The office must supply exact copy. */ }
  const request = await db.selectFrom('requests').select(['owner','stage','rev','current_task_id'])
    .where('tenant_id','=',tenantId).where('request_id','=',task.request_id).executeTakeFirst();
  const nativeRecovery = request?.owner === 'restate' && request.stage === 'manual' && request.current_task_id === taskId &&
    Number(request.rev) === 1 ? { requestId: task.request_id, rev: 1 } : undefined;
  return { required: true as const, available: true as const, kind: 'initial' as const, ...basis, basisSha256,
    taskVersion: Number(task.version), lifecycleOwned: true as const, nativeRecovery, parentEditUrl: null, directive: '',
    copy: confirmed?.copy ?? copy, confirmedEventId: confirmed?.basisSha256 === basisSha256 ? confirmed.id : null, message: instruction };
}

/** Caller owns an actor-scoped transaction. Confirmation never approves a design or advances the request. */
export async function confirmInitialNativeCopy(db: Db, s: NativeActorScope, taskId: string, key: string, input: {
  expectedTaskVersion: number; basisSha256: string; copy: unknown; reviewedCurrentDesign: unknown; separateRequestDesign: unknown;
}) {
  if (!['administrator', 'art_director', 'creative_director', 'operator', 'designer'].includes(s.role || '') || isServiceUserId(s.actorId))
    throw new CanvaFlowError(403, 'HUMAN_REVIEW_REQUIRED', 'An office operator or designer must confirm the final copy.');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['expectedTaskVersion','basisSha256','copy','reviewedCurrentDesign','separateRequestDesign'].includes(k)) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !Number.isSafeInteger(input.expectedTaskVersion) ||
      !/^[0-9a-f]{64}$/.test(input.basisSha256 || '') || !validReviewedRevisionCopy(input.copy) ||
      input.reviewedCurrentDesign !== true || input.separateRequestDesign !== true)
    throw new CanvaFlowError(422, 'INITIAL_COPY_REVIEW_REQUIRED', 'Review the linked design and its exact final copy, and confirm it is this request’s own separate design.');
  if (!s.nativeRecovery) throw new CanvaFlowError(409, 'LIFECYCLE_OWNED', 'Use the current manual request and an office human identity.');
  const owner = await lockNativeRecovery(db, s, taskId);
  if (owner.kind !== 'initial') throw new CanvaFlowError(409, 'NATIVE_RECOVERY_STALE', 'Reload the current manual request.');
  await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db);
  const requestHash = digest({ nativeRecovery: s.nativeRecovery, expectedTaskVersion: input.expectedTaskVersion,
    basisSha256: input.basisSha256, copy: input.copy, reviewedCurrentDesign: true, separateRequestDesign: true });
  const prior = (await sql<{ id: string; actor_id: string; data: { initialNativeCopy: InitialCopyConfirmation } }>`SELECT id,actor_id,data
    FROM hawa.task_events WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid
      AND data->'initialNativeCopy'->>'requestKey'=${key} ORDER BY aggregate_version DESC LIMIT 1`.execute(db)).rows[0];
  if (prior) {
    if (prior.actor_id !== s.actorId || prior.data.initialNativeCopy.requestHash !== requestHash)
      throw new CanvaFlowError(409, 'INITIAL_REVIEW_CONFLICT', 'This request key already identifies another copy review.');
    return { confirmationEventId: prior.id, replayed: true };
  }
  const task = await initialTask(db, s.tenantId, taskId);
  if (!task || !['received','failed_operator','human_review','revision_requested'].includes(task.state))
    throw new CanvaFlowError(409, 'INITIAL_HANDOFF_UNAVAILABLE', 'Use an open manual request task.');
  await sql`SELECT id FROM hawa.canva_bindings WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid FOR SHARE`.execute(db);
  const handoff = await nativeInitialHandoff(db, s.tenantId, taskId);
  if (!handoff?.available || !handoff.bindingId || !handoff.designId)
    throw new CanvaFlowError(409, 'NATIVE_DESIGN_REQUIRED', 'Link this request’s own separate Canva design before confirming.');
  if (Number(task.version) !== input.expectedTaskVersion || handoff.basisSha256 !== input.basisSha256)
    throw new CanvaFlowError(409, 'INITIAL_BASIS_CHANGED', 'The task or linked design changed. Reload and review the current design.');
  const confirmation: InitialCopyConfirmation = { schemaVersion: 1, requestKey: key, requestHash, basisSha256: handoff.basisSha256,
    copy: input.copy, requestId: handoff.requestId, bindingId: handoff.bindingId, bindingVersion: handoff.bindingVersion!,
    designId: handoff.designId, clientId: handoff.clientId, separateDesign: 'operator_reviewed' };
  await new TaskRepository(db).transitionState({ taskId, tenantId: s.tenantId, expectedVersion: Number(task.version),
    fromState: task.state as 'received', toState: 'failed_operator', actorType: 'user', actorId: s.actorId,
    reason: 'Exact final copy confirmed; capture the linked native design for review.', data: { initialNativeCopy: confirmation } }, db);
  const saved = await latestInitialCopy(db, s.tenantId, taskId);
  return { confirmationEventId: saved!.id, replayed: false };
}

/** One route for both native journeys; the persisted task source decides which applies. */
export async function confirmNativeCopy(db: Db, s: NativeActorScope, taskId: string, key: string, input: unknown) {
  const task = await initialTask(db, s.tenantId, taskId);
  if (task?.request_id && !nativeRevisionIntent(task.source))
    return confirmInitialNativeCopy(db, s, taskId, key, input as Parameters<typeof confirmInitialNativeCopy>[4]);
  return confirmNativeRevisionCopy(db, s, taskId, key, input as Parameters<typeof confirmNativeRevisionCopy>[4]);
}
