/**
 * The file store's garbage collector (ADR-035 section 2.3): mark and sweep with a grace period.
 *
 *   1. mark: files nothing references get unreferenced_since = now(); referenced ones lose it;
 *   2. sweep: rows unreferenced for longer than the grace (and created before it) are deleted;
 *   3. each swept file is claimed and unlinked, after the delete has committed;
 *   4. orphans: files older than the grace with no row (a put whose transaction rolled back after
 *      its rename) are claimed and unlinked the same way;
 *   5. temporary files older than a day (a put that died between write and rename) are removed.
 *
 * The grace must outlast the archive's retention (infra/backup/nightly_backup.sh refuses otherwise):
 * every dump still kept then has its files. The nightly backup runs this after a verified backup,
 * never on a timer inside Core. The database work is in migration 019's functions, which run as the
 * owner, so this runs as the application role.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import { isBlobMediaType, isSha256Hex, BLOB_MEDIA_TYPES, type BlobMediaType } from '@hawa/contracts';
import type { Database } from '../types.js';
import { BlobStore } from './store.js';

export const BLOB_GC_MIN_GRACE_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;
const TMP_MAX_AGE_MS = DAY_MS;
const FILE_NAME = /^([0-9a-f]{64})\.([a-z]+)$/;
const EXTENSION_TYPES = new Map<string, BlobMediaType>(
  (Object.entries(BLOB_MEDIA_TYPES) as Array<[BlobMediaType, string]>).map(([type, ext]) => [ext, type]),
);

export interface BlobGcOptions {
  graceDays: number;
  limit?: number;
  /** Counts what would go and changes nothing: the mark and sweep are rolled back, nothing is unlinked. */
  dryRun?: boolean;
  /** The clock for file ages; tests move it. */
  now?: () => number;
}

export interface BlobGcReport {
  dryRun: boolean;
  marked: number;
  cleared: number;
  deleted: number;
  unlinked: number;
  orphans: number;
  tmp: number;
  bytesFreed: number;
  storeFiles: number;
  storeBytes: number;
}

