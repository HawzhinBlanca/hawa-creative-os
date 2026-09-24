import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { unzipSync, strFromU8 } from 'fflate';
import type { PhotoElement, StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { photoElementSchema, studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { coverCrop, dataUriPixelSize, photoFocusOrUndefined, type CoverCropRect } from '../src/studio/photo-crop.js';
import { renderLayoutV2Async, renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2, imagePixelSize } from '../src/studio/transfer-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { prepareGeneratedLayoutV3, settlePhotos } from '../src/studio/pipeline-v3.js';
import { scaleNormalizedLayoutToV2, type NormalizedLayoutCandidate } from '../src/studio/layout-generator-v3.js';
import type { PhotoCutoutAsset } from '../src/studio/photo-cutout.js';

import { inlineSvgFiles } from '../src/studio/svg-files.js';
/**
 * The render's markup with its picture files put back inline: pictures are files beside the SVG
 * (ADR-035), and these assertions read the markup as the one document it used to be.
 */
const inlinedSvgOf = (...args: Parameters<typeof renderLayoutV2ToSvg>) => {
  const r = renderLayoutV2ToSvg(...args);
  return { ...r, svg: inlineSvgFiles(r.svg, r.files), noTextSvg: inlineSvgFiles(r.noTextSvg, r.files) };
};

/**
 * Face-aware cropping of framed photos. A centred crop of a tall portrait into a square or wide box
 * cuts off the head; a focus point (from face detection) moves the crop to keep that part of the
 * photo in view. The preview and the Canva deck crop by the same rule, and a photo without a focus
 * point is drawn exactly as before.
 */

type Rgba = [number, number, number, number];

function rgbaPng(width: number, height: number, paint: (x: number, y: number) => Rgba): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) png.data.set(paint(x, y), (width * y + x) * 4);
  }
  return PNG.sync.write(png);
}

const RED: Rgba = [200, 30, 30, 255];
const BLUE: Rgba = [30, 30, 200, 255];
const BACKGROUND = '#0A1628';

/** A 40x80 portrait: the top 16 rows (the "head", 20% of the height) red, the rest blue. */
const portrait = () => rgbaPng(40, 80, (_x, y) => (y < 16 ? RED : BLUE));
const portraitUri = () => `data:image/png;base64,${portrait().toString('base64')}`;

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
const withPhotos = (...photos: PhotoElement[]): StudioLayoutV2 => ({ ...base(), photos });
/** A square box: the portrait loses half its height to the crop. */
const square = { x: 86, y: 420, width: 440, height: 440 };
const headFocus = { x: 0.5, y: 0.1 };

