import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ingestOfficePhotoFolder,
  parseCsv,
  parseOfficePhotoTagSheet,
  readOfficePhotoLibrary,
} from '../src/studio/office-photo-library-store.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';

/** Hunt-3: ingestion and tag-sheet edge cases of the office photo library (ADR-280). */

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const roots: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(path.join(tmpdir(), p)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

describe('tag sheet CSV (hunt-3)', () => {
  it('refuses a quote that is never closed instead of swallowing the rows after it', () => {
    const text = [
      'source,description,usable',
      'a.png,"Students at the campus,yes',
      'b.png,Graduation,no',
      'c.png,Forum,no',
    ].join('\n');
    expect(() => parseCsv(text)).toThrow(/OFFICE_PHOTO_TAGS_INVALID: .*quote/i);
    expect(() => parseOfficePhotoTagSheet(text, 'csv')).toThrow(/OFFICE_PHOTO_TAGS_INVALID/);
  });

  it('still reads quoted commas, doubled quotes, line breaks in a quoted field, CRLF and a BOM', () => {
    const rows = parseCsv('﻿source,description\r\n"a,b.png","He said ""hi""\nthen left"\r\n');
    expect(rows).toEqual([['source', 'description'], ['a,b.png', 'He said "hi"\nthen left']]);
  });
});

describe('ingestion edge cases (hunt-3)', () => {
  it('skips a file whose name the manifest cannot hold, and still ingests the rest of the folder', async () => {
    const source = tmp('olp-h3-names-');
    const root = tmp('olp-h3-root-');
    const deep = path.join(source, 'a'.repeat(120), 'b'.repeat(120));
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, `${'c'.repeat(100)}.png`), syntheticPhoto(900, 900, 71));
    writeFileSync(path.join(source, 'ok.png'), syntheticPhoto(900, 900, 72));
    writeFileSync(path.join(source, 'نامە ١.png'), syntheticPhoto(900, 900, 73));
    const report = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(report.added).toHaveLength(2);
    expect(report.skipped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/name/) })]);
    const read = await readOfficePhotoLibrary(path.join(root, 'kaae'));
    expect(read?.library.photos.map((p) => p.sourceName).sort()).toEqual(['ok.png', 'نامە ١.png']);
  });

  it('reports a second copy of the same photo in the folder as a skipped duplicate, not as unchanged', async () => {
    const source = tmp('olp-h3-dup-');
    const root = tmp('olp-h3-root-');
    const photo = syntheticPhoto(900, 900, 74);
    writeFileSync(path.join(source, 'one.png'), photo);
    writeFileSync(path.join(source, 'two.png'), photo);
    const report = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(report.added).toEqual([`olp_${sha(photo).slice(0, 16)}`]);
    expect(report.unchanged).toEqual([]);
    expect(report.skipped).toEqual([{ source: 'two.png', reason: 'duplicate of a photo already in this folder' }]);
  });

  it('a re-run restores a stored photo that went missing or was damaged instead of calling it unchanged', async () => {
    const source = tmp('olp-h3-restore-');
    const root = tmp('olp-h3-root-');
    const photo = syntheticPhoto(900, 900, 75);
    writeFileSync(path.join(source, 'one.png'), photo);
    await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    const stored = path.join(root, 'kaae', 'photos', `${sha(photo)}.png`);
    const manifestBefore = readFileSync(path.join(root, 'kaae', 'library.json'), 'utf8');
    unlinkSync(stored);
    const again = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(readFileSync(stored).equals(photo)).toBe(true);
    expect(again.unchanged).toEqual([]);
    expect(again.updated).toEqual([`olp_${sha(photo).slice(0, 16)}`]);
    writeFileSync(stored, Buffer.from('damaged'));
    await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(readFileSync(stored).equals(photo)).toBe(true);
    // The manifest itself did not need to change: the same entry, the same bytes on disk.
    const manifestAfter = JSON.parse(readFileSync(path.join(root, 'kaae', 'library.json'), 'utf8'));
    expect(manifestAfter.photos).toEqual(JSON.parse(manifestBefore).photos);
  });

  it('skips a photo whose header claims more pixels than the limit before any decoding', async () => {
    const source = tmp('olp-h3-bomb-');
    const root = tmp('olp-h3-root-');
    // A tiny PNG whose header says 60000 x 60000 pixels.
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(60000, 0); ihdr.writeUInt32BE(60000, 4); ihdr[8] = 8; ihdr[9] = 2;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(1000))), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(path.join(source, 'bomb.png'), bomb);
    writeFileSync(path.join(source, 'ok.png'), syntheticPhoto(900, 900, 76));
    const report = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(report.added).toHaveLength(1);
    expect(report.skipped).toEqual([{ source: 'bomb.png', reason: 'larger than the pixel limit' }]);
  });

  it('a damaged image is skipped and the rest of the folder is still ingested', async () => {
    const source = tmp('olp-h3-corrupt-');
    const root = tmp('olp-h3-root-');
    const good = syntheticPhoto(900, 900, 77);
    // A JPEG start-of-image marker with an EXIF orientation 6 segment and nothing decodable after it.
    const exif = Buffer.from('4578696600004d4d002a00000008000101120003000000010006000000000000', 'hex');
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x03, 0x84, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    writeFileSync(path.join(source, 'broken.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(64, 0x55)]));
    writeFileSync(path.join(source, 'empty.jpg'), Buffer.alloc(0));
    writeFileSync(path.join(source, 'good.png'), good);
    const report = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae' });
    expect(report.added).toEqual([`olp_${sha(good).slice(0, 16)}`]);
    expect(report.skipped.map((s) => s.source).sort()).toEqual(['broken.jpg', 'empty.jpg']);
  });

  it('names a video as not an image, not as HEIC', async () => {
    const source = tmp('olp-h3-video-');
    const root = tmp('olp-h3-root-');
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32)]);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    writeFileSync(path.join(source, 'clip.mp4'), mp4);
    writeFileSync(path.join(source, 'photo.heic'), heic);
    const report = await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae', dryRun: true });
    expect(report.skipped).toEqual([
      { source: 'clip.mp4', reason: 'not an image' },
      { source: 'photo.heic', reason: 'HEIC/HEIF is not supported; export it as JPEG first' },
    ]);
  });
});
