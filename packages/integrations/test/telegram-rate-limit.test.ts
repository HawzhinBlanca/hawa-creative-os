import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBridgeDaemon } from '../src/telegram-bridge.js';

afterEach(() => vi.restoreAllMocks());

/**
 * Telegram answers 429 with how long to wait (`parameters.retry_after`, in seconds). The bridge used
 * to drop it, so a sender could only guess (PHASE2_DESIGN.md 1.2 finding 4; slice 2.2): the
 * TelegramSender object now retries after exactly that long. The error code stays as it was, so the
 * outbox, which reads it, is unchanged.
 */
describe("a 429 from Telegram carries Telegram's retry_after", () => {
  const limited = () =>
    new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }), { status: 429 });

  it('on a text message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(limited());
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: 'Status' })).toEqual({ success: false, error: 'TELEGRAM_REJECTED_429', retryAfterSeconds: 3 });
  });

  it('on a text message sent with a parse mode (no plain-text second try on a 429)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(limited());
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: '<b>Status</b>', parse_mode: 'HTML' })).toEqual({ success: false, error: 'TELEGRAM_REJECTED_429', retryAfterSeconds: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('on a document', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(limited());
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1, 2, 3]), 'a.png')).toEqual({ success: false, error: 'TELEGRAM_DOCUMENT_REJECTED_429', retryAfterSeconds: 3 });
  });

  it('and no retry_after when Telegram named none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 429 }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    const res = await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.png');
    expect(res).toEqual({ success: false, error: 'TELEGRAM_DOCUMENT_REJECTED_429' });
    expect(res).not.toHaveProperty('retryAfterSeconds');
  });
});
