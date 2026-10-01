import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { compileLogoVisibility, readLogoVisibility } from '../src/studio/art-direction/logo-visibility.js';
import { logoGroundQuiet, readLogoGround, renderLogoTemplate, readRenderedLogoVisibility, settleLogoGround } from '../src/studio/art-direction/logo-ground.js';
import { solveRecipe } from '../src/studio/art-direction/solver.js';
import { renderLayoutV2Async } from '../src/studio/render-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';

const BLUE = [15, 35, 65] as const, WHITE = [255, 255, 255] as const;
function image(w = 104, h = 64): PNG { return new PNG({ width: w, height: h }); }
function rect(p: PNG, x: number, y: number, w: number, h: number, color: readonly number[]): void {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
    const i = (py * p.width + px) * 4; p.data[i] = color[0]; p.data[i + 1] = color[1]; p.data[i + 2] = color[2]; p.data[i + 3] = 255;
  }
}
function composite(logo: PNG, color: readonly number[]): PNG {
  const out = image(logo.width, logo.height);
  for (let i = 0; i < out.data.length; i += 4) {
    const alpha = logo.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(alpha * logo.data[i + c] + (1 - alpha) * color[c]);
    out.data[i + 3] = 255;
  }
  return out;
}
const logoSource = () => { const p = image(); rect(p, 4, 5, 65, 48, BLUE); rect(p, 78, 15, 20, 32, WHITE); return p; };

describe('source component logo visibility', () => {
  it('rejects a high-contrast minority when most source artwork disappears', () => {
    const source = logoSource(), actual = composite(source, BLUE), empty = image(); rect(empty, 0, 0, 104, 64, BLUE);
    const legacy = readLogoGround(actual, empty, { x: 0, y: 0, width: 104, height: 64 }, { x: 0, y: 0, width: 104, height: 64 });
    expect(legacy.contrast).toBeGreaterThan(3); // This was sufficient to pass ADR180's original check.
    expect(logoGroundQuiet(legacy)).toBe(false); // Historical statistic grants no feature certification.
    const reading = readLogoVisibility(actual, compileLogoVisibility(source));
    expect(reading.componentCount).toBe(2);
    expect(reading.worstComponent).toBe(0);
    expect(reading.passed).toBe(false);
  });
  it('a small missing wordmark component cannot hide behind global coverage', () => {
    const p = image(); rect(p, 4, 4, 86, 48, BLUE); rect(p, 95, 20, 3, 6, WHITE);
    const r = readLogoVisibility(composite(p, WHITE), compileLogoVisibility(p));
    expect(r.coverage).toBeGreaterThan(.9);
    expect(r.worstComponent).toBe(0);
    expect(r.passed).toBe(false);
  });
  it('keeps the intrinsic lettering of an approved opaque plate on either light or dark paper', () => {
    const p = image(); rect(p, 4, 4, 96, 56, WHITE); rect(p, 25, 15, 10, 34, BLUE); rect(p, 50, 15, 10, 34, BLUE);
    const bytes = Buffer.from(p.data), signature = compileLogoVisibility(p);
    for (const ground of [WHITE, BLUE]) expect(readLogoVisibility(composite(p, ground), signature).passed).toBe(true);
    expect(p.data).toEqual(bytes);
  });
  it('flat light and dark wordmarks work on the opposing ground and fail on their own ground', () => {
    for (const [ink, good] of [[WHITE, BLUE], [BLUE, WHITE]]) {
      const p = image(); rect(p, 10, 10, 60, 35, ink);
      const template = compileLogoVisibility(p);
      expect(readLogoVisibility(composite(p, good), template).passed).toBe(true);
      expect(readLogoVisibility(composite(p, ink), template).passed).toBe(false);
    }
  });
  it('absent/oversized/geometry-mismatched evidence refuses measurement', () => {
    expect(() => compileLogoVisibility(image())).toThrow('LOGO_UNMEASURED');
    expect(() => compileLogoVisibility({ width: 2048, height: 2048, data: new Uint8Array() })).toThrow('LOGO_UNMEASURED');
    expect(() => readLogoVisibility(image(103, 64), compileLogoVisibility(logoSource()))).toThrow('LOGO_UNMEASURED');
  });
});

const PALETTE = ['#0F2341', '#FFFFFF'];
const COPY = { 0: 'Source-aware logo control' };
function layout() { return solveRecipe({ width: 1080, height: 1350, photos: [{ photoIndex: 0, width: 1280, height: 853 }],
  palette: PALETTE, logoAspect: 104 / 64, copy: { text: COPY },
  choice: { recipe: 'hero_fade_report', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
    slots: [{ copyIndex: 0, slot: 'title' }], params: { frame: 'inset' } } }); }

describe('rendered source binding and final gate', () => {
  it('rejects edited pixels and stale geometry even when saved metadata claims success', async () => {
    const l = layout(), p = image(1280, 853); rect(p, 0, 0, 1280, 853, WHITE);
    const source = image(); rect(source, 5, 5, 85, 50, BLUE);
    const opts = { copyText: COPY, logoDataUri: `data:image/png;base64,${PNG.sync.write(source).toString('base64')}`,
      photoFiles: [{ bytes: PNG.sync.write(p), mediaType: 'image/png' }] };
    const template = await renderLogoTemplate(l, opts), rendered = await renderLayoutV2Async(l, opts);
    expect(readRenderedLogoVisibility(rendered.noTextPng, l.logo, template).passed).toBe(true);
    const tampered = PNG.sync.read(rendered.noTextPng), r = template.region;
    rect(tampered, r.x, r.y, r.width, r.height, WHITE);
    const qa = (compositeBytes: Buffer, sourceTemplate = template) => evaluateHardQa(l, {
      width: l.width, height: l.height, copyScripts: ['latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
      palette: PALETTE, logoAspect: 104 / 64, photoCount: 1, copyText: COPY,
      renderedComposite: compositeBytes, logoVisibilityRequired: true, logoVisibilityTemplate: sourceTemplate });
    expect(qa(rendered.noTextPng).defectCodes).not.toContain('LOGO_UNREADABLE');
    expect(qa(PNG.sync.write(tampered)).defectCodes).toContain('LOGO_UNREADABLE');
    expect(qa(rendered.noTextPng, { ...template, logo: { ...template.logo, x: l.logo.x + 1 } }).defectCodes).toContain('LOGO_UNMEASURED');
    expect(evaluateHardQa(l, { width: 1080, height: 1350, copyScripts: ['latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
      palette: PALETTE, logoAspect: 104 / 64, photoCount: 1, copyText: COPY, logoVisibilityRequired: true }).defectCodes).toContain('LOGO_UNMEASURED');
  });
  it('an existing panel is measured; impossible approved tones refuse instead of accepting the last tab', async () => {
    const l = layout(), source = image(); rect(source, 5, 5, 85, 50, WHITE);
    const photo = image(1280, 853); rect(photo, 0, 0, 1280, 853, WHITE);
    const onWhite = { ...l, background: { ...l.background, color: '#FFFFFF' }, overlays: [], shapes: [{ kind: 'rect' as const, role: 'panel' as const, layer: 'overlay' as const,
      color: '#FFFFFF', x: 0, y: 0, width: 1080, height: 1350 }] };
    await expect(settleLogoGround(onWhite, { palette: ['#FFFFFF'], render: {
      logoDataUri: `data:image/png;base64,${PNG.sync.write(source).toString('base64')}`,
      photoFiles: [{ bytes: PNG.sync.write(photo), mediaType: 'image/png' }] } })).rejects.toThrow('LOGO_UNREADABLE');
  }, 60000);
});
