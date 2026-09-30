import { describe, it, expect, vi, afterEach } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * Bug hunt 2026-09-24: what the worker leaves behind when it gives up on a studio run.
 *
 * 1. DESIGN_STUCK (and DESIGN_SERVER_ERROR from an exhausted resume step) end the workflow with the
 *    studio run still at its stage. Nothing abandons it, and Core refuses a new run for the task while
 *    it exists (redriveTask: "still being made"; createOrGetRun: STUDIO_RUN_IN_PROGRESS; the unique
 *    index design_studio_one_active_run). See apps/core/test/redrive-stale-run.hunt.test.ts.
 * 2. The outcome goes only to Core. When Core is what is down, the report step gives up too and the
 *    workflow ends with no outcome recorded anywhere: the task stays `received`, nobody is told.
 */
const input: WorkflowInput = {
  taskId: '00000000-0000-4000-c000-000000000001',
  tenantId: 'tenant',
  clientId: 'client',
  rawText: '',
  sourcePlatform: 'telegram',
  idempotencyKey: 'key',
  canvaAutoGenerate: true,
  designStudio: true,
};

/** Like Restate: a step whose action fails is retried, and once its budget is spent ctx.run throws a TerminalError. */
function restateLikeContext(attempts = 3) {
  const steps: string[] = [];
  const ctx = {
    key: 'wf-hunt',
    run: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      steps.push(name);
      let last: any;
      for (let i = 0; i < attempts; i++) {
        try { return await action(); } catch (err: any) { if (err?.terminal) throw new restate.TerminalError(err.message); last = err; }
      }
      throw new restate.TerminalError(`${last?.message || last}`);
    },
    sleep: async () => {},
  };
  return { ctx, steps };
}

const calls = (remote: ReturnType<typeof vi.fn>, part: string) => remote.mock.calls.filter((c) => String(c[0]).includes(part));

afterEach(() => { vi.unstubAllEnvs(); });

describe('HUNT: a studio run the worker gives up on', () => {
  it('DESIGN_STUCK abandons the run it stopped following', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/resume')) return Response.json({ runId: 'run-stuck', status: 'laying_out' });
      if (u.endsWith('/canva/studio')) return Response.json({ runId: 'run-stuck', status: 'briefing' });
      if (u.includes('/notifications/')) return Response.json({ ok: true });
      return Response.json({ tenantId: 'tenant', clientId: 'client' });
    });
    const { ctx } = restateLikeContext();
    const out = await runCanvaDraft(input, ctx as any, remote as any);
    expect(out.status).toBe('DESIGN_STUCK');
    // Expected: POST .../canva/studio/run-stuck/abandon (or an equivalent that frees the task). Actual: none.
    expect(calls(remote, '/abandon')).toHaveLength(1);
  });

  it('an exhausted resume step (DESIGN_SERVER_ERROR) abandons the run too', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/resume')) return new Response(JSON.stringify({ title: 'Studio Operation Failed' }), { status: 500 });
      if (u.endsWith('/canva/studio')) return Response.json({ runId: 'run-500', status: 'briefing' });
      if (u.includes('/notifications/')) return Response.json({ ok: true });
      return Response.json({ tenantId: 'tenant', clientId: 'client' });
    });
    const { ctx } = restateLikeContext();
    const out = await runCanvaDraft(input, ctx as any, remote as any);
    expect(out.status).toBe('DESIGN_SERVER_ERROR');
    expect(calls(remote, '/abandon')).toHaveLength(1);
  });

  it('when Core stays down past the step budget, the outcome is still recorded somewhere', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    const { ctx, steps } = restateLikeContext();
    const outcome = await runCanvaDraft(input, ctx as any, remote as any).then(
      (r) => ({ ended: 'returned', status: r.status }),
      (e) => ({ ended: 'threw', error: String(e?.message || e).slice(0, 60) })
    );
    // Today: the scope check gives up, finish() tries to report DESIGN_SERVER_ERROR to the same dead
    // Core, that step gives up too, and the workflow throws. Nothing was written for the task.
    expect({ outcome, reportSteps: steps.filter((s) => s.startsWith('canva-notify-')) }).toEqual({
      outcome: { ended: 'returned', status: 'DESIGN_SERVER_ERROR' },
      reportSteps: ['canva-notify-design_server_error'],
    });
  });
});
