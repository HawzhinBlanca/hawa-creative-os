import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export class ClientRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(tenantId: string, clientId: string) {
    return await this.db
      .selectFrom('clients')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', clientId)
      .executeTakeFirst();
  }

  async findByCode(tenantId: string, code: string) {
    return await this.db
      .selectFrom('clients')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('code', '=', code)
      .executeTakeFirst();
  }

  async resolveChannelMapping(tenantId: string, adapterKind: string, accountId: string, channelId: string) {
    return await this.db
      .selectFrom('client_channels')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('adapter_kind', '=', adapterKind)
      .where('account_id', '=', accountId)
      .where('channel_id', '=', channelId)
      .where('active', '=', true)
      .executeTakeFirst();
  }

  async listActive(tenantId: string) {
    return await this.db
      .selectFrom('clients')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .execute();
  }

  async findActiveDna(tenantId: string, clientId: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .selectFrom('client_dna_versions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  async findDnaByVersion(tenantId: string, clientId: string, version: number, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .selectFrom('client_dna_versions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .where('version', '=', version)
      .executeTakeFirst();
  }

  async listDnaSnapshots(tenantId: string, clientId: string, trx?: Kysely<Database>) {
    const client = trx || this.db;
    return await client
      .selectFrom('client_dna_versions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .orderBy('version', 'desc')
      .execute();
  }

  async saveDnaVersion(params: {
    tenantId: string;
    clientId: string;
    version: number;
    dna: any;
    contentHash: string;
    createdBy?: string | null;
    approvedBy?: string | null;
    expectedVersion?: number;
  }, outerTrx?: Kysely<Database>) {
    const run = async (trx: Kysely<Database>) => {
      // 1. Optimistic concurrency check
      const current = await trx
        .selectFrom('client_dna_versions')
        .select(['version'])
        .where('tenant_id', '=', params.tenantId)
        .where('client_id', '=', params.clientId)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();

      if (params.expectedVersion !== undefined) {
        const currentVer = current?.version ?? 0;
        if (currentVer !== params.expectedVersion) {
          throw new Error(`OptimisticConcurrencyConflict: expected version ${params.expectedVersion} but current active version is ${currentVer}`);
        }
      }

      // 2. Mark previous active version as superseded
      await trx
        .updateTable('client_dna_versions')
        .set({ status: 'superseded' })
        .where('tenant_id', '=', params.tenantId)
        .where('client_id', '=', params.clientId)
        .where('status', '=', 'active')
        .execute();

      // 3. Insert new active version (upsert on duplicate version to ensure idempotency)
      const inserted = await trx
        .insertInto('client_dna_versions')
        .values({
          tenant_id: params.tenantId,
          client_id: params.clientId,
          version: params.version,
          status: 'active',
          dna: JSON.stringify(params.dna),
          content_hash: params.contentHash,
          created_by: params.createdBy || null,
          approved_by: params.approvedBy || null,
        })
        .onConflict((oc) => oc
          .columns(['client_id', 'version'])
          .doUpdateSet({
            status: 'active',
            dna: JSON.stringify(params.dna),
            content_hash: params.contentHash,
            created_by: params.createdBy || null,
            approved_by: params.approvedBy || null,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      return inserted;
    };

    if (outerTrx) {
      return await run(outerTrx);
    }
    return await this.db.transaction().execute(run);
  }
}
