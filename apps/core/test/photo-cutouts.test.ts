import { describe, it, expect, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { blobStoreFromEnv, createDb, withRlsContext, sql } from '@hawa/db';
import { type StudioLayoutV2, type PhotoCutoutAsset } from '@hawa/creative';
import { PhotoCutouts, arrangeCutouts, CUTOUT_WORDS, reasonFor } from '../src/services/design-studio/photo-cutouts.js';
import { editMeans, carryOver } from '../src/services/design-studio/stages/edit.stage.js';
import { photosBrief } from '../src/services/design-studio/stages/layouts.stage.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';

/**
 * People cut out of their photos (ADR-032). On 2026-09-23 a requester asked twice for the panelists
 * cut out and set on the poster's background, as in her reference; the pipeline had no means to do
 * it. These are the Core half: when a design wants cut-outs, where they come from, how the people
 * are set on the design, and what the requester is told.
 */

// A 1 x 1 PNG: the pixels are the service's business; these tests are about sizes and bookkeeping.
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (_w: number, _h: number) => Buffer.from(ONE_PIXEL, 'base64');
const asset = (w: number, h: number): PhotoCutoutAsset => ({ png: png(4, 4), width: w, height: h, shadowPng: png(4, 4), shadowWidth: w + 20, shadowHeight: h + 20, shadowX: -8, shadowY: -8 });

const layout = (): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#0A2A6B' },
    shapes: [],
    text: [
      { x: 72, y: 150, width: 936, height: 240, copyIndex: 0, role: 'title', fontSize: 90, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
      { x: 72, y: 640, width: 800, height: 90, copyIndex: 1, role: 'date', fontSize: 36, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
    ],
    logo: { x: 880, y: 1180, width: 128, height: 128 },
    photos: [
      { x: 72, y: 820, width: 300, height: 400, photoIndex: 0, role: 'portrait', radius: 24, treatment: 'cutout' },
      { x: 400, y: 820, width: 300, height: 400, photoIndex: 1, role: 'portrait', treatment: 'cutout' },
    ],
  }) as unknown as StudioLayoutV2;

describe('which requests want people cut out', () => {
  it('reads the words people and briefs use for it, and not ordinary ones', () => {
    for (const yes of [
      'The panelists photos need to be a cutout of them',
      'photos need to be a cut-out of the person',
      'remove the background of the photos',
      'put them without background like green screen',
      'paired cutout portraits anchored at the bottom left',
      'portraits with backgrounds removed',
    ])
      expect(CUTOUT_WORDS.test(yes), yes).toBe(true);
    for (const no of ['make the background navy', 'change the background colour', 'move the logo', 'the photos should be bigger'])
      expect(CUTOUT_WORDS.test(no), no).toBe(false);
  });
});

describe('people are set as a designer sets them', () => {
  it('stand on the bottom edge, heads the same size, side by side, clear of the text', () => {
    const faces = [{ photoIndex: 0, passed: true, faceHeight: 150 }, { photoIndex: 1, passed: true, faceHeight: 100 }];
    const out = arrangeCutouts(layout(), [asset(600, 900), asset(500, 800)], faces);
    const [a, b] = out.photos!;
    expect(a.y + a.height).toBe(1350);
    expect(b.y + b.height).toBe(1350);
    // Heads matched: placed face height = box height * face / cut-out height.
    const headA = (a.height * 150) / 900;
    const headB = (b.height * 100) / 800;
    expect(Math.abs(headA - headB)).toBeLessThan(2);
    // Box fitted to the person.
    expect(Math.abs(a.width / a.height - 600 / 900)).toBeLessThan(0.01);
    // Overlap at most a fifth of the narrower person.
    const overlap = a.x + a.width - b.x;
    expect(overlap).toBeLessThanOrEqual(0.2 * Math.min(a.width, b.width) + 1);
    // Clear of the date above (bottom 730) with a gap.
    expect(Math.min(a.y, b.y)).toBeGreaterThanOrEqual(730);
    expect(a.radius).toBeUndefined();
  });

  it('a photo whose cut-out failed is shown framed and keeps its box', () => {
    const before = layout();
    const out = arrangeCutouts(before, [asset(600, 900), undefined], []);
    expect(out.photos![1]).toMatchObject({ treatment: 'framed', x: 400, y: 820, width: 300, height: 400 });
    expect(out.photos![0].treatment).toBe('cutout');
  });
});

describe('the edit and the layout are told what cut-outs exist', () => {
  it('lets the edit show a person cut out when their cut-out passed, and names why not when it failed', () => {
    const means = editMeans({ photoCutouts: [asset(10, 10), undefined], cutoutOutcomes: [{ photoIndex: 0, passed: true }, { photoIndex: 1, passed: false, reason: reasonFor(['head_not_cut']) }] });
    expect(means).toContain('CAN: show the person in photo 0 cut out of the photo');
    expect(means).toContain('cut out photo 1 (the top of the head is cut off in the photo)');
    expect(means).not.toContain('cut a person out,');
    // No cut-outs made: the means are as before.
    expect(editMeans({})).toContain('cut a person out');
  });

  it('tells the layout model to stand cut-out people in the lower part', () => {
    const line = photosBrief([{ dataUrl: '', bytes: Buffer.alloc(0), mimeType: 'image/jpeg', width: 800, height: 1200 }], 1080, 1350, [asset(10, 10)]);
    expect(line).toContain('Photos 0 are people cut out of their backgrounds');
    expect(photosBrief([{ dataUrl: '', bytes: Buffer.alloc(0), mimeType: 'image/jpeg' }], 1080, 1350)).not.toContain('cut out');
  });
});

describe('the requester is told what became of their photos', () => {
  it('says the people were cut out, or which photo could not be and why', () => {
    const run = (cutouts: unknown[], treatments: string[]) => ({
      winner_candidate_id: 'w',
      stages: { brief: { photosSent: 2, imageRoles: [{ role: 'style_reference', notes: 'paired cutout portraits' }] }, cutouts },
    });
    const cand = (treatments: string[]) => [{ id: 'w', layouts: [{ photos: treatments.map((t, i) => ({ photoIndex: i, treatment: t })) }] }];
    expect(requesterDraftNotes({ run: run([{ photoIndex: 0, passed: true }, { photoIndex: 1, passed: true }], []), candidates: cand(['cutout', 'cutout']) })).toEqual([
      'Your 2 photos are on the design, the people cut out of their backgrounds.',
      'Image 1 — style reference (not placed as a content photo): paired cutout portraits',
      'Styled after the reference design you sent.',
    ]);
    const mixed = requesterDraftNotes({ run: run([{ photoIndex: 0, passed: true }, { photoIndex: 1, passed: false, reason: 'the top of the head is cut off in the photo' }], []), candidates: cand(['cutout', 'framed']) });
    expect(mixed).toContain('⚠️ Photo 2 could not be cut out cleanly (the top of the head is cut off in the photo), so it is shown as you sent it.');
    expect(mixed.join(' ')).not.toContain('cannot be made automatically yet');
  });
});

describe('a framed photo is cropped around its faces', () => {
  const photo = (tag: string) => ({ dataUrl: '', bytes: Buffer.from(`photo ${tag}`), mimeType: 'image/jpeg' as const });
  const faces = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('asks the service where the faces are in each photo, and keeps the point inside the photo', async () => {
    const replies = [faces({ ok: true, orientation: 1, focus: { x: 0.42, y: 0.18 } }), faces({ ok: true, focus: { x: 1.2, y: -0.1 } })];
    const fetcher = vi.fn(async () => replies.shift()!);
    const out = await new PhotoCutouts({ url: 'http://cutout:8090/', fetcher: fetcher as unknown as typeof fetch }).focusFor([photo('a'), photo('b')]);
    // ADR-123: each point names the photo it was found in; a service that reports no runtime adds none.
    const source = (tag: string) => createHash('sha256').update(`photo ${tag}`).digest('hex');
    expect(out).toEqual([{ x: 0.42, y: 0.18, derivation: { sourceSha256: source('a') } }, { x: 1, y: 0, derivation: { sourceSha256: source('b') } }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe('http://cutout:8090/v1/faces');
  });

  it('crops from the centre, as before, a photo stored on its side, one it could not read, or all when it is down', async () => {
    const replies = [faces({ ok: true, orientation: 6, focus: { x: 0.5, y: 0.2 } }), faces({ ok: false, error: 'not a picture' }, 400)];
    const answered = await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: vi.fn(async () => replies.shift()!) as unknown as typeof fetch }).focusFor([photo('a'), photo('b')]);
    expect(answered).toEqual([undefined, undefined]);
    const down = await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }).focusFor([photo('a')]);
    expect(down).toEqual([undefined]);
    const never = vi.fn();
    expect(await new PhotoCutouts({ url: '', fetcher: never as unknown as typeof fetch }).focusFor([photo('a')])).toEqual([undefined]);
    expect(never).not.toHaveBeenCalled();
  });

  it('keeps the crop through an edit that did not change it', () => {
    const parent = layout();
    parent.photos = [{ ...parent.photos![0], treatment: undefined, focus: { x: 0.4, y: 0.2 } }];
    const edited = layout();
    edited.photos = [{ ...edited.photos![0], treatment: undefined }];
    expect(carryOver(parent, edited).photos?.[0].focus).toEqual({ x: 0.4, y: 0.2 });
  });
});

