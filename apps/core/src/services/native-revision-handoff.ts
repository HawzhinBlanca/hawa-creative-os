import { createHash } from 'node:crypto';
import { sql, TaskRepository, type Database, type Kysely } from '@hawa/db';
import { freshRoundIntent, nativeRevisionIntent, validReviewedRevisionCopy } from '@hawa/domain';
import { isServiceUserId } from '@hawa/contracts';
import { CanvaFlowError } from './canva-flow-error.js';
import { savedDesignCopy } from './saved-design-copy.js';
import { lockNativeRecovery, type NativeActorScope } from './lifecycle-native-scope.js';

type Db = Kysely<Database>;
type Scope = NativeActorScope;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instruction = 'Open the revision handoff in Canva design and exports. Copy the current native design, preserve unrelated edits, link the separate copy and confirm its exact revised text before capture.';

async function taskSource(db: Db, tenantId: string, taskId: string) {
  return (await sql<{ client_id: string | null; request_id: string | null; state: string; version: number; description: string; source: unknown }>`
    SELECT t.client_id,t.request_id,t.state,t.version,t.description,
      (SELECT e.data FROM hawa.task_events e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id
       AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
    FROM hawa.tasks t WHERE t.tenant_id=${tenantId}::uuid AND t.id=${taskId}::uuid`.execute(db)).rows[0];
}

/** No qualified native patch exists yet. This guard precedes all new creative spending. */
export async function assertNativeRevisionAdmission(db: Db, tenantId: string, taskId: string, historicalParent?: unknown): Promise<void> {
  const task = await taskSource(db, tenantId, taskId);
  if (nativeRevisionIntent(task?.source) || (typeof historicalParent === 'string' && historicalParent))
    throw new CanvaFlowError(422, 'NATIVE_REVISION_HANDOFF_REQUIRED', instruction);
  // ADR-233: a fresh round (a redo, or changes sent while the first draft was made) is a new design of
  // its own request. Its parent must be another task of the same request and client; anything else is
  // held exactly as a native revision is. The parent's Canva design is never opened by the round.
  const fresh = freshRoundIntent(task?.source);
  if (fresh) {
    const parent = (await sql<{ ok: boolean }>`SELECT (p.request_id IS NOT NULL AND p.request_id = t.request_id
        AND p.client_id IS NOT DISTINCT FROM t.client_id AND p.id <> t.id) AS ok
      FROM hawa.tasks t JOIN hawa.tasks p ON p.tenant_id = t.tenant_id AND p.id = ${fresh.parentTaskId}::uuid
      WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${taskId}::uuid`.execute(db)).rows[0];
    if (!parent?.ok) throw new CanvaFlowError(422, 'NATIVE_REVISION_HANDOFF_REQUIRED',
      'This new version names an earlier design outside its own request. An operator must review it before anything is made.');
  }
}

export interface RevisionCopyConfirmation {
  schemaVersion: 1;
  requestKey: string;
  requestHash: string;
  basisSha256: string;
  copy: string[];
  parentTaskId: string;
  parentTaskVersion: number;
  parentBindingId: string;
  parentBindingVersion: number;
  parentDesignId: string;
  bindingId: string;
  bindingVersion: number;
  designId: string;
  clientId: string;
  preservation: 'operator_reviewed';
}

export async function latestRevisionCopy(db: Db, tenantId: string, taskId: string) {
  const row = (await sql<{ id: string; data: { revisionHandoff: RevisionCopyConfirmation }; actor_id: string | null }>`
    SELECT id,data,actor_id FROM hawa.task_events WHERE tenant_id=${tenantId}::uuid AND task_id=${taskId}::uuid
      AND actor_type='user' AND data->'revisionHandoff'->>'schemaVersion'='1'
    ORDER BY aggregate_version DESC LIMIT 1`.execute(db)).rows[0];
  if (!row?.actor_id || isServiceUserId(row.actor_id)) return undefined;
  return { id: row.id, ...row.data.revisionHandoff };
}

