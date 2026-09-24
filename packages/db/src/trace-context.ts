/**
 * Where the request id that task events and outbox commands carry comes from (architecture programme
 * 1.4). The database layer does not know about logging: Core and the worker each install a source
 * that reads their log context, and every event written inside a request records that request's id in
 * task_events.trace_id (a column that was always null), so an event leads to the log lines of the
 * request that wrote it (scripts/request_logs.ts <id>).
 *
 * An outbox command carries the id in its payload as `requestId`, which is how it reaches the worker
 * and, from there, Restate and the calls back to Core. A payload that names its own is left alone.
 */
let source: (() => string | null | undefined) | null = null;

export function setTraceIdSource(fn: (() => string | null | undefined) | null): void {
  source = fn;
}

/** The current request's id, or null outside one. A source that throws never fails a write. */
export function currentTraceId(): string | null {
  try {
    return source?.() || null;
  } catch {
    return null;
  }
}

export function withRequestId<T extends Record<string, unknown>>(payload: T): T {
  const id = currentTraceId();
  return id && payload.requestId === undefined ? { ...payload, requestId: id } : payload;
}
