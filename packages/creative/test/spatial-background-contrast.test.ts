import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { declaredTextContrast, computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import type { OverlayElement, StudioLayoutV2 } from '../src/studio/layout-v2.js';
import type { BackgroundField } from '../src/studio/background-field.js';
import { backgroundFieldLuminanceBounds } from '../src/studio/background-field.js';
import { rgbToLuminance } from '../src/studio/luminance.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { carrierOf, overlayOpacityOver } from '../src/studio/art-direction/surfaces.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { flatPng } from './fixtures/synthetic-photos.js';

function layout(direction: BackgroundField['direction'] = 'to-bottom'): StudioLayoutV2 {
  const vertical = direction === 'to-bottom' || direction === 'to-top';
  const reversed = direction === 'to-top' || direction === 'to-left';
  return { version: 2, width: 800, height: 1000, grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#000000', field: { kind: 'linear', direction,
      stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#FFFFFF' }] } },
    shapes: [], logo: { x: 620, y: 450, width: 100, height: 100 },
    text: [{ copyIndex: 0, role: 'title', x: vertical ? 60 : reversed ? 650 : 60,
      y: vertical ? reversed ? 850 : 60 : 60, width: vertical ? 500 : 90, height: 90,
      fontSize: 40, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true, lineHeight: 1.2 }] };
}
describe('spatial declared gradient contrast', () => {
  for (const direction of ['to-bottom', 'to-top', 'to-right', 'to-left'] as const) {
    it(`keeps readable ink in the dark region of a ${direction} field`, () => {
      const l = layout(direction);
      const before = structuredClone(l);
      const contrast = declaredTextContrast(l, l.text[0]);
      expect(contrast).toBeGreaterThan(10);
      const render = renderLayoutV2(l, { copyText: { 0: 'Hi' }, logoDataUri: KAAE_TEST_LOGO });
      const measured = computeBoxP05Contrast(PNG.sync.read(render.noTextPng), l.text[0], '#FFFFFF');
      expect(contrast).toBeLessThanOrEqual(measured);
      expect(l).toEqual(before);
    });
  }
  it('includes an interior bright stop even when both ends of the text extent are dark', () => {
    const l = layout(); l.text[0].y = 100; l.text[0].height = 300;
    l.background.field!.stops = [{ at: 0, color: '#000000' }, { at: .2, color: '#FFFFFF' },
      { at: .4, color: '#000000' }, { at: 1, color: '#000000' }];
    expect(declaredTextContrast(l, l.text[0])).toBe(1);
  });
  it('does not let a bright stop outside the text extent reject a dark local surface', () => {
    const l = layout(); l.text[0].y = 800;
    l.background.field!.stops = [{ at: 0, color: '#000000' }, { at: .2, color: '#FFFFFF' },
      { at: .4, color: '#000000' }, { at: 1, color: '#000000' }];
    expect(declaredTextContrast(l, l.text[0])).toBeGreaterThan(20);
  });
  it('refuses an interior luminance crossing, rather than checking only endpoints', () => {
    const l = layout(); l.text[0].y = 100; l.text[0].height = 800; l.text[0].color = '#777777';
    expect(declaredTextContrast(l, l.text[0])).toBe(1);
  });
  it('preserves an actual opaque carrier instead of measuring the field beneath it', () => {
    const l = layout(); l.text[0].y = 500;
    l.shapes.push({ kind: 'rect', role: 'panel', layer: 'overlay', color: '#000000',
      x: 50, y: 490, width: 520, height: 120 });
    expect(declaredTextContrast(l, l.text[0])).toBe(21);
  });
  it('fails closed on a missing or invalid text footprint', () => {
    for (const patch of [{ y: 2000 }, { x: NaN }, { width: 0 }, { height: -1 }]) {
      const l = layout(); Object.assign(l.text[0], patch);
      expect(declaredTextContrast(l, l.text[0])).toBe(1);
    }
  });
  for (const colors of [['#FF0000', '#00FF00'], ['#0000FF', '#FFFF00'],
    ['#000000', '#FFFFFF', '#000000', '#FFFFFF']]) {
    it(`encloses every rendered pixel for opposing channels and interior stops ${colors.join('/')}`, () => {
      const l = layout(); l.text[0].height = 800;
      l.background.field!.stops = colors.map((color, i) => ({ color, at: i / (colors.length - 1) }));
      const bounds = backgroundFieldLuminanceBounds(l.background.field!, l.width, l.height, l.text[0]);
      const render = renderLayoutV2(l, { copyText: { 0: 'Hi' }, logoDataUri: KAAE_TEST_LOGO });
      const png = PNG.sync.read(render.noTextPng);
      let min = 1, max = 0;
      // An independent raster oracle; the logo is outside this column.
      for (let y = l.text[0].y; y <= l.text[0].y + l.text[0].height; y++) {
        const i = (y * png.width + 100) * 4;
        const lum = rgbToLuminance(png.data[i], png.data[i + 1], png.data[i + 2]);
        min = Math.min(min, lum); max = Math.max(max, lum);
      }
      expect(bounds.min).toBeLessThanOrEqual(min);
      expect(bounds.max).toBeGreaterThanOrEqual(max);
      expect(max - bounds.max).toBeGreaterThan(-.04);
      expect(min - bounds.min).toBeLessThan(.04);
    });
  }
  it('uses local contrast in final QA without waiving measured pixels or palette checks', () => {
    const l = layout(); l.text[0].width = 680; l.logo.x = 640;
    const context = { width: 800, height: 1000, copyScripts: ['latin' as const], latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic', palette: ['#000000', '#FFFFFF'], logoAspect: 1,
      copyText: { 0: 'Hi' } };
    const render = renderLayoutV2(l, { copyText: context.copyText, logoDataUri: KAAE_TEST_LOGO });
    const qa = evaluateHardQa(l, { ...context, renderedComposite: render.noTextPng });
    expect(qa.defectCodes).toEqual([]);
    expect(qa.passed).toBe(true);
    expect(qa.defectCodes).not.toContain('CONTRAST');
    const blank = new PNG({ width: 800, height: 1000 }); blank.data.fill(255);
    const hidden = evaluateHardQa(l, { ...context, renderedComposite: PNG.sync.write(blank) });
    expect(hidden.defectCodes).toContain('CONTRAST');
    l.background.field!.stops[1].color = '#FF00FF';
    expect(evaluateHardQa(l, context).defectCodes).toContain('PALETTE');
  });
});

describe('complete opacity enclosure for text carriers', () => {
  const overlay = (direction: OverlayElement['direction']): OverlayElement => ({
    kind: 'gradient', purpose: 'scrim', color: '#000000', direction,
    x: 0, y: 0, width: 800, height: 1000, stops: [
      { at: 0, opacity: 1 }, { at: .47, opacity: 1 }, { at: .48, opacity: 0 },
      { at: .49, opacity: 1 }, { at: 1, opacity: 1 },
    ],
  });
  for (const direction of ['to-bottom', 'to-top', 'to-right', 'to-left'] as const) {
    it(`refuses a narrow interior dip in a ${direction} carrier`, () => {
      const o = overlay(direction), box = { x: 0, y: 0, width: 800, height: 1000 };
      expect(overlayOpacityOver(o, box)).toBe(0);
      expect(carrierOf({ shapes: [], overlays: [o] }, box)).toBeUndefined();
    });
  }
  it('includes interior radial rings instead of just the farthest corner', () => {
    const o = overlay('radial'), box = { x: 300, y: 290, width: 200, height: 420 };
    expect(overlayOpacityOver(o, box)).toBe(0);
    expect(carrierOf({ shapes: [], overlays: [o] }, box)).toBeUndefined();
  });
  it('ignores a dip outside the actual radial footprint', () => {
    const o = overlay('radial'), box = { x: 560, y: 475, width: 10, height: 50 };
    expect(overlayOpacityOver(o, box)).toBe(1);
  });
  it('ignores a dip outside the linear footprint without treating the full canvas as the carrier', () => {
    const o = overlay('to-bottom'), box = { x: 60, y: 700, width: 680, height: 100 };
    expect(overlayOpacityOver(o, box)).toBe(1);
    expect(carrierOf({ shapes: [], overlays: [o] }, box)?.kind).toBe('overlay');
  });
  it('refuses the actual transparent strip over a photograph before measured QA', () => {
    const l = layout(); delete l.background.field;
    l.text[0].width = 680; l.text[0].height = 800;
    l.photos = [{ photoIndex: 0, role: 'hero', x: 0, y: 0, width: 800, height: 1000 }];
    l.overlays = [overlay('to-bottom')];
    l.artDirection = { recipe: 'hero_plate', titleZone: { ...l.text[0] }, omittedPhotos: [], rtl: false };
    const render = renderLayoutV2(l, { copyText: { 0: 'Hi' }, logoDataUri: KAAE_TEST_LOGO,
      photoFiles: [{ bytes: flatPng(800, 1000, [255, 255, 255]) }] });
    const png = PNG.sync.read(render.noTextPng);
    expect(png.data[(480 * png.width + 100) * 4]).toBeGreaterThan(240);
    expect(png.data[(400 * png.width + 100) * 4]).toBeLessThan(10);
    const result = validateLayoutV2(l, { expectedWidth: 800, expectedHeight: 1000,
      copyCount: 1, copyScripts: ['latin'], photoCount: 1,
      reference: { rules: { fontFamily: 'Verdana', palette: ['#000000', '#FFFFFF'] }, logoAspect: 1 } });
    expect(result).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(result.ok ? '' : result.message).toContain('sits bare');
  });
});
