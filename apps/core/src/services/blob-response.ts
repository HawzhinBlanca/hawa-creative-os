/**
 * Answers a request for a stored file (ADR-035 section 2.4). The route has already authorised the
 * request on the referencing row (a candidate, a pair, a task's file) under row-level security, never
 * on the hash; this only builds the response.
 *
 *   - accel mode (HAWA_BLOB_ACCEL_PREFIX set, as in production): an empty 200 with X-Accel-Redirect to
 *     nginx's internal /_blobs/ location, so nginx sends the file and Core never holds its bytes. The
 *     redirect is built from the checked hash and the extension map only.
 *   - stream mode (dev and tests): Core streams the file itself, with Content-Length, an ETag and a
 *     304 for a matching If-None-Match.
 *
 * nginx keeps Content-Type, Content-Disposition and Cache-Control from this response across the
 * redirect; its /_blobs/ location repeats the security headers (infra/docker/nginx.conf).
 */
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { parseBlobRef, type BlobRef } from '@hawa/contracts';
import type { BlobStore } from '@hawa/db';

export const IMMUTABLE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

export interface BlobResponseOptions {
  cacheControl?: string;
  /** e.g. 'inline; filename="design.png"'. */
  disposition?: string;
  /** false for a judge's link: the hash would tell a judge which arm a picture came from. */
  exposeSha?: boolean;
  /** Overrides HAWA_BLOB_ACCEL_PREFIX; an empty string forces stream mode. */
  accelPrefix?: string;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === etag);
}

export async function blobResponse(c: Context, store: BlobStore, ref: BlobRef, o: BlobResponseOptions = {}): Promise<Response> {
  const checked = parseBlobRef(ref);
  if (!checked) throw new Error('blobResponse needs a well-formed blob reference');
  const headers = new Headers({
    'Content-Type': checked.mediaType,
    'Cache-Control': o.cacheControl ?? IMMUTABLE_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  });
  if (o.disposition) headers.set('Content-Disposition', o.disposition);
  if (o.exposeSha !== false) headers.set('X-Content-SHA256', checked.sha256);

  const prefix = o.accelPrefix ?? process.env.HAWA_BLOB_ACCEL_PREFIX ?? '';
  if (prefix) {
    headers.set('X-Accel-Redirect', store.accelUri(checked, prefix));
    return new Response(null, { status: 200, headers });
  }

  // The ETag is the hash too, so a response that hides the hash has none.
  if (o.exposeSha !== false) {
    const etag = `"sha256-${checked.sha256}"`;
    headers.set('ETag', etag);
    if (etagMatches(c.req.header('If-None-Match'), etag)) {
      headers.delete('Content-Type');
      return new Response(null, { status: 304, headers });
    }
  }
  const stream = await store.open(checked);
  headers.set('Content-Length', String(checked.size));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 200, headers });
}
