import { describe, it, expect } from 'vitest';
import {
  RestateAdmin,
  readTopology,
  planDeploy,
  finishDrains,
  registerColour,
  containerFetch,
  runCli,
  DEFAULT_WORKER_ADDRESSES,
} from '../../../scripts/restate-bluegreen.js';

/**
 * Blue/green worker deploys (architecture programme 0.1, ADR-034). deploy.sh re-registered the worker
 * at the same address on every deploy with a force:true fallback, so in-flight journals replayed on
 * new code (Restate's RT0016). These tests drive the decision logic deploy.sh calls against a fake
 * Restate admin API that behaves as Restate 1.7.10 did on 2026-09-24 (scratch server): 201 for a new
 * deployment, 200 and no change for an address it already holds (force:false never replaces
 * handlers), 500 META0003 for an address it cannot reach, 501 for a delete without force, 202 for a
 * forced delete, and {"rows":[…]} from POST /query.
 */
const ADMIN = 'http://restate:9070';
const { blue: BLUE, green: GREEN, legacy: LEGACY } = DEFAULT_WORKER_ADDRESSES;

interface FakeDeployment { id: string; uri: string }
interface FakeInvocation { pinned: string | null; status: string }

class FakeRestate {
  deployments: FakeDeployment[] = [];
  serving: string | null = null; // deployment id TaskWorkflow and TaskService route to
  /** A service routed somewhere other than `serving` (a build that did not host it, say). */
  routedElsewhere: Record<string, string> = {};
  failServiceLists = false;
  invocations: FakeInvocation[] = [];
  unreachable = new Set<string>();
  refuse: { status: number; message: string } | null = null;
  posts: any[] = [];
  deletes: string[] = [];
  queries = 0;
  private next = 1;

  constructor(initial: Array<{ uri: string; live?: boolean }> = []) {
    for (const d of initial) {
      const id = `dp_${this.next++}`;
      this.deployments.push({ id, uri: d.uri });
      if (d.live) this.serving = id;
    }
  }

  idOf(uri: string) { return this.deployments.find((d) => d.uri === uri)?.id; }
  route(name: string): string | null { return this.routedElsewhere[name] ?? this.serving; }