describe('coverCrop', () => {
  it('with no focus is the centred crop xMidYMid slice draws', () => {
    expect(coverCrop({ width: 300, height: 300 }, { width: 400, height: 800 })).toEqual({ sx: 0, sy: 200, sw: 400, sh: 400 });
    expect(coverCrop({ width: 600, height: 300 }, { width: 400, height: 800 })).toEqual({ sx: 0, sy: 300, sw: 400, sh: 200 });
    expect(coverCrop({ width: 300, height: 600 }, { width: 1600, height: 900 })).toEqual({ sx: 575, sy: 0, sw: 450, sh: 900 });
    // The centre as an explicit focus is the same crop.
    expect(coverCrop({ width: 300, height: 300 }, { width: 400, height: 800 }, { x: 0.5, y: 0.5 })).toEqual({ sx: 0, sy: 200, sw: 400, sh: 400 });
  });

  it('keeps the top of a portrait in a square box when the face is near the top', () => {
    const top = coverCrop({ width: 300, height: 300 }, { width: 400, height: 800 }, { x: 0.5, y: 0.2 });
    // The face at 160px would sit at the crop's centre from 160 - 200 < 0, so the crop starts at the top.
    expect(top).toEqual({ sx: 0, sy: 0, sw: 400, sh: 400 });
    // Lower down it is centred on the face.
    expect(coverCrop({ width: 300, height: 300 }, { width: 400, height: 800 }, { x: 0.5, y: 0.3 })).toEqual({ sx: 0, sy: 40, sw: 400, sh: 400 });
  });

  it('is clamped inside the image at every edge', () => {
    const box = { width: 300, height: 300 };
    const image = { width: 400, height: 800 };
    expect(coverCrop(box, image, { x: 0, y: 0 })).toEqual({ sx: 0, sy: 0, sw: 400, sh: 400 });
    expect(coverCrop(box, image, { x: 1, y: 1 })).toEqual({ sx: 0, sy: 400, sw: 400, sh: 400 });
    // A focus outside 0..1 is held to the image, and one that is not a number is the centre.
    expect(coverCrop(box, image, { x: -3, y: 7 })).toEqual({ sx: 0, sy: 400, sw: 400, sh: 400 });
    expect(coverCrop(box, image, { x: Number.NaN, y: Number.NaN })).toEqual({ sx: 0, sy: 200, sw: 400, sh: 400 });
  });

  it('follows the focus across a wide image in a tall box', () => {
    const box = { width: 300, height: 600 };
    const image = { width: 1600, height: 900 };
    expect(coverCrop(box, image, { x: 0.8, y: 0.5 })).toEqual({ sx: 1280 - 225, sy: 0, sw: 450, sh: 900 });
    expect(coverCrop(box, image, { x: 0.1, y: 0.5 })).toEqual({ sx: 0, sy: 0, sw: 450, sh: 900 });
    expect(coverCrop(box, image, { x: 0.99, y: 0.5 })).toEqual({ sx: 1150, sy: 0, sw: 450, sh: 900 });
  });

  it('always has the box\'s aspect, and keeps a same-aspect image whole whatever the focus', () => {
    const cases: Array<[{ width: number; height: number }, { width: number; height: number }]> = [
      [{ width: 440, height: 600 }, { width: 3024, height: 4032 }],
      [{ width: 1080, height: 400 }, { width: 3024, height: 4032 }],
      [{ width: 333, height: 777 }, { width: 4032, height: 3024 }],
    ];
    for (const [box, image] of cases) {
      for (const focus of [undefined, { x: 0.2, y: 0.8 }, { x: 0.9, y: 0.05 }]) {
        const c = coverCrop(box, image, focus);
        expect(c.sw / c.sh).toBeCloseTo(box.width / box.height, 9);
        expect(c.sx).toBeGreaterThanOrEqual(0);
        expect(c.sy).toBeGreaterThanOrEqual(0);
        expect(c.sx + c.sw).toBeLessThanOrEqual(image.width + 1e-9);
        expect(c.sy + c.sh).toBeLessThanOrEqual(image.height + 1e-9);
      }
    }
    expect(coverCrop({ width: 300, height: 400 }, { width: 3024, height: 4032 }, { x: 0.1, y: 0.9 })).toEqual({ sx: 0, sy: 0, sw: 3024, sh: 4032 });
  });

  it('refuses a box or an image with no size', () => {
    expect(() => coverCrop({ width: 0, height: 300 }, { width: 400, height: 800 })).toThrow(RangeError);
    expect(() => coverCrop({ width: 300, height: 300 }, { width: 400, height: Number.NaN })).toThrow(RangeError);
  });
});

describe('the focus field', () => {
  const photo = { photoIndex: 0, role: 'portrait' as const, ...square };

  it('is optional in the schema, a point inside the photo, and nothing else', () => {
    expect(photoElementSchema.safeParse(photo).success).toBe(true);
    expect(photoElementSchema.safeParse({ ...photo, focus: { x: 0, y: 1 } }).success).toBe(true);
    expect(photoElementSchema.safeParse({ ...photo, focus: { x: 0.5, y: 1.2 } }).success).toBe(false);
    expect(photoElementSchema.safeParse({ ...photo, focus: { x: 0.5 } }).success).toBe(false);
    expect(photoElementSchema.safeParse({ ...photo, focus: { x: 0.5, y: 0.5, weight: 1 } }).success).toBe(false);
  });

  it('is held to the photo, or dropped when it is not a point', () => {
    expect(photoFocusOrUndefined({ x: 0.3, y: 0.2 })).toEqual({ x: 0.3, y: 0.2 });
    expect(photoFocusOrUndefined({ x: 1.0000001, y: -0.01 })).toEqual({ x: 1, y: 0 });
    expect(photoFocusOrUndefined({ x: Number.NaN, y: 0.2 })).toBeUndefined();
    expect(photoFocusOrUndefined({ x: '0.3', y: 0.2 })).toBeUndefined();
    expect(photoFocusOrUndefined(null)).toBeUndefined();
  });

  it('reads the photo\'s pixel size from a base64 data URI', () => {
    expect(dataUriPixelSize(portraitUri())).toEqual({ width: 40, height: 80 });
    expect(dataUriPixelSize('data:image/webp;base64,UklGRgAAAABXRUJQ')).toBeNull();
    expect(dataUriPixelSize('data:image/png,%89PNG')).toBeNull();
    expect(dataUriPixelSize('not a uri')).toBeNull();
  });
});

