import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { movedUntargeted, withPlacesOf } from '../src/services/design-studio/stages/edit.stage.js';
import { requesterDraftNotes, studioStatusNote } from '../src/services/design-studio/studio-status-note.js';

/**
 * Two guards on a change to a design (ADR-032 plan 2.3 and 2.5): nothing the request did not name
 * moves, unless it has to make room, and then the sender is told; and a yes/no look at before and
 * after says whether each ask shows, as advice for the office beside the recorded outcome.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
const ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

const moveLogo = { ask: 'move the logo to the left', elements: ['logo'], restyle: false, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const harness = (editReply: unknown, visual?: (params: any) => unknown) => {
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
      directed: { parentTaskId: randomUUID(), revisionDirective: 'move the logo to the left' },
    },
  };
  const updated: any[] = [];
  const repo = {
    getRunById: async () => run,
    updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      return run;
    },
    insertCandidate: async (c: any) => c,
    updateCandidate: async (_id: string, _t: string, u: any) => {
      updated.push(u);
      return u;
    },
    getCandidatesForRun: async () => [],
    recordCallStart: async () => ({}),
    finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) => {
    if (params.schemaName === 'EditTargets') return { data: { targets: ['logo'], asks: [moveLogo], frustrated: false }, receipt: {} };
    if (params.schemaName === 'VisualCheck') {
      if (!visual) throw new Error('no visual check in this test');
      return { data: visual(params), receipt: {} };
    }
    return { data: clone(editReply), receipt: {} };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).imagesForRun = async () => [];
  (service as any).activeRunsOfTask = async () => 0;
  (service as any).earlierAsks = async () => [];
  (service as any).parentWinner = async () => ({ runId: 'parent-run', candidateId: 'parent-cand', layout: clone(parentLayout), previewPng: ONE_PIXEL, concept: { id: 'c', archetype: 'split-band' } });
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, pipelineV3: true,
  });
  const go = async () => {
    await service.resume(scope as any, run.task_id, run.id);
    await service.resume(scope as any, run.task_id, run.id);
    return { stages: JSON.parse(run.stages), layout: updated.find((u) => u.layouts)?.layouts?.[0] as StudioLayoutV2 | undefined };
  };
  return { run, go, completeJson };
};

describe('the places of what the request did not name', () => {
  it('are compared by place and size only, and put back without touching anything else', () => {
    const edited = clone(parentLayout);
    edited.logo = { x: 72, y: 1160, width: 168, height: 118 };
    edited.text[1] = { ...edited.text[1], y: 700, color: '#F7B500' };
    expect(movedUntargeted(parentLayout, edited, ['logo'])).toEqual(['text:1']);
    expect(movedUntargeted(parentLayout, edited, ['all'])).toEqual([]);
    const back = withPlacesOf(parentLayout, edited, ['text:1']);
    expect(back.text[1]).toMatchObject({ y: 520, color: '#F7B500' });
    expect(back.logo).toEqual(edited.logo);
  });
});

describe('an edit that moved something unasked', () => {
  it('has it put back when the design still passes, and says nothing moved', async () => {
    const reply = clone(parentLayout);
    reply.logo = { x: 72, y: 1160, width: 168, height: 118 };
    reply.text[1] = { ...reply.text[1], y: 640 };
    const { go } = harness({ layout: reply, changes: [{ element: 'logo', before: 'right', after: 'left', why: 'asked' }] });
    const { stages, layout } = await go();
    expect(layout?.logo).toMatchObject({ x: 72 });
    expect(layout?.text.find((t) => t.copyIndex === 1)).toMatchObject({ y: 520 });
    expect(stages.directed.sideEffects).toBeUndefined();
  });

  it('keeps it moved when putting it back would break the design, and tells the sender it made room', async () => {
    const reply = clone(parentLayout);
    // The logo takes the date's place; the date moves down to make room for it.
    reply.logo = { x: 72, y: 500, width: 168, height: 118 };
    reply.text[1] = { ...reply.text[1], y: 700 };
    const { run, go } = harness({ layout: reply, changes: [{ element: 'logo', before: 'bottom right', after: 'left', why: 'asked' }] });
    const { stages, layout } = await go();
    expect(layout?.text.find((t) => t.copyIndex === 1)).toMatchObject({ y: 700 });
    expect(stages.directed.sideEffects).toEqual(['the date']);
    expect(requesterDraftNotes({ run, candidates: [] } as any)).toContain('To make room, this also moved: the date. Nothing else changed.');
  });
});

describe('the visual check', () => {
  it('looks at before and after once, and records its verdict beside the outcome without changing it', async () => {
    const reply = clone(parentLayout);
    reply.logo = { x: 72, y: 1160, width: 168, height: 118 };
    const { run, go, completeJson } = harness({ layout: reply, changes: [] }, () => ({ verdicts: [{ index: 1, made: false, why: 'the logo is still on the right' }] }));
    const { stages } = await go();
    const call = completeJson.mock.calls.find((c: any) => c[0].schemaName === 'VisualCheck') as any;
    expect(call[0].images).toHaveLength(2);
    expect(call[0].prompt).toContain('1. move the logo to the left');
    expect(stages.directed.asks).toEqual([{ ask: 'move the logo to the left', status: 'done', by: 'model', seen: { made: false, why: 'the logo is still on the right' } }]);
    const office = studioStatusNote({ run, candidates: [] } as any);
    expect(office).toContain('visual check: 0 of 1 agree; ⚠️ not seen made: move the logo to the left');
    // The requester's note reads the outcome, not the advice.
    expect(requesterDraftNotes({ run, candidates: [] } as any)).toContain('✅ Done: move the logo to the left.');
  });

  it('that fails leaves the asks unchecked, and the edit made', async () => {
    const reply = clone(parentLayout);
    reply.logo = { x: 72, y: 1160, width: 168, height: 118 };
    const { go } = harness({ layout: reply, changes: [] });
    const { stages, layout } = await go();
    expect(layout?.logo).toMatchObject({ x: 72 });
    expect(stages.directed.asks).toEqual([{ ask: 'move the logo to the left', status: 'done', by: 'model' }]);
  });
});

describe('a photo shown much larger than its own pixels', () => {
  it('is named to the requester, with its size; a sharp one, a cut-out or an unknown size is not', async () => {
    const { softPhotoNotes } = await import('../src/services/design-studio/studio-status-note.js');
    const photos = [
      { photoIndex: 0, x: 0, y: 0, width: 1080, height: 1350 },
      { photoIndex: 1, x: 0, y: 0, width: 400, height: 400 },
      { photoIndex: 2, x: 0, y: 0, width: 1080, height: 1350, treatment: 'cutout' },
      { photoIndex: 3, x: 0, y: 0, width: 1080, height: 1350 },
    ];
    const notes = softPhotoNotes(photos, [{ width: 480, height: 640 }, { width: 1280, height: 960 }, { width: 200, height: 300 }, null]);
    expect(notes).toEqual(['⚠️ Photo 1 is small for its place on the design (480×640 pixels, shown about 2.3 times larger), so it may look soft. Send a larger version if you have one.']);
  });
});
