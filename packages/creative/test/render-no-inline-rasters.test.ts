import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { StudioLayoutV2, PhotoElement } from '../src/studio/layout-v2.js';
import type { PhotoCutoutAsset } from '../src/studio/photo-cutout.js';

/**
 * ADR-035 section 5 (FILESTORE_DESIGN.md sections 6 and 7): no picture reaches either rasteriser as a
 * data URI over 100 KB. Photos, cut-outs, their outlines and glows, the art and the logo are files
 * beside the SVG, and they draw the same pixels the data URIs drew.
 *
 * The spy sits where the rasterisers hand the SVG to rsvg-convert: every call of execFile (the async
 * rasteriser and the deck's bake) and spawnSync (the sync rasteriser and the logo prescale) has its SVG
 * file read before rsvg runs.
 */
const seen: Array<{ via: string; svg: string; siblings: string[] }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const record = (via: string, args: unknown) => {
    const list = Array.isArray(args) ? (args as string[]) : [];
    const file = list[list.length - 1];
    if (typeof file === 'string' && file.endsWith('.svg') && fs.existsSync(file)) {
      seen.push({ via, svg: fs.readFileSync(file, 'utf8'), siblings: fs.readdirSync(path.dirname(file)) });
    }
  };
  return {
    ...actual,
    execFile: ((cmd: string, args: unknown, ...rest: unknown[]) => {
      record('execFile', args);
      return (actual.execFile as any)(cmd, args, ...rest);
    }) as typeof actual.execFile,
    spawnSync: ((cmd: string, args: unknown, ...rest: unknown[]) => {
      record('spawnSync', args);
      return (actual.spawnSync as any)(cmd, args, ...rest);
    }) as typeof actual.spawnSync,
  };
});

const { renderLayoutV2, renderLayoutV2Async, renderLayoutV2ToSvg, svgToPngAsync } = await import('../src/studio/render-layout-v2.js');
const { encodeStudioTransferV2 } = await import('../src/studio/transfer-v2.js');
const { uprightPhoto } = await import('../src/studio/photo-upright.js');
const { INLINE_DATA_URI_MAX, largestInlineDataUri, inlineSvgFiles, checkInlineDataUris, setInlineDataUriGuard } = await import('../src/studio/svg-files.js');

/** A deterministic pseudo-random stream, so the noise fixtures are the same bytes every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A noise PNG: incompressible, so its size is about its pixel count times four. */
function noisePng(width: number, height: number, seed: number, alpha?: (x: number, y: number) => number): Buffer {
  const png = new PNG({ width, height });
  const rnd = prng(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) * 4;
      png.data[i] = Math.floor(rnd() * 256);
      png.data[i + 1] = Math.floor(rnd() * 256);
      png.data[i + 2] = Math.floor(rnd() * 256);
      png.data[i + 3] = alpha ? alpha(x, y) : 255;
    }
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

/** The phone photo fixture (4032x3024 JPEG) with an EXIF orientation 6 segment, as an iPhone stores a portrait. */
function phonePhotoOrientation6(): Buffer {
  const jpeg = fs.readFileSync(new URL('./fixtures/phone-12mp-plasma.jpg', import.meta.url));
  const exif = Buffer.from('457869660000' + '4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000', 'hex');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, exif, jpeg.subarray(2)]);
}

const uri = (bytes: Buffer, type: string) => `data:${type};base64,${bytes.toString('base64')}`;

/** A person cut out: opaque in an ellipse, transparent around it, noise inside so the PNG is large. */
function personCutout(): PhotoCutoutAsset {
  const w = 360;
  const h = 540;
  const inside = (x: number, y: number) => ((x - w / 2) / (w * 0.35)) ** 2 + ((y - h * 0.55) / (h * 0.45)) ** 2 <= 1;
  return { png: noisePng(w, h, 7, (x, y) => (inside(x, y) ? 255 : 0)), width: w, height: h };
}

const layout = (photos: PhotoElement[], withArt = true): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#0A2A6B' },
    shapes: [],
    ...(withArt ? { art: { box: { x: 0, y: 0, width: 1080, height: 600 }, opacity: 0.9 } } : {}),
    logo: { x: 860, y: 60, width: 160, height: 160 },
    text: [{ x: 72, y: 1180, width: 936, height: 120, copyIndex: 0, role: 'title', fontSize: 56, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true }],
    photos,
  }) as unknown as StudioLayoutV2;

