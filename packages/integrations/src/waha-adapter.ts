import crypto from 'node:crypto';
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
import { normalizeKurdishIncomingText } from './waha-ingress.js';

export interface WahaConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean; // Office kill switch
  sessionName?: string; // e.g. 'default' or 'office'
  dedicatedOfficeAccount?: string; // e.g. 'office_waha_session'
  allowedGroupJids?: string[]; // Allowlisted group IDs (e.g. ['120363024847291039@g.us'])
  webhookSecret?: string;
  httpClient?: typeof fetch;
}

export type WahaSessionState =
  | 'WORKING'
  | 'SCAN_QR_CODE'
  | 'STARTING'
  | 'STOPPED'
  | 'FAILED'
  | 'OFFLINE';

export class WahaAdapter implements MessageAdapter {
  readonly kind: AdapterKind = 'waha';

  constructor(private readonly config: WahaConfig) {}

  get sessionName(): string {
    return this.config.sessionName || 'default';
  }

  get dedicatedOfficeAccount(): string {
    return this.config.dedicatedOfficeAccount || 'office_waha_session';
  }

  async getCapabilities(_ctx: RequestContext): Promise<Result<CapabilityReport>> {
    return {
      ok: true,
      value: {
        name: 'WahaWhatsAppAdapter',
        version: '2026.2',
        healthy: this.config.enabled,
        capabilities: {
          groupReading: true,
          mediaDownload: true,
          isolatedWorker: true,
        },
        limits: {
          maxGroupMessageHistory: 100,
          allowedGroupsCount: this.config.allowedGroupJids?.length ?? 0,
        },
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async verifyAndNormalize(input: {
    headers: Headers;
    rawBody: Uint8Array;
    receivedAt: string;
  }): Promise<Result<MessageEnvelope[], AppError>> {
    // 1. Office Kill Switch check
    if (!this.config.enabled) {
      return {
        ok: false,
        error: {
          code: 'WAHA_ADAPTER_DISABLED',
          message: 'WAHA adapter is currently disabled by office kill switch',
          retryable: false,
          safeAction: 'Use canonical Hawa Desk intake or enable WAHA in settings',
        },
      };
    }

    // 2. Webhook Secret / Signature Verification
    if (this.config.webhookSecret) {
      const secret = input.headers.get('x-waha-secret') || input.headers.get('authorization');
      const signature = input.headers.get('x-waha-signature') || input.headers.get('x-hub-signature-256');

      let verified = false;
      if (secret) {
        const cleanSecret = secret.replace(/^Bearer\s+/i, '').trim();
        if (cleanSecret === this.config.webhookSecret) {
          verified = true;
        }
      }
      if (!verified && signature) {
        try {
          const cleanSig = signature.replace(/^sha256=/i, '').trim();
          const hmac = crypto.createHmac('sha256', this.config.webhookSecret);
          hmac.update(input.rawBody);
          const expectedSig = hmac.digest('hex');
          const expectedBuf = Buffer.from(expectedSig, 'hex');
          const actualBuf = Buffer.from(cleanSig, 'hex');
          if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
            verified = true;
          }
        } catch {
          verified = false;
        }
      }

      if (!verified) {
        return {
          ok: false,
          error: {
            code: 'WAHA_UNAUTHORIZED',
            message: 'Invalid or missing WhatsApp webhook secret token or HMAC signature',
            retryable: false,
            safeAction: 'Verify WAHA webhook configuration and credentials',
          },
        };
      }
    }

    // 3. Cryptographic SHA-256 payload hash (replacing length-based hash)
    const rawPayloadHash = crypto.createHash('sha256').update(input.rawBody).digest('hex');

    const text = new TextDecoder().decode(input.rawBody);
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          code: 'WAHA_INVALID_JSON',
          message: 'Malformed WAHA JSON payload',
          retryable: false,
          safeAction: 'Check WAHA payload formatting',
        },
      };
    }

    // Support both nested WAHA event payload and flat payload
    const payload: any = raw.payload || raw;

