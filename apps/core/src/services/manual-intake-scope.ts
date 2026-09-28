import { sql, type Database, type Kysely } from '@hawa/db';

export class ManualIntakeScopeError extends Error {}

/** Recheck under the same transaction that creates the task/event/outbox, after exact replay. */
export async function prepareManualIntake(trx: Kysely<Database>, input: {
  tenantId: string; clientId: string; projectId?: string | null;
}): Promise<Record<string, unknown>> {
  const client = await trx.selectFrom('clients').select('id')
    .where('tenant_id', '=', input.tenantId).where('id', '=', input.clientId).where('status', '=', 'active')
    .where(sql<boolean>`hawa.can_write_client(${input.tenantId}::uuid,${input.clientId}::uuid)`)
    .forShare().executeTakeFirst();
  if (!client) throw new ManualIntakeScopeError('The selected client is unavailable or cannot accept requests from this account');
  if (input.projectId) {
    const project = await trx.selectFrom('projects').select('id').where('tenant_id', '=', input.tenantId)
      .where('client_id', '=', input.clientId).where('id', '=', input.projectId).where('status', '=', 'active')
      .forShare().executeTakeFirst();
    if (!project) throw new ManualIntakeScopeError('The selected project is unavailable in this client scope');
  }
  const dna = await trx.selectFrom('client_dna_versions').select('version').where('tenant_id', '=', input.tenantId)
    .where('client_id', '=', input.clientId).where('status', '=', 'active').forShare().executeTakeFirst();
  if (!dna) throw new ManualIntakeScopeError('The selected client has no active brand DNA');
  return { clientDnaVersion: dna.version };
}
