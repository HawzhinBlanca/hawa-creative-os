import type { MiddlewareHandler } from 'hono';
import {
  acceptRequestId,
  createLogger,
  currentRequestId,
  newRequestId,
  runWithLogContext,
  REQUEST_ID_HEADER,
} from '@hawa/observability';
import { setTraceIdSource } from '@hawa/db';

export { bindLogContext, runWithLogContext, requestIdHeaders, getLogContext } from '@hawa/observability';

/** Core's logger: JSON lines on stdout, each carrying the current request's context. */
export const log = createLogger('core');

// Task events and outbox commands Core writes record the request that wrote them.
setTraceIdSource(currentRequestId);

const TASK_IN_PATH = /\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** Docker asks these every 10–15 s; a line for each would bury everything else. */
const QUIET_PATHS = new Set(['/ready', '/health', '/api/health', '/v1/health', '/api/v1/health']);

/**
 * Gives every HTTP request its log context. The id is the caller's `x-request-id` when it sent a
 * usable one (nginx sets it for every request from outside; the worker and the Telegram poller send
 * the one they are working under), otherwise a new one. It is sent back in the response, so an
 * operator holding a failed response can find its lines with scripts/request_logs.ts.
 *
 * A task id in the path is known from the start; the tenant is added once the request is
 * authenticated (registerRoute), and the chat when a Telegram update is read.
 */
export function requestLogContext(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = acceptRequestId(c.req.header(REQUEST_ID_HEADER)) ?? newRequestId();
    const taskId = TASK_IN_PATH.exec(c.req.path)?.[1];
    const started = performance.now();
    await runWithLogContext({ requestId, taskId }, async () => {
      await next();
      // A handler may return a Response whose headers cannot be changed (a proxied fetch).
      try { c.res.headers.set(REQUEST_ID_HEADER, requestId); } catch { /* immutable headers */ }
      const line = { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) };
      if (QUIET_PATHS.has(c.req.path)) log.debug(line, 'request');
      else log.info(line, 'request');
    });
  };
}