  fetch = async (url: string, init: any = {}): Promise<Response> => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    if (u.origin !== ADMIN) throw new TypeError('fetch failed');
    const path = u.pathname;
    if (method === 'GET' && path === '/deployments') {
      return Response.json({ deployments: this.deployments.map((d) => ({ id: d.id, uri: `${d.uri}/`, created_at: '2026-09-24T00:00:00Z', services: [] })) });
    }
    let m = /^\/deployments\/([\w]+)$/.exec(path);
    if (method === 'GET' && m) {
      const d = this.deployments.find((x) => x.id === m![1]);
      return d ? Response.json({ id: d.id, uri: `${d.uri}/` }) : new Response('', { status: 404 });
    }
    if (method === 'GET' && path === '/services') {
      if (this.failServiceLists) return new Response('', { status: 503 });
      return Response.json({ services: ['TaskWorkflow', 'TaskService'].map((name) => ({ name, deployment_id: this.route(name) })).filter((x) => x.deployment_id) });
    }
    m = /^\/services\/(\w+)$/.exec(path);
    if (method === 'GET' && m) {
      const id = this.route(m[1]);
      return id ? Response.json({ name: m[1], deployment_id: id }) : Response.json({ message: 'not found' }, { status: 404 });
    }
    if (method === 'POST' && path === '/deployments') {
      const body = JSON.parse(init.body);
      this.posts.push(body);
      const uri = body.uri.replace(/\/$/, '');
      if (this.unreachable.has(uri)) {
        return Response.json({ message: `[META0003] error when calling '${uri}/': unable to reach the remote endpoint.`, restate_code: 'META0003' }, { status: 500 });
      }
      if (this.refuse) return Response.json({ message: this.refuse.message }, { status: this.refuse.status });
      const existing = this.idOf(uri);
      if (existing) return Response.json({ id: existing, services: [] }, { status: 200 });
      const id = `dp_${this.next++}`;
      this.deployments.push({ id, uri });
      this.serving = id;
      return Response.json({ id, services: [{ name: 'TaskWorkflow', deployment_id: id }, { name: 'TaskService', deployment_id: id }] }, { status: 201 });
    }
    if (method === 'DELETE' && /^\/deployments\/\w+$/.test(path)) {
      const id = path.split('/').pop()!;
      if (u.searchParams.get('force') !== 'true') return new Response(null, { status: 501 });
      this.deletes.push(id);
      this.deployments = this.deployments.filter((d) => d.id !== id);
      return new Response(null, { status: 202 });
    }
    if (method === 'POST' && path === '/query') {
      this.queries++;
      const query: string = JSON.parse(init.body).query;
      const pinned = /pinned_deployment_id = '([\w]+)'/.exec(query)?.[1];
      const stuckOnly = /status IN \('paused', 'backing-off'\)/.test(query);
      const n = this.invocations.filter((i) => i.pinned === pinned && (stuckOnly ? ['paused', 'backing-off'].includes(i.status) : i.status !== 'completed')).length;
      return Response.json({ rows: [{ n }] });
    }
    return new Response('', { status: 404 });
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

describe('planDeploy: which colour a deploy goes to', () => {
  it('deploys to the colour that is not live', async () => {
    const blueLive = new FakeRestate([{ uri: BLUE, live: true }]);
    expect(planDeploy(await readTopology(new RestateAdmin(ADMIN, blueLive.fetch)))).toMatchObject({ live: 'blue', idle: 'green' });
    const greenLive = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    expect(planDeploy(await readTopology(new RestateAdmin(ADMIN, greenLive.fetch)))).toMatchObject({ live: 'green', idle: 'blue' });
  });

  it('first migration: the single `worker` service is the live deployment and the deploy goes to blue', async () => {
    const restate = new FakeRestate([{ uri: LEGACY, live: true }]);
    const plan = planDeploy(await readTopology(new RestateAdmin(ADMIN, restate.fetch)));
    expect(plan).toMatchObject({ live: 'legacy', liveDeploymentId: 'dp_1', idle: 'blue' });
  });

  it('a Restate that holds no worker yet (recreated volume) deploys to blue with nothing to drain', async () => {
    const restate = new FakeRestate();
    expect(planDeploy(await readTopology(new RestateAdmin(ADMIN, restate.fetch)))).toMatchObject({ live: null, idle: 'blue' });
  });
});

describe('registerColour: force:false only, and only a new deployment counts', () => {
  it('registers the idle colour at its own address and checks Restate now routes both services to it', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    const out = await registerColour(new RestateAdmin(ADMIN, restate.fetch), 'green', { ...clock() });
    expect(out).toEqual({ ok: true, deploymentId: 'dp_2' });
    expect(restate.posts).toEqual([{ uri: GREEN, use_http_11: true, force: false }]);
  });

  it('refused registration: aborts with Restate\'s reason, never retries with force, touches nothing live', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    restate.refuse = { status: 409, message: 'the new deployment changes the type of service TaskWorkflow' };
    const out = await registerColour(new RestateAdmin(ADMIN, restate.fetch), 'green', { ...clock() });
    expect(out.ok).toBe(false);
    expect((out as any).reason).toMatch(/409.*changes the type/);
    expect(restate.posts.every((p) => p.force === false)).toBe(true);
    expect(restate.deletes).toEqual([]);
    expect(restate.serving).toBe('dp_1');
  });

  it('an address Restate already holds is refused: its 200 means it kept the old handlers', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }, { uri: GREEN }]);
    const out = await registerColour(new RestateAdmin(ADMIN, restate.fetch), 'green', { ...clock() });
    expect(out.ok).toBe(false);
    expect((out as any).reason).toMatch(/already registered/);
    expect(restate.serving).toBe('dp_1');
  });

  it('waits for a colour that is still starting (META0003), then registers it', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    restate.unreachable.add(GREEN);
    const c = clock();
    let polls = 0;
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/deployments') && ++polls === 3) restate.unreachable.clear();
      return restate.fetch(url, init);
    });
    expect(await registerColour(admin, 'green', { ...c, attempts: 10, intervalMs: 2000 })).toEqual({ ok: true, deploymentId: 'dp_2' });
    expect(restate.posts).toHaveLength(3);
  });

  it('gives up on a colour that never answers, without force', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    restate.unreachable.add(GREEN);
    const out = await registerColour(new RestateAdmin(ADMIN, restate.fetch), 'green', { ...clock(), attempts: 4, intervalMs: 1000 });
    expect(out.ok).toBe(false);
    expect((out as any).reason).toMatch(/META0003|reach/);
    expect(restate.posts).toHaveLength(4);
    expect(restate.serving).toBe('dp_1');
  });
});

