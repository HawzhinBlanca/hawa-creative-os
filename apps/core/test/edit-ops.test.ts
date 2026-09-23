import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, PNG, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { applyOp, verifyOp, opParams, nearestBrand, type OpContext } from '../src/services/design-studio/edit-ops.js';
import { movedUntargeted, withPlacesOf } from '../src/services/design-studio/stages/edit.stage.js';

/**
 * The common changes a requester asks for, made by rules from the parameters the analysis read out
 * of their words (ADR-032 plan 2.2), each checked by its own rule: exact, free, and nothing else moves.
 */
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

const made = (op: Parameters<typeof applyOp>[1], params: Record<string, unknown>) => {
  const parent = design();
  const layout = design();
  const p = opParams(params);
  const result = applyOp(layout, op, p, ctx);
  return { parent, layout, result, verified: verifyOp(parent, layout, op, p, ctx) };
};

describe('the rules', () => {
  it('colour text and words in brand colours only, the nearest to what was asked', () => {
    expect(nearestBrand('#F5B400', palette)).toBe('#F7B500');
    const whole = made('text_colour', { text: 1, colour: '#F5B400' });
    expect(whole.layout.text[1].color).toBe('#F7B500');
    expect(whole.verified).toBe(true);
    const words = made('accent', { text: 0, words: 'SAGACON 2026', colour: '#F7B500' });
    expect(words.layout.text[0]).toMatchObject({ accentText: 'SAGACON 2026', accentColor: '#F7B500' });
    expect(made('accent', { text: 0, words: 'NOT ON IT', colour: '#F7B500' }).result).toMatchObject({ ok: false });
  });

  it('step type and the logo a fifth bigger or smaller, and set weight and alignment', () => {
    const bigger = made('font_size', { text: 1, direction: 'bigger' });
    expect(bigger.layout.text[1]).toMatchObject({ fontSize: 48, height: 72 });
    expect(bigger.verified).toBe(true);
    expect(made('font_weight_or_style', { text: 1, bold: true }).layout.text[1].bold).toBe(true);
    const centred = made('align_or_spacing', { align: 'center' });
    expect(centred.layout.text.every((t) => t.align === 'center')).toBe(true);
    expect(made('align_or_spacing', {}).result).toMatchObject({ ok: false });
  });

  it('put the logo in a named corner at the margin', () => {
    const tl = made('logo_move_or_scale', { corner: 'top-left' });
    expect(tl.layout.logo).toMatchObject({ x: 72, y: 72 });
    expect(tl.verified).toBe(true);
    const bc = made('logo_move_or_scale', { corner: 'bottom-center', direction: 'smaller' });
    expect(bc.layout.logo).toMatchObject({ width: 140, height: 98, x: 470, y: 1180 });
    expect(bc.verified).toBe(true);
  });

  it('treat the photos asked for, or all of them', () => {
    const bw = made('photo_filter', { filter: 'bw' });
    expect(bw.layout.photos!.every((p) => p.filter?.kind === 'bw')).toBe(true);
    const duo = made('photo_filter', { photos: [0], filter: 'duotone' });
    expect(duo.layout.photos![0].filter).toEqual({ kind: 'duotone', dark: '#0A2A6B', light: '#F7B500' });
    expect(duo.layout.photos![1].filter).toBeUndefined();
    const circle = made('photo_mask', { photos: [0], mask: 'circle' });
    expect(circle.layout.photos![0]).toMatchObject({ mask: 'circle', width: 400, height: 400, y: 760 });
    expect(made('photo_fade', { fadeEdge: 'bottom' }).layout.photos![0].fade).toEqual({ edge: 'bottom', length: 0.35 });
    expect(made('photo_crop', { photos: [1], zoom: 'in' }).layout.photos![1].zoom).toBe(1.3);
  });

  it('cut out only a photo whose cut-out passed, and draw outlines only around cut-out people', () => {
    expect(made('photo_cutout', { photos: [0], cutout: true }).result).toMatchObject({ ok: false });
    const cut = made('photo_cutout', { photos: [1], cutout: true });
    expect(cut.layout.photos![1].treatment).toBe('cutout');
    const framedOutline = made('photo_outline_or_glow', { outline: true });
    expect(framedOutline.result).toMatchObject({ ok: false });
    const layout = design();
    layout.photos![1].treatment = 'cutout';
    expect(applyOp(layout, 'photo_outline_or_glow', opParams({ outline: true }), ctx)).toEqual({ ok: true });
    expect(layout.photos![1].outline).toEqual({ color: '#F7B500', width: 8 });
    expect(layout.photos![0].outline).toBeUndefined();
  });

  it('leave anything they do not cover to the edit model', () => {
    expect(made('move', { text: 1 }).result).toMatchObject({ ok: false });
    expect(made('overall_style', {}).result).toMatchObject({ ok: false });
  });

  it('keep the parameters to their types, and drop anything else', () => {
    expect(opParams({ text: 1.5, colour: 'gold', corner: 'middle', photos: [0, -1, 'x'], filter: 'sepia', zoom: 'in', bold: 'yes' })).toEqual({ photos: [0], zoom: 'in' });
  });
});

