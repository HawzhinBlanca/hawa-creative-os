import { log } from '../logging.js';

/**
 * The worker's credential for Core's /v1/internal/* (Phase 2.1), and the secret Core signs what the
 * worker verifies with. Moved here from routes/lifecycle-internal.routes.ts (which re-exports it) so
 * that services can sign without importing a route module (ADR-129).
 */

/** Keys the worker token must differ from: one of them would turn it into a second use of that key. */
// HAWA_DEV_TOKEN too: POST /auth/session turns it into an operator session (ADR-128).
const OTHER_KEYS = ['HAWA_API_KEY', 'HAWA_BEARER_TOKEN', 'HAWA_DESK_SECRET', 'HAWA_DEV_TOKEN', 'HAWA_ADMIN_KEY', 'HAWA_REVIEWER_KEY', 'HAWA_ART_DIRECTOR_KEY', 'TELEGRAM_WEBHOOK_SECRET'] as const;
const MIN_TOKEN_LENGTH = 16;
let warnedAbout = '';

/**
 * HAWA_WORKER_TOKEN when it can be used: set, at least 16 characters, and equal to no other key Core
 * accepts. A worker token that is also the operator's key would make the operator a service and the
 * worker an operator; it is refused (and said once in the log), so /v1/internal/* stays closed.
 */
export function serviceTokenOf(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.HAWA_WORKER_TOKEN?.trim();
  if (!token) return null;
  let fault = '';
  if (token.length < MIN_TOKEN_LENGTH) fault = `is shorter than ${MIN_TOKEN_LENGTH} characters`;
  const clash = OTHER_KEYS.find((k) => env[k]?.trim() === token);
  if (clash) fault = `is the same as ${clash}`;
  if (!fault) return token;
  if (warnedAbout !== fault) {
    warnedAbout = fault;
    log.error(`[core:internal] HAWA_WORKER_TOKEN ${fault}; /v1/internal/* refuses every caller until it is a key of its own`);
  }
  return null;
}

let warnedAboutPrevious = '';

/**
 * HAWA_WORKER_TOKEN_PREVIOUS while a rotation is under way (ADR-129, Phase 4 operations finding 4): a
 * colour still draining keeps the token it was created with. Usable under the same rules as the
 * current token, and only beside a usable current one; equal to it, it adds nothing.
 */
function previousServiceTokenOf(env: Record<string, string | undefined>, current: string): string | null {
  const token = env.HAWA_WORKER_TOKEN_PREVIOUS?.trim();
  if (!token || token === current) return null;
  let fault = '';
  if (token.length < MIN_TOKEN_LENGTH) fault = `is shorter than ${MIN_TOKEN_LENGTH} characters`;
  const clash = OTHER_KEYS.find((k) => env[k]?.trim() === token);
  if (clash) fault = `is the same as ${clash}`;
  if (!fault) return token;
  if (warnedAboutPrevious !== fault) {
    warnedAboutPrevious = fault;
    log.error(`[core:internal] HAWA_WORKER_TOKEN_PREVIOUS ${fault}; it is ignored`);
  }
  return null;
}

/** Every worker credential /v1/internal/* accepts: the current one, and the previous one during a rotation. */
export function acceptedServiceTokensOf(env: Record<string, string | undefined> = process.env): string[] {
  const current = serviceTokenOf(env);
  if (!current) return [];
  const previous = previousServiceTokenOf(env, current);
  return previous ? [current, previous] : [current];
}

/**
 * The secret Core signs what the worker verifies with (office decisions, native reviews, delivery
 * claims). During a rotation it is the previous token: the colour still running the old value, which
 * is also the one Restate routes new work to until the new colour is registered, can verify it, and a
 * colour started during the rotation accepts both (apps/worker/src/lifecycle/worker-secrets.ts).
 */
export function workerSigningSecretOf(env: Record<string, string | undefined> = process.env): string | null {
  const current = env.HAWA_WORKER_TOKEN?.trim() || '';
  if (!current) return null;
  return previousServiceTokenOf(env, current) ?? current;
}