describe('finishDrains: the old colour is removed only once nothing is pinned to it', () => {
  it('in flight: waits, polling Restate, and deletes the old deployment once it has drained', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'running' }, { pinned: 'dp_1', status: 'suspended' }, { pinned: 'dp_2', status: 'running' });
    const c = clock();
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      // The design finishes on the old colour after three polls.
      if (url.endsWith('/query') && restate.queries === 3) restate.invocations.forEach((i) => { if (i.pinned === 'dp_1') i.status = 'completed'; });
      return restate.fetch(url, init);
    });
    const report = await finishDrains(admin, { ...c, waitMs: 600_000, intervalMs: 10_000 });
    expect(report.deleted).toEqual([{ slot: 'blue', deploymentId: 'dp_1' }]);
    expect(report.draining).toEqual([]);
    expect(restate.deletes).toEqual(['dp_1']);
    expect(restate.queries).toBeGreaterThanOrEqual(4);
    expect(c.now()).toBeGreaterThanOrEqual(30_000);
  });

  it('drained: deletes the old deployment at once and never the live one', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'completed' }, { pinned: 'dp_2', status: 'running' });
    const report = await finishDrains(new RestateAdmin(ADMIN, restate.fetch), { ...clock(), waitMs: 600_000, intervalMs: 10_000 });
    expect(report.deleted).toEqual([{ slot: 'blue', deploymentId: 'dp_1' }]);
    expect(restate.deletes).toEqual(['dp_1']);
    expect(restate.deployments.map((d) => d.id)).toEqual(['dp_2']);
  });

  it('timeout: keeps the old deployment (and so its container) and reports what is still pinned to it', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'suspended' });
    const c = clock();
    const report = await finishDrains(new RestateAdmin(ADMIN, restate.fetch), { ...c, waitMs: 60_000, intervalMs: 10_000 });
    expect(report.deleted).toEqual([]);
    expect(report.draining).toEqual([{ slot: 'blue', deploymentId: 'dp_1', inFlight: 1 }]);
    expect(restate.deletes).toEqual([]);
    expect(c.now()).toBeGreaterThanOrEqual(60_000);
    expect(c.now()).toBeLessThan(80_000);
  });

  it('first migration: the old `worker` deployment drains and is deleted like a colour', async () => {
    const restate = new FakeRestate([{ uri: LEGACY, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'running' });
    const admin = new RestateAdmin(ADMIN, restate.fetch);
    expect((await registerColour(admin, 'blue', { ...clock() })).ok).toBe(true);
    let report = await finishDrains(admin, { ...clock(), waitMs: 0, intervalMs: 10_000 });
    expect(report.draining).toEqual([{ slot: 'legacy', deploymentId: 'dp_1', inFlight: 1 }]);
    restate.invocations[0].status = 'completed';
    report = await finishDrains(admin, { ...clock(), waitMs: 0, intervalMs: 10_000 });
    expect(report.deleted).toEqual([{ slot: 'legacy', deploymentId: 'dp_1' }]);
  });

  it('a Restate that stops answering mid-drain leaves the old colour running rather than guess', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    let n = 0;
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      if (url.endsWith('/query') && ++n >= 1) throw new TypeError('fetch failed');
      return restate.fetch(url, init);
    });
    const report = await finishDrains(admin, { ...clock(), waitMs: 30_000, intervalMs: 10_000 });
    expect(report.deleted).toEqual([]);
    expect(report.draining).toEqual([{ slot: 'blue', deploymentId: 'dp_1', inFlight: null }]);
    expect(restate.deletes).toEqual([]);
  });

  it('leaves deployments that are not worker colours alone', async () => {
    const restate = new FakeRestate([{ uri: 'http://someone-else:9080' }, { uri: GREEN, live: true }]);
    const report = await finishDrains(new RestateAdmin(ADMIN, restate.fetch), { ...clock(), waitMs: 0, intervalMs: 10_000 });
    expect(report.deleted).toEqual([]);
    expect(restate.deletes).toEqual([]);
  });

  it('sends the drain query the plan names, against sys_invocation', async () => {
    const seen: string[] = [];
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    await finishDrains(new RestateAdmin(ADMIN, async (url, init) => {
      if (url.endsWith('/query')) seen.push(JSON.parse(String(init?.body)).query);
      return restate.fetch(url, init);
    }), { ...clock(), waitMs: 0, intervalMs: 10_000 });
    expect(seen).toEqual(["SELECT count(*) AS n FROM sys_invocation WHERE pinned_deployment_id = 'dp_1' AND status <> 'completed'"]);
  });
});

