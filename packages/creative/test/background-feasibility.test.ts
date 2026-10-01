import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { applyContentBackground } from '../src/studio/background-planning.js';
import { declaredTextContrast, computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { encodeEditableTransfer } from '../src/editable-transfer.js';
import { prepareGeneratedLayoutV3 } from '../src/studio/pipeline-v3.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const palette = ['#888888', '#666666', '#BBBBBB', '#000000', '#FFFFFF'];
function stage(): StudioLayoutV2 {
  return { version: 2, width: 800, height: 1000,
    grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#888888' }, shapes: [], logo: { x: 620, y: 60, width: 100, height: 100 },
    text: [
      { copyIndex: 0, role: 'title', x: 60, y: 70, width: 680, height: 100,
        fontFamily: 'Verdana', lineHeight: 1.3, fontSize: 40, color: '#000000', align: 'left', bold: true },
      { copyIndex: 1, role: 'body', x: 60, y: 300, width: 216, height: 600,
        fontFamily: 'Verdana', lineHeight: 1.3, fontSize: 22, color: '#000000', align: 'left' },
    ] };
}
const copy = { text: { 0: 'Original title', 1: 'Exact date 2026\nPrice 123.45' } };
const options = { intent: 'showcase' as const, mode: 'gradient' as const };
const readable = (layout: StudioLayoutV2) => layout.text.every(t =>
  declaredTextContrast(layout, t) >= requiredContrast(t.fontSize, !!t.bold));

describe('joint approved background feasibility and atomic refusal', () => {
  it('finds the approved readable field missed by the nearest-color proposal', () => {
    const layout = stage(), before = structuredClone(layout);
    const texts = layout.text, title = layout.text[0];
    expect(applyContentBackground(layout, palette, options)).toBe(layout);
    expect(layout.background.field?.stops.map(s => s.color)).toEqual(['#888888', '#BBBBBB']);
    expect(readable(layout)).toBe(true);
    expect(layout.text).toEqual(before.text);
    expect(layout.text).toBe(texts); expect(layout.text[0]).toBe(title);
    expect(layout.logo).toEqual(before.logo);
    expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
  });

  it('keeps the nearest restrained field when it already fits the copy footprint', () => {
    const layout = stage(); layout.text[1].height = 100;
    applyContentBackground(layout, palette, options);
    expect(layout.background.field?.stops.map(s => s.color)).toEqual(['#888888', '#666666']);
    expect(readable(layout)).toBe(true);
  });

  it('uses the landscape footprint and canonical approved stops without changing the solved boxes', () => {
    const layout = stage(); layout.width = 1000; layout.height = 800;
    Object.assign(layout.text[0], { x: 70, y: 60, width: 100, height: 200 });
    Object.assign(layout.text[1], { x: 300, y: 60, width: 600, height: 216 });
    const before = structuredClone(layout.text);
    applyContentBackground(layout, ['#888', '#666', '#BBB', '#000', '#FFF'], options);
    expect(layout.background.field?.direction).toBe('to-right');
    expect(layout.background.field?.stops.map(s => s.color)).toEqual(['#888888', '#BBBBBB']);
    expect(layout.text).toEqual(before); expect(readable(layout)).toBe(true);
  });

  it('commits matching grounds while preserving distinct cards, tabs, photos and successful node identities', () => {
    const layout = stage();
    layout.shapes = [
      { kind: 'rect', role: 'panel', x: 400, y: 600, width: 100, height: 100, color: '#888888' },
      { kind: 'rect', role: 'panel', surface: 'tab', x: 500, y: 600, width: 100, height: 100, color: '#888888' },
      { kind: 'rect', role: 'panel', x: 500, y: 750, width: 100, height: 100, color: '#BBBBBB' },
    ];
    layout.overlays = [{ kind: 'gradient', purpose: 'paper', x: 400, y: 750, width: 100, height: 100,
      color: '#888888', direction: 'to-bottom', stops: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }] }];
    layout.photos = [{ photoIndex: 0, role: 'inset', x: 500, y: 300, width: 200, height: 200 }];
    const shapes = layout.shapes, shape = shapes[0], overlay = layout.overlays[0], photos = structuredClone(layout.photos);
    applyContentBackground(layout, palette, { requestedColor: '#BBBBBB', style: { texture: 'none', titleColor: 'as_generated' } });
    expect(layout.shapes).toBe(shapes); expect(layout.shapes[0]).toBe(shape); expect(layout.overlays[0]).toBe(overlay);
    expect(layout.shapes.map(s => s.color)).toEqual(['#BBBBBB', '#888888', '#BBBBBB']);
    expect(overlay.color).toBe('#BBBBBB'); expect(layout.photos).toEqual(photos); expect(readable(layout)).toBe(true);
  });

  it('preserves the requester ground and plateau while choosing another compatible approved stop', () => {
    const layout = stage(); layout.text[1].y = 800; layout.text[1].width = 100; layout.text[1].height = 150;
    applyContentBackground(layout, palette, { ...options, requestedColor: '#888888' });
    expect(layout.background.field?.stops).toEqual([
      { at: 0, color: '#888888' }, { at: .8, color: '#888888' }, { at: 1, color: '#BBBBBB' },
    ]);
    expect(layout.background.decision?.basis).toBe('requester');
    expect(readable(layout)).toBe(true);
  });

  it('refuses an infeasible explicit field without changing any input or aliases', () => {
    const layout = stage(); layout.text[0].color = '#888888';
    const before = structuredClone(layout), background = layout.background, body = layout.text[1];
    expect(() => applyContentBackground(layout, palette.filter(c => c !== '#BBBBBB'), options))
      .toThrow(/BACKGROUND.*readable ink/);
    expect(layout).toEqual(before);
    expect(layout.background).toBe(background); expect(layout.text[1]).toBe(body);
  });

  it('rolls back carriers, overlays, art, repaired ink and accent removals on a later refusal', () => {
    const layout = stage();
    layout.text[0].color = '#888888'; layout.text[0].accentColor = '#888888'; layout.text[0].accentText = 'Original';
    layout.text[1].color = '#888888';
    layout.shapes.push({ kind: 'rect', role: 'panel', x: 400, y: 600, width: 100, height: 100, color: '#888888' });
    layout.overlays = [{ kind: 'gradient', purpose: 'paper', x: 400, y: 750, width: 100, height: 100,
      color: '#888888', direction: 'to-bottom', stops: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }] }];
    layout.art = { source: 'procedural', motif: 'thin-rules', box: { x: 0, y: 0, width: 800, height: 1000 },
      opacity: .1, calmRegion: { x: 0, y: 0, width: 800, height: 1000 } };
    const before = structuredClone(layout), shape = layout.shapes[0], overlay = layout.overlays[0], art = layout.art;
    expect(() => applyContentBackground(layout, ['#888888', '#777777', '#FFFFFF'],
      { requestedColor: '#777777', style: { texture: 'none', titleColor: 'as_generated' } })).toThrow(/BACKGROUND.*block 1/);
    expect(layout).toEqual(before);
    expect(layout.shapes[0]).toBe(shape); expect(layout.overlays[0]).toBe(overlay); expect(layout.art).toBe(art);
  });

  it('honors no-texture and full-photo scene precedence without forcing a field', () => {
    const solid = applyContentBackground(stage(), palette, { ...options, style: { texture: 'none', titleColor: 'as_generated' } });
    expect(solid.background.field).toBeUndefined(); expect(solid.background.decision?.mode).toBe('solid');
    const scene = stage(); scene.photos = [{ photoIndex: 0, role: 'hero', x: 0, y: 0, width: 800, height: 1000 }];
    const photos = structuredClone(scene.photos);
    applyContentBackground(scene, palette, options);
    expect(scene.background.field).toBeUndefined(); expect(scene.background.decision?.mode).toBe('scene');
    expect(scene.photos).toEqual(photos);
  });

  it('preserves the accepted field through JSON replay and actual photo-recipe preparation', () => {
    const initial = stage(); initial.text[1].y = 800; initial.text[1].width = 100; initial.text[1].height = 150;
    const planned = { ...options, requestedColor: '#888888' };
    const layout = applyContentBackground(initial, palette, planned);
    const replay = JSON.parse(JSON.stringify(layout)) as StudioLayoutV2;
    applyContentBackground(replay, palette, planned);
    expect(replay).toEqual(layout);
    replay.artDirection = { recipe: 'photo_diptych', titleZone: { x: 60, y: 70, width: 680, height: 100 }, omittedPhotos: [], rtl: false };
    const field = structuredClone(replay.background.field);
    const prepared = prepareGeneratedLayoutV3(replay, copy,
      { width: 800, height: 1000, palette, background: '#888888' });
    expect(prepared.background.field).toEqual(field);
    expect(readable(prepared)).toBe(true);
  });

  it('refuses forbidden requests and oversized search input without mutating a caller', () => {
    for (const [colors, planning] of [
      [palette, { ...options, requestedColor: '#FF00FF' }],
      [Array.from({ length: 33 }, (_, i) => '#' + i.toString(16).padStart(6, '0')), options],
    ] as const) {
      const layout = stage(), before = structuredClone(layout);
      expect(() => applyContentBackground(layout, [...colors], planning)).toThrow(/BACKGROUND/);
      expect(layout).toEqual(before);
    }
    const layout = stage(); layout.text = Array.from({ length: 41 }, (_, i) => ({ ...layout.text[0], copyIndex: i }));
    const before = structuredClone(layout);
    expect(() => applyContentBackground(layout, palette, options)).toThrow(/BACKGROUND.*bound/);
    expect(layout).toEqual(before);
  });

  it('passes actual local raster contrast and retains a separate editable gradient and live factual copy', async () => {
    const layout = applyContentBackground(stage(), palette, options);
    const render = renderLayoutV2(layout, { copyText: copy.text, logoDataUri: KAAE_TEST_LOGO });
    const composite = PNG.sync.read(render.noTextPng);
    for (const text of layout.text) expect(computeBoxP05Contrast(composite, text, text.color))
      .toBeGreaterThanOrEqual(requiredContrast(text.fontSize, !!text.bold));
    const transfer = await encodeStudioTransferV2(layout, [copy.text[0], copy.text[1]]);
    const xml = strFromU8(unzipSync(transfer.bytes)['ppt/slides/slide1.xml']);
    expect(xml).toContain('name="Hawa background field"'); expect(xml).toContain('<a:gradFill');
    expect(xml).toContain('val="BBBBBB"'); expect(xml).toContain('Original title'); expect(xml).toContain('Price 123.45');
    expect(transfer.manifest.plan.backgroundField).toEqual(layout.background.field);
    const reconstructed = await encodeEditableTransfer({ ...transfer.plan, logo: undefined }, [copy.text[0], copy.text[1]]);
    expect(reconstructed.manifest.nativeVerification).toBe('required');
    expect(strFromU8(unzipSync(reconstructed.bytes)['ppt/slides/slide1.xml'])).toContain('val="BBBBBB"');
  });
});
