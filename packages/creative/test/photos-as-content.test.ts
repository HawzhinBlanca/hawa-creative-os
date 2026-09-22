import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2, imagePixelSize } from '../src/studio/transfer-v2.js';

/**
 * "A graphic with these texts and two pictures in it." Until 2026-09-22 a photo sent with a request
 * could only be a style reference; the design that came back had the texts and no pictures, and
 * the sender was told the checks passed. A photo the client sends is content: placed once, big
 * enough to read as a photograph, never under text, carried to Canva as the same crop the judge saw.
 */

/** A 4x2 red PNG: enough for a real header and a real aspect. */
function tinyPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) raw.set([200, 30, 30], y * (width * 3 + 1) + 1 + x * 3); }
  const { deflateSync } = require('node:zlib');
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const base = (): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [],
  logo: { x: 86, y: 86, width: 120, height: 120 },
  text: [
    { copyIndex: 0, role: 'title', x: 86, y: 280, width: 908, height: 120, fontSize: 44, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { copyIndex: 1, role: 'body', x: 86, y: 1100, width: 908, height: 120, fontSize: 20, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
});
const context = (photoCount: number) => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 2, copyScripts: ['latin', 'latin'] as Array<'latin' | 'arabic'>,
  photoCount,
  reference: { rules: { fontFamily: 'Verdana', palette: ['#0A1628', '#FFFFFF'] }, logoAspect: 1.0 },
});
const twoPortraits = (): StudioLayoutV2 => ({
  ...base(),
  photos: [
    { photoIndex: 0, role: 'portrait', x: 86, y: 420, width: 440, height: 600, radius: 24 },
    { photoIndex: 1, role: 'portrait', x: 554, y: 420, width: 440, height: 600, radius: 24 },
  ],
});

describe('photos as content', () => {
  it('the schema accepts placed photos', () => {
    expect(studioLayoutV2Schema.safeParse(twoPortraits()).success).toBe(true);
  });

  it('a request with two photos must place both, once each, clear of text and logo, and large enough', () => {
    expect(validateLayoutV2(twoPortraits(), context(2)).ok).toBe(true);

    const dropped = { ...twoPortraits(), photos: [twoPortraits().photos![0]] };
    expect(validateLayoutV2(dropped, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });

    const invented = twoPortraits();
    expect(validateLayoutV2(invented, context(0))).toMatchObject({ ok: false, code: 'PHOTOS' });

    const twice = { ...twoPortraits(), photos: twoPortraits().photos!.map((p) => ({ ...p, photoIndex: 0 })) };
    expect(validateLayoutV2(twice, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });

    const underText = twoPortraits();
    underText.photos![0].y = 300;
    expect(validateLayoutV2(underText, context(2)).ok).toBe(false);

    const thumbnail = twoPortraits();
    thumbnail.photos![1] = { ...thumbnail.photos![1], width: 120, height: 120 };
    expect(validateLayoutV2(thumbnail, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });

    const offCanvas = twoPortraits();
    offCanvas.photos![1].x = 900;
    expect(validateLayoutV2(offCanvas, context(2))).toMatchObject({ ok: false, code: 'PHOTOS' });

    // A design with no photos is still fine for a request with none.
    expect(validateLayoutV2(base(), context(0)).ok).toBe(true);
  });

  it('the preview draws each photo, clipped to its box, and a labelled slot when the bytes are missing', () => {
    const png = tinyPng(4, 2);
    const uri = `data:image/png;base64,${png.toString('base64')}`;
    const render = renderLayoutV2(twoPortraits(), { copyText: { 0: 'Her path, her power', 1: 'September 25, 2026' }, photoDataUris: [uri] });
    expect(render.svg).toMatch(/<image id="photo-0"[^>]*preserveAspectRatio="xMidYMid slice"[^>]*clip-path="url\(#photo-clip-0\)"/);
    expect(render.svg).toMatch(/<rect id="photo-slot-1"/);
    // Photos sit above the art and below the text.
    expect(render.svg.indexOf('id="photo-0"')).toBeLessThan(render.svg.indexOf('Her path'));
  });

  it('the Canva deck carries every placed photo with cover sizing, and refuses a placed photo with no bytes', async () => {
    const bytes = tinyPng(4, 2);
    expect(imagePixelSize(bytes)).toEqual({ width: 4, height: 2 });
    const logo = { bytes: tinyPng(2, 2), mimeType: 'image/png' as const, sha256: createHash('sha256').update(tinyPng(2, 2)).digest('hex') };
    const deck = await encodeStudioTransferV2(twoPortraits(), ['Her path, her power', 'September 25, 2026'], logo, {
      photos: [{ bytes, mimeType: 'image/png' }, { bytes, mimeType: 'image/png' }],
    });
    const zip = Buffer.from(deck.bytes);
    const names = new Set<string>();
    for (let i = 0; i + 46 <= zip.length; i++) {
      if (zip.readUInt32LE(i) !== 0x02014b50) continue; // central directory entry
      const n = zip.readUInt16LE(i + 28);
      names.add(zip.subarray(i + 46, i + 46 + n).toString('utf8'));
    }
    const media = [...names].filter((n) => /^ppt\/media\/.+\.(png|jpe?g)$/.test(n));
    // logo + two photos
    expect(media.length).toBeGreaterThanOrEqual(3);

    await expect(encodeStudioTransferV2(twoPortraits(), ['a', 'b'], logo, { photos: [{ bytes, mimeType: 'image/png' }] })).rejects.toThrow(/Photo 1 .*no bytes/);
  });

  it('reads a JPEG size from its header', () => {
    // SOI, APP0 (empty), SOF0 with height 560 width 1438, EOI
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x30, 0x05, 0x9e, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x02]), sof, Buffer.from([0xff, 0xd9])]);
    expect(imagePixelSize(jpeg)).toEqual({ width: 1438, height: 560 });
  });
});

