import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { unzipSync, strFromU8 } from 'fflate';
import type { PhotoElement, StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { photoElementSchema, studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { coverCrop, photoZoomFactor } from '../src/studio/photo-crop.js';
import type { PhotoCutoutAsset } from '../src/studio/photo-cutout.js';
import { photoLayers } from '../src/studio/photo-cutout.js';
import {
  cutoutEffectRect,
  outlineMorphologySteps,
  photoBakePixelSize,
  photoFilterMatrix,
  photoTreatmentFields,
  type PhotoFragment,
} from '../src/studio/photo-treatments.js';
import { renderLayoutV2Async, renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { scaleNormalizedLayoutToV2, type NormalizedLayoutCandidate } from '../src/studio/layout-generator-v3.js';

/**
 * Designer photo treatments: zoom, circle and arch masks, fades, black-and-white, duotone and tint
 * filters, and outlines and glows around cut-out people. Each is deterministic and works on the
 * photograph's own pixels (ADR-032). The preview draws them from one SVG fragment per photo and the
 * Canva deck bakes the same fragment into a PNG, so the two show the same pixels; a photo with none
 * of them is drawn exactly as before in both.
 */

type Rgba = [number, number, number, number];

function rgbaPng(width: number, height: number, paint: (x: number, y: number) => Rgba): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) png.data.set(paint(x, y), (width * y + x) * 4);
  }
  return PNG.sync.write(png);
}

const uriOf = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const at = (png: PNG, x: number, y: number): Rgba => {
  const i = (png.width * Math.round(y) + Math.round(x)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
};
const near = (got: Rgba, want: readonly number[], tolerance = 3) =>
  want.slice(0, 3).every((v, k) => Math.abs(got[k] - v) <= tolerance);

const RED: Rgba = [200, 30, 30, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
const BACKGROUND = '#0A1628';
const BG: Rgba = [0x0a, 0x16, 0x28, 255];
const NAVY = '#0A2A6B';
const GOLD = '#F5B700';
const GOLD_RGB = [0xf5, 0xb7, 0x00];

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
const copy = [copyText[0], copyText[1]];
const withPhotos = (...photos: PhotoElement[]): StudioLayoutV2 => ({ ...base(), photos });
const context = (photoCount: number) => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 2, copyScripts: ['latin', 'latin'] as Array<'latin' | 'arabic'>,
  photoCount,
  reference: { rules: { fontFamily: 'Verdana', palette: [BACKGROUND, '#FFFFFF'] }, logoAspect: 1.0 },
});

/** A 400x400 box: every framed test photo is drawn here. */
const square = { x: 86, y: 440, width: 400, height: 400 };
const framed = (extra: Partial<PhotoElement> = {}): PhotoElement => ({ photoIndex: 0, role: 'portrait', ...square, ...extra });

