/**
 * The test suite has its own Postgres instance, `hawa-test-postgres` on 127.0.0.1:55432
 * (infra/docker/docker-compose.test.yml, provisioned by provision-isolated-test-db.ts). Until
 * 2026-09-18 the suite's databases lived on the production server, 127.0.0.1:54332, next to the
 * live `hawa` database: every `pnpm test` loaded the office's database, and the suites create and
 * drop cluster-wide roles. These checks keep a test process off that server.
 *
 * Nothing here imports pg, so vitest.config.ts can run it before any test file is loaded.
 */

/** The host port the production compose file publishes for its Postgres. */
export const PRODUCTION_POSTGRES_PORT = 54332;
/** The office's live database. */
export const PRODUCTION_DATABASE = 'hawa';
/** Container names the production compose project creates. */
export const PRODUCTION_CONTAINER_PREFIX = 'hawa-production-';

export const TEST_POSTGRES_CONTAINER = 'hawa-test-postgres';
export const TEST_POSTGRES_PORT = 55432;

export interface ConnectionTarget {
  host?: string;
  port?: number | string;
  database?: string;
}

/** Why a connection target is production, or null when it is not. */
export function productionTargetReason(target: ConnectionTarget): string | null {
  if (Number(target.port) === PRODUCTION_POSTGRES_PORT) {
    return `port ${PRODUCTION_POSTGRES_PORT} is the production Postgres server`;
  }
  if (target.database === PRODUCTION_DATABASE) {
    return `database "${PRODUCTION_DATABASE}" is the office's live database`;
  }
  return null;
}

/**
 * Parse a postgres URL the way pg resolves it: a missing port or database falls back to PGPORT
 * and PGDATABASE, so `postgresql://u:p@127.0.0.1/x` with PGPORT=54332 still reaches production.
 */
export function connectionTargetOf(url: string, env: Record<string, string | undefined> = {}): ConnectionTarget {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return {
    host: parsed.hostname || env.PGHOST,
    port: parsed.port || env.PGPORT || 5432,
    database: database || env.PGDATABASE || decodeURIComponent(parsed.username),
  };
}

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * Refuse a test environment in which any database variable reaches the production server or the
 * live database. Every variable whose value is a postgres URL is checked, not only the four the
 * suite is documented to use: tests also read DATABASE_URL (createDb's fallback) and the recovery
 * drill's POSTGRES_LIVE_URL / POSTGRES_OWNER_URL. Messages name variables, never credentials.
 */
export function assertTestDatabaseEnv(env: Record<string, string | undefined>): void {
  const problems: string[] = [];
  const pgDefaults = productionTargetReason({ port: env.PGPORT, database: env.PGDATABASE });
  if (pgDefaults) problems.push(`PGPORT/PGDATABASE: ${pgDefaults}`);
  for (const [name, value] of Object.entries(env)) {
    if (!value || !POSTGRES_URL.test(value)) continue;
    let reason: string | null;
    try {
      reason = productionTargetReason(connectionTargetOf(value, env));
    } catch {
      reason = 'value is not a parseable postgres URL';
    }
    if (reason) problems.push(`${name}: ${reason}`);
  }
  const container = env.POSTGRES_DRILL_CONTAINER;
  if (container?.startsWith(PRODUCTION_CONTAINER_PREFIX)) {
    problems.push(`POSTGRES_DRILL_CONTAINER: ${container} is a production container`);
  }
  if (problems.length) {
    throw new Error(
      `Refusing to run tests against the production Postgres server:\n  - ${problems.join('\n  - ')}\n` +
        `Tests use hawa-test-postgres on 127.0.0.1:${TEST_POSTGRES_PORT}. Provision it with ` +
        '`pnpm test:db` and print the .env.test lines with `pnpm test:db --print-env`.'
    );
  }
}
