import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Database } from './types.js';
import pg from 'pg';

export interface RlsContext {
  tenantId: string;
  clientId?: string;
  userId?: string;
  role?: string;
}

export function createDb(connectionString?: string): Kysely<Database> {
  const resolved = connectionString || process.env.DATABASE_URL;
  if (!resolved) throw new Error('createDb requires a connection string or DATABASE_URL; there is no default database');
  const pool = new pg.Pool({
    connectionString: resolved,
    max: 20,
    idleTimeoutMillis: 30000,
  });

  pool.on('connect', (client) => {
    client.query('SET search_path TO hawa, public');
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

export async function withRlsContext<T>(
  db: Kysely<Database>,
  ctx: RlsContext,
  callback: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (trx) => {
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
  });
}
