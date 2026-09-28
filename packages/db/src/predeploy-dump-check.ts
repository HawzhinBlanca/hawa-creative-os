/**
 * Pre-deploy check on production's own data (ADR-137): restores the newest production dump into a
 * scratch database on the TEST server (hawa-test-postgres, 127.0.0.1:55432), applies this
 * checkout's pending migrations with the upgrader deploy.sh runs (upgrade.ts), runs the read-only
 * invariants of predeploy-invariants.ts, and drops the scratch databases.
 *
 *   npx tsx packages/db/src/predeploy-dump-check.ts                  # newest infra/backup/snapshots/predeploy_*.dump
 *   npx tsx packages/db/src/predeploy-dump-check.ts --dump <file>    # a given pg_dump -Fc file
 *   npx tsx packages/db/src/predeploy-dump-check.ts --json <file>    # also write the report (counts only)
 *   npx tsx packages/db/src/predeploy-dump-check.ts --through 066    # replay a past release: migrations up to 066 only
 *   HAWA_PREDEPLOY_SNAPSHOTS=<dir>                                   # where to look for dumps
 *
 * Exit 0: every invariant holds. Exit 1: one does not, or the restore or upgrade failed.
 * Exit 3: there is no dump to check (scripts/enforce_release_gate.sh reports the stage as skipped).
 *
 * It never connects to production: the dump is a file (deploy.sh writes one before every deploy),
 * every URL is built for the test server and checked by the production guard, and the scratch names
 * are hawa_drill_predeploy_*, which the test tooling alone may drop. Restored rows are client data:
 * nothing here prints them (restore errors are reduced to their error class), and the databases are
 * dropped on every exit path.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkPredeployInvariants, schemaShape, type InvariantReport } from './predeploy-invariants.js';
import { readyTestServer } from './provision-isolated-test-db.js';
import { TEST_POSTGRES_CONTAINER } from './test-database-guard.js';
import { discoverMigrations, upgradeCanvaSchema } from './upgrade.js';

export const SCRATCH_PREFIX = 'hawa_drill_predeploy_';
const SCRATCH_NAME = /^hawa_drill_predeploy_[a-z0-9_]{1,40}$/;

/**
 * The newest production dump in `dir`: deploy.sh's predeploy_<stamp>.dump or the nightly
 * hawa_<stamp>.dump, whichever has the later UTC stamp in its name; null when there is none.
 */
export function newestDump(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const stamped = readdirSync(dir).flatMap((f) => {
    const m = /^(?:predeploy|hawa)_(\d{8}T\d{6}Z)\.dump$/.exec(f);
    return m ? [{ f, stamp: m[1] }] : [];
  }).sort((a, b) => (a.stamp === b.stamp ? a.f.localeCompare(b.f) : a.stamp.localeCompare(b.stamp)));
  return stamped.length ? join(dir, stamped[stamped.length - 1].f) : null;
}

/** A restore error line without values: pg's DETAIL/key text can quote row contents. */
export function sanitizeRestoreError(line: string): string {
  return line.replace(/\bDETAIL:.*$/s, '').replace(/\([^)]*\)=\([^)]*\)/g, '(…)=(…)').replace(/"[^"]*@[^"]*"/g, '"…"').slice(0, 200);
}

function sha256File(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => ok(hash.digest('hex'))).on('error', fail);
  });
}

function assertScratch(name: string): void {
  if (!SCRATCH_NAME.test(name)) throw new Error(`refusing database ${name}: not a pre-deploy scratch name`);
}

async function admin<T>(ownerUrl: (db: string) => string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ownerUrl('postgres'), connectionTimeoutMillis: 10000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => undefined); }
}

async function createScratch(ownerUrl: (db: string) => string, name: string): Promise<void> {
  assertScratch(name);
  await admin(ownerUrl, async (c) => {
    await c.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
    await c.query(`GRANT CONNECT ON DATABASE ${name} TO hawa_app`);
  });
}

