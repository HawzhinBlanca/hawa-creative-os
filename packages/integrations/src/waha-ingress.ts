/**
 * WAHA (WhatsApp HTTP API) Webhook Ingress & Normalization Engine (FR-004, FR-071)
 * Enforces Invariant #1 (Hawa Desk canonical), Invariant #6 (pre-retrieval scope locking),
 * and Invariant #12 (idempotency key deduplication).
 */

import crypto from 'node:crypto';

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
    participant?: string;
    author?: string;
    key?: {
      id?: string;
      remoteJid?: string;
      participant?: string;
    };
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
  participant?: string;
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
  isGroup: boolean;
  groupJid?: string;
  isDisallowedGroup?: boolean;
  rawPayloadHash?: string;
}

export interface WahaIngressOptions {
  secretToken?: string;
  allowedGroupJids?: string[];
  killSwitchEnabled?: boolean;
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

export const KAAE_CLIENT_ID = 'c1000000-0000-4000-8000-000000000002';

/**
 * Known Office / Client phone number routing table (Invariant #6 scope mapping)
 */
export const PHONE_CLIENT_DIRECTORY: Record<string, string> = {
  '9647500000001': KAAE_CLIENT_ID,
  '9647501234567': 'client-drustee',
  '9647507654321': 'client-aster',
  '9647701112233': 'client-nova',
  '9647709998877': 'client-rona',
};

export function computeWahaPayloadHash(payload: string | Buffer | Uint8Array | ArrayBuffer): string {
  const hasher = crypto.createHash('sha256');
  if (typeof payload === 'string') {
    hasher.update(payload, 'utf8');
  } else if (payload instanceof ArrayBuffer) {
    hasher.update(Buffer.from(payload));
  } else {
    hasher.update(payload);
  }
  return hasher.digest('hex');
}

export class WahaIngressHandler {
  readonly secretToken?: string;
  readonly allowedGroupJids?: string[];
  readonly killSwitchActive: boolean;

  constructor(optionsOrSecret?: string | WahaIngressOptions) {
    if (typeof optionsOrSecret === 'string') {
      this.secretToken = optionsOrSecret;
      this.allowedGroupJids = undefined;
      this.killSwitchActive = false;
    } else if (optionsOrSecret) {
      this.secretToken = optionsOrSecret.secretToken;
      this.allowedGroupJids = optionsOrSecret.allowedGroupJids;
      this.killSwitchActive = optionsOrSecret.killSwitchEnabled === false;
    } else {
      this.secretToken = undefined;
      this.allowedGroupJids = undefined;
      this.killSwitchActive = false;
    }
  }

  /**
   * Verifies incoming webhook request headers.
   */
  verifySecret(providedSecret?: string): boolean {
    if (!this.secretToken) return true; // Optional in local test mode
    if (!providedSecret || typeof providedSecret !== 'string') return false;
    const cleanSecret = providedSecret.replace(/^Bearer\s+/i, '').trim();
    const expectedBuf = Buffer.from(this.secretToken);
    const actualBuf = Buffer.from(cleanSecret);
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Verifies HMAC-SHA256 signature against webhook raw payload with timing-safe comparison.
   */
  verifySignature(payload: string | Buffer | Uint8Array | ArrayBuffer, signature?: string): boolean {
    if (!this.secretToken) return true; // Optional in local test mode
    if (!signature) return false;
    try {
      const cleanSig = signature.replace(/^sha256=/i, '').trim();
      const hmac = crypto.createHmac('sha256', this.secretToken);
      if (typeof payload === 'string') {
        hmac.update(payload, 'utf8');
      } else if (payload instanceof ArrayBuffer) {
        hmac.update(Buffer.from(payload));
      } else {
        hmac.update(payload);
      }
      const expected = hmac.digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(cleanSig, 'hex');
      if (expectedBuf.length !== actualBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      return false;
    }
  }

  /**
   * Checks whether a JID represents a WhatsApp group
   */
  isGroup(jid: string): boolean {
    return typeof jid === 'string' && jid.endsWith('@g.us');
  }

  /**
   * Checks whether a group is explicitly allowlisted
   */
  isGroupAllowed(jid: string): boolean {
    if (!this.isGroup(jid)) return true; // Direct chats are not group-restricted
    if (!this.allowedGroupJids || this.allowedGroupJids.length === 0) return true;
    return this.allowedGroupJids.includes(jid);
  }

  /**
   * Normalizes incoming raw WAHA payload into canonical message representation.
   */
  normalize(raw: WahaRawPayload, rawBodyBytes?: Uint8Array | Buffer | string | ArrayBuffer): WahaNormalizedMessage {
    const data: any = raw.payload || raw;
    const rawId = data.id || data.key?.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fromRaw = data.from || data.key?.remoteJid || 'unknown@c.us';
    const isGroup = this.isGroup(fromRaw);
    const isDisallowed = isGroup && !this.isGroupAllowed(fromRaw);

    const participantRaw = data.participant || data.author || data.key?.participant || fromRaw;
    const phoneClean = participantRaw.replace(/[^0-9]/g, '') || fromRaw.replace(/[^0-9]/g, '');
    const senderName = data.pushname || data._data?.notifyName || 'WhatsApp Client';
    const text = data.body || data.caption || '';
    const normalizedText = normalizeKurdishIncomingText(text);

    // Derive or map client ID before any retrieval (Invariant #4 & #6)
    // The webhook secret/signature is the trust boundary: an authenticated adapter may name the
    // client explicitly; otherwise the sender's phone directory entry or a brand keyword decides.
    let detectedClientId: string | undefined = raw.clientId || PHONE_CLIENT_DIRECTORY[phoneClean];
    if (!detectedClientId) {
      const lower = text.toLowerCase();
      if (
        lower.includes('kaae') ||
        text.includes('باوەڕپێدان') ||
        text.includes('کەی ئەی') ||
        lower.includes('accreditation') ||
        lower.includes('university') ||
        text.includes('زانکۆ')
      ) {
        detectedClientId = KAAE_CLIENT_ID;
      } else if (lower.includes('drustee') || text.includes('دەرمان') || text.includes('ڤیتامین')) {
        detectedClientId = 'client-drustee';
      } else if (lower.includes('aster') || text.includes('ئاستێر') || text.includes('هۆتێل')) {
        detectedClientId = 'client-aster';
      } else if (lower.includes('nova') || text.includes('نۆڤا') || text.includes('تەکنەلۆجیا')) {
        detectedClientId = 'client-nova';
      } else if (lower.includes('rona') || text.includes('ڕۆنا') || text.includes('مۆدە')) {
        detectedClientId = 'client-rona';
      }
      // Otherwise the message stays unscoped; the art director assigns the client in Hawa Desk.
    }

    const rawPayloadHash = rawBodyBytes ? computeWahaPayloadHash(rawBodyBytes) : undefined;

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
      isGroup,
      groupJid: isGroup ? fromRaw : undefined,
      isDisallowedGroup: isDisallowed,
      rawPayloadHash,
    };
  }
}
