/**
 * Provision the disposable `hawa_repair` database used by the DB-gated Vitest suites
 * (canva-design-planner, canva-connect-live-boundary, chat-intake-durability,
 * ship-binding-isolation, schema-upgrade). Those suites refuse any database whose
 * name is not `hawa_repair`, so this script refuses any other target too.
 *
 * Usage:
 *   POSTGRES_ADMIN_URL=postgresql://<owner>:<password>@127.0.0.1:54332/postgres \
 *     npx tsx packages/db/src/provision-isolated-test-db.ts [--recreate]
 *
 * The credential comes only from the environment. Nothing is printed except progress.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const DB_NAME = 'hawa_repair';
const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) {
  console.error('POSTGRES_ADMIN_URL is required (owner connection to the `postgres` maintenance database).');
  process.exit(2);
}
const ADMIN_URL: string = adminUrl;
const admin = new URL(ADMIN_URL);
if (admin.pathname === `/${DB_NAME}`) {
  console.error('POSTGRES_ADMIN_URL must point at the maintenance database, not hawa_repair itself.');
  process.exit(2);
}
const recreate = process.argv.includes('--recreate');
const root = resolve(process.cwd());
const files = ['db/schema.sql', 'db/rls.sql', 'db/seed.sql'].map((f) => resolve(root, f));

async function main() {
  const maint = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 10000 });
  await maint.connect();
  try {
    const exists = (await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME])).rowCount === 1;
    if (exists && !recreate) {
      console.log(`${DB_NAME} already exists; pass --recreate to drop and rebuild it.`);
      return;
    }
    if (exists) {
      await maint.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_NAME]);
      await maint.query(`DROP DATABASE ${DB_NAME}`);
      console.log(`dropped ${DB_NAME}`);
    }
    await maint.query(`CREATE DATABASE ${DB_NAME}`);
    console.log(`created ${DB_NAME}`);
  } finally {
    await maint.end().catch(() => {});
  }

  const target = new URL(ADMIN_URL);
  target.pathname = `/${DB_NAME}`;
  const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(file, 'utf8');
      await client.query(sql);
      console.log(`applied ${file.replace(root + '/', '')}`);
    }
    // The application role must be able to use the disposable database exactly like the office database.
    const appRole = process.env.HAWA_DB_USER || 'hawa_app';
    const hasRole = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole])).rowCount === 1;
    if (hasRole) {
      await client.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${appRole}`);
      await client.query(`GRANT USAGE ON SCHEMA hawa TO ${appRole}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hawa TO ${appRole}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hawa TO ${appRole}`);
      console.log(`granted runtime privileges to ${appRole}`);
    }
  } finally {
    await client.end().catch(() => {});
  }

  // Versioned Canva upgrades are applied through the same runner production uses.
  const { upgradeCanvaSchema } = await import('./upgrade.js');
  const result = await upgradeCanvaSchema(target.href);
  console.log(`versioned upgrades applied=${result.applied.length} verified=${result.verified.length}`);
  console.log(`ready: ${DB_NAME}`);
}

main().catch((err) => {
  console.error('provisioning failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