export async function nativeRevisionHandoff(db: Db, tenantId: string, taskId: string) {
  const task = await taskSource(db, tenantId, taskId);
  const intent = nativeRevisionIntent(task?.source);
  if (!intent) return undefined;
  if (!task?.client_id || !uuid.test(intent.parentTaskId) || intent.parentTaskId === taskId)
    return { required: true as const, available: false as const, message: 'The original design reference needs an operator review.' };
  const parent = (await sql<{ id: string; version: number; binding_id: string | null; binding_version: number | null; design_id: string | null; edit_url: string | null }>`
    SELECT t.id,t.version,b.id AS binding_id,b.version AS binding_version,b.canva_design_id AS design_id,b.edit_url
    FROM hawa.tasks t LEFT JOIN hawa.canva_bindings b ON b.tenant_id=t.tenant_id AND b.task_id=t.id
      AND b.client_id=t.client_id AND b.status='bound' AND b.direction_name='primary'
    WHERE t.tenant_id=${tenantId}::uuid AND t.id=${intent.parentTaskId}::uuid AND t.client_id=${task.client_id}::uuid`.execute(db)).rows[0];
  if (!parent) return { required: true as const, available: false as const, message: 'The original design is unavailable in this client scope.' };
  const binding = (await sql<{ id: string; version: number; canva_design_id: string }>`SELECT id,version,canva_design_id
    FROM hawa.canva_bindings WHERE tenant_id=${tenantId}::uuid AND task_id=${taskId}::uuid
      AND client_id=${task.client_id}::uuid AND status='bound' AND direction_name='primary'`.execute(db)).rows[0];
  const confirmed = await latestRevisionCopy(db, tenantId, taskId);
  let copy: string[] = [];
  try { copy = savedDesignCopy(task.source, task.description).copy; } catch { /* Human must supply exact copy. */ }
  const basis = { taskId, clientId: task.client_id, parentTaskId: parent.id, parentTaskVersion: Number(parent.version),
    parentBindingId: parent.binding_id, parentBindingVersion: parent.binding_version, parentDesignId: parent.design_id,
    bindingId: binding?.id ?? null, bindingVersion: binding?.version ?? null, designId: binding?.canva_design_id ?? null };
  const basisSha256 = digest(basis);
  const request = task.request_id ? await db.selectFrom('requests').select(['owner','stage','rev','current_task_id'])
    .where('tenant_id','=',tenantId).where('request_id','=',task.request_id).executeTakeFirst() : undefined;
  const nativeRecovery = request?.owner === 'restate' && request.stage === 'manual' && request.current_task_id === taskId && Number(request.rev) >= 2
    ? { requestId: task.request_id!, rev: Number(request.rev) } : undefined;
  return { required: true as const, available: true as const, ...basis, basisSha256, taskVersion: Number(task.version),
    lifecycleOwned: Boolean(task.request_id), nativeRecovery, parentEditUrl: parent.edit_url, directive: intent.directive,
    copy: confirmed?.copy ?? copy, confirmedEventId: confirmed?.basisSha256 === basisSha256 ? confirmed.id : null,
    message: instruction };
}