/** One file of the store as found on disk. */
export interface StoreFile {
  sha256: string;
  mediaType: BlobMediaType;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every well-named file under sha256/; anything else there is left alone and not counted. */
export async function listStoreFiles(root: string): Promise<StoreFile[]> {
  const out: StoreFile[] = [];
  const base = path.join(root, 'sha256');
  let shards: string[];
  try {
    shards = await fsp.readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }
  for (const shard of shards.sort()) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let names: string[];
    try {
      names = await fsp.readdir(path.join(base, shard));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const m = FILE_NAME.exec(name);
      const mediaType = m ? EXTENSION_TYPES.get(m[2]) : undefined;
      if (!m || !mediaType || m[1].slice(0, 2) !== shard) continue;
      const file = path.join(base, shard, name);
      try {
        const s = await fsp.stat(file);
        if (s.isFile()) out.push({ sha256: m[1], mediaType, path: file, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // Gone between the listing and the stat: another collector or a restore. Nothing to count.
      }
    }
  }
  return out;
}

/**
 * Claims one file and unlinks it inside the claim's transaction, only if its row is still gone.
 * Returns the bytes freed, or undefined when the file was kept (its row came back).
 */
export async function claimAndUnlink(db: Kysely<Database>, file: string, sha256: string): Promise<number | undefined> {
  if (!isSha256Hex(sha256)) throw new Error('Not a blob hash');
  return db.transaction().execute(async (trx) => {
    const claim = await sql<{ gone: boolean }>`SELECT hawa.blob_gc_claim_unlink(${sha256}) AS gone`.execute(trx);
    if (!claim.rows[0]?.gone) return undefined;
    let size = 0;
    try {
      size = (await fsp.stat(file)).size;
      await fsp.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return size;
  });
}

export async function runBlobGc(store: BlobStore, db: Kysely<Database>, opts: BlobGcOptions): Promise<BlobGcReport> {
  if (!Number.isFinite(opts.graceDays) || opts.graceDays < BLOB_GC_MIN_GRACE_DAYS) {
    throw new Error(`The blob grace period must be at least ${BLOB_GC_MIN_GRACE_DAYS} days (got ${opts.graceDays})`);
  }
  const limit = Math.max(1, Math.min(10000, Math.floor(opts.limit ?? 500)));
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceDays * DAY_MS;
  await store.assertReady();
  const report: BlobGcReport = { dryRun, marked: 0, cleared: 0, deleted: 0, unlinked: 0, orphans: 0, tmp: 0, bytesFreed: 0, storeFiles: 0, storeBytes: 0 };

  // 1 and 2. Mark, then sweep until a batch comes back short. A dry run does both in one transaction
  // and rolls it back, so it counts exactly what a real run would delete.
  const swept: Array<{ sha256: string; mediaType: BlobMediaType }> = [];
  const markAndSweep = async (trx: Kysely<Database>) => {
    const mark = await sql<{ marked: string; cleared: string }>`SELECT marked, cleared FROM hawa.blob_gc_mark()`.execute(trx);
    report.marked = Number(mark.rows[0]?.marked ?? 0);
    report.cleared = Number(mark.rows[0]?.cleared ?? 0);
    for (;;) {
      const batch = await sql<{ sha256: string; media_type: string }>`
        SELECT sha256, media_type FROM hawa.blob_gc_sweep(make_interval(days => ${opts.graceDays}), ${limit})`.execute(trx);
      for (const row of batch.rows) {
        if (isBlobMediaType(row.media_type)) swept.push({ sha256: row.sha256, mediaType: row.media_type });
      }
      report.deleted += batch.rows.length;
      if (batch.rows.length < limit) break;
    }
  };
  if (dryRun) {
    class DryRun extends Error {}
    await db.transaction().execute(async (trx) => {
      await markAndSweep(trx);
      throw new DryRun();
    }).catch((error) => {
      if (!(error instanceof DryRun)) throw error;
    });
  } else {
    // Each function call is its own transaction: a long sweep never holds the mark's row locks.
    await markAndSweep(db);
  }

  // 3. Unlink what was swept, each under its claim.
  if (!dryRun) {
    for (const blob of swept) {
      const freed = await claimAndUnlink(db, store.pathOf(blob), blob.sha256);
      if (freed !== undefined) {
        report.unlinked++;
        report.bytesFreed += freed;
      }
    }
  }

  // 4. Orphans: files past the grace whose row does not exist.
  const files = await listStoreFiles(store.root);
  const old = files.filter((f) => now() - f.mtimeMs > graceMs);
  const withRow = new Set<string>();
  for (let i = 0; i < old.length; i += 1000) {
    const hashes = old.slice(i, i + 1000).map((f) => f.sha256);
    const rows = await sql<{ sha256: string }>`SELECT sha256 FROM hawa.blobs WHERE sha256 = ANY(${hashes}::text[])`.execute(db);
    for (const row of rows.rows) withRow.add(row.sha256);
  }
  const gone = new Set<string>();
  for (const file of old) {
    if (withRow.has(file.sha256)) continue;
    if (dryRun) {
      report.orphans++;
      continue;
    }
    const freed = await claimAndUnlink(db, file.path, file.sha256);
    if (freed !== undefined) {
      report.orphans++;
      report.bytesFreed += freed;
      gone.add(file.path);
    }
  }
  for (const file of files) {
    if (gone.has(file.path)) continue;
    report.storeFiles++;
    report.storeBytes += file.size;
  }

  // 5. Temporary files from puts that never finished.
  const tmpDir = path.join(store.root, 'tmp');
  const tmpNames = await fsp.readdir(tmpDir).catch(() => [] as string[]);
  for (const name of tmpNames) {
    if (!name.endsWith('.part')) continue;
    const file = path.join(tmpDir, name);
    try {
      const s = await fsp.stat(file);
      if (!s.isFile() || now() - s.mtimeMs <= TMP_MAX_AGE_MS) continue;
      if (!dryRun) await fsp.unlink(file);
      report.tmp++;
    } catch {
      // Renamed into place or removed meanwhile.
    }
  }
  return report;
}
