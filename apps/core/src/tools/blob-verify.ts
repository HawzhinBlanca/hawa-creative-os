/**
 * The file store's check (packages/db/src/blobs/verify.ts): every hawa.blobs row has its file, with
 * the right size and hash. Exit 0 only when nothing is missing or corrupt. A referenced hash without a
 * row (bytes the backfill has not copied out of Postgres yet) is reported as referencedWithoutRow and
 * does not fail the check.
 *
 * Usage:
 *   docker exec hawa-production-core-1 node /app/apps/core/dist/tools/blob-verify.js           # the live store
 *   DATABASE_URL=<owner URL> node apps/core/dist/tools/blob-verify.js --db hawa_drill_<stamp> --dir <unpacked blobs>
 *
 * --db names another database on the same server as DATABASE_URL (the restore drill's copy), so the
 * password stays in the environment and out of the process list. --dir overrides HAWA_BLOB_DIR.
 * --no-hash checks sizes only. Prints one JSON line; the first 20 problems are listed.
 */
import path from 'node:path';
import { createDb, verifyBlobStore } from '@hawa/db';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required');
  let url = base;
  const database = option('--db');
  if (database) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error('--db must be a plain database name');
    const parsed = new URL(base);
    parsed.pathname = `/${database}`;
    url = parsed.toString();
  }
  const dir = option('--dir') ?? process.env.HAWA_BLOB_DIR;
  if (!dir) throw new Error('--dir or HAWA_BLOB_DIR is required');
  const db = createDb(url, { max: 2 });
  try {
    const report = await verifyBlobStore(db, path.resolve(dir), { hash: !process.argv.includes('--no-hash') });
    const { problems, ...counts } = report;
    console.log(JSON.stringify({ ...counts, problems: problems.slice(0, 20) }));
    return report.missing === 0 && report.corrupt === 0 ? 0 : 1;
  } finally {
    await db.destroy().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('blob verify failed:', error instanceof Error ? error.message : error);
  process.exit(2);
});
