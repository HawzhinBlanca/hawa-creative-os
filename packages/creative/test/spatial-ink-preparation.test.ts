import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { conformToHouseRules, prepareGeneratedLayoutV3, type OrnamentSettings } from '../src/studio/pipeline-v3.js';
import { declaredTextContrast, declaredColorContrast, declaredColorContrastEvaluator, computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { applyStyleSpec, NEUTRAL_STYLE_SPEC } from '../src/studio/style-spec.js';
import { computeTextLegibility } from '../src/studio/design-metrics.js';
import { computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { unzipSync, strFromU8 } from 'fflate';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import { checkRefinementGate, refineCandidate } from '../src/studio/refinement-engine-v3.js';

const palette = ['#666666', '#787878', '#000000', '#FFFFFF'];
const copy = { text: { 0: 'Hi' } };
const ornament: OrnamentSettings = { balance: false, dividers: false, texture: 'none', textureOpacity: 0 };
function stage(direction: 'to-bottom' | 'to-top' | 'to-right' | 'to-left' = 'to-bottom'): StudioLayoutV2 {
  const vertical = direction === 'to-bottom' || direction === 'to-top';
  const reverse = direction === 'to-top' || direction === 'to-left';
  return { version: 2, width: 800, height: 1000, grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#666666', field: { kind: 'linear', direction,
      stops: [{ at: 0, color: '#666666' }, { at: 1, color: '#787878' }] } }, shapes: [],
    logo: { x: 640, y: 450, width: 100, height: 100 }, text: [{ copyIndex: 0, role: 'body',
      x: vertical ? 60 : reverse ? 60 : 680, y: vertical ? reverse ? 80 : 850 : 850,
      width: vertical ? 680 : 60, height: 70, fontSize: 28, lineHeight: 1.2,
      fontFamily: 'Verdana', color: '#000000', align: 'left' }] };
}

