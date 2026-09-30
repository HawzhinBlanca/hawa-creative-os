import { CHANNEL_INGRESS_USER_ID, toApiTaskStatus } from '@hawa/contracts';
import { taskControlTarget, TaskControlPolicyError } from '@hawa/domain';
import { sql, TaskRepository, type Database, type Kysely } from '@hawa/db';
import type { LateRequesterChange } from './lifecycle-chat-target.js';

/** Caller records the routing receipt in this same transaction before acknowledging a hold. */
export async function pauseRequesterDesign(trx: Kysely<Database>, tenantId: string,
  late: Pick<LateRequesterChange, 'requestId' | 'taskId' | 'requestRev' | 'requestStage' | 'text'>,
  updateId: number): Promise<boolean> {
  if (late.requestStage !== 'designing') return false;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${late.requestId}`},0))`.execute(trx);
  const request = await trx.selectFrom('requests').select(['owner','stage','rev','current_task_id'])
    .where('tenant_id','=',tenantId).where('request_id','=',late.requestId).executeTakeFirst();
  if (request?.owner !== 'restate' || request.stage !== 'designing' ||
      Number(request.rev) !== late.requestRev || request.current_task_id !== late.taskId) return false;
  const task = await trx.selectFrom('tasks').select(['state','version','request_id'])
    .where('tenant_id','=',tenantId).where('id','=',late.taskId).forUpdate().executeTakeFirst();
  if (!task || task.request_id !== late.requestId) return false;
  // A concurrently replayed update must never re-pause a task the office already resumed.
  const prior = await trx.selectFrom('task_events').select('id')
    .where('tenant_id','=',tenantId).where('task_id','=',late.taskId)
    .where(sql<boolean>`data->>'requesterHoldUpdateId'=${String(updateId)}`).executeTakeFirst();
  if (prior) return true;
  if (task.state === 'paused') {
    const checkpoint = await trx.selectFrom('task_events').select('data')
      .where('tenant_id','=',tenantId).where('task_id','=',late.taskId).where('event_type','=','task.state_changed')
      .orderBy('aggregate_version','desc').limit(1).executeTakeFirst();
    return checkpoint?.data?.requesterHoldRequestId === late.requestId;
  }
  try { taskControlTarget(toApiTaskStatus(task.state),'pause'); }
  catch (error) { if (error instanceof TaskControlPolicyError) return false; throw error; }
  await new TaskRepository(trx).transitionState({taskId:late.taskId,tenantId,expectedVersion:Number(task.version),
    fromState:task.state,toState:'paused',actorType:'adapter',actorId:CHANNEL_INGRESS_USER_ID,
    reason:`Requester asked to hold the design: ${late.text}`.slice(0,1000),
    data:{operatorControl:'pause',requesterHoldRequestId:late.requestId,requesterHoldRequestRev:late.requestRev,
      requesterHoldUpdateId:String(updateId)}},trx);
  return true;
}
