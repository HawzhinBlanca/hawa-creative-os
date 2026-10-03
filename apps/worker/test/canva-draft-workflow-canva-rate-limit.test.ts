import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowInput } from '../src/design-input.js';

/**
 * Every automatic draft imports and exports through the office's one Canva connection, and Canva
 * limits imports and exports to 20 a minute per user (canva.dev, 2026-09-28). When Canva was still
 * refusing after the client's short retry (or asked for more than 30 s), Core recorded the import or
 * export as failed and the workflow ended the draft (DESIGN_FAILED, CANVA_PREVIEW_FAILED). Core now
 * answers 429 CANVA_RATE_LIMITED with Canva's wait, bounded, and the workflow waits it durably and asks
 * again under the same idempotency key, for up to 15 minutes.
 */

const input: WorkflowInput = {
  taskId: '00000000-0000-4000-c000-000000000004',
  tenantId: 'tenant',
  clientId: 'client',
  rawText: '',
  sourcePlatform: 'telegram',
  idempotencyKey: 'key',
  canvaAutoGenerate: true,
};

const WINDOW_MS = 15 * 60 * 1000;

function recordingContext(journal: Map<string, unknown> = new Map()) {
  const steps: string[] = [];
  const sleeps: number[] = [];
  const ctx = {
    key: 'wf-canva-rate-limit-test',
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

type Refusals = { generate?: number; planResume?: number; png?: number; pptx?: number };

/** A Core stand-in that answers 429 CANVA_RATE_LIMITED (Retry-After 20) the given number of times per call. */
function canvaLimitedCore(refusals: Refusals, opts: { retryAfter?: string; planned?: boolean; refusal?: { status: number; title: string } } = {}) {
  const left = { generate: 0, planResume: 0, png: 0, pptx: 0, ...refusals };
  const refuse = (which: keyof typeof left) => {
    if (left[which]-- <= 0) return null;
    const { status, title } = opts.refusal ?? { status: 429, title: 'CANVA_RATE_LIMITED' };
    return Response.json({ title, detail: 'Canva is refusing new requests for now.' }, { status, headers: status === 429 ? { 'Retry-After': opts.retryAfter ?? '20' } : {} });
  };
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/canva/generate')) {
      return refuse('generate') ?? Response.json(opts.planned ? { planId: 'plan-rl', status: 'submitted' } : { planId: 'plan-rl', status: 'retrieved', designId: 'DA_plan' });
    }
    if (target.includes('/canva/plans/plan-rl/resume')) return refuse('planResume') ?? Response.json({ planId: 'plan-rl', status: 'retrieved', designId: 'DA_plan' });
    if (target.endsWith('/canva/exports')) {
      const format = JSON.parse(String(init?.body)).format as 'png' | 'pptx';
      return (
        refuse(format) ??
        Response.json(
          format === 'pptx'
            ? { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }
            : { status: 'retrieved', artifact: { id: 'artifact' } }
        )
      );
    }
    if (target.includes('/canva/parity-check')) return Response.json({ parity: 'match' });
    if (target.endsWith('/canva')) return Response.json({ binding: { designId: 'DA_plan', version: 1 } });
    if (target.includes('/notifications/')) return Response.json({ ok: true });
    return Response.json({ tenantId: 'tenant', clientId: 'client' });
  });
}

const callsTo = (remote: ReturnType<typeof vi.fn>, match: (url: string, body: any) => boolean) =>
  remote.mock.calls.filter((c) => match(String(c[0]), c[1] && (c[1] as RequestInit).body ? JSON.parse(String((c[1] as RequestInit).body)) : undefined));