import { scaleNormalizedLayoutToV2, type NormalizedLayoutCandidate } from '../src/studio/layout-generator-v3.js';
import { layoutDefectCount } from '../src/studio/style-spec.js';

describe('photos in the v3 pipeline (the one production runs)', () => {
  const norm = (): NormalizedLayoutCandidate => ({
    id: 'c1', conceptTitle: 'Two speakers', compositionArchetype: 'asymmetric_editorial' as any,
    typeScale: { base: 20, ratio: 1.25 }, grid: { margin: 0.08, columns: 6, gutter: 0.02, baseline: 0.006 },
    background: { color: '#0A1628' }, logo: { x: 0.08, y: 0.06, width: 0.11, height: 0.09 }, art: null, shapes: [],
    text: [{ copyIndex: 0, role: 'title', x: 0.08, y: 0.22, width: 0.84, height: 0.1, fontSize: 44, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true } as any],
    photos: [
      { photoIndex: 0, role: 'portrait', x: 0.08, y: 0.4, width: 0.4, height: 0.32, radiusFraction: 0.5 },
      { photoIndex: 1, role: 'portrait', x: 0.52, y: 0.4, width: 0.4, height: 0.32, radiusFraction: 0 },
    ],
  });

  it('scales normalized photos to pixels with their corner radius', () => {
    const v2 = scaleNormalizedLayoutToV2(norm(), 1080, 1350);
    expect(v2.photos).toHaveLength(2);
    expect(v2.photos![0]).toMatchObject({ photoIndex: 0, role: 'portrait', x: 86, y: 540, width: 432, height: 432, radius: 216 });
    expect(v2.photos![1].radius).toBeUndefined();
  });

  it('a layout with text on a photo counts as a defect, so no guarded pass can make one', () => {
    const v2 = scaleNormalizedLayoutToV2(norm(), 1080, 1350);
    const copy = { text: { 0: 'MEET KAAE AT SAGACON 2026' } };
    const clean = layoutDefectCount(v2, copy);
    const covered = JSON.parse(JSON.stringify(v2));
    covered.text[0].y = covered.photos[0].y + 10;
    expect(layoutDefectCount(covered, copy)).toBeGreaterThan(clean);
  });
});

import { settlePhotos } from '../src/studio/pipeline-v3.js';

describe('settlePhotos: the photos move, not the copy', () => {
  // Candidate 4f4e82d6 of run f54b0388 (2026-09-22) as it left preparation: the subtitle on portrait 0.
  const failing = (): StudioLayoutV2 => ({
    ...base(),
    grid: { margin: 65, columns: 6, gutter: 20, baseline: 8 },
    logo: { x: 486, y: 361, width: 108, height: 108 },
    text: [
      { copyIndex: 0, role: 'title', x: 65, y: 537, width: 950, height: 248, fontSize: 88, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
      { copyIndex: 1, role: 'subtitle', x: 65, y: 785, width: 792, height: 90, fontSize: 30, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    ],
    photos: [
      { photoIndex: 0, role: 'portrait', x: 170, y: 802, width: 313, height: 470 },
      { photoIndex: 1, role: 'portrait', x: 527, y: 888, width: 383, height: 383 },
    ],
  });
  const ctx2 = { ...context(2), copyCount: 2 };

  it('re-seats photos that text covers into a free band, at a valid size, aligned with the copy', () => {
    expect(validateLayoutV2(failing(), ctx2)).toMatchObject({ ok: false, code: 'PHOTOS' });
    const settled = settlePhotos(failing());
    expect(validateLayoutV2(settled, ctx2).ok).toBe(true);
    expect(settled.photos![0].x).toBe(settled.grid.margin); // left-aligned copy, left-aligned row
    expect(settled.text[1].y).toBe(785); // the copy did not move
  });

  it('leaves a layout with no conflict exactly as it is', () => {
    const ok = twoPortraits();
    expect(settlePhotos(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it('does not shrink photos into thumbnails when no band fits: QA refuses instead', () => {
    const crowded = failing();
    crowded.text.push({ copyIndex: 2, role: 'body', x: 65, y: 900, width: 950, height: 380, fontSize: 20, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' } as any);
    crowded.text[0].y = 120;
    const before = JSON.stringify(crowded.photos);
    expect(JSON.stringify(settlePhotos(crowded).photos)).toBe(before);
  });

  it('draws photos above panels (card backgrounds), below the copy', () => {
    const l = twoPortraits();
    l.shapes = [{ kind: 'rect', role: 'panel', x: 60, y: 400, width: 960, height: 640, color: '#1E3A5F' } as any];
    const svg = renderLayoutV2(l, { copyText: { 0: 'Title', 1: 'Body' }, photoDataUris: [`data:image/png;base64,${tinyPng(2, 2).toString('base64')}`, `data:image/png;base64,${tinyPng(2, 2).toString('base64')}`] }).svg;
    expect(svg.indexOf('fill="#1E3A5F"')).toBeLessThan(svg.indexOf('id="photo-0"'));
  });
});
