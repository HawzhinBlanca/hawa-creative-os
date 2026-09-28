import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { RouteContext } from './types.js';
import { isValidUuid } from '../core-helpers.js';
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
 * The workflow reports to RequestLifecycle, which applies one versioned Core projection. The report
 * to Core (POST /v1/internal/tasks/:taskId/delivery-finished, for tasks RequestLifecycle did not own)
 * was removed by stage 2 of ADR-135.
 *
 * They are registered straight on the app, not through registerRoute, because they take one
 * credential only: the worker's own HAWA_WORKER_TOKEN, a service principal (PHASE2_DESIGN.md 1.2
 * finding 3). The operator, Desk and API tokens all open registerRoute's guard, and none of them may
 * reach these. verifyRequestAuth maps that token to role 'service' on /v1/internal/* only, and this
 * module accepts that role and nothing else.
 */
export function registerDeliveryInternalRoutes(ctx: RouteContext): void {
  const { app, problem, readCurrentTask, verifyRequestAuth } = ctx;
  const { prepareWorkflowDelivery } = ctx.delivery;

  // Only verifyRequestAuth decides (ADR-128). On /v1/internal/* it accepts HAWA_WORKER_TOKEN alone and
  // only through serviceTokenOf, which refuses a token shorter than 16 characters or equal to another
  // key. This check used to compare the raw variable itself, so a worker token equal to the operator
  // key let the operator key report a delivery or start one, while intake refused it.
  const isWorker = (c: Context): boolean => {
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
    const requestId = c.req.param('requestId') || '';
    // Stage 2 of ADR-135: only a request RequestLifecycle owns is delivered by the workflow.
    if (!task.requestId) return failed(c, 409, 'LEGACY_WORKFLOW_DELIVERY_RETIRED', 'The Delivery workflow delivers only requests RequestLifecycle owns');
    if (requestId !== task.requestId || !Number.isInteger(body?.requestRev) ||
        !Number.isInteger(body?.run) || typeof body?.deliveryId !== 'string') {
      return failed(c, 409, 'LIFECYCLE_DELIVERY_NOT_CURRENT', 'The workflow input does not match this task\'s owner');
    }

    const result = await prepareWorkflowDelivery(taskId, {
      tenantId,
      approvalId,
      revisionId: typeof body?.revisionId === 'string' ? body.revisionId : undefined,
      policy: typeof body?.policy === 'string' ? body.policy : undefined,
      lifecycle: { requestId, requestRev: Number(body.requestRev), deliveryId: String(body.deliveryId), run: Number(body.run) },
    });
    if (result?.ok && result.prepared) return c.json(result.prepared, 200);
    const status = Number(result?.status) || 500;
    // Another delivery of the task holds the publish lock for the moment: the workflow asks again.
    const code = String(result?.code || (status === 404 ? 'TASK_NOT_FOUND' : status === 422 ? 'NOTHING_TO_DELIVER' : 'PREPARE_FAILED'));
    const retryable = status >= 500 || code === 'PUBLICATION_IN_PROGRESS';
    log.warn(`[core:delivery-internal] prepare of task ${taskId} answered ${status} ${code}: ${result?.message || ''}`);
    return failed(c, retryable ? 503 : status, code, String(result?.message || code));
  });
}
