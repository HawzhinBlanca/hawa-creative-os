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

export interface RecordInboxEventParams {
  tenantId: string;
  integrationId?: string | null;
  sourceAccountId: string;
  sourceEventId: string;
  sourceSequence?: string | null;
  eventKind: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  verified: boolean;
  occurredAt?: Date | null;
  processingError?: string | null;
}

export interface RecordMessageEventParams {
  tenantId: string;
  inboxEventId?: string | null;
  integrationId?: string | null;
  externalAccountId: string;
  externalChannelId: string;
  externalThreadId?: string | null;
  externalMessageId: string;
  externalRevisionId?: string;
  senderExternalId?: string | null;
  mappedUserId?: string | null;
  language?: string | null;
  direction?: 'ltr' | 'rtl' | 'auto' | null;
  textOriginal?: string;
  entities?: unknown[];
  rawPayloadEncrypted?: Buffer | null;
  occurredAt?: Date | null;
  receivedAt?: Date;
}

export interface RecordAttachmentParams {
  tenantId: string;
  messageEventId: string;
  sourceAttachmentId?: string | null;
  filename: string;
  mimeType: string;
  byteSize: number | bigint;
  sha256: string;
  storageKey: string;
  scanState?: 'pending' | 'clean' | 'quarantined' | 'rejected';
  metadata?: Record<string, unknown>;
}

export class IngressRepository {
  constructor(private readonly db: Kysely<Database>) {}

  // Legacy fallback for backward compatibility
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

  // --- Production Ingress Repository Methods ---

  async findInboxEvent(
    tenantId: string,
    integrationId: string | null | undefined,
    sourceAccountId: string,
    sourceEventId: string,
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    let query = client
      .selectFrom('inbox_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_account_id', '=', sourceAccountId)
      .where('source_event_id', '=', sourceEventId);

    if (integrationId) {
      query = query.where('integration_id', '=', integrationId);
    }
    return await query.executeTakeFirst();
  }