/** A plain red photo, 200px square: at 0.5 source px per layout px, baked at 1x. */
const redPhoto = () => rgbaPng(200, 200, () => RED);
/** Black on the left, white on the right. */
const blackWhite = () => rgbaPng(200, 200, (x) => (x < 100 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

/**
 * A 100x150 "person": transparent, with an opaque red body in the middle columns from row 20 to the
 * bottom. In a 400x600 box the placement scale is 4, so the body is x 240..440 and y 520..1040.
 */
const person = (): PhotoCutoutAsset => ({
  png: rgbaPng(100, 150, (x, y) => (x >= 25 && x < 75 && y >= 20 ? RED : CLEAR)),
  width: 100,
  height: 150,
});
const standing = { x: 140, y: 440, width: 400, height: 600 };
const cutout = (extra: Partial<PhotoElement> = {}): PhotoElement => ({ photoIndex: 0, role: 'portrait', ...standing, treatment: 'cutout', ...extra });
const BODY = { left: 240, right: 440, top: 520, bottom: 1040 };

async function preview(layout: StudioLayoutV2, photos: Buffer[], cutouts?: Array<PhotoCutoutAsset | undefined>) {
  const result = await renderLayoutV2Async(layout, { copyText, photoDataUris: photos.map(uriOf), ...(cutouts ? { photoCutouts: cutouts } : {}) });
  return { png: PNG.sync.read(result.png), noText: PNG.sync.read(result.noTextPng), svg: result.svg };
}

interface DeckPicture {
  name: string;
  media: Uint8Array;
  x: number;
  y: number;
  cx: number;
  cy: number;
  srcRect: boolean;
}

async function deckOf(layout: StudioLayoutV2, photos: Buffer[], cutouts?: Array<PhotoCutoutAsset | undefined>) {
  const deck = await encodeStudioTransferV2(layout, copy, undefined, {
    photos: photos.map((bytes) => ({ bytes, mimeType: 'image/png' as const })),
    ...(cutouts ? { photoCutouts: cutouts } : {}),
  });
  const files = unzipSync(new Uint8Array(deck.bytes));
  const slide = strFromU8(files['ppt/slides/slide1.xml']);
  const rels = strFromU8(files['ppt/slides/_rels/slide1.xml.rels']);
  const target = new Map([...rels.matchAll(/Id="(rId\d+)"[^>]*Target="\.\.\/media\/([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const pictures: DeckPicture[] = [...slide.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map(([pic]) => ({
    name: pic.match(/<p:cNvPr id="\d+" name="([^"]*)"/)![1],
    media: files[`ppt/media/${target.get(pic.match(/r:embed="(rId\d+)"/)![1])}`],
    x: Number(pic.match(/<a:off x="(-?\d+)"/)![1]),
    y: Number(pic.match(/<a:off x="-?\d+" y="(-?\d+)"/)![1]),
    cx: Number(pic.match(/<a:ext cx="(\d+)"/)![1]),
    cy: Number(pic.match(/<a:ext cx="\d+" cy="(\d+)"/)![1]),
    srcRect: /<a:srcRect/.test(pic),
  }));
  const media = Object.keys(files).filter((k) => k.startsWith('ppt/media/') && files[k].length).sort().map((k) => files[k]);
  return { slide, pictures, media };
}

const EMU_PER_PX = 9525;

describe('the treatment fields in the layout schema', () => {
  const photo = framed();
  const accepts = (extra: Record<string, unknown>) => photoElementSchema.safeParse({ ...photo, ...extra }).success;

  it('accepts each treatment within its range, and none at all', () => {
    expect(accepts({})).toBe(true);
    expect(accepts({ zoom: 1 })).toBe(true);
    expect(accepts({ zoom: 3 })).toBe(true);
    expect(accepts({ mask: 'circle' })).toBe(true);
    expect(accepts({ mask: 'arch' })).toBe(true);
    expect(accepts({ fade: { edge: 'bottom', length: 0.05 } })).toBe(true);
    expect(accepts({ fade: { edge: 'left', length: 1 } })).toBe(true);
    expect(accepts({ filter: { kind: 'bw' } })).toBe(true);
    expect(accepts({ filter: { kind: 'duotone', dark: NAVY, light: GOLD } })).toBe(true);
    expect(accepts({ filter: { kind: 'tint', color: '#FFF', strength: 0 } })).toBe(true);
    expect(accepts({ treatment: 'cutout', outline: { color: GOLD, width: 1 }, glow: { color: '#FFFFFF', radius: 60 } })).toBe(true);
  });

  it('refuses a value out of range, an unknown kind, a bad colour or an extra key', () => {
    expect(accepts({ zoom: 0.5 })).toBe(false);
    expect(accepts({ zoom: 3.01 })).toBe(false);
    expect(accepts({ mask: 'square' })).toBe(false);
    expect(accepts({ fade: { edge: 'bottom', length: 0.04 } })).toBe(false);
    expect(accepts({ fade: { edge: 'middle', length: 0.3 } })).toBe(false);
    expect(accepts({ fade: { edge: 'top', length: 0.3, curve: 'ease' } })).toBe(false);
    expect(accepts({ filter: { kind: 'sepia' } })).toBe(false);
    expect(accepts({ filter: { kind: 'bw', strength: 1 } })).toBe(false);
    expect(accepts({ filter: { kind: 'duotone', dark: 'navy', light: GOLD } })).toBe(false);
    expect(accepts({ filter: { kind: 'tint', color: NAVY, strength: 1.2 } })).toBe(false);
    expect(accepts({ filter: { kind: 'tint', color: NAVY } })).toBe(false);
    expect(accepts({ outline: { color: GOLD, width: 25 } })).toBe(false);
    expect(accepts({ outline: { color: GOLD, width: 0.5 } })).toBe(false);
    expect(accepts({ glow: { color: GOLD, radius: 1 } })).toBe(false);
    expect(accepts({ glow: { color: GOLD, radius: 20, spread: 2 } })).toBe(false);
  });

  it('validation refuses a mask on a cut-out and an outline or glow on a framed photo, as a PHOTOS defect', () => {
    const verdict = (p: PhotoElement) => validateLayoutV2(withPhotos(p), context(1));
    expect(verdict(framed({ mask: 'circle', fade: { edge: 'bottom', length: 0.3 }, filter: { kind: 'bw' }, zoom: 1.5 })).ok).toBe(true);
    expect(verdict(cutout({ outline: { color: '#FFFFFF', width: 6 }, glow: { color: '#FFFFFF', radius: 20 }, fade: { edge: 'bottom', length: 0.3 } })).ok).toBe(true);

    const masked = verdict(cutout({ mask: 'arch' }));
    expect(masked).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(('message' in masked ? masked.message : '')).toContain('cut-out and cannot take the arch mask');
    const outlined = verdict(framed({ outline: { color: '#FFFFFF', width: 6 } }));
    expect(outlined).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(('message' in outlined ? outlined.message : '')).toContain('framed and cannot take an outline');
    const glowing = verdict(framed({ glow: { color: '#FFFFFF', radius: 20 } }));
    expect(('message' in glowing ? glowing.message : '')).toContain('framed and cannot take a glow');
  });

  it('normalisation holds each field to its range and drops a malformed one, never the whole photo', () => {
    expect(photoTreatmentFields({
      zoom: 7, mask: 'circle',
      fade: { edge: 'top', length: 0.001 },
      filter: { kind: 'tint', color: NAVY, strength: 1.5, extra: true },
      outline: { color: GOLD, width: 40 },
      glow: { color: GOLD, radius: 0 },
    })).toEqual({
      zoom: 3, mask: 'circle',
      fade: { edge: 'top', length: 0.05 },
      filter: { kind: 'tint', color: NAVY, strength: 1 },
      outline: { color: GOLD, width: 24 },
      glow: { color: GOLD, radius: 2 },
    });
    expect(photoTreatmentFields({
      zoom: Number.NaN, mask: 'hexagon',
      fade: { edge: 'middle', length: 0.3 },
      filter: { kind: 'duotone', dark: NAVY },
      outline: { color: 'gold', width: 4 },
      glow: { radius: 10 },
    })).toEqual({});
    expect(photoTreatmentFields(undefined)).toEqual({});
  });

  it('the v3 generator\'s normalisation carries the treatments, and the result passes the schema', () => {
    const norm: NormalizedLayoutCandidate = {
      id: 'c1', conceptTitle: 'Two speakers', compositionArchetype: 'asymmetric_editorial',
      typeScale: { base: 20, ratio: 1.25 }, grid: { margin: 0.08, columns: 6, gutter: 0.02, baseline: 0.006 },
      background: { color: BACKGROUND }, logo: { x: 0.08, y: 0.06, width: 0.11, height: 0.09 }, art: null, shapes: [],
      text: [{ copyIndex: 0, role: 'title', x: 0.08, y: 0.22, width: 0.84, height: 0.1, fontSize: 44, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true, italic: false, rtl: false }],
      photos: [
        { photoIndex: 0, role: 'portrait', x: 0.08, y: 0.4, width: 0.28, height: 0.32, radiusFraction: 0, zoom: 1.8, mask: 'circle', filter: { kind: 'duotone', dark: NAVY, light: GOLD } },
        { photoIndex: 1, role: 'portrait', x: 0.38, y: 0.4, width: 0.28, height: 0.32, radiusFraction: 0, treatment: 'cutout', outline: { color: GOLD, width: 30 }, fade: { edge: 'bottom', length: 0.3 } },
      ],
    };
    const v2 = scaleNormalizedLayoutToV2(norm, 1080, 1350);
    expect(v2.photos![0]).toMatchObject({ zoom: 1.8, mask: 'circle', filter: { kind: 'duotone', dark: NAVY, light: GOLD } });
    expect(v2.photos![1]).toMatchObject({ treatment: 'cutout', outline: { color: GOLD, width: 24 }, fade: { edge: 'bottom', length: 0.3 } });
    expect('glow' in v2.photos![1]).toBe(false);
    expect(studioLayoutV2Schema.safeParse(v2).success).toBe(true);
  });
});

describe('coverCrop with a zoom', () => {
  const box = { width: 300, height: 300 };
  const image = { width: 400, height: 800 };

  it('is exactly the cover crop at zoom 1 or with no zoom', () => {
    for (const focus of [undefined, { x: 0.5, y: 0.2 }, { x: 0.9, y: 0.95 }]) {
      expect(coverCrop(box, image, focus, 1)).toEqual(coverCrop(box, image, focus));
      expect(coverCrop(box, image, focus, undefined)).toEqual(coverCrop(box, image, focus));
    }
    expect(coverCrop(box, image, undefined, 1)).toEqual({ sx: 0, sy: 200, sw: 400, sh: 400 });
  });

  it('at zoom 2 keeps half of each side, with the focus inside and as central as the edges allow', () => {
    const cover = coverCrop(box, image, { x: 0.5, y: 0.3 });
    const zoomed = coverCrop(box, image, { x: 0.5, y: 0.3 }, 2);
    expect(zoomed.sw).toBe(cover.sw / 2);
    expect(zoomed.sh).toBe(cover.sh / 2);
    // The focus at (200, 240) is the zoomed crop's centre: nothing holds it off.
    expect(zoomed).toEqual({ sx: 100, sy: 140, sw: 200, sh: 200 });
    // With no focus it is the centre of the image.
    expect(coverCrop(box, image, undefined, 2)).toEqual({ sx: 100, sy: 300, sw: 200, sh: 200 });
    // The box's aspect is kept for a wide box too.
    const wide = coverCrop({ width: 600, height: 300 }, { width: 1600, height: 900 }, { x: 0.3, y: 0.4 }, 2.5);
    expect(wide.sw / wide.sh).toBeCloseTo(2, 9);
    expect(0.3 * 1600).toBeGreaterThanOrEqual(wide.sx);
    expect(0.3 * 1600).toBeLessThanOrEqual(wide.sx + wide.sw);
    expect(0.4 * 900).toBeGreaterThanOrEqual(wide.sy);
    expect(0.4 * 900).toBeLessThanOrEqual(wide.sy + wide.sh);
  });

  it('is clamped to the image edges, and a zoom out of range is held to 1..3', () => {
    expect(coverCrop(box, image, { x: 0, y: 0 }, 2)).toEqual({ sx: 0, sy: 0, sw: 200, sh: 200 });
    expect(coverCrop(box, image, { x: 1, y: 1 }, 2)).toEqual({ sx: 200, sy: 600, sw: 200, sh: 200 });
    expect(coverCrop(box, image, { x: 0.02, y: 0.5 }, 3)).toMatchObject({ sx: 0 });
    expect(coverCrop(box, image, undefined, 0.5)).toEqual(coverCrop(box, image));
    expect(coverCrop(box, image, undefined, Number.NaN)).toEqual(coverCrop(box, image));
    expect(coverCrop(box, image, undefined, 9)).toEqual(coverCrop(box, image, undefined, 3));
    expect(photoZoomFactor(undefined)).toBe(1);
    expect(photoZoomFactor(2.25)).toBe(2.25);
  });

  it('crops a framed photo tighter in the preview, and natively in the deck, with nothing baked', async () => {
    // Red top half, blue bottom half; zoom 2 on the middle shows the boundary at the box's centre.
    const halves = rgbaPng(200, 200, (_x, y) => (y < 100 ? RED : [30, 30, 200, 255]));
    const layout = withPhotos(framed({ zoom: 2 }));
    const svg = renderLayoutV2ToSvg(layout, { copyText, photoDataUris: [uriOf(halves)] }).svg;
    expect(svg).toContain('<svg id="photo-0" x="86" y="440" width="400" height="400" viewBox="50 50 100 100" preserveAspectRatio="none">');
    const { png } = await preview(layout, [halves]);
    expect(near(at(png, 286, 460), RED)).toBe(true);
    expect(near(at(png, 286, 820), [30, 30, 200])).toBe(true);

    const deck = await deckOf(layout, [halves]);
    expect(deck.pictures).toHaveLength(1);
    expect(deck.pictures[0].srcRect).toBe(true);
    expect(deck.slide).toContain('<a:srcRect l="25000" r="25000" t="25000" b="25000"/>');
    expect(deck.media[0]).toEqual(new Uint8Array(halves));
  });
});

describe('the preview draws each treatment', () => {
  it('circle: the corners are the background, the middle the photo', async () => {
    const { png, svg } = await preview(withPhotos(framed({ mask: 'circle' })), [redPhoto()]);
    expect(svg).toContain('<clipPath id="photo-clip-0"><ellipse cx="286" cy="640" rx="200" ry="200"/></clipPath>');
    for (const [x, y] of [[90, 444], [482, 444], [90, 836], [482, 836]]) expect(at(png, x, y)).toEqual(BG);
    expect(near(at(png, 286, 640), RED)).toBe(true);
    // Just inside the circle's edge on the axes.
    expect(near(at(png, 90, 640), RED)).toBe(true);
    expect(near(at(png, 286, 444), RED)).toBe(true);
  });

  it('arch: the top corners are the background, the bottom corners and the crown the photo', async () => {
    const { png } = await preview(withPhotos(framed({ mask: 'arch' })), [redPhoto()]);
    expect(at(png, 92, 446)).toEqual(BG);
    expect(at(png, 480, 446)).toEqual(BG);
    expect(near(at(png, 90, 836), RED)).toBe(true);
    expect(near(at(png, 482, 836), RED)).toBe(true);
    expect(near(at(png, 286, 444), RED)).toBe(true);
    // Below the semicircle (radius 200) the sides are straight: full width at y = 440 + 200 + 10.
    expect(near(at(png, 88, 650), RED)).toBe(true);
  });

  it('fade: the edge row is the background, the far rows the photo, and the ramp is linear between', async () => {
    const { png } = await preview(withPhotos(framed({ fade: { edge: 'bottom', length: 0.5 } })), [redPhoto()]);
    expect(near(at(png, 286, 839), BG, 4)).toBe(true);
    expect(near(at(png, 286, 450), RED)).toBe(true);
    expect(near(at(png, 286, 630), RED)).toBe(true);
    // Halfway down the 200px ramp the photo is half over the background.
    const mid = at(png, 286, 740);
    expect(Math.abs(mid[0] - (200 + 10) / 2)).toBeLessThanOrEqual(4);

    const left = await preview(withPhotos(framed({ fade: { edge: 'left', length: 0.25 } })), [redPhoto()]);
    expect(near(at(left.png, 86, 640), BG, 4)).toBe(true);
    expect(near(at(left.png, 300, 640), RED)).toBe(true);
  });

  it('bw: every pixel is grey, at the Rec. 709 luminance of the colour', async () => {
    const { png } = await preview(withPhotos(framed({ filter: { kind: 'bw' } })), [redPhoto()]);
    const grey = Math.round(0.2126 * 200 + 0.7152 * 30 + 0.0722 * 30);
    for (const [x, y] of [[100, 460], [286, 640], [470, 820]]) {
      const [r, g, b] = at(png, x, y);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(Math.abs(r - grey)).toBeLessThanOrEqual(1);
    }
  });

  it('duotone: black becomes the dark colour and white the light one', async () => {
    const { png } = await preview(withPhotos(framed({ filter: { kind: 'duotone', dark: NAVY, light: GOLD } })), [blackWhite()]);
    expect(near(at(png, 150, 640), [0x0a, 0x2a, 0x6b], 1)).toBe(true);
    expect(near(at(png, 420, 640), GOLD_RGB, 1)).toBe(true);
  });

  it('tint: each pixel is mixed toward the colour by the strength', async () => {
    const { png } = await preview(withPhotos(framed({ filter: { kind: 'tint', color: NAVY, strength: 0.5 } })), [redPhoto()]);
    expect(near(at(png, 286, 640), [(200 + 0x0a) / 2, (30 + 0x2a) / 2, (30 + 0x6b) / 2], 1)).toBe(true);
    expect(photoFilterMatrix({ kind: 'tint', color: NAVY, strength: 0 }).slice(0, 5)).toEqual([1, 0, 0, 0, 0]);
  });

  it('outline: a ring of the colour just outside the silhouette, the person untouched, nothing under their feet', async () => {
    const asset = person();
    const plain = await preview(withPhotos(cutout()), [redPhoto()], [asset]);
    const { png, svg } = await preview(withPhotos(cutout({ outline: { color: GOLD, width: 8 } })), [redPhoto()], [asset]);
    // Four pixels outside the left and top edges of the body.
    expect(near(at(png, BODY.left - 4, 700), GOLD_RGB)).toBe(true);
    expect(near(at(png, 340, BODY.top - 4), GOLD_RGB)).toBe(true);
    // Past the outline's width, and below the person: the background.
    expect(at(png, BODY.left - 12, 700)).toEqual(BG);
    expect(at(png, 340, BODY.top - 12)).toEqual(BG);
    expect(at(png, BODY.left - 4, BODY.bottom + 3)).toEqual(BG);
    // The person's own pixels are the ones drawn without an outline.
    // Inside the edge the 4x upscaled matte blends over (about four pixels), where the outline meets it.
    for (const [x, y] of [[BODY.left + 6, 700], [340, BODY.top + 6], [340, 900], [BODY.right - 6, BODY.bottom - 6]]) {
      expect(at(png, x, y)).toEqual(at(plain.png, x, y));
    }
    // Layered under the person, with the person's picture carried once.
    expect(svg.indexOf('id="photo-outline-0"')).toBeLessThan(svg.indexOf('id="photo-0"'));
    expect(svg.split(asset.png.toString('base64')).length - 1).toBe(1);
  });

  it('glow: a soft halo that fades out beyond the radius, the person untouched', async () => {
    const plain = await preview(withPhotos(cutout()), [redPhoto()], [person()]);
    const { png } = await preview(withPhotos(cutout({ glow: { color: GOLD, radius: 20 } })), [redPhoto()], [person()]);
    const close = at(png, BODY.left - 3, 700);
    expect(close[0]).toBeGreaterThan(BG[0] + 40);
    expect(close[0]).toBeLessThan(GOLD_RGB[0] - 40);
    const farther = at(png, BODY.left - 15, 700);
    expect(farther[0]).toBeLessThan(close[0]);
    expect(at(png, BODY.left - 40, 700)).toEqual(BG);
    expect(at(png, 340, 800)).toEqual(at(plain.png, 340, 800));
  });

  it('a cut-out\'s fade takes the person and their outline out together, into the background', async () => {
    const { png } = await preview(withPhotos(cutout({ fade: { edge: 'bottom', length: 0.25 }, outline: { color: GOLD, width: 8 } })), [redPhoto()], [person()]);
    // The fade runs over the person's rect (440..1040), so its last quarter is 890..1040.
    expect(near(at(png, 340, BODY.bottom - 1), BG, 5)).toBe(true);
    expect(near(at(png, BODY.left - 4, BODY.bottom - 1), BG, 5)).toBe(true);
    expect(near(at(png, 340, 700), RED)).toBe(true);
    expect(near(at(png, BODY.left - 4, 700), GOLD_RGB)).toBe(true);
    // Halfway down the ramp the person is half over the background, not tinted by the outline.
    const mid = at(png, 340, 965);
    expect(Math.abs(mid[0] - (200 + BG[0]) / 2)).toBeLessThanOrEqual(5);
    expect(Math.abs(mid[1] - (30 + BG[1]) / 2)).toBeLessThanOrEqual(5);
  });

  it('keeps every id unique when two photos share a filter, and keeps the ids a photo had', () => {
    const layout = withPhotos(
      framed({ filter: { kind: 'bw' }, mask: 'circle' }),
      { photoIndex: 1, role: 'portrait', x: 594, y: 440, width: 400, height: 400, filter: { kind: 'bw' }, fade: { edge: 'bottom', length: 0.3 } },
    );
    const svg = renderLayoutV2ToSvg(layout, { copyText, photoDataUris: [uriOf(redPhoto()), uriOf(redPhoto())] }).svg;
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['photo-0', 'photo-1', 'photo-clip-0', 'photo-clip-1', 'photo-filter-0', 'photo-filter-1', 'photo-fade-1']) {
      expect(ids).toContain(id);
    }
    // A cut-out's effects have their own ids too.
    const cut = renderLayoutV2ToSvg(withPhotos(cutout({ outline: { color: GOLD, width: 4 }, glow: { color: GOLD, radius: 10 }, filter: { kind: 'bw' } })), {
      copyText, photoCutouts: [person()],
    }).svg;
    const cutIds = [...cut.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(cutIds).size).toBe(cutIds.length);
    for (const id of ['photo-0', 'photo-glow-0', 'photo-outline-0', 'photo-source-0', 'photo-filter-0']) expect(cutIds).toContain(id);
  });
});

