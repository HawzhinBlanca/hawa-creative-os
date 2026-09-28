import { describe, it, expect } from 'vitest';
import { RestateAdmin, registerColour, runCli } from '../../../scripts/restate-bluegreen.js';

/**
 * Phase 4 operations finding 2 (ADR-129). Restate never un-routes a service. A worker build that
 * hosts fewer services than Restate already routes to the worker (a rollback below the build that
 * added ChatInbox, say) moves only the services it hosts. The others stay on the old colour, the next
 * deploy plans that colour as idle, finish-drains keeps it ("Restate still sends … to it") and every
 * later deploy stops at step 4b. Registering such a build is therefore refused before anything is
 * sent, while Restate still routes every service to one colour.
 */
const ADMIN = 'http://restate:9070';
const ALL = ['TaskWorkflow', 'TaskService', 'ChatInbox', 'Delivery', 'TelegramSender', 'RequestLifecycle', 'DesignRun', 'OfficeDecisionGateway'];

function restate(routed: string[] = ALL) {
  const posts: unknown[] = [];
  const serving: Record<string, string> = Object.fromEntries(routed.map((name) => [name, 'dp_green']));
  const fetcher = async (url: string, init: any = {}) => {
    const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
    if (m === 'GET' && u.pathname === '/deployments') return Response.json({ deployments: [{ id: 'dp_green', uri: 'http://worker-green:9080/' }] });
    if (m === 'GET' && u.pathname === '/services') return Response.json({ services: Object.entries(serving).map(([name, deployment_id]) => ({ name, deployment_id })) });
    const s = /^\/services\/(\w+)$/.exec(u.pathname);
    if (m === 'GET' && s) return serving[s[1]] ? Response.json({ deployment_id: serving[s[1]] }) : new Response('', { status: 404 });
    if (m === 'POST' && u.pathname === '/deployments') {
      posts.push(JSON.parse(init.body));
      // Restate moves only what the new build hosts; here the new build hosts every service.
      for (const k of Object.keys(serving)) serving[k] = 'dp_blue';
      return Response.json({ id: 'dp_blue', services: [] }, { status: 201 });
    }
    return new Response('', { status: 404 });
  };
  return { admin: new RestateAdmin(ADMIN, fetcher as any), fetcher, posts, serving };
}

const quiet = { sleep: async () => {} };

