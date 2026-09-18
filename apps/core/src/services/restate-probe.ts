/**
 * Whether Restate can run a task: reachable, and holding the worker's services.
 *
 * Health used to report restate "connected" whenever RESTATE_INGRESS_URL was set, without asking
 * Restate anything. When its data volume was recreated on 2026-09-17, the worker's registration
 * went with it, and for 23 hours every task failed with "service 'TaskWorkflow' not found" while
 * health said connected. This asks Restate's admin API which services it holds.
 */
export type RestateStatus = 'connected' | 'unregistered' | 'unreachable' | 'unconfigured';

/** The services the worker registers; a task cannot run without both. */
export const REQUIRED_RESTATE_SERVICES = ['TaskWorkflow', 'TaskService'] as const;

/** The admin API: RESTATE_ADMIN_URL, else the ingress host on Restate's admin port. */
export function restateAdminUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RESTATE_ADMIN_URL) return env.RESTATE_ADMIN_URL.replace(/\/$/, '');
  if (!env.RESTATE_INGRESS_URL) return null;
  try {
    const url = new URL(env.RESTATE_INGRESS_URL);
    url.port = '9070';
    return url.origin;
  } catch {
    return null;
  }
}

export async function probeRestate(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2000
): Promise<{ status: RestateStatus; missing: string[] }> {
  if (!env.RESTATE_INGRESS_URL) return { status: 'unconfigured', missing: [] };
  const admin = restateAdminUrl(env);
  if (!admin) return { status: 'unreachable', missing: [...REQUIRED_RESTATE_SERVICES] };
  try {
    const res = await fetcher(`${admin}/services`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { status: 'unreachable', missing: [...REQUIRED_RESTATE_SERVICES] };
    const body = (await res.json()) as { services?: Array<{ name?: string }> };
    const names = new Set((body.services || []).map((s) => s.name));
    const missing = REQUIRED_RESTATE_SERVICES.filter((name) => !names.has(name));
    return { status: missing.length ? 'unregistered' : 'connected', missing };
  } catch {
    return { status: 'unreachable', missing: [...REQUIRED_RESTATE_SERVICES] };
  }
}
