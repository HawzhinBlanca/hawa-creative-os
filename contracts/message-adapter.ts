import type { AppError, CapabilityReport, ISODateTime, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';

export type AdapterKind = 'hawa_desk' | 'telegram' | 'waha' | 'slack' | 'email' | 'other';

export interface NormalizedAttachment {
  sourceId?: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: SHA256;
  storageKey: string;
  scanState: 'pending' | 'clean' | 'quarantined' | 'rejected';
}

export interface MessageEnvelope {
  schemaVersion: 1;
  adapter: { kind: AdapterKind; integrationId: UUID; version: string };
  source: {
    accountId: string;
    channelId: string;
    topicId?: string;
    threadId?: string;
    messageId: string;
    revisionId?: string;
    eventId: string;
    sequence?: string;
    permalink?: string;
  };
  sender: { externalId: string; mappedUserId?: UUID; displayName?: string };
  occurredAt?: ISODateTime;
  receivedAt: ISODateTime;
  language?: string;
  direction: 'ltr' | 'rtl' | 'auto';
  text: string;
  entities: Array<{ type: string; offset?: number; length?: number; value?: unknown }>;
  attachments: NormalizedAttachment[];
  replyTo?: { messageId: string; quotedText?: string };
  reactions: Array<{ name: string; actorExternalId: string; action?: string }>;
  verification: { verified: boolean; method: string; receivedIp?: string };
  rawPayloadHash: SHA256;
}

export interface ReconcileCursor {
  value?: string;
  since?: ISODateTime;
  limit: number;
}

export interface ReconcileResult {
  events: MessageEnvelope[];
  nextCursor?: string;
  complete: boolean;
  detectedGaps: Array<{ from?: string; to?: string; reason: string }>;
}

export interface OutboundNotification {
  destination: { accountId: string; channelId: string; threadId?: string; userId?: string };
  type: 'task_created' | 'needs_information' | 'review_ready' | 'revision_ready' | 'published' | 'failed';
  text: string;
  actionUrl?: string;
  attachments?: Array<{ filename: string; mimeType: string; storageKey: string }>;
}

export interface NotificationReceipt {
  externalMessageId?: string;
  delivered: boolean;
  providerState?: string;
  sentAt: ISODateTime;
}

export interface MessageAdapter {
  readonly kind: AdapterKind;
  getCapabilities(ctx: RequestContext): Promise<Result<CapabilityReport>>;
  verifyAndNormalize(input: { headers: Headers; rawBody: Uint8Array; receivedAt: ISODateTime }): Promise<Result<MessageEnvelope[], AppError>>;
  reconcile(ctx: RequestContext, cursor: ReconcileCursor): Promise<Result<ReconcileResult>>;
  notify(ctx: RequestContext, notification: OutboundNotification): Promise<Result<NotificationReceipt>>;
  resolvePermalink?(ctx: RequestContext, source: MessageEnvelope['source']): Promise<Result<string>>;
  health(ctx: RequestContext): Promise<Result<{ state: 'healthy' | 'degraded' | 'unavailable' | 'reauth_required'; detail: JsonObject }>>;
}
