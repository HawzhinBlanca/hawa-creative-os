/**
 * The file store's garbage collector (ADR-035 section 2.3, packages/db/src/blobs/gc.ts).
 *
 * Usage (inside Core, where the store is mounted; the application role is enough):
 *   docker exec hawa-production-core-1 node /app/apps/core/dist/tools/blob-gc.js [--grace-days 15] [--limit 500] [--dry-run]
 *
 * infra/backup/nightly_backup.sh runs it after a verified backup has been archived, never at any other
 * time: a file is deleted only while every kept dump that references it has its copy in the archive.
 * Prints one JSON line: {marked, cleared, deleted, unlinked, orphans, tmp, bytesFreed, storeFiles, storeBytes}.
 * The grace comes from --grace-days or HAWA_BLOB_GRACE_DAYS (15); under 7 days is refused.
 */
import { blobStoreFromEnv, createDb, runBlobGc } from '@hawa/db';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const graceDays = Number(option('--grace-days') ?? process.env.HAWA_BLOB_GRACE_DAYS ?? 15);
  const limit = Number(option('--limit') ?? 500);
  if (!Number.isInteger(graceDays)) throw new Error('--grace-days must be a whole number of days');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive whole number');
  const db = createDb(process.env.DATABASE_URL, { max: 2 });
  try {
    const store = blobStoreFromEnv(db);
    const report = await runBlobGc(store, db, { graceDays, limit, dryRun: process.argv.includes('--dry-run') });
    console.log(JSON.stringify({ graceDays, ...report }));
  } finally {
    await db.destroy().catch(() => {});
  }
}

main().catch((error) => {
  console.error('blob gc failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