const keysOf = (calls: unknown[][]) => new Set(calls.map((c) => (c[1] as { headers: Record<string, string> }).headers['Idempotency-Key']));
const exportsOf = (remote: ReturnType<typeof vi.fn>, format: string) => callsTo(remote, (u, b) => u.endsWith('/canva/exports') && b?.format === format);
const notifications = (remote: ReturnType<typeof vi.fn>) => callsTo(remote, (u) => u.includes('/notifications/canva-status')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Canva still refusing with 429 after the client retried', () => {
  it('the preview export waits the time Core names and asks again under the same key, then the draft is ready', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ png: 2 });
    const { ctx, steps, sleeps, journal } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result).toMatchObject({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', documentId: 'DA_plan' });
    expect(exportsOf(remote, 'png')).toHaveLength(3);
    expect(keysOf(exportsOf(remote, 'png'))).toEqual(new Set(['workflow-preview-' + input.taskId]));
    expect(steps).toEqual(expect.arrayContaining(['canva-export-preview', 'canva-export-preview-after-busy-1', 'canva-export-preview-after-busy-2']));
    expect(sleeps).toEqual([20000, 20000]);
    expect(notifications(remote)).toEqual([expect.objectContaining({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' })]);

    // A replay of the journal asks for the same timers and calls Core for nothing.
    const replayRemote = canvaLimitedCore({ png: 2 });
    const replay = recordingContext(journal);
    expect((await runCanvaDraft(input, replay.ctx, replayRemote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(replayRemote).not.toHaveBeenCalled();
    expect(replay.sleeps).toEqual(sleeps);
  });

  it('the copy and font check export waits the same way', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ pptx: 1 }, { retryAfter: '7' });
    const { ctx, steps, sleeps } = recordingContext();

    expect((await runCanvaDraft(input, ctx, remote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(keysOf(exportsOf(remote, 'pptx'))).toEqual(new Set(['workflow-check-' + input.taskId]));
    expect(exportsOf(remote, 'pptx')).toHaveLength(2);
    expect(steps).toContain('canva-export-copy-font-check-after-busy-1');
    expect(sleeps).toEqual([7000]);
  });

  it('an import refused inside the generation waits, and the same generation key imports the one saved plan', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ generate: 2 });
    const { ctx, sleeps } = recordingContext();

    expect((await runCanvaDraft(input, ctx, remote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    const generations = callsTo(remote, (u) => u.endsWith('/canva/generate'));
    expect(generations).toHaveLength(3);
    expect(keysOf(generations)).toEqual(new Set(['workflow-' + input.taskId]));
    expect(sleeps).toEqual([20000, 20000]);
  });

  it('an import refused while the plan is resumed waits too', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ planResume: 1 }, { planned: true });
    const { ctx, steps, sleeps } = recordingContext();

    expect((await runCanvaDraft(input, ctx, remote)).status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(steps).toEqual(expect.arrayContaining(['canva-resume-draft-0', 'canva-resume-draft-0-after-busy-1']));
    // The poll's own 2 s wait, then the named 20 s.
    expect(sleeps).toEqual([2000, 20000]);
  });

  it('ends the draft as a failed preview, naming the rate limit, when Canva refuses for the whole window', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ png: Number.POSITIVE_INFINITY }, { retryAfter: '30' });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result).toMatchObject({ status: 'CANVA_PREVIEW_FAILED', documentId: 'DA_plan' });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(WINDOW_MS);
    expect(exportsOf(remote, 'png')).toHaveLength(WINDOW_MS / 30000 + 1);
    expect(exportsOf(remote, 'pptx')).toHaveLength(0);
    const told = notifications(remote);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ status: 'CANVA_PREVIEW_FAILED', code: 'CANVA_RATE_LIMITED', designId: 'DA_plan' });
    expect(told[0].detail).toMatch(/Canva/);
    expect(told[0].detail).toContain('15 minutes');
  });

  it('an import still refused after the window ends the draft naming the rate limit, not a planning slot', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ generate: Number.POSITIVE_INFINITY }, { retryAfter: '30' });
    const { ctx } = recordingContext();

    expect((await runCanvaDraft(input, ctx, remote)).status).toBe('DESIGN_SERVER_ERROR');
    const told = notifications(remote);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ status: 'DESIGN_SERVER_ERROR', code: 'CANVA_RATE_LIMITED' });
    expect(told[0].detail).toMatch(/Canva/);
    expect(told[0].detail).not.toMatch(/planning slot/);
  });

  it('any other refusal of an export stays final: no wait, no second request', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const remote = canvaLimitedCore({ png: 1 }, { refusal: { status: 409, title: 'CANVA_EXPORT_PENDING' } });
    const { ctx, sleeps } = recordingContext();

    const result = await runCanvaDraft(input, ctx, remote);

    expect(result.status).toBe('CANVA_PREVIEW_FAILED');
    expect(exportsOf(remote, 'png')).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(notifications(remote)).toEqual([expect.objectContaining({ status: 'CANVA_PREVIEW_FAILED', code: 'CANVA_EXPORT_PENDING' })]);
  });
});
