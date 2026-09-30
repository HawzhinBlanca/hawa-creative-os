import { createHash, randomUUID } from 'node:crypto';
import { taskControlTarget, TaskControlPolicyError, type TaskControl } from '@hawa/domain';
import { TaskRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { isTaskApiStatus, isTaskDbState, isServiceUserId, toApiTaskStatus, toDbTaskState } from '@hawa/contracts';
import { CanvaFlowError } from './canva-flow-error.js';

type Scope = { tenantId: string; actorId: string; role: string };
interface TaskControlReceipt { commandId: string; taskId: string; workflowId: string; acceptedAt: string; fromStatus: string; status: string; version: number }
export interface TaskControlInput { reason: string; expectedVersion: number; key: string }

export async function controlTask(db: Kysely<Database>, scope: Scope, taskId: string, control: TaskControl, input: TaskControlInput) {
  const requestHash = createHash('sha256').update(JSON.stringify({ control, ...input, actorId: scope.actorId })).digest('hex');
  return withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: scope.role }, async trx => {
    const owner = await trx.selectFrom('tasks').select('request_id')
      .where('id','=',taskId).where('tenant_id','=',scope.tenantId).executeTakeFirst();
    if (owner?.request_id) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${owner.request_id}`},0))`.execute(trx);
    const task = await trx.selectFrom('tasks').select(['state', 'version', 'request_id'])
      .where('id', '=', taskId).where('tenant_id', '=', scope.tenantId).forUpdate().executeTakeFirst();
    if (!task) throw new CanvaFlowError(404, 'TASK_NOT_FOUND', 'Task not found in your scope.');
    if (task.request_id && (control !== 'resume' || isServiceUserId(scope.actorId))) {
      throw new CanvaFlowError(409, 'LIFECYCLE_OWNED', 'Only the office can resume a requester hold on the current task.');
    }
    const prior = (await sql<{data: Record<string, unknown>}>`SELECT data FROM hawa.task_events
      WHERE tenant_id=${scope.tenantId}::uuid AND task_id=${taskId}::uuid AND event_type='task.state_changed'
      AND data->>'controlKey'=${input.key} ORDER BY aggregate_version DESC LIMIT 1`.execute(trx)).rows[0];
    if (prior) {
      if (prior.data.controlRequestHash !== requestHash) throw new CanvaFlowError(409, 'IDEMPOTENCY_CONFLICT', 'This control key belongs to a different action.');
      const receipt = prior.data.controlReceipt as TaskControlReceipt | undefined;
      if (!receipt || receipt.taskId !== taskId || !isTaskApiStatus(receipt.status) || !isTaskApiStatus(receipt.fromStatus) ||
          !Number.isSafeInteger(receipt.version) || typeof receipt.commandId !== 'string' || typeof receipt.acceptedAt !== 'string') {
        throw new CanvaFlowError(503, 'CONTROL_RECEIPT_INVALID', 'The saved control receipt needs operator inspection.');
      }
      return { ...receipt, replayed: true };
    }
    if (Number(task.version) !== input.expectedVersion) {
      throw new CanvaFlowError(409, 'TASK_VERSION_CONFLICT', 'The task changed. Refresh it before applying this control.');
    }
    const checkpoint = control === 'resume' ? await trx.selectFrom('task_events').select('data')
      .where('task_id', '=', taskId).where('tenant_id', '=', scope.tenantId).where('event_type', '=', 'task.state_changed')
      .orderBy('aggregate_version', 'desc').limit(1).executeTakeFirst() : undefined;
    const data = checkpoint?.data as Record<string, unknown> | undefined;
    if (task.request_id) {
      const request = await trx.selectFrom('requests').select(['owner','current_task_id','stage','rev'])
        .where('tenant_id','=',scope.tenantId).where('request_id','=',task.request_id).executeTakeFirst();
      if (data?.requesterHoldRequestId !== task.request_id || request?.owner !== 'restate' ||
          request.current_task_id !== taskId || request.stage !== 'designing' ||
          Number(request.rev) !== data.requesterHoldRequestRev) {
        throw new CanvaFlowError(409,'LIFECYCLE_OWNED','This task has no current requester hold checkpoint to resume.');
      }
    }
    const pausedFrom = data?.operatorControl === 'pause' && data.toState === 'paused' && isTaskDbState(data.fromState)
      ? toApiTaskStatus(data.fromState) : undefined;
    let target;
    try { target = taskControlTarget(toApiTaskStatus(task.state), control, pausedFrom); }
    catch (error) {
      if (error instanceof TaskControlPolicyError) throw new CanvaFlowError(409, error.code, error.message);
      throw error;
    }
    const receipt = { commandId: randomUUID(), taskId, workflowId: task.request_id ?? `wf_${taskId}`, acceptedAt: new Date().toISOString(),
      fromStatus: toApiTaskStatus(task.state), status: target, version: Number(task.version) + 1 };
    await new TaskRepository(trx).transitionState({ taskId, tenantId: scope.tenantId,
      expectedVersion: input.expectedVersion, fromState: task.state, toState: toDbTaskState(target),
      actorType: 'user', actorId: scope.actorId, reason: input.reason,
      data: { operatorControl: control, controlKey: input.key, controlRequestHash: requestHash, controlReceipt: receipt },
    }, trx);
    return { ...receipt, replayed: false };
  });
}
