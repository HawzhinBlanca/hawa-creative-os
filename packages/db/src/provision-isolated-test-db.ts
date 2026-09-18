/**
 * Provision the test suite's own Postgres server, `hawa-test-postgres` on 127.0.0.1:55432
 * (infra/docker/docker-compose.test.yml), and its two disposable databases:
 *   - hawa_test   used by the plain suite (TEST_DATABASE_URL, TEST_DATABASE_OWNER_URL);
 *   - hawa_repair used by the DB-gated suites (HAWA_ISOLATED_TEST_DB, HAWA_ISOLATED_RUNTIME_DB),
 *     which refuse any other database name.
 * Both get schema, RLS, seed, runtime grants and the versioned upgrades production runs; hawa_test
 * also gets db/test-fixtures.sql.
 *
 * Usage (from the repository root):
 *   pnpm test:db               start the server if needed, create missing databases
 *   pnpm test:db --recreate    drop and rebuild both databases
 *   pnpm test:db --print-env   print the four .env.test lines (they contain the test passwords)
 *
 * The credentials are generated on first use into ~/.hawa/test-postgres.env (mode 0600), shared by
 * every checkout and worktree on this machine, and are used by nothing but this server; no
 * production credential works here and no test credential works on production. POSTGRES_ADMIN_URL,
 * which earlier versions took, is ignored: the script cannot be pointed at another server.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  TEST_POSTGRES_CONTAINER,
  TEST_POSTGRES_PORT,
  connectionTargetOf,
  productionTargetReason,
} from './test-database-guard.js';

const DATABASES = ['hawa_test', 'hawa_repair'] as const;
const OWNER_ROLE = 'hawa_owner';
const APP_ROLE = 'hawa_app';
const COMPOSE_FILE = 'infra/docker/docker-compose.test.yml';
const CREDENTIALS_FILE = resolve(homedir(), '.hawa', 'test-postgres.env');

/** Database names this tool is permitted to destroy. Anything else is refused. */
const DROPPABLE_NAME = /^hawa_(repair|test|drill|isolated)[a-z0-9_]*$/;

export function assertSafeToDrop(name: string): void {
  if (!DROPPABLE_NAME.test(name)) {
    throw new Error(
      `Refusing to DROP DATABASE "${name}": only databases matching ${DROPPABLE_NAME} may be ` +
        `destroyed by this tool. The production database is 'hawa'.`
    );
  }
}

interface Credentials {
  ownerPassword: string;
  appPassword: string;
}

