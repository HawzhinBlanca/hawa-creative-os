import { describe, expect, it } from 'vitest';
import { solveRecipe, type SolveRecipeInput } from '../src/studio/art-direction/solver.js';
import { prepareGeneratedLayoutV3 } from '../src/studio/pipeline-v3.js';
import { NEUTRAL_STYLE_SPEC } from '../src/studio/style-spec.js';
import { declaredTextContrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';

const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const copy = { 0: 'School visit', 1: 'Learning together', 2: 'kaae.org' };
function input(): SolveRecipeInput {
  return { width: 1080, height: 1350, palette, copy: { text: copy }, logoAspect: 1,
    photos: Array.from({ length: 3 }, (_, photoIndex) => ({ photoIndex, width: 1280, height: 853 })),
    choice: { recipe: 'hero_storyboard', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }, { copyIndex: 2, slot: 'cta' }], params: {} } };
}
describe('content-aware background request precedence', () => {
  it('honors the requested surface inside the recipe solver and keeps copy readable', () => {
    const layout = solveRecipe({ ...input(), backgroundPlanning: { requestedColor: '#4770A3' } } as SolveRecipeInput);
    expect(layout.background.color).toBe('#4770A3');
    expect(layout.text.every(t => declaredTextContrast(layout, t) >= requiredContrast(t.fontSize, !!t.bold))).toBe(true);
  });
  it('does not discard a requested background in photo-recipe preparation', () => {
    const layout = solveRecipe(input());
    const prepared = prepareGeneratedLayoutV3(layout, { text: copy }, { width: 1080, height: 1350, palette,
      background: '#FDF8F3', style: { ...NEUTRAL_STYLE_SPEC, texture: 'none' } });
    expect(prepared.background.color).toBe('#FDF8F3');
    expect(prepared.text.every(t => declaredTextContrast(prepared, t) >= requiredContrast(t.fontSize, !!t.bold))).toBe(true);
  });
  it('refuses a requested background outside the approved palette before producing a candidate', () => {
    expect(() => solveRecipe({ ...input(), backgroundPlanning: { requestedColor: '#FF00FF' } } as SolveRecipeInput)).toThrow(/BACKGROUND.*palette/i);
  });
});

import { applyContentBackground } from '../src/studio/background-planning.js';
import { backgroundFieldSchema, backgroundFieldSvg } from '../src/studio/background-field.js';
import { studioLayoutV2Schema, type StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2, studioLayoutV2ToTransferPlan } from '../src/studio/transfer-v2.js';
import { encodeEditableTransfer } from '../src/editable-transfer.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { strFromU8, unzipSync } from 'fflate';
import { pixelAt } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

function stage(): StudioLayoutV2 {
  return { version: 2, width: 800, height: 1000, grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#0A1628' }, shapes: [], logo: { x: 620, y: 60, width: 100, height: 100 },
    text: [{ copyIndex: 0, role: 'title', x: 60, y: 300, width: 680, height: 100, fontFamily: 'Verdana', lineHeight: 1.3, fontSize: 40, color: '#FFFFFF', align: 'left', bold: true }] };
}
const gradient = { kind: 'linear' as const, direction: 'to-bottom' as const,
  stops: [{ at: 0, color: '#0A1628' }, { at: 1, color: '#1E3A5F' }] };
