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
}
