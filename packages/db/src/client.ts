import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Database } from './types.js';
import pg from 'pg';

export interface RlsContext {
  tenantId: string;
  clientId?: string;
  userId?: string;
  role?: string;
}

/** `options.max` bounds the pool; tests use 1 to prove a code path holds no second connection. */
export function createDb(connectionString?: string, options: { max?: number } = {}): Kysely<Database> {
  const resolved = connectionString || process.env.DATABASE_URL;
  if (!resolved) throw new Error('createDb requires a connection string or DATABASE_URL; there is no default database');
  const pool = new pg.Pool({
    connectionString: resolved,
    max: options.max ?? 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  attachPoolErrorLogging(pool);

  pool.on('connect', (client) => {
    client
      .query("SET search_path TO hawa, public; SET statement_timeout TO '15s'; SET idle_in_transaction_session_timeout TO '30s';")
      .catch((err) => console.error('[db:pool] Could not apply session settings:', describePoolError(err)));
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

/**
 * One line for a pool or connection error: its code and message, never the error object. pg attaches
 * the Client to an idle-client error (`err.client`), and logging the error printed that whole object,
 * connection parameters included, on 2026-09-30 (ADR-158).
 */
export function describePoolError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  return `${typeof code === 'string' ? `${code} ` : ''}${err.message}`;
}

/** Error listeners for a pg.Pool: its idle clients' errors and those of every client it connects. */
export function attachPoolErrorLogging(pool: pg.Pool): void {
  pool.on('error', (err) => {
    console.error('[db:pool] Unexpected error on idle client:', describePoolError(err));
  });
  pool.on('connect', (client) => {
    // The pool's own 'error' event covers idle clients only. A connection that dies while checked
    // out (a PostgreSQL restart, pg_terminate_backend, a dropped socket) emits 'error' on the client,
    // and an EventEmitter with no listener for it throws: one database restart would take Core down
    // through uncaughtException. The query in flight still rejects, so the caller sees the failure.
    client.on('error', (err) => {
      console.error('[db:pool] Connection lost while in use:', describePoolError(err));
    });
  });
}

export async function withRlsContext<T>(
  db: Kysely<Database>,
  ctx: RlsContext,
  callback: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  const runner = async (trx: Kysely<Database>) => {
    await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`.execute(trx);
    await sql`SELECT set_config('hawa.current_tenant_id', ${ctx.tenantId}, true)`.execute(trx);
    if (ctx.clientId) {
      await sql`SELECT set_config('app.client_id', ${ctx.clientId}, true)`.execute(trx);
      await sql`SELECT set_config('hawa.current_client_id', ${ctx.clientId}, true)`.execute(trx);
    }
    if (ctx.userId) {
      await sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
      await sql`SELECT set_config('hawa.current_user_id', ${ctx.userId}, true)`.execute(trx);
    }
    if (ctx.role) {
      await sql`SELECT set_config('app.role', ${ctx.role}, true)`.execute(trx);
      await sql`SELECT set_config('hawa.current_role', ${ctx.role}, true)`.execute(trx);
    }
    return await callback(trx);
  };

  if ((db as any).isTransaction) {
    return await runner(db);
  }
  return await db.transaction().execute(runner);
}

