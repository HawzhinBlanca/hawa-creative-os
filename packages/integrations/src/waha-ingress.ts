/**
 * WAHA (WhatsApp HTTP API) Webhook Ingress & Normalization Engine (FR-004, FR-071)
 * Enforces Invariant #1 (Hawa Desk canonical), Invariant #6 (pre-retrieval scope locking),
 * and Invariant #12 (idempotency key deduplication).
 */

export interface WahaRawPayload {
  event?: string;
  session?: string;
  payload?: {
    id?: string;
    from?: string;
    to?: string;
    body?: string;
    caption?: string;
    timestamp?: number;
    pushname?: string;
    hasMedia?: boolean;
    mediaUrl?: string;
    mimetype?: string;
    _data?: any;
  };
  // Flat payload support
  id?: string;
  from?: string;
  body?: string;
  caption?: string;
  timestamp?: number;
  pushname?: string;
  hasMedia?: boolean;
  mediaUrl?: string;
  mimetype?: string;
  clientId?: string;
}

export interface WahaNormalizedMessage {
  platform: 'whatsapp';
  messageId: string;
  senderPhone: string;
  senderName: string;
  rawText: string;
  normalizedKurdishText: string;
  idempotencyKey: string;
  timestamp: string;
  hasMedia: boolean;
  mediaMimeType?: string;
  detectedClientId?: string;
  direction: 'rtl';
}

/**
 * Normalizes Kurdish Sorani text in WhatsApp messages:
 * - Preserves Kurdish distinct characters (ک, گ, ڵ, ۆ, ڕ, ێ, ە)
 * - Converts legacy Arabic Yah/Kaf to standard Kurdish glyphs (ي -> ی, ك -> ک)
 * - Preserves Zero-Width Non-Joiner (ZWNJ, \u200C)
 */
export function normalizeKurdishIncomingText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\u064A/g, 'ی') // Arabic Yeh to Farsi/Kurdish Yeh
    .replace(/\u0643/g, 'ک') // Arabic Kaf to Keheh
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Known Office / Client phone number routing table (Invariant #6 scope mapping)
 */
export const PHONE_CLIENT_DIRECTORY: Record<string, string> = {
  '9647501234567': 'client-drustee',
  '9647507654321': 'client-aster',
  '9647701112233': 'client-nova',
  '9647709998877': 'client-rona',
};

export class WahaIngressHandler {
  constructor(private readonly secretToken?: string) {}

  /**
   * Verifies incoming webhook request headers.
   */
  verifySecret(providedSecret?: string): boolean {
    if (!this.secretToken) return true; // Optional in local test mode
    return providedSecret === this.secretToken;
  }

  /**
   * Normalizes incoming raw WAHA payload into canonical message representation.
   */
  normalize(raw: WahaRawPayload): WahaNormalizedMessage {
    const data = raw.payload || raw;
    const rawId = data.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fromRaw = data.from || 'unknown@c.us';
    const phoneClean = fromRaw.replace(/[^0-9]/g, '');
    const senderName = data.pushname || 'WhatsApp Client';
    const text = data.body || data.caption || '';
    const normalizedText = normalizeKurdishIncomingText(text);

    // Derive or map client ID before any retrieval (Invariant #6)
    const detectedClientId = raw.clientId || PHONE_CLIENT_DIRECTORY[phoneClean] || 'client-drustee';

    return {
      platform: 'whatsapp',
      messageId: rawId,
      senderPhone: phoneClean,
      senderName,
      rawText: text,
      normalizedKurdishText: normalizedText,
      idempotencyKey: `idem_waha_${rawId}`,
      timestamp: new Date((data.timestamp ? data.timestamp * 1000 : Date.now())).toISOString(),
      hasMedia: Boolean(data.hasMedia || data.mediaUrl),
      mediaMimeType: data.mimetype,
      detectedClientId,
      direction: 'rtl',
    };
  }
}
