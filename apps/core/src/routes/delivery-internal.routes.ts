import type { DeliveryOutcome } from '@hawa/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { RouteContext } from './types.js';
import { isValidUuid, secretsEqual } from '../core-helpers.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';

/**
 * Core's side of the Restate Delivery workflow (architecture programme Phase 2, slice 2.2;
 * PHASE2_DESIGN.md sections 2.5 and 2.8, ADR-034). Only the worker calls these:
 *
 * - POST /v1/internal/lifecycle/:requestId/deliveries/:approvalId/prepare: the workflow's first step.
 *   Core's own delivery without the requester's messages and without completing the task: the Drive
 *   archive and the Sheets row (both idempotent through the publication key), then what the requester
 *   is sent. Asked again after a lost answer, it adopts the Drive files it already wrote.
 * - POST /v1/internal/tasks/:taskId/delivery-finished: the workflow's report, which moves the task
 *   (COMPLETE, PUBLISH_RECONCILIATION or back to APPROVED) once. In slice 2.3 the report goes to
 *   RequestLifecycle instead.
 *
 * They are registered straight on the app, not through registerRoute, because they take one
 * credential only: the worker's own HAWA_WORKER_TOKEN, a service principal (PHASE2_DESIGN.md 1.2
 * finding 3). The operator, Desk and API tokens all open registerRoute's guard, and none of them may
 * reach these. When verifyRequestAuth learns the service principal (the internal-auth work of the
 * same phase), a caller it maps to role 'service' is accepted too; until then this module checks the
 * token itself.
 */
export function registerDeliveryInternalRoutes(ctx: RouteContext): void {
  const { app, problem, readCurrentTask, verifyRequestAuth } = ctx;
  const { prepareWorkflowDelivery, finishWorkflowDelivery } = ctx.delivery;

  const isWorker = (c: Context): boolean => {
    const configured = process.env.HAWA_WORKER_TOKEN;
    const header = String(c.req.header('Authorization') || '');
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (configured && configured.trim() && presented && secretsEqual(presented, configured)) return true;
    // Only a request that carries a credential: the test harness signs token-less requests in as an
    // operator, and an operator is refused anyway, but nothing here relies on that.
    if (!presented) return false;
    const auth = verifyRequestAuth(c);
    return Boolean(auth.authenticated && auth.role === 'service');
  };

  const refuse = (c: Context) => problem(c, 401, 'Worker Credential Required', 'Internal endpoints take the worker token (HAWA_WORKER_TOKEN) only');

  /** A problem the worker can act on: its code says whether asking again can help (503) or not. */
  const failed = (c: Context, status: number, code: string, message: string) =>
    c.json({ type: `https://hawa.design/errors/${status}`, title: code, status, code, detail: message, instance: c.req.url }, status as ContentfulStatusCode);

  app.post('/v1/internal/lifecycle/:requestId/deliveries/:approvalId/prepare', async (c: Context) => {
    if (!isWorker(c)) return refuse(c);
    const approvalId = c.req.param('approvalId') || '';
    const body = await c.req.json().catch(() => ({}));
    const taskId = String(body?.taskId || '');
    const tenantId = String(body?.tenantId || '');
    if (![taskId, tenantId, approvalId].every(isValidUuid)) return failed(c, 422, 'INVALID_REQUEST', 'prepare names a task, its tenant and an approval, each by id');
    // The tenant comes from the workflow's input, which Core wrote; a task of another tenant is not found.
    let task: Awaited<ReturnType<typeof readCurrentTask>>;
    try {
      task = await readCurrentTask(taskId);
    } catch (err) {
      return failed(c, 503, 'DATABASE_UNAVAILABLE', err instanceof Error ? err.message : String(err));
    }
    const taskTenant = task?.tenantId && isValidUuid(task.tenantId) ? task.tenantId : DEFAULT_TENANT_ID;
    if (!task || taskTenant !== tenantId) return failed(c, 404, 'TASK_NOT_FOUND', `Task ${taskId} is not in tenant ${tenantId}`);

    const result = await prepareWorkflowDelivery(taskId, {
      tenantId,
      approvalId,
      revisionId: typeof body?.revisionId === 'string' ? body.revisionId : undefined,
      policy: typeof body?.policy === 'string' ? body.policy : undefined,
    });
    if (result?.ok && result.prepared) return c.json(result.prepared, 200);
    const status = Number(result?.status) || 500;
    // Another delivery of the task holds the publish lock for the moment: the workflow asks again.
    const code = String(result?.code || (status === 404 ? 'TASK_NOT_FOUND' : status === 422 ? 'NOTHING_TO_DELIVER' : 'PREPARE_FAILED'));
    const retryable = status >= 500 || code === 'PUBLICATION_IN_PROGRESS';
    log.warn(`[core:delivery-internal] prepare of task ${taskId} answered ${status} ${code}: ${result?.message || ''}`);
    return failed(c, retryable ? 503 : status, code, String(result?.message || code));
  });

  app.post('/v1/internal/tasks/:taskId/delivery-finished', async (c: Context) => {
    if (!isWorker(c)) return refuse(c);
    const taskId = c.req.param('taskId') || '';
    const body = await c.req.json().catch(() => ({}));
    const outcome = body?.outcome as DeliveryOutcome | undefined;
    const run = Number(body?.run);
    const outcomes = ['delivered', 'chat_only', 'uncertain', 'failed'];
    if (!outcome || !outcomes.includes(String(outcome.outcome)) || !Number.isInteger(run) || run < 1 || typeof body?.deliveryId !== 'string') {
      return failed(c, 422, 'INVALID_REPORT', 'A delivery report names its delivery, its run and an outcome');
    }
    const result = await finishWorkflowDelivery(taskId, String(body?.tenantId || ''), {
      deliveryId: body.deliveryId,
      approvalId: String(body?.approvalId || ''),
      run,
      outcome: {
        outcome: outcome.outcome,
        uncertain: Array.isArray(outcome.uncertain) ? outcome.uncertain.map(String).slice(0, 50) : [],
        sheetsConfirmed: outcome.sheetsConfirmed === true,
        archived: outcome.archived === true,
        filesSent: Number(outcome.filesSent) || 0,
        ...(outcome.reason ? { reason: String(outcome.reason).slice(0, 500) } : {}),
      },
    });
    if (!result.ok) return failed(c, result.status, result.code, result.message);
    return c.json({ status: result.status, taskState: result.taskState }, 200);
  });
}
