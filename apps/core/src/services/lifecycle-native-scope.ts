import { sql, type Kysely, type Database } from '@hawa/db';
import { nativeRevisionIntent, NATIVE_RECOVERY_ROLES, type NativeRecoveryScope } from '@hawa/domain';
import { isServiceUserId } from '@hawa/contracts';
import { CanvaFlowError } from './canva-flow-error.js';

export type NativeActorScope = { tenantId: string; actorId: string; role?: string; nativeRecovery?: NativeRecoveryScope };

/** Caller transaction keeps this lock through the preparation write or owner projection. */
export async function lockNativeRecovery(db: Kysely<Database>, s: NativeActorScope, taskId: string) {
  const scope = s.nativeRecovery;
  if (!scope || !NATIVE_RECOVERY_ROLES.some(role => role === s.role) || isServiceUserId(s.actorId))
    throw new CanvaFlowError(409, 'LIFECYCLE_OWNED', 'Use the current manual request and an office human identity.');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${scope.requestId}`},0))`.execute(db);
  // FOR SHARE would also require the users UPDATE policy and hide valid office
  // actors from hawa_app. This is an active-user snapshot check, not a lock that
  // serializes concurrent account revocation; request mutation is fenced below.
  const actor=await db.selectFrom('users').select('id').where('id','=',s.actorId).where('disabled_at','is',null)
    .executeTakeFirst();
  if (!actor) throw new CanvaFlowError(403,'HUMAN_REVIEW_REQUIRED','An active office user must perform the native handoff.');
  const request = (await sql<{ request_id: string; rev: number; stage: string; owner: string; current_task_id: string }>`
    SELECT request_id,rev,stage,owner,current_task_id FROM hawa.requests
    WHERE tenant_id=${s.tenantId}::uuid AND request_id=${scope.requestId}::uuid FOR UPDATE`.execute(db)).rows[0];
  const task = (await sql<{ request_id: string; source: unknown }>`SELECT t.request_id,
    (SELECT e.data FROM hawa.task_events e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id
      AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
    FROM hawa.tasks t WHERE t.tenant_id=${s.tenantId}::uuid AND t.id=${taskId}::uuid`.execute(db)).rows[0];
  if (!request || request.owner !== 'restate' || request.stage !== 'manual' ||
      request.current_task_id !== taskId || Number(request.rev) !== scope.rev || scope.rev < 2 ||
      task?.request_id !== scope.requestId || !nativeRevisionIntent(task.source))
    throw new CanvaFlowError(409, 'NATIVE_RECOVERY_STALE', 'Reload the current manual revision request before changing its native handoff.');
  return request;
}
