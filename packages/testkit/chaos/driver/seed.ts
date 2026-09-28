/**
 * The chaos stack on a copy of production's data (run.ts --seed-dump, ADR-137).
 *
 * The suites never saw the 2026-09-28 regression (ADR-133) because their databases hold no
 * production-shaped history. With a dump, the chaos Postgres is emptied after its init scripts and
 * the dump is restored into hawa_chaos as it is; the driver then runs the versioned upgrades exactly
 * as a deploy does (provision.ts upgradeSchema, packages/db/src/upgrade.ts), and only then
 * neutralises what could act outside the stack. Real clients, client DNA, tasks and history stay.
 *
 * What keeps restored data from reaching a real service:
 *  1. The network (docker-compose.chaos.yml): Core and the workers are on internal networks only;
 *     every provider host resolves to the fakes; nothing else resolves or routes.
 *     verifyEgressFence() proves it from inside Core and the blue worker before any scenario runs
 *     and the run refuses to start if it does not hold.
 *  2. Credentials: every provider key and the bot token come from .run/chaos.env or are
 *     placeholders; production's never enter the stack (the dump holds none of them).
 *  3. Restored credentials: neutralise() deletes the stored Canva connections and OAuth states, desk
 *     and office sign-in sessions, and clears integration configs, then refuses to continue if any
 *     credential-shaped column still holds a value. The Canva connection the scenarios use is
 *     sealed afresh with the chaos key (provision.ts connectCanva); production's tokens, sealed with
 *     production's key, are gone before any application process starts.
 * Real chat ids, Canva design ids and Drive folder ids stay in the rows: any call they cause lands
 * in the fakes, which accept any id.
 *
 * The restored data is client data: it lives only in the hawa-chaos Postgres volume, which every
 * run removes (down -v) at its start and, unless --keep, at its end. Nothing here prints row values.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createDb, sql, type Database, type Kysely } from '@hawa/db';
import { PORTS, PROJECT, secrets, run as runCommand } from './stack.js';

const POSTGRES_CONTAINER = `${PROJECT}-postgres-1`;

function ownerUrl(database: string): string {
  return `postgresql://hawa_owner:${secrets().CHAOS_OWNER_PASSWORD}@127.0.0.1:${PORTS.postgres}/${database}`;
}

async function withClient<T>(database: string, fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDb(ownerUrl(database), { max: 1 });
  try { return await fn(db); } finally { await db.destroy().catch(() => undefined); }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
async function count(db: Kysely<Database>, text: string): Promise<number> {
  return Number((await sql.raw<{ n: number }>(text).execute(db)).rows[0].n);
}
async function tableExists(db: Kysely<Database>, table: string): Promise<boolean> {
  return (await sql<{ e: boolean }>`SELECT to_regclass(${`hawa.${table}`}) IS NOT NULL AS e`.execute(db)).rows[0].e;
}

function sha256File(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => ok(hash.digest('hex'))).on('error', fail);
  });
}

export interface SeedReport {
  dump: string;
  dumpBytes: number;
  checksum: 'verified' | 'absent';
  restoreMs: number;
  migrationsInDump: number;
  counts: Record<string, number>;
}

/**
 * Replaces the chaos database with the dump. Call after `up` of postgres (its init scripts made the
 * roles this restore needs: hawa_owner and hawa_app, whose login member is hawa_app_a) and before any
 * application container starts.
 */
