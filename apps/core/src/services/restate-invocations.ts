/**
 * How much work Restate is holding back, for /health (architecture programme 0.1, risk 3).
 *
 * Restate retries a failing invocation with backoff for about an hour and then pauses it; a paused
 * invocation waits for a person and nothing announced it. This asks Restate's SQL introspection
 * (POST /query on the admin API) how many invocations are paused or backing off, and how deep the
 * inbox is (invocations queued behind a busy virtual object or workflow key).
 *
 * Docker polls /health every 10 s and the Desk polls it too, so the answer is cached for 10 s, one
 * question is asked at a time, and each query gives up after 1 s. Restate being down is reported
 * as "unknown" here and as unreachable by the registration probe; health never fails because of it.
 */
import { restateAdminUrl } from './restate-probe.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RestateInvocationCounts {
  status: 'ok' | 'unknown' | 'unconfigured';
  paused: number | null;
  backingOff: number | null;
  inbox: number | null;
  checkedAt: string;
}

export function createRestateInvocationProbe(options: {
  env?: NodeJS.ProcessEnv;
  fetcher?: FetchLike;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
} = {}): () => Promise<RestateInvocationCounts> {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const timeoutMs = Math.min(options.timeoutMs ?? 1000, 1000);
  const cacheMs = Math.min(options.cacheMs ?? 10_000, 10_000);
  let cached: { at: number; value: RestateInvocationCounts } | null = null;
  let pending: Promise<RestateInvocationCounts> | null = null;

  const query = async (admin: string, sql: string): Promise<Array<Record<string, unknown>>> => {
    const res = await (options.fetcher || fetch)(`${admin}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Restate /query answered ${res.status}`);
    const rows = ((await res.json()) as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) throw new Error('Restate /query answered without rows');
    return rows;
  };

  const ask = async (): Promise<RestateInvocationCounts> => {
    const checkedAt = new Date(now()).toISOString();
    const admin = env.RESTATE_INGRESS_URL ? restateAdminUrl(env) : null;
    if (!admin) return { status: 'unconfigured', paused: null, backingOff: null, inbox: null, checkedAt };
    try {
      const [statuses, inbox] = await Promise.all([
        query(admin, "SELECT status, count(*) AS n FROM sys_invocation WHERE status IN ('paused', 'backing-off') GROUP BY status"),
        query(admin, 'SELECT count(*) AS n FROM sys_inbox'),
      ]);
      const count = (status: string) => Number(statuses.find((r) => r.status === status)?.n ?? 0);
      const depth = Number(inbox[0]?.n);
      if (![count('paused'), count('backing-off'), depth].every(Number.isFinite)) throw new Error('unreadable counts');
      return { status: 'ok', paused: count('paused'), backingOff: count('backing-off'), inbox: depth, checkedAt };
    } catch {
      return { status: 'unknown', paused: null, backingOff: null, inbox: null, checkedAt };
    }
  };

  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    pending ??= ask().then((value) => {
      cached = { at: now(), value };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}
