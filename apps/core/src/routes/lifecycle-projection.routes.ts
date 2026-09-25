/**
 * The request lifecycle's projection endpoints (architecture programme Phase 2, slice 2.3;
 * PHASE2_DESIGN.md section 2.8, ADR-034). Only the worker's RequestLifecycle object calls them:
 *
 *   POST /v1/internal/lifecycle/:requestId/project  {v, expectedRev, rev, key, tenantId, stage?, ops}
 *        200 {v, status: 'applied' | 'replayed', rev, stage, results}
 *        409 {code: 'AHEAD' | 'STALE_REVISION' | 'KEY_REUSED', pgRev, expectedRev, rev}
 *        404 REQUEST_NOT_FOUND, 422 (a malformed projection or an op this Core cannot do), 503 DATABASE_UNAVAILABLE
 *   GET  /v1/internal/lifecycle/:requestId?tenantId=…   the request as Postgres has it, for reconciliation
 *
 * The work is in services/lifecycle-projection.ts; this module only authenticates, reads the body and
 * answers. The worker treats a 409 as final: AHEAD makes it take Postgres's revision (the object was
 * restored), STALE_REVISION pauses it for a person. A 503 is asked again.
 *
 * Only HAWA_WORKER_TOKEN opens /v1/internal/*: a `service` principal in app.ts's verifyRequestAuth,
 * and the only credential these routes accept. Postgres only: no memory map of Core is read here.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { chaosPoint } from '@hawa/observability';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import { applyProjection, readLifecycleRecord, readProjectionRequest } from '../services/lifecycle-projection.js';
import type { RouteContext } from './types.js';

export function registerLifecycleProjectionRoutes(ctx: RouteContext): void {
  const { app, db, problem, verifyRequestAuth, broadcastEvent, broadcastTransition } = ctx;

  const isWorker = (c: Context): boolean => {
    const auth = verifyRequestAuth(c);
    return auth.authenticated && auth.role === 'service';
  };
  const refuse = (c: Context) => problem(c, 401, 'Authentication Required', 'This route takes the worker\'s credential only');
  /** A problem the worker can act on by its code. */
  const failed = (c: Context, status: number, code: string, detail: string, extra: Record<string, unknown> = {}) =>
    c.json({ type: `https://hawa.design/errors/${status}`, title: code, status, code, detail, instance: c.req.url, ...extra }, status as ContentfulStatusCode);

  app.post('/v1/internal/lifecycle/:requestId/project', async (c: Context) => {
    if (!isWorker(c)) return refuse(c);
    const requestId = c.req.param('requestId') || '';
    const raw = await c.req.json().catch(() => null);
    const read = readProjectionRequest(requestId, raw);
    if (!read.ok) return failed(c, 422, 'INVALID_PROJECTION', read.message);
    if (!db) return failed(c, 503, 'DATABASE_UNAVAILABLE', 'Core has no database to project into');
    const body = read.body;

    const answer = await applyProjection(db, requestId, body);
    if (!answer.ok) {
      if (answer.status >= 500 || answer.status === 409) log.warn(`[core:lifecycle] projection ${body.key} answered ${answer.status} ${answer.code}: ${answer.message}`);
      return failed(c, answer.status, answer.code, answer.message, answer.conflict ? { ...answer.conflict } : {});
    }
    const { response } = answer;
    if (response.status === 'applied') {
      // Committed; the answer has not left yet (chaos suite point: a Core killed here must answer the
      // worker's retry from the projection's record, and write nothing twice).
      await chaosPoint('core.project.after-commit', { requestId, rev: body.rev, key: body.key });
      for (const taskId of answer.createdTaskIds) broadcastEvent('task:created', { id: taskId, taskId, requestId });
      for (const m of answer.moves) broadcastTransition(m.taskId, m.from, m.to, m.version);
    }
    return c.json(response, 200);
  });

  app.get('/v1/internal/lifecycle/:requestId', async (c: Context) => {
    if (!isWorker(c)) return refuse(c);
    const requestId = c.req.param('requestId') || '';
    const tenantId = c.req.query('tenantId') || '';
    if (!isValidUuid(requestId) || !isValidUuid(tenantId)) return failed(c, 422, 'INVALID_REQUEST', 'Name the request and its tenant (?tenantId=), each by id');
    if (!db) return failed(c, 503, 'DATABASE_UNAVAILABLE', 'Core has no database to read');
    try {
      const record = await readLifecycleRecord(db, requestId, tenantId);
      if (!record) return failed(c, 404, 'REQUEST_NOT_FOUND', `Request ${requestId} is not open in tenant ${tenantId}`);
      return c.json(record, 200);
    } catch (err) {
      log.warn(`[core:lifecycle] reading request ${requestId} failed:`, err instanceof Error ? err.message : err);
      return failed(c, 503, 'DATABASE_UNAVAILABLE', 'The request could not be read; ask again');
    }
  });
}
