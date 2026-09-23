import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import { cutoutPlacement, type PhotoCutoutAsset, type StudioLayoutV2 } from '@hawa/creative';
import type { ContentPhoto } from './types.js';

/**
 * People cut out of the client's photos (ADR-032), made by the cut-out service (services/cutout) and
 * kept in hawa.photo_cutouts, so the same photo is cut once. A cut-out that failed the service's
 * checks is kept too, with why, so it is not retried on every stage and the requester can be told.
 */

/** What became of one photo's cut-out. */
export interface CutoutOutcome {
  photoIndex: number;
  passed: boolean;
  /** Plain words for the requester when it did not pass. */
  reason?: string;
  failed?: string[];
  people?: number;
  /** Height of the largest face inside the cut-out, in the cut-out's pixels: heads are matched by it. */
  faceHeight?: number;
}

export interface LoadedCutouts {
  /** By photoIndex; present only for a cut-out that passed. */
  assets: Array<PhotoCutoutAsset | undefined>;
  outcomes: CutoutOutcome[];
  /** Why no cut-out could be made at all (the service down), when that is the case. */
  unavailable?: string;
}

type Tx = <T>(fn: (db: Kysely<Database>) => Promise<T>) => Promise<T>;

interface ServiceReply {
  ok: boolean;
  passed: boolean;
  png: string;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  shadow?: { png: string; width: number; height: number; x: number; y: number };
  faces?: Array<{ x: number; y: number; width: number; height: number; alpha?: number }>;
  gates?: Record<string, { ok: boolean; hard: boolean; value?: unknown; limit?: string }>;
  stats?: Record<string, unknown>;
  timings?: Record<string, number>;
  model: string;
  modelSha256: string;
  error?: string;
}

interface StoredRow {
  passed: boolean;
  png: Buffer;
  width: number;
  height: number;
  shadow_png: Buffer | null;
  shadow: { width: number; height: number; x: number; y: number } | null;
  report: { failed?: string[]; people?: number; faceHeight?: number } | null;
}

/** The requester's words for each check a cut-out can fail. */
const FAILED_IN_WORDS: Record<string, string> = {
  person_found: 'no person could be found in the photo',
  faces_whole: 'part of the face would have been lost',
  area: 'the person is too small in the photo, or fills all of it',
  pieces: 'the person came out in pieces',
  haze: 'the edges could not be separated cleanly from the background',
  head_not_cut: 'the top of the head is cut off in the photo',
  resolution: 'the photo is too small to cut out cleanly',
  people_expected: 'not everyone in the photo could be found',
};

export function reasonFor(failed: string[]): string {
  const words = failed.map((f) => FAILED_IN_WORDS[f]).filter(Boolean);
  return words.length ? words[0] : 'the cut-out did not pass its checks';
}

