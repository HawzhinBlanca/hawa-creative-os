import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, PNG, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { applyOp, verifyOp, opParams, type OpContext } from '../src/services/design-studio/edit-ops.js';

/** Bug hunt on b2bbbb8: rules measured from the parent (base), and scopeFor(ruled). */
const palette = ['#0A2A6B', '#F7B500', '#FFFFFF'];
const ctx: OpContext = { palette, cutoutAvailable: (i) => i === 1, copy: ['MEET KAAE AT SAGACON 2026', 'September 25, 2026'] };

const design = (): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#0A2A6B' },
    shapes: [],
    text: [
      { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
      { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
    ],
    logo: { x: 840, y: 1160, width: 168, height: 118 },
    photos: [
      { photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 400, height: 520 },
      { photoIndex: 1, role: 'portrait', x: 568, y: 700, width: 400, height: 520 },
    ],
  }) as unknown as StudioLayoutV2;

const noPhotos = () => {
  const d = design();
  d.photos = [];
  return d;
};

const runEdit = async (opts: { parent: StudioLayoutV2; asks: unknown[]; reply?: (params: any) => unknown; photos?: unknown[] }) => {
  const run: any = {
    id: randomUUID(), tenant_id: '00000000-0000-4000-a000-000000000001', task_id: randomUUID(), client_id: 'c1000000-0000-4000-8000-000000000002', actor_id: 'a',
    status: 'conceiving',
    stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
    budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
    request: { width: 1080, height: 1350, pipelineV3: true, instructions: 'x', copyBlocks: [{ text: ctx.copy[0], script: 'latin' }, { text: ctx.copy[1], script: 'latin' }], directed: { parentTaskId: randomUUID(), revisionDirective: 'x' } },
  };
  const updated: any[] = [];
  const repo = {
    getRunById: async () => run,
    updateRunStatus: async (_i: string, _t: string, status: string, extra: any = {}) => { run.status = status; if (extra.stages) run.stages = JSON.stringify(extra.stages); return run; },
    insertCandidate: async (c: any) => c,
    updateCandidate: async (_i: string, _t: string, u: any) => { updated.push(u); return u; },
    getCandidatesForRun: async () => [], recordCallStart: async () => ({}), finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) => {
    if (params.schemaName === 'EditTargets') return { data: { targets: [], asks: opts.asks, frustrated: false }, receipt: {} };
    if (params.schemaName === 'VisualCheck') throw new Error('no check');
    return { data: opts.reply ? opts.reply(params) : { layout: structuredClone(opts.parent), changes: [] }, receipt: {} };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  Object.assign(service as any, {
    repo, attachedImage: async () => undefined, imagesForRun: async () => [], activeRunsOfTask: async () => 0, earlierAsks: async () => [],
    parentWinner: async () => ({ runId: 'p', candidateId: 'pc', layout: structuredClone(opts.parent), concept: { id: 'c', archetype: 'split-band' } }),
    createStageContext: (_s: any, r: any) => ({
      runId: r.id, tenantId: r.tenant_id, taskId: r.task_id, clientId: r.client_id, actorId: 'a', width: 1080, height: 1350, tier: 'standard', instructions: 'x',
      copyBlocks: r.request.copyBlocks, referencePack: { palette }, promotedRules: 'None',
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true, ...(opts.photos ? { photos: opts.photos } : {}),
    }),
  });
  await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
  const res: any = await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
  return { res, run, completeJson, layout: updated.find((u) => u.layouts)?.layouts?.[0] as StudioLayoutV2 | undefined, stages: () => JSON.parse(run.stages) };
};
const ask = (a: string, op: string, params: Record<string, unknown>, elements: string[], restyle = false) =>
  ({ ask: a, op, params, elements, restyle, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] });

