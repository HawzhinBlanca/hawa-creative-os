import { useMemoryVisualInputs } from '../test-support/studio-visual-input-fixture.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';
import { questionButtons, composeDesignerHandoff } from '../src/services/requester-actions.js';

/**
 * One question before a change is made, when an ask could mean visibly different designs (ADR-032
 * §2.4, the clarify rule): "less empty space" is bigger photos or bigger text, and a wrong guess
 * costs the requester a round. Otherwise the edit acts and says how it read the ask.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };

const parentLayout = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [],
  text: [
    { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
  logo: { x: 840, y: 1160, width: 168, height: 118 },
} as unknown as StudioLayoutV2;

const emptier = { ask: 'less empty space', elements: ['all'], restyle: false, possible: true, reason: '', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'], assumption: '', copyEdits: [] };
const moveLogo = { ask: 'move the logo to the left', elements: ['logo'], restyle: false, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] };

const harness = (opts: { asks: unknown[]; clarified?: boolean; frustrated?: boolean }) => {
  const run: any = {
    id: randomUUID(),
    tenant_id: scope.tenantId,
    task_id: randomUUID(),
    client_id: 'c1000000-0000-4000-8000-000000000002',
    actor_id: scope.actorId,
    status: 'conceiving',
    stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
    budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
    request: {
      width: 1080,
      height: 1350,
      pipelineV3: true,
      instructions: 'x',
      copyBlocks: [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }],
      directed: {
        parentTaskId: randomUUID(),
        revisionDirective: opts.clarified ? 'less empty space, and move the logo left\n\nAsked "Fill the space with what?", the client answered: bigger logo' : 'less empty space, and move the logo left',
        ...(opts.clarified ? { clarified: true } : {}),
      },
    },
  };
  const writes: any[] = [];
  const repo = {
    getCallsForRun: async () => [],
    getRunById: async () => run,
    updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
      writes.push({ status, ...extra });
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      return run;
    },
    insertCandidate: async (c: any) => c,
    updateCandidate: async (_id: string, _t: string, u: any) => u,
    getCandidatesForRun: async () => [],
    recordCallStart: async () => ({}),
    finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) => {
    if (params.schemaName === 'EditTargets') return { data: { targets: ['logo'], asks: opts.asks, frustrated: opts.frustrated === true }, receipt: {} };
    return {
      data: { layout: { ...JSON.parse(JSON.stringify(parentLayout)), logo: { x: 72, y: 1160, width: 168, height: 118 } }, changes: [{ element: 'logo', before: 'right', after: 'left', why: 'asked' }] },
      receipt: {},
    };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  useMemoryVisualInputs(service);
  // Stage-only harness: task admission/RLS is covered by studio-run-guards and DB integration tests.
  vi.spyOn(service as any, 'assertTaskCanGenerate').mockResolvedValue(undefined);
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).imagesForRun = async () => [];
  (service as any).activeRunsOfTask = async () => 0;
  (service as any).earlierAsks = async () => [];
  (service as any).parentWinner = async () => ({ runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(parentLayout)), concept: { id: 'c', archetype: 'split-band' } });
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true,
  });
  const go = async () => {
    await service.resume(scope as any, run.task_id, run.id);
    return (await service.resume(scope as any, run.task_id, run.id)) as any;
  };
  return { run, writes, completeJson, go };
};

describe('an ask that could mean different designs is asked about once, before anything is paid', () => {
  it('stops before the edit with one question and its answers; the whole request waits for it', async () => {
    const { run, writes, completeJson, go } = harness({ asks: [emptier, moveLogo] });
    const res = await go();
    expect(res).toMatchObject({ status: 'failed', code: 'NEEDS_CLARIFICATION' });
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const stages = JSON.parse(run.stages);
    expect(stages.directed.refused).toBe('NEEDS_CLARIFICATION');
    expect(stages.directed.clarify).toEqual({ ask: 'less empty space', question: 'Fill the space with what?', options: ['bigger title text', 'bigger logo'] });
    expect(stages.directed.asks.map((a: any) => a.status)).toEqual(['asked', 'asked']);
    expect(stages.directedFailed).toBeUndefined();
    expect(writes.at(-1).diagnostic).toMatch(/stopped at stage laying_out: A question was sent/);
  });

  it('asks nothing once the requester has answered: the edit is made with the answer in it', async () => {
    const { run, completeJson, go } = harness({ asks: [emptier, moveLogo], clarified: true });
    const res = await go();
    expect(res.code).toBeUndefined();
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets', 'DirectedEdit']);
    const analysis = String((completeJson.mock.calls[0] as any)[0].prompt);
    expect(analysis).toContain('already answered a question about this request');
    expect(analysis).toContain('the client answered: bigger logo');
    expect(JSON.parse(run.stages).directed.clarify).toBeUndefined();
  });

  it('an ask read one way says how it was read, in the note the requester gets', async () => {
    const readAs = { ...emptier, question: '', options: [], assumption: 'the logo made bigger to fill the space' };
    const { run, go } = harness({ asks: [{ ...readAs, elements: ['logo'] }] });
    await go();
    const stages = JSON.parse(run.stages);
    expect(stages.directed.asks).toEqual([{ ask: 'less empty space', status: 'done', by: 'model', assumption: 'the logo made bigger to fill the space' }]);
    expect(requesterDraftNotes({ run, candidates: [] } as any)).toContain('✅ Done: less empty space (read as: the logo made bigger to fill the space).');
  });

  it('a question needs two answers; one answer is acted on, not asked', async () => {
    const { run, go } = harness({ asks: [{ ...emptier, elements: ['logo'], options: ['bigger logo'] }] });
    const res = await go();
    expect(res.code).toBeUndefined();
    expect(JSON.parse(run.stages).directed.asks[0].status).toBe('done');
  });

  it('a requester losing patience is recorded, for the office', async () => {
    const { run, go } = harness({ asks: [moveLogo], frustrated: true });
    await go();
    expect(JSON.parse(run.stages).directed.frustrated).toBe(true);
    const handoff = composeDesignerHandoff({ taskId: run.task_id, title: 'KAAE', asks: [], rounds: 2, why: 'frustrated' });
    expect(handoff.text).toContain('The requester sounds frustrated');
  });
});

describe('the question the requester reads', () => {
  const taskId = '00000000-0000-4000-c000-000000000009';
  it('says nothing was made, lists the answers as buttons, and offers a designer', () => {
    const msg = composeCanvaStatusMessage({
      taskId,
      status: 'DESIGN_REJECTED',
      code: 'NEEDS_CLARIFICATION',
      question: { question: 'Fill the space with what?', options: ['bigger title text', 'bigger <logo>'] },
      notPossible: [{ ask: 'cut the panelists out', reason: 'a designer is needed' }],
    });
    // ADR-145 (#27): the question in plain words; no "reply to this message".
    expect(msg.text).toContain('One question about your design before I make your change');
    expect(msg.text).toContain('Tap an answer below, or answer in your own words.');
    expect(msg.text).not.toMatch(/reply to/i);
    expect(msg.text).toContain('Fill the space with what?');
    expect(msg.text).toContain('2. bigger &lt;logo&gt;');
    expect(msg.text).toContain('• cut the panelists out (a designer is needed)');
    const data = msg.reply_markup!.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : b.url));
    expect(data).toEqual([`rq:a1:${taskId}`, `rq:a2:${taskId}`, `rq:dsg:${taskId}`]);
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });

  it('offers at most three answer buttons, each cut to fit', () => {
    // The press is no longer read by any intake (ADR-135 stage 2 answers it as a stale reply); the
    // buttons are still composed on Core's own Canva outcome message.
    const rows = questionButtons(taskId, ['x'.repeat(80), 'y', 'z', 'w']);
    const data = rows.flat().map((b) => ('callback_data' in b ? b.callback_data : b.url));
    expect(data).toEqual([`rq:a1:${taskId}`, `rq:a2:${taskId}`, `rq:a3:${taskId}`, `rq:dsg:${taskId}`]);
    expect(rows.flat()[0].text).toHaveLength(60);
  });
});
