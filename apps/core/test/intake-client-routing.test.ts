import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';

/**
 * HUNT: intake names a request's client from substrings of common Sorani words. "دروستی" (the
 * Drustee alias) is inside "تەندروستی" (health) and is the everyday "دروستی بکە" (make it);
 * "پارەدان" (payment) names FastPay; "دەرمان" (medicine) names Drustee. With a database these
 * aliases resolve to the seeded Drustee and FastPay client rows (CLIENT_ALIAS_TO_UUID), so the
 * request is scoped to a client the sender never named (Invariant #4) and auto-generated for it.
 */
function send(text: string) {
  const dispatch = vi.fn().mockResolvedValue({ success: true });
  const app = createApp({ telegramBridge: { dispatchOutboundMessage: dispatch } as any });
  const chatId = `hunt-routing-${randomUUID()}`;
  return app
    .request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
      body: JSON.stringify({
        update_id: `hunt-routing-${randomUUID()}`,
        message: { message_id: 4, from: { id: 42, first_name: 'Office' }, chat: { id: chatId }, text },
      }),
    })
    .then(async (res) => ({ body: await res.json(), replies: dispatch.mock.calls.map((c) => String(c[1]?.text ?? '')).join('\n') }));
}

describe('review of 2026-09-24: a client is never named by a word inside another word', () => {
  it('"Ministry of Health" (وەزارەتی تەندروستی) is not a Drustee request', async () => {
    const { body, replies } = await send('بانگهێشت بۆ سیمیناری وەزارەتی تەندروستی\n\n١٢ی تشرینی یەکەم، هۆڵی ئاسیا، هەولێر');
    expect(body.task.clientId).toBeNull();
    expect(replies).not.toContain('Drustee');
  });

  it('"make it" (دروستی بکە) is not a Drustee request', async () => {
    const { body } = await send('ئەم پۆستەرە دروستی بکە\n\nڕۆژی مامۆستا\n١ی ئادار ٢٠٢٧');
    expect(body.task.clientId).toBeNull();
  });

  it('"membership fee payment" (پارەدانی ئابوونە) is not a FastPay request', async () => {
    const { body } = await send('ئاگاداری\n\nدوا وادەی پارەدانی ئابوونەی ئەندامان ٣٠ی ئەیلوولە');
    expect(body.task.clientId).toBeNull();
  });
});