describe('review of 2026-09-24: logo size step measured from the parent', () => {
  it('"move the logo to the top left" then "make it bigger": the size step puts the logo back where the parent had it', () => {
    const parent = design();
    const layout = design();
    expect(applyOp(layout, 'logo_move_or_scale', opParams({ corner: 'top-left' }), ctx, parent)).toEqual({ ok: true });
    expect(layout.logo).toMatchObject({ x: 72, y: 72 });
    expect(applyOp(layout, 'logo_move_or_scale', opParams({ direction: 'bigger' }), ctx, parent)).toEqual({ ok: true });
    // Expected: still top-left, bigger. Actual: anchored to the parent's bottom-right place.
    expect(layout.logo).toMatchObject({ x: 72, y: 72 });
  });

  it('the same two asks through the edit stage: the corner ask is reported not done', async () => {
    const parent = noPhotos();
    const { layout, stages, completeJson } = await runEdit({
      parent,
      asks: [
        ask('move the logo to the top left', 'logo_move_or_scale', { corner: 'top-left' }, ['logo']),
        ask('make the logo bigger', 'logo_move_or_scale', { direction: 'bigger' }, ['logo']),
      ],
    });
    expect(layout?.logo).toMatchObject({ x: 72, y: 72 });
    expect(stages().directed.asks.map((a: any) => a.status)).toEqual(['done', 'done']);
  });

  it('a logo move the edit model made (not a rule) is undone by reapply of a size rule', async () => {
    const parent = noPhotos();
    const { layout, completeJson, stages } = await runEdit({
      parent,
      asks: [
        ask('make the logo bigger', 'logo_move_or_scale', { direction: 'bigger' }, ['logo']),
        ask('put the logo beside the date', 'move', {}, ['logo']),
      ],
      // The model moves the (already bigger) logo beside the date.
      reply: (params: any) => {
        const l = JSON.parse(String(params.prompt).split('Current layout JSON:\n')[1].split('\n\nYour previous')[0]);
        // Beside the date: level with its top, against the right margin (on the grid, so hard QA passes).
        l.logo = { ...l.logo, x: 1080 - 72 - l.logo.width, y: 520 };
        return { layout: l, changes: [{ element: 'logo', before: '', after: 'beside the date' }] };
      },
    });
    expect(completeJson.mock.calls.some((c: any) => c[0].schemaName === 'DirectedEdit')).toBe(true);
    expect(layout?.logo).toMatchObject({ x: 1080 - 72 - (layout?.logo?.width ?? 0), y: 520 });
    expect(layout?.logo?.width).toBeGreaterThan(168);
  });
});

describe('review of 2026-09-24: photo zoom out', () => {
  it('zoom out on all photos, one already uncropped: the rule is made but its own check says not done', () => {
    const parent = design();
    parent.photos![0].zoom = 1.69;
    const layout = structuredClone(parent);
    const p = opParams({ zoom: 'out' });
    expect(applyOp(layout, 'photo_crop', p, ctx, parent)).toEqual({ ok: true });
    expect(layout.photos![0].zoom).toBe(1.3);
    expect(verifyOp(parent, layout, 'photo_crop', p, ctx)).toBe(true);
  });
});

describe('review of 2026-09-24: "show more of the photos" on a design whose heads were matched', () => {
  it('is made by the rule on the zoomed photo, then reported not done after a paid edit call', async () => {
    const png = new PNG({ width: 200, height: 260 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 120, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const photo = { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes, mimeType: 'image/png' as const, width: 200, height: 260 };
    const parent = design();
    // alignFramedHeads tightened one portrait to match the other's head size; the other is uncropped.
    parent.photos![0].zoom = 1.69;
    const { layout, completeJson, stages } = await runEdit({ parent, photos: [photo, photo], asks: [ask('show more of the photos', 'photo_crop', { zoom: 'out' }, ['photos'])] });
    const calls = completeJson.mock.calls.map((c: any) => c[0].schemaName);
    const asks = stages().directed.asks.map((a: any) => [a.ask, a.status, a.by]);
    expect(calls).toEqual(['EditTargets']);
    expect(asks).toEqual([['show more of the photos', 'done', 'rule']]);
  });
});

describe('review of 2026-09-24: photos guarded one by one', () => {
  it('a change to photo 2, named as the analysis names photos, still lets photo 1 move unreported', async () => {
    const png = new PNG({ width: 200, height: 260 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 120, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const photo = { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes, mimeType: 'image/png' as const, width: 200, height: 260 };
    const parent = design();
    const { layout, stages } = await runEdit({
      parent, photos: [photo, photo],
      // The analysis can only name 'photos' (TARGET_PATTERN); the params say which one.
      asks: [ask('make photo 2 black and white', 'photo_filter', { photos: [1], filter: 'bw' }, ['photos'], true), ask('spread the text out', 'align_or_spacing', {}, ['text:0', 'text:1'])],
      // The model also moves photo 1, which nobody asked about.
      reply: (params: any) => {
        const l = JSON.parse(String(params.prompt).split('Current layout JSON:\n')[1].split('\n\nYour previous')[0]);
        l.photos[0] = { ...l.photos[0], x: 100, y: 760 };
        return { layout: l, changes: [] };
      },
    });
    const moved = layout?.photos?.[0].x !== 72 || layout?.photos?.[0].y !== 700;
    expect(moved ? (stages().directed.sideEffects ?? []) : ['put back']).not.toEqual([]);
  });
});

describe('review of 2026-09-24: an ask the checks undid is not given back to the edit model', () => {
  it('the model is told the undone ask is "already made" and given an empty list of changes', async () => {
    const parent = noPhotos();
    const { completeJson } = await runEdit({
      parent,
      // Navy date on the navy background: made by the rule, undone by settling (contrast).
      asks: [ask('make the date navy', 'text_colour', { text: 1, colour: '#0A2A6B' }, ['text:1'], true)],
    });
    const edit = completeJson.mock.calls.find((c: any) => c[0].schemaName === 'DirectedEdit') as any;
    expect(edit).toBeDefined();
    const prompt = String(edit[0].prompt);
    // Expected: the undone ask is the model's to make.
    expect(prompt).toMatch(/Make exactly these changes:\n1\. make the date navy/);
  });
});