describe('untreated photos are drawn exactly as before', () => {
  it('in the preview: a framed photo, a zoom of 1, and a cut-out keep their markup', () => {
    const uri = uriOf(redPhoto());
    const svg = renderLayoutV2ToSvg(withPhotos(framed({ radius: 24 })), { copyText, photoDataUris: [uri] }).svg;
    expect(svg).toContain(`<clipPath id="photo-clip-0"><rect x="86" y="440" width="400" height="400" rx="24" ry="24"/></clipPath>`);
    expect(svg).toContain(`<image id="photo-0" xlink:href="${uri}" x="86" y="440" width="400" height="400" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo-clip-0)"/>`);
    expect(renderLayoutV2ToSvg(withPhotos(framed({ radius: 24, zoom: 1 })), { copyText, photoDataUris: [uri] }).svg).toBe(svg);

    const asset = person();
    const cut = renderLayoutV2ToSvg(withPhotos(cutout()), { copyText, photoCutouts: [asset] }).svg;
    expect(cut).toContain(`<image id="photo-0" xlink:href="${uriOf(asset.png)}" x="140" y="440" width="400" height="600" preserveAspectRatio="none"/>`);
    expect(cut).not.toContain('<defs>');
  });

  it('in the preview: treating one photo leaves the other\'s markup and the rest of the design alone', () => {
    const uri = uriOf(redPhoto());
    const other: PhotoElement = { photoIndex: 1, role: 'portrait', x: 594, y: 440, width: 400, height: 400 };
    const plain = renderLayoutV2ToSvg(withPhotos(framed(), other), { copyText, photoDataUris: [uri, uri] }).svg;
    const treated = renderLayoutV2ToSvg(withPhotos(framed({ mask: 'arch', filter: { kind: 'bw' } }), other), { copyText, photoDataUris: [uri, uri] }).svg;
    const untouched = `<image id="photo-1" xlink:href="${uri}" x="594" y="440" width="400" height="400" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo-clip-1)"/>`;
    expect(plain).toContain(untouched);
    expect(treated).toContain(untouched);
    const before = plain.match(/<clipPath id="photo-clip-0">[\s\S]*?clip-path="url\(#photo-clip-0\)"\/>/)![0];
    const after = treated.match(/<g><defs><clipPath id="photo-clip-0">[\s\S]*?<\/svg><\/g><\/g><\/g>/)![0];
    expect(treated.replace(after, before)).toBe(plain);
  });

  it('in the deck: a framed photo and a cut-out keep their pictures, and a zoom of 1 changes nothing', async () => {
    const photo = redPhoto();
    const plain = await deckOf(withPhotos(framed()), [photo]);
    expect(plain.pictures).toHaveLength(1);
    expect(plain.pictures[0].media).toEqual(new Uint8Array(photo));
    // Rounded corners are baked since 2026-09-24 (pptxgenjs's rounding is an ellipse); see the review tests.
    expect(plain.slide).toContain('<a:srcRect l="0" r="0" t="0" b="0"/>');
    const zoomOne = await deckOf(withPhotos(framed({ zoom: 1 })), [photo]);
    expect(zoomOne.slide).toBe(plain.slide);
    expect(zoomOne.media).toEqual(plain.media);

    const asset = person();
    const cut = await deckOf(withPhotos(cutout()), [], [asset]);
    expect(cut.pictures.map((p) => p.name)).toEqual(['Photo 0']);
    expect(cut.pictures[0].media).toEqual(new Uint8Array(asset.png));
  });
});

