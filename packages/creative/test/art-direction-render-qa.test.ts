import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { flatPng, pixelAt, syntheticPhoto } from './fixtures/synthetic-photos.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa, type HardQaContext } from '../src/studio/hard-qa.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { solveRecipe, type SolverPhoto } from '../src/studio/art-direction/solver.js';
import { analysePhotoAsync, analysePixels } from '../src/studio/art-direction/photo-analysis.js';
import { PNG } from 'pngjs';

/**
 * ADR-170: the renderer's new layers (fade, blended texture, plates and cards with a soft shadow,
 * stroke-only frames, z-order), the validator's rules for text over photos, hard QA's measured
 * contrast for it, and the Canva transfer keeping the photo native under a separate fade PNG.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const NAVY = '#0A1628';
const GOLD = '#F7B500';
const COPY = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward', 3: 'kaae.org' };
const WHITE_PHOTO = flatPng(400, 500, [255, 255, 255]);
const RED_PHOTO = flatPng(400, 300, [220, 20, 20]);
const logoDataUri = KAAE_TEST_LOGO;

const dist = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** A hand-built layout exercising every new layer. */
function layered(): StudioLayoutV2 {
  return {
    version: 2, width: 800, height: 1000,
    grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: NAVY },
    shapes: [
      // Under the photos: hidden by the full-bleed hero.
      { kind: 'rect', role: 'panel', color: '#4770A3', x: 0, y: 0, width: 100, height: 100 },
      // Over the photos: a plate with a soft shadow, a stroke-only inset frame.
      { kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: '#1E3A5F', x: 200, y: 200, width: 400, height: 120, shadow: { color: NAVY, opacity: 0.6, blur: 12, offsetY: 10 } },
      { kind: 'rect', role: 'frame', layer: 'overlay', fill: 'none', color: GOLD, strokeColor: GOLD, strokeWidth: 4, x: 24, y: 24, width: 752, height: 952 },
    ],
    overlays: [{ kind: 'gradient', purpose: 'fade', color: NAVY, direction: 'to-bottom', x: 0, y: 500, width: 800, height: 500, stops: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }] }],
    photos: [
      { photoIndex: 0, role: 'hero', x: 0, y: 0, width: 800, height: 1000 },
      { photoIndex: 1, role: 'texture', x: 0, y: 600, width: 800, height: 400, opacity: 0.5 },
    ],
    text: [{ copyIndex: 0, role: 'title', x: 220, y: 220, width: 360, height: 80, fontSize: 30, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center', bold: true }],
    logo: { x: 640, y: 60, width: 100, height: 100 },
    artDirection: { recipe: 'hero_plate', titleZone: { x: 200, y: 200, width: 400, height: 120 }, omittedPhotos: [], rtl: false },
  };
}

describe('renderer layers (ADR-170)', () => {
  const out = renderLayoutV2(layered(), { copyText: { 0: 'Title' }, logoDataUri, photoFiles: [{ bytes: WHITE_PHOTO }, { bytes: RED_PHOTO }] });
  const px = (x: number, y: number) => pixelAt(out.noTextPng, x, y);

  it('draws plates and frames over the photo, and shapes without a layer under it', () => {
    expect(dist(px(50, 50), [255, 255, 255])).toBeLessThan(3); // the under-photo panel is hidden
    expect(dist(px(400, 260), [0x1e, 0x3a, 0x5f])).toBeLessThan(3); // the plate is over the hero
    expect(dist(px(24, 400), [0xf7, 0xb5, 0x00])).toBeLessThan(40); // the frame's stroke
    expect(dist(px(40, 400), [255, 255, 255])).toBeLessThan(3); // stroke only: the photo shows inside it
  });

  it('casts the plate\'s soft shadow below it and nothing far from it', () => {
    const below = px(400, 330);
    expect(below[0]).toBeLessThan(230);
    expect(dist(px(400, 420), [255, 255, 255])).toBeLessThan(3);
  });

  it('fades to navy over the photo, and blends the texture photo under the fade at its opacity', () => {
    expect(dist(px(400, 505), [255, 255, 255])).toBeLessThan(8);
    expect(dist(px(400, 995), [0x0a, 0x16, 0x28])).toBeLessThan(8);
    // Texture at 50% over the white hero, at the top of its box where the fade is ~20%.
    const [r, g] = px(400, 602);
    expect(r).toBeGreaterThan(g + 40);
  });
});

function recipeLayout(): { layout: StudioLayoutV2; photos: Buffer[] } {
  const photos = Array.from({ length: 6 }, (_, i) => syntheticPhoto(320, 213, i + 1));
  const facts: SolverPhoto[] = photos.map((_, i) => ({ photoIndex: i, width: 320, height: 213 }));
  const layout = solveRecipe({
    width: 1080, height: 1350, copy: { text: COPY }, photos: facts, palette: PALETTE, logoAspect: 1,
    choice: {
      recipe: 'hero_fade_report', heroPhotoIndex: 0, texturePhotoIndex: 4, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }, { copyIndex: 3, slot: 'cta' }],
      params: { frame: 'inset' },
    },
  });
  return { layout, photos };
}