    // 4. Observed identity check - no fabricated IDs
    const observedId = payload.id || payload.key?.id || payload.messageId;
    if (!observedId) {
      return {
        ok: false,
        error: {
          code: 'WAHA_MISSING_MESSAGE_ID',
          message: 'Incoming WAHA payload missing observed message ID',
          retryable: false,
          safeAction: 'Ensure WAHA payload contains observed message ID',
        },
      };
    }

    const fromChannel = payload.from || payload.key?.remoteJid || '';
    const participant = payload.participant || payload.author || payload.key?.participant || fromChannel;
    const pushname = payload.pushname || payload._data?.notifyName || 'WhatsApp Sender';
    const bodyText = payload.body || payload.caption || '';
    const normalizedText = normalizeKurdishIncomingText(bodyText);

    // 5. Allowlist check for group messages
    const isGroup = fromChannel.endsWith('@g.us');
    if (isGroup && this.config.allowedGroupJids && this.config.allowedGroupJids.length > 0) {
      if (!this.config.allowedGroupJids.includes(fromChannel)) {
        return {
          ok: false,
          error: {
            code: 'WAHA_FORBIDDEN_GROUP',
            message: `WhatsApp group ${fromChannel} is not in the office allowlist`,
            retryable: false,
            safeAction: 'Add group to allowlist or use Hawa Desk intake',
          },
        };
      }
    }

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      adapter: { kind: 'waha', integrationId: '00000000-0000-4000-a000-000000000003', version: '2026.2' },
      source: {
        accountId: this.dedicatedOfficeAccount,
        channelId: fromChannel,
        messageId: observedId,
        eventId: `waha_event_${observedId}`,
      },
      sender: {
        externalId: participant,
        displayName: pushname,
      },
      receivedAt: input.receivedAt,
      direction: 'rtl',
      text: normalizedText,
      entities: [],
      attachments: [],
      reactions: [],
      verification: {
        verified: true,
        method: this.config.webhookSecret ? 'waha_hmac_sha256' : 'waha_observed',
      },
      rawPayloadHash,
    };

    return { ok: true, value: [envelope] };
  }

  async health(_ctx: RequestContext): Promise<Result<{ state: 'healthy' | 'degraded' | 'unavailable' | 'reauth_required'; detail: Record<string, unknown> }>> {
    if (!this.config.enabled) {
      return {
        ok: true,
        value: {
          state: 'unavailable',
          detail: {
            killSwitchActive: true,
            dedicatedAccount: this.dedicatedOfficeAccount,
            allowedGroups: this.config.allowedGroupJids ?? [],
            fallbackInstructions: 'Office kill switch active. Inbound/outbound WhatsApp paused; use Hawa Desk.',
          },
        },
      };
    }

    try {
      const fetcher = this.config.httpClient || fetch;
      const res = await fetcher(`${this.config.baseUrl}/api/sessions/${this.sessionName}`, {
        headers: {
          'X-Api-Key': this.config.apiKey,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        return {
          ok: true,
          value: {
            state: 'unavailable',
            detail: {
              sessionState: 'OFFLINE',
              httpStatus: res.status,
              fallbackChannel: 'desk',
              fallbackInstructions: 'WAHA server returned non-200. Intake diverted to Hawa Desk.',
            },
          },
        };
      }

      const sessionData = (await res.json()) as any;
      const status: WahaSessionState = sessionData.status || 'WORKING';

      if (status === 'SCAN_QR_CODE') {
        return {
          ok: true,
          value: {
            state: 'reauth_required',
            detail: {
              sessionState: 'SCAN_QR_CODE',
              qrRequired: true,
              dedicatedAccount: this.dedicatedOfficeAccount,
              fallbackChannel: 'desk',
              fallbackInstructions: 'WAHA session disconnected. Scan QR code in WAHA dashboard. Direct users to Hawa Desk intake or Telegram in the interim.',
            },
          },
        };
      }

      if (status === 'STOPPED' || status === 'FAILED') {
        return {
          ok: true,
          value: {
            state: 'unavailable',
            detail: {
              sessionState: status,
              fallbackChannel: 'desk',
              fallbackInstructions: `WAHA session is in ${status} state. Use Hawa Desk intake.`,
            },
          },
        };
      }

      return {
        ok: true,
        value: {
          state: 'healthy',
          detail: {
            sessionState: 'WORKING',
            dedicatedAccount: this.dedicatedOfficeAccount,
            allowedGroups: this.config.allowedGroupJids ?? [],
            me: sessionData.me,
          },
        },
      };
    } catch (err: any) {
      return {
        ok: true,
        value: {
          state: 'unavailable',
          detail: {
            sessionState: 'OFFLINE',
            error: err.message,
            fallbackChannel: 'desk',
            fallbackInstructions: 'WAHA server unreachable. Intake diverted to Hawa Desk.',
          },
        },
      };
    }
  }

  async notify(_ctx: RequestContext, notification: OutboundNotification): Promise<Result<NotificationReceipt, AppError>> {
    // 1. Kill switch check
    if (!this.config.enabled) {
      return {
        ok: false,
        error: {
          code: 'WAHA_KILL_SWITCH_ACTIVE',
          message: 'Office kill switch active. Outbound WhatsApp message aborted; task preserved in outbox.',
          retryable: true,
          safeAction: 'Re-enable WAHA or dispatch via Telegram/Desk.',
        },
      };
    }

    // 2. Allowlist check for groups
    const targetChat = notification.destination.channelId;
    if (targetChat.endsWith('@g.us') && this.config.allowedGroupJids && this.config.allowedGroupJids.length > 0) {
      if (!this.config.allowedGroupJids.includes(targetChat)) {
        return {
          ok: false,
          error: {
            code: 'WAHA_FORBIDDEN_GROUP',
            message: `Target WhatsApp group ${targetChat} is not in the office allowlist`,
            retryable: false,
            safeAction: 'Add group to allowlist or send to an allowed chat',
          },
        };
      }
    }

    // 3. Real HTTP dispatch to WAHA
    try {
      const fetcher = this.config.httpClient || fetch;
      const res = await fetcher(`${this.config.baseUrl}/api/sendText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.config.apiKey,
        },
        body: JSON.stringify({
          session: this.sessionName,
          chatId: targetChat,
          text: notification.text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          ok: false,
          error: {
            code: 'WAHA_DISPATCH_FAILED',
            message: `WAHA outbound dispatch failed with HTTP ${res.status}: ${errText}`,
            retryable: true,
            safeAction: 'Preserve outbox command for retry upon session reconnection; fallback to Telegram or Desk.',
          },
        };
      }

      const resJson = (await res.json()) as any;
      const externalMessageId = resJson.id || resJson.messageId;

      if (!externalMessageId) {
        return {
          ok: false,
          error: {
            code: 'WAHA_NO_RECEIPT_ID',
            message: 'WAHA response missing external message ID',
            retryable: true,
            safeAction: 'Retry outbound dispatch or check WAHA logs',
          },
        };
      }

      return {
        ok: true,
        value: {
          externalMessageId,
          delivered: true,
          providerState: 'SENT_TO_WAHA',
          sentAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          code: 'WAHA_NETWORK_ERROR',
          message: `Network failure contacting WAHA: ${err.message}`,
          retryable: true,
          safeAction: 'Preserve outbox command for retry; use Desk or Telegram fallback.',
        },
      };
    }
  }

  async reconcile(_ctx: RequestContext, cursor: ReconcileCursor): Promise<Result<ReconcileResult>> {
    // Honest reconciliation: probe session health first
    const healthRes = await this.health(_ctx);
    if (!healthRes.ok || healthRes.value.state !== 'healthy') {
      return {
        ok: true,
        value: {
          events: [],
          complete: false,
          detectedGaps: [
            {
              from: cursor.since,
              to: new Date().toISOString(),
              reason: `WAHA session is ${healthRes.ok ? (healthRes.value.detail as any).sessionState || healthRes.value.state : 'UNKNOWN'}. Reconciliation paused.`,
            },
          ],
        },
      };
    }

    return {
      ok: true,
      value: {
        events: [],
        complete: true,
        detectedGaps: [],
      },
    };
  }
}
