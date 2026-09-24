import { describe, it, expect, vi } from 'vitest';
import { LiveColourGate, runWhileLive, backgroundLoopsFromEnv } from '../src/live-colour.js';

/**
 * Blue/green worker deploys (architecture programme 0.1): two worker colours run while the old one
 * drains, and the outbox consumer must run in only one of them. Two consumers lease the same table
 * with SKIP LOCKED, which keeps a claim exclusive only for its 60 s lease: a batch that outlives it
 * is re-leased by the other colour and a Telegram delivery goes out twice. And the old colour runs
 * the old handlers against commands the new Core writes. The live colour is the one Restate sends
 * new TaskWorkflow invocations to.
 */
const ADMIN = 'http://restate:9070';
const BLUE = 'http://worker-blue:9080';
const GREEN = 'http://worker-green:9080';

/** A fake Restate admin API whose TaskWorkflow is served by the deployment at `live()`. */
function fakeRestate(live: () => string | null, opts: { down?: () => boolean; registered?: () => string[] } = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url);
    if (opts.down?.()) throw new TypeError('fetch failed');
    const uri = live();
    if (url === `${ADMIN}/services/TaskWorkflow`) {
      if (!uri) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      return Response.json({ name: 'TaskWorkflow', deployment_id: `dp_${uri.includes('blue') ? 'blue' : 'green'}` });
    }
    if (url === `${ADMIN}/deployments` && opts.registered) {
      return Response.json({ deployments: opts.registered().map((u, i) => ({ id: `dp_${i}`, uri: `${u}/` })) });
    }
    const m = /\/deployments\/(dp_\w+)$/.exec(url);
    if (m && uri) return Response.json({ id: m[1], uri: `${uri}/` });
    return new Response('', { status: 404 });
  });
  return { fetcher, calls };
}

describe('LiveColourGate: the live colour is the deployment Restate routes new work to', () => {
  it('is live when TaskWorkflow is served from its own address (Restate adds a trailing slash)', async () => {
    const { fetcher } = fakeRestate(() => BLUE);
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: BLUE, fetcher, now: () => t, takeoverMs: 0 });
    expect(await gate.isLive()).toBe(true);
    expect(gate.state()).toBe('live');
    const other = new LiveColourGate({ adminUrl: ADMIN, selfUri: GREEN, fetcher, now: () => t, takeoverMs: 0 });
    expect(await other.isLive()).toBe(false);
    expect(other.state()).toBe('standby');
  });

  it('asks Restate at most once per refresh interval', async () => {
    const { fetcher } = fakeRestate(() => BLUE);
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: BLUE, fetcher, now: () => t, refreshMs: 10_000, takeoverMs: 0 });
    await gate.isLive(); await gate.isLive(); await gate.isLive();
    expect(fetcher).toHaveBeenCalledTimes(2); // service, then its deployment
    t = 10_001;
    await gate.isLive();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('stops at once when a deploy registers the other colour', async () => {
    let live = BLUE;
    const { fetcher } = fakeRestate(() => live);
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: BLUE, fetcher, now: () => t, refreshMs: 1000, takeoverMs: 0 });
    expect(await gate.isLive()).toBe(true);
    live = GREEN;
    t = 1001;
    expect(await gate.isLive()).toBe(false);
  });

  it('takes over only after it has been the live colour for the whole takeover delay', async () => {
    // The old colour notices within one refresh and its last batch runs out within one lease; the new
    // colour waits for both before it leases anything.
    const { fetcher } = fakeRestate(() => GREEN);
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: GREEN, fetcher, now: () => t, refreshMs: 1000, takeoverMs: 70_000 });
    expect(await gate.isLive()).toBe(false);
    expect(gate.state()).toBe('taking_over');
    t = 69_999;
    expect(await gate.isLive()).toBe(false);
    t = 70_000;
    expect(await gate.isLive()).toBe(true);
  });

  it('waits out the takeover delay while Restate still holds another worker deployment', async () => {
    const { fetcher } = fakeRestate(() => GREEN, { registered: () => [BLUE, GREEN] });
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: GREEN, fetcher, now: () => t, refreshMs: 1000, takeoverMs: 70_000 });
    expect(await gate.isLive()).toBe(false);
    expect(gate.state()).toBe('taking_over');
    t = 70_000;
    expect(await gate.isLive()).toBe(true);
  });

  it('a restart of the live colour when it is the only deployment left starts its loops at once', async () => {
    // Otherwise every crash or restart of the live worker stopped the outbox for about 80 s.
    const { fetcher } = fakeRestate(() => GREEN, { registered: () => [GREEN] });
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: GREEN, fetcher, now: () => 5_000, refreshMs: 1000, takeoverMs: 70_000 });
    expect(await gate.isLive()).toBe(true);
    expect(gate.state()).toBe('live');
  });

  it('keeps the takeover delay when the list of deployments cannot be read', async () => {
    const { fetcher } = fakeRestate(() => GREEN); // no list: 404
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: GREEN, fetcher, now: () => 5_000, refreshMs: 1000, takeoverMs: 70_000 });
    expect(await gate.isLive()).toBe(false);
    expect(gate.state()).toBe('taking_over');
  });

  it('keeps its last answer while Restate does not answer, and starts as not live', async () => {
    let down = true;
    const { fetcher } = fakeRestate(() => BLUE, { down: () => down });
    let t = 0;
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: BLUE, fetcher, now: () => t, refreshMs: 1000, takeoverMs: 0 });
    expect(await gate.isLive()).toBe(false);
    expect(gate.state()).toBe('unknown');
    down = false; t = 1001;
    expect(await gate.isLive()).toBe(true);
    down = true; t = 2002;
    expect(await gate.isLive()).toBe(true);
  });

  it('is not live when no deployment serves TaskWorkflow yet', async () => {
    const { fetcher } = fakeRestate(() => null);
    const gate = new LiveColourGate({ adminUrl: ADMIN, selfUri: BLUE, fetcher, now: () => 0, takeoverMs: 0 });
    expect(await gate.isLive()).toBe(false);
    expect(gate.state()).toBe('standby');
  });
});