describe('the preview crops a framed photo around its focus', () => {
  const focused = () => withPhotos({ photoIndex: 0, role: 'portrait', ...square, radius: 24, focus: headFocus });
  const unfocused = () => withPhotos({ photoIndex: 0, role: 'portrait', ...square, radius: 24 });

  it('as a nested viewport whose viewBox is the coverCrop rectangle, clipped to the rounded box', () => {
    const uri = portraitUri();
    const svg = inlinedSvgOf(focused(), { copyText, photoDataUris: [uri] }).svg;
    const crop = coverCrop(square, { width: 40, height: 80 }, headFocus);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 40, sh: 40 });
    const nested = svg.match(/<g clip-path="url\(#photo-clip-0\)"><svg id="photo-0" ([^>]*)><image ([^>]*)\/><\/svg><\/g>/);
    expect(nested).not.toBeNull();
    const attrs = nested![1];
    expect(attrs).toContain('x="86" y="420" width="440" height="440"');
    expect(attrs).toContain('preserveAspectRatio="none"');
    const viewBox = attrs.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
    expect(viewBox).toEqual([crop.sx, crop.sy, crop.sw, crop.sh]);
    // The whole picture at its natural size inside the viewport.
    expect(nested![2]).toBe(`xlink:href="${uri}" x="0" y="0" width="40" height="80" preserveAspectRatio="none"`);
    // The clip is the box with its corner radius, as for an unfocused photo.
    expect(svg).toContain('<clipPath id="photo-clip-0"><rect x="86" y="420" width="440" height="440" rx="24" ry="24"/></clipPath>');
    // Under the copy.
    expect(svg.indexOf('id="photo-0"')).toBeLessThan(svg.indexOf('Her path'));
  });

  it('writes a fractional crop to a thousandth of a pixel', () => {
    const uri = `data:image/png;base64,${rgbaPng(30, 70, () => BLUE).toString('base64')}`;
    const focus = { x: 0.5, y: 0.37 };
    const box = { x: 86, y: 420, width: 440, height: 333 };
    const svg = inlinedSvgOf(withPhotos({ photoIndex: 0, role: 'portrait', ...box, focus }), { copyText, photoDataUris: [uri] }).svg;
    const viewBox = svg.match(/<svg id="photo-0" [^>]*viewBox="([^"]+)"/)![1].split(' ').map(Number);
    const crop = coverCrop(box, { width: 30, height: 70 }, focus);
    [crop.sx, crop.sy, crop.sw, crop.sh].forEach((v, i) => expect(Math.abs(viewBox[i] - v)).toBeLessThanOrEqual(0.0005));
  });

  it('draws the head at the top of the box, where the centred crop draws only the body', async () => {
    const uri = portraitUri();
    const at = (png: PNG, x: number, y: number) => Array.from(png.data.subarray((png.width * y + x) * 4, (png.width * y + x) * 4 + 4));
    const withFocus = PNG.sync.read((await renderLayoutV2Async(focused(), { copyText, photoDataUris: [uri] })).png);
    const centred = PNG.sync.read((await renderLayoutV2Async(unfocused(), { copyText, photoDataUris: [uri] })).png);
    // 60px into the box: source row 5 of the kept 0..40 (red), against row 25 of the centred 20..60 (blue).
    const head = at(withFocus, 306, 480);
    expect(head[0]).toBeGreaterThan(150);
    expect(head[2]).toBeLessThan(80);
    const body = at(centred, 306, 480);
    expect(body[2]).toBeGreaterThan(150);
    expect(body[0]).toBeLessThan(80);
    // Both show the body near the bottom of the box.
    expect(at(withFocus, 306, 820)[2]).toBeGreaterThan(150);
    // The rounded corner still clips: the design's own background shows there.
    expect(at(withFocus, 87, 421)).toEqual([0x0a, 0x16, 0x28, 255]);
  });

  it('leaves a photo without a focus exactly as it was drawn before', () => {
    const uri = portraitUri();
    const svg = inlinedSvgOf(unfocused(), { copyText, photoDataUris: [uri] }).svg;
    expect(svg).toContain(`<image id="photo-0" xlink:href="${uri}" x="86" y="420" width="440" height="440" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo-clip-0)"/>`);
    // A focus changes the photo's own markup and nothing else in the design.
    const withFocus = inlinedSvgOf(focused(), { copyText, photoDataUris: [uri] }).svg;
    const focusedMarkup = withFocus.match(/<g clip-path="url\(#photo-clip-0\)"><svg id="photo-0"[\s\S]*?<\/svg><\/g>/)![0];
    const unfocusedMarkup = svg.match(/<image id="photo-0"[^>]*\/>/)![0];
    expect(withFocus.replace(focusedMarkup, unfocusedMarkup)).toBe(svg);
  });

  it('falls back to the centred crop when the photo\'s size cannot be read, and never touches a cut-out', () => {
    const webp = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
    const before = inlinedSvgOf(unfocused(), { copyText, photoDataUris: [webp] }).svg;
    expect(inlinedSvgOf(focused(), { copyText, photoDataUris: [webp] }).svg).toBe(before);

    const person: PhotoCutoutAsset = { png: rgbaPng(100, 150, () => RED), width: 100, height: 150 };
    const cut = (focus?: { x: number; y: number }) =>
      withPhotos({ photoIndex: 0, role: 'portrait', ...square, treatment: 'cutout', ...(focus ? { focus } : {}) });
    const plain = inlinedSvgOf(cut(), { copyText, photoDataUris: [portraitUri()], photoCutouts: [person] }).svg;
    expect(inlinedSvgOf(cut(headFocus), { copyText, photoDataUris: [portraitUri()], photoCutouts: [person] }).svg).toBe(plain);
  });
});

