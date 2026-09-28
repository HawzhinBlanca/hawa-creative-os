/** Live data stays in a pipe and a disposable, isolated DB. Evidence contains no row contents. */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { upgradeCanvaSchema, discoverMigrations } from '../../../packages/db/src/upgrade.ts';
import { createDb, withRlsContext, listTaskPage, sql } from '../../../packages/db/src/index.ts';
import { connectionTargetOf, productionTargetReason } from '../../../packages/db/src/test-database-guard.ts';

const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const root = new URL('../../../', import.meta.url);
const sourceContainer = 'hawa-production-postgres-1';
const targetContainer = 'hawa-test-postgres';
const targetName = `hawa_drill_live_upgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const startedAt = new Date().toISOString();
const receiptFile = new URL(`migration-${startedAt.replaceAll(':', '-')}.json`, import.meta.url);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const inspect = (name: string) => JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
const environment = (container: any) => Object.fromEntries(container.Config.Env.map((line: string) => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
const sourceContainerState = inspect(sourceContainer);
const targetContainerState = inspect(targetContainer);
const sourceEnv = environment(sourceContainerState);
const targetEnv = environment(targetContainerState);
if (sourceContainerState.Id === targetContainerState.Id || targetContainerState.Name !== '/hawa-test-postgres'
    || targetContainerState.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort !== '55432'
    || sourceContainerState.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort !== '54332'
    || !/^hawa_drill_live_upgrade_[a-f0-9]{12}$/.test(targetName)) throw new Error('Container isolation refused');
const connectUrl = (env: Record<string, string>, port: number, database: string) => {
  const url = new URL('postgresql://127.0.0.1'); url.port = String(port); url.username = env.POSTGRES_USER;
  url.password = env.POSTGRES_PASSWORD; url.pathname = '/' + database; return url.href;
};
const targetUrl = connectUrl(targetEnv, 55432, targetName);
if (productionTargetReason(connectionTargetOf(targetUrl))) throw new Error('Unsafe migration target');
const source = new Client({ connectionString: connectUrl(sourceEnv, 54332, sourceEnv.POSTGRES_DB), connectionTimeoutMillis: 10000 });
const admin = new Client({ connectionString: connectUrl(targetEnv, 55432, 'postgres'), connectionTimeoutMillis: 10000 });
const target = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 10000 });
const report: any = { schemaVersion: 1, startedAt, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'Consistent live-data migration rehearsal on separate disposable PostgreSQL; no provider callers or human actions.',
  source: { container: sourceContainer, imageId: sourceContainerState.Image, access: 'repeatable-read read-only exported snapshot' },
  target: { container: targetContainer, imageId: targetContainerState.Image, database: targetName, removed: false },
  dataExposure: 'No dump or row contents written to host files, logs or evidence; private copy removed in finally.',
  rowFingerprint: 'SHA-256 of ordered SHA-256 JSON row fingerprints; source columns frozen before migration.',
  phases: [], status: 'running', productionMigrated: false, productionDeployed: false,
  limits: ['Same host and nondurable test PostgreSQL: not independent-host recovery or RPO/RTO evidence.',
    'No blob filesystem, Restate journal, Google sign-in, real approval or delivery was exercised.',
    'No rollback archive is retained; production needs its own verified backup before migration.'] };
let created = false;
let phase = 'connect';
function save() { writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
async function fingerprint(client: any, table: string, columns: string[], where = '') {
  // Only aggregate fingerprints enter this process. Row contents and credentials never do.
  const result = await client.query(`SELECT count(*)::text AS rows,
    encode(sha256(convert_to(COALESCE(string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM
      (SELECT ${columns.map(quote).join(',')} FROM hawa.${quote(table)} ${where}) t) hashes`);
  return result.rows[0] as { rows: string; digest: string };
}
async function dumpAndRestore(snapshot: string) {
  if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error('Invalid exported snapshot');
  const dump = spawn('docker', ['exec', sourceContainer, 'pg_dump', '-U', sourceEnv.POSTGRES_USER,
    '-d', sourceEnv.POSTGRES_DB, '--format=custom', '--snapshot', snapshot, '--lock-wait-timeout=10s'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const restore = spawn('docker', ['exec', '-i', targetContainer, 'pg_restore', '-U', targetEnv.POSTGRES_USER,
    '-d', targetName, '--no-owner', '--exit-on-error', '--single-transaction'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  // Drain diagnostics without disclosing a failing row or SQL body. Exit status is retained.
  dump.stderr.on('data', () => {}); restore.stderr.on('data', () => {});
  const waits = [dump, restore].map(child => new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  }));
  restore.stdin.on('error', () => { dump.kill('SIGTERM'); });
  dump.stdout.pipe(meter).pipe(restore.stdin);
  const timeout = setTimeout(() => { dump.kill('SIGTERM'); restore.kill('SIGTERM'); }, 120000);
  try {
    const [dumpExit, restoreExit] = await Promise.all(waits);
    report.stream = { bytes, sha256: hash.digest('hex'), dumpExit, restoreExit };
    if (dumpExit !== 0 || restoreExit !== 0) throw new Error('Database stream or restore failed');
  } finally { clearTimeout(timeout); }
}

try {
  save();
  await source.connect(); await admin.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query("SET LOCAL statement_timeout = '60s'");
  const { snapshot, bytes } = (await source.query('SELECT pg_export_snapshot() AS snapshot, pg_database_size(current_database())::text AS bytes')).rows[0];
  if (Number(bytes) > 1024 * 1024 * 1024) throw new Error('Snapshot exceeds one GiB rehearsal bound');
  report.source.bytes = Number(bytes);
  report.source.version = (await source.query('SHOW server_version')).rows[0].server_version;
  const tables = (await source.query(`SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
    FROM information_schema.columns WHERE table_schema='hawa' AND table_name IN
    (SELECT tablename FROM pg_tables WHERE schemaname='hawa') GROUP BY table_name ORDER BY table_name`)).rows;
  const before = new Map<string, {rows:string;digest:string}>();
  const roleExisted = (await source.query("SELECT EXISTS(SELECT 1 FROM hawa.model_roles WHERE role='voice_transcriber') AS present")).rows[0].present;
  const oldUpgrades = (await source.query('SELECT name,sha256 FROM hawa.schema_upgrades ORDER BY name')).rows;
  if (oldUpgrades.length !== 22 || oldUpgrades.at(-1)?.name !== '022_publication_executor.sql') throw new Error('Live schema changed since preflight');
  report.migrationsBefore = oldUpgrades.map((item: {name:string}) => item.name);
  phase = 'fingerprint-live-snapshot';
  for (const table of tables) before.set(table.table_name, await fingerprint(source, table.table_name, table.columns));
  report.phases.push({ name: phase, tables: tables.length, passed: true }); save();
  phase = 'create-isolated-target';
  await admin.query(`CREATE DATABASE ${quote(targetName)} TEMPLATE template0`); created = true;
  await admin.query(`REVOKE CONNECT ON DATABASE ${quote(targetName)} FROM PUBLIC`);
  phase = 'stream-consistent-snapshot'; await dumpAndRestore(snapshot);
  await source.query('ROLLBACK');
  await target.connect();
  phase = 'compare-restored-snapshot';
  for (const table of tables) {
    const expected = before.get(table.table_name)!;
    const actual = await fingerprint(target, table.table_name, table.columns);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Restored rows differ from exported snapshot');
  }
  report.phases.push({ name: phase, tables: tables.length, passed: true }); save();
  phase = 'apply-current-migrations';
  const start = performance.now();
  const first = await upgradeCanvaSchema(targetUrl);
  report.upgrade = { ...first, durationMs: Math.round(performance.now() - start) }; save();
  phase = 'compare-historical-rows';
  report.tables = [];
  for (const table of tables) {
    const expected = before.get(table.table_name)!;
    const where = table.table_name === 'schema_upgrades' ? `WHERE name < '023'`
      : table.table_name === 'model_roles' && !roleExisted ? "WHERE role <> 'voice_transcriber'" : '';
    const actual = await fingerprint(target, table.table_name, table.columns, where);
    const unchanged = JSON.stringify(expected) === JSON.stringify(actual);
    report.tables.push({ name: table.table_name, existingRows: Number(expected.rows), originalColumnsUnchanged: unchanged });
    if (!unchanged) throw new Error('Migration changed historical rows');
  }
  report.expectedNewVoiceRole = (await target.query("SELECT count(*)::int AS count FROM hawa.model_roles WHERE role='voice_transcriber'")).rows[0].count === 1;
  phase = 'replay-current-migrations';
  const second = await upgradeCanvaSchema(targetUrl);
  if (second.applied.length !== 0 || second.verified.length !== discoverMigrations().length) throw new Error('Migration replay failed');
  report.replay = { applied: 0, verified: second.verified.length };
  const newColumns = (await target.query(`SELECT
    (SELECT count(*) FROM hawa.tasks WHERE request_id IS NOT NULL OR delivery_executor_pin <> 'core')::int AS unexpected_legacy_owner,
    (SELECT count(*) FROM hawa.desk_sessions WHERE auth_method <> 'shared_key')::int AS invented_named_sessions,
    (SELECT count(*) FROM hawa.office_review_assignments)::int AS invented_review_assignments`)).rows[0];
  report.legacyDefaults = newColumns;
  if (Object.values(newColumns).some(value => value !== 0)) throw new Error('Historical ownership/authentication defaults differ');
  phase = 'read-current-task-projection';
  const runtime = createDb(targetUrl);
  try {
    const page = await withRlsContext(runtime, { tenantId:'00000000-0000-4000-a000-000000000001', userId:'00000000-0000-4000-b000-000000000001', role:'operator' }, async trx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);
      return listTaskPage(trx, { tenantId:'00000000-0000-4000-a000-000000000001', limit:20 });
    });
    report.taskProjection = { returned:page.rows.length, total:page.total, runtimeRole:'hawa_app', passed:true };
  } finally { await runtime.destroy(); }
  report.status = 'passed'; report.completedAt = new Date().toISOString(); save();
} catch (error) {
  report.status = 'failed';
  report.failure = { phase, class: error instanceof Error ? error.name : 'unknown',
    code:(error as any)?.code ?? null, table:(error as any)?.table ?? null, constraint:(error as any)?.constraint ?? null };
  process.exitCode = 1;
} finally {
  await source.end().catch(() => {}); await target.end().catch(() => {});
  if (created) {
    try {
      if (inspect(targetContainer).Id !== targetContainerState.Id) throw new Error('Cleanup target changed');
      await admin.query(`DROP DATABASE ${quote(targetName)} WITH (FORCE)`);
      report.target.removed = true;
    } catch { report.cleanupFailed = true; process.exitCode = 1; }
  }
  await admin.end().catch(() => {}); save();
  console.log(JSON.stringify({ receipt:receiptFile.pathname, status:report.status, failure:report.failure,
    oldTablesCompared:report.tables?.length, migrationsApplied:report.upgrade?.applied.length,
    replay:report.replay, privateCloneRemoved:report.target.removed }));
}
