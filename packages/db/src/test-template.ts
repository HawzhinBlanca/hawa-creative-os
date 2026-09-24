/**
 * Per-file test databases (architecture programme 1.1).
 *
 * The suite used to share two databases, hawa_test and hawa_repair, for every file and every
 * worktree on the machine. Rows piled up between runs, timing and daily-cap tests flaked on
 * whatever earlier files had left behind, and two worktrees testing at once corrupted each
 * other's runs. Now:
 *
 *   - the global setup builds two template databases, hawa_tpl_test_<hash> and
 *     hawa_tpl_repair_<hash>, once per schema version (the hash covers schema, RLS, seed,
 *     fixtures and every versioned migration), under an advisory lock because worktrees share
 *     the server;
 *   - each test file clones its own pair (hawa_t_… and hawa_tr_…) before it is imported and drops
 *     them WITH (FORCE) when it finishes.
 *
 * A rolled-back transaction per test was rejected: the app opens its own transactions from a
 * pool, row-level security relies on transaction-local settings and SET LOCAL ROLE, and
 * commit-time behaviour (NOTIFY, deferred constraints, retries) would never run.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectionTargetOf, productionTargetReason, TEST_POSTGRES_PORT } from './test-database-guard.js';

export const APP_ROLE = 'hawa_app';
export type TemplateKind = 'test' | 'repair';

/** Clone names: hawa_t_<run>_<n> for the plain suite, hawa_tr_<run>_<n> for the repair suites. */
export const CLONE_PREFIX: Record<TemplateKind, string> = { test: 'hawa_t_', repair: 'hawa_tr_' };
const TEMPLATE_PREFIX = 'hawa_tpl_';
/** Every database name this module creates or drops matches this; anything else is refused. */
const OWNED_NAME = /^hawa_(t|tr|tpl_test|tpl_repair|tpl_build)_[a-z0-9_]+$/;

function assertOwnedName(name: string): void {
  if (!OWNED_NAME.test(name) || name.length > 63) {
    throw new Error(`Refusing to create or drop database "${name}": not a per-file test database name.`);
  }
}

/** The same URL pointed at another database on the same server, refusing production. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  const next = parsed.toString();
  const target = connectionTargetOf(next);
  const reason = productionTargetReason(target);
  if (reason) throw new Error(`Refusing test database ${database}: ${reason}`);
  if (Number(target.port) !== TEST_POSTGRES_PORT) {
    throw new Error(`Refusing test database ${database}: per-file databases live on the test server (port ${TEST_POSTGRES_PORT}) only.`);
  }
  return next;
}

/** Files whose content defines a template; any change builds a new one. */
export function templateSources(root: string): string[] {
  const migrations = readdirSync(resolve(root, 'packages/db/migrations'))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort()
    .map((f) => `packages/db/migrations/${f}`);
  return ['db/schema.sql', 'db/rls.sql', 'db/seed.sql', 'db/test-fixtures.sql', 'packages/db/src/test-template.ts', ...migrations];
}

export function templateHash(root: string): string {
  const hash = createHash('sha256');
  for (const file of templateSources(root)) {
    hash.update(file).update('\0').update(readFileSync(resolve(root, file))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function templateName(kind: TemplateKind, hash: string): string {
  return `${TEMPLATE_PREFIX}${kind}_${hash}`;
}

/**
 * Build one database the way production's is built: schema, RLS, seed, the runtime grants, then
 * the versioned upgrades through the runner production uses. The plain suite's template also gets
 * db/test-fixtures.sql; the repair template stays schema + seed, which its suites assume.
 */
export async function buildDatabase(root: string, ownerUrl: string, options: { fixtures: boolean }, log: (line: string) => void = () => {}): Promise<void> {
  const database = connectionTargetOf(ownerUrl).database ?? '';
  const client = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    for (const file of ['db/schema.sql', 'db/rls.sql', 'db/seed.sql']) {
      await client.query(readFileSync(resolve(root, file), 'utf8'));
      log(`${database}: applied ${file}`);
    }
    // The application role uses the disposable database exactly like the office database. The
    // versioned upgrades below grant their own tables narrowly, so this runs before them.
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA hawa TO ${APP_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hawa TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hawa TO ${APP_ROLE}`);
    log(`${database}: granted runtime privileges to ${APP_ROLE}`);
  } finally {
    await client.end().catch(() => {});
  }
  const { upgradeCanvaSchema } = await import('./upgrade.js');
  const result = await upgradeCanvaSchema(ownerUrl);
  log(`${database}: versioned upgrades applied=${result.applied.length} verified=${result.verified.length}`);
  if (options.fixtures) {
    const fixtures = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 10000 });
    await fixtures.connect();
    try {
      await fixtures.query(readFileSync(resolve(root, 'db/test-fixtures.sql'), 'utf8'));
      log(`${database}: applied db/test-fixtures.sql`);
    } finally {
      await fixtures.end().catch(() => {});
    }
  }
}

async function withAdmin<T>(ownerUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(ownerUrl, 'postgres'), connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
}

async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  assertOwnedName(name);
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/**
 * Make sure both templates for the current schema exist. Worktrees share the server, so the
 * build runs under a session advisory lock and a template is only renamed into place once it is
 * complete: a half-built template is never cloned.
 */
export async function ensureTemplates(root: string, ownerUrl: string, log: (line: string) => void = () => {}): Promise<Record<TemplateKind, string>> {
  const hash = templateHash(root);
  const names: Record<TemplateKind, string> = { test: templateName('test', hash), repair: templateName('repair', hash) };
  await withAdmin(ownerUrl, async (admin) => {
    await admin.query("SELECT pg_advisory_lock(hashtext('hawa.test_templates'))");
    try {
      for (const kind of ['test', 'repair'] as const) {
        if (await databaseExists(admin, names[kind])) continue;
        const building = `hawa_tpl_build_${kind}_${randomBytes(4).toString('hex')}`;
        assertOwnedName(building);
        // template0 with an explicit encoding, so a template never inherits whatever template1
        // happens to hold on this server; the locale stays the server's, as hawa_test's was.
        await admin.query(`CREATE DATABASE ${building} TEMPLATE template0 ENCODING 'UTF8'`);
        try {
          await buildDatabase(root, withDatabase(ownerUrl, building), { fixtures: kind === 'test' }, log);
          await admin.query(`ALTER DATABASE ${building} RENAME TO ${names[kind]}`);
          await admin.query(`ALTER DATABASE ${names[kind]} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
          log(`built template ${names[kind]}`);
        } catch (error) {
          await dropDatabase(admin, building).catch(() => {});
          throw error;
        }
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtext('hawa.test_templates'))").catch(() => {});
    }
  });
  return names;
}

