import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { BlobMissingError, BlobStore, createDb, initBlobStoreDir } from '@hawa/db';
import type { BlobRef } from '@hawa/contracts';
import { blobResponse, IMMUTABLE_CACHE_CONTROL, type BlobResponseOptions } from '../src/services/blob-response.js';

/**
 * The serving helper (ADR-035 section 2.4, FILESTORE_DESIGN.md section 3): accel mode answers an
 * empty 200 with X-Accel-Redirect to nginx's internal location, stream mode sends the bytes with an
 * ETag and a 304. Routes (which authorise on the referencing row) come in a later part of 3.1.
 */
const appUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!appUrl)('blobResponse', () => {
  const db = createDb(appUrl!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-response-test-'));
  const store = new BlobStore({ root, db });
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(4000)]);
  let ref: BlobRef;

  const serve = (target: BlobRef, o: BlobResponseOptions = {}) => {
    const app = new Hono();
    app.get('/file', (c) => blobResponse(c, store, target, o));
    return app;
  };

  beforeAll(async () => {
    await initBlobStoreDir(root);
    ref = await store.put(bytes, 'image/png');
  });
  afterAll(async () => {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accel mode: an empty 200 that sends nginx to the internal location, with the file headers', async () => {
    const res = await serve(ref, { accelPrefix: '/_blobs/' }).request('/file');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Accel-Redirect')).toBe(`/_blobs/sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}.png`);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Content-SHA256')).toBe(ref.sha256);
    expect(res.headers.get('Content-Length')).toBeNull();
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('accel mode follows HAWA_BLOB_ACCEL_PREFIX, and a judge link hides the hash', async () => {
    const before = process.env.HAWA_BLOB_ACCEL_PREFIX;
    process.env.HAWA_BLOB_ACCEL_PREFIX = '/_blobs/';
    try {
      const res = await serve(ref, { exposeSha: false, cacheControl: 'private, max-age=3600', disposition: 'inline; filename="design.png"' }).request('/file');
      expect(res.headers.get('X-Accel-Redirect')).toMatch(/^\/_blobs\/sha256\//);
      expect(res.headers.get('X-Content-SHA256')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
      expect(res.headers.get('Content-Disposition')).toBe('inline; filename="design.png"');
    } finally {
      if (before === undefined) delete process.env.HAWA_BLOB_ACCEL_PREFIX;
      else process.env.HAWA_BLOB_ACCEL_PREFIX = before;
    }
  });

  it('stream mode: the same bytes, their length, an ETag, and 304 for a matching If-None-Match', async () => {
    const app = serve(ref, { accelPrefix: '' });
    const res = await app.request('/file');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Accel-Redirect')).toBeNull();
    expect(res.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(res.headers.get('ETag')).toBe(`"sha256-${ref.sha256}"`);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-SHA256')).toBe(ref.sha256);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

    for (const inm of [`"sha256-${ref.sha256}"`, `W/"sha256-${ref.sha256}"`, `"other", "sha256-${ref.sha256}"`]) {
      const cached = await app.request('/file', { headers: { 'If-None-Match': inm } });
      expect(cached.status).toBe(304);
      expect((await cached.arrayBuffer()).byteLength).toBe(0);
      expect(cached.headers.get('ETag')).toBe(`"sha256-${ref.sha256}"`);
    }
    const stale = await app.request('/file', { headers: { 'If-None-Match': '"sha256-0000"' } });
    expect(stale.status).toBe(200);
  });

  it('refuses a malformed reference before building any header, and reports a missing file in stream mode', async () => {
    const bad = { sha256: '../../etc/passwd', mediaType: 'image/png', size: 10 } as BlobRef;
    expect((await serve(bad, { accelPrefix: '/_blobs/' }).request('/file')).status).toBe(500);
    const gone = { sha256: 'a'.repeat(64), mediaType: 'image/png' as const, size: 10 };
    const app = new Hono();
    app.get('/file', async (c) => {
      try {
        return await blobResponse(c, store, gone, { accelPrefix: '' });
      } catch (error) {
        return c.text(error instanceof BlobMissingError ? 'missing' : 'other', 404);
      }
    });
    const res = await app.request('/file');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('missing');
  });
});
