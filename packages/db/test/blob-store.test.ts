import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import {
  BlobCorruptError,
  BlobMediaTypeError,
  BlobMissingError,
  BlobStore,
  blobStoreFromEnv,
  initBlobStoreDir,
  nodeBlobFs,
  type BlobFs,
} from '../src/blobs/store.js';

/**
 * The content-addressed file store (ADR-035, FILESTORE_DESIGN.md sections 2.2 and 7): layout and
 * modes, idempotent puts, the media-type check, the write protocol's order under injected faults,
 * and corruption detection. Each test gets its own store directory; the database is this file's own
 * clone (packages/db/test-support/test-database-clone.ts).
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 200) => Buffer.concat([PNG_SIGNATURE, randomBytes(n)]);
const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
async function freshRoot(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-store-test-'));
  dirs.push(root);
  await initBlobStoreDir(root);
  return root;
}
const tmpFiles = (root: string) => fs.readdirSync(path.join(root, 'tmp'));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe.skipIf(!appUrl || !ownerUrl)('BlobStore against PostgreSQL and a temporary directory', () => {
  const app = createDb(appUrl!);
  const owner = createDb(ownerUrl!);
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  let root: string;
  let store: BlobStore;
  beforeEach(async () => {
    root = await freshRoot();
    // The application role, as Core and the worker run it.
    store = new BlobStore({ root, db: app });
  });

  const rowOf = async (h: string) =>
    (await sql<{ size: string; media_type: string; unreferenced_since: Date | null }>`SELECT size, media_type, unreferenced_since FROM hawa.blobs WHERE sha256 = ${h}`.execute(owner)).rows[0];

  it('writes sha256/<ab>/<hex>.<ext>, files 0444 and directories 0755, and records the row', async () => {
    const bytes = png();
    const ref = await store.put(bytes, 'image/png');
    expect(ref).toEqual({ sha256: sha(bytes), mediaType: 'image/png', size: bytes.length });
    const file = path.join(root, 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.png`);
    expect(store.pathOf(ref)).toBe(file);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(mode(file)).toBe(0o444);
    expect(mode(path.dirname(file))).toBe(0o755);
    expect(mode(path.join(root, 'sha256'))).toBe(0o755);
    expect(await rowOf(ref.sha256)).toMatchObject({ size: String(bytes.length), media_type: 'image/png', unreferenced_since: null });
    expect(tmpFiles(root)).toEqual([]);
    expect(store.accelUri(ref)).toBe(`/_blobs/sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}.png`);
  });

  it('the same bytes twice give one file and one row; ten concurrent puts give one file', async () => {
    const bytes = jpeg();
    const a = await store.put(bytes, 'image/jpeg');
    const b = await store.put(bytes, 'image/jpeg');
    expect(b).toEqual(a);
    const other = png(5000);
    const refs = await Promise.all(Array.from({ length: 10 }, () => store.put(other, 'image/png')));
    expect(new Set(refs.map((r) => r.sha256)).size).toBe(1);
    const shard = path.dirname(store.pathOf(refs[0]));
    expect(fs.readdirSync(shard).filter((n) => n.startsWith(refs[0].sha256))).toEqual([`${refs[0].sha256}.png`]);
    const count = await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.blobs WHERE sha256 IN (${a.sha256}, ${refs[0].sha256})`.execute(owner);
    expect(Number(count.rows[0].n)).toBe(2);
    expect(tmpFiles(root)).toEqual([]);
  });

  it('refuses bytes whose type is not the one declared, and leaves no row, file or temporary file', async () => {
    const bytes = jpeg();
    await expect(store.put(bytes, 'image/png')).rejects.toBeInstanceOf(BlobMediaTypeError);
    await expect(store.put(randomBytes(64), 'application/pdf')).rejects.toBeInstanceOf(BlobMediaTypeError);
    await expect(store.put(bytes, 'image/svg+xml' as never)).rejects.toBeInstanceOf(BlobMediaTypeError);
    expect(await rowOf(sha(bytes))).toBeUndefined();
    expect(fs.readdirSync(path.join(root, 'sha256'))).toEqual([]);
    expect(tmpFiles(root)).toEqual([]);
    // A PDF and a PPTX are accepted by their own signatures.
    await store.put(Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(50)]), 'application/pdf');
    await store.put(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(50)]), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('refuses a directory without the store marker (an empty mount point)', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-bare-'));
    dirs.push(bare);
    const s = new BlobStore({ root: bare, db: app });
    await expect(s.put(png(), 'image/png')).rejects.toThrow(/not a blob store/);
    expect(fs.readdirSync(bare)).toEqual([]);
    expect(() => blobStoreFromEnv(app, { NODE_ENV: 'production' })).toThrow(/HAWA_BLOB_DIR is not set/);
  });

  it('writes, syncs and closes the temporary file before the rename, and syncs the directory after it', async () => {
    const calls: string[] = [];
    const rel = (p: string) => path.relative(root, p).replace(/[0-9a-f]{64}(\.[0-9a-f]{12})?/, 'H');
    const recording: BlobFs = {
      ...nodeBlobFs,
      open: async (file, flags, m) => {
        const handle = await nodeBlobFs.open(file, flags, m);
        const what = flags === 'r' ? `dir ${rel(file)}` : `file ${rel(file)}`;
        calls.push(`open ${what}`);
        return {
          writeFile: async (d) => { calls.push(`write ${what}`); await handle.writeFile(d); },
          sync: async () => { calls.push(`sync ${what}`); await handle.sync(); },
          close: async () => { calls.push(`close ${what}`); await handle.close(); },
        };
      },
      rename: async (a, b) => { calls.push(`rename ${rel(a)} -> ${rel(b)}`); await nodeBlobFs.rename(a, b); },
      chmod: async (f, m) => { calls.push(`chmod ${rel(f)} ${m.toString(8)}`); await nodeBlobFs.chmod(f, m); },
      mkdir: async (d, m) => { calls.push(`mkdir ${rel(d)}`); await nodeBlobFs.mkdir(d, m); },
    };
    const s = new BlobStore({ root, db: app, fs: recording });
    const ref = await s.put(png(), 'image/png');
    const shard = `sha256/${ref.sha256.slice(0, 2)}`;
    const writes = calls.filter((c) => !c.startsWith('mkdir tmp'));
    expect(writes).toEqual([
      'open file tmp/H.part',
      'write file tmp/H.part',
      'sync file tmp/H.part',
      'close file tmp/H.part',
      'chmod tmp/H.part 444',
      `mkdir ${shard}`,
      'open dir sha256',
      'sync dir sha256',
      'close dir sha256',
      `rename tmp/H.part -> ${shard}/H.png`,
      `open dir ${shard}`,
      `sync dir ${shard}`,
      `close dir ${shard}`,
    ]);
  });

  for (const step of ['write', 'sync', 'close', 'rename', 'dirsync'] as const) {
    it(`a failure at ${step} rejects the put, commits no row, and leaves no temporary file`, async () => {
      const boom = () => { throw Object.assign(new Error(`injected ${step} failure`), { code: 'EIO' }); };
      const faulty: BlobFs = {
        ...nodeBlobFs,
        open: async (file, flags, m) => {
          const handle = await nodeBlobFs.open(file, flags, m);
          const isDir = flags === 'r';
          return {
            writeFile: async (d) => { if (step === 'write') boom(); await handle.writeFile(d); },
            sync: async () => { if ((step === 'sync' && !isDir) || (step === 'dirsync' && isDir && file.includes(path.sep + 'sha256' + path.sep))) boom(); await handle.sync(); },
            close: async () => { await handle.close(); if (step === 'close' && !isDir) boom(); },
          };
        },
        rename: async (a, b) => { if (step === 'rename') boom(); await nodeBlobFs.rename(a, b); },
      };
      const s = new BlobStore({ root, db: app, fs: faulty });
      const bytes = png();
      await expect(s.put(bytes, 'image/png')).rejects.toThrow(`injected ${step} failure`);
      expect(await rowOf(sha(bytes))).toBeUndefined();
      expect(tmpFiles(root)).toEqual([]);
      // A later put of the same bytes works: nothing half-done is in the way.
      await store.put(bytes, 'image/png');
      expect(fs.readFileSync(store.pathOf({ sha256: sha(bytes), mediaType: 'image/png' })).equals(bytes)).toBe(true);
    });
  }

  it('reads back by reference or by hash, streams, and reports corruption and loss', async () => {
    const bytes = png(1000);
    const ref = await store.put(bytes, 'image/png');
    expect((await store.read(ref)).equals(bytes)).toBe(true);
    expect((await store.read(ref.sha256, { verify: true })).equals(bytes)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const c of await store.open(ref)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(await store.stat(ref.sha256)).toMatchObject({ sha256: ref.sha256, mediaType: 'image/png', size: bytes.length, onDisk: true, unreferencedSince: null });

    const file = store.pathOf(ref);
    fs.chmodSync(file, 0o644);
    // Same size, different bytes: only the hash check sees it.
    const flipped = Buffer.from(bytes);
    flipped[500] ^= 0xff;
    fs.writeFileSync(file, flipped);
    expect((await store.read(ref)).length).toBe(bytes.length);
    await expect(store.read(ref, { verify: true })).rejects.toBeInstanceOf(BlobCorruptError);
    // A different size is caught on every read and before a stream opens.
    fs.writeFileSync(file, bytes.subarray(0, 100));
    await expect(store.read(ref)).rejects.toBeInstanceOf(BlobCorruptError);
    await expect(store.open(ref)).rejects.toBeInstanceOf(BlobCorruptError);
    fs.unlinkSync(file);
    await expect(store.read(ref)).rejects.toBeInstanceOf(BlobMissingError);
    await expect(store.open(ref)).rejects.toBeInstanceOf(BlobMissingError);
    expect((await store.stat(ref.sha256))?.onDisk).toBe(false);
    await expect(store.read('0'.repeat(64))).rejects.toBeInstanceOf(BlobMissingError);
    // Storing the bytes again repairs the file.
    await store.put(bytes, 'image/png');
    expect((await store.read(ref, { verify: true })).equals(bytes)).toBe(true);
  });

  it("a put inside the caller's transaction commits with it; a rollback leaves only an orphan file", async () => {
    const kept = png();
    const lost = png();
    await app.transaction().execute(async (trx) => {
      await store.put(kept, 'image/png', { trx });
    });
    expect(await rowOf(sha(kept))).toBeDefined();
    await expect(app.transaction().execute(async (trx) => {
      await store.put(lost, 'image/png', { trx });
      throw new Error('caller failed');
    })).rejects.toThrow('caller failed');
    expect(await rowOf(sha(lost))).toBeUndefined();
    // The file was renamed into place before the rollback; the collector's orphan sweep removes it.
    expect(fs.existsSync(store.pathOf({ sha256: sha(lost), mediaType: 'image/png' }))).toBe(true);
  });

  it('storing a file again clears its unreferenced mark, as the application role', async () => {
    const bytes = png();
    const ref = await store.put(bytes, 'image/png');
    await sql`SELECT hawa.blob_gc_mark()`.execute(app);
    expect((await rowOf(ref.sha256))?.unreferenced_since).toBeInstanceOf(Date);
    await store.put(bytes, 'image/png');
    expect((await rowOf(ref.sha256))?.unreferenced_since).toBeNull();
  });

  it('keeps fsync on unless a test run turns it off', () => {
    const on = blobStoreFromEnv(app, { HAWA_BLOB_DIR: '/tmp/x', NODE_ENV: 'production', HAWA_BLOB_FSYNC: 'off' });
    const off = blobStoreFromEnv(app, { HAWA_BLOB_DIR: '/tmp/x', NODE_ENV: 'test', HAWA_BLOB_FSYNC: 'off' });
    expect((on as unknown as { fsync: boolean }).fsync).toBe(true);
    expect((off as unknown as { fsync: boolean }).fsync).toBe(false);
  });
});