export async function dropScratch(ownerUrl: (db: string) => string, name: string): Promise<void> {
  assertScratch(name);
  await admin(ownerUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

/** pg_restore inside the test server's container, the dump on stdin: nothing is copied into it. */
function restore(dump: string, database: string): Promise<{ code: number; errors: string[] }> {
  assertScratch(database);
  return new Promise((ok, fail) => {
    const child = spawn('docker', ['exec', '-i', TEST_POSTGRES_CONTAINER, 'pg_restore', '-U', 'hawa_owner', '-d', database, '--exit-on-error'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', fail);
    child.on('close', (code) => ok({ code: code ?? 1, errors: stderr.split('\n').filter((l) => /error/i.test(l)).slice(0, 5).map(sanitizeRestoreError) }));
    createReadStream(dump).pipe(child.stdin);
  });
}

/**
 * A database built from this checkout the way production's was first built (the init scripts of
 * docker-compose.prod.yml: schema, RLS, runtime grants, seed) and then upgraded: the schema the
 * tests ran against, to compare the upgraded restore with.
 */
async function buildFresh(root: string, url: string, through?: number): Promise<void> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  await c.connect();
  try {
    for (const file of ['db/schema.sql', 'db/rls.sql', 'db/03-grants.sql', 'db/seed.sql']) await c.query(readFileSync(resolve(root, file), 'utf8'));
  } finally {
    await c.end().catch(() => undefined);
  }
  await upgradeCanvaSchema(url, { through });
}

export interface DumpCheckReport {
  status: 'passed' | 'failed' | 'skipped';
  dump?: string;
  dumpBytes?: number;
  checksum?: 'verified' | 'absent';
  migrationsBefore?: number;
  applied?: string[];
  ms: Record<string, number>;
  report?: InvariantReport;
  error?: string;
}

export async function runDumpCheck(options: { root: string; dump?: string; snapshots?: string; through?: number; log?: (line: string) => void }): Promise<DumpCheckReport> {
  const log = options.log ?? console.log;
  const ms: Record<string, number> = {};
  const dump = options.dump ?? newestDump(options.snapshots ?? join(options.root, 'infra', 'backup', 'snapshots'));
  if (!dump || !existsSync(dump)) return { status: 'skipped', ms, error: `no production dump (predeploy_*.dump or hawa_*.dump) in ${options.dump ?? options.snapshots ?? 'infra/backup/snapshots'}` };
  const out: DumpCheckReport = { status: 'failed', dump: dump.split('/').pop(), dumpBytes: statSync(dump).size, ms };
  let t = Date.now();
  if (existsSync(`${dump}.sha256`)) {
    const expected = readFileSync(`${dump}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if ((await sha256File(dump)) !== expected) return { ...out, error: 'the dump does not match its .sha256' };
    out.checksum = 'verified';
  } else out.checksum = 'absent';

  const { ownerUrl } = await readyTestServer(options.root);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const scratch = `${SCRATCH_PREFIX}${stamp}_${process.pid}`;
  const fresh = `${SCRATCH_PREFIX}fresh_${stamp}_${process.pid}`;
  const created: string[] = [];
  const cleanup = async () => { for (const name of created.splice(0)) await dropScratch(ownerUrl, name).catch((e) => log(`WARNING: could not drop ${name}: ${e instanceof Error ? e.message : e}`)); };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await createScratch(ownerUrl, scratch);
    created.push(scratch);
    ms.checksum = Date.now() - t;
    t = Date.now();
    log(`restoring ${out.dump} (${Math.round(out.dumpBytes! / 1048576)} MiB) into ${scratch} on ${TEST_POSTGRES_CONTAINER}`);
    const restored = await restore(dump, scratch);
    ms.restore = Date.now() - t;
    if (restored.code !== 0) return { ...out, error: `pg_restore failed (${restored.code}): ${restored.errors.join(' | ')}` };

    t = Date.now();
    const probe = new pg.Client({ connectionString: ownerUrl(scratch), connectionTimeoutMillis: 10000 });
    await probe.connect();
    const before = await probe.query('SELECT count(*)::int AS n FROM hawa.schema_upgrades').then((r) => Number(r.rows[0].n)).finally(() => probe.end().catch(() => undefined));
    out.migrationsBefore = before;
    const upgraded = await upgradeCanvaSchema(ownerUrl(scratch), { through: options.through });
    out.applied = upgraded.applied;
    ms.upgrade = Date.now() - t;
    const span = upgraded.applied.length ? ` (${upgraded.applied[0].slice(0, 3)}…${upgraded.applied[upgraded.applied.length - 1].slice(0, 3)})` : '';
    log(`upgraded: ${upgraded.applied.length} pending migration(s) applied${span}, ${upgraded.verified.length} already recorded; ${discoverMigrations().length} in this checkout`);

    t = Date.now();
    await createScratch(ownerUrl, fresh);
    created.push(fresh);
    await buildFresh(options.root, ownerUrl(fresh), options.through);
    const c = new pg.Client({ connectionString: ownerUrl(fresh), connectionTimeoutMillis: 10000 });
    await c.connect();
    const expected = await schemaShape(c).finally(() => c.end().catch(() => undefined));
    ms.freshBuild = Date.now() - t;

    t = Date.now();
    out.report = await checkPredeployInvariants(ownerUrl(scratch), { expected });
    ms.invariants = Date.now() - t;
    out.status = out.report.ok ? 'passed' : 'failed';
    return out;
  } catch (error) {
    return { ...out, error: error instanceof Error ? error.message : String(error) };
  } finally {
    t = Date.now();
    await cleanup();
    ms.drop = Date.now() - t;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const started = Date.now();
  const through = arg('--through');
  if (through !== undefined && !/^\d{1,3}$/.test(through)) throw new Error('--through takes a migration number, e.g. 066');
  const result = await runDumpCheck({ root, dump: arg('--dump'), snapshots: process.env.HAWA_PREDEPLOY_SNAPSHOTS, through: through === undefined ? undefined : Number(through) });
  const json = arg('--json');
  if (json) writeFileSync(json, JSON.stringify({ ...result, totalMs: Date.now() - started }, null, 2) + '\n');
  if (result.status === 'skipped') {
    console.log(`SKIPPED: ${result.error}`);
    return 3;
  }
  for (const inv of result.report?.invariants ?? []) {
    console.log(`${inv.ok ? '  ok  ' : '  FAIL'} ${inv.name}: ${inv.detail}`);
    for (const p of inv.problems ?? []) console.log(`         - ${p}`);
  }
  if (result.report) console.log(`counts: ${JSON.stringify(result.report.counts)}`);
  console.log(`timings (ms): ${JSON.stringify(result.ms)}; total ${Date.now() - started}`);
  if (result.error) console.log(`ERROR: ${result.error}`);
  console.log(result.status === 'passed' ? 'PASSED' : 'FAILED');
  return result.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => { console.error(`ERROR: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
