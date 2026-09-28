import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { unzipSync, strFromU8 } from 'fflate';
import type { PhotoElement, PhotoTreatment, StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { PHOTO_TREATMENTS, photoElementSchema, photoTreatmentSchema, studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { CUTOUT_MAX_OVERLAP_SHARE, cutoutPlacement, photoLayers, photosMayOverlap, type PhotoCutoutAsset } from '../src/studio/photo-cutout.js';
import { renderLayoutV2Async, renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { settlePhotos } from '../src/studio/pipeline-v3.js';
import { layoutDefectCount } from '../src/studio/style-spec.js';
import { scaleNormalizedLayoutToV2, type NormalizedLayoutCandidate } from '../src/studio/layout-generator-v3.js';

import { inlineSvgFiles } from '../src/studio/svg-files.js';
/**
 * The render's markup with its picture files put back inline: pictures are files beside the SVG
 * (ADR-035), and these assertions read the markup as the one document it used to be.
 */
const inlinedSvgOf = (...args: Parameters<typeof renderLayoutV2ToSvg>) => {
  const r = renderLayoutV2ToSvg(args[0], { logoDataUri: KAAE_TEST_LOGO, ...(args[1] ?? {}) });
  return { ...r, svg: inlineSvgFiles(r.svg, r.files), noTextSvg: inlineSvgFiles(r.noTextSvg, r.files) };
};

/**
 * Cut-out people: the person matted out of their photo's background and standing on the design's
 * own background, as panelists do on requesters' reference posters. The preview and the Canva deck
 * place them by one rule, framed photos are untouched, and people in a group may overlap a little.
 */

type Rgba = [number, number, number, number];

/** A synthetic RGBA PNG, one colour per pixel from `paint`. */
function rgbaPng(width: number, height: number, paint: (x: number, y: number) => Rgba): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      png.data.set(paint(x, y), (width * y + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

const RED: Rgba = [200, 30, 30, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
const BACKGROUND = '#0A1628';

/** A 100x150 "person": the left half transparent, the right half opaque red. */
const halfPerson = (): PhotoCutoutAsset => ({
  png: rgbaPng(100, 150, (x) => (x < 50 ? CLEAR : RED)),
  width: 100,
  height: 150,
});

/** The same person with a 130x30 shadow starting 15px left of them, 135px down. */
const withShadow = (): PhotoCutoutAsset => ({
  ...halfPerson(),
  shadowPng: rgbaPng(130, 30, () => [0, 0, 0, 90]),
  shadowWidth: 130,
  shadowHeight: 30,
  shadowX: -15,
  shadowY: 135,
});

const base = (): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: BACKGROUND },
  shapes: [],
  logo: { x: 86, y: 86, width: 120, height: 120 },
  text: [
    { copyIndex: 0, role: 'title', x: 86, y: 280, width: 908, height: 120, fontSize: 44, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { copyIndex: 1, role: 'body', x: 86, y: 1100, width: 908, height: 120, fontSize: 20, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
});
const copyText = { 0: 'Her path, her power', 1: 'September 25, 2026' };
const context = (photoCount: number) => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 2, copyScripts: ['latin', 'latin'] as Array<'latin' | 'arabic'>,
  photoCount,
  reference: { rules: { fontFamily: 'Verdana', palette: [BACKGROUND, '#FFFFFF'] }, logoAspect: 1.0 },
});
const withPhotos = (...photos: PhotoElement[]): StudioLayoutV2 => ({ ...base(), photos });
/** Two 400x600 portraits side by side whose boxes overlap by `overlap` px, both with `treatment`. */
const pair = (overlap: number, treatment?: PhotoTreatment): StudioLayoutV2 => {
  const t = treatment ? { treatment } : {};
  return withPhotos(
    { photoIndex: 0, role: 'portrait', x: 140, y: 440, width: 400, height: 600, ...t },
    { photoIndex: 1, role: 'portrait', x: 540 - overlap, y: 440, width: 400, height: 600, ...t },
  );
};

describe('photo treatment in the layout schema', () => {
  const photo = { photoIndex: 0, role: 'portrait', x: 86, y: 420, width: 440, height: 600 };

  it('accepts framed, cutout, and no treatment at all (framed)', () => {
    expect(PHOTO_TREATMENTS).toEqual(['framed', 'cutout']);
    expect(photoTreatmentSchema.options).toEqual(['framed', 'cutout']);
    expect(photoElementSchema.safeParse(photo).success).toBe(true);
    expect(photoElementSchema.safeParse({ ...photo, treatment: 'framed' }).success).toBe(true);
    expect(photoElementSchema.safeParse({ ...photo, treatment: 'cutout' }).success).toBe(true);
    expect(studioLayoutV2Schema.safeParse(pair(0, 'cutout')).success).toBe(true);
  });

  it('refuses any other treatment', () => {
    expect(photoElementSchema.safeParse({ ...photo, treatment: 'sticker' }).success).toBe(false);
    expect(photoElementSchema.safeParse({ ...photo, treatment: 1 }).success).toBe(false);
    expect(photoElementSchema.safeParse({ ...photo, treatment: null }).success).toBe(false);
  });
});

describe('cutoutPlacement: contain, centred, standing on the bottom edge', () => {
  it('in a tall box the width limits the person, who stands on the bottom edge', () => {
    const placed = cutoutPlacement({ x: 100, y: 200, width: 400, height: 800 }, { width: 200, height: 300 });
    expect(placed.scale).toBe(2);
    expect(placed.person).toEqual({ x: 100, y: 400, width: 400, height: 600 });
    expect(placed.shadow).toBeUndefined();
  });

  it('in a wide box the height limits the person, who is centred horizontally', () => {
    const box = { x: 0, y: 100, width: 800, height: 400 };
    const placed = cutoutPlacement(box, { width: 200, height: 300 });
    expect(placed.scale).toBeCloseTo(4 / 3, 12);
    expect(placed.person.height).toBe(400);
    expect(placed.person.width).toBeCloseTo(266.667, 3);
    expect(placed.person.y).toBe(100);
    // Centred: equal space either side.
    const left = placed.person.x - box.x;
    const right = box.x + box.width - (placed.person.x + placed.person.width);
    expect(Math.abs(left - right)).toBeLessThan(0.002);
  });

  it('always ends exactly on the bottom edge, with finite numbers', () => {
    for (const [bw, bh, cw, ch] of [[440, 600, 100, 150], [313, 470, 977, 1433], [383, 383, 1200, 800], [1000, 90, 7, 3]]) {
      const box = { x: 37, y: 91, width: bw, height: bh };
      const { person, scale } = cutoutPlacement(box, { width: cw, height: ch });
      for (const n of [person.x, person.y, person.width, person.height, scale]) expect(Number.isFinite(n)).toBe(true);
      expect(person.y + person.height).toBeCloseTo(box.y + box.height, 6);
      expect(person.width).toBeLessThanOrEqual(box.width + 0.001);
      expect(person.height).toBeLessThanOrEqual(box.height + 0.001);
      expect(person.x).toBeGreaterThanOrEqual(box.x - 0.001);
    }
  });

  it('scales the shadow with the person and offsets it from their top-left, even beyond the box', () => {
    const box = { x: 100, y: 200, width: 400, height: 800 };
    const placed = cutoutPlacement(box, { width: 200, height: 300, shadowWidth: 260, shadowHeight: 60, shadowX: -30, shadowY: 270 });
    expect(placed.person).toEqual({ x: 100, y: 400, width: 400, height: 600 });
    expect(placed.shadow).toEqual({ x: 40, y: 940, width: 520, height: 120 });
    // Out of the box on the left and at the bottom: the shadow is allowed to leave it.
    expect(placed.shadow!.x).toBeLessThan(box.x);
    expect(placed.shadow!.y + placed.shadow!.height).toBeGreaterThan(box.y + box.height);
    // No offset given: the shadow starts at the person's top-left.
    expect(cutoutPlacement(box, { width: 200, height: 300, shadowWidth: 10, shadowHeight: 10 }).shadow).toEqual({ x: 100, y: 400, width: 20, height: 20 });
  });

  it('refuses a cut-out or a box with no usable size rather than drawing nothing', () => {
    expect(() => cutoutPlacement({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 10 })).toThrow(RangeError);
    expect(() => cutoutPlacement({ x: 0, y: 0, width: 100, height: 100 }, { width: Number.NaN, height: 10 })).toThrow(RangeError);
    expect(() => cutoutPlacement({ x: 0, y: 0, width: 0, height: 100 }, { width: 10, height: 10 })).toThrow(RangeError);
  });
});

describe('photosMayOverlap', () => {
  const box = (x: number, treatment?: PhotoTreatment) => ({ x, y: 0, width: 400, height: 600, ...(treatment ? { treatment } : {}) });

  it('lets two cut-outs overlap by up to 35% of the narrower box', () => {
    expect(CUTOUT_MAX_OVERLAP_SHARE).toBe(0.35);
    expect(photosMayOverlap(box(0, 'cutout'), box(400 - 140, 'cutout'))).toBe(true);
    expect(photosMayOverlap(box(0, 'cutout'), box(400 - 141, 'cutout'))).toBe(false);
    // Measured against the narrower box: 100px is 50% of a 200px-wide person.
    expect(photosMayOverlap(box(0, 'cutout'), { x: 300, y: 0, width: 200, height: 600, treatment: 'cutout' })).toBe(false);
  });

  it('never lets a framed photo overlap anything', () => {
    expect(photosMayOverlap(box(0), box(390))).toBe(false);
    expect(photosMayOverlap(box(0, 'framed'), box(390, 'cutout'))).toBe(false);
    expect(photosMayOverlap(box(0, 'cutout'), box(390, 'framed'))).toBe(false);
  });
});

describe('photoLayers: one drawing order for the preview and the deck', () => {
  it('puts every cut-out shadow under every photo, then the photos in layout order', () => {
    const group = pair(120, 'cutout');
    group.photos!.push({ photoIndex: 2, role: 'inset', x: 86, y: 1240, width: 200, height: 100 });
    const layers = photoLayers(group.photos!, [withShadow(), withShadow()]);
    expect(layers.map((l) => `${l.kind}:${l.photo.photoIndex}`)).toEqual([
      'cutout-shadow:0', 'cutout-shadow:1', 'cutout-person:0', 'cutout-person:1', 'framed:2',
    ]);
    const person1 = layers[3];
    expect(person1.kind === 'cutout-person' && person1.rect).toEqual(cutoutPlacement(group.photos![1], withShadow()).person);
  });

  it('draws a cut-out with no asset, or a framed photo with one, framed', () => {
    const photos = pair(120, 'cutout').photos!;
    expect(photoLayers(photos, undefined).map((l) => l.kind)).toEqual(['framed', 'framed']);
    expect(photoLayers(photos, [undefined, halfPerson()]).map((l) => l.kind)).toEqual(['framed', 'cutout-person']);
    expect(photoLayers(pair(0).photos!, [halfPerson(), halfPerson()]).map((l) => l.kind)).toEqual(['framed', 'framed']);
  });
});

describe('the preview draws a cut-out person', () => {
  const box = { x: 86, y: 420, width: 440, height: 600 };
  const cutoutLayout = () => withPhotos({ photoIndex: 0, role: 'portrait', ...box, radius: 24, treatment: 'cutout' });
  const framedLayout = () => withPhotos({ photoIndex: 0, role: 'portrait', ...box, radius: 24 });
  const photoUri = `data:image/png;base64,${rgbaPng(4, 2, () => RED).toString('base64')}`;

  it('as its shadow then the person, at the helper\'s rects, with no clip-path and no corner radius', () => {
    const asset = withShadow();
    const placed = cutoutPlacement(box, asset);
    const { svg, noTextSvg } = inlinedSvgOf(cutoutLayout(), { copyText, photoDataUris: [photoUri], photoCutouts: [asset] });
    const person = svg.match(/<image id="photo-0"[^>]*\/>/)?.[0] ?? '';
    const shadow = svg.match(/<image id="photo-shadow-0"[^>]*\/>/)?.[0] ?? '';
    expect(person).toContain(`xlink:href="data:image/png;base64,${asset.png.toString('base64')}"`);
    expect(person).toContain(`x="${placed.person.x}" y="${placed.person.y}" width="${placed.person.width}" height="${placed.person.height}"`);
    expect(person).toContain('preserveAspectRatio="none"');
    expect(person).not.toContain('clip-path');
    expect(shadow).toContain(`xlink:href="data:image/png;base64,${asset.shadowPng!.toString('base64')}"`);
    expect(shadow).toContain(`x="${placed.shadow!.x}" y="${placed.shadow!.y}" width="${placed.shadow!.width}" height="${placed.shadow!.height}"`);
    expect(shadow).toContain('preserveAspectRatio="none"');
    expect(svg).not.toContain('photo-clip-0');
    expect(svg).not.toContain('rx="24"');
    // Shadow under the person, both under the copy; and both in the no-text composite that contrast is measured on.
    expect(svg.indexOf('id="photo-shadow-0"')).toBeLessThan(svg.indexOf('id="photo-0"'));
    expect(svg.indexOf('id="photo-0"')).toBeLessThan(svg.indexOf('Her path'));
    expect(noTextSvg).toContain(person);
    expect(noTextSvg).toContain(shadow);
  });

  it('lets the background through the transparent part of the person', async () => {
    const asset = halfPerson();
    const { person } = cutoutPlacement(box, asset);
    // 100x150 into 440x600: scale 4, 400x600, centred at x 106.
    expect(person).toEqual({ x: 106, y: 420, width: 400, height: 600 });
    const render = await renderLayoutV2Async(cutoutLayout(), { logoDataUri: KAAE_TEST_LOGO, copyText, photoCutouts: [asset] });
    const png = PNG.sync.read(render.png);
    const at = (x: number, y: number) => Array.from(png.data.subarray((png.width * y + x) * 4, (png.width * y + x) * 4 + 4));
    // Left half of the person: transparent, so the design's own background.
    expect(at(206, 720)).toEqual([0x0a, 0x16, 0x28, 255]);
    // Right half: the person.
    expect(at(406, 720)).toEqual([200, 30, 30, 255]);
    // The no-text composite contrast is measured on shows the same.
    const noText = PNG.sync.read(render.noTextPng);
    expect(Array.from(noText.data.subarray((noText.width * 720 + 206) * 4, (noText.width * 720 + 206) * 4 + 4))).toEqual([0x0a, 0x16, 0x28, 255]);
  });

  it('falls back to framed, exactly, when the cut-out is missing', () => {
    const framed = inlinedSvgOf(framedLayout(), { copyText, photoDataUris: [photoUri] }).svg;
    expect(inlinedSvgOf(cutoutLayout(), { copyText, photoDataUris: [photoUri] }).svg).toBe(framed);
    expect(inlinedSvgOf(cutoutLayout(), { copyText, photoDataUris: [photoUri], photoCutouts: [] }).svg).toBe(framed);
    expect(inlinedSvgOf(cutoutLayout(), { copyText, photoDataUris: [photoUri], photoCutouts: [undefined, halfPerson()] }).svg).toBe(framed);
  });

  it('keeps a neighbour\'s shadow off an overlapping person in a group', () => {
    const { svg } = inlinedSvgOf(pair(120, 'cutout'), { copyText, photoCutouts: [withShadow(), withShadow()] });
    const order = ['id="photo-shadow-0"', 'id="photo-shadow-1"', 'id="photo-0"', 'id="photo-1"'].map((id) => svg.indexOf(id));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('leaves framed photos exactly as they were drawn before, cut-outs supplied or not', () => {
    const without = inlinedSvgOf(framedLayout(), { copyText, photoDataUris: [photoUri] }).svg;
    expect(without).toContain('<clipPath id="photo-clip-0"><rect x="86" y="420" width="440" height="600" rx="24" ry="24"/></clipPath>');
    expect(without).toContain(`<image id="photo-0" xlink:href="${photoUri}" x="86" y="420" width="440" height="600" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo-clip-0)"/>`);
    const explicit = withPhotos({ photoIndex: 0, role: 'portrait', ...box, radius: 24, treatment: 'framed' });
    expect(inlinedSvgOf(explicit, { copyText, photoDataUris: [photoUri], photoCutouts: [withShadow()] }).svg).toBe(without);
    expect(inlinedSvgOf(framedLayout(), { copyText, photoDataUris: [photoUri], photoCutouts: [withShadow()] }).svg).toBe(without);
  });
});

describe('the Canva deck carries a cut-out person', () => {
  const EMU_PER_PX = 914400 / 96;
  const emu = (px: number) => Math.round((px / 96) * 914400);
  const pictures = (xml: string) => [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => ({ xml: m[0], at: m.index ?? -1 }));
  const geometry = (pic: string) => {
    const off = pic.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    return { x: Number(off?.[1]), y: Number(off?.[2]), cx: Number(ext?.[1]), cy: Number(ext?.[2]) };
  };

  it('as two pictures, shadow then person, at the helper\'s rects, uncropped, below the copy', async () => {
    const cut: PhotoElement = { photoIndex: 0, role: 'portrait', x: 86, y: 420, width: 440, height: 600, treatment: 'cutout' };
    const framed: PhotoElement = { photoIndex: 1, role: 'portrait', x: 554, y: 420, width: 440, height: 600 };
    const asset = withShadow();
    const photoBytes = rgbaPng(4, 2, () => RED);
    // The cut-out photo needs no original bytes; only the framed one does.
    const photos: Array<{ bytes: Buffer; mimeType: 'image/png' }> = [];
    photos[1] = { bytes: photoBytes, mimeType: 'image/png' };
    const deck = await encodeStudioTransferV2(withPhotos(cut, framed), [copyText[0], copyText[1]], undefined, {
      photos,
      photoCutouts: [asset],
    });
    const files = unzipSync(new Uint8Array(deck.bytes));
    const slide = strFromU8(files['ppt/slides/slide1.xml']);
    const pics = pictures(slide);
    const shadowPic = pics.find((p) => p.xml.includes('name="Photo 0 shadow"'));
    const personPic = pics.find((p) => p.xml.includes('name="Photo 0"'));
    expect(shadowPic).toBeDefined();
    expect(personPic).toBeDefined();

    const placed = cutoutPlacement(cut, asset);
    expect(geometry(personPic!.xml)).toEqual({ x: emu(placed.person.x), y: emu(placed.person.y), cx: emu(placed.person.width), cy: emu(placed.person.height) });
    expect(geometry(shadowPic!.xml)).toEqual({ x: emu(placed.shadow!.x), y: emu(placed.shadow!.y), cx: emu(placed.shadow!.width), cy: emu(placed.shadow!.height) });
    expect(geometry(personPic!.xml).x / EMU_PER_PX).toBeCloseTo(106, 3);
    for (const pic of [shadowPic!, personPic!]) {
      expect(pic.xml).not.toContain('<a:srcRect');
      expect(pic.xml).toContain('<a:stretch><a:fillRect/></a:stretch>');
      expect(pic.xml).toContain('prst="rect"');
    }
    // The framed photo beside it is still cover-cropped, so the check above means something.
    const framedPic = pics.filter((p) => p !== shadowPic && p !== personPic);
    expect(framedPic).toHaveLength(1);
    expect(framedPic[0].xml).toContain('<a:srcRect');

    // Layer order as the preview draws: shadow, person, then the copy above them.
    expect(shadowPic!.at).toBeLessThan(personPic!.at);
    expect(personPic!.at).toBeLessThan(slide.indexOf('Her path'));

    // The deck embeds the cut-out PNGs themselves.
    const media = Object.entries(files).filter(([name]) => name.startsWith('ppt/media/')).map(([, bytes]) => Buffer.from(bytes));
    expect(media.some((m) => m.equals(asset.png))).toBe(true);
    expect(media.some((m) => m.equals(asset.shadowPng!))).toBe(true);
  });

  it('stacks a group as the preview does: both shadows, then both people', async () => {
    const deck = await encodeStudioTransferV2(pair(120, 'cutout'), [copyText[0], copyText[1]], undefined, { photoCutouts: [withShadow(), withShadow()] });
    const names = pictures(strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml'])).map((p) => p.xml.match(/name="([^"]*)"/)?.[1]);
    expect(names).toEqual(['Photo 0 shadow', 'Photo 1 shadow', 'Photo 0', 'Photo 1']);
  });

  it('as one picture when the cut-out has no shadow, and framed when there is no cut-out', async () => {
    const cut: PhotoElement = { photoIndex: 0, role: 'portrait', x: 86, y: 420, width: 440, height: 600, treatment: 'cutout' };
    const photoBytes = rgbaPng(4, 2, () => RED);
    const single = await encodeStudioTransferV2(withPhotos(cut), [copyText[0], copyText[1]], undefined, { photoCutouts: [halfPerson()] });
    const singlePics = pictures(strFromU8(unzipSync(new Uint8Array(single.bytes))['ppt/slides/slide1.xml']));
    expect(singlePics).toHaveLength(1);
    expect(singlePics[0].xml).toContain('name="Photo 0"');

    const fallback = await encodeStudioTransferV2(withPhotos(cut), [copyText[0], copyText[1]], undefined, { photos: [{ bytes: photoBytes, mimeType: 'image/png' }] });
    const fallbackPics = pictures(strFromU8(unzipSync(new Uint8Array(fallback.bytes))['ppt/slides/slide1.xml']));
    expect(fallbackPics).toHaveLength(1);
    expect(fallbackPics[0].xml).toContain('<a:srcRect');
    // With neither a cut-out nor the photo's bytes, the deck is still refused.
    await expect(encodeStudioTransferV2(withPhotos(cut), [copyText[0], copyText[1]], undefined, {})).rejects.toThrow(/Photo 0 .*no bytes/);
  });
});

describe('cut-out people in a group may overlap', () => {
  it('validation accepts cut-outs overlapping by up to 35% and refuses more, or framed photos overlapping at all', () => {
    expect(validateLayoutV2(pair(0, 'cutout'), context(2)).ok).toBe(true);
    expect(validateLayoutV2(pair(120, 'cutout'), context(2)).ok).toBe(true);
    expect(validateLayoutV2(pair(160, 'cutout'), context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(validateLayoutV2(pair(120), context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(validateLayoutV2(pair(120, 'framed'), context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
    const mixed = pair(120, 'cutout');
    delete mixed.photos![1].treatment;
    expect(validateLayoutV2(mixed, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
    // Everything else still applies to a cut-out: text on it is refused.
    const underText = pair(0, 'cutout');
    underText.photos![0].y = 300;
    expect(validateLayoutV2(underText, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
  });

  it('the defect count guarded passes compare agrees', () => {
    const copy = { text: copyText };
    expect(layoutDefectCount(pair(120, 'cutout'), copy)).toBe(layoutDefectCount(pair(0, 'cutout'), copy));
    expect(layoutDefectCount(pair(120), copy)).toBe(layoutDefectCount(pair(0), copy) + 1);
  });

  it('settlePhotos leaves overlapping cut-outs where they stand', () => {
    const group = pair(120, 'cutout');
    expect(settlePhotos(JSON.parse(JSON.stringify(group)))).toEqual(group);
  });

  it('settlePhotos still separates overlapping framed photos', () => {
    const settled = settlePhotos(pair(120));
    const [a, b] = settled.photos!;
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
    expect(validateLayoutV2(settled, context(2)).ok).toBe(true);
  });

  it('settlePhotos still moves a cut-out that text covers, and keeps it a cut-out', () => {
    const covered = pair(120, 'cutout');
    covered.photos!.forEach((p) => { p.y = 300; });
    expect(validateLayoutV2(covered, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });
    const settled = settlePhotos(covered);
    expect(validateLayoutV2(settled, context(2)).ok).toBe(true);
    expect(settled.photos!.map((p) => p.treatment)).toEqual(['cutout', 'cutout']);
    expect(settled.text[0].y).toBe(280); // the copy did not move
  });
});

describe('the generator normalisation keeps a photo\'s treatment', () => {
  const norm = (treatment?: PhotoTreatment): NormalizedLayoutCandidate => ({
    id: 'c1', conceptTitle: 'Two speakers', compositionArchetype: 'asymmetric_editorial',
    typeScale: { base: 20, ratio: 1.25 }, grid: { margin: 0.08, columns: 6, gutter: 0.02, baseline: 0.006 },
    background: { color: BACKGROUND }, logo: { x: 0.08, y: 0.06, width: 0.11, height: 0.09 }, art: null, shapes: [],
    text: [{ copyIndex: 0, role: 'title', x: 0.08, y: 0.22, width: 0.84, height: 0.1, fontSize: 44, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true, italic: false, rtl: false }],
    photos: [{ photoIndex: 0, role: 'portrait', x: 0.08, y: 0.4, width: 0.4, height: 0.32, radiusFraction: 0, ...(treatment ? { treatment } : {}) }],
  });

  it('carries cutout through, leaves an absent treatment absent, and drops one the schema does not know', () => {
    expect(scaleNormalizedLayoutToV2(norm('cutout'), 1080, 1350).photos![0].treatment).toBe('cutout');
    expect('treatment' in scaleNormalizedLayoutToV2(norm(), 1080, 1350).photos![0]).toBe(false);
    const unknown = scaleNormalizedLayoutToV2(norm('sticker' as unknown as PhotoTreatment), 1080, 1350);
    expect('treatment' in unknown.photos![0]).toBe(false);
    expect(studioLayoutV2Schema.safeParse(unknown).success).toBe(true);
  });
});