describe('the command line deploy.sh calls', () => {
  const run = async (restate: FakeRestate, argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const code = await runCli(argv, { fetcher: restate.fetch, out: (l) => out.push(l), err: (l) => err.push(l), ...clock() });
    return { code, out, err: err.join('\n') };
  };

  it('plan prints the live and idle colours as key=value lines', async () => {
    const r = await run(new FakeRestate([{ uri: LEGACY, live: true }]), ['plan', '--admin', ADMIN]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['live=legacy', 'live_deployment=dp_1', 'idle=blue', 'live_stuck=0']);
  });

  it('plan counts paused and backing-off invocations pinned to the old single worker (it has no outbox gate)', async () => {
    const restate = new FakeRestate([{ uri: LEGACY, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'paused' }, { pinned: 'dp_1', status: 'backing-off' }, { pinned: 'dp_1', status: 'running' });
    expect((await run(restate, ['plan', '--admin', ADMIN])).out).toContain('live_stuck=2');
    // Colours have the gate, so only the migration asks.
    const colours = new FakeRestate([{ uri: BLUE, live: true }]);
    colours.invocations.push({ pinned: 'dp_1', status: 'paused' });
    expect((await run(colours, ['plan', '--admin', ADMIN])).out).toContain('live_stuck=');
    expect((await run(colours, ['plan', '--admin', ADMIN])).out).not.toContain('live_stuck=1');
  });

  it('register exits 2 with a clear message when Restate refuses', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    restate.refuse = { status: 400, message: 'bad manifest' };
    const r = await run(restate, ['register', 'green', '--admin', ADMIN, '--attempts', '1']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/refused.*green.*was not changed/is);
  });

  it('finish-drains exits 3 when the colour a deploy needs is still draining, 0 otherwise', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'running' });
    let r = await run(restate, ['finish-drains', '--admin', ADMIN, '--wait-seconds', '0', '--require-drained', 'blue']);
    expect(r.code).toBe(3);
    expect(r.out).toEqual(['draining=blue:1']);
    r = await run(restate, ['finish-drains', '--admin', ADMIN, '--wait-seconds', '0']);
    expect(r.code).toBe(0);
    restate.invocations[0].status = 'completed';
    r = await run(restate, ['finish-drains', '--admin', ADMIN, '--wait-seconds', '0', '--require-drained', 'blue']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['deleted=blue']);
  });

  it('rejects an unknown colour', async () => {
    const r = await run(new FakeRestate(), ['register', 'purple', '--admin', ADMIN]);
    expect(r.code).toBe(64);
  });
});