/** Read the machine's test-server credentials, generating them on first use. */
function loadOrCreateCredentials(): Credentials {
  if (!existsSync(CREDENTIALS_FILE)) {
    mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
    const secret = () => randomBytes(24).toString('base64url');
    writeFileSync(
      CREDENTIALS_FILE,
      '# Credentials of the hawa-test-postgres server only (pnpm test:db). Nothing in production uses them.\n' +
        `HAWA_TEST_POSTGRES_PASSWORD=${secret()}\nHAWA_TEST_APP_PASSWORD=${secret()}\n`,
      { mode: 0o600 }
    );
    console.log(`generated test credentials in ${CREDENTIALS_FILE}`);
  }
  chmodSync(CREDENTIALS_FILE, 0o600);
  const values: Record<string, string> = {};
  for (const line of readFileSync(CREDENTIALS_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=([A-Za-z0-9_-]+)$/.exec(line.trim());
    if (m) values[m[1]] = m[2];
  }
  const ownerPassword = values.HAWA_TEST_POSTGRES_PASSWORD;
  const appPassword = values.HAWA_TEST_APP_PASSWORD;
  if (!ownerPassword || !appPassword) {
    throw new Error(`${CREDENTIALS_FILE} must define HAWA_TEST_POSTGRES_PASSWORD and HAWA_TEST_APP_PASSWORD`);
  }
  return { ownerPassword, appPassword };
}

function testUrl(role: string, password: string, database: string): string {
  const url = `postgresql://${role}:${password}@127.0.0.1:${TEST_POSTGRES_PORT}/${database}`;
  // Built from constants today; checked anyway, because the cost of a wrong edit here is production.
  const reason = productionTargetReason(connectionTargetOf(url));
  if (reason) throw new Error(`Refusing to provision ${database}: ${reason}`);
  return url;
}

/** The four lines `.env.test` needs. They carry the test passwords, so they are printed only on request. */
export function envTestLines({ ownerPassword, appPassword }: Credentials): string[] {
  return [
    `TEST_DATABASE_URL=${testUrl(APP_ROLE, appPassword, 'hawa_test')}`,
    `TEST_DATABASE_OWNER_URL=${testUrl(OWNER_ROLE, ownerPassword, 'hawa_test')}`,
    `HAWA_ISOLATED_TEST_DB=${testUrl(OWNER_ROLE, ownerPassword, 'hawa_repair')}`,
    `HAWA_ISOLATED_RUNTIME_DB=${testUrl(APP_ROLE, appPassword, 'hawa_repair')}`,
  ];
}

function startServer(root: string): void {
  execFileSync(
    'docker',
    ['compose', '-f', resolve(root, COMPOSE_FILE), '--env-file', CREDENTIALS_FILE, 'up', '-d', '--wait', 'postgres'],
    { stdio: 'inherit' }
  );
}

/**
 * Set both role passwords from the credentials file over the container's local socket, which the
 * image trusts. The server then always matches the file, even when the volume predates it.
 */
function syncRoles(credentials: Credentials): void {
  const sql = `
ALTER ROLE ${OWNER_ROLE} WITH PASSWORD '${credentials.ownerPassword}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} LOGIN; END IF;
END $$;
ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${credentials.appPassword}';
`;
  execFileSync(
    'docker',
    ['exec', '-i', TEST_POSTGRES_CONTAINER, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', OWNER_ROLE, '-d', 'postgres'],
    { input: sql, stdio: ['pipe', 'inherit', 'inherit'] }
  );
}

async function provisionDatabase(root: string, credentials: Credentials, name: (typeof DATABASES)[number], recreate: boolean) {
  const maint = new pg.Client({ connectionString: testUrl(OWNER_ROLE, credentials.ownerPassword, 'postgres'), connectionTimeoutMillis: 10000 });
  await maint.connect();
  try {
    const exists = (await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
    if (exists && !recreate) {
      console.log(`${name} already exists; pass --recreate to drop and rebuild it.`);
      return;
    }
    if (exists) {
      // This project has already lost its production database once. The name is a constant, but
      // it is checked at the point of destruction rather than trusted.
      assertSafeToDrop(name);
      await maint.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
      await maint.query(`DROP DATABASE ${name}`);
      console.log(`dropped ${name}`);
    }
    await maint.query(`CREATE DATABASE ${name}`);
    console.log(`created ${name}`);
  } finally {
    await maint.end().catch(() => {});
  }

  const target = testUrl(OWNER_ROLE, credentials.ownerPassword, name);
  const client = new pg.Client({ connectionString: target, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    for (const file of ['db/schema.sql', 'db/rls.sql', 'db/seed.sql']) {
      await client.query(readFileSync(resolve(root, file), 'utf8'));
      console.log(`${name}: applied ${file}`);
    }
    // The application role uses the disposable database exactly like the office database. The
    // versioned upgrades below grant their own tables narrowly, so this runs before them.
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA hawa TO ${APP_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hawa TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hawa TO ${APP_ROLE}`);
    console.log(`${name}: granted runtime privileges to ${APP_ROLE}`);
  } finally {
    await client.end().catch(() => {});
  }

  // Versioned upgrades are applied through the same runner production uses.
  const { upgradeCanvaSchema } = await import('./upgrade.js');
  const result = await upgradeCanvaSchema(target);
  console.log(`${name}: versioned upgrades applied=${result.applied.length} verified=${result.verified.length}`);
}

/**
 * The plain suite's own rows, on every run: the file is idempotent, so an existing hawa_test
 * converges too. hawa_repair stays exactly schema + seed, which its suites assume.
 */
async function applyFixtures(root: string, credentials: Credentials) {
  const client = new pg.Client({ connectionString: testUrl(OWNER_ROLE, credentials.ownerPassword, 'hawa_test'), connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query(readFileSync(resolve(root, 'db/test-fixtures.sql'), 'utf8'));
    console.log('hawa_test: applied db/test-fixtures.sql');
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const root = process.cwd();
  if (!existsSync(resolve(root, COMPOSE_FILE))) {
    throw new Error(`run from the repository root (${COMPOSE_FILE} not found in ${root})`);
  }
  if (process.env.POSTGRES_ADMIN_URL) {
    console.log('POSTGRES_ADMIN_URL is ignored: this script provisions hawa-test-postgres only.');
  }
  const credentials = loadOrCreateCredentials();
  if (process.argv.includes('--print-env')) {
    console.log(envTestLines(credentials).join('\n'));
    return;
  }
  const recreate = process.argv.includes('--recreate');
  startServer(root);
  syncRoles(credentials);
  for (const name of DATABASES) await provisionDatabase(root, credentials, name, recreate);
  await applyFixtures(root, credentials);
  console.log(`ready: ${DATABASES.join(', ')} on ${TEST_POSTGRES_CONTAINER} (127.0.0.1:${TEST_POSTGRES_PORT})`);
  console.log('.env.test needs the lines printed by: pnpm test:db --print-env');
}

// Only run when this file is the entry point: it exports assertSafeToDrop, and importing it for
// that must not attempt to provision or drop a database. The qualification runner had exactly this
// shape, and importing it for its brief list launched a paid twenty-brief run.
const isEntryPoint = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('provisioning failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
