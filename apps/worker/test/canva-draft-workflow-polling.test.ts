import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * The studio advance loop, measured against the durable engine rather than a clock.
 *
 * Before this suite the loop slept a flat 5 s before every resume. Core's resume runs the next
 * stage inline and returns the status it reached, so on a design that advanced on all nine of its
 * polls the nine gaps were pure waiting: 9 x 5000 ms = 45 000 ms per successful design. A run that
 * core had marked 'abandoned' was not in the loop's stop list at all, so it was resumed 150 times
 * with 150 x 5000 ms = 750 000 ms of sleep and then reported as its own stage name. Those two
 * numbers are the ones the 2026-09-19 audit measured, and they are asserted against HEAD below.
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

/** The nine statuses core's resume walks through on a design that transfers, in order. */
const ADVANCING_STAGES = [
  'conceiving',
  'laying_out',
  'rendering',
  'critiquing',
  'revising',
  'judging',
  'qa',
  'transferring',
  'transferred',
];

/**
 * Records exactly what the workflow asked of the durable engine: the journalled step names in the
 * order they were requested, and every timer it asked for. A journal handed in from a previous run
 * replays it, the way Restate replays a suspended invocation.
 */
function recordingContext(journal: Map<string, unknown> = new Map()) {
  const steps: string[] = [];
  const sleeps: number[] = [];
  const ctx = {
    key: 'wf-polling-test',
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

/** A Core stand-in whose studio resume returns the next status from `statuses`. */
function coreWithStudioStatuses(opts: {
  runId: string;
  startStatus: string;
  statuses: string[];
  designId?: string;
}) {
  const queue = [...opts.statuses];
  let lastStatus = opts.startStatus;
  return vi.fn(async (url: unknown, init?: any) => {
    const target = String(url);
    if (target.includes('/canva/studio/') && target.endsWith('/resume')) {
      lastStatus = queue.length ? queue.shift()! : lastStatus;
      return Response.json({
        runId: opts.runId,
        status: lastStatus,
        ...(lastStatus === 'transferred' && opts.designId ? { designId: opts.designId } : {}),
      });
    }
    if (target.endsWith('/canva/studio')) return Response.json({ runId: opts.runId, status: opts.startStatus });
    if (target.endsWith('/canva/exports')) {
      const format = JSON.parse(init.body).format;
      return Response.json(
        format === 'pptx'
          ? { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }
          : { status: 'retrieved', artifact: { id: 'artifact' } }
      );
    }
    if (target.includes('/canva/parity-check')) return Response.json({ parity: 'match' });
    if (target.endsWith('/canva')) return Response.json({ binding: { designId: opts.designId, version: 1 } });
    if (target.includes('/notifications/')) return Response.json({ ok: true });
    return Response.json({ tenantId: 'tenant', clientId: 'client' });
  });
}

const resumeCalls = (remote: ReturnType<typeof vi.fn>) =>
  remote.mock.calls.filter((c) => String(c[0]).includes('/canva/studio/') && String(c[0]).endsWith('/resume'));

const notifications = (remote: ReturnType<typeof vi.fn>) =>
  remote.mock.calls.filter((c) => String(c[0]).includes('/notifications/canva-status')).map((c) => JSON.parse((c[1] as any).body));

const total = (values: number[]) => values.reduce((a, b) => a + b, 0);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('design studio advance loop', () => {
  it('never waits between stages that advanced, the 45 000 ms HEAD spent on every design', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = coreWithStudioStatuses({
      runId: 'run-fast',
      startStatus: 'briefing',
      statuses: ADVANCING_STAGES,
      designId: 'DA_fast',
    });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx as any, remote as any);

    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(result.documentId).toBe('DA_fast');
    // The same nine resumes as HEAD, and not one timer between them. HEAD asked for
    // [5000 x 9] here, which is the 45 s the audit measured on a successful design.
    expect(resumeCalls(remote)).toHaveLength(9);
    expect(sleeps).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(total(sleeps)).toBe(9);
  });

  it('stops at the first poll that says the run was abandoned and reports it once', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = coreWithStudioStatuses({
      runId: 'run-gone',
      startStatus: 'briefing',
      statuses: ['abandoned'],
    });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx as any, remote as any);

    expect(result.status).toBe('DESIGN_ABANDONED');
    // HEAD's stop list held transferred, degraded and failed only, so an abandoned run was
    // resumed 150 times and slept 750 000 ms before it said anything.
    expect(resumeCalls(remote)).toHaveLength(1);
    expect(sleeps).toEqual([1]);
    expect(notifications(remote)).toEqual([
      expect.objectContaining({ status: 'DESIGN_ABANDONED', runId: 'run-gone' }),
    ]);
  });

  it('ends a run that stopped moving with a terminal status naming the stage it died in', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = coreWithStudioStatuses({
      runId: 'run-stuck',
      startStatus: 'qa',
      statuses: Array(200).fill('qa'),
    });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx as any, remote as any);

    expect(result.status).toBe('DESIGN_STUCK');
    // Ten polls at the same status is the limit: one with no wait, then the backoff 500, 1000,
    // 2000, 4000 and a 5000 ms ceiling. 32 500 ms in total against HEAD's 750 000 ms.
    expect(resumeCalls(remote)).toHaveLength(10);
    expect(sleeps).toEqual([1, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000]);
    expect(total(sleeps)).toBe(32501);
    // The owner is told which stage stopped. Core's status handler strips everything that is not
    // [A-Z0-9_] from `code` and renders it in the Telegram message, so the stage rides in the code.
    expect(notifications(remote)).toEqual([
      expect.objectContaining({ status: 'DESIGN_STUCK', code: 'STUCK_IN_QA', runId: 'run-stuck' }),
    ]);
  });

  it('gives up on a run that idles in bursts once the accumulated wait budget is spent', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    // Runs of eight and nine identical statuses never reach the ten-poll limit, so only the
    // 60 000 ms wait budget can stop this run.
    const statuses = [...Array(8).fill('qa'), ...Array(9).fill('judging'), ...Array(30).fill('qa')];
    const remote = coreWithStudioStatuses({ runId: 'run-burst', startStatus: 'qa', statuses });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx as any, remote as any);

    expect(result.status).toBe('DESIGN_STUCK');
    expect(resumeCalls(remote)).toHaveLength(23);
    expect(total(sleeps)).toBe(62503);
    expect(notifications(remote)).toEqual([
      expect.objectContaining({ status: 'DESIGN_STUCK', code: 'STUCK_IN_QA' }),
    ]);
  });

  it('replays the same journalled steps and the same timers for the same inputs', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = coreWithStudioStatuses({
      runId: 'run-replay',
      startStatus: 'qa',
      statuses: Array(200).fill('qa'),
    });
    const first = recordingContext();
    const firstResult = await runCanvaDraft(input, first.ctx as any, remote as any);

    expect(first.steps.filter((s) => s.startsWith('canva-studio-resume-'))).toEqual(
      Array.from({ length: 10 }, (_, i) => 'canva-studio-resume-' + i)
    );

    // A suspended invocation resumes from the journal: every step is answered from it, so Core is
    // never called again, and the backoff must ask for the very same timers in the very same order.
    const replay = recordingContext(new Map(first.journal));
    const refuse = vi.fn(async () => {
      throw new Error('a replay must not reach Core');
    });
    const replayResult = await runCanvaDraft(input, replay.ctx as any, refuse as any);

    expect(refuse).not.toHaveBeenCalled();
    expect(replay.steps).toEqual(first.steps);
    expect(replay.sleeps).toEqual(first.sleeps);
    expect(replayResult).toEqual(firstResult);
  });
});
