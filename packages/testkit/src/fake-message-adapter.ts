import type {
  MessageAdapter,
  AdapterKind,
  RequestContext,
  Result,
  CapabilityReport,
  MessageEnvelope,
  ReconcileCursor,
  ReconcileResult,
  OutboundNotification,
  NotificationReceipt,
  AppError,
} from '@hawa/contracts';

export class FakeMessageAdapter implements MessageAdapter {
  readonly kind: AdapterKind;
  private deliveredNotifications: OutboundNotification[] = [];

  constructor(kind: AdapterKind = 'telegram') {
    this.kind = kind;
  }

  async getCapabilities(_ctx: RequestContext): Promise<Result<CapabilityReport>> {
    return {
      ok: true,
      value: {
        name: `Fake${this.kind}Adapter`,
        version: '1.0.0',
        healthy: true,
        capabilities: {
          webhookVerification: true,
          inlineKeyboards: true,
          mediaAttachments: true,
        },
        limits: { maxFileSizeMb: 50 },
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async verifyAndNormalize(input: {
    headers: Headers;
    rawBody: Uint8Array;
    receivedAt: string;
  }): Promise<Result<MessageEnvelope[], AppError>> {
    const secret = input.headers.get('x-telegram-bot-api-secret-token');
    if (this.kind === 'telegram' && secret !== 'expected_office_secret') {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Invalid webhook secret token',
          retryable: false,
          safeAction: 'Verify Telegram Bot webhook secret configuration',
        },
      };
    }

    const text = new TextDecoder().decode(input.rawBody);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      adapter: { kind: this.kind, integrationId: crypto.randomUUID(), version: '1.0' },
      source: {
        accountId: 'acc_office_1',
        channelId: (json.channelId as string) || 'tg_group_marketing',
        messageId: (json.messageId as string) || `msg_${Date.now()}`,
        eventId: (json.eventId as string) || `evt_${Date.now()}`,
      },
      sender: {
        externalId: (json.senderId as string) || 'user_123',
        displayName: 'Hawzhin',
      },
      receivedAt: input.receivedAt,
      direction: 'rtl',
      text: (json.text as string) || 'تکایە پۆستێک دروست بکە بۆ داشکاندنی بەهارە',
      entities: [],
      attachments: [],
      reactions: [],
      verification: { verified: true, method: 'secret_token' },
      rawPayloadHash: `payload_hash_${text.length}`,
    };

    return { ok: true, value: [envelope] };
  }

  async reconcile(_ctx: RequestContext, _cursor: ReconcileCursor): Promise<Result<ReconcileResult>> {
    return {
      ok: true,
      value: {
        events: [],
        complete: true,
        detectedGaps: [],
      },
    };
  }

  async notify(_ctx: RequestContext, notification: OutboundNotification): Promise<Result<NotificationReceipt>> {
    this.deliveredNotifications.push(notification);
    return {
      ok: true,
      value: {
        externalMessageId: `tg_out_${Date.now()}`,
        delivered: true,
        sentAt: new Date().toISOString(),
      },
    };
  }

  getDeliveredNotifications(): OutboundNotification[] {
    return this.deliveredNotifications;
  }

  async health(_ctx: RequestContext): Promise<Result<{ state: 'healthy' | 'degraded' | 'unavailable' | 'reauth_required'; detail: Record<string, unknown> }>> {
    return {
      ok: true,
      value: {
        state: 'healthy',
        detail: { latencyMs: 12, delivered: this.deliveredNotifications.length },
      },
    };
  }
}
