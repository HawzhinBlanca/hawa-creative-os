import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';

/** The tenant the outbox serves when TENANT_IDS is unset (OutboxConsumer's own default). */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

/**
 * The tenants this worker's outbox acts in, read from the environment as index.ts starts it: the
 * TENANT_IDS list, or else the consumer's default tenant (HAWA_TENANT_ID only picks /health's tenant).
 */
export function servedTenantIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.TENANT_IDS || env.HAWA_TENANT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [DEFAULT_TENANT_ID];
}

/**
 * The served tenants in which System Automation holds no active operator membership. The worker acts
 * as that user, and RLS lets a user see a tenant's rows only through a membership. Migration 012 gave
 * it one in every tenant that existed then; nothing adds one for a tenant created later, where the
 * worker would find no outbox commands and say nothing about it (review of 2026-09-24).
 */
export async function automationMembershipGaps(db: Kysely<Database>, tenantIds: string[]): Promise<string[]> {
  const gaps: string[] = [];
  for (const tenantId of tenantIds) {
    // Read as the worker reads: RLS shows a user its own membership rows in the tenant it acts in.
    const member = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ ok: number }>`SELECT 1 AS ok FROM hawa.tenant_memberships
        WHERE tenant_id = ${tenantId}::uuid AND user_id = ${SYSTEM_AUTOMATION_USER_ID}::uuid
          AND role = 'operator' AND active LIMIT 1`.execute(trx)).rows.length > 0);
    if (!member) gaps.push(tenantId);
  }
  return gaps;
}
