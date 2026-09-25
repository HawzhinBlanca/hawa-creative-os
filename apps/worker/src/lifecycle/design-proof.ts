import { createHmac } from 'node:crypto';
import { lifecycleDesignProofPayload } from '@hawa/contracts';

/** Scoped to the exact Core write URL. The worker-only credential never crosses this boundary. */
export function lifecycleDesignProofHeaders(input: {
  taskId: string; requestId: string; runId: string; method: string; path: string;
}, secret: string | undefined = process.env.HAWA_WORKER_TOKEN): Record<string, string> {
  if (!secret || secret.length < 16) throw new Error('Lifecycle design proof requires the configured worker credential');
  const signature = createHmac('sha256', secret).update(lifecycleDesignProofPayload(input)).digest('hex');
  return {
    'X-Hawa-Lifecycle-Request-Id': input.requestId,
    'X-Hawa-Lifecycle-Run-Id': input.runId,
    'X-Hawa-Lifecycle-Proof': signature,
  };
}
