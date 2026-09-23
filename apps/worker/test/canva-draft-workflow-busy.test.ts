import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * A studio start that Core answers with 429 STUDIO_BUSY (two of the tenant's runs still unfinished)
 * used to be retried five times in under a second and then reported as "We could not make the
 * automatic draft" (2026-09-23). It now waits its turn: a journalled 25 s wait between tries, for up
 * to 15 minutes, and only then ends the run as before.
 */

const input: WorkflowInput = {
  taskId: '00000000-0000-4000-c000-000000000002',
  tenantId: 'tenant',
  clientId: 'client',
  rawText: '',
  sourcePlatform: 'telegram',
  idempotencyKey: 'key',
  canvaAutoGenerate: true,
  designStudio: true,
};

const BUSY_WAIT_MS = 25000;
const BUSY_WINDOW_MS = 15 * 60 * 1000;

/** Records the journalled steps, their options and every timer; a journal handed in is replayed. */
function recordingContext(journal: Map<string, unknown> = new Map()) {
  const steps: string[] = [];
  const options = new Map<string, { maxRetryAttempts?: number } | undefined>();
  const sleeps: number[] = [];
  const ctx = {
    key: 'wf-busy-test',
    run: async <T>(name: string, action: () => Promise<T>, opts?: { maxRetryAttempts?: number }): Promise<T> => {
      steps.push(name);
      options.set(name, opts);
      if (journal.has(name)) return journal.get(name) as T;
      const value = await action();
      journal.set(name, value);
      return value;
    },
    sleep: async (millis: number) => {
      sleeps.push(millis);
    },
  };
  return { ctx, steps, options, sleeps, journal };
}

/** A Core stand-in whose studio start and resume answer 429 STUDIO_BUSY the given number of times. */
function busyCore(opts: { busyStarts: number; busyResumes?: number }) {
  let starts = opts.busyStarts;
  let resumes = opts.busyResumes ?? 0;
  const busy = () => Response.json({ title: 'STUDIO_BUSY', detail: 'Two studio designs are already in progress.' }, { status: 429 });
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/canva/studio')) {
      if (starts-- > 0) return busy();
      return Response.json({ runId: 'run-busy', status: 'briefing' }, { status: 202 });
    }
    if (target.includes('/canva/studio/') && target.endsWith('/resume')) {
      if (resumes-- > 0) return busy();
      return Response.json({ runId: 'run-busy', status: 'transferred', designId: 'DA_busy' });
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
    if (target.endsWith('/canva')) return Response.json({ binding: { designId: 'DA_busy', version: 1 } });
    if (target.includes('/notifications/')) return Response.json({ ok: true });
    return Response.json({ tenantId: 'tenant', clientId: 'client' });
  });
}

const callsTo = (remote: ReturnType<typeof vi.fn>, test: (url: string) => boolean) =>
  remote.mock.calls.filter((c) => test(String(c[0])));
const starts = (remote: ReturnType<typeof vi.fn>) => callsTo(remote, (u) => u.endsWith('/canva/studio'));
const resumes = (remote: ReturnType<typeof vi.fn>) => callsTo(remote, (u) => u.includes('/canva/studio/') && u.endsWith('/resume'));
const notifications = (remote: ReturnType<typeof vi.fn>) =>
  callsTo(remote, (u) => u.includes('/notifications/canva-status')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a busy studio', () => {
  it('waits its turn and then designs, telling the requester nothing extra', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = busyCore({ busyStarts: 2 });
    const { ctx, steps, sleeps, journal } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result).toMatchObject({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', documentId: 'DA_busy' });
    expect(starts(remote)).toHaveLength(3);
    // Every try carries the same idempotency key: Core starts one run, never three.
    expect(new Set(starts(remote).map((c) => (c[1] as { headers: Record<string, string> }).headers['Idempotency-Key']))).toEqual(
      new Set(['workflow-studio-' + input.taskId])
    );
    expect(steps.slice(0, 4)).toEqual(['canva-verify-task-scope', 'canva-studio-start', 'canva-studio-start-after-busy-1', 'canva-studio-start-after-busy-2']);
    expect(sleeps.filter((ms) => ms === BUSY_WAIT_MS)).toHaveLength(2);
    // One message, the result: the wait itself is never announced.
    expect(notifications(remote)).toEqual([expect.objectContaining({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' })]);

    // A replay of the same journal asks for the same timers and makes no call to Core.
    const replayRemote = busyCore({ busyStarts: 2 });
    const replay = recordingContext(journal);
    expect((await runCanvaDraft(input, replay.ctx, replayRemote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(replayRemote).not.toHaveBeenCalled();
    expect(replay.sleeps).toEqual(sleeps);
  });

  it('ends the run as before once the studio has stayed busy for the whole window', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const remote = busyCore({ busyStarts: Number.POSITIVE_INFINITY });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result.status).toBe('DESIGN_SERVER_ERROR');
    expect(sleeps.filter((ms) => ms === BUSY_WAIT_MS).reduce((a, b) => a + b, 0)).toBe(BUSY_WINDOW_MS);
    expect(starts(remote)).toHaveLength(BUSY_WINDOW_MS / BUSY_WAIT_MS + 1);
    expect(resumes(remote)).toHaveLength(0);
    const told = notifications(remote);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ status: 'DESIGN_SERVER_ERROR', code: 'STUDIO_BUSY' });
    expect(told[0].detail).toContain('15 minutes');
  });

  it('waits on a busy resume too, and a report after the window still names the run', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const recovering = busyCore({ busyStarts: 0, busyResumes: 1 });
    const first = recordingContext();
    expect((await runCanvaDraft(input, first.ctx, recovering)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(first.steps).toContain('canva-studio-resume-0-after-busy-1');

    const stuck = busyCore({ busyStarts: 0, busyResumes: Number.POSITIVE_INFINITY });
    const second = recordingContext();
    expect((await runCanvaDraft(input, second.ctx, stuck)).status).toBe('DESIGN_SERVER_ERROR');
    expect(notifications(stuck)).toEqual([expect.objectContaining({ status: 'DESIGN_SERVER_ERROR', code: 'STUDIO_BUSY', runId: 'run-busy' })]);
  });
});

describe('step retry options', () => {
  it('leaves every Core step on the adapter default (the restart window) except the paid parity check', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const { ctx, options } = recordingContext();
    await runCanvaDraft(input, ctx, busyCore({ busyStarts: 0 }));

    expect(options.get('canva-parity-check')).toEqual({ maxRetryAttempts: 5 });
    const others = [...options.entries()].filter(([name]) => name !== 'canva-parity-check');
    expect(others.map(([name]) => name)).toEqual(expect.arrayContaining(['canva-studio-start', 'canva-studio-resume-0', 'canva-notify-canva_draft_ready_for_visual_review']));
    expect(others.filter(([, opts]) => opts !== undefined)).toEqual([]);
  });
});

describe('a change whose original design is still being made', () => {
  it('waits for the original instead of ending as a refused design', async () => {
    const { ctx, sleeps } = recordingContext();
    let refusals = 1;
    const base = busyCore({ busyStarts: 0 });
    const remote = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/canva/studio') && refusals-- > 0) {
        return Response.json({ title: 'PARENT_STILL_RUNNING', detail: 'The design this change is for is still being made.' }, { status: 409 });
      }
      return base(url, init);
    });
    const result = await runCanvaDraft(input, ctx, remote as unknown as typeof fetch);
    expect(result).toMatchObject({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' });
    expect(sleeps.filter((ms) => ms === BUSY_WAIT_MS)).toHaveLength(1);
  });
});
