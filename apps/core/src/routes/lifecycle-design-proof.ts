/** Guard direct task and Canva writes against a persisted RequestLifecycle owner. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lifecycleDesignProofPayload, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { withRlsContext } from '@hawa/db';
import type { AuthContext, RouteContext } from './types.js';
import { serviceTokenOf } from './lifecycle-internal.routes.js';
import { isServiceUserId } from '@hawa/contracts';
import { NATIVE_RECOVERY_ROLES, type NativeRecoveryScope } from '@hawa/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export function nativeRecoveryHeaders(c: { req: { header(name: string): string | undefined } }): NativeRecoveryScope | undefined {
  const requestId = c.req.header('X-Hawa-Manual-Request-Id') || '';
  const revision = c.req.header('X-Hawa-Manual-Request-Rev') || '';
  const rev = Number(revision);
  return UUID.test(requestId) && /^[1-9][0-9]*$/.test(revision) && Number.isSafeInteger(rev) && rev >= 2
    ? { requestId, rev } : undefined;
}

async function persistedOwner(ctx: RouteContext, auth: AuthContext, taskId: string) {
  return withRlsContext(ctx.db!, {
    tenantId: auth.tenantId!, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator',
  }, async (trx) => {
    const task = await trx.selectFrom('tasks').select('request_id')
      .where('tenant_id', '=', auth.tenantId!).where('id', '=', taskId).executeTakeFirst();
    if (!task?.request_id) return { requestId: null, request: null };
    const request = await trx.selectFrom('requests').select(['owner', 'stage', 'current_task_id', 'rev'])
      .where('tenant_id', '=', auth.tenantId!).where('request_id', '=', task.request_id).executeTakeFirst();
    return { requestId: task.request_id, request };
  });
}

/** Legacy task controls and design endpoints never start a request-owned run. A manual revision is office recovery. */
export async function rejectLegacyTaskDesignWrite(
  ctx: RouteContext, c: any, auth: AuthContext, allowManualRevision = false,
): Promise<Response | null> {
  const taskId = c.req.param('taskId');
  if (!ctx.db || !taskId || !UUID.test(taskId)) return null;
  if (!auth.tenantId || !auth.userId) return ctx.problem(c, 503, 'Database Required');
  let owner: Awaited<ReturnType<typeof persistedOwner>>;
  try { owner = await persistedOwner(ctx, auth, taskId); }
  catch { return ctx.problem(c, 503, 'Durable Storage Unavailable', 'Task could not be read from the database; try again'); }
  if (!owner.requestId) return null;
  if (allowManualRevision && owner.request?.owner === 'restate' &&
      owner.request.stage === 'manual' && owner.request.current_task_id === taskId) {
    if (['administrator', 'art_director', 'creative_director', 'operator', 'designer']
      .includes(auth.role || '')) return null;
    return ctx.problem(c, 403, 'Manual Revision Forbidden', 'An office designer or operator is required');
  }
  return ctx.problem(c, 409, 'LIFECYCLE_OWNED',
    'RequestLifecycle owns this task; use its current request and office action');
}

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
  let owner: Awaited<ReturnType<typeof persistedOwner>>;
  try { owner = await persistedOwner(ctx, auth, taskId); }
  catch { return ctx.problem(c, 503, 'Durable Storage Unavailable', 'Task could not be read from the database; try again'); }
  if (!owner.requestId) return null;
  const manual = nativeRecoveryHeaders(c);
  const manualPath = taskPath === `/tasks/${taskId}/canva-binding` ||
    taskPath === `/tasks/${taskId}/canva/revision-copy` || taskPath === `/tasks/${taskId}/canva/exports` ||
    new RegExp(`^/tasks/${taskId}/canva/exports/[0-9a-f-]{36}/resume$`, 'i').test(taskPath);
  if (manualPath && manual?.requestId === owner.requestId && manual.rev === Number(owner.request?.rev) &&
      owner.request?.owner === 'restate' && owner.request.stage === 'manual' && owner.request.current_task_id === taskId &&
      auth.userId && !isServiceUserId(auth.userId) && NATIVE_RECOVERY_ROLES.some(role => role === auth.role)) return null;
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
