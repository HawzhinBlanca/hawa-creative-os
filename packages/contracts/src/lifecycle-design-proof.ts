/** Canonical v1 scope for a worker proof on a request-owned Canva write. */
export function lifecycleDesignProofPayload(input: {
  taskId: string; requestId: string; runId: string; method: string; path: string;
}): string {
  return JSON.stringify(['hawa.lifecycle.design.v1', input.taskId, input.requestId, input.runId,
    input.method.toUpperCase(), input.path]);
}
