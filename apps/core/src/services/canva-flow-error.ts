export class CanvaFlowError extends Error {
  /** retryAfterMs: when a busy refusal expects the caller to find room, sent as Retry-After (ADR-131). */
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}
