import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export interface IngressEventParams {
  adapterKind: string;
  sourceEventId: string;
  payloadHash: string;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
  verified: boolean;
}

export class IngressRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findBySourceEventId(adapterKind: string, sourceEventId: string) {
    return await this.db
      .selectFrom('raw_ingress_events')
      .selectAll()
      .where('adapter_kind', '=', adapterKind)
      .where('source_event_id', '=', sourceEventId)
      .executeTakeFirst();
  }

  async recordEvent(params: IngressEventParams) {
    const existing = await this.findBySourceEventId(params.adapterKind, params.sourceEventId);
    if (existing) {
      return { event: existing, isDuplicate: true };
    }

    const event = await this.db
      .insertInto('raw_ingress_events')
      .values({
        adapter_kind: params.adapterKind,
        source_event_id: params.sourceEventId,
        payload_hash: params.payloadHash,
        headers: params.headers,
        body: params.body,
        verified: params.verified,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { event, isDuplicate: false };
  }
}