/**
 * The data-URI baseline: the same SVG with every file put back inline, through the renderer's own
 * rasteriser (same rsvg, same pinned fonts), with the guard set to log for this one call.
 */
async function rasteriseInline(svg: string, width: number, height: number): Promise<Buffer> {
  setInlineDataUriGuard('log');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await svgToPngAsync(svg, width, height);
  } finally {
    warn.mockRestore();
    setInlineDataUriGuard(undefined);
  }
}

const samePixels = (a: Buffer, b: Buffer) => {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  return x.width === y.width && x.height === y.height && Buffer.compare(x.data, y.data) === 0;
};

function assertNoLargeDataUris() {
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) expect(largestInlineDataUri(s.svg), `${s.via}: ${s.svg.slice(0, 120)}`).toBeLessThanOrEqual(INLINE_DATA_URI_MAX);
}

const phone = phonePhotoOrientation6();
const art = noisePng(540, 300, 3);
// Smaller than its box, so it is drawn as it came (no prescale): the unprescaled logo path.
const logo = noisePng(150, 150, 5);
const cut = personCutout();

beforeEach(() => {
  seen.length = 0;
});

describe('ADR-035: the renderer reads pictures as files beside the SVG', () => {
  it('fixtures are the sizes the acceptance names: every one would have been a data URI over 100 KB', () => {
    for (const bytes of [phone, art, logo, cut.png]) expect(uri(bytes, 'image/png').length).toBeGreaterThan(INLINE_DATA_URI_MAX);
  });

  it('a design with an EXIF-6 phone photo, a treated photo, a cut-out with glow and outline, art and a logo: no data URI over 100 KB reaches either rasteriser, and the pixels equal the data-URI baseline', async () => {
    const upright = await uprightPhoto(phone);
    expect(upright.changed).toBe(true);
    const photos: PhotoElement[] = [
      { photoIndex: 0, role: 'portrait', x: 72, y: 620, width: 300, height: 400, focus: { x: 0.4, y: 0.3 } } as PhotoElement,
      { photoIndex: 1, role: 'portrait', x: 400, y: 620, width: 260, height: 260, mask: 'circle', filter: { kind: 'bw' } } as unknown as PhotoElement,
      { photoIndex: 2, role: 'portrait', x: 700, y: 560, width: 300, height: 540, treatment: 'cutout', outline: { width: 6, color: '#F5B700' }, glow: { radius: 12, color: '#FFFFFF' } } as unknown as PhotoElement,
    ];
    const options = {
      copyText: { 0: 'Her path, her power' },
      artImagePath: uri(art, 'image/png'),
      logoDataUri: uri(logo, 'image/png'),
      photoFiles: [{ bytes: upright.bytes }, { bytes: phone }, undefined],
      photoCutouts: [undefined, undefined, cut],
    };
    const l = layout(photos);

    const asyncResult = await renderLayoutV2Async(l, options);
    assertNoLargeDataUris();
    expect(seen.filter((s) => s.via === 'execFile').length).toBeGreaterThanOrEqual(2);
    // Every file the SVG names was written beside it.
    for (const s of seen) for (const name of s.svg.match(/href="([a-z0-9-]+\.[a-z]+)"/g) ?? []) expect(s.siblings).toContain(name.slice(6, -1));
    expect(Object.keys(asyncResult.files).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^photo-[0-9a-f]{16}\.png$/), expect.stringMatching(/^photo-[0-9a-f]{16}\.jpg$/), expect.stringMatching(/^cutout-/), expect.stringMatching(/^outline-/), expect.stringMatching(/^glow-/), expect.stringMatching(/^art-/), expect.stringMatching(/^logo-/)])
    );

    seen.length = 0;
    const syncResult = renderLayoutV2(l, options);
    assertNoLargeDataUris();
    expect(seen.some((s) => s.via === 'spawnSync')).toBe(true);
    expect(samePixels(syncResult.png, asyncResult.png)).toBe(true);

    // The data-URI baseline: the same SVG with every file put back inline.
    const baseline = await rasteriseInline(inlineSvgFiles(asyncResult.svg, asyncResult.files), 1080, 1350);
    const baselineNoText = await rasteriseInline(inlineSvgFiles(asyncResult.noTextSvg, asyncResult.files), 1080, 1350);
    expect(largestInlineDataUri(inlineSvgFiles(asyncResult.svg, asyncResult.files))).toBeGreaterThan(INLINE_DATA_URI_MAX);
    expect(samePixels(asyncResult.png, baseline)).toBe(true);
    expect(samePixels(asyncResult.noTextPng, baselineNoText)).toBe(true);
  }, 120_000);

  it('photos passed the legacy way, as data URIs, are written as files too, with the same pixels as photoFiles', async () => {
    const photos = [{ photoIndex: 0, role: 'portrait', x: 72, y: 620, width: 500, height: 500 } as PhotoElement];
    const viaUri = await renderLayoutV2Async(layout(photos, false), { copyText: { 0: 'x' }, photoDataUris: [uri(phone, 'image/jpeg')] });
    assertNoLargeDataUris();
    const viaFiles = await renderLayoutV2Async(layout(photos, false), { copyText: { 0: 'x' }, photoFiles: [{ bytes: phone }] });
    expect(viaUri.svg).toBe(viaFiles.svg);
    expect(samePixels(viaUri.png, viaFiles.png)).toBe(true);
  }, 60_000);

  it('a 20 MB PNG renders from a file (as a data URI it is past rsvg\'s 10 MB attribute limit)', async () => {
    const huge = noisePng(2800, 2200, 11);
    expect(huge.length).toBeGreaterThan(20 * 1024 * 1024);
    const photos = [{ photoIndex: 0, role: 'hero', x: 0, y: 0, width: 1080, height: 1000 } as PhotoElement];
    const result = await renderLayoutV2Async(layout(photos, false), { copyText: { 0: 'x' }, photoFiles: [{ bytes: huge }] });
    assertNoLargeDataUris();
    expect(result.png.length).toBeGreaterThan(1000);
    // The pixel at the photo's centre is the photo's, not the navy background.
    const out = PNG.sync.read(result.png);
    const i = (out.width * 500 + 540) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).not.toEqual([0x0a, 0x2a, 0x6b]);
  }, 120_000);

  it('the deck\'s bake of treated photos and cut-out effects hands rsvg files, not data URIs', async () => {
    const photos: PhotoElement[] = [
      { photoIndex: 0, role: 'portrait', x: 72, y: 620, width: 300, height: 300, radius: 24, filter: { kind: 'bw' } } as unknown as PhotoElement,
      { photoIndex: 1, role: 'portrait', x: 500, y: 560, width: 300, height: 540, treatment: 'cutout', fade: { edge: 'bottom', length: 0.3 }, outline: { width: 4, color: '#F5B700' } } as unknown as PhotoElement,
    ];
    await encodeStudioTransferV2(layout(photos, false), ['x'], undefined, {
      photos: [{ bytes: phone, mimeType: 'image/jpeg' }, { bytes: cut.png, mimeType: 'image/png' }],
      photoCutouts: [undefined, cut],
    });
    assertNoLargeDataUris();
    expect(seen.some((s) => s.siblings.some((n) => n.startsWith('photo-')))).toBe(true);
    expect(seen.some((s) => s.siblings.some((n) => n.startsWith('cutout-')))).toBe(true);
  }, 120_000);

  it('the guard refuses an SVG with an inline data URI over 100 KB in a test run', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${uri(art, 'image/png')}"/></svg>`;
    expect(() => checkInlineDataUris(svg, 'test')).toThrow(/inline data URI \d+ bytes/);
    expect(() => checkInlineDataUris(`<svg><image href="${uri(noisePng(10, 10, 1), 'image/png')}"/></svg>`, 'test')).not.toThrow();
    // renderLayoutV2ToSvg itself never emits one.
    const { svg: built } = renderLayoutV2ToSvg(layout([{ photoIndex: 0, role: 'hero', x: 0, y: 0, width: 400, height: 400 } as PhotoElement]), {
      copyText: { 0: 'x' },
      artImagePath: uri(art, 'image/png'),
      photoDataUris: [uri(phone, 'image/jpeg')],
    });
    expect(largestInlineDataUri(built)).toBeLessThanOrEqual(INLINE_DATA_URI_MAX);
  });
});
