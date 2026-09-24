import { readdirSync } from 'node:fs';
import { createDb, resolveWorkspaceFile, sql, type Database, type Kysely } from '@hawa/db';

/**
 * Whether the database Core is about to serve from has had every versioned upgrade this build
 * knows (packages/db/migrations, applied by packages/db/src/upgrade.ts, which deploy.sh runs).
 *
 * A fresh data directory gets db/schema.sql from the postgres init scripts but none of the
 * upgrades, which run later from deploy.sh. Core started on it either died on the first table an
 * upgrade creates or, with only the base schema there, opened its port and failed request by
 * request (the chaos harness, 2026-09-24). index.ts now asks this first, and a database that is
 * behind stops the start with one line naming what is missing; compose restarts Core, and once
 * deploy.sh has migrated, the next start serves.
 */
export type SchemaCheck =
  | { ok: true; applied: number }
  | { ok: false; missing: string[]; reason: string };

/** The upgrades this build carries, in order, as upgrade.ts discovers them. */
export function expectedUpgrades(dir = resolveWorkspaceFile('packages/db/migrations')): string[] {
  return readdirSync(dir).filter((f) => /^\d{3}_(?!.*_down\.sql$).*\.sql$/.test(f)).sort();
}

/**
 * Compares hawa.schema_upgrades with `expected`. Read as the app role: migration 020 grants it the
 * read, so "permission denied" means 020 (at least) has not run. Any other failure (the database is
 * unreachable) is thrown: that is not a missing upgrade.
 */
export async function checkSchemaUpgrades(db: Kysely<Database>, expected: string[]): Promise<SchemaCheck> {
  let applied: Set<string>;
  try {
    const rows = (await sql<{ name: string }>`SELECT name FROM hawa.schema_upgrades`.execute(db)).rows;
    applied = new Set(rows.map((r) => r.name));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // 42P01: no such table; 3F000: no such schema. No upgrade has ever run here.
    if (code === '42P01' || code === '3F000') {
      return { ok: false, missing: expected, reason: 'hawa.schema_upgrades does not exist, so no versioned upgrade has run' };
    }
    if (code === '42501') {
      const granting = expected.find((name) => name.startsWith('020_'));
      const behind = granting ? expected.slice(expected.indexOf(granting)) : expected;
      return { ok: false, missing: behind, reason: `hawa.schema_upgrades cannot be read (permission denied), so ${granting ?? 'the upgrade that grants it'} has not run` };
    }
    throw err;
  }
  const missing = expected.filter((name) => !applied.has(name));
  return missing.length ? { ok: false, missing, reason: `${missing.length} of ${expected.length} versioned upgrades have not run` } : { ok: true, applied: applied.size };
}

/** The one line index.ts logs when the database is behind. */
export function describeMissingUpgrades(check: Extract<SchemaCheck, { ok: false }>): string {
  return `the database is missing versioned upgrade${check.missing.length === 1 ? '' : 's'} ${check.missing.join(', ')} (${check.reason}); ` +
    'run packages/db/src/upgrade.ts against it as the schema owner (deploy.sh does), then start Core again. Not serving.';
}

/** Opens a short-lived pool on `url`, checks, and closes it. */
export async function checkDatabaseUpgrades(url: string): Promise<SchemaCheck> {
  const db = createDb(url, { max: 1 });
  try {
    return await checkSchemaUpgrades(db, expectedUpgrades());
  } finally {
    await db.destroy().catch(() => {});
  }
}
