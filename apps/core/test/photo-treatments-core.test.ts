import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, PNG, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { alignFramedHeads } from '../src/services/design-studio/photo-cutouts.js';
import { carryOver, editMeans, treatmentsOnPalette } from '../src/services/design-studio/stages/edit.stage.js';
import { softPhotoNotes } from '../src/services/design-studio/studio-status-note.js';

/**
 * The Core half of the designer's photo treatments (plan 4.1 and 4.2): heads matched across framed
 * portraits set side by side, and treatments kept through a change unless it takes them off.
 */
const layout = (photos: unknown[]): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#0A2A6B' },
    shapes: [],
    text: [],
    logo: { x: 880, y: 1180, width: 128, height: 128 },
    photos,
  }) as unknown as StudioLayoutV2;

describe('framed portraits side by side', () => {
  const row = () =>
    layout([
      { photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 440, height: 520, focus: { x: 0.5, y: 0.3 } },
      { photoIndex: 1, role: 'portrait', x: 568, y: 700, width: 440, height: 520, focus: { x: 0.5, y: 0.3 } },
    ]);
  const sizes = [{ width: 1600, height: 2000 }, { width: 1600, height: 2000 }];

  it('show their heads at one size: the smaller face is cropped tighter around it', () => {
    const out = alignFramedHeads(row(), [{ x: 0.5, y: 0.3, faceShare: 0.3 }, { x: 0.5, y: 0.3, faceShare: 0.2 }], sizes);
    expect(out.photos?.[0].zoom).toBeUndefined();
    expect(out.photos?.[1].zoom).toBe(1.5);
  });

  it('are never cropped past what the photo holds sharply, nor past the zoom limit', () => {
    const small = [{ width: 1600, height: 2000 }, { width: 500, height: 625 }];
    const out = alignFramedHeads(row(), [{ x: 0.5, y: 0.3, faceShare: 0.4 }, { x: 0.5, y: 0.3, faceShare: 0.1 }], small);
    // A 500-pixel-wide photo in a 440-pixel box holds about 1.8 times the cover crop before it looks
    // soft; the match stops just under that, so it never earns the "may look soft" warning.
    expect(out.photos?.[1].zoom).toBe(1.78);
    expect(softPhotoNotes(out.photos as never[], small)).toEqual([]);
  });

  it('are left alone when heads already match, when they are not in one row, or without faces', () => {
    expect(alignFramedHeads(row(), [{ x: 0.5, y: 0.3, faceShare: 0.3 }, { x: 0.5, y: 0.3, faceShare: 0.29 }], sizes).photos?.every((p) => p.zoom === undefined)).toBe(true);
    const apart = row();
    apart.photos![1] = { ...apart.photos![1], y: 100, height: 200, width: 200 };
    expect(alignFramedHeads(apart, [{ x: 0.5, y: 0.3, faceShare: 0.3 }, { x: 0.5, y: 0.3, faceShare: 0.1 }], sizes).photos?.every((p) => p.zoom === undefined)).toBe(true);
    expect(alignFramedHeads(row(), [{ x: 0.5, y: 0.3 }, undefined], sizes).photos?.every((p) => p.zoom === undefined)).toBe(true);
  });
});

describe('a change to a design with treated photos', () => {
  const parent = layout([
    { photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 440, height: 520, mask: 'circle', filter: { kind: 'bw' }, zoom: 1.4 },
    { photoIndex: 1, role: 'portrait', x: 568, y: 700, width: 440, height: 520, treatment: 'cutout', outline: { color: '#F7B500', width: 6 } },
  ]);

  it('keeps every treatment the answer leaves out, and takes off one set to null', () => {
    const answer = layout([
      { photoIndex: 0, role: 'portrait', x: 72, y: 650, width: 440, height: 520, filter: null },
      { photoIndex: 1, role: 'portrait', x: 568, y: 650, width: 440, height: 520 },
    ]);
    const out = carryOver(parent, answer);
    expect(out.photos?.[0]).toMatchObject({ mask: 'circle', zoom: 1.4, y: 650 });
    expect(out.photos?.[0]).not.toHaveProperty('filter');
    expect(out.photos?.[1]).toMatchObject({ treatment: 'cutout', outline: { color: '#F7B500', width: 6 } });
  });

  it('drops what a photo can no longer carry when the answer changes how it is shown', () => {
    const answer = layout([
      { photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 440, height: 520, treatment: 'cutout' },
      { photoIndex: 1, role: 'portrait', x: 568, y: 700, width: 440, height: 520, treatment: 'framed' },
    ]);
    const out = carryOver(parent, answer);
    expect(out.photos?.[0]).not.toHaveProperty('mask');
    expect(out.photos?.[1]).not.toHaveProperty('outline');
  });

  it('tells the analysis that masks, fades and colour treatments are within the edit\'s means', () => {
    const means = editMeans({});
    expect(means).toContain('shape it as a circle or an arch, fade its edge into the background');
    expect(means).not.toContain('recolour or blur a photo');
  });
});

