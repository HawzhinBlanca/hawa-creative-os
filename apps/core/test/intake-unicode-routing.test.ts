import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';

/**
 * Intake read the incoming message with ASCII word boundaries, which no Kurdish word ever has. The
 * Kurdish openings in the conversational-directive strip ("تکایە ...") therefore never matched, and
 * the request's first line, an instruction, was kept as copy and became the headline of the design.
 */
function telegram(app: any, text: string, query = '') {
  const chatId = `unicode-routing-${randomUUID()}`;
  return app.request(`/api/webhooks/telegram${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify({
      update_id: `unicode-routing-${randomUUID()}`,
      message: { message_id: 4, from: { id: 42, first_name: 'Office' }, chat: { id: chatId }, text },
    }),
  });
}

const newApp = () =>
  createApp({ telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }) } as any });

describe('intake reads Kurdish openings and brand names with Unicode word edges', () => {
  it('strips a Kurdish opening directive instead of designing it as the headline', async () => {
    const text = [
      'تکایە پۆستێکم بۆ دروست بکە بۆ ڕاگەیاندنی کۆنفرانسەکە',
      'کۆنفرانسی نیشتمانی متمانەبەخشین',
      '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر',
    ].join('\n\n');

    const { task } = await (await telegram(newApp(), text)).json();

    expect(task.headlineCkb).toBe('کۆنفرانسی نیشتمانی متمانەبەخشین');
    expect(task.brief.exactCopy.map((block: any) => block.text)).toEqual([
      'کۆنفرانسی نیشتمانی متمانەبەخشین',
      '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر',
    ]);
  });

  it('still strips the English openings that already worked', async () => {
    const text = 'I need a poster for the launch, keep it formal\n\nNATIONAL ACCREDITATION CONFERENCE\n\nSeptember 9, 2026, Erbil';
    const { task } = await (await telegram(newApp(), text)).json();
    expect(task.headlineEn).toBe('NATIONAL ACCREDITATION CONFERENCE');
  });

  it('routes a brand name that carries a Sorani suffix to its client', async () => {
    const { task } = await (await telegram(newApp(), 'بانگهێشتنامەیەک بۆ KAAEی\n\nکۆنفرانسی ساڵانە')).json();
    expect(task.clientId).toBe('c1000000-0000-4000-8000-000000000002');
  });

  it('does not route on a brand name welded onto the end of a Kurdish word', async () => {
    // \b sees a word boundary wherever the script changes, so "rona" stuck to the end of a Kurdish
    // word scoped the request to a client the sender never named. An unscoped request waits for the
    // art director instead, which is the safe side of Invariant #4.
    const { task } = await (await telegram(newApp(), 'داواکاری دیزاین بۆ کۆمپانیایrona\n\nناونیشانی ڕووداوەکە')).json();
    expect(task.clientId).toBeNull();
  });
});