describe('the Canva deck crops a framed photo to the same rectangle', () => {
  const EMU_PER_PX = 9525;
  const slideOf = async (layout: StudioLayoutV2, photos: Array<{ bytes: Buffer; mimeType: 'image/png' | 'image/webp' }>, photoCutouts?: PhotoCutoutAsset[]) => {
    const deck = await encodeStudioTransferV2(layout, [copyText[0], copyText[1]], undefined, { photos, ...(photoCutouts ? { photoCutouts } : {}) });
    return strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
  };
  const onlyPicture = (slide: string) => {
    const pics = [...slide.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]);
    expect(pics).toHaveLength(1);
    return pics[0];
  };
  const srcRect = (pic: string) => {
    const m = pic.match(/<a:srcRect l="(-?\d+)" r="(-?\d+)" t="(-?\d+)" b="(-?\d+)"\/>/);
    expect(m).not.toBeNull();
    return { l: Number(m![1]), r: Number(m![2]), t: Number(m![3]), b: Number(m![4]) };
  };
  const geometry = (pic: string) => {
    const off = pic.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    return { x: Number(off?.[1]), y: Number(off?.[2]), cx: Number(ext?.[1]), cy: Number(ext?.[2]) };
  };
  /** srcRect edges (thousandths of a percent of the picture) that keep exactly `c` of an image. */
  const expectedRect = (c: CoverCropRect, image: { width: number; height: number }) => ({
    l: (1e5 * c.sx) / image.width,
    r: (1e5 * (image.width - c.sx - c.sw)) / image.width,
    t: (1e5 * c.sy) / image.height,
    b: (1e5 * (image.height - c.sy - c.sh)) / image.height,
  });
  const expectRectNear = (got: { l: number; r: number; t: number; b: number }, want: { l: number; r: number; t: number; b: number }) => {
    for (const k of ['l', 'r', 't', 'b'] as const) expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(2);
  };

  it('writes the coverCrop rectangle as srcRect, with the picture at the box', async () => {
    const bytes = portrait();
    expect(imagePixelSize(bytes)).toEqual({ width: 40, height: 80 });
    for (const focus of [headFocus, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.93 }]) {
      const pic = onlyPicture(await slideOf(withPhotos({ photoIndex: 0, role: 'portrait', ...square, focus }), [{ bytes, mimeType: 'image/png' }]));
      const crop = coverCrop(square, { width: 40, height: 80 }, focus);
      expectRectNear(srcRect(pic), expectedRect(crop, { width: 40, height: 80 }));
      expect(geometry(pic)).toEqual({ x: 86 * EMU_PER_PX, y: 420 * EMU_PER_PX, cx: 440 * EMU_PER_PX, cy: 440 * EMU_PER_PX });
    }
    // The head focus keeps the top half: nothing cut from the top, half from the bottom.
    const head = onlyPicture(await slideOf(withPhotos({ photoIndex: 0, role: 'portrait', ...square, focus: headFocus }), [{ bytes, mimeType: 'image/png' }]));
    expect(srcRect(head)).toEqual({ l: 0, r: 0, t: 0, b: 50000 });
  });

  it('follows the focus across a wide picture, even one scaled far past what pptxgenjs reads as inches', async () => {
    // 2000x100 into a 400x800 box: the crop is 50px wide, so the picture is scaled to 16000px.
    const bytes = rgbaPng(2000, 100, () => BLUE);
    const box = { x: 86, y: 420, width: 400, height: 800 };
    for (const focus of [{ x: 0.9, y: 0.5 }, { x: 0.3, y: 0.5 }]) {
      const pic = onlyPicture(await slideOf(withPhotos({ photoIndex: 0, role: 'hero', ...box, focus }), [{ bytes, mimeType: 'image/png' }]));
      const crop = coverCrop(box, { width: 2000, height: 100 }, focus);
      expectRectNear(srcRect(pic), expectedRect(crop, { width: 2000, height: 100 }));
      expect(geometry(pic)).toEqual({ x: 86 * EMU_PER_PX, y: 420 * EMU_PER_PX, cx: 400 * EMU_PER_PX, cy: 800 * EMU_PER_PX });
    }
  });

  it('leaves a photo without a focus as it was: the centred cover crop', async () => {
    const pic = onlyPicture(await slideOf(unfocusedDeckLayout(), [{ bytes: portrait(), mimeType: 'image/png' }]));
    // pptxgenjs `cover` for 40x80 in a square box, exactly as before.
    expect(srcRect(pic)).toEqual({ l: 0, r: 0, t: 25000, b: 25000 });
    expectRectNear(srcRect(pic), expectedRect(coverCrop(square, { width: 40, height: 80 }), { width: 40, height: 80 }));
    expect(geometry(pic)).toEqual({ x: 86 * EMU_PER_PX, y: 420 * EMU_PER_PX, cx: 440 * EMU_PER_PX, cy: 440 * EMU_PER_PX });
  });

  it('changes nothing for a photo whose size cannot be read, or a cut-out', async () => {
    const webp = Buffer.from('UklGRgAAAABXRUJQ', 'base64');
    const plain = await slideOf(unfocusedDeckLayout(), [{ bytes: webp, mimeType: 'image/webp' }]);
    expect(await slideOf(withPhotos({ photoIndex: 0, role: 'portrait', ...square, focus: headFocus }), [{ bytes: webp, mimeType: 'image/webp' }])).toBe(plain);

    const person: PhotoCutoutAsset = { png: rgbaPng(100, 150, () => RED), width: 100, height: 150 };
    const cut = (focus?: { x: number; y: number }) =>
      withPhotos({ photoIndex: 0, role: 'portrait', ...square, treatment: 'cutout', ...(focus ? { focus } : {}) });
    const cutPlain = await slideOf(cut(), [], [person]);
    expect(await slideOf(cut(headFocus), [], [person])).toBe(cutPlain);
  });

  function unfocusedDeckLayout(): StudioLayoutV2 {
    return withPhotos({ photoIndex: 0, role: 'portrait', ...square });
  }
});