const qaContext = (extra: Partial<HardQaContext> = {}): HardQaContext => ({
  width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin', 'latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
  palette: PALETTE, logoAspect: 1, copyText: COPY, photoCount: 6, photoSelection: { mode: 'choose', minimum: 2 }, ...extra,
});

describe('validator: text over a photo (ADR-170)', () => {
  const ctx = (photoCount = 2): LayoutValidationContext => ({
    expectedWidth: 800, expectedHeight: 1000, copyCount: 1, copyScripts: ['latin'], photoCount,
    photoSelection: { mode: 'all', minimum: photoCount },
    reference: { rules: { fontFamily: 'Verdana', palette: PALETTE }, logoAspect: 1 },
  });

  it('accepts text carried by a plate over the photo', () => {
    expect(validateLayoutV2(layered(), ctx())).toMatchObject({ ok: true });
  });

  it('refuses text bare on the photo, even in a recipe', () => {
    const bare = layered();
    bare.text[0] = { ...bare.text[0], y: 360 };
    expect(validateLayoutV2(bare, ctx())).toMatchObject({ ok: false, code: 'PHOTOS' });
  });

  it('refuses text where the fade is still too thin to carry it, and accepts it where it is dense', () => {
    const thin = layered();
    thin.text[0] = { ...thin.text[0], y: 520 };
    expect(validateLayoutV2(thin, ctx())).toMatchObject({ ok: false, code: 'PHOTOS' });
    const dense = layered();
    dense.text[0] = { ...dense.text[0], y: 860 };
    expect(validateLayoutV2(dense, ctx())).toMatchObject({ ok: true });
  });

  it('keeps the old rules for a layout that is not a recipe: no text on a photo, no logo on one, no textures', () => {
    const plain = layered();
    delete plain.artDirection;
    expect(validateLayoutV2(plain, ctx())).toMatchObject({ ok: false, code: 'PHOTOS' });
  });

  it('a stroke-only frame does not collide with the text well inside it', () => {
    const l = layered();
    l.shapes = l.shapes.filter((s) => s.role === 'frame');
    l.photos = [];
    delete l.overlays;
    delete l.artDirection;
    expect(validateLayoutV2(l, ctx(0))).toMatchObject({ ok: true });
  });
});

describe('hard QA on a recipe (ADR-170)', () => {
  it('holds text over a photo to contrast measured on the rendered pixels; without them it is a defect', async () => {
    const { layout, photos } = recipeLayout();
    const unmeasured = evaluateHardQa(layout, qaContext());
    expect(unmeasured.passed).toBe(false);
    expect(unmeasured.defectCodes).toContain('CONTRAST');
    expect(unmeasured.messages.join(' ')).toMatch(/not measured on the rendered pixels/);

    const render = renderLayoutV2(layout, { copyText: COPY, logoDataUri, photoFiles: photos.map((bytes) => ({ bytes })) });
    const measured = evaluateHardQa(layout, qaContext({ renderedComposite: render.noTextPng }));
    expect(measured.messages).toEqual([]);
    expect(measured.passed).toBe(true);
    for (const t of layout.text) expect(measured.measuredContrast![t.copyIndex]).toBeGreaterThanOrEqual(3);
    // The recipe's own choice of photos is recorded, as a requester's choice is.
    expect(measured.omittedPhotos).toEqual([1, 2, 3, 5]);
  });

  it('fails the measured gate when the fade is removed and the text lies bare on a bright photo', () => {
    const { layout, photos } = recipeLayout();
    const faded = { ...layout, overlays: layout.overlays!.map((o) => ({ ...o, stops: [{ at: 0, opacity: 0 }, { at: 1, opacity: 0.56 }] })) };
    const bright = photos.map(() => flatPng(320, 213, [250, 250, 250]));
    const render = renderLayoutV2(faded, { copyText: COPY, logoDataUri, photoFiles: bright.map((bytes) => ({ bytes })) });
    const outcome = evaluateHardQa(faded, qaContext({ renderedComposite: render.noTextPng }));
    expect(outcome.defectCodes).toContain('CONTRAST');
  });
});

