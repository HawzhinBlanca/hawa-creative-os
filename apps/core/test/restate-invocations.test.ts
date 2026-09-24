import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRestateInvocationProbe } from '../src/services/restate-invocations.js';
import { createApp } from '../src/app.js';

/**
 * Silent pauses (architecture programme risk 3): Restate retries a failing invocation for about an
 * hour and then pauses it, and nothing said so. Health now reports paused and backing-off
 * invocations and the inbox depth from Restate's SQL introspection, within 1 s, cached for 10 s,
 * and "unknown" (never a failure) when Restate does not answer.
 */
const env = { RESTATE_INGRESS_URL: 'http://restate:8080' } as NodeJS.ProcessEnv;

/** A fake Restate /query endpoint answering like Restate 1.7.10 (rows of {status, n}; sys_inbox count). */
function fakeRestate(statuses: Record<string, number>, inbox: number) {
  const queries: string[] = [];
  const fetcher = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('http://restate:9070/query');
    expect(init.method).toBe('POST');
    const query: string = JSON.parse(init.body).query;
    queries.push(query);
    if (/sys_inbox/.test(query)) return Response.json({ rows: [{ n: inbox }] });
    return Response.json({ rows: Object.entries(statuses).map(([status, n]) => ({ status, n })) });
  });
  return { fetcher, queries };
}

describe('Restate invocation counts for health', () => {
  it('reports paused and backing-off invocations and the inbox depth', async () => {
    const { fetcher } = fakeRestate({ paused: 2, 'backing-off': 3 }, 4);
    const probe = createRestateInvocationProbe({ env, fetcher: fetcher as any, now: () => 0 });
    expect(await probe()).toMatchObject({ status: 'ok', paused: 2, backingOff: 3, inbox: 4 });
  });

  it('counts nothing as zero, not as unknown', async () => {
    const { fetcher } = fakeRestate({}, 0);
    const probe = createRestateInvocationProbe({ env, fetcher: fetcher as any, now: () => 0 });
    expect(await probe()).toMatchObject({ status: 'ok', paused: 0, backingOff: 0, inbox: 0 });
  });

  it('asks Restate at most once per 10 s, and one question at a time', async () => {
    const { fetcher } = fakeRestate({ paused: 1 }, 0);
    let t = 0;
    const probe = createRestateInvocationProbe({ env, fetcher: fetcher as any, now: () => t });
    await Promise.all([probe(), probe(), probe()]);
    await probe();
    const calls = fetcher.mock.calls.length;
    expect(calls).toBe(2); // one status query and one inbox query
    t = 9_999; await probe();
    expect(fetcher.mock.calls.length).toBe(calls);
    t = 10_001; await probe();
    expect(fetcher.mock.calls.length).toBe(calls * 2);
  });

  it('says unknown, within about a second, when Restate does not answer', async () => {
    const hung = vi.fn((_url: string, init: any) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const probe = createRestateInvocationProbe({ env, fetcher: hung as any });
    const started = Date.now();
    const result = await probe();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ status: 'unknown', paused: null, backingOff: null, inbox: null });
  });

  it('says unknown when Restate refuses or answers something unreadable', async () => {
    const refused = createRestateInvocationProbe({ env, fetcher: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any });
    expect((await refused()).status).toBe('unknown');
    const odd = createRestateInvocationProbe({ env, fetcher: vi.fn(async () => Response.json({ nope: true })) as any });
    expect((await odd()).status).toBe('unknown');
    const failing = createRestateInvocationProbe({ env, fetcher: vi.fn(async () => new Response('', { status: 500 })) as any });
    expect((await failing()).status).toBe('unknown');
  });

  it('asks nothing without Restate', async () => {
    const fetcher = vi.fn();
    const probe = createRestateInvocationProbe({ env: {}, fetcher: fetcher as any });
    expect(await probe()).toMatchObject({ status: 'unconfigured', paused: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('/health and /ready', () => {
  const savedFetch = globalThis.fetch;
  const savedIngress = process.env.RESTATE_INGRESS_URL;
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedIngress === undefined) delete process.env.RESTATE_INGRESS_URL; else process.env.RESTATE_INGRESS_URL = savedIngress;
  });

  it('/health reports Restate\'s paused invocations and is degraded while any is paused', async () => {
    process.env.RESTATE_INGRESS_URL = 'http://restate:8080';
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url === 'http://restate:9070/services') return Response.json({ services: [{ name: 'TaskWorkflow' }, { name: 'TaskService' }] });
      if (url === 'http://restate:9070/query') {
        const query: string = JSON.parse(init.body).query;
        return /sys_inbox/.test(query) ? Response.json({ rows: [{ n: 1 }] }) : Response.json({ rows: [{ status: 'paused', n: 2 }, { status: 'backing-off', n: 1 }] });
      }
      return new Response('', { status: 404 });
    }) as any;
    const res = await createApp({ db: null as any }).request('/health');
    const body: any = await res.json();
    expect(body.restateInvocations).toMatchObject({ status: 'ok', paused: 2, backingOff: 1, inbox: 1 });
    expect(body.dependencies.restatePausedInvocations).toBe(2);
    expect(body.status).not.toBe('healthy');
  });

  it('/health says unknown, and still answers, while Restate is down', async () => {
    process.env.RESTATE_INGRESS_URL = 'http://restate:8080';
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any;
    const res = await createApp({ db: null as any }).request('/health');
    const body: any = await res.json();
    expect(body.restateInvocations.status).toBe('unknown');
    expect(body.dependencies.restatePausedInvocations).toBe('unknown');
  });

  it('/ready is a liveness check: no call leaves the process, at most one database ping', async () => {
    process.env.RESTATE_INGRESS_URL = 'http://restate:8080';
    const outbound = vi.fn(async () => new Response('{}'));
    globalThis.fetch = outbound as any;
    const executeQuery = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    const db = { getExecutor: () => ({ executeQuery, transformQuery: (n: unknown) => n, compileQuery: () => ({ sql: 'SELECT 1', parameters: [] }), adapter: {} }) };
    const app = createApp({ db: db as any, skipPaidModelProbe: true, skipTelegramProbe: true } as any);
    executeQuery.mockClear(); outbound.mockClear();
    for (const path of ['/ready', '/v1/ready']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ready', postgres: 'connected' });
    }
    expect(outbound).not.toHaveBeenCalled();
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it('/ready answers 503 when the database does not answer', async () => {
    const executeQuery = vi.fn(async () => { throw new Error('connection refused'); });
    const db = { getExecutor: () => ({ executeQuery, transformQuery: (n: unknown) => n, compileQuery: () => ({ sql: 'SELECT 1', parameters: [] }), adapter: {} }) };
    const res = await createApp({ db: db as any } as any).request('/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', postgres: 'disconnected' });
  });

  it('/ready answers 503 for a Core without a database: its state would live in memory only', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await createApp({ db: null as any }).request('/ready');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: 'not_ready', postgres: 'uninitialized' });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