describe('a request covered by rules', () => {
  it('is made without the edit model, exactly, and each ask is checked by its rule', async () => {
    const png = new PNG({ width: 200, height: 260 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 120, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const photo = { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes, mimeType: 'image/png' as const, width: 200, height: 260 };
    const parent = design();
    parent.photos = [parent.photos![0]];
    const run: any = {
      id: randomUUID(), tenant_id: '00000000-0000-4000-a000-000000000001', task_id: randomUUID(), client_id: 'c1000000-0000-4000-8000-000000000002', actor_id: 'a',
      status: 'conceiving',
      stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
      budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
      request: { width: 1080, height: 1350, pipelineV3: true, instructions: 'x', copyBlocks: [{ text: ctx.copy[0], script: 'latin' }, { text: ctx.copy[1], script: 'latin' }], directed: { parentTaskId: randomUUID(), revisionDirective: 'photo black and white, date in gold, logo top left' } },
    };
    const updated: any[] = [];
    const repo = {
      getRunById: async () => run,
      updateRunStatus: async (_i: string, _t: string, status: string, extra: any = {}) => { run.status = status; if (extra.stages) run.stages = JSON.stringify(extra.stages); return run; },
      insertCandidate: async (c: any) => c,
      updateCandidate: async (_i: string, _t: string, u: any) => { updated.push(u); return u; },
      getCandidatesForRun: async () => [], recordCallStart: async () => ({}), finalizeCall: async () => ({}),
    };
    const ask = (ask: string, op: string, params: Record<string, unknown>, elements: string[]) => ({ ask, op, params, elements, restyle: true, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] });
    const asks = [
      ask('make the photo black and white', 'photo_filter', { filter: 'bw' }, ['photos']),
      ask('make the date gold', 'text_colour', { text: 1, colour: '#F7B500' }, ['text:1']),
      ask('move the logo to the top left', 'logo_move_or_scale', { corner: 'top-left' }, ['logo']),
    ];
    const completeJson = vi.fn(async (params: any) => {
      if (params.schemaName === 'EditTargets') return { data: { targets: ['photos', 'text:1', 'logo'], asks, frustrated: false }, receipt: {} };
      throw new Error(`no ${params.schemaName} call expected`);
    });
    const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
    Object.assign(service as any, {
      repo, attachedImage: async () => undefined, imagesForRun: async () => [photo.dataUrl], activeRunsOfTask: async () => 0, earlierAsks: async () => [],
      parentWinner: async () => ({ runId: 'p', candidateId: 'pc', layout: structuredClone(parent), concept: { id: 'c', archetype: 'split-band' } }),
      createStageContext: (_s: any, r: any) => ({
        runId: r.id, tenantId: r.tenant_id, taskId: r.task_id, clientId: r.client_id, actorId: 'a', width: 1080, height: 1350, tier: 'standard', instructions: 'x',
        copyBlocks: r.request.copyBlocks, referencePack: { palette }, promotedRules: 'None',
        latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, pipelineV3: true, photos: [photo],
      }),
    });
    await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    const res: any = await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    expect(res.code).toBeUndefined();
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const final = updated.find((u) => u.layouts).layouts[0];
    expect(final.photos[0].filter).toEqual({ kind: 'bw' });
    expect(final.text.find((t: any) => t.copyIndex === 1).color).toBe('#F7B500');
    expect(final.text.find((t: any) => t.copyIndex === 0)).toMatchObject({ color: '#FFFFFF', y: 180 });
    expect(final.logo).toMatchObject({ x: 72, y: 72 });
    expect(JSON.parse(run.stages).directed.asks.map((a: any) => [a.status, a.by])).toEqual([['done', 'rule'], ['done', 'rule'], ['done', 'rule']]);
  });
});

/** The 2026-09-24 review's findings on the edit stage, each as it was reproduced. */
describe('the rules, after the review', () => {
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
        latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, pipelineV3: true, ...(opts.photos ? { photos: opts.photos } : {}),
      }),
    });
    await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    const res: any = await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    return { res, run, completeJson, layout: updated.find((u) => u.layouts)?.layouts?.[0] as StudioLayoutV2 | undefined, stages: () => JSON.parse(run.stages) };
  };
  const ask = (a: string, op: string, params: Record<string, unknown>, elements: string[]) => ({ ask: a, op, params, elements, restyle: false, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] });
  const noPhotos = () => { const d = design(); d.photos = []; return d; };

  it('a logo against the margin grows from its corner and stays inside, without the edit model', async () => {
    const { res, layout, completeJson } = await runEdit({ parent: noPhotos(), asks: [ask('make the logo bigger', 'logo_move_or_scale', { direction: 'bigger' }, ['logo'])] });
    expect(res.code).toBeUndefined();
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    // It sat at x 840..1008 (the right margin) and y 1160..1278: now 202 wide, still ending at 1008.
    expect(layout?.logo).toMatchObject({ width: 202, x: 806 });
    expect((layout!.logo!.x + layout!.logo!.width)).toBe(1008);
  });

  it('a rule made again on the edit model\'s answer is one step from the design, not two', async () => {
    const parent = noPhotos();
    const { layout, completeJson } = await runEdit({
      parent,
      asks: [ask('make the date bigger', 'font_size', { text: 1, direction: 'bigger' }, ['text:1']), ask('spread the text out', 'align_or_spacing', {}, ['all'])],
      // The model also enlarges the date, as told to before the fix.
      reply: () => { const l = structuredClone(parent); l.text[1] = { ...l.text[1], fontSize: 48, height: 72, y: 560 }; return { layout: l, changes: [] }; },
    });
    expect(layout?.text.find((t) => t.copyIndex === 1)).toMatchObject({ fontSize: 48, height: 72 });
    const prompt = String((completeJson.mock.calls.find((c: any) => c[0].schemaName === 'DirectedEdit') as any)[0].prompt);
    expect(prompt).toContain('Already made exactly on the layout below, by code');
    expect(prompt).toMatch(/Make exactly these changes:\n1\. spread the text out\n/);
  });

  it('a size or alignment rule does not let the edit model recolour text nobody asked about', async () => {
    const parent = noPhotos();
    const { layout } = await runEdit({
      parent,
      asks: [ask('centre the text', 'align_or_spacing', { align: 'center' }, ['all']), ask('spread the text out', 'align_or_spacing', {}, ['all'])],
      reply: () => { const l = structuredClone(parent); l.text[1] = { ...l.text[1], color: '#F7B500' }; return { layout: l, changes: [] }; },
    });
    expect(layout?.text.every((t) => t.align === 'center')).toBe(true);
    expect(layout?.text.find((t) => t.copyIndex === 1)?.color).toBe('#FFFFFF');
  });

  it('a treatment the model sends without its colour is refused with a reason, not a crash', async () => {
    const png = new PNG({ width: 200, height: 260 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 120, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const photo = { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes, mimeType: 'image/png' as const, width: 200, height: 260 };
    const parent = design();
    parent.photos = [parent.photos![0]];
    const { completeJson } = await runEdit({
      parent, photos: [photo],
      asks: [ask('warm up the photo', 'overall_style', {}, ['photos'])],
      reply: () => { const l = structuredClone(parent); (l.photos![0] as any).filter = { kind: 'tint', strength: 0.3 }; return { layout: l, changes: [] }; },
    });
    const second = (completeJson.mock.calls.filter((c: any) => c[0].schemaName === 'DirectedEdit')[1] as any)?.[0].prompt as string | undefined;
    expect(second ?? '').not.toContain("reading 'trim'");
  });

  it('"show more of the photo" on an uncropped photo is left to the edit model, not reported done', () => {
    const parent = design();
    expect(applyOp(design(), 'photo_crop', opParams({ zoom: 'out' }), ctx, parent)).toMatchObject({ ok: false });
    expect(verifyOp(parent, design(), 'photo_crop', opParams({ zoom: 'out' }), ctx)).toBe(false);
  });

  it('a photo check with no photo left to check is not passed', () => {
    const parent = design();
    const allCut = design();
    for (const p of allCut.photos!) p.treatment = 'cutout';
    expect(verifyOp(parent, allCut, 'photo_mask', opParams({ mask: 'circle' }), ctx)).toBe(false);
    expect(verifyOp(parent, design(), 'photo_outline_or_glow', opParams({ outline: true }), ctx)).toBe(false);
    expect(verifyOp(parent, allCut, 'photo_crop', opParams({ zoom: 'in' }), ctx)).toBe(false);
  });
});

describe('photos guarded one by one', () => {
  it('a change to one photo leaves the others in their places, or names them', () => {
    const parent = design();
    const edited = design();
    edited.photos![0] = { ...edited.photos![0], mask: 'circle', width: 400, height: 400, y: 760 };
    edited.photos![1] = { ...edited.photos![1], y: 640, height: 480 };
    expect(movedUntargeted(parent, edited, ['photo:0'])).toEqual(['photo:1']);
    const back = withPlacesOf(parent, edited, ['photo:1']);
    expect(back.photos![1]).toMatchObject({ y: 700, height: 520 });
    expect(back.photos![0]).toMatchObject({ mask: 'circle', y: 760 });
  });
});