// As the application role, not the owner: the owner is the test server's superuser and passes every
// row policy, so a tenant check made as it proves nothing (it did not, 2026-09-23).
const url = process.env.HAWA_ISOLATED_RUNTIME_DB;

describe.skipIf(!url)('cut-outs are made once and kept (PostgreSQL, application role)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const tx = <T>(fn: (trx: any) => Promise<T>) => withRlsContext(db, { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, fn);
  afterAll(() => db.destroy());

  const reply = (passed: boolean) => ({
    ok: true,
    passed,
    png: png(30, 60).toString('base64'),
    width: 30,
    height: 60,
    bbox: [10, 5, 30, 60],
    shadow: { png: png(40, 70).toString('base64'), width: 40, height: 70, x: -5, y: -4 },
    faces: [{ x: 20, y: 10, width: 12, height: 14, alpha: 0.99 }],
    gates: { person_found: { ok: passed, hard: true }, head_not_cut: { ok: passed, hard: true } },
    stats: { people: 1 },
    timings: { matte: 9.1 },
    model: 'BiRefNet-portrait-epoch_150.onnx',
    modelSha256: '1'.repeat(64),
  });

  it('asks the service once per photo, stores the result, and reads it back after', async () => {
    const photo = { dataUrl: '', bytes: Buffer.from(`photo ${randomUUID()}`), mimeType: 'image/jpeg' as const };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(reply(true)), { status: 200 }));
    const cutouts = new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as unknown as typeof fetch });
    const first = await cutouts.forPhotos(tx, tenantId, [photo]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.outcomes).toMatchObject([{ photoIndex: 0, passed: true, people: 1, faceHeight: 14, derivation: { modelSha256: '1'.repeat(64) } }]);
    expect(first.assets[0]).toMatchObject({ width: 30, height: 60, shadowWidth: 40, shadowX: -5, shadowY: -4 });
    const again = await cutouts.forPhotos(tx, tenantId, [photo]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(again.assets[0]?.png.equals(first.assets[0]!.png)).toBe(true);
    expect(again.outcomes).toEqual(first.outcomes);
  });

  it('writes the cut-out and its shadow to the file store too, and reads them back from it (ADR-035)', async () => {
    const store = blobStoreFromEnv(db);
    // A cut-out distinct from the other tests': two different one-pixel PNGs.
    const person = Buffer.from(ONE_PIXEL, 'base64');
    const shadow = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpFrAAABJQC97kY5HgAAAABJRU5ErkJggg==',
      'base64'
    );
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ...reply(true), png: person.toString('base64'), shadow: { png: shadow.toString('base64'), width: 1, height: 1, x: 0, y: 0 } }), { status: 200 })
    );
    const photo = { dataUrl: '', bytes: Buffer.from(`photo ${randomUUID()}`), mimeType: 'image/jpeg' as const };
    const cutouts = new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as unknown as typeof fetch, blobStore: store });
    await cutouts.forPhotos(tx, tenantId, [photo]);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const source = createHash('sha256').update(photo.bytes).digest('hex');
    const row = await tx(async (trx) =>
      (await sql<{ png_sha256: string; shadow_sha256: string; has_png: boolean }>`SELECT png_sha256, shadow_sha256, png IS NOT NULL AS has_png
        FROM hawa.photo_cutouts WHERE source_sha256 = ${source}`.execute(trx)).rows[0]
    );
    expect(row).toEqual({ png_sha256: sha(person), shadow_sha256: sha(shadow), has_png: true });
    expect((await store.read(sha(person), { verify: true })).equals(person)).toBe(true);
    expect((await store.read(sha(shadow), { verify: true })).equals(shadow)).toBe(true);
    const again = await cutouts.forPhotos(tx, tenantId, [photo]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(again.assets[0]?.png.equals(person)).toBe(true);
    expect(again.assets[0]?.shadowPng?.equals(shadow)).toBe(true);
  });

  it('keeps a failed cut-out with why, and never places it', async () => {
    const photo = { dataUrl: '', bytes: Buffer.from(`photo ${randomUUID()}`), mimeType: 'image/jpeg' as const };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(reply(false)), { status: 200 }));
    const out = await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as unknown as typeof fetch }).forPhotos(tx, tenantId, [photo]);
    expect(out.assets[0]).toBeUndefined();
    expect(out.outcomes[0]).toMatchObject({ passed: false, reason: 'no person could be found in the photo' });
    const row = await tx(async (trx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.photo_cutouts WHERE passed = false`.execute(trx)).rows[0]);
    expect(row.n).toBeGreaterThan(0);
  });

  it('with the service down, says so and makes nothing, and asks no further photo', async () => {
    const photos = [0, 1].map(() => ({ dataUrl: '', bytes: Buffer.from(`photo ${randomUUID()}`), mimeType: 'image/jpeg' as const }));
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const out = await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as unknown as typeof fetch }).forPhotos(tx, tenantId, photos);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out.unavailable).toMatch(/fetch failed/);
    expect(out.outcomes.map((o) => o.reason)).toEqual(['the cut-out service is not available right now', 'the cut-out service is not available right now']);
  });

  it('reads nothing of another tenant', async () => {
    const photo = { dataUrl: '', bytes: Buffer.from(`photo ${randomUUID()}`), mimeType: 'image/jpeg' as const };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(reply(true)), { status: 200 }));
    await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as unknown as typeof fetch }).forPhotos(tx, tenantId, [photo]);
    const other = <T>(fn: (trx: any) => Promise<T>) => withRlsContext(db, { tenantId: '00000000-0000-4000-a000-000000000002', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, fn);
    const none = await new PhotoCutouts({ url: 'http://cutout:8090', fetcher: vi.fn(async () => { throw new Error('should not be called'); }) as unknown as typeof fetch }).forPhotos(other, '00000000-0000-4000-a000-000000000002', [photo], { compute: false });
    expect(none.assets[0]).toBeUndefined();
  });
});