describe('typed background field and content decisions', () => {
  it('uses a restrained field for a showcase and a calm surface for dense editorial copy', () => {
    const showcase = applyContentBackground(stage(), palette, { intent: 'showcase' });
    expect(showcase.background).toMatchObject({ field: { kind: 'linear' }, decision: { intent: 'showcase', mode: 'gradient' } });
    const dense = stage(); dense.text[0].height = 450;
    applyContentBackground(dense, palette, { intent: 'editorial' });
    expect(dense.background.color).toBe('#FFFFFF');
    expect(dense.background.field).toBeUndefined();
    expect(dense.text[0].color).not.toBe('#FFFFFF');
  });
  it('explicit color and texture-none override concept/reference preferences, with no invented image', () => {
    const layout = applyContentBackground(stage(), palette, { requestedColor: '#FDF8F3', colorIndex: 0,
      intent: 'showcase', mode: 'gradient', style: { texture: 'none', titleColor: 'light' } });
    expect(layout.background).toMatchObject({ color: '#FDF8F3', decision: { basis: 'requester', mode: 'solid' } });
    expect(layout.background.field).toBeUndefined();
    expect(layout.art).toBeUndefined();
    expect(declaredTextContrast(layout, layout.text[0])).toBeGreaterThan(4.5);
  });
  it('is replay deterministic and keeps source geometry and required copy indices', () => {
    const before = stage();
    const a = applyContentBackground(structuredClone(before), palette, { intent: 'showcase' });
    const b = applyContentBackground(structuredClone(before), palette, { intent: 'showcase' });
    expect(a).toEqual(b);
    expect(a.text.map(({ color, ...t }) => t)).toEqual(before.text.map(({ color, ...t }) => t));
    expect(a.logo).toEqual(before.logo);
    expect(studioLayoutV2Schema.safeParse(a).success).toBe(true);
  });
  it('preserves a solved gradient through requester-background preparation and saved-layout replay', () => {
    const layout = applyContentBackground(stage(), palette, { intent: 'showcase', mode: 'gradient', requestedColor: '#0A1628' });
    const before = structuredClone(layout.background);
    const prepared = prepareGeneratedLayoutV3(structuredClone(layout), { text: { 0: 'Exact title' } },
      { width: 800, height: 1000, palette, background: '#0A1628' });
    expect(prepared.background).toEqual(before);
    expect(prepared.background.field).toBeDefined();
  });
  it('rejects unordered, missing-endpoint, nonfinite, oversized and markup-bearing fields', () => {
    for (const field of [ { ...gradient, stops: [...gradient.stops].reverse() },
      { ...gradient, stops: [{ at: .1, color: '#0A1628' }, gradient.stops[1]] },
      { ...gradient, stops: [{ at: NaN, color: '#0A1628' }, gradient.stops[1]] },
      { ...gradient, stops: Array.from({ length: 5 }, (_, i) => ({ at: i / 4, color: '#0A1628' })) },
      { ...gradient, stops: [{ at: 0, color: '<script>' }, gradient.stops[1]] } ]) {
      expect(backgroundFieldSchema.safeParse(field).success).toBe(false);
      expect(() => backgroundFieldSvg(field, 800, 1000)).toThrow();
    }
  });
  it('validates every field stop against the scoped palette', () => {
    const layout = stage(); layout.background.field = { ...gradient, stops: [gradient.stops[0], { at: 1, color: '#FF00FF' }] };
    expect(validateLayoutV2(layout, { expectedWidth: 800, expectedHeight: 1000, copyCount: 1, copyScripts: ['latin'],
      reference: { rules: { fontFamily: 'Verdana', palette }, logoAspect: 1 } })).toMatchObject({ ok: false, code: 'PALETTE' });
  });
  it('catches intermediate low contrast rather than treating endpoints as a flat ground', () => {
    const layout = stage(); layout.background.field = { ...gradient, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#FFFFFF' }] };
    // The text footprint must actually span the ink's luminance, not a remote canvas region.
    layout.text[0].height = 250;
    layout.text[0].color = '#777777';
    expect(declaredTextContrast(layout, layout.text[0])).toBe(1);
  });
  for (const direction of ['to-bottom', 'to-top', 'to-right', 'to-left'] as const) {
    it(`renders the ${direction} field beneath separate logo/type layers`, () => {
      const layout = stage(); layout.background.field = { ...gradient, direction };
      const out = renderLayoutV2(layout, { copyText: { 0: 'Exact title' }, logoDataUri: KAAE_TEST_LOGO });
      const vertical = direction === 'to-bottom' || direction === 'to-top';
      const a = pixelAt(out.noTextPng, vertical ? 20 : 2, vertical ? 2 : 20);
      const b = pixelAt(out.noTextPng, vertical ? 20 : 797, vertical ? 997 : 20);
      expect(Math.abs(a[2] - b[2])).toBeGreaterThan(35);
      expect(out.noTextSvg.indexOf('background-field-node')).toBeLessThan(out.noTextSvg.indexOf('id="logo"'));
      expect(out.svg).toContain('Exact title');
    });
  }
  it('retains the field as a named native gradient with exact live copy, including reconstruction', async () => {
    const layout = stage(); layout.background.field = gradient;
    const encoded = await encodeStudioTransferV2(layout, ['Exact title']);
    const files = unzipSync(encoded.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('name="Hawa background field"');
    expect(xml).toContain('<a:gradFill');
    expect(xml).toContain('<a:lin ang="5400000" scaled="0"/>');
    expect(xml).toContain('<a:t>Exact title</a:t>');
    expect(Object.keys(files).filter(k => k.startsWith('ppt/media/') && !k.endsWith('/'))).toHaveLength(0);
    expect(encoded.manifest.plan.backgroundField).toEqual(gradient);
    const rebuilt = await encodeEditableTransfer({ ...studioLayoutV2ToTransferPlan(layout), logo: undefined }, ['Exact title']);
    expect(strFromU8(unzipSync(rebuilt.bytes)['ppt/slides/slide1.xml'])).toContain('<a:gradFill');
    expect(rebuilt.manifest.nativeVerification).toBe('required');
  });
});
