import { describe, it, expect } from 'vitest';
import {
  WahaIngressHandler,
  normalizeKurdishIncomingText,
  PHONE_CLIENT_DIRECTORY,
} from '../src/waha-ingress.js';

describe('WAHA Ingress & Normalization Engine (FR-004, FR-071)', () => {
  it('normalizes legacy Arabic characters to standard Kurdish Sorani', () => {
    const rawArabic = 'ئۆفەری تايبەتي بۆ دەرمانخانەی هاوچەرخ';
    const normalized = normalizeKurdishIncomingText(rawArabic);

    expect(normalized).not.toContain('\u064A'); // No Arabic Yeh
    expect(normalized).toContain('ی'); // Standard Kurdish/Farsi Yeh
  });

  it('normalizes incoming WAHA webhook payload and computes deterministic idempotency key', () => {
    const handler = new WahaIngressHandler('office_waha_secret_token');
    expect(handler.verifySecret('office_waha_secret_token')).toBe(true);
    expect(handler.verifySecret('wrong_token')).toBe(false);

    const rawPayload = {
      event: 'message',
      payload: {
        id: 'waha_msg_10928374',
        from: '9647501234567@c.us',
        pushname: 'Drustee Official',
        body: 'کەمپینی نوێی ڤیتامین D3+K2',
        timestamp: 1725577200,
      },
    };

    const msg = handler.normalize(rawPayload);

    expect(msg.platform).toBe('whatsapp');
    expect(msg.messageId).toBe('waha_msg_10928374');
    expect(msg.senderPhone).toBe('9647501234567');
    expect(msg.senderName).toBe('Drustee Official');
    expect(msg.idempotencyKey).toBe('idem_waha_waha_msg_10928374');
    expect(msg.detectedClientId).toBe('client-drustee');
    expect(msg.direction).toBe('rtl');
    expect(msg.normalizedKurdishText).toBe('کەمپینی نوێی ڤیتامین D3+K2');
  });

  it('maps known client phone numbers prior to any retrieval (Invariant #6)', () => {
    const handler = new WahaIngressHandler();

    const asterPayload = {
      id: 'msg_aster_99',
      from: '9647507654321@c.us',
      body: 'شەوی هەینی ئاستێر',
    };

    const normalized = handler.normalize(asterPayload);
    expect(normalized.detectedClientId).toBe('client-aster');
  });

  it('verifies valid and rejects forged HMAC-SHA256 signatures with timing-safe comparison', () => {
    const hmacTestKey = 'test-key-mock';
    const handler = new WahaIngressHandler(hmacTestKey);
    const body = JSON.stringify({ id: 'msg_99', text: 'Hello from WhatsApp' });

    const validSig = require('node:crypto').createHmac('sha256', hmacTestKey).update(body).digest('hex');
    expect(handler.verifySignature(body, validSig)).toBe(true);
    expect(handler.verifySignature(body, `sha256=${validSig}`)).toBe(true);

    // Tampered payload or signature
    expect(handler.verifySignature(body + 'tampered', validSig)).toBe(false);
    expect(handler.verifySignature(body, 'bad_signature_digest')).toBe(false);
    expect(handler.verifySignature(body, undefined)).toBe(false);
  });
});
