import crypto from 'node:crypto';
import type { Context } from 'hono';
import { TaskStateMachine, type TaskStatus, type WorkflowExecutionState } from '@hawa/domain';
import { toApiTaskStatus, toDbTaskState, withRlsContext } from '@hawa/db';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';
import { createRedrive } from '../services/redrive.js';
import { decideForLifecycle, decisionProblem, officeActionIdOf, readTaskLifecycle } from '../services/office-decisions.js';

/**
 * The task controls (architecture programme 1.3, SPLIT_PLAN.md G6), moved unchanged from app.ts:
 * pause, resume, cancel and retry, the re-drive of one failed task and the sweep of all of them
 * (services/redrive.ts), and the workflow controller routes, which since then read the task's state
 * from Postgres and no longer keep a controller per task in memory.
 */
export function registerControlsRoutes(ctx: RouteContext): void {
  const {
    registerRoute, verifyRequestAuth, problem, db, taskRepo, events, readCurrentTask, broadcastTransition,
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

    // A task of a request the lifecycle owns (slice 2.4): cancel is RequestLifecycle's decision (it also
    // stops a running design); pause, resume and retry move nothing the lifecycle knows of, so they are
    // refused rather than let the task and its request disagree.
    if (db) {
      let lifecycle: Awaited<ReturnType<typeof readTaskLifecycle>> = null;
      try {
        lifecycle = await readTaskLifecycle(db, tenantId, taskId);
      } catch (err) {
        log.error('[core:control] Could not read whether the request lifecycle owns this task:', err);
        return problem(c, 503, 'Database Unavailable', 'Who controls this task could not be read; try again');
      }
      if (lifecycle?.owner === 'restate') {
        if (control !== 'cancel') {
          return c.json({
            type: 'https://hawa.design/errors/409', title: 'Lifecycle Owned', status: 409, code: 'LIFECYCLE_OWNED', instance: c.req.url, lifecycle,
            detail: `Task ${taskId} belongs to request ${lifecycle.requestId}, which the request lifecycle runs; ${control} is not one of its decisions. Cancel it, or re-drive it.`,
          }, 409);
        }
        const { actionId } = officeActionIdOf(c.req.header('Idempotency-Key'));
        const body = await c.req.json().catch(() => ({}));
        const comment = String(body?.reason || body?.comment || '').trim().slice(0, 1000);
        const { answer, forwarded } = await decideForLifecycle(db, tenantId, lifecycle, {
          actionId, actor: { userId: auth.userId || auth.actorId || 'operator', role: auth.role || 'operator' }, kind: 'cancel', taskId,
          ...(comment ? { comment } : {}),
        });
        const lifecycleNow = forwarded.kind === 'answered' && forwarded.result.accepted ? { ...lifecycle, rev: forwarded.result.rev, stage: forwarded.result.stage } : lifecycle;
        if (answer.status !== 200) return decisionProblem(c, answer, { actionId, lifecycle: lifecycleNow });
        return c.json({ commandId: crypto.randomUUID(), taskId, actionId, executor: 'restate', lifecycle: lifecycleNow, acceptedAt: new Date().toISOString() }, 202);
      }
    }

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
      const result = await redriveTask(taskId, undefined, { id: auth.userId || 'operator', role: auth.role || 'operator' }, { actionHeader: c.req.header('Idempotency-Key') });
      // A lifecycle request's re-drive or capture was RequestLifecycle's to decide (slice 2.4).
      if ('lifecycleAnswer' in result && result.lifecycleAnswer) {
        const { lifecycleAnswer, ...rest } = result;
        if (lifecycleAnswer.status !== 200) return decisionProblem(c, lifecycleAnswer, rest);
        return c.json(rest, 200);
      }
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

  // Worker Durable Execution Recovery Controller Endpoints (FR-060, FR-061, Gate C & H). These kept a
  // TaskWorkflowController per task in this process's memory: a restart lost every pause, checkpoint
  // and audit line, a second Core answered differently, and pause, resume and cancel changed only this
  // process's copy of the task, never Postgres, so neither the Desk nor the worker saw them. No Desk
  // screen calls them (architecture programme 1.3, SPLIT_PLAN.md G6). The state is now the task's as
  // Postgres has it; the durable controls are the four routes above, and a design run's checkpoints
  // and replay are the worker's Restate journal, so the actions answer 410 and name the route to use.
  const executionStateOf = (status: string): WorkflowExecutionState =>
    status === 'PAUSED' ? 'PAUSED'
      : status === 'CANCELLED' || status === 'REJECTED' ? 'CANCELLED'
      : status === 'COMPLETE' ? 'COMPLETE'
      : 'RUNNING';

  registerRoute('get', '/tasks/:taskId/workflow/state', async (c: Context) => {
    const taskId = c.req.param('taskId') || '';
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    const status = String(task.status);
    return c.json({ taskId, executionState: executionStateOf(status), status, version: task.version ?? null }, 200);
  });

  // What each retired action is now: a control on the task, or a new run of its design.
  const retiredWorkflowActions = new Map<string, string>([
    ['pause', 'pause'], ['resume', 'resume'], ['cancel', 'cancel'],
    ['crash', 'redrive'], ['checkpoint', 'redrive'], ['replay', 'redrive'],
  ]);

  registerRoute('post', '/tasks/:taskId/workflow/:action', async (c: Context) => {
    const taskId = c.req.param('taskId') || '';
    const use = retiredWorkflowActions.get(c.req.param('action') || '');
    if (!use) return problem(c, 400, 'Unknown Action', 'Supported actions: pause, resume, cancel, crash, checkpoint, replay');
    if (!(await readCurrentTask(taskId))) return problem(c, 404, 'Task Not Found');
    return problem(c, 410, 'Workflow Action Retired',
      `Workflow actions held their state in one Core process and never reached the task. Use POST /tasks/${taskId}/${use}.`);
  });
}
