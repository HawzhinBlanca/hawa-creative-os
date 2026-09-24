import {
  acceptRequestId,
  createLogger,
  currentRequestId,
  runWithLogContext,
  REQUEST_ID_HEADER,
  type LogContext,
} from '@hawa/observability';
import { setTraceIdSource } from '@hawa/db';

export { bindLogContext, runWithLogContext, requestIdHeaders, getLogContext } from '@hawa/observability';

/** The worker's logger: JSON lines on stdout, each carrying the current invocation's context. */
export const log = createLogger('worker');

// Outcomes and commands the worker writes itself record the request they belong to.
setTraceIdSource(currentRequestId);

/** What a handler receives that can name its request. */
export interface InvocationFields {
  taskId?: string;
  tenantId?: string;
  requestId?: string;
}

/** The part of a Restate context this needs; tests pass a plain object. */
export interface InvocationRequestSource {
  request(): { id: string; headers: ReadonlyMap<string, string> };
}

function headerOf(headers: ReadonlyMap<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers.get(name);
  if (direct !== undefined) return direct;
  for (const [key, value] of headers) if (key.toLowerCase() === name) return value;
  return undefined;
}

/**
 * The log context of one Restate invocation. The request id is the `x-request-id` the invocation was
 * started with (the outbox dispatcher sends the one Core wrote with the command), else the one in its
 * input, else the invocation's own id, which Restate keeps across retries and replays.
 */
export function invocationLogContext(ctx: InvocationRequestSource, input: InvocationFields | undefined): LogContext {
  let request: { id: string; headers: ReadonlyMap<string, string> } | undefined;
  try { request = ctx.request(); } catch { request = undefined; }
  const requestId = acceptRequestId(headerOf(request?.headers, REQUEST_ID_HEADER))
    ?? acceptRequestId(input?.requestId)
    ?? (request?.id ? `restate-${request.id}` : undefined);
  return { requestId, taskId: input?.taskId, tenantId: input?.tenantId };
}

/** Runs a Restate handler's body inside its invocation's log context. Call it at every handler entry. */
export function withInvocationLogContext<T>(ctx: InvocationRequestSource, input: InvocationFields | undefined, fn: () => Promise<T>): Promise<T> {
  return runWithLogContext(invocationLogContext(ctx, input), fn);
}

/**
 * The log context of one outbox command: the request that wrote it (Core puts its id in the payload),
 * or the command itself for one written before requests had ids.
 */
export function outboxLogContext(claim: { id: string; tenant_id: string; aggregate_type: string; aggregate_id: string; payload?: unknown }): LogContext {
  const payload = (claim.payload && typeof claim.payload === 'object' ? claim.payload : {}) as Record<string, unknown>;
  const chat = payload.sourceChannelId ?? payload.chatId;
  return {
    requestId: acceptRequestId(typeof payload.requestId === 'string' ? payload.requestId : undefined) ?? `outbox-${claim.id}`,
    taskId: claim.aggregate_type === 'task' ? claim.aggregate_id : undefined,
    tenantId: claim.tenant_id,
    chatId: typeof chat === 'string' || typeof chat === 'number' ? String(chat) : undefined,
  };
}
