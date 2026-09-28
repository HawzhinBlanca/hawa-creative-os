import type { Context } from 'hono';
import type { WorkflowExecutionState } from '@hawa/domain';
import { controlTask } from '../services/task-control-service.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';
import { createRedrive } from '../services/redrive.js';
import { rejectLegacyTaskDesignWrite } from './lifecycle-design-proof.js';

/**
 * The task controls (architecture programme 1.3, SPLIT_PLAN.md G6), moved unchanged from app.ts:
 * pause, resume, cancel and retry, the re-drive of one failed task and the sweep of all of them
 * (services/redrive.ts), and the workflow controller routes, which since then read the task's state
 * from Postgres and no longer keep a controller per task in memory.
 */
export function registerControlsRoutes(ctx: RouteContext): void {
  const {
    registerRoute, verifyRequestAuth, problem, db, readCurrentTask, broadcastTransition,
  } = ctx;
  const { redriveTask, sweepFailedTasks } = createRedrive(ctx);

  // Task Control Commands (pause, resume, cancel, retry), one explicit path each. They were one
  // POST /tasks/:taskId/:control route, registered before six other POST /tasks/:taskId/<word> routes,
  // which it answered 404 for an unknown task before handing them on: registration order decided
  // who answered (architecture programme 1.3, SPLIT_PLAN.md F9). Those six now check the task themselves.
  const applyControl = (control: 'pause' | 'resume' | 'cancel' | 'retry') => async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return problem(c, 401, 'Authentication Required');
    if (!['operator', 'administrator', 'art_director', 'creative_director', 'designer'].includes(auth.role || '')) {
      return problem(c, 403, 'Task Control Forbidden', 'An office operator or designer is required.');
    }
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    if (!(await readCurrentTask(taskId))) return problem(c, 404, 'Task Not Found');
    if (!db) return problem(c, 503, 'Database Required', 'Task controls require a durable checkpoint.');
    if (control === 'retry') return problem(c, 409, 'RECOVERY_CHECKPOINT_REQUIRED',
      'Inspect the saved Studio or Canva run and use its resume action. A task-state change alone cannot safely retry work.');
    const body = await c.req.json().catch(() => null);
    const key = c.req.header('Idempotency-Key') || '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !Number.isSafeInteger(body?.expectedVersion) || body.expectedVersion < 1 ||
        typeof body?.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) {
      return problem(c, 422, 'TASK_CONTROL_INPUT_REQUIRED', 'Provide a stable Idempotency-Key, current expectedVersion and a reason (1–2000 characters).');
    }
    try {
      const result = await controlTask(db, { tenantId: auth.tenantId, actorId: auth.userId, role: auth.role || 'operator' },
        taskId, control, { key, expectedVersion: body.expectedVersion, reason: body.reason.trim() });
      if (!result.replayed) broadcastTransition(taskId, String(result.fromStatus), String(result.status), Number(result.version));
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof CanvaFlowError) return problem(c, error.status, error.code, error.message);
      log.error('[core:control:db] Durable control failed');
      return problem(c, 503, 'TASK_CONTROL_UNAVAILABLE', 'The control could not be confirmed. Retry with the same key after storage recovers.');
    }
  };
  for (const control of ['pause', 'resume', 'cancel', 'retry'] as const) registerRoute('post', `/tasks/:taskId/${control}`, applyControl(control));

  // Re-drive Failed Task Generation (ADR-025 / Audit 2026-09-16)
  registerRoute('post', '/tasks/:taskId/redrive', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    const taskId = c.req.param('taskId');
    // 404 for a task nobody knows, 503 when Postgres cannot be read (the `:control` catch-all answered these).
    if (!(await readCurrentTask(taskId))) return problem(c, 404, 'Task Not Found');
    try {
      const result = await redriveTask(taskId, undefined, { id: auth.userId || 'operator', role: auth.role || 'operator' });
      if (!result.ok && (result as any).code === 'TASK_GENERATION_BLOCKED') return problem(c, 409, 'TASK_GENERATION_BLOCKED', (result as any).message || '');
      if (!result.ok && (result as any).code === 'LIFECYCLE_OWNED') return problem(c, 409, 'LIFECYCLE_OWNED', (result as any).message || '');
      if (!result.ok && (result as any).code === 'CLIENT_REQUIRED') return problem(c, 422, 'CLIENT_REQUIRED', (result as any).message || '');
      if (!result.ok && (result as any).code === 'TASK_NOT_FOUND') return problem(c, 404, 'TASK_NOT_FOUND', (result as any).message || '');
      return c.json(result, result.ok ? 200 : 500);
    } catch (err: any) {
      if (err instanceof CanvaFlowError) return problem(c, err.status, err.code, err.message);
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