describe('shared spatial ink decisions', () => {
  for (const direction of ['to-bottom', 'to-top', 'to-right', 'to-left'] as const) {
    it(`preserves readable regional ink through actual ${direction} preparation and replay`, () => {
      const before = stage(direction);
      expect(declaredTextContrast(before, before.text[0])).toBeGreaterThanOrEqual(4.5);
      const conformed = conformToHouseRules(structuredClone(before), copy, palette);
      expect(conformed.text[0].color).toBe('#000000');
      const prepared = prepareGeneratedLayoutV3(structuredClone(before), copy,
        { width: 800, height: 1000, palette, ornament });
      expect(prepared.text[0].color).toBe('#000000');
      expect(prepared.background).toEqual(before.background);
      expect(declaredTextContrast(prepared, prepared.text[0])).toBeGreaterThanOrEqual(4.5);
      const replay = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(prepared)), copy,
        { width: 800, height: 1000, palette, ornament });
      expect(replay).toEqual(prepared);
      const render = renderLayoutV2(prepared, { copyText: copy.text, logoDataUri: KAAE_TEST_LOGO });
      expect(computeBoxP05Contrast(PNG.sync.read(render.noTextPng), prepared.text[0], '#000000')).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('does not replace readable title ink with an unreadable reference preference', () => {
    const l = stage(); l.text[0].role = 'title'; l.text[0].fontSize = 40; l.text[0].bold = true;
    l.background.field!.stops[1].color = '#FFFFFF';
    applyStyleSpec(l, copy, { ...NEUTRAL_STYLE_SPEC, titleColor: 'light' }, palette);
    expect(l.text[0].color).toBe('#000000');
    expect(declaredTextContrast(l, l.text[0])).toBeGreaterThanOrEqual(3);
  });
  it('does not add an unreadable reference accent on a locally bright field', () => {
    const l = stage(); l.text[0].role = 'title'; l.text[0].fontSize = 40; l.text[0].bold = true;
    l.background.color = '#000000'; l.background.field!.stops = [{ at: 0, color: '#000000' }, { at: 1, color: '#FFFFFF' }];
    l.text[0].height = 100;
    applyStyleSpec(l, { text: { 0: 'Hi\nEdition' } }, { ...NEUTRAL_STYLE_SPEC, accentLastTitleLine: true }, [...palette, '#F7B500']);
    expect(l.text[0].accentColor).toBeUndefined();
  });
  it('rejects the same unreadable body ink in advisory legibility and final-size policy', () => {
    const l = stage(); l.text[0].color = '#FFFFFF';
    expect(declaredTextContrast(l, l.text[0])).toBeLessThan(4.5);
    expect(computeTextLegibility(l).passed).toBe(false);
    expect(computeLayoutMetrics(l).contrastP05[0]).toBeCloseTo(declaredTextContrast(l, l.text[0]), 2);
    delete l.background.field; l.background.color = '#777777';
    expect(computeTextLegibility(l).passed).toBe(false);
  });
  it('names the actual contrast failure at refinement admission and respects a zero-call budget', async () => {
    const l = stage(); l.text[0].color = '#FFFFFF';
    expect(checkRefinementGate(l).reason).toContain('textLegibility');
    let calls = 0;
    const result = await refineCandidate('spatial-ink-fixture', l, { maxRounds: 0,
      fetchFn: (async () => { calls++; throw Error('Unexpected provider call'); }) as typeof fetch });
    expect(calls).toBe(0);
    expect(result.roundsRun).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.finalLayout).toEqual(l);
  });
  it('keeps opaque carrier precedence and measured metric overrides', () => {
    const l = stage();
    l.shapes.push({ kind: 'rect', role: 'panel', layer: 'overlay', color: '#666666',
      x: 50, y: 840, width: 700, height: 90 });
    conformToHouseRules(l, copy, palette);
    expect(l.text[0].color).toBe('#FFFFFF');
    expect(computeLayoutMetrics(l).contrastP05[0]).toBeCloseTo(declaredTextContrast(l, l.text[0]), 2);
    expect(computeLayoutMetrics(l, { contrastValues: { 0: 2.7 } }).contrastP05[0]).toBe(2.7);
  });
  it('shares one immutable decision enclosure, and recreates it for a changed footprint', () => {
    const l = stage(), on = declaredColorContrastEvaluator(l, l.text[0]);
    const before = on('#000000');
    for (const color of palette) expect(on(color)).toBe(declaredColorContrast(l, l.text[0], color));
    l.text[0].y = 100;
    expect(on('#000000')).toBe(before);
    expect(declaredColorContrastEvaluator(l, l.text[0])('#000000')).toBeLessThan(before);
    l.background.field!.stops[1].color = '#FFFFFF';
    expect(on('#000000')).toBe(before);
    expect(declaredColorContrastEvaluator(l, l.text[0])('#FFFFFF')).not.toBe(on('#FFFFFF'));
  });
  it('refuses an unsatisfiable palette without changing the field or adding a text plaque', () => {
    const l = stage();
    l.background.color = '#000000';
    l.background.field!.stops = [{ at: 0, color: '#000000' }, { at: .87, color: '#FFFFFF' },
      { at: .91, color: '#000000' }, { at: 1, color: '#000000' }];
    const background = structuredClone(l.background);
    conformToHouseRules(l, copy, palette);
    expect(l.background).toEqual(background);
    expect(l.shapes).toEqual([]);
    expect(palette).toContain(l.text[0].color);
    expect(declaredTextContrast(l, l.text[0])).toBeLessThan(4.5);
    expect(evaluateHardQa(l, { width: 800, height: 1000, copyScripts: ['latin'], latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic', palette, logoAspect: 1, copyText: copy.text }).defectCodes).toContain('CONTRAST');
  });
  it('keeps the repaired ink and background independently editable with exact live copy', async () => {
    const l = prepareGeneratedLayoutV3(stage(), copy, { width: 800, height: 1000, palette, ornament });
    const before = structuredClone(l);
    const output = await encodeStudioTransferV2(l, ['Hi']);
    const files = unzipSync(output.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(l).toEqual(before);
    expect(xml).toContain('<a:t>Hi</a:t>');
    expect(xml).toContain('<a:srgbClr val="000000"');
    expect(xml).toContain('<a:gradFill');
    expect(output.manifest.plan.backgroundField).toEqual(l.background.field);
    expect(l.text[0].color).toBe('#000000');
  });
});
