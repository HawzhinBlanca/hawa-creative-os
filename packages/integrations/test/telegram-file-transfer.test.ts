import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBridgeDaemon } from '../src/telegram-bridge.js';

/**
 * File transfers with Telegram, in both directions. A delivered design reaches the requester as a
 * document (the exact approved bytes), and a stalled download can never hold intake indefinitely.
 */

const botToken = ['bot', 'token', 'for', 'tests'].join('_');
afterEach(() => vi.restoreAllMocks());

/** A fetch that answers only when its request is aborted, the way a stalled Telegram connection behaves. */
function stalledFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url: any, init?: any) =>
    new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (!signal) return; // no deadline: this request never settles
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  );
}

describe('Telegram sendDocument', () => {
  it('uploads the bytes as a multipart document with its name, type and caption', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 123 } } }))
    );
    const bridge = new TelegramBridgeDaemon({ botToken });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

    const res = await bridge.dispatchOutboundDocument(123, bytes, 'kaae-design.png', {
      mimeType: 'image/png',
      caption: 'kaae-design.png',
    });

    expect(res).toEqual({ success: true, messageId: '77' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${botToken}/sendDocument`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('123');
    expect(form.get('caption')).toBe('kaae-design.png');
    const file = form.get('document') as File;
    expect(file.name).toBe('kaae-design.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('does not report a rejected upload or a mismatched receipt as delivered', async () => {
    const bridge = new TelegramBridgeDaemon({ botToken });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 413 }), { status: 413 })
    );
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.pdf')).toEqual({
      success: false,
      error: 'TELEGRAM_DOCUMENT_REJECTED_413',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: 999 } } }))
    );
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.pdf')).toEqual({
      success: false,
      error: 'TELEGRAM_RECEIPT_INVALID',
    });
  });

  it('gives up on a stalled upload at its timeout and reports it as uncertain, never resending', async () => {
    const fetch = stalledFetch();
    const bridge = new TelegramBridgeDaemon({ botToken });
    const res = await bridge.dispatchOutboundDocument(123, new Uint8Array([1, 2]), 'a.pdf', { timeoutMs: 50 });
    expect(res).toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('holds a document upload after a 5xx or unreadable success response', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 503 }, { status: 503 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 200 }));
    const bridge = new TelegramBridgeDaemon({ botToken });
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.pdf'))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.pdf'))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.pdf'))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('refuses to send without a bot token or without bytes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await new TelegramBridgeDaemon({}).dispatchOutboundDocument(1, new Uint8Array([1]), 'a.png')).toEqual({
      success: false,
      error: 'TELEGRAM_NOT_CONFIGURED',
    });
    expect(await new TelegramBridgeDaemon({ botToken }).dispatchOutboundDocument(1, new Uint8Array(), 'a.png')).toEqual({
      success: false,
      error: 'INVALID_DOCUMENT_BUFFER',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Telegram downloadFile', () => {
  it('gives up on a stalled download at its timeout instead of holding intake', async () => {
    stalledFetch();
    const bridge = new TelegramBridgeDaemon({ botToken, downloadTimeoutMs: 50 });
    const started = Date.now();
    await expect(bridge.downloadFile('file-1')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  }, 3000);

  it('bounds the file body request with the same deadline', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga' } })));
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([9, 8, 7])));
    const bridge = new TelegramBridgeDaemon({ botToken });
    const bytes = await bridge.downloadFile('file-1');
    expect(bytes).toEqual(Buffer.from([9, 8, 7]));
    for (const call of fetch.mock.calls) expect((call[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });
});
