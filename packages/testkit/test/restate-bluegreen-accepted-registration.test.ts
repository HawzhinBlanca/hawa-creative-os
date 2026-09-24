import { describe, it, expect } from 'vitest';
import { runCli, DEFAULT_WORKER_ADDRESSES } from '../../../scripts/restate-bluegreen.js';

/**
 * Review finding (phase 0.1 fix round): a registration Restate had already accepted was reported as a
 * refusal (exit 2), and deploy.sh then removed the colour Restate was sending all new work to.
 */
function restateThatLosesTheFirstAnswer() {
  const deps = [{ id: 'dp_green', uri: DEFAULT_WORKER_ADDRESSES.green + '/' }];
  const state = { serving: 'dp_green' };
  const fetcher = async (url: string, init: any = {}) => {
    const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
    if (m === 'GET' && u.pathname === '/deployments') return Response.json({ deployments: deps });
    if (m === 'GET' && u.pathname.startsWith('/services/')) return Response.json({ deployment_id: state.serving });
    if (m === 'POST' && u.pathname === '/deployments') {
      const b = JSON.parse(init.body);
      const existing = deps.find((d) => d.uri.replace(/\/$/, '') === b.uri);
      if (existing) return Response.json({ id: existing.id }, { status: 200 });
      deps.push({ id: 'dp_blue', uri: b.uri + '/' }); state.serving = 'dp_blue';
      throw new TypeError('fetch failed inside hawa-production-core-1: TimeoutError'); // committed, answer lost
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, state };
}

describe('register: a registration Restate accepted is never reported as a refusal', () => {
  it('a lost 201 followed by a 200 for the same address is success, not "live colour not touched"', async () => {
    const r = restateThatLosesTheFirstAnswer();
    const errs: string[] = [];
    const code = await runCli(['register', 'blue'], { fetcher: r.fetcher as any, err: (l) => errs.push(l), out: () => {}, sleep: async () => {} });
    expect(r.state.serving).toBe('dp_blue');      // Restate routes new work to blue
    expect(code).toBe(0);                          // was 2 -> deploy.sh abandon_idle removed worker-blue
    expect(errs.join(' ')).not.toMatch(/not touched/);
  });

  it('a 201 that moved only TaskWorkflow (Restate 1.7.10 when the new build hosts fewer services) is not a refusal that permits removing the new colour', async () => {
    const serving: Record<string, string> = { TaskWorkflow: 'dp_legacy', TaskService: 'dp_legacy' };
    const fetcher = async (url: string, init: any = {}) => {
      const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
      if (m === 'GET' && u.pathname === '/deployments') return Response.json({ deployments: [{ id: 'dp_legacy', uri: 'http://worker:9080/' }] });
      const s = /^\/services\/(\w+)$/.exec(u.pathname);
      if (m === 'GET' && s) return Response.json({ deployment_id: serving[s[1]] });
      if (m === 'POST' && u.pathname === '/deployments') { serving.TaskWorkflow = 'dp_blue'; return Response.json({ id: 'dp_blue' }, { status: 201 }); }
      return new Response('', { status: 404 });
    };
    const errs: string[] = [];
    const code = await runCli(['register', 'blue'], { fetcher: fetcher as any, err: (l) => errs.push(l), out: () => {}, sleep: async () => {} });
    expect(serving.TaskWorkflow).toBe('dp_blue');
    // Exit 2 is the code deploy.sh answers with `abandon_idle` (rm -sf worker-blue); it must not be used here.
    expect(code).not.toBe(2);                      // was 2, message 'The live colour was not touched.'
  });
});
