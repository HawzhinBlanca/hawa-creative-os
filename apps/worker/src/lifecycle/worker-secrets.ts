/**
 * The values this worker accepts for what Core signs with the worker credential (ADR-129, Phase 4
 * operations finding 4). HAWA_WORKER_TOKEN first; during a rotation also HAWA_WORKER_TOKEN_PREVIOUS,
 * which Core signs with until the colour holding the old value has drained, and which also verifies a
 * claim Core signed before the rotation when it is replayed. The worker still calls Core with
 * HAWA_WORKER_TOKEN only. A previous value shorter than 16 characters is ignored, as Core ignores it.
 */
const MIN_PREVIOUS_LENGTH = 16;

export function acceptedWorkerSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const current = env.HAWA_WORKER_TOKEN?.trim() || '';
  const previous = env.HAWA_WORKER_TOKEN_PREVIOUS?.trim() || '';
  if (!current) return [];
  return previous.length >= MIN_PREVIOUS_LENGTH && previous !== current ? [current, previous] : [current];
}