describe('runWhileLive: a background loop runs only in the live colour', () => {
  const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

  it('runs a batch on every turn while live, none while not, and resumes when live again', async () => {
    let live = true;
    const tick = vi.fn(async () => ({ leased: 0 }));
    const timers: Array<() => void> = [];
    const loop = runWhileLive({
      gate: { isLive: async () => live },
      tick,
      intervalMs: 1000,
      schedule: (fn) => { timers.push(fn); return 0 as any; },
      cancel: () => {},
    });
    const turn = async () => { const fn = timers.shift(); fn?.(); await flush(); };
    await turn();
    expect(tick).toHaveBeenCalledTimes(1);
    live = false;
    await turn(); await turn();
    expect(tick).toHaveBeenCalledTimes(1);
    live = true;
    await turn();
    expect(tick).toHaveBeenCalledTimes(2);
    loop.stop();
    await turn();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('never runs two batches at once, and a failed batch does not end the loop', async () => {
    let running = 0; let most = 0; let n = 0;
    const tick = vi.fn(async () => {
      running++; most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (++n === 1) throw new Error('database went away');
      return { leased: 0 };
    });
    const errors: unknown[] = [];
    const loop = runWhileLive({ gate: { isLive: async () => true }, tick, intervalMs: 1, onError: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 80));
    loop.stop();
    expect(most).toBe(1);
    expect(errors).toHaveLength(1);
    expect(tick.mock.calls.length).toBeGreaterThan(2);
  });
});

describe('backgroundLoopsFromEnv: which worker gates its loops', () => {
  it('gates on Restate only when the worker knows its own address', () => {
    expect(backgroundLoopsFromEnv({})).toEqual({ mode: 'always' });
    expect(backgroundLoopsFromEnv({ HAWA_WORKER_SELF_URI: BLUE, RESTATE_ADMIN_URL: `${ADMIN}/` })).toMatchObject({ mode: 'live-colour', selfUri: BLUE, adminUrl: ADMIN });
    expect(backgroundLoopsFromEnv({ HAWA_WORKER_SELF_URI: BLUE, RESTATE_INGRESS_URL: 'http://restate:8080' })).toMatchObject({ mode: 'live-colour', adminUrl: ADMIN });
    expect(backgroundLoopsFromEnv({ HAWA_WORKER_SELF_URI: BLUE, HAWA_WORKER_TAKEOVER_MS: '5000' })).toMatchObject({ mode: 'misconfigured' });
    expect((backgroundLoopsFromEnv({ HAWA_WORKER_SELF_URI: BLUE, RESTATE_ADMIN_URL: ADMIN, HAWA_WORKER_TAKEOVER_MS: '5000' }) as any).takeoverMs).toBe(5000);
  });
});