describe('the Canva deck bakes a treated photo from the preview\'s own fragment', () => {
  it('as one PNG at the box, uncropped, with the mask as transparency', async () => {
    const photo = rgbaPng(800, 800, () => RED);
    const deck = await deckOf(withPhotos(framed({ mask: 'circle', filter: { kind: 'bw' } })), [photo]);
    expect(deck.pictures).toHaveLength(1);
    const [pic] = deck.pictures;
    expect(pic.name).toBe('Photo 0');
    expect(pic.srcRect).toBe(false);
    expect({ x: pic.x, y: pic.y, cx: pic.cx, cy: pic.cy }).toEqual({ x: 86 * EMU_PER_PX, y: 440 * EMU_PER_PX, cx: 400 * EMU_PER_PX, cy: 400 * EMU_PER_PX });
    const baked = PNG.sync.read(Buffer.from(pic.media));
    // 800px of photo for 400px of box: baked at twice the box.
    expect({ width: baked.width, height: baked.height }).toEqual({ width: 800, height: 800 });
    expect(at(baked, 4, 4)[3]).toBe(0);
    expect(at(baked, 795, 795)[3]).toBe(0);
    const middle = at(baked, 400, 400);
    expect(middle[3]).toBe(255);
    expect(middle[0]).toBe(middle[1]);
  });

  it('never finer than the photograph: a small photo is baked at the box\'s own pixels', async () => {
    const deck = await deckOf(withPhotos(framed({ fade: { edge: 'top', length: 0.3 } })), [redPhoto()]);
    const baked = PNG.sync.read(Buffer.from(deck.pictures[0].media));
    expect({ width: baked.width, height: baked.height }).toEqual({ width: 400, height: 400 });
    const fragment = (sourceScale?: number): PhotoFragment => ({ defs: '', svg: '', rect: { x: 0, y: 0, width: 400, height: 300 }, ...(sourceScale !== undefined ? { sourceScale } : {}) });
    expect(photoBakePixelSize(fragment(3))).toEqual({ width: 800, height: 600 });
    expect(photoBakePixelSize(fragment(1.9))).toEqual({ width: 400, height: 300 });
    expect(photoBakePixelSize(fragment(0.4))).toEqual({ width: 400, height: 300 });
    expect(photoBakePixelSize(fragment())).toEqual({ width: 800, height: 600 });
    // A full-page story hero at 2x would pass the pixel budget, so it is baked at 1x.
    expect(photoBakePixelSize({ defs: '', svg: '', rect: { x: 0, y: 0, width: 1080, height: 1920 }, sourceScale: 4 })).toEqual({ width: 1080, height: 1920 });
  });

  it('matches the preview\'s pixels in the box', async () => {
    // A photo at more than twice the box's resolution after the zoom, so the bake is at 2x, and
    // smooth, so the comparison measures the treatments rather than two resamplings of fine detail.
    const detailed = rgbaPng(1200, 1200, (x, y) => [Math.round((x * 255) / 1199), Math.round((y * 255) / 1199), Math.round(((x + y) * 255) / 2398), 255]);
    const layout = withPhotos(framed({ mask: 'arch', zoom: 1.4, focus: { x: 0.4, y: 0.3 }, fade: { edge: 'bottom', length: 0.4 }, filter: { kind: 'duotone', dark: NAVY, light: GOLD } }));
    const { noText } = await preview(layout, [detailed]);
    const deck = await deckOf(layout, [detailed]);
    const baked = PNG.sync.read(Buffer.from(deck.pictures[0].media));
    expect(baked.width).toBe(800);
    // On the arch's anti-aliased rim, one pixel's coverage and the average of four differ by a few
    // levels more; those points are left out. The arch's crown is a semicircle of radius 200.
    const onRim = (gx: number, gy: number) => gy < 200 && Math.abs(Math.hypot(gx + 0.5 - 200, gy + 0.5 - 200) - 200) < 1.5;
    let checked = 0;
    for (let gy = 5; gy < 400; gy += 37) {
      for (let gx = 5; gx < 400; gx += 37) {
        if (onRim(gx, gy)) continue;
        // The 2x2 baked pixels that make up one preview pixel, each over the background and averaged,
        // against the preview's pixel at the same place.
        const over = [0, 0, 0];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const [r, g, b, a] = at(baked, gx * 2 + dx, gy * 2 + dy);
          [r, g, b].forEach((c, k) => (over[k] += (c * a + BG[k] * (255 - a)) / 255 / 4));
        }
        const want = at(noText, square.x + gx, square.y + gy);
        expect(Math.max(...over.map((c, k) => Math.abs(c - want[k])))).toBeLessThanOrEqual(4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('adds an outline and a glow as pictures of their own under the untouched person', async () => {
    const asset = person();
    const layout = withPhotos(cutout({ outline: { color: GOLD, width: 8 }, glow: { color: '#FFFFFF', radius: 16 } }));
    const deck = await deckOf(layout, [], [asset]);
    expect(deck.pictures.map((p) => p.name)).toEqual(['Photo 0 glow', 'Photo 0 outline', 'Photo 0']);
    // The person is the cut-out's own PNG, exactly as without the effects.
    expect(deck.pictures[2].media).toEqual(new Uint8Array(asset.png));
    // The outline reaches its width (plus a pixel) to the sides and above, and not below the feet.
    const outline = deck.pictures[1];
    const rect = cutoutEffectRect('outline', layout.photos![0], standing, layout)!;
    expect(rect).toEqual({ x: 131, y: 431, width: 418, height: 609 });
    expect({ x: outline.x, y: outline.y, cx: outline.cx, cy: outline.cy }).toEqual({
      x: rect.x * EMU_PER_PX, y: rect.y * EMU_PER_PX, cx: rect.width * EMU_PER_PX, cy: rect.height * EMU_PER_PX,
    });
    const ring = PNG.sync.read(Buffer.from(outline.media));
    expect({ width: ring.width, height: ring.height }).toEqual({ width: 418, height: 609 });
    // Gold just outside the body, nothing inside it (the ring is not under the person).
    expect(at(ring, BODY.left - 4 - rect.x, 700 - rect.y)).toEqual([...GOLD_RGB, 255]);
    expect(at(ring, 340 - rect.x, 800 - rect.y)[3]).toBe(0);
  });

  it('bakes the person only when their own pixels change, and the layers match the preview', async () => {
    const asset = person();
    const layout = withPhotos(cutout({ outline: { color: GOLD, width: 8 }, filter: { kind: 'bw' } }));
    const { noText } = await preview(layout, [], [asset]);
    const deck = await deckOf(layout, [], [asset]);
    expect(deck.pictures.map((p) => p.name)).toEqual(['Photo 0 outline', 'Photo 0']);
    const [outline, personPic] = deck.pictures;
    expect(personPic.media).not.toEqual(new Uint8Array(asset.png));
    // The person's picture is on whole pixels around the placed person.
    expect(personPic.x).toBe(140 * EMU_PER_PX);
    expect(personPic.cx).toBe(400 * EMU_PER_PX);
    // Composite the two baked layers over the background, as Canva stacks them, and compare.
    const ring = PNG.sync.read(Buffer.from(outline.media));
    const body = PNG.sync.read(Buffer.from(personPic.media));
    const composite = (x: number, y: number) => {
      let px = [...BG.slice(0, 3)];
      for (const [layer, pic] of [[ring, outline], [body, personPic]] as const) {
        const lx = x - pic.x / EMU_PER_PX;
        const ly = y - pic.y / EMU_PER_PX;
        if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;
        const [r, g, b, a] = at(layer, lx, ly);
        px = [r, g, b].map((c, k) => (c * a + px[k] * (255 - a)) / 255);
      }
      return px;
    };
    for (const [x, y] of [[BODY.left - 4, 700], [340, BODY.top - 4], [300, 800], [BODY.left - 20, 700], [BODY.right + 3, 1000]]) {
      const want = at(noText, x, y);
      const got = composite(x, y);
      expect(Math.max(...got.map((c, k) => Math.abs(c - want[k])))).toBeLessThanOrEqual(3);
    }
  });
});

describe('librsvg\'s morphology limits, and how the outline works within them', () => {
  it('splits a wide outline into whole-pixel steps of at most 5px, which at 2x is librsvg\'s 10px cap', () => {
    expect(outlineMorphologySteps(1)).toEqual([1]);
    expect(outlineMorphologySteps(5)).toEqual([5]);
    expect(outlineMorphologySteps(6)).toEqual([3, 3]);
    expect(outlineMorphologySteps(12)).toEqual([4, 4, 4]);
    expect(outlineMorphologySteps(24)).toEqual([5, 5, 5, 5, 4]);
    for (let w = 1; w <= 24; w++) {
      const steps = outlineMorphologySteps(w);
      expect(steps.reduce((a, b) => a + b, 0)).toBe(w);
      expect(Math.max(...steps)).toBeLessThanOrEqual(5);
      expect(steps.every(Number.isInteger)).toBe(true);
    }
  });

  it('draws a 20px outline 20px wide, in the preview and in a deck baked at 2x', async () => {
    // A cut-out with four times the box's pixels, so its layers are baked at 2x.
    const big: PhotoCutoutAsset = {
      png: rgbaPng(800, 1200, (x, y) => (x >= 200 && x < 600 && y >= 160 ? RED : CLEAR)),
      width: 800,
      height: 1200,
    };
    const layout = withPhotos(cutout({ outline: { color: GOLD, width: 20 } }));
    const { png } = await preview(layout, [], [big]);
    // The body's left edge is x 240 in the layout: gold from 220 to 239, background at 218.
    expect(near(at(png, 221, 700), GOLD_RGB)).toBe(true);
    expect(at(png, 218, 700)).toEqual(BG);
    const deck = await deckOf(layout, [], [big]);
    const outline = deck.pictures.find((p) => p.name === 'Photo 0 outline')!;
    const ring = PNG.sync.read(Buffer.from(outline.media));
    const left = outline.x / EMU_PER_PX;
    expect(ring.width).toBe(Math.round((outline.cx / EMU_PER_PX) * 2));
    expect(at(ring, (221 - left) * 2, (700 - outline.y / EMU_PER_PX) * 2)).toEqual([...GOLD_RGB, 255]);
    expect(at(ring, (218 - left) * 2, (700 - outline.y / EMU_PER_PX) * 2)[3]).toBe(0);
  });

  it('draws the layers in the order the preview and the deck share: shadows, then glow, outline, person', () => {
    const asset = { ...person(), shadowPng: rgbaPng(10, 10, () => [0, 0, 0, 90]), shadowWidth: 10, shadowHeight: 10, shadowX: 0, shadowY: 140 };
    const layers = photoLayers([cutout({ glow: { color: GOLD, radius: 10 }, outline: { color: GOLD, width: 2 } })], [asset]);
    expect(layers.map((l) => l.kind)).toEqual(['cutout-shadow', 'cutout-glow', 'cutout-outline', 'cutout-person']);
    // An outline on a photo drawn framed (no cut-out supplied) is not drawn.
    expect(photoLayers([cutout({ outline: { color: GOLD, width: 2 } })], []).map((l) => l.kind)).toEqual(['framed']);
  });
});

describe('after the 2026-09-24 review', () => {
  it('draws an outline as row and column passes, so a wide one bakes in time', () => {
    const svg = renderLayoutV2ToSvg(withPhotos(cutout({ outline: { color: '#FFFFFF', width: 24 } })), { copyText, photoDataUris: [uriOf(redPhoto())], photoCutouts: [person()] }).svg;
    expect(svg).toMatch(/radius="\d+ 0"/);
    expect(svg).toMatch(/radius="0 \d+"/);
    expect(svg).not.toMatch(/radius="\d+"(?! )/);
  });

  it('crops a photo 9,600 px or more on a side in the deck instead of drawing nothing', async () => {
    const wide = Buffer.from(rgbaPng(10, 10, () => RED));
    wide.writeUInt32BE(9800, 16);
    wide.writeUInt32BE(1400, 20);
    const layout = withPhotos({ photoIndex: 0, role: 'hero', x: 86, y: 440, width: 800, height: 400 });
    const deck = await encodeStudioTransferV2(layout, copy, undefined, { photos: [{ bytes: wide, mimeType: 'image/png' as const }] });
    const slide = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    const rect = slide.match(/<a:srcRect([^/]*)\/>/)?.[1] ?? '';
    // 9800x1400 into 800x400: the height is kept whole and the sides are cropped.
    expect(rect).toContain('t="0" b="0"');
    expect(Number(rect.match(/\bl="(\d+)"/)?.[1])).toBeGreaterThan(30000);
  });

  it('sends rounded corners to the deck as they are drawn; a true circle stays native', async () => {
    const rounded = await deckOf(withPhotos(framed({ width: 400, height: 250, radius: 24 })), [redPhoto()]);
    expect(rounded.pictures).toHaveLength(1);
    expect(rounded.slide).not.toContain('prst="ellipse"');
    const circle = await deckOf(withPhotos(framed({ radius: 200 })), [redPhoto()]);
    expect(circle.slide).toContain('prst="ellipse"');
  });

  it('casts no contact shadow under a person fading into the background', () => {
    const shadowed: PhotoCutoutAsset = { ...person(), shadowPng: rgbaPng(10, 10, () => [0, 0, 0, 90]), shadowWidth: 110, shadowHeight: 160, shadowX: -5, shadowY: -5 };
    expect(photoLayers([cutout()], [shadowed]).map((l) => l.kind)).toContain('cutout-shadow');
    expect(photoLayers([cutout({ fade: { edge: 'bottom', length: 0.4 } })], [shadowed]).map((l) => l.kind)).not.toContain('cutout-shadow');
  });
});
