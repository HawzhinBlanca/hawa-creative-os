/**
 * The file store's check (fsck): every hawa.blobs row has its file, and each file's bytes hash to its
 * name and have the row's size. Run weekly against the live store and by the monthly restore drill
 * (infra/backup/restore_drill.sh) against a restored database and the files unpacked from the archive:
 * `missing` must be 0.
 *
 * A referenced hash with no row is counted apart (referencedWithoutRow), never as missing. Until the
 * copy backfill has run, the running Core writes hashes into columns hawa.blob_references reads while
 * the bytes still live in bytea beside them (design_studio_candidates.preview_sha256 and others): those
 * hashes have no row and no file, and nothing is lost. Once migration 020 adds the foreign keys to
 * hawa.blobs, a reference without a row cannot exist, and every reference is a row this check covers.
 *
 * fsync through Docker Desktop's file sharing ends in macOS fsync, not F_FULLFSYNC, so a power cut can
 * lose a file whose row committed. This check and the drill are how that would be found.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import { blobRelPath, isBlobMediaType, type BlobMediaType } from '@hawa/contracts';
import type { Database } from '../types.js';
import { listStoreFiles } from './gc.js';

export interface BlobVerifyProblem {
  sha256: string;
  problem: 'missing' | 'size' | 'hash' | 'no_row' | 'referenced_without_row';
  detail?: string;
}

export interface BlobVerifyReport {
  rows: number;
  references: number;
  checked: number;
  missing: number;
  corrupt: number;
  /**
   * Referenced hashes with no hawa.blobs row: bytes the backfill has not copied yet. Not a failure, and
   * not in `missing`; impossible once every foreign key exists (migration 020).
   */
  referencedWithoutRow: number;
  /** Files on disk with no row; the collector removes them after the grace. Not a failure. */
  orphanFiles: number;
  problems: BlobVerifyProblem[];
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function verifyBlobStore(db: Kysely<Database>, root: string, opts: { hash?: boolean } = {}): Promise<BlobVerifyReport> {
  const checkHash = opts.hash !== false;
  const rows = (await sql<{ sha256: string; size: string; media_type: string }>`
    SELECT sha256, size, media_type FROM hawa.blobs ORDER BY sha256`.execute(db)).rows;
  const references = (await sql<{ sha256: string }>`SELECT h AS sha256 FROM hawa.blob_reference_hashes() AS h`.execute(db)).rows;
  const report: BlobVerifyReport = {
    rows: rows.length,
    references: references.length,
    checked: 0,
    missing: 0,
    corrupt: 0,
    referencedWithoutRow: 0,
    orphanFiles: 0,
    problems: [],
  };
  const known = new Map<string, { size: number; mediaType: BlobMediaType }>();
  for (const row of rows) {
    if (!isBlobMediaType(row.media_type)) continue;
    known.set(row.sha256, { size: Number(row.size), mediaType: row.media_type });
  }
  for (const [sha256, row] of known) {
    const file = path.join(root, blobRelPath({ sha256, mediaType: row.mediaType }));
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      report.missing++;
      report.problems.push({ sha256, problem: 'missing' });
      continue;
    }
    report.checked++;
    if (size !== row.size) {
      report.corrupt++;
      report.problems.push({ sha256, problem: 'size', detail: `${size} bytes on disk, ${row.size} in the row` });
      continue;
    }
    if (checkHash) {
      const actual = await sha256OfFile(file);
      if (actual !== sha256) {
        report.corrupt++;
        report.problems.push({ sha256, problem: 'hash', detail: `bytes hash to ${actual.slice(0, 12)}…` });
      }
    }
  }
  for (const ref of references) {
    if (known.has(ref.sha256)) continue;
    // Listed for the record only. Without a row the extension is unknown, so a file under any
    // extension counts as there.
    report.referencedWithoutRow++;
    const shard = path.join(root, 'sha256', ref.sha256.slice(0, 2));
    const names = await fs.promises.readdir(shard).catch(() => [] as string[]);
    const hasFile = names.some((n) => n.startsWith(`${ref.sha256}.`));
    report.problems.push({ sha256: ref.sha256, problem: 'referenced_without_row', ...(hasFile ? {} : { detail: 'and no file' }) });
  }
  for (const file of await listStoreFiles(root)) {
    if (!known.has(file.sha256)) report.orphanFiles++;
  }
  return report;
}
