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
  const pool = new pg.Pool({
    connectionString: connectionString || process.env.DATABASE_URL || 'postgres://hawa_app:secret@localhost:5432/hawa',
    max: 20,
    idleTimeoutMillis: 30000,
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
    await sql`SET LOCAL hawa.current_tenant_id = ${ctx.tenantId}`.execute(trx);
    if (ctx.clientId) {
      await sql`SET LOCAL hawa.current_client_id = ${ctx.clientId}`.execute(trx);
    }
    if (ctx.userId) {
      await sql`SET LOCAL hawa.current_user_id = ${ctx.userId}`.execute(trx);
    }
    if (ctx.role) {
      await sql`SET LOCAL hawa.current_role = ${ctx.role}`.execute(trx);
    }
    return await callback(trx);
  });
}