/** Words in a request or a brief that ask for people cut out of their photos. */
export const CUTOUT_WORDS =
  /cut[\s-]?outs?\b|cutting (?:them |the people |the persons? )?out|(?:remove|removing|without|no|drop|take off|delete)\s+(?:the\s+|their\s+|its\s+|a\s+)?(?:photo'?s?\s+)?backgrounds?|backgrounds?\s+removed|green[\s-]?screen|transparent background|isolated (?:figures|portraits|people|persons)|png (?:people|portraits)/i;

export class PhotoCutouts {
  private readonly url: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { url?: string; fetcher?: typeof fetch; timeoutMs?: number } = {}) {
    this.url = (options.url ?? process.env.CUTOUT_URL ?? '').replace(/\/+$/, '') || undefined;
    this.fetcher = options.fetcher ?? fetch;
    // A cut takes about 10 s in the office VM, one at a time: a run with several photos, or another
    // run's photos ahead in the queue, waits for them.
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CUTOUT_TIMEOUT_MS || 240000);
  }

  get configured(): boolean {
    return Boolean(this.url);
  }

  /** Whether the service answers and has its model loaded. */
  async health(): Promise<'connected' | 'loading' | 'unreachable' | 'unconfigured'> {
    if (!this.url) return 'unconfigured';
    try {
      const res = await this.fetcher(`${this.url}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return 'connected';
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return body.status === 'loading' ? 'loading' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  /**
   * The cut-out of every photo, from the store or, when `compute` is true and it is not there yet,
   * from the service. Photos are cut one after another; the service serialises anyway.
   */
  async forPhotos(tx: Tx, tenantId: string, photos: ContentPhoto[], options: { compute: boolean } = { compute: true }): Promise<LoadedCutouts> {
    const assets: Array<PhotoCutoutAsset | undefined> = [];
    const outcomes: CutoutOutcome[] = [];
    let unavailable: string | undefined;
    for (let photoIndex = 0; photoIndex < photos.length; photoIndex++) {
      const photo = photos[photoIndex];
      const sourceSha256 = createHash('sha256').update(photo.bytes).digest('hex');
      let row = await this.stored(tx, sourceSha256);
      if (!row && options.compute && !unavailable) {
        try {
          row = await this.make(tx, tenantId, photo, sourceSha256);
        } catch (err) {
          unavailable = (err as Error)?.message || String(err);
          console.warn(`[cutouts] photo ${photoIndex} could not be cut out: ${unavailable}`);
        }
      }
      if (!row) {
        outcomes.push({ photoIndex, passed: false, reason: unavailable ? 'the cut-out service is not available right now' : 'no cut-out has been made yet' });
        assets.push(undefined);
        continue;
      }
      const failed = row.report?.failed ?? [];
      outcomes.push({
        photoIndex,
        passed: row.passed,
        ...(row.passed ? {} : { reason: reasonFor(failed), failed }),
        ...(typeof row.report?.people === 'number' ? { people: row.report.people } : {}),
        ...(typeof row.report?.faceHeight === 'number' ? { faceHeight: row.report.faceHeight } : {}),
      });
      assets.push(
        row.passed
          ? {
              png: row.png,
              width: row.width,
              height: row.height,
              ...(row.shadow_png && row.shadow
                ? { shadowPng: row.shadow_png, shadowWidth: row.shadow.width, shadowHeight: row.shadow.height, shadowX: row.shadow.x, shadowY: row.shadow.y }
                : {}),
            }
          : undefined
      );
    }
    return { assets, outcomes, ...(unavailable ? { unavailable } : {}) };
  }

  /**
   * Where the people are in each photo, as a focus point (0..1 of the photo) for cropping it into a
   * frame without cutting heads: face detection only, milliseconds a photo. Undefined for a photo the
   * service could not read, or every photo when it is not configured or not answering: those are
   * cropped from the centre, as before.
   */
  async focusFor(photos: ContentPhoto[]): Promise<Array<{ x: number; y: number } | undefined>> {
    if (!this.url) return photos.map(() => undefined);
    const out: Array<{ x: number; y: number } | undefined> = [];
    for (const photo of photos) {
      try {
        const res = await this.fetcher(`${this.url}/v1/faces`, {
          method: 'POST',
          headers: { 'Content-Type': photo.mimeType },
          body: new Uint8Array(photo.bytes),
          signal: AbortSignal.timeout(30000),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; orientation?: unknown; focus?: { x?: unknown; y?: unknown } };
        const x = Number(body.focus?.x);
        const y = Number(body.focus?.y);
        // The point is in the upright photo, but the crop is of the stored pixels; a photo stored on
        // its side (EXIF orientation other than 1) keeps the centred crop rather than a wrong one.
        const upright = body.orientation === undefined || body.orientation === 1;
        out.push(res.ok && body.ok && upright && Number.isFinite(x) && Number.isFinite(y) ? { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } : undefined);
      } catch {
        out.push(undefined);
      }
    }
    return out;
  }

  private async stored(tx: Tx, sourceSha256: string): Promise<StoredRow | undefined> {
    return tx(async (db) =>
      (
        await sql<StoredRow>`SELECT passed, png, width, height, shadow_png, shadow, report FROM hawa.photo_cutouts
          WHERE source_sha256 = ${sourceSha256} ORDER BY created_at DESC LIMIT 1`.execute(db)
      ).rows[0]
    );
  }

  private async make(tx: Tx, tenantId: string, photo: ContentPhoto, sourceSha256: string): Promise<StoredRow> {
    if (!this.url) throw new Error('CUTOUT_URL is not set');
    const res = await this.fetcher(`${this.url}/v1/cutout`, {
      method: 'POST',
      headers: { 'Content-Type': photo.mimeType },
      body: new Uint8Array(photo.bytes),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const reply = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as ServiceReply;
    if (!res.ok || !reply.ok) throw new Error(`cut-out service answered ${res.status}: ${reply.error || 'no detail'}`);
    const failed = Object.entries(reply.gates || {}).filter(([, g]) => g.hard && !g.ok).map(([name]) => name);
    const [x0, y0] = reply.bbox || [0, 0];
    // The people's faces in the cut-out's own pixels; the largest sets the head size that is matched.
    const inside = (reply.faces || []).filter((f) => (f.alpha ?? 1) >= 0.5).map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }));
    const faceHeight = inside.length ? Math.max(...inside.map((f) => f.height)) : undefined;
    const report = {
      failed,
      people: typeof reply.stats?.people === 'number' ? reply.stats.people : inside.length,
      ...(faceHeight ? { faceHeight } : {}),
      faces: inside,
      gates: reply.gates,
      stats: reply.stats,
      timings: reply.timings,
      bbox: reply.bbox,
    };
    const row: StoredRow = {
      passed: Boolean(reply.passed),
      png: Buffer.from(reply.png, 'base64'),
      width: reply.width,
      height: reply.height,
      shadow_png: reply.shadow ? Buffer.from(reply.shadow.png, 'base64') : null,
      shadow: reply.shadow ? { width: reply.shadow.width, height: reply.shadow.height, x: reply.shadow.x, y: reply.shadow.y } : null,
      report,
    };
    await tx(async (db) =>
      sql`INSERT INTO hawa.photo_cutouts (tenant_id, source_sha256, model, model_sha256, passed, png, width, height, shadow_png, shadow, report)
        VALUES (${tenantId}::uuid, ${sourceSha256}, ${reply.model}, ${reply.modelSha256}, ${row.passed}, ${row.png}, ${row.width}, ${row.height},
          ${row.shadow_png}, ${row.shadow ? JSON.stringify(row.shadow) : null}::jsonb, ${JSON.stringify(report)}::jsonb)
        ON CONFLICT (tenant_id, source_sha256, model_sha256) DO NOTHING`.execute(db)
    );
    console.log(`[cutouts] ${sourceSha256.slice(0, 12)}: ${row.passed ? 'passed' : `failed ${failed.join(', ')}`} (${reply.timings?.matte ?? '?'} s)`);
    return row;
  }
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * People cut out of their photos, set as an office designer sets them: standing on the bottom edge of
 * the design, heads the same size (each scaled by its largest face), side by side in the order and
 * around the places the layout gave them, overlapping a little at most, and shrunk together, heads
 * still matched, until the text and the logo above them are clear.
 *
 * Only photos with `treatment: 'cutout'` and a cut-out that passed are moved; any other photo keeps
 * its box. A photo whose cut-out failed is set back to framed here, so the renderer, the transfer and
 * the note agree on what the design shows.
 */
export function arrangeCutouts(layout: StudioLayoutV2, assets: Array<PhotoCutoutAsset | undefined>, outcomes: CutoutOutcome[] = []): StudioLayoutV2 {
  const photos = layout.photos ?? [];
  for (const p of photos) if (p.treatment === 'cutout' && !assets[p.photoIndex]) p.treatment = 'framed';
  const cut = photos.filter((p) => p.treatment === 'cutout' && assets[p.photoIndex]);
  if (!cut.length) return layout;
  const W = layout.width;
  const H = layout.height;
  const margin = Math.max(0, layout.grid?.margin ?? Math.round(Math.min(W, H) * 0.06));
  const face = (index: number) => {
    const asset = assets[index]!;
    const measured = outcomes.find((o) => o.photoIndex === index)?.faceHeight;
    // No face measured: a head is about a seventh of a waist-up portrait's height.
    return measured && measured > 0 ? measured : asset.height / 7;
  };

  // Head size: what the layout's boxes imply on average, raised so the tallest person stands at least
  // 42% of the design's height (the people are the point of such a design; the reference that asked
  // for them had them at about 40%), and no person taller than 72% of it.
  const implied = cut.map((p) => {
    const a = assets[p.photoIndex]!;
    const placed = cutoutPlacement(p, a);
    return (placed.person.height * face(p.photoIndex)) / a.height;
  });
  let head = implied.reduce((s, v) => s + v, 0) / implied.length;
  const tallestAt = (h: number) => Math.max(...cut.map((p) => (h * assets[p.photoIndex]!.height) / face(p.photoIndex)));
  if (tallestAt(head) < 0.42 * H) head = (head * 0.42 * H) / tallestAt(head);
  if (tallestAt(head) > 0.72 * H) head = (head * 0.72 * H) / tallestAt(head);

  const obstacles: Rect[] = [
    ...layout.text,
    ...(layout.logo && layout.logo.width > 0 ? [layout.logo] : []),
  ];
  const gap = Math.max(12, Math.round(Math.min(W, H) * 0.015));
  const order = [...cut].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));

  const place = (h: number) => {
    const sizes = order.map((p) => {
      const a = assets[p.photoIndex]!;
      const height = (h * a.height) / face(p.photoIndex);
      return { p, width: (height * a.width) / a.height, height };
    });
    // Side by side, overlapping by at most a fifth of the narrower person, centred where the layout
    // put the group, inside the side margins.
    const overlap = (i: number) => (i === 0 ? 0 : 0.18 * Math.min(sizes[i].width, sizes[i - 1].width));
    const total = sizes.reduce((s, v, i) => s + v.width - overlap(i), 0);
    const centre = order.reduce((s, p) => s + p.x + p.width / 2, 0) / order.length;
    let x = Math.max(margin * 0.5, Math.min(W - margin * 0.5 - total, centre - total / 2));
    return sizes.map((s, i) => {
      x -= overlap(i);
      const rect = { x: Math.round(x), y: Math.round(H - s.height), width: Math.round(s.width), height: Math.round(s.height) };
      x += s.width;
      return { p: s.p, rect };
    });
  };

  // Shrink together until nothing above the people sits on them, but never so far that the shortest
  // person drops under a third of the design's short side (the checks' least for a cut-out). What
  // still clashes then is left to settlePhotos and hard QA, which refuse it rather than hide it.
  const shortestAt = (h: number) => Math.min(...cut.map((p) => (h * assets[p.photoIndex]!.height) / face(p.photoIndex)));
  const least = Math.min(W, H) * 0.22 * 1.5;
  let placed = place(head);
  for (let i = 0; i < 16; i++) {
    const clash = placed.some(({ rect }) => obstacles.some((o) => o.x < rect.x + rect.width && o.x + o.width > rect.x && o.y + o.height + gap > rect.y && o.y < rect.y + rect.height));
    if (!clash || shortestAt(head * 0.94) < least) break;
    head *= 0.94;
    placed = place(head);
  }
  for (const { p, rect } of placed) {
    Object.assign(p, rect);
    delete p.radius;
  }
  return layout;
}
