import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { sniffImageMime } from '../src/services/telegram-media.js';

/**
 * HUNT (2026-09-24): inputs a real office sends, driven through the real webhook with no database
 * (every branch here runs before or without one) and a fake bridge.
 */
function harness(download?: Buffer | null) {
  const dispatch = vi.fn().mockResolvedValue({ success: true });
  const bridge = {
    dispatchOutboundMessage: dispatch,
    downloadFile: vi.fn().mockResolvedValue(download ?? null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  const app = createApp({ telegramBridge: bridge as any });
  const chatId = 55000000 + Math.floor(Math.random() * 1e6);
  const send = async (message: Record<string, unknown>) => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
      body: JSON.stringify({ update_id: randomUUID(), message: { message_id: 7, from: { id: 42, first_name: 'Office' }, chat: { id: chatId, type: 'private' }, ...message } }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const texts = () => dispatch.mock.calls.map((c) => String(c[1]?.text ?? ''));
  return { send, texts, bridge, chatId };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('review of 2026-09-24: intake edges', () => {
  it('an image file over 20 MB is refused with a reason, not retried into the parked-update queue', async () => {
    // Telegram's getFile refuses files over 20 MB, so downloadFile answers null every time.
    const { send, texts } = harness(null);
    const res = await send({
      caption: 'KAAE poster\n---\nMay 5, 2027\nErbil',
      document: { file_id: 'big', file_unique_id: 'big-u', file_name: 'hall.jpg', mime_type: 'image/jpeg', file_size: 25 * 1024 * 1024 },
    });
    // 503 makes the poller retry it five times (blocking every chat's queue for about a minute), then
    // park it and send the generic "could not process it automatically" notice. The size was known up front.
    expect.soft(res.status).toBe(200);
    expect.soft(texts().join('\n')).toMatch(/20 MB/);
  });

  it('a HEIC photo sent as a file is not labelled JPEG', () => {
    // ISO-BMFF header of an iPhone HEIC: ....ftypheic
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(32)]);
    const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(32)]);
    // The studio accepts data:image/jpeg and sends it to the model as a JPEG.
    expect.soft(sniffImageMime(heic)).not.toBe('image/jpeg');
    expect.soft(sniffImageMime(bmp)).not.toBe('image/jpeg');
    expect.soft(sniffImageMime(tiff)).not.toBe('image/jpeg');
  });

  it('the "request saved" acknowledgement never cuts an emoji in half', async () => {
    const { send, texts } = harness();
    // The title is the headline cut to 45 UTF-16 units; the emoji straddles unit 45.
    const headline = 'KAAE ' + 'a'.repeat(39) + '🎓 Graduation Day';
    expect(headline.charCodeAt(44)).toBeGreaterThanOrEqual(0xd800);
    const res = await send({ text: `${headline}\n\nJune 1, 2027, Erbil` });
    expect(res.status).toBe(201);
    const ack = texts().find((t) => /Task ID/.test(t))!;
    expect(LONE_SURROGATE.test(ack)).toBe(false);
  });

  it('with the model unavailable, a full brief sent as a reply to the bot\'s greeting is a new request, not "is this a change?"', async () => {
    const { send, texts } = harness();
    const greeting = { message_id: 3, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: 1, type: 'private' }, text: '👋 Hello! How can Hawa Creative OS assist you today? Please send your event brief or announcement copy to start.' };
    const res = await send({ text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil', reply_to_message: greeting });
    expect.soft(res.body.status).not.toBe('CLARIFICATION_REQUIRED');
    expect.soft(texts().join('\n')).not.toMatch(/is this a change to the design/);
  });

  it('a 👍 sticker in reply to a draft is not answered "this message contained no text or media"', async () => {
    const { send, texts } = harness();
    const draft = { message_id: 9, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: 1, type: 'private' }, caption: `🎨 Canva draft · Task ID: ${randomUUID()}` };
    await send({ sticker: { file_id: 's1', file_unique_id: 's1u', emoji: '👍', width: 512, height: 512, is_animated: false }, reply_to_message: draft });
    expect(texts().join('\n')).not.toMatch(/contained no text or media/);
  });
});
