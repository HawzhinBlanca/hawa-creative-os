/**
 * The content-addressed file store (ADR-035, architecture programme 3.1).
 *
 * A picture or a design source is written once, to `<root>/sha256/<first two hex>/<hex>.<ext>`, and
 * recorded in hawa.blobs; rows and payloads carry its hash. Files never change: the same bytes always
 * land at the same name, so a second put of the same bytes finds the file and only makes sure the row
 * exists. On disk:
 *
 *   <root>/.hawa-blob-store       marker; without it nothing is written (a missed bind mount would
 *                                 otherwise fill an empty directory inside the container)
 *   <root>/sha256/ab/<hex>.<ext>  files 0444, directories 0755
 *   <root>/tmp/<hex>.<rand>.part  writes in progress, on the same filesystem so the rename is atomic
 *
 * The one invariant the garbage collector and the backups rely on: when a hawa.blobs row commits, its
 * file exists. put() writes and fsyncs the file before its transaction, inserts the row and renames
 * the file into place inside it, and fsyncs the directory before the commit. A rename followed by a
 * rollback leaves a file without a row, which the collector's orphan sweep removes after the grace.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import {
  BLOB_MAX_BYTES,
  blobRelPath,
  isBlobMediaType,
  isSha256Hex,
  sniffBlobMediaType,
  type BlobMediaType,
  type BlobRef,
} from '@hawa/contracts';
import type { Database } from '../types.js';

export const BLOB_STORE_MARKER = '.hawa-blob-store';
export const BLOB_STORE_MARKER_CONTENT = 'sha256-v1\n';
const FILE_MODE = 0o444;
const DIR_MODE = 0o755;

export class BlobMissingError extends Error {
  constructor(readonly sha256: string, detail = 'no file') {
    super(`Blob ${sha256.slice(0, 12)}… is missing: ${detail}`);
    this.name = 'BlobMissingError';
  }
}
export class BlobCorruptError extends Error {
  constructor(readonly sha256: string, detail: string) {
    super(`Blob ${sha256.slice(0, 12)}… is corrupt: ${detail}`);
    this.name = 'BlobCorruptError';
  }
}
export class BlobMediaTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobMediaTypeError';
  }
}

/** A file handle as put() uses it; node's FileHandle is one. */
export interface BlobFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The file operations the store makes, so a test can inject faults and watch their order. */
export interface BlobFs {
  open(file: string, flags: string, mode?: number): Promise<BlobFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  mkdir(dir: string, mode: number): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  stat(file: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
  readFile(file: string): Promise<Buffer>;
  readdir(dir: string): Promise<string[]>;
  createReadStream(file: string): fs.ReadStream;
}
export const nodeBlobFs: BlobFs = {
  open: (file, flags, mode) => fsp.open(file, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (file) => fsp.unlink(file),
  mkdir: async (dir, mode) => {
    await fsp.mkdir(dir, { mode });
  },
  chmod: (file, mode) => fsp.chmod(file, mode),
  stat: (file) => fsp.stat(file),
  readFile: (file) => fsp.readFile(file),
  readdir: (dir) => fsp.readdir(dir),
  createReadStream: (file) => fs.createReadStream(file),
};

export interface BlobStat extends BlobRef {
  createdAt: Date;
  unreferencedSince: Date | null;
  path: string;
  onDisk: boolean;
}

export interface BlobStoreOptions {
  root: string;
  db: Kysely<Database>;
  /** Off only in tests (HAWA_BLOB_FSYNC=off under NODE_ENV=test): fsync is most of a put's time. */
  fsync?: boolean;
  fs?: BlobFs;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Creates the store's directories and marker; what deploy.sh does on the host, for tests and dev. */
export async function initBlobStoreDir(root: string): Promise<void> {
  await fsp.mkdir(path.join(root, 'sha256'), { recursive: true, mode: DIR_MODE });
  await fsp.mkdir(path.join(root, 'tmp'), { recursive: true, mode: DIR_MODE });
  const marker = path.join(root, BLOB_STORE_MARKER);
  try {
    await fsp.writeFile(marker, BLOB_STORE_MARKER_CONTENT, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export class BlobStore {
  readonly root: string;
  private readonly db: Kysely<Database>;
  private readonly fsync: boolean;
  private readonly fs: BlobFs;
  private markerSeen = false;

  constructor(opts: BlobStoreOptions) {
    if (!opts.root || !path.isAbsolute(opts.root)) throw new Error('The blob store root must be an absolute path');
    this.root = opts.root;
    this.db = opts.db;
    this.fsync = opts.fsync ?? true;
    this.fs = opts.fs ?? nodeBlobFs;
  }

  /** The absolute path of a file in this container. */
  pathOf(ref: Pick<BlobRef, 'sha256' | 'mediaType'>): string {
    return path.join(this.root, blobRelPath(ref));
  }

  /** The internal nginx location of a file ('/_blobs/sha256/ab/<hex>.png'), for X-Accel-Redirect. */
  accelUri(ref: Pick<BlobRef, 'sha256' | 'mediaType'>, prefix = '/_blobs/'): string {
    if (!/^\/[A-Za-z0-9_\-/]*\/$/.test(prefix) || prefix.includes('//')) throw new Error(`Not an accel prefix: ${prefix}`);
    return `${prefix}${blobRelPath(ref)}`;
  }

  /** Throws unless the marker is there: the directory is the store, not an empty mount point. */
  async assertReady(): Promise<void> {
    if (this.markerSeen) return;
    try {
      const marker = await this.fs.readFile(path.join(this.root, BLOB_STORE_MARKER));
      if (marker.toString('utf8').trim() !== BLOB_STORE_MARKER_CONTENT.trim()) throw new Error('unexpected marker content');
    } catch (error) {
      throw new Error(`${this.root} is not a blob store (${BLOB_STORE_MARKER} ${isNotFound(error) ? 'is missing' : 'is unreadable'}); refusing to use it. deploy.sh creates it.`);
    }
    this.markerSeen = true;
  }

  async put(bytes: Uint8Array, mediaType: BlobMediaType, opts: { trx?: Kysely<Database> } = {}): Promise<BlobRef> {
    if (!isBlobMediaType(mediaType)) throw new BlobMediaTypeError(`Not a blob media type: ${String(mediaType)}`);
    if (bytes.byteLength < 1 || bytes.byteLength > BLOB_MAX_BYTES) {
      throw new Error(`A blob must be between 1 and ${BLOB_MAX_BYTES} bytes (got ${bytes.byteLength})`);
    }
    const sniffed = sniffBlobMediaType(bytes);
    if (sniffed !== mediaType) {
      throw new BlobMediaTypeError(`The bytes are ${sniffed ?? 'of no type the store knows'}, not ${mediaType}`);
    }
    await this.assertReady();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref: BlobRef = { sha256, mediaType, size: bytes.byteLength };
    const finalPath = this.pathOf(ref);
    let tmp: string | undefined;
    try {
      // The slow part, outside any transaction: write, fsync, close. Skipped when the file is already
      // there, which is most puts of a picture sent again.
      if ((await this.sizeOnDisk(finalPath)) !== ref.size) tmp = await this.writeTemp(bytes, sha256);
      const place = async (trx: Kysely<Database>) => {
        await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`hawa.blob:${sha256}`}, 0))`.execute(trx);
        const inserted = await sql<{ media_type: string; size: string }>`
          INSERT INTO hawa.blobs (sha256, size, media_type) VALUES (${sha256}, ${ref.size}, ${mediaType})
          ON CONFLICT (sha256) DO UPDATE SET unreferenced_since = NULL WHERE hawa.blobs.unreferenced_since IS NOT NULL
          RETURNING media_type, size`.execute(trx);
        const row = inserted.rows[0]
          ?? (await sql<{ media_type: string; size: string }>`SELECT media_type, size FROM hawa.blobs WHERE sha256 = ${sha256}`.execute(trx)).rows[0];
        if (!row) throw new Error(`Blob ${sha256.slice(0, 12)}… has no row after its insert`);
        if (row.media_type !== mediaType) {
          throw new BlobMediaTypeError(`Blob ${sha256.slice(0, 12)}… is stored as ${row.media_type}, not ${mediaType}`);
        }
        if (Number(row.size) !== ref.size) throw new BlobCorruptError(sha256, `its row says ${row.size} bytes, the bytes are ${ref.size}`);
        // Under the lock the collector cannot be unlinking this file. If it did so after the check
        // above, the bytes are written now.
        if ((await this.sizeOnDisk(finalPath)) !== ref.size) {
          if (!tmp) tmp = await this.writeTemp(bytes, sha256);
          await this.ensureShard(path.dirname(finalPath));
          await this.fs.rename(tmp, finalPath);
          tmp = undefined;
          await this.syncDir(path.dirname(finalPath));
        }
      };
      if (opts.trx) await place(opts.trx);
      else await this.db.transaction().execute(place);
      return ref;
    } finally {
      // An existing target means the same bytes: the temporary copy goes. So does one left by an error.
      if (tmp) await this.fs.unlink(tmp).catch(() => {});
    }
  }

  /** The bytes, with the size always checked and the hash checked when `verify` is set. */
  async read(ref: BlobRef | string, opts: { verify?: boolean } = {}): Promise<Buffer> {
    const resolved = typeof ref === 'string' ? await this.refOf(ref) : ref;
    let bytes: Buffer;
    try {
      bytes = await this.fs.readFile(this.pathOf(resolved));
    } catch (error) {
      if (isNotFound(error)) throw new BlobMissingError(resolved.sha256);
      throw error;
    }
    if (bytes.length !== resolved.size) throw new BlobCorruptError(resolved.sha256, `${bytes.length} bytes on disk, ${resolved.size} expected`);
    if (opts.verify) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== resolved.sha256) throw new BlobCorruptError(resolved.sha256, `its bytes hash to ${actual.slice(0, 12)}…`);
    }
    return bytes;
  }

  /** A stream of the file, for Core's stream mode; the size is checked before it opens. */
  async open(ref: BlobRef): Promise<fs.ReadStream> {
    const file = this.pathOf(ref);
    const size = await this.sizeOnDisk(file);
    if (size === undefined) throw new BlobMissingError(ref.sha256);
    if (size !== ref.size) throw new BlobCorruptError(ref.sha256, `${size} bytes on disk, ${ref.size} expected`);
    return this.fs.createReadStream(file);
  }

  async stat(sha256: string): Promise<BlobStat | null> {
    if (!isSha256Hex(sha256)) return null;
    const row = (await sql<{ size: string; media_type: string; created_at: Date; unreferenced_since: Date | null }>`
      SELECT size, media_type, created_at, unreferenced_since FROM hawa.blobs WHERE sha256 = ${sha256}`.execute(this.db)).rows[0];
    if (!row || !isBlobMediaType(row.media_type)) return null;
    const ref: BlobRef = { sha256, mediaType: row.media_type, size: Number(row.size) };
    const file = this.pathOf(ref);
    return {
      ...ref,
      createdAt: row.created_at,
      unreferencedSince: row.unreferenced_since,
      path: file,
      onDisk: (await this.sizeOnDisk(file)) === ref.size,
    };
  }

  private async refOf(sha256: string): Promise<BlobRef> {
    const found = await this.stat(sha256);
    if (!found) throw new BlobMissingError(isSha256Hex(sha256) ? sha256 : '(not a hash)', 'no row');
    return { sha256: found.sha256, mediaType: found.mediaType, size: found.size };
  }

  private async sizeOnDisk(file: string): Promise<number | undefined> {
    try {
      const s = await this.fs.stat(file);
      return s.isFile() ? s.size : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async writeTemp(bytes: Uint8Array, sha256: string): Promise<string> {
    const tmpDir = path.join(this.root, 'tmp');
    await this.fs.mkdir(tmpDir, DIR_MODE).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const tmp = path.join(tmpDir, `${sha256}.${randomBytes(6).toString('hex')}.part`);
    const handle = await this.fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      if (this.fsync) await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await this.fs.unlink(tmp).catch(() => {});
      throw error;
    }
    try {
      await handle.close();
      await this.fs.chmod(tmp, FILE_MODE);
    } catch (error) {
      await this.fs.unlink(tmp).catch(() => {});
      throw error;
    }
    return tmp;
  }

  /** The shard directory exists; a new one is made durable in its parent before any rename into it. */
  private async ensureShard(shard: string): Promise<void> {
    try {
      await this.fs.mkdir(shard, DIR_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.fs.mkdir(path.dirname(shard), DIR_MODE).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await this.fs.mkdir(shard, DIR_MODE).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    await this.syncDir(path.dirname(shard));
  }

  private async syncDir(dir: string): Promise<void> {
    if (!this.fsync) return;
    const handle = await this.fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/**
 * The store the process is configured for: HAWA_BLOB_DIR is required (there is no default directory),
 * and fsync can be turned off only by a test run.
 */
export function blobStoreFromEnv(db: Kysely<Database>, env: NodeJS.ProcessEnv = process.env): BlobStore {
  const root = env.HAWA_BLOB_DIR;
  if (!root) throw new Error('HAWA_BLOB_DIR is not set; the blob store has no default directory');
  const fsync = !(env.NODE_ENV === 'test' && env.HAWA_BLOB_FSYNC === 'off');
  return new BlobStore({ root: path.resolve(root), db, fsync });
}
