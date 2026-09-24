import crypto from 'node:crypto';
import { isTaskApiStatus } from '@hawa/contracts';
import { TaskStateMachine, TaskWorkflowController, type TaskActor, type TaskStatus } from '@hawa/domain';
import { toApiTaskStatus, toDbTaskState, withRlsContext } from '@hawa/db';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';
import { createRedrive } from '../services/redrive.js';

/**
 * The task controls (architecture programme 1.3, SPLIT_PLAN.md G6), moved unchanged from app.ts:
 * pause, resume, cancel and retry, the re-drive of one failed task and the sweep of all of them
 * (services/redrive.ts), and the workflow controller routes.
 */
export function registerControlsRoutes(ctx: RouteContext): void {
  const {
    registerRoute, verifyRequestAuth, problem, db, taskRepo, tasks, events, workflowControllers, readCurrentTask,
    broadcastEvent: broadcast, broadcastTransition,
  } = ctx;
  const { redriveTask, sweepFailedTasks } = createRedrive(ctx);

  // Task Control Commands (pause, resume, cancel, retry), one explicit path each. They were one
  // POST /tasks/:taskId/:control route, registered before six other POST /tasks/:taskId/<word> routes,
  // which it answered 404 for an unknown task before handing them on: registration order decided
  // who answered (architecture programme 1.3, SPLIT_PLAN.md F9). Those six now check the task themselves.
  const controlTask = (control: 'pause' | 'resume' | 'cancel' | 'retry') => async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    let task = await readCurrentTask(taskId);
    let dbTask: any = null;
    if (taskRepo && db) {
      try {
        dbTask = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          return await taskRepo.findById(taskId, tenantId, trx);
        });
      } catch (err) {
        log.error('[core:control:lookup] DB task error:', err);
      }
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    const currentStatus = task ? task.status : toApiTaskStatus(dbTask.state);
    const sm = new TaskStateMachine(taskId, currentStatus);
    let targetStatus: TaskStatus = 'COMPLETE';
    let reason = `Operator invoked ${control}`;

    if (control === 'pause') targetStatus = 'PLANNING';
    else if (control === 'resume') targetStatus = 'PLANNING';
    else if (control === 'cancel') targetStatus = 'OPERATOR_REQUIRED';
    else if (control === 'retry') targetStatus = 'PLANNING';

    const trans = sm.transition(targetStatus, { type: 'user', id: auth.actorId || 'operator' }, reason);
    if (!trans.ok) return problem(c, 409, 'Conflict', trans.error.message);

    if (task) {
      task.status = targetStatus;
      task.updatedAt = new Date().toISOString();
      if (!events.has(taskId)) events.set(taskId, []);
      events.get(taskId)?.push(trans.value);
    }

    let controlVersion: number | null = null;
    if (taskRepo && db) {
      try {
        await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          controlVersion = Number((await taskRepo.transitionState({
            taskId,
            tenantId,
            toState: toDbTaskState(targetStatus),
            actorType: 'user',
            actorId: auth.actorId || auth.userId || 'operator',
            reason,
            data: { control },
          }, trx))?.version) || null;
        });
      } catch (err) {
        log.error('[core:control:db] DB transition error:', err);
      }
    }

    broadcastTransition(taskId, currentStatus, targetStatus, controlVersion);

    return c.json({
      commandId: crypto.randomUUID(),
      taskId,
      workflowId: `wf_${taskId}`,
      acceptedAt: new Date().toISOString(),
    }, 202);
  };
  for (const control of ['pause', 'resume', 'cancel', 'retry'] as const) registerRoute('post', `/tasks/:taskId/${control}`, controlTask(control));

  // Re-drive Failed Task Generation (ADR-025 / Audit 2026-09-16)
  registerRoute('post', '/tasks/:taskId/redrive', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const taskId = c.req.param('taskId');
    // 404 for a task nobody knows, 503 when Postgres cannot be read (the `:control` catch-all answered these).
    if (!(await readCurrentTask(taskId))) return problem(c, 404, 'Task Not Found');
    try {
      const result = await redriveTask(taskId, undefined, { id: auth.userId || 'operator', role: auth.role || 'operator' });
      if (!result.ok && (result as any).code === 'CLIENT_REQUIRED') return problem(c, 422, 'CLIENT_REQUIRED', (result as any).message || '');
      if (!result.ok && (result as any).code === 'TASK_NOT_FOUND') return problem(c, 404, 'TASK_NOT_FOUND', (result as any).message || '');
      return c.json(result, result.ok ? 200 : 500);
    } catch (err: any) {
      return problem(c, 500, 'REDRIVE_FAILED', err.message || 'Task redrive failed');
    }
  });

  // Daily / On-Demand Sweep of Failed Generation Tasks
  registerRoute('post', '/tasks/sweep-failed', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    if (auth.role !== 'administrator' && auth.role !== 'operator') return problem(c, 403, 'Forbidden', 'Operator required');
    const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
    try {
      const result = await sweepFailedTasks(tenantId);
      return c.json(result, 200);
    } catch (err: any) {
      return problem(c, 500, 'SWEEP_FAILED', err.message || 'Failed tasks sweep failed');
    }
  });

  // Helper: Retrieve or instantiate Task Durable Workflow Controller (FR-060, Invariant #10 & #12)
  function getOrCreateWorkflowController(taskId: string): TaskWorkflowController {
    let controller = workflowControllers.get(taskId);
    if (!controller) {
      const task = tasks.get(taskId);
      const isComplete = task?.status === 'COMPLETE';
      controller = new TaskWorkflowController(taskId, isComplete ? 'COMPLETE' : 'RUNNING');
      controller.recordCheckpoint(
        task?.currentPhase || 'INTAKE',
        (task?.status as TaskStatus) || 'RECEIVED',
        `init_${taskId}`,
        [
          {
            type: 'asset_render',
            key: `render_init_${taskId}`,
            completedAt: new Date().toISOString(),
          },
        ],
        { taskTitle: (task as any)?.title || taskId, status: task?.status || 'RECEIVED' }
      );
      workflowControllers.set(taskId, controller);
    }
    return controller;
  }

  // Worker Durable Execution Recovery Controller Endpoints (FR-060, FR-061, Gate C & H)
  registerRoute('get', '/tasks/:taskId/workflow/state', async (c: any) => {
    const taskId = c.req.param('taskId');
    const controller = getOrCreateWorkflowController(taskId);
    return c.json(controller.getState(), 200);
  });

  registerRoute('post', '/tasks/:taskId/workflow/:action', async (c: any) => {
    const taskId = c.req.param('taskId');
    const action = c.req.param('action');
    const body = await c.req.json().catch(() => ({}));
    const reason = body.reason || `Operator action: ${action}`;
    const actor: TaskActor = body.actor || { type: 'user', id: 'operator' };

    const controller = getOrCreateWorkflowController(taskId);
    const task = tasks.get(taskId);

    if (action === 'pause') {
      const ok = controller.pause(actor, reason);
      if (!ok) return problem(c, 400, 'Invalid Workflow Transition', `Cannot pause workflow in state ${controller.getExecutionState()}`);
      if (task) task.status = 'PAUSED';
      broadcast('workflow:state_changed', { taskId, action: 'pause', state: controller.getState() });
      return c.json({ ok: true, state: controller.getState() }, 200);
    }

    if (action === 'resume') {
      const ok = controller.resume(actor, reason);
      if (!ok) return problem(c, 400, 'Invalid Workflow Transition', `Cannot resume workflow in state ${controller.getExecutionState()}`);
      // COMPOSING: the design is being made again (this said DESIGN_IN_PROGRESS, a word no other layer had).
      if (task) task.status = 'COMPOSING';
      broadcast('workflow:state_changed', { taskId, action: 'resume', state: controller.getState() });
      return c.json({ ok: true, state: controller.getState() }, 200);
    }

    if (action === 'cancel') {
      const ok = controller.cancel(actor, reason);
      if (!ok) return problem(c, 400, 'Invalid Workflow Transition', `Cannot cancel workflow in state ${controller.getExecutionState()}`);
      if (task) task.status = 'CANCELLED';
      broadcast('workflow:state_changed', { taskId, action: 'cancel', state: controller.getState() });
      return c.json({ ok: true, state: controller.getState() }, 200);
    }

    if (action === 'crash') {
      controller.simulateCrash(reason);
      broadcast('workflow:state_changed', { taskId, action: 'crash', state: controller.getState() });
      return c.json({ ok: true, simulatedCrash: true, state: controller.getState() }, 200);
    }

    if (action === 'checkpoint') {
      const stage = body.stage || task?.currentPhase || 'SYNTHESIS';
      const status = body.status || task?.status || 'COMPOSING';
      // A replay puts this status back on the task, so it must be one the vocabulary has.
      if (!isTaskApiStatus(status)) return problem(c, 400, 'Bad Request', `Checkpoint status "${status}" is not a task status`);
      const idempotencyKey = body.idempotencyKey || `chk_${crypto.randomUUID()}`;
      const sideEffects = body.completedSideEffects || [];
      const payload = body.payload || {};
      const chk = controller.recordCheckpoint(stage, status, idempotencyKey, sideEffects, payload);
      broadcast('workflow:checkpoint_recorded', { taskId, checkpoint: chk });
      return c.json({ ok: true, checkpoint: chk, state: controller.getState() }, 201);
    }

    if (action === 'replay') {
      const targetCheckpointId = body.targetCheckpointId;
      const replayResult = controller.replayFromCheckpoint(actor, reason, targetCheckpointId);
      if (!replayResult.success) {
        return problem(c, 400, 'Replay Failed', 'Unable to replay from specified checkpoint');
      }
      if (task && replayResult.restoredCheckpoint) {
        task.status = replayResult.restoredCheckpoint.taskStatus;
      }
      broadcast('workflow:state_changed', { taskId, action: 'replay', replayResult, state: controller.getState() });
      return c.json({ ok: true, replayResult, state: controller.getState() }, 200);
    }

    return problem(c, 400, 'Unknown Action', 'Supported actions: pause, resume, cancel, crash, checkpoint, replay');
  });
}
