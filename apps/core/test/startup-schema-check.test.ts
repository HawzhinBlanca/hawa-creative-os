import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql, type Database, type Kysely } from '@hawa/db';
import { checkSchemaUpgrades, describeMissingUpgrades, expectedUpgrades } from '../src/schema-check.js';

/**
 * Core on a database the versioned upgrades have not reached (chaos harness, 2026-09-24): a fresh
 * data directory gets db/schema.sql from the postgres init scripts, and deploy.sh runs the upgrades
 * later. Core must stop with one clear line naming what is missing and a non-zero exit (compose
 * restarts it), never open its port on a half-built schema or die of an unhandled rejection.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAST = '089_customer_acceptance_downloads.sql';
// The upgrade that grants the app role its read of hawa.schema_upgrades (schema-check.ts): when the
// read is denied, it and every later upgrade count as missing.
const GRANTING = '020_inbox_event_dedupe.sql';

/** Rolls back whatever `fn` did as the schema owner. */
async function rolledBack<T>(owner: Kysely<Database>, fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  let result: T;
  await owner.transaction().execute(async (trx) => {
    result = await fn(trx);
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((err) => { if (!err?.rollback) throw err; });
  return result!;
}

/** Starts the real entrypoint against `databaseUrl` and waits for it to exit (or 60 s). */
function startCore(databaseUrl: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'apps/core/src/index.ts'], {
      cwd: root,
      // Enough configuration for createApp to get as far as the database, so that on code without
      // the check this test sees what a real start did, not a missing setting. No Telegram token:
      // nothing is polled.
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1',
        NODE_ENV: 'production', HAWA_ACTION_HMAC_SECRET: ['startup', 'check', 'fixture', 'hmac'].join('_'),
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

describe.skipIf(!appUrl || !ownerUrl)('Core checks the versioned upgrades before it starts', () => {
  let app: Kysely<Database>;
  let owner: Kysely<Database>;
  beforeAll(() => {
    app = createDb(appUrl!);
    owner = createDb(ownerUrl!);
  });
  afterAll(async () => {
    await app?.destroy();
    await owner?.destroy();
  });

  it('knows every upgrade this build carries, in order', () => {
    const names = expectedUpgrades();
    expect(names[0]).toBe('001_canva_bindings.sql');
    expect(names.at(-1)).toBe(LAST);
    expect(names.some((n) => n.endsWith('_down.sql'))).toBe(false);
  });

  it('passes a database with every upgrade applied, read as the app role', async () => {
    await expect(checkSchemaUpgrades(app, expectedUpgrades())).resolves.toEqual({ ok: true, applied: expectedUpgrades().length });
  });

  it('names the upgrades a database has not had', async () => {
    const check = await rolledBack(owner, async (trx) => {
      await sql`DELETE FROM hawa.schema_upgrades WHERE name IN ('019_blob_store.sql', ${LAST})`.execute(trx);
      return checkSchemaUpgrades(trx, expectedUpgrades());
    });
    expect(check).toMatchObject({ ok: false, missing: ['019_blob_store.sql', LAST] });
    expect(describeMissingUpgrades(check as Extract<typeof check, { ok: false }>)).toContain(`missing versioned upgrades 019_blob_store.sql, ${LAST}`);
  });

  it('says no upgrade has run when their table is not there, and that 020 has not run when it cannot be read', async () => {
    const none = await rolledBack(owner, async (trx) => {
      await sql`ALTER TABLE hawa.schema_upgrades RENAME TO schema_upgrades_hidden`.execute(trx);
      return checkSchemaUpgrades(trx, expectedUpgrades());
    });
    expect(none).toMatchObject({ ok: false, missing: expectedUpgrades(), reason: expect.stringContaining('no versioned upgrade has run') });
    const denied = await rolledBack(owner, async (trx) => {
      await sql`REVOKE SELECT ON hawa.schema_upgrades FROM hawa_app`.execute(trx);
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);
      return checkSchemaUpgrades(trx, expectedUpgrades());
    });
    expect(denied).toMatchObject({ ok: false, missing: expectedUpgrades().slice(expectedUpgrades().indexOf(GRANTING)), reason: expect.stringContaining(`${GRANTING} has not run`) });
  });

  it('does not call an unreachable database a missing upgrade', async () => {
    // A login that does not exist, on a database that does not exist.
    const unreachable = new URL('postgresql://127.0.0.1:55432/hawa_t_nonexistent_0');
    unreachable.username = 'nobody';
    unreachable.password = ['not', 'a', 'login'].join('_');
    const nowhere = createDb(unreachable.toString(), { max: 1 });
    try {
      await expect(checkSchemaUpgrades(nowhere, expectedUpgrades())).rejects.toThrow();
    } finally {
      await nowhere.destroy();
    }
  });

  it('the entrypoint logs one line naming the missing upgrade and exits 1 without serving', async () => {
    await sql`UPDATE hawa.schema_upgrades SET name = 'renamed-for-test' WHERE name = ${LAST}`.execute(owner);
    try {
      const { code, out } = await startCore(appUrl!);
      const fatal = out.split('\n').filter((l) => /"level":"fatal"|FATAL/.test(l));
      expect({ code, fatal: fatal.length }).toEqual({ code: 1, fatal: 1 });
      expect(fatal[0]).toContain(`missing versioned upgrade ${LAST}`);
      expect(out).not.toMatch(/unhandledRejection|uncaughtException|Starting Hawa Core API/);
    } finally {
      await sql`UPDATE hawa.schema_upgrades SET name = ${LAST} WHERE name = 'renamed-for-test'`.execute(owner);
    }
  }, 90_000);

  it('the entrypoint says so when no upgrade has run at all', async () => {
    await sql`ALTER TABLE hawa.schema_upgrades RENAME TO schema_upgrades_hidden`.execute(owner);
    try {
      const { code, out } = await startCore(appUrl!);
      const fatal = out.split('\n').filter((l) => /"level":"fatal"|FATAL/.test(l));
      expect({ code, fatal: fatal.length }).toEqual({ code: 1, fatal: 1 });
      expect(fatal[0]).toContain('001_canva_bindings.sql');
      expect(fatal[0]).toContain('no versioned upgrade has run');
      expect(out).not.toMatch(/unhandledRejection|uncaughtException|Starting Hawa Core API/);
    } finally {
      await sql`ALTER TABLE hawa.schema_upgrades_hidden RENAME TO schema_upgrades`.execute(owner);
    }
  }, 90_000);
});

/**
 * The case the chaos harness met (2026-09-24): a database exactly as a fresh production data directory
 * leaves it before deploy.sh migrates (docker-compose.prod.yml's init files through psql, no
 * upgrades). Core died of an unhandled rejection there (relation "client_dna_versions" does not
 * exist); now it names the upgrades and exits 1.
 */
const container = process.env.POSTGRES_DRILL_CONTAINER || 'hawa-test-postgres';
if (container.startsWith('hawa-production-')) throw new Error(`refusing to build a database in ${container}`);
const containerRunning = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).stdout?.trim() === 'true';
const INIT_FILES = ['infra/docker/00-init-roles.sql', 'db/schema.sql', 'db/rls.sql', 'db/03-grants.sql', 'db/seed.sql'];
/** A name the per-file database guard accepts and the global setup prunes if this run is killed. */
const freshName = `hawa_t_${Math.floor(Date.now() / 1000).toString(36)}${randomBytes(3).toString('hex')}_${process.pid}`;
const onDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

describe.skipIf(!appUrl || !ownerUrl || !containerRunning)('Core on a fresh production database before deploy.sh migrates', () => {
  let server: Kysely<Database>;
  beforeAll(async () => {
    server = createDb(onDatabase(ownerUrl!, 'postgres'), { max: 1 });
    await sql`CREATE DATABASE ${sql.id(freshName)} TEMPLATE template0 ENCODING 'UTF8'`.execute(server);
    const owner = new URL(ownerUrl!).username;
    for (const file of INIT_FILES) {
      // As the postgres image's entrypoint runs them; the app URL reaches psql through the environment.
      const res = spawnSync('docker', ['exec', '-i', '-e', 'HAWA_APP_DATABASE_URL', container,
        'psql', '-v', 'ON_ERROR_STOP=1', '--username', owner, '--no-password', '--no-psqlrc', '--dbname', freshName, '-f', '-'], {
        input: readFileSync(path.join(root, file)),
        env: { ...process.env, HAWA_APP_DATABASE_URL: appUrl },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.status !== 0) throw new Error(`${file} failed in a fresh database: ${String(res.stderr).trim().slice(0, 2000)}`);
    }
  }, 180_000);
  afterAll(async () => {
    await sql`DROP DATABASE IF EXISTS ${sql.id(freshName)} WITH (FORCE)`.execute(server).catch(() => {});
    await server?.destroy();
  }, 60_000);

  it('logs one line naming every upgrade, exits 1, and never dies of an unhandled rejection', async () => {
    const { code, out } = await startCore(onDatabase(appUrl!, freshName));
    const fatal = out.split('\n').filter((l) => /"level":"fatal"|FATAL/.test(l));
    expect({ code, fatal: fatal.length }).toEqual({ code: 1, fatal: 1 });
    expect(fatal[0]).toContain('no versioned upgrade has run');
    for (const name of expectedUpgrades()) expect(fatal[0]).toContain(name);
    expect(out).not.toMatch(/unhandledRejection|uncaughtException|Starting Hawa Core API/);
  }, 90_000);
});