describe('containerFetch: Restate admin calls made from inside the Core container', () => {
  it('passes the request to node in the container and returns its answer as a Response', async () => {
    const calls: any[] = [];
    const fetcher = containerFetch('hawa-production-core-1', (cmd, args, opts) => {
      calls.push({ cmd, args, input: JSON.parse(opts.input) });
      return { status: 0, stdout: JSON.stringify({ status: 201, body: '{"id":"dp_9"}' }), stderr: '' };
    });
    const res = await fetcher('http://restate:9070/deployments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":false}' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'dp_9' });
    expect(calls[0].cmd).toBe('docker');
    expect(calls[0].args.slice(0, 3)).toEqual(['exec', '-i', 'hawa-production-core-1']);
    expect(calls[0].input).toMatchObject({ url: 'http://restate:9070/deployments', method: 'POST', body: '{"force":false}' });
  });

  it('turns a failed exec or a network error inside the container into a thrown error, like fetch', async () => {
    await expect(containerFetch('c', () => ({ status: 1, stdout: '', stderr: 'No such container' }))('http://restate:9070/services')).rejects.toThrow(/No such container/);
    await expect(containerFetch('c', () => ({ status: 0, stdout: JSON.stringify({ error: 'ECONNREFUSED' }), stderr: '' }))('http://restate:9070/services')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('keeps a 202 or 204 answer without a body', async () => {
    const res = await containerFetch('c', () => ({ status: 0, stdout: JSON.stringify({ status: 202, body: '' }), stderr: '' }))('http://restate:9070/deployments/dp_1?force=true', { method: 'DELETE' });
    expect(res.status).toBe(202);
  });
});

describe('registration Restate accepted is never reported as a refusal (phase 0.1 review)', () => {
  it('an answer lost after Restate committed, then no answer at all: Restate\'s registry decides, and it says registered', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/deployments')) {
        await restate.fetch(url, init); // committed on the first attempt; every answer is lost
        throw new TypeError('fetch failed inside hawa-production-core-1: TimeoutError');
      }
      return restate.fetch(url, init);
    });
    const out = await registerColour(admin, 'green', { ...clock(), attempts: 3, intervalMs: 1000 });
    expect(out).toEqual({ ok: true, deploymentId: 'dp_2' });
    expect(restate.serving).toBe('dp_2');
  });

  it('answers lost and Restate holds nothing at the address: a refusal, safe to remove the colour', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/deployments')) throw new TypeError('fetch failed');
      return restate.fetch(url, init);
    });
    const out = await registerColour(admin, 'green', { ...clock(), attempts: 3, intervalMs: 1000 });
    expect(out).toMatchObject({ ok: false, state: 'refused' });
    expect((out as any).reason).toMatch(/holds no deployment/);
  });

  it('an address Restate held before the deploy is refused without being sent at all', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }, { uri: GREEN }]);
    const out = await registerColour(new RestateAdmin(ADMIN, restate.fetch), 'green', { ...clock() });
    expect(out).toMatchObject({ ok: false, state: 'refused' });
    expect(restate.posts).toEqual([]);
  });

  it('a service left on the old deployment is a partial switch (exit 4), never a refusal (exit 2)', async () => {
    const restate = new FakeRestate([{ uri: LEGACY, live: true }]);
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      const res = await restate.fetch(url, init);
      if (init?.method === 'POST' && res.status === 201) restate.routedElsewhere.TaskService = 'dp_1';
      return res;
    });
    const out = await registerColour(admin, 'blue', { ...clock() });
    expect(out).toMatchObject({ ok: false, state: 'partial', deploymentId: 'dp_2' });
    expect((out as any).reason).toMatch(/TaskService -> dp_1/);

    const lines: string[] = []; const errs: string[] = [];
    const restate2 = new FakeRestate([{ uri: LEGACY, live: true }]);
    const code = await runCli(['register', 'blue', '--admin', ADMIN], {
      fetcher: async (url, init) => {
        const res = await restate2.fetch(url, init);
        if (init?.method === 'POST' && res.status === 201) restate2.routedElsewhere.TaskService = 'dp_1';
        return res;
      },
      out: (l) => lines.push(l), err: (l) => errs.push(l), ...clock(),
    });
    expect(code).toBe(4);
    expect(lines).toEqual(['deployment=dp_2']);
    expect(errs.join(' ')).toMatch(/must keep running/);
  });

  it('a check that cannot read the routes after a 201 is a partial switch, not a thrown error or a refusal', async () => {
    const restate = new FakeRestate([{ uri: BLUE, live: true }]);
    let posted = false;
    const admin = new RestateAdmin(ADMIN, async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/deployments')) posted = true;
      else if (posted && /\/services/.test(url)) throw new TypeError('docker exec hawa-production-core-1 failed');
      return restate.fetch(url, init);
    });
    const out = await registerColour(admin, 'green', { ...clock() });
    expect(out).toMatchObject({ ok: false, state: 'partial', deploymentId: 'dp_2' });
  });
});