  async recordInboxEvent(
    params: RecordInboxEventParams,
    trx?: Kysely<Database>
  ): Promise<{ event: any; isDuplicate: boolean }> {
    const client = trx || this.db;
    const existing = await this.findInboxEvent(
      params.tenantId,
      params.integrationId,
      params.sourceAccountId,
      params.sourceEventId,
      client
    );
    if (existing) {
      return { event: existing, isDuplicate: true };
    }

    const event = await client
      .insertInto('inbox_events')
      .values({
        tenant_id: params.tenantId,
        integration_id: params.integrationId || null,
        source_account_id: params.sourceAccountId,
        source_event_id: params.sourceEventId,
        source_sequence: params.sourceSequence || null,
        event_kind: params.eventKind,
        payload: params.payload,
        payload_hash: params.payloadHash,
        verified: params.verified,
        occurred_at: params.occurredAt || null,
        processing_error: params.processingError || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { event, isDuplicate: false };
  }

  async findMessageEvent(
    tenantId: string,
    params: {
      integrationId?: string | null;
      externalAccountId: string;
      externalChannelId: string;
      externalMessageId: string;
      externalRevisionId?: string;
    },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const revId = params.externalRevisionId || '';
    let query = client
      .selectFrom('message_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('external_account_id', '=', params.externalAccountId)
      .where('external_channel_id', '=', params.externalChannelId)
      .where('external_message_id', '=', params.externalMessageId)
      .where('external_revision_id', '=', revId);

    if (params.integrationId) {
      query = query.where('integration_id', '=', params.integrationId);
    }
    return await query.executeTakeFirst();
  }

  async findLatestMessageRevision(
    tenantId: string,
    params: {
      integrationId?: string | null;
      externalAccountId: string;
      externalChannelId: string;
      externalMessageId: string;
    },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    let query = client
      .selectFrom('message_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('external_account_id', '=', params.externalAccountId)
      .where('external_channel_id', '=', params.externalChannelId)
      .where('external_message_id', '=', params.externalMessageId)
      .orderBy('received_at', 'desc');

    if (params.integrationId) {
      query = query.where('integration_id', '=', params.integrationId);
    }
    return await query.executeTakeFirst();
  }

  async recordMessageEvent(
    params: RecordMessageEventParams,
    trx?: Kysely<Database>
  ): Promise<{ message: any; isDuplicate: boolean }> {
    const client = trx || this.db;
    const revId = params.externalRevisionId || '';

    const existing = await this.findMessageEvent(
      params.tenantId,
      {
        integrationId: params.integrationId,
        externalAccountId: params.externalAccountId,
        externalChannelId: params.externalChannelId,
        externalMessageId: params.externalMessageId,
        externalRevisionId: revId,
      },
      client
    );
    if (existing) {
      return { message: existing, isDuplicate: true };
    }

    const message = await client
      .insertInto('message_events')
      .values({
        tenant_id: params.tenantId,
        inbox_event_id: params.inboxEventId || null,
        integration_id: params.integrationId || null,
        external_account_id: params.externalAccountId,
        external_channel_id: params.externalChannelId,
        external_thread_id: params.externalThreadId || null,
        external_message_id: params.externalMessageId,
        external_revision_id: revId,
        sender_external_id: params.senderExternalId || null,
        mapped_user_id: params.mappedUserId || null,
        language: params.language || null,
        direction: params.direction || null,
        text_original: params.textOriginal || '',
        entities: (params.entities || []) as any,
        raw_payload_encrypted: params.rawPayloadEncrypted || null,
        occurred_at: params.occurredAt || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { message, isDuplicate: false };
  }

  async recordAttachment(
    params: RecordAttachmentParams,
    trx?: Kysely<Database>
  ): Promise<{ attachment: any; isDuplicate: boolean }> {
    const client = trx || this.db;
    const existing = await client
      .selectFrom('message_attachments')
      .selectAll()
      .where('tenant_id', '=', params.tenantId)
      .where('message_event_id', '=', params.messageEventId)
      .where('sha256', '=', params.sha256)
      .executeTakeFirst();

    if (existing) {
      return { attachment: existing, isDuplicate: true };
    }

    const attachment = await client
      .insertInto('message_attachments')
      .values({
        tenant_id: params.tenantId,
        message_event_id: params.messageEventId,
        source_attachment_id: params.sourceAttachmentId || null,
        filename: params.filename,
        mime_type: params.mimeType,
        byte_size: params.byteSize,
        sha256: params.sha256,
        storage_key: params.storageKey,
        scan_state: params.scanState || 'pending',
        metadata: (params.metadata || {}) as any,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { attachment, isDuplicate: false };
  }

  async findTaskBySourceMessageId(
    tenantId: string,
    sourceMessageId: string,
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    return await client
      .selectFrom('tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_message_id', '=', sourceMessageId)
      .executeTakeFirst();
  }

  async findTaskByMessageExternal(
    tenantId: string,
    params: {
      integrationId?: string | null;
      externalAccountId: string;
      externalChannelId: string;
      externalMessageId: string;
    },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    let query = client
      .selectFrom('tasks')
      .innerJoin('message_events', 'message_events.id', 'tasks.source_message_id')
      .selectAll('tasks')
      .where('tasks.tenant_id', '=', tenantId)
      .where('message_events.external_account_id', '=', params.externalAccountId)
      .where('message_events.external_channel_id', '=', params.externalChannelId)
      .where('message_events.external_message_id', '=', params.externalMessageId);

    if (params.integrationId) {
      query = query.where('message_events.integration_id', '=', params.integrationId);
    }
    return await query.executeTakeFirst();
  }

  async getOrCreateIntegration(
    tenantId: string,
    kind: string,
    name: string,
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const existing = await client
      .selectFrom('integrations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('kind', '=', kind)
      .where('name', '=', name)
      .executeTakeFirst();

    if (existing) {
      return existing;
    }

    return await client
      .insertInto('integrations')
      .values({
        tenant_id: tenantId,
        kind,
        name,
        enabled: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async resolveChannelRoute(
    tenantId: string,
    integrationId: string,
    externalAccountId: string,
    externalChannelId: string,
    externalTopicId?: string,
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const topicId = externalTopicId || '';
    return await client
      .selectFrom('channel_routes')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('integration_id', '=', integrationId)
      .where('external_account_id', '=', externalAccountId)
      .where('external_channel_id', '=', externalChannelId)
      .where('external_topic_id', '=', topicId)
      .executeTakeFirst();
  }
}