describe('Canva transfer of a recipe (ADR-170): editable, in the preview\'s order', () => {
  it('keeps the hero a native cropped picture, the fade its own PNG above it, plates and pills native shapes, and text native', async () => {
    const { layout, photos } = recipeLayout();
    const copy = [COPY[0], COPY[1], COPY[2], COPY[3]];
    const logoBytes = Buffer.from(logoDataUri.split(',')[1], 'base64');
    const { createHash } = await import('node:crypto');
    const res = await encodeStudioTransferV2(JSON.parse(JSON.stringify(layout)), copy,
      { bytes: logoBytes, mimeType: 'image/png', sha256: createHash('sha256').update(logoBytes).digest('hex') } as never,
      { photos: photos.map((bytes) => ({ bytes, mimeType: 'image/png' as const })) });
    const files = unzipSync(new Uint8Array(res.bytes));
    const slide = strFromU8(files['ppt/slides/slide1.xml']);
    const pics = [...slide.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]);
    // Hero first: native, cropped by srcRect around its focus, not a baked PNG.
    const heroAt = slide.indexOf('<p:pic>');
    expect(pics[0]).toMatch(/<a:srcRect/);
    // The texture is its own alpha-faded picture; the fade is a separate PNG named for Canva's layers.
    const fadeAt = slide.indexOf('name="Fade 0"');
    expect(fadeAt).toBeGreaterThan(heroAt);
    expect(pics.length).toBeGreaterThanOrEqual(4); // hero, texture, fade, logo
    // Pill and frame native shapes above the fade; the frame has no fill.
    const pillAt = slide.indexOf('name="Pill');
    const frameAt = slide.indexOf('name="Frame');
    expect(pillAt).toBeGreaterThan(fadeAt);
    expect(frameAt).toBeGreaterThan(fadeAt);
    const frameShape = slide.slice(frameAt, slide.indexOf('</p:sp>', frameAt));
    expect(frameShape).toMatch(/<a:solidFill><a:srgbClr val="F7B500"><a:alpha val="0"\/>/);
    // Every copy block native text, after the overlays.
    for (const text of ['KAAE K', 'Field Visit Report', 'Insights from KAAE', 'kaae.org']) {
      const at = slide.indexOf(text);
      expect(at, text).toBeGreaterThan(pillAt);
    }
    // The fade PNG really is transparent at its top and navy at its bottom.
    const media = Object.entries(files).filter(([n]) => n.startsWith('ppt/media/') && n.endsWith('.png'));
    const fadePng = media.map(([, b]) => PNG.sync.read(Buffer.from(b))).find((p) => p.width === 540 && p.data[3] <= 5);
    expect(fadePng).toBeDefined();
    const last = ((fadePng!.height - 1) * fadePng!.width) * 4;
    expect(fadePng!.data[last + 3]).toBeGreaterThan(230);
  });

  it('carries a card\'s soft shadow natively', async () => {
    const photos = [syntheticPhoto(320, 400, 3)];
    const layout = solveRecipe({
      width: 1080, height: 1350, copy: { text: { 0: 'Why Accreditation?', 1: 'Quality assurance and public trust.' } },
      photos: [{ photoIndex: 0, width: 320, height: 400 }], palette: PALETTE, logoAspect: 1,
      choice: { recipe: 'hero_card', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }], params: {} },
    });
    const logoBytes = Buffer.from(logoDataUri.split(',')[1], 'base64');
    const { createHash } = await import('node:crypto');
    const res = await encodeStudioTransferV2(layout, ['Why Accreditation?', 'Quality assurance and public trust.'],
      { bytes: logoBytes, mimeType: 'image/png', sha256: createHash('sha256').update(logoBytes).digest('hex') } as never,
      { photos: photos.map((bytes) => ({ bytes, mimeType: 'image/png' as const })) });
    const slide = strFromU8(unzipSync(new Uint8Array(res.bytes))['ppt/slides/slide1.xml']);
    const cardAt = slide.indexOf('name="Card');
    expect(cardAt).toBeGreaterThan(0);
    expect(slide.slice(cardAt, slide.indexOf('</p:sp>', cardAt))).toMatch(/<a:outerShdw/);
    expect(slide.indexOf('name="Tab')).toBeGreaterThan(cardAt);
  });
});

describe('local photo analysis (ADR-170)', () => {
  it('finds the calm, bright top of a photo and scores a sharp one above a flat one', async () => {
    const busy = await analysePhotoAsync(syntheticPhoto(320, 240, 7));
    expect(busy.quiet).toBe('top');
    expect(busy.quietLuminance).toBeGreaterThan(0.8);
    const flat = await analysePhotoAsync(flatPng(320, 240, [120, 120, 120]));
    expect(busy.sharpness).toBeGreaterThan(flat.sharpness + 0.3);
    expect(busy.salient.y).toBeGreaterThan(0.5);
  });

  it('is deterministic on decoded pixels', () => {
    const png = PNG.sync.read(syntheticPhoto(200, 150, 2));
    expect(analysePixels(png, { width: 2000, height: 1500 })).toEqual(analysePixels(png, { width: 2000, height: 1500 }));
  });
});
