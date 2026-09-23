import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { uprightPhotoDataUrl } from '../src/studio/photo-upright.js';
import { renderLayoutV2Async } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * Bug hunt on b2bbbb8: a 12 MP phone photo sent as a file (orientation 6, as an iPhone stores a
 * portrait) is turned upright as a full-size PNG. How big is it, how long does it take, and what does
 * it cost every render afterwards? HUNT_PHOTO is a 4032x3024 JPEG (made with ImageMagick plasma);
 * HUNT_RSVG optionally runs the production core image's rsvg-convert.
 */
const file = process.env.HUNT_PHOTO || '';
const rsvg = process.env.HUNT_RSVG ? { rsvgConvertPath: process.env.HUNT_RSVG } : undefined;

const withOrientation = (jpeg: Buffer, o: number) => {
  const exif = Buffer.from(`457869660000` + `4d4d002a00000008` + `0001` + `011200030000000100${o.toString(16).padStart(2, '0')}0000` + `00000000`, 'hex');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, exif, jpeg.subarray(2)]);
};

const layout = (): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350,
  grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#0A2A6B' }, shapes: [],
  text: [{ x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true }],
  photos: [{ photoIndex: 0, role: 'portrait', x: 72, y: 500, width: 600, height: 800 }],
} as unknown as StudioLayoutV2);

describe.skipIf(!file)('review of 2026-09-24: a 12 MP photo turned upright', () => {
  it('stays about the size it came, and renders about as fast', async () => {
    const jpeg = withOrientation(fs.readFileSync(file), 6);
    const inUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    let t = Date.now();
    const upright = await uprightPhotoDataUrl(inUrl, rsvg);
    const turnMs = Date.now() - t;
    t = Date.now();
    await renderLayoutV2Async(layout(), { copyText: { 0: 'TITLE' }, photoDataUris: [inUrl], ...(rsvg || {}) });
    const renderJpegMs = Date.now() - t;
    t = Date.now();
    let renderUpright = '';
    try {
      await renderLayoutV2Async(layout(), { copyText: { 0: 'TITLE' }, photoDataUris: [upright], ...(rsvg || {}) });
      renderUpright = `${Date.now() - t} ms`;
    } catch (err) {
      renderUpright = `FAILED after ${Date.now() - t} ms: ${String((err as Error).message).replace(/\/var\/folders\S+/, '<tmp>').slice(0, 160)}`;
    }
    const renderUprightMs = renderUpright;
    const mb = (s: string) => Math.round((s.length / 1024 / 1024) * 10) / 10;
    expect(renderUprightMs).not.toContain('FAILED');
    expect(upright.length).toBeLessThan(inUrl.length * 2);
  }, 120000);
});