describe('removable: deploy.sh removes a colour only when Restate holds nothing at its address', () => {
  const run = async (restate: FakeRestate, colour: string) => {
    const out: string[] = [];
    const code = await runCli(['removable', colour, '--admin', ADMIN], { fetcher: restate.fetch, out: (l) => out.push(l), err: () => {} });
    return { code, out };
  };

  it('0 for an address Restate does not hold, 4 with what it serves for one it does', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    expect(await run(new FakeRestate([{ uri: BLUE, live: true }]), 'green')).toEqual({ code: 0, out: ['registered='] });
    expect(await run(restate, 'green')).toEqual({ code: 4, out: ['registered=dp_2', 'serves=TaskWorkflow,TaskService'] });
    expect(await run(restate, 'blue')).toEqual({ code: 4, out: ['registered=dp_1', 'serves=none'] });
  });

  it('1 when Restate cannot be read, so the caller keeps the colour', async () => {
    const code = await runCli(['removable', 'green', '--admin', ADMIN], { fetcher: async () => { throw new TypeError('fetch failed'); }, out: () => {}, err: () => {} });
    expect(code).toBe(1);
  });
});

describe('finishDrains keeps what a service still needs, and says why (phase 0.1 review)', () => {
  const run = async (restate: FakeRestate, argv: string[]) => {
    const out: string[] = [];
    const code = await runCli(argv, { fetcher: restate.fetch, out: (l) => out.push(l), err: () => {}, ...clock() });
    return { code, out };
  };

  it('a drained deployment still routed to by TaskService is kept and reported as such', async () => {
    const restate = new FakeRestate([{ uri: LEGACY }, { uri: BLUE, live: true }]);
    restate.routedElsewhere.TaskService = 'dp_1';
    const r = await run(restate, ['finish-drains', '--admin', ADMIN, '--wait-seconds', '600', '--require-drained', 'green']);
    expect(restate.deletes).toEqual([]);
    expect(r.out).toEqual(['kept=legacy:Restate still sends TaskService to it']);
    expect(r.code).toBe(3);
  });

  it('nothing is deleted while the routes cannot be read', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    restate.failServiceLists = true;
    const report = await finishDrains(new RestateAdmin(ADMIN, restate.fetch), { ...clock(), waitMs: 30_000, intervalMs: 10_000 });
    expect(restate.deletes).toEqual([]);
    expect(report.draining).toEqual([{ slot: 'blue', deploymentId: 'dp_1', inFlight: 0 }]);
  });

  it('a delete that keeps failing is reported as kept with its reason, not as draining with 0', async () => {
    const restate = new FakeRestate([{ uri: BLUE }, { uri: GREEN, live: true }]);
    const fetcher = async (url: string, init?: RequestInit) => (init?.method === 'DELETE' ? new Response('boom', { status: 500 }) : restate.fetch(url, init));
    const out: string[] = [];
    const code = await runCli(['finish-drains', '--admin', ADMIN, '--wait-seconds', '20', '--require-drained', 'blue'], { fetcher, out: (l) => out.push(l), err: () => {}, ...clock() });
    expect(out).toEqual(['kept=blue:drained, but its delete failed: DELETE /deployments/dp_1 answered 500']);
    expect(code).toBe(3);
  });

  it('the old single worker still draining blocks every later deploy, whichever colour it goes to', async () => {
    const restate = new FakeRestate([{ uri: LEGACY }, { uri: BLUE, live: true }]);
    restate.invocations.push({ pinned: 'dp_1', status: 'suspended' });
    const r = await run(restate, ['finish-drains', '--admin', ADMIN, '--wait-seconds', '0', '--require-drained', 'green']);
    expect(r.out).toEqual(['draining=legacy:1']);
    expect(r.code).toBe(3);
  });
});