/** Caller owns an actor-scoped transaction. Confirmation never approves a design. */
export async function confirmNativeRevisionCopy(db: Db, s: Scope, taskId: string, key: string, input: {
  expectedTaskVersion: number; basisSha256: string; copy: unknown; reviewedCurrentDesign: unknown; preservedUnrequestedChanges: unknown;
}) {
  if (!['administrator', 'art_director', 'creative_director', 'operator', 'designer'].includes(s.role || '') || isServiceUserId(s.actorId))
    throw new CanvaFlowError(403, 'HUMAN_REVIEW_REQUIRED', 'An office operator or designer must confirm the revised copy.');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !Number.isSafeInteger(input.expectedTaskVersion) ||
      !/^[0-9a-f]{64}$/.test(input.basisSha256 || '') || !validReviewedRevisionCopy(input.copy) ||
      input.reviewedCurrentDesign !== true || input.preservedUnrequestedChanges !== true)
    throw new CanvaFlowError(422, 'REVISION_COPY_REVIEW_REQUIRED', 'Review the current native design, unrelated changes and exact final copy before confirming.');
  if (s.nativeRecovery) await lockNativeRecovery(db,s,taskId);
  await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db);
  const requestHash = digest({ ...(s.nativeRecovery ? {nativeRecovery:s.nativeRecovery} : {}), expectedTaskVersion: input.expectedTaskVersion, basisSha256: input.basisSha256,
    copy: input.copy, reviewedCurrentDesign: true, preservedUnrequestedChanges: true });
  const prior = (await sql<{ id: string; actor_id: string; data: { revisionHandoff: RevisionCopyConfirmation } }>`SELECT id,actor_id,data
    FROM hawa.task_events WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid
      AND data->'revisionHandoff'->>'requestKey'=${key} ORDER BY aggregate_version DESC LIMIT 1`.execute(db)).rows[0];
  if (prior) {
    if (prior.actor_id !== s.actorId || prior.data.revisionHandoff.requestHash !== requestHash)
      throw new CanvaFlowError(409, 'REVISION_REVIEW_CONFLICT', 'This request key already identifies another copy review.');
    return { confirmationEventId: prior.id, replayed: true };
  }
  const task = await taskSource(db, s.tenantId, taskId);
  if (!task || (task.request_id && !s.nativeRecovery) || !['received','failed_operator','human_review','revision_requested','approved'].includes(task.state))
    throw new CanvaFlowError(409, 'REVISION_HANDOFF_UNAVAILABLE', 'Use the current task owner and an open manual revision task.');
  // Lock both bindings and the parent task before validating the expected basis.
  const intent = nativeRevisionIntent(task.source);
  if (intent && uuid.test(intent.parentTaskId)) {
    await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${intent.parentTaskId}::uuid
      AND client_id=${task.client_id}::uuid FOR SHARE`.execute(db);
    await sql`SELECT id FROM hawa.canva_bindings WHERE tenant_id=${s.tenantId}::uuid
      AND client_id=${task.client_id}::uuid AND task_id IN (${taskId}::uuid,${intent.parentTaskId}::uuid) ORDER BY id FOR SHARE`.execute(db);
  }
  const handoff = await nativeRevisionHandoff(db, s.tenantId, taskId);
  if (!handoff?.available || !handoff.bindingId || !handoff.parentBindingId ||
      !handoff.designId || !handoff.parentDesignId || handoff.designId === handoff.parentDesignId)
    throw new CanvaFlowError(409, 'NATIVE_COPY_REQUIRED', 'Link a separate copy of the original native design before confirming.');
  if (Number(task.version) !== input.expectedTaskVersion || handoff.basisSha256 !== input.basisSha256)
    throw new CanvaFlowError(409, 'REVISION_BASIS_CHANGED', 'The task or linked design changed. Reload and review the current native basis.');
  const confirmation: RevisionCopyConfirmation = { schemaVersion: 1, requestKey: key, requestHash, basisSha256: handoff.basisSha256,
    copy: input.copy, parentTaskId: handoff.parentTaskId, parentTaskVersion: handoff.parentTaskVersion, parentBindingId: handoff.parentBindingId,
    parentBindingVersion: handoff.parentBindingVersion!, parentDesignId: handoff.parentDesignId,
    bindingId: handoff.bindingId, bindingVersion: handoff.bindingVersion!, designId: handoff.designId,
    clientId: handoff.clientId, preservation: 'operator_reviewed' };
  await new TaskRepository(db).transitionState({ taskId, tenantId: s.tenantId, expectedVersion: Number(task.version),
    fromState: task.state as 'received', toState: 'failed_operator', actorType: 'user', actorId: s.actorId,
    reason: 'Exact revised copy confirmed; capture the current native copy for review.', data: { revisionHandoff: confirmation } }, db);
  const saved = await latestRevisionCopy(db, s.tenantId, taskId);
  return { confirmationEventId: saved!.id, replayed: false };
}
