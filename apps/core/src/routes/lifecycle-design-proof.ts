/** Guard every Canva/Studio write for a Restate-owned task before provider or database effects. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lifecycleDesignProofPayload } from '@hawa/contracts';
import { withRlsContext } from '@hawa/db';
import type { AuthContext, RouteContext } from './types.js';
import { serviceTokenOf } from './lifecycle-internal.routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export async function rejectUnownedLifecycleDesignWrite(
  ctx: RouteContext, c: any, auth: AuthContext,
): Promise<Response | null> {
  const taskId = c.req.param('taskId');
  if (c.req.method !== 'POST' || !taskId || !UUID.test(taskId)) return null;
  const path = String(c.req.path || '');
  const taskPath = path.slice(path.indexOf('/tasks/'));
  if (!taskPath.startsWith(`/tasks/${taskId}/canva/`) &&
      taskPath !== `/tasks/${taskId}/canva-binding`) return null;
  if (!ctx.db || !auth.tenantId || !auth.userId) return ctx.problem(c, 503, 'Database Required');
  const owner = await withRlsContext(ctx.db, {
    tenantId: auth.tenantId, userId: auth.userId, role: auth.role || 'operator',
  }, async (trx) => {
    const task = await trx.selectFrom('tasks').select('request_id')
      .where('tenant_id', '=', auth.tenantId!).where('id', '=', taskId).executeTakeFirst();
    if (!task?.request_id) return { requestId: null, request: null };
    const request = await trx.selectFrom('requests').select(['owner', 'stage', 'current_task_id'])
      .where('tenant_id', '=', auth.tenantId!).where('request_id', '=', task.request_id).executeTakeFirst();
    return { requestId: task.request_id, request };
  });
  if (!owner.requestId) return null;
  const requestId = c.req.header('X-Hawa-Lifecycle-Request-Id') || '';
  const runId = c.req.header('X-Hawa-Lifecycle-Run-Id') || '';
  const proof = c.req.header('X-Hawa-Lifecycle-Proof') || '';
  const secret = serviceTokenOf();
  const shapeOkay = requestId === owner.requestId && UUID.test(requestId) &&
    (runId === `dr-${taskId}` || new RegExp(`^dr-${taskId}-a[1-9][0-9]*$`).test(runId)) &&
    SHA256.test(proof) && owner.request?.owner === 'restate' &&
    owner.request.stage === 'designing' && owner.request.current_task_id === taskId;
  if (shapeOkay && secret) {
    const expected = createHmac('sha256', secret).update(lifecycleDesignProofPayload({
      taskId, requestId, runId, method: 'POST', path,
    })).digest();
    const actual = Buffer.from(proof, 'hex');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return null;
  }
  return ctx.problem(c, 409, 'LIFECYCLE_OWNED',
    'This task is owned by RequestLifecycle; its design writes require the current worker run');
}