describe('the focus survives preparation and normalisation', () => {
  it('settlePhotos moves the photos and keeps their focus', () => {
    // Candidate 4f4e82d6 of run f54b0388 (2026-09-22): the subtitle on portrait 0, so both photos move.
    const layout: StudioLayoutV2 = {
      ...base(),
      grid: { margin: 65, columns: 6, gutter: 20, baseline: 8 },
      logo: { x: 486, y: 361, width: 108, height: 108 },
      text: [
        { copyIndex: 0, role: 'title', x: 65, y: 537, width: 950, height: 248, fontSize: 88, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
        { copyIndex: 1, role: 'subtitle', x: 65, y: 785, width: 792, height: 90, fontSize: 30, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
      ],
      photos: [
        { photoIndex: 0, role: 'portrait', x: 170, y: 802, width: 313, height: 470, focus: { x: 0.4, y: 0.2 } },
        { photoIndex: 1, role: 'portrait', x: 527, y: 888, width: 383, height: 383, focus: { x: 0.6, y: 0.15 } },
      ],
    };
    const before = layout.photos!.map((p) => ({ x: p.x, y: p.y }));
    const settled = settlePhotos(layout);
    expect(settled.photos!.map((p) => ({ x: p.x, y: p.y }))).not.toEqual(before);
    expect(settled.photos!.map((p) => p.focus)).toEqual([{ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.15 }]);
    expect(studioLayoutV2Schema.safeParse(settled).success).toBe(true);
  });

  it('every preparation pass keeps it', () => {
    const layout = withPhotos(
      { photoIndex: 0, role: 'portrait', x: 86, y: 420, width: 440, height: 600, radius: 24, focus: { x: 0.45, y: 0.18 } },
      { photoIndex: 1, role: 'portrait', x: 554, y: 420, width: 440, height: 600, focus: { x: 0.55, y: 0.22 } }
    );
    const prepared = prepareGeneratedLayoutV3(layout, { text: copyText }, { width: 1080, height: 1350, logoAspect: 1, palette: [BACKGROUND, '#FFFFFF'] });
    expect(prepared.photos!.map((p) => p.focus)).toEqual([{ x: 0.45, y: 0.18 }, { x: 0.55, y: 0.22 }]);
    expect(validateLayoutV2(prepared, {
      expectedWidth: 1080, expectedHeight: 1350, copyCount: 2, copyScripts: ['latin', 'latin'], photoCount: 2,
      reference: { rules: { fontFamily: 'Verdana', palette: [BACKGROUND, '#FFFFFF'] }, logoAspect: 1.0 },
    }).ok).toBe(true);
  });

  it('the v3 generator\'s normalisation carries it unscaled, held to the photo, and drops one that is not a point', () => {
    const norm: NormalizedLayoutCandidate = {
      id: 'c1', conceptTitle: 'Two speakers', compositionArchetype: 'asymmetric_editorial',
      typeScale: { base: 20, ratio: 1.25 }, grid: { margin: 0.08, columns: 6, gutter: 0.02, baseline: 0.006 },
      background: { color: BACKGROUND }, logo: { x: 0.08, y: 0.06, width: 0.11, height: 0.09 }, art: null, shapes: [],
      text: [{ copyIndex: 0, role: 'title', x: 0.08, y: 0.22, width: 0.84, height: 0.1, fontSize: 44, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true, italic: false, rtl: false }],
      photos: [
        { photoIndex: 0, role: 'portrait', x: 0.08, y: 0.4, width: 0.28, height: 0.32, radiusFraction: 0, focus: { x: 0.3, y: 0.2 } },
        { photoIndex: 1, role: 'portrait', x: 0.38, y: 0.4, width: 0.28, height: 0.32, radiusFraction: 0, focus: { x: 1.2, y: -0.1 } },
        { photoIndex: 2, role: 'portrait', x: 0.68, y: 0.4, width: 0.24, height: 0.32, radiusFraction: 0, focus: { x: Number.NaN, y: 0.5 } },
      ],
    };
    const v2 = scaleNormalizedLayoutToV2(norm, 1080, 1350);
    expect(v2.photos!.map((p) => p.focus)).toEqual([{ x: 0.3, y: 0.2 }, { x: 1, y: 0 }, undefined]);
    expect('focus' in v2.photos![2]).toBe(false);
    expect(studioLayoutV2Schema.safeParse(v2).success).toBe(true);
  });
});

describe('pixel sizes and orientation (2026-09-24 review)', () => {
  it('reads a WebP\'s size from its header, in each of its three forms', async () => {
    const { webpPixelSize, imagePixelSize } = await import('../src/studio/photo-crop.js');
    const riff = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), body]);
    const vp8x = Buffer.alloc(14); vp8x.writeUIntLE(640 - 1, 4, 3); vp8x.writeUIntLE(480 - 1, 7, 3);
    expect(webpPixelSize(riff('VP8X', vp8x))).toEqual({ width: 640, height: 480 });
    const vp8l = Buffer.alloc(14); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((300 - 1) & 0x3fff) | (((200 - 1) & 0x3fff) << 14), 1);
    expect(webpPixelSize(riff('VP8L', vp8l))).toEqual({ width: 300, height: 200 });
    const vp8 = Buffer.alloc(14); vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a; vp8.writeUInt16LE(400, 6); vp8.writeUInt16LE(273, 8);
    expect(imagePixelSize(riff('VP8 ', vp8))).toEqual({ width: 400, height: 273 });
    expect(webpPixelSize(Buffer.from('RIFF0000WAVEfmt '))).toBeNull();
  });

  it('turns a JPEG stored on its side upright, once, and leaves every other photo as it came', async () => {
    const fs = await import('node:fs');
    const { jpegOrientation } = await import('../src/studio/photo-crop.js');
    const { uprightPhotoDataUrl } = await import('../src/studio/photo-upright.js');
    const { PNG: Png } = await import('pngjs');
    // A 16x8 JPEG, red on the left and blue on the right, tagged "turn 90 degrees clockwise" (6).
    const plain = fs.readFileSync(new URL('./fixtures/red-left-blue-right.jpg', import.meta.url));
    const exif = Buffer.from('45786966000' + '04d4d002a00000008000101120003000000010006000000000000', 'hex');
    const withoutApp1 = (() => {
      const parts = [plain.subarray(0, 2)];
      let i = 2;
      while (i + 4 < plain.length && plain[i] === 0xff && plain[i + 1] !== 0xda) {
        const len = plain.readUInt16BE(i + 2);
        if (plain[i + 1] !== 0xe1) parts.push(plain.subarray(i, i + 2 + len));
        i += 2 + len;
      }
      parts.push(plain.subarray(i));
      return Buffer.concat(parts);
    })();
    const length = Buffer.alloc(2); length.writeUInt16BE(exif.length + 2);
    const tagged = Buffer.concat([withoutApp1.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, exif, withoutApp1.subarray(2)]);
    expect(jpegOrientation(tagged)).toBe(6);
    expect(jpegOrientation(withoutApp1)).toBe(1);
    const upright = await uprightPhotoDataUrl(`data:image/jpeg;base64,${tagged.toString('base64')}`);
    expect(upright.startsWith('data:image/png;base64,')).toBe(true);
    const pixels = Png.sync.read(Buffer.from(upright.split(',')[1], 'base64'));
    expect([pixels.width, pixels.height]).toEqual([8, 16]);
    const at = (x: number, y: number) => [...pixels.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
    // Turned clockwise, the red left half is on top and the blue right half below.
    expect(at(4, 2)[0]).toBeGreaterThan(at(4, 2)[2]);
    expect(at(4, 13)[2]).toBeGreaterThan(at(4, 13)[0]);
    const untouched = `data:image/jpeg;base64,${withoutApp1.toString('base64')}`;
    expect(await uprightPhotoDataUrl(untouched)).toBe(untouched);
  });

  it('a photo too large to embed comes back small enough to render, the same picture (review of 2026-09-24)', async () => {
    const { uprightPhotoDataUrl, PHOTO_DATA_URL_MAX, UPRIGHT_MAX_SIDE } = await import('../src/studio/photo-upright.js');
    const { PNG: Png } = await import('pngjs');
    // Noise barely compresses: 1800x1800 is a PNG of about 10 MB, over rsvg's 10 MB attribute limit as a
    // data URL, which failed every render of the design it was in.
    const png = new Png({ width: 1800, height: 1800 });
    let seed = 7;
    for (let i = 0; i < png.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      png.data.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255], i);
    }
    // A red square in the top left corner, to see it is the same picture the same way up.
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) png.data.set([255, 0, 0, 255], (y * 1800 + x) * 4);
    const big = `data:image/png;base64,${Png.sync.write(png).toString('base64')}`;
    expect(big.length).toBeGreaterThan(PHOTO_DATA_URL_MAX);
    const out = await uprightPhotoDataUrl(big);
    expect(out.length).toBeLessThanOrEqual(PHOTO_DATA_URL_MAX);
    const pixels = Png.sync.read(Buffer.from(out.split(',')[1], 'base64'));
    expect(Math.max(pixels.width, pixels.height)).toBeLessThanOrEqual(UPRIGHT_MAX_SIDE);
    expect(pixels.width).toBe(pixels.height);
    const corner = (Math.round(pixels.height * 0.05) * pixels.width + Math.round(pixels.width * 0.05)) * 4;
    expect([...pixels.data.subarray(corner, corner + 3)]).toEqual([255, 0, 0]);
  }, 60000);
});