export async function restoreDump(dump: string): Promise<SeedReport> {
  if (!existsSync(dump)) throw new Error(`--seed-dump: ${dump} does not exist`);
  let checksum: SeedReport['checksum'] = 'absent';
  if (existsSync(`${dump}.sha256`)) {
    const expected = readFileSync(`${dump}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if ((await sha256File(dump)) !== expected) throw new Error('--seed-dump: the dump does not match its .sha256');
    checksum = 'verified';
  }
  await withClient('postgres', async (db) => {
    await sql.raw('DROP DATABASE hawa_chaos WITH (FORCE)').execute(db);
    await sql.raw("CREATE DATABASE hawa_chaos OWNER hawa_owner TEMPLATE template0 ENCODING 'UTF8'").execute(db);
  });
  const started = Date.now();
  const result = await new Promise<{ code: number; errors: string[] }>((ok, fail) => {
    const child = spawn('docker', ['exec', '-i', POSTGRES_CONTAINER, 'pg_restore', '-U', 'hawa_owner', '-d', 'hawa_chaos', '--exit-on-error'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', fail);
    // Error classes only: a DETAIL or key text can quote row contents.
    child.on('close', (code) => ok({ code: code ?? 1, errors: stderr.split('\n').filter((l) => /error/i.test(l)).slice(0, 5)
      .map((l) => l.replace(/\bDETAIL:.*$/s, '').replace(/\([^)]*\)=\([^)]*\)/g, '(…)=(…)').slice(0, 200)) }));
    createReadStream(dump).pipe(child.stdin);
  });
  if (result.code !== 0) throw new Error(`--seed-dump: pg_restore failed (${result.code}): ${result.errors.join(' | ')}`);
  const restoreMs = Date.now() - started;
  const counts = await withClient('hawa_chaos', async (db) => {
    const out: Record<string, number> = {};
    for (const table of ['tenants', 'clients', 'client_dna_versions', 'tasks', 'outbox_commands', 'design_studio_calls', 'canva_design_plans', 'users']) {
      if (await tableExists(db, table)) out[table] = await count(db, `SELECT count(*)::int AS n FROM hawa.${table}`);
    }
    return out;
  });
  const migrationsInDump = await withClient('hawa_chaos', (db) => count(db, 'SELECT count(*)::int AS n FROM hawa.schema_upgrades'));
  return { dump: dump.split('/').pop()!, dumpBytes: statSync(dump).size, checksum, restoreMs, migrationsInDump, counts };
}

/** Columns that can hold a credential: text-like and named like one (token counters are integers). */
export const CREDENTIAL_COLUMN = /(token|secret|password|credential|api_?key|verifier|config_encrypted|private_key)/i;

export interface NeutraliseReport {
  removed: Record<string, number>;
  /** Credential-shaped columns checked for leftover values, and how many were found (must be 0). */
  credentialColumns: number;
  outboxDue: number;
}

/**
 * Removes what restored rows could use against a real service. Run after the upgrade and before
 * connectCanva(), which then stores the chaos operator's connection sealed with the chaos key.
 */
export async function neutralise(): Promise<NeutraliseReport> {
  return withClient('hawa_chaos', async (db) => {
    const removed: Record<string, number> = {};
    let credentialColumns = 0;
    await db.transaction().execute(async (trx) => {
      await sql.raw('SET LOCAL row_security = off').execute(trx);
      for (const table of ['canva_connections', 'canva_oauth_states', 'desk_sessions', 'office_oidc_flows']) {
        if (await tableExists(trx, table)) removed[table] = Number((await sql.raw(`DELETE FROM hawa.${table}`).execute(trx)).numAffectedRows ?? 0);
      }
      removed['integrations.config_encrypted'] = Number((await sql.raw('UPDATE hawa.integrations SET config_encrypted = NULL WHERE config_encrypted IS NOT NULL').execute(trx)).numAffectedRows ?? 0);
      // Anything credential-shaped left anywhere stops the run (the transaction rolls back): a new
      // secret column must be neutralised above before a run on such a dump.
      const columns = (await sql<{ table_name: string; column_name: string }>`SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='hawa' AND data_type IN ('text','character varying','bytea','jsonb','json')
            AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='hawa' AND table_type='BASE TABLE')`.execute(trx)).rows
        .filter((r) => CREDENTIAL_COLUMN.test(r.column_name));
      credentialColumns = columns.length;
      const left: string[] = [];
      for (const { table_name, column_name } of columns) {
        const n = await count(trx, `SELECT count(*)::int AS n FROM hawa.${ident(table_name)} WHERE ${ident(column_name)} IS NOT NULL`);
        if (n > 0) left.push(`${table_name}.${column_name} (${n})`);
      }
      if (left.length) throw new Error(`--seed-dump: restored credential-shaped values remain in ${left.join(', ')}; neutralise them in driver/seed.ts before running on this dump`);
    });
    const outboxDue = await count(db, "SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE state NOT IN ('delivered','dead')");
    return { removed, credentialColumns, outboxDue };
  });
}

export interface EgressProbe { container: string; checks: Array<{ name: string; ok: boolean; detail: string }> }

/**
 * Proves the network fence from inside the application containers, with the code they run (Node's
 * resolver and sockets): every provider host resolves to the fakes container, a host nobody faked
 * does not resolve, and a public address cannot be reached at all.
 */
export function verifyEgressFence(services: Array<'core' | 'worker-blue'> = ['core', 'worker-blue']): EgressProbe[] {
  const fakesIp = runCommand('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${PROJECT}_chaos").IPAddress}}`, `${PROJECT}-fakes-1`]).stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(fakesIp)) throw new Error('egress fence: the fakes container has no address on the chaos network');
  const providers = ['api.telegram.org', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.canva.com',
    'export-download.canva.com', 'document-export.canva.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com'];
  const unfaked = ['example.com', 'github.com', 'www.canva.com', 'drive.google.com', 'upload.googleapis.com'];
  const script = `
const dns = require('node:dns').promises, net = require('node:net');
const providers = ${JSON.stringify(providers)}, unfaked = ${JSON.stringify(unfaked)};
const connect = (host, port) => new Promise((ok) => { const s = net.connect({ host, port, timeout: 3000 });
  s.on('connect', () => { s.destroy(); ok('connected'); }); s.on('timeout', () => { s.destroy(); ok('timeout'); }); s.on('error', (e) => ok(e.code || 'error')); });
(async () => {
  const out = [];
  for (const h of providers) { const a = await dns.lookup(h, { all: true }).then((r) => r.map((x) => x.address)).catch((e) => [e.code]); out.push(['provider ' + h, a.join(',')]); }
  for (const h of unfaked) { const a = await dns.lookup(h).then((r) => r.address).catch((e) => e.code); out.push(['unfaked ' + h, a]); }
  out.push(['public 1.1.1.1:443', await connect('1.1.1.1', 443)]);
  out.push(['public 8.8.8.8:53', await connect('8.8.8.8', 53)]);
  console.log(JSON.stringify(out));
})();`;
  return services.map((service) => {
    const res = runCommand('docker', ['exec', `${PROJECT}-${service}-1`, 'node', '-e', script], { allowFail: true, timeoutMs: 60_000 });
    let rows: Array<[string, string]> = [];
    try { rows = JSON.parse(res.stdout.trim().split('\n').pop() || '[]'); } catch { /* reported below */ }
    const checks = rows.map(([name, value]) => {
      if (name.startsWith('provider ')) return { name, ok: value === fakesIp, detail: value === fakesIp ? 'the fakes' : `resolved to ${value}` };
      if (name.startsWith('unfaked ')) return { name, ok: !/^\d+\.\d+\.\d+\.\d+$/.test(value), detail: /^\d/.test(value) ? `resolved to ${value}` : value };
      return { name, ok: value !== 'connected', detail: value };
    });
    if (!checks.length) checks.push({ name: 'probe ran', ok: false, detail: (res.stderr || res.stdout).slice(-300) });
    return { container: service, checks };
  });
}
