import { describe, it, expect, vi } from 'vitest';
import { probeRestate, restateAdminUrl } from '../src/services/restate-probe.js';

describe('Restate health: registered services, not a configured URL', () => {
  const env = { RESTATE_INGRESS_URL: 'http://restate:8080' } as NodeJS.ProcessEnv;
  const answering = (services: string[]) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ services: services.map((name) => ({ name })) }) });

  it('asks the admin API on the ingress host, unless told where it is', () => {
    expect(restateAdminUrl(env)).toBe('http://restate:9070');
    expect(restateAdminUrl({ ...env, RESTATE_ADMIN_URL: 'http://admin:1234/' })).toBe('http://admin:1234');
    expect(restateAdminUrl({})).toBeNull();
  });

  it('is connected only when both of the worker\'s services are registered', async () => {
    const fetcher = answering(['TaskWorkflow', 'TaskService']);
    expect(await probeRestate(env, fetcher as any)).toEqual({ status: 'connected', missing: [] });
    expect(fetcher).toHaveBeenCalledWith('http://restate:9070/services', expect.anything());
  });

  it('reports unregistered for a Restate that has lost its registrations', async () => {
    // Production, 2026-09-17 to 2026-09-18: a recreated volume, no deployments, health "connected".
    expect(await probeRestate(env, answering([]) as any)).toEqual({
      status: 'unregistered',
      missing: ['TaskWorkflow', 'TaskService'],
    });
    expect((await probeRestate(env, answering(['TaskService']) as any)).missing).toEqual(['TaskWorkflow']);
  });

  it('reports unreachable when the admin API fails or does not answer, and unconfigured without Restate', async () => {
    expect((await probeRestate(env, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any)).status).toBe('unreachable');
    expect((await probeRestate(env, vi.fn().mockResolvedValue({ ok: false }) as any)).status).toBe('unreachable');
    expect((await probeRestate({}, vi.fn() as any)).status).toBe('unconfigured');
  });
});
