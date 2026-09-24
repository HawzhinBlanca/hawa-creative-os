import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { FakeObjectContext } from '../../../packages/testkit/src/fake-restate-context.js';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import type { WorkflowDurableContext } from '../src/durable-context.js';
import { readDesignRunInput, runDesign, runInputReader, type DesignRunContext, type DesignRunDeps, type DesignRunInput } from '../src/lifecycle/design-run.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * DesignRun (architecture programme Phase 2, slice 2.3 part B; PHASE2_DESIGN.md 2.4): today's design
 * run, reporting its outcome to the request's RequestLifecycle as a journaled one-way send instead of
 * posting it to Core, and reading its brief from the request's recorded task.created row.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const token = ['design', 'run', 'test', 'bearer'].join('_');
const requestId = '5a1f0c3e-2b7d-5c11-8e42-0f6d1a2b3c4d';

const inputFor = (taskId: string, extra: Partial<DesignRunInput> = {}): DesignRunInput => ({
  v: 1, taskId, tenantId, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` }, ...extra,
});

const facts = { rawText: 'Staff meeting', canvaAutoGenerate: true, canvaVariant: { width: 1080, height: 1350 }, designStudio: false, studioOptions: undefined, sourcePlatform: 'telegram', clientId };

/** The fake context as the durable context runCanvaDraft is written against. */
const durableOf = (ctx: FakeObjectContext, override: Partial<WorkflowDurableContext> = {}) => (): WorkflowDurableContext => ({
  key: ctx.key,
  run: (name, action, options) => ctx.run(name, action, options),
  sleep: (ms) => ctx.sleep(ms),
  ...override,
});

const designFinishedSends = (ctx: FakeObjectContext) => ctx.sends.filter((s) => s.service === 'RequestLifecycle');

const saved = process.env.HAWA_BEARER_TOKEN;
beforeAll(() => { process.env.HAWA_BEARER_TOKEN = token; });
afterAll(() => { if (saved === undefined) delete process.env.HAWA_BEARER_TOKEN; else process.env.HAWA_BEARER_TOKEN = saved; });

describe('DesignRun: starting a run', () => {
  it('reads its brief in a journaled step and runs the design with the run id as its key; a re-drive keeps its attempt', async () => {
    const taskId = randomUUID();
    const ctx = new FakeObjectContext({ key: `dr-${taskId}-a2` });
    const seen: WorkflowInput[] = [];
    const deps: DesignRunDeps = {
      readRunInput: async (t, task) => { expect([t, task]).toEqual([tenantId, taskId]); return facts; },
      draft: async (input) => { seen.push(input); return { taskId, status: 'X', qcPassed: false, auditEventsCount: 0, executedSteps: [], replayedSteps: [] }; },
    };
    await runDesign(ctx as unknown as DesignRunContext, inputFor(taskId, { redriveAttempt: 2, lifecycle: { requestId, round: 3, runId: `dr-${taskId}-a2` } }), deps, durableOf(ctx));
    expect(ctx.journal.filter((e) => e.kind === 'run').map((e) => (e as { name: string }).name)).toEqual(['run-input']);
    expect(seen).toEqual([{ ...facts, taskId, tenantId, idempotencyKey: `dr-${taskId}-a2`, requesterToldAtIntake: false, redriveAttempt: 2 }]);
  });

  it('with no recorded brief it reports DESIGN_REJECTED to the lifecycle, and runs nothing', async () => {
    const taskId = randomUUID();
    const ctx = new FakeObjectContext({ key: `dr-${taskId}` });
    let ran = false;
    await runDesign(ctx as unknown as DesignRunContext, inputFor(taskId), { readRunInput: async () => null, draft: async () => { ran = true; throw new Error('no'); } }, durableOf(ctx));
    expect(ran).toBe(false);
    expect(designFinishedSends(ctx).map((s) => [s.key, s.handler, s.idempotencyKey, (s.arg as { report: { status: string; code: string } }).report])).toEqual([
      [requestId, 'designFinished', `dr-finished:dr-${taskId}`, expect.objectContaining({ status: 'DESIGN_REJECTED', code: 'RUN_INPUT_MISSING' })],
    ]);
  });

  it('refuses a malformed input for good', () => {
    expect(() => readDesignRunInput({ v: 1, taskId: 't' })).toThrow(restate.TerminalError);
    expect(() => readDesignRunInput({ ...inputFor('t'), v: 2 })).toThrow(/v1/);
  });
});

describe('DesignRun: the outcome goes to RequestLifecycle, never to Core', () => {
  it('a refused scope check is reported as designFinished, exactly once, and Core\'s canva-status is never called', async () => {
    const taskId = randomUUID();
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ title: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const ctx = new FakeObjectContext({ key: `dr-${taskId}` });
    const deps: DesignRunDeps = {
      readRunInput: async () => facts,
      draft: (input, dctx, _f, recordOutcome, report) => runCanvaDraft(input, dctx, fetcher, recordOutcome, report),
    };
    const out = await runDesign(ctx as unknown as DesignRunContext, inputFor(taskId), deps, durableOf(ctx));
    expect(out.status).toBe('DESIGN_REJECTED');
    expect(urls.some((u) => /canva-status/.test(u))).toBe(false);
    const sends = designFinishedSends(ctx);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ key: requestId, handler: 'designFinished', idempotencyKey: `dr-finished:dr-${taskId}` });
    expect(sends[0].arg).toMatchObject({ v: 1, eventId: `dr-finished:dr-${taskId}`, runId: `dr-${taskId}`, round: 0, taskId, report: { status: 'DESIGN_REJECTED', code: 'NOT_FOUND' } });
  });

  it('a run cancelled mid-studio abandons the studio run and reports CANCELLED', async () => {
    const taskId = randomUUID();
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      const u = String(url);
      urls.push(u);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.endsWith(`/v1/tasks/${taskId}`)) return json({ id: taskId, clientId, tenantId });
      if (u.endsWith('/canva/studio')) return json({ runId: 'studio-1', status: 'layout' });
      if (u.includes('/canva/studio/studio-1/abandon')) return json({ abandoned: true });
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const ctx = new FakeObjectContext({ key: `dr-${taskId}` });
    let sleeps = 0;
    const cancelOnFirstSleep = durableOf(ctx, { sleep: async () => { if (sleeps++ === 0) throw new restate.CancelledError(); } });
    const deps: DesignRunDeps = {
      readRunInput: async () => ({ ...facts, designStudio: true }),
      draft: (input, dctx, _f, recordOutcome, report) => runCanvaDraft(input, dctx, fetcher, recordOutcome, report),
    };
    const out = await runDesign(ctx as unknown as DesignRunContext, inputFor(taskId), deps, cancelOnFirstSleep);
    expect(out.status).toBe('CANCELLED');
    expect(urls.filter((u) => /abandon/.test(u))).toHaveLength(1);
    expect(urls.some((u) => /resume|canva-status/.test(u))).toBe(false);
    expect(designFinishedSends(ctx).map((s) => (s.arg as { report: { status: string } }).report.status)).toEqual(['CANCELLED']);
  });

  it('without a report, runCanvaDraft still reports to Core as before (TaskWorkflow)', async () => {
    const taskId = randomUUID();
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(String(url)); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
    const ctx = new FakeObjectContext({ key: `task-wf-${taskId}` });
    const out = await runCanvaDraft({ taskId, tenantId, rawText: 'x', sourcePlatform: 'telegram', idempotencyKey: 'k', canvaAutoGenerate: true }, durableOf(ctx)(), fetcher);
    expect(out.status).toBe('CLIENT_REQUIRED');
    expect(urls.filter((u) => /notifications\/canva-status$/.test(u))).toHaveLength(1);
  });
});

describe('DesignRun: the brief from the recorded task.created row', () => {
  let db: Kysely<Database>;
  const rows: string[] = [];
  beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
  afterEach(async () => {
    if (!rows.length) return;
    await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      sql`DELETE FROM hawa.outbox_commands WHERE idempotency_key = ANY(${rows})`.execute(trx));
    rows.length = 0;
  });
  afterAll(async () => { await db?.destroy(); });

  it('reads the fields the dispatcher sends TaskWorkflow, without the pictures', async () => {
    const taskId = randomUUID();
    const key = `lc-test:${taskId}`;
    rows.push(key);
    const payload = {
      sourcePlatform: 'telegram', rawRequestText: 'Staff meeting Sunday', workflow: 'canva', autoGenerate: true, clientId,
      variant: { width: 1080, height: 1350 }, designStudio: true, studioOptions: { tier: 'quality', referenceImageBase64: 'QUJD' }, referenceImageBase64: 'QUJD',
    };
    await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state, delivered_at, available_at, last_error)
        VALUES (${tenantId}::uuid, 'task', ${taskId}::uuid, 'task.created', ${key}, ${JSON.stringify(payload)}::jsonb, 'delivered', now(), now(), 'OWNED_BY_LIFECYCLE')`.execute(trx));
    const read = await runInputReader(db)(tenantId, taskId);
    expect(read).toEqual({
      rawText: 'Staff meeting Sunday', canvaAutoGenerate: true, canvaVariant: { width: 1080, height: 1350 }, designStudio: true,
      studioOptions: { tier: 'quality' }, sourcePlatform: 'telegram', clientId,
    });
    expect(await runInputReader(db)(tenantId, randomUUID())).toBeNull();
  });
});
