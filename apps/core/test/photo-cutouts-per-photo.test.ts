import { describe, it, expect, vi } from 'vitest';
import { PhotoCutouts } from '../src/services/design-studio/photo-cutouts.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';

/**
 * Bug hunt 2026-09-24. PhotoCutouts.forPhotos treats ANY failure of one photo's cut as "the service is
 * down": the first error sets `unavailable`, and every later photo in the run is skipped without being
 * sent. A single photo the service refuses (400 "not a picture", or 500 for a decompression-bomb-sized
 * image) therefore costs every other photo its cut-out, and the requester is told for each of them that
 * "the cut-out service is not available right now", which is false. No database: `tx` is a stub (no
 * stored rows, inserts ignored).
 */
const tx = (async () => undefined) as any;
const photo = (tag: string) => ({ bytes: Buffer.from(tag), mimeType: 'image/jpeg', width: 1200, height: 1600 }) as any;

const okReply = {
  ok: true,
  passed: true,
  png: Buffer.from('png').toString('base64'),
  width: 600,
  height: 900,
  bbox: [0, 0, 600, 900],
  faces: [{ x: 200, y: 100, width: 150, height: 180, alpha: 1 }],
  gates: {},
  stats: { people: 1 },
  model: 'BiRefNet-portrait-epoch_150.onnx',
  modelSha256: 'f'.repeat(64),
};

describe('HUNT: one bad photo poisons the cut-outs of the rest', () => {
  it('a photo the service refuses does not stop the next photo from being cut, and is not blamed on the service', async () => {
    const sent: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: any) => {
      const body = Buffer.from(init.body).toString();
      sent.push(body);
      if (body === 'broken') {
        return new Response(JSON.stringify({ ok: false, error: 'UnidentifiedImageError: cannot identify image file' }), { status: 400 });
      }
      return new Response(JSON.stringify(okReply), { status: 200 });
    });
    const cutouts = new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as any });

    const loaded = await cutouts.forPhotos(tx, '00000000-0000-4000-a000-000000000001', [photo('broken'), photo('good')], { compute: true });

    // What the requester reads about each photo.
    const notes = requesterDraftNotes({
      run: { stages: { cutouts: loaded.outcomes }, winner_candidate_id: 'w' },
      candidates: [{ id: 'w', layouts: [{ photos: [{ photoIndex: 0, treatment: 'framed' }, { photoIndex: 1, treatment: 'framed' }] }] }],
    } as any);

    expect({
      photosSentToService: sent,
      secondPhotoCut: Boolean(loaded.assets[1]),
      notesBlamingService: notes.filter((n) => /not available right now/.test(n)).length,
    }).toEqual({ photosSentToService: ['broken', 'good'], secondPhotoCut: true, notesBlamingService: 0 });
  });

  // 2026-09-24 fix: each refused photo gets its own reason; only a 503 (the model loading) or no
  // answer means the service is unavailable, and then no further photo is sent.
  it('names why each refused photo was not cut, and stops only for a service that is not ready', async () => {
    const replies: Record<string, () => Response> = {
      huge: () => new Response(JSON.stringify({ ok: false, error: 'UnreadablePhoto: the photo is too large to cut out: Image size (400000000 pixels) exceeds limit of 178956970 pixels' }), { status: 400 }),
      crash: () => new Response(JSON.stringify({ ok: false, error: 'RuntimeError: onnxruntime failed' }), { status: 500 }),
      good: () => new Response(JSON.stringify(okReply), { status: 200 }),
      loading: () => new Response(JSON.stringify({ ok: false, error: 'model loading' }), { status: 503 }),
    };
    const sent: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: any) => {
      const body = Buffer.from(init.body).toString();
      sent.push(body);
      return replies[body]();
    });
    const cutouts = new PhotoCutouts({ url: 'http://cutout:8090', fetcher: fetcher as any });
    const loaded = await cutouts.forPhotos(tx, '00000000-0000-4000-a000-000000000001', ['huge', 'crash', 'good', 'loading', 'good2'].map(photo), { compute: true });
    expect(sent).toEqual(['huge', 'crash', 'good', 'loading']);
    expect(loaded.outcomes.map((o) => o.reason)).toEqual([
      'the photo is too large to cut out',
      'the cut-out failed on this photo',
      undefined,
      'the cut-out service is not available right now',
      'the cut-out service is not available right now',
    ]);
    expect(loaded.unavailable).toMatch(/503/);
  });
});