describe('treatment colours', () => {
  it('are held to the brand palette: a near miss becomes the nearest brand colour', () => {
    const out = treatmentsOnPalette(
      layout([
        { photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 440, height: 520, filter: { kind: 'duotone', dark: '#0B2B6A', light: '#F5B400' } },
        { photoIndex: 1, role: 'portrait', x: 568, y: 700, width: 440, height: 520, treatment: 'cutout', outline: { color: '#ffffff', width: 6 }, glow: { color: '#FF0000', radius: 20 } },
      ]),
      ['#0A2A6B', '#F7B500', '#FFFFFF']
    );
    expect(out.photos?.[0].filter).toEqual({ kind: 'duotone', dark: '#0A2A6B', light: '#F7B500' });
    expect(out.photos?.[1].outline?.color).toBe('#ffffff');
    expect(out.photos?.[1].glow?.color).toBe('#F7B500');
  });
});

describe('a change that asks for a treatment', () => {
  it('is made by the edit, checked and drawn by the real renderer, and recorded done', async () => {
    // A 200 x 240 photo, a flat warm colour, so black and white is visible in the pixels.
    const png = new PNG({ width: 200, height: 240 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 120, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const photo = { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes, mimeType: 'image/png' as const, width: 200, height: 240 };
    const parent = layout([{ photoIndex: 0, role: 'portrait', x: 72, y: 700, width: 440, height: 520 }]);
    parent.text = [{ x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true }] as StudioLayoutV2['text'];
    const answer = structuredClone(parent);
    (answer.photos![0] as unknown as Record<string, unknown>).filter = { kind: 'bw' };
    const run: any = {
      id: randomUUID(), tenant_id: '00000000-0000-4000-a000-000000000001', task_id: randomUUID(), client_id: 'c1000000-0000-4000-8000-000000000002', actor_id: 'a',
      status: 'conceiving',
      stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }], readingOrder: [0], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
      budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
      request: { width: 1080, height: 1350, pipelineV3: true, instructions: 'x', copyBlocks: [{ text: 'MEET KAAE', script: 'latin' }], directed: { parentTaskId: randomUUID(), revisionDirective: 'make the photo black and white' } },
    };
    const updated: any[] = [];
    const repo = {
      getRunById: async () => run,
      updateRunStatus: async (_i: string, _t: string, status: string, extra: any = {}) => { run.status = status; if (extra.stages) run.stages = JSON.stringify(extra.stages); return run; },
      insertCandidate: async (c: any) => c,
      updateCandidate: async (_i: string, _t: string, u: any) => { updated.push(u); return u; },
      getCandidatesForRun: async () => [], recordCallStart: async () => ({}), finalizeCall: async () => ({}),
    };
    const ask = { ask: 'make the photo black and white', op: 'photo_filter', elements: ['photos'], restyle: true, possible: true, reason: '', question: '', options: [], assumption: '', copyEdits: [] };
    const completeJson = vi.fn(async (params: any) =>
      params.schemaName === 'EditTargets' ? { data: { targets: ['photos'], asks: [ask], frustrated: false }, receipt: {} } : { data: { layout: structuredClone(answer), changes: [] }, receipt: {} }
    );
    const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
    Object.assign(service as any, {
      repo, attachedImage: async () => undefined, imagesForRun: async () => [photo.dataUrl], activeRunsOfTask: async () => 0, earlierAsks: async () => [],
      parentWinner: async () => ({ runId: 'p', candidateId: 'pc', layout: structuredClone(parent), concept: { id: 'c', archetype: 'split-band' } }),
      createStageContext: (_s: any, r: any) => ({
        runId: r.id, tenantId: r.tenant_id, taskId: r.task_id, clientId: r.client_id, actorId: 'a', width: 1080, height: 1350, tier: 'standard', instructions: 'x',
        copyBlocks: r.request.copyBlocks, referencePack: { palette: ['#0A2A6B', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
        latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, client: { completeJson }, pipelineV3: true, photos: [photo],
      }),
    });
    await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    const res: any = await service.resume({ tenantId: run.tenant_id, actorId: 'a' } as any, run.task_id, run.id);
    expect(res.code).toBeUndefined();
    const edit = String((completeJson.mock.calls.find((c: any) => c[0].schemaName === 'DirectedEdit') as any)[0].prompt);
    expect(edit).toContain("filter ({kind:'bw'}");
    const final = updated.find((u) => u.layouts);
    expect(final.layouts[0].photos[0].filter).toEqual({ kind: 'bw' });
    expect(JSON.parse(run.stages).directed.asks[0]).toMatchObject({ ask: 'make the photo black and white', status: 'done', op: 'photo_filter' });
    // The preview shows it: the middle of the photo box is grey.
    const preview = PNG.sync.read(final.previewPng);
    const at = ((700 + 260) * preview.width + (72 + 220)) * 4;
    const [r, g, b] = preview.data.subarray(at, at + 3);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(3);
  });
});
