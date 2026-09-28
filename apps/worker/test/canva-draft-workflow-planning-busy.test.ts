import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * Core plans a bounded number of designs at a time and answers the others 429 PLANNING_BUSY with a
 * Retry-After: when it expects a slot to free. The planning step used to throw the 429 into
 * Restate's step retry, which doubles its wait (2, 4, 8, 16, 30 s), so ten briefs sent at once got
 * their drafts in pairs at about 5, 7, 11, 19 and 35 s on the chaos stack (2026-09-24 load test)
 * while slots stood free between tries. The busy answer is now journalled, like the studio's, and
 * the same request is asked again after the wait Core named.
 */

const input: WorkflowInput = {
  taskId: '00000000-0000-4000-c000-000000000003',
  tenantId: 'tenant',
  clientId: 'client',
  rawText: '',
  sourcePlatform: 'telegram',
  idempotencyKey: 'key',
  canvaAutoGenerate: true,
};

const BUSY_WINDOW_MS = 15 * 60 * 1000;

function recordingContext(journal: Map<string, unknown> = new Map()) {
  const steps: string[] = [];
  const sleeps: number[] = [];
  const ctx = {
    key: 'wf-planning-busy-test',
    run: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      steps.push(name);
      if (journal.has(name)) return journal.get(name) as T;
      const value = await action();
      journal.set(name, value);
      return value;
    },
    sleep: async (millis: number) => {
      sleeps.push(millis);
    },
  };
  return { ctx, steps, sleeps, journal };
}

/** A Core stand-in whose generation answers 429 PLANNING_BUSY the given number of times. */
function planningCore(opts: { busy: number; retryAfter?: string | null }) {
  let busy = opts.busy;
  const retryAfter = opts.retryAfter === undefined ? '3' : opts.retryAfter;
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/canva/generate')) {
      if (busy-- > 0) {
        return Response.json(
          { title: 'PLANNING_BUSY', detail: 'Every planning slot is taken.' },
          { status: 429, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } }
        );
      }
      return Response.json({ planId: 'plan-busy', status: 'retrieved', designId: 'DA_plan' });
    }
    if (target.endsWith('/canva/exports')) {
      const format = JSON.parse(String(init?.body)).format;
      return Response.json(
        format === 'pptx'
          ? { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }
          : { status: 'retrieved', artifact: { id: 'artifact' } }
      );
    }
    if (target.includes('/canva/parity-check')) return Response.json({ parity: 'match' });
    if (target.endsWith('/canva')) return Response.json({ binding: { designId: 'DA_plan', version: 1 } });
    if (target.includes('/notifications/')) return Response.json({ ok: true });
    return Response.json({ tenantId: 'tenant', clientId: 'client' });
  });
}

const generations = (remote: ReturnType<typeof vi.fn>) => remote.mock.calls.filter((c) => String(c[0]).endsWith('/canva/generate'));
const notifications = (remote: ReturnType<typeof vi.fn>) =>
  remote.mock.calls.filter((c) => String(c[0]).includes('/notifications/canva-status')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a busy planner', () => {
  it('waits the time Core names, not a doubling backoff, and then designs', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = planningCore({ busy: 4, retryAfter: '3' });
    const { ctx, steps, sleeps, journal } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result).toMatchObject({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', documentId: 'DA_plan' });
    expect(generations(remote)).toHaveLength(5);
    // Every try carries the same idempotency key: Core plans one design, never five.
    expect(new Set(generations(remote).map((c) => (c[1] as { headers: Record<string, string> }).headers['Idempotency-Key']))).toEqual(
      new Set(['workflow-' + input.taskId])
    );
    expect(steps.slice(1, 6)).toEqual([
      'canva-create-draft',
      'canva-create-draft-after-busy-1',
      'canva-create-draft-after-busy-2',
      'canva-create-draft-after-busy-3',
      'canva-create-draft-after-busy-4',
    ]);
    expect(sleeps.slice(0, 4)).toEqual([3000, 3000, 3000, 3000]);
    // The wait is never announced; the requester hears the result.
    expect(notifications(remote)).toEqual([expect.objectContaining({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' })]);

    // A replay of the same journal asks for the same timers and makes no call to Core.
    const replayRemote = planningCore({ busy: 4 });
    const replay = recordingContext(journal);
    expect((await runCanvaDraft(input, replay.ctx, replayRemote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(replayRemote).not.toHaveBeenCalled();
    expect(replay.sleeps).toEqual(sleeps);
  });

  it('bounds the named wait to between 1 and 30 seconds', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const long = recordingContext();
    await runCanvaDraft(input, long.ctx, planningCore({ busy: 1, retryAfter: '3600' }));
    expect(long.sleeps[0]).toBe(30000);

    const zero = recordingContext();
    await runCanvaDraft(input, zero.ctx, planningCore({ busy: 1, retryAfter: '0' }));
    expect(zero.sleeps[0]).toBe(1000);
  });

  it('waits the default 25 s when Core names no time', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const { ctx, sleeps } = recordingContext();
    await runCanvaDraft(input, ctx, planningCore({ busy: 1, retryAfter: null }));
    expect(sleeps[0]).toBe(25000);
  });

  it('ends the run as a busy server once the planner has stayed busy for the whole window', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = planningCore({ busy: Number.POSITIVE_INFINITY, retryAfter: '10' });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result.status).toBe('DESIGN_SERVER_ERROR');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(BUSY_WINDOW_MS);
    expect(generations(remote)).toHaveLength(BUSY_WINDOW_MS / 10000 + 1);
    const told = notifications(remote);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ status: 'DESIGN_SERVER_ERROR', code: 'PLANNING_BUSY' });
    expect(told[0].detail).toContain('15 minutes');
  });
});