/** A run id that also records when the run started, so leftovers of a killed run can be aged. */
export function newRunId(nowMs: number): string {
  return `${Math.floor(nowMs / 1000).toString(36)}${randomBytes(3).toString('hex')}`;
}

/** Epoch seconds encoded in a clone's run id, or null for a name this module did not make. */
export function cloneStartedAt(name: string): number | null {
  const m = /^hawa_tr?_([0-9a-z]+?)[0-9a-f]{6}_\d+$/.exec(name);
  if (!m) return null;
  const seconds = parseInt(m[1], 36);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Drop per-file databases a killed run left behind (older than maxAgeMs), and templates of
 * earlier schema versions that no clone has been made from for a while. Other worktrees may be
 * testing a different schema right now, so the newest few templates of each kind are kept.
 */
export async function pruneStale(ownerUrl: string, nowMs: number, maxAgeMs: number, keepTemplates = 4): Promise<string[]> {
  return withAdmin(ownerUrl, async (admin) => {
    const dropped: string[] = [];
    const rows = (await admin.query<{ datname: string; oid: number }>(
      "SELECT datname, oid::int AS oid FROM pg_database WHERE datname LIKE 'hawa\\_t\\_%' OR datname LIKE 'hawa\\_tr\\_%' OR datname LIKE 'hawa\\_tpl\\_%' ORDER BY oid DESC"
    )).rows;
    const kept: Record<string, number> = {};
    for (const { datname } of rows) {
      if (datname.startsWith('hawa_tpl_build_')) {
        // A build that never finished (the builder was killed): only safe once the lock is free.
        const free = (await admin.query("SELECT pg_try_advisory_lock(hashtext('hawa.test_templates')) AS ok")).rows[0].ok;
        if (free) {
          await dropDatabase(admin, datname);
          await admin.query("SELECT pg_advisory_unlock(hashtext('hawa.test_templates'))");
          dropped.push(datname);
        }
        continue;
      }
      if (datname.startsWith(TEMPLATE_PREFIX)) {
        const kind = datname.startsWith('hawa_tpl_test_') ? 'test' : 'repair';
        kept[kind] = (kept[kind] ?? 0) + 1;
        if (kept[kind] > keepTemplates) {
          await admin.query(`ALTER DATABASE ${datname} WITH IS_TEMPLATE false`);
          await dropDatabase(admin, datname);
          dropped.push(datname);
        }
        continue;
      }
      const started = cloneStartedAt(datname);
      if (started !== null && nowMs - started * 1000 > maxAgeMs) {
        await dropDatabase(admin, datname);
        dropped.push(datname);
      }
    }
    return dropped;
  });
}

/** Clone a template for one test file. */
export async function cloneTemplate(ownerUrl: string, template: string, clone: string): Promise<void> {
  assertOwnedName(clone);
  await withAdmin(ownerUrl, async (admin) => {
    await admin.query(`CREATE DATABASE ${clone} TEMPLATE ${template}`);
    // Database-level privileges live in pg_database, not in the copied files.
    await admin.query(`GRANT CONNECT ON DATABASE ${clone} TO ${APP_ROLE}`);
  });
}

export async function dropClone(ownerUrl: string, clone: string): Promise<void> {
  await withAdmin(ownerUrl, (admin) => dropDatabase(admin, clone));
}

/** Drop whatever clones of one run are still there (a worker that crashed before its afterAll). */
export async function dropRunClones(ownerUrl: string, runId: string): Promise<string[]> {
  if (!/^[0-9a-z]+$/.test(runId)) throw new Error(`invalid test run id ${runId}`);
  return withAdmin(ownerUrl, async (admin) => {
    const rows = (await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2',
      [`hawa\\_t\\_${runId}\\_%`, `hawa\\_tr\\_${runId}\\_%`]
    )).rows;
    for (const { datname } of rows) await dropDatabase(admin, datname);
    return rows.map((r) => r.datname);
  });
}