describe('register refuses a build that does not host every service Restate routes to the worker', () => {
  it('a rollback build hosting only TaskWorkflow and TaskService is refused before anything is sent', async () => {
    const r = restate();
    const outcome = await registerColour(r.admin, 'blue', { ...quiet, hosts: ['TaskWorkflow', 'TaskService'] });
    expect(outcome).toMatchObject({ ok: false, state: 'refused' });
    expect(outcome.ok ? '' : outcome.reason).toMatch(/ChatInbox/);
    expect(outcome.ok ? '' : outcome.reason).toMatch(/does not host/);
    expect(r.posts).toEqual([]);
    expect(r.serving.TaskWorkflow).toBe('dp_green');
  });

  it('a build that does not list its services (older than Phase 2.1) is refused while ChatInbox is routed', async () => {
    const r = restate();
    const outcome = await registerColour(r.admin, 'blue', { ...quiet, hosts: null });
    expect(outcome).toMatchObject({ ok: false, state: 'refused' });
    expect(outcome.ok ? '' : outcome.reason).toMatch(/does not list the services it hosts/);
    expect(r.posts).toEqual([]);
  });

  it('the same unlisted build is accepted while Restate routes only TaskWorkflow and TaskService', async () => {
    const r = restate(['TaskWorkflow', 'TaskService']);
    const outcome = await registerColour(r.admin, 'blue', { ...quiet, attempts: 1, hosts: null });
    expect(r.posts).toHaveLength(1);
    // The switch itself then reports on the eight services a current build must host.
    expect(outcome).toMatchObject({ ok: false, state: 'partial' });
  });

  it('a build that hosts every routed service is registered as before', async () => {
    const r = restate();
    const outcome = await registerColour(r.admin, 'blue', { ...quiet, attempts: 1, hosts: ALL });
    expect(outcome).toEqual({ ok: true, deploymentId: 'dp_blue' });
    expect(r.posts).toHaveLength(1);
  });

  it('when Restate cannot say what it routes, nothing is registered', async () => {
    const r = restate();
    const broken = async (url: string, init: any = {}) => (new URL(url).pathname === '/services' ? new Response('', { status: 503 }) : r.fetcher(url, init));
    const outcome = await registerColour(new RestateAdmin(ADMIN, broken as any), 'blue', { ...quiet, hosts: ALL });
    expect(outcome).toMatchObject({ ok: false, state: 'refused' });
    expect(r.posts).toEqual([]);
  });

  it('the CLI takes --hosts from deploy.sh and exits 2 (nothing registered, the new colour may be removed)', async () => {
    const r = restate();
    const out: string[] = []; const err: string[] = [];
    const code = await runCli(['register', 'blue', '--hosts', 'TaskWorkflow,TaskService', '--attempts', '1'], {
      fetcher: r.fetcher as any, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, ...quiet,
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/ChatInbox/);
    expect(r.posts).toEqual([]);
    const unknown = await runCli(['register', 'blue', '--hosts', 'unknown', '--attempts', '1'], {
      fetcher: r.fetcher as any, out: () => {}, err: () => {}, env: {}, ...quiet,
    });
    expect(unknown).toBe(2);
  });
});

// Phase 4 review of 72cb6fae.
describe('--hosts unknown and the check-hosts command', () => {
  it('"--hosts unknown" (deploy.sh when /ready gives no list) is the pre-Phase-2.1 fallback, not a service named "unknown"', async () => {
    const r = restate(['TaskWorkflow', 'TaskService']);
    const err: string[] = [];
    const code = await runCli(['register', 'blue', '--hosts', 'unknown', '--attempts', '1'], {
      fetcher: r.fetcher as any, out: () => {}, err: (l) => err.push(l), env: {}, ...quiet,
    });
    // Accepted like hosts:null: the registration is sent (the switch then reports on the eight services).
    expect(r.posts).toHaveLength(1);
    expect(code).toBe(4);
    expect(err.join('\n')).not.toMatch(/does not host TaskWorkflow/);
  });

  it('a partly unusable list is treated as no list, not trusted in part', async () => {
    const r = restate();
    const err: string[] = [];
    const code = await runCli(['register', 'blue', '--hosts', 'TaskWorkflow,Task Service;rm', '--attempts', '1'], {
      fetcher: r.fetcher as any, out: () => {}, err: (l) => err.push(l), env: {}, ...quiet,
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/could not be read/);
    expect(r.posts).toEqual([]);
  });

  it('check-hosts refuses a build that does not host every routed service, and sends nothing', async () => {
    const r = restate();
    const err: string[] = [];
    const code = await runCli(['check-hosts', '--hosts', 'TaskWorkflow,TaskService'], {
      fetcher: r.fetcher as any, out: () => {}, err: (l) => err.push(l), env: {}, ...quiet,
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/does not host ChatInbox/);
    expect(r.posts).toEqual([]);
  });

  it('check-hosts accepts a build that hosts every routed service, and an unlisted build while only TaskWorkflow and TaskService are routed', async () => {
    const r = restate();
    const out: string[] = [];
    expect(await runCli(['check-hosts', '--hosts', ALL.join(',')], { fetcher: r.fetcher as any, out: (l) => out.push(l), err: () => {}, env: {}, ...quiet })).toBe(0);
    expect(out).toContain('hosts=ok');
    const old = restate(['TaskWorkflow', 'TaskService']);
    expect(await runCli(['check-hosts', '--hosts', 'unknown'], { fetcher: old.fetcher as any, out: () => {}, err: () => {}, env: {}, ...quiet })).toBe(0);
    expect(r.posts).toEqual([]);
    expect(old.posts).toEqual([]);
  });

  it('check-hosts refuses when Restate cannot say what it routes, and needs --hosts', async () => {
    const r = restate();
    const broken = async (url: string, init: any = {}) => (new URL(url).pathname === '/services' ? new Response('', { status: 503 }) : r.fetcher(url, init));
    expect(await runCli(['check-hosts', '--hosts', ALL.join(',')], { fetcher: broken as any, out: () => {}, err: () => {}, env: {}, ...quiet })).toBe(2);
    expect(await runCli(['check-hosts'], { fetcher: r.fetcher as any, out: () => {}, err: () => {}, env: {}, ...quiet })).toBe(64);
  });
});
