import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';

/**
 * Intake read the incoming message with ASCII word boundaries, which no Kurdish word ever has. The
 * Kurdish openings in the conversational-directive strip ("تکایە ...") therefore never matched, and
 * the request's first line, an instruction, was kept as copy and became the headline of the design.
 *
 * ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
 * lifecycle (lifecycle-internal.routes.ts), so the reading is asserted on that draft.
 */
function prepare(text: string) {
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `unicode-routing-${randomUUID()}`, sourceChannelId: `unicode-routing-${randomUUID()}`,
    senderName: 'Office', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

describe('intake reads Kurdish openings and brand names with Unicode word edges', () => {
  it('strips a Kurdish opening directive instead of designing it as the headline', async () => {
    const text = [
      'تکایە پۆستێکم بۆ دروست بکە بۆ ڕاگەیاندنی کۆنفرانسەکە',
      'کۆنفرانسی نیشتمانی متمانەبەخشین',
      '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر',
    ].join('\n\n');

    const draft = await prepare(text);

    expect(draft.headlineCkb).toBe('کۆنفرانسی نیشتمانی متمانەبەخشین');
    expect(draft.exactCopy.map((block: any) => block.text)).toEqual([
      'کۆنفرانسی نیشتمانی متمانەبەخشین',
      '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر',
    ]);
    expect(draft.designInstructions).toBe('تکایە پۆستێکم بۆ دروست بکە بۆ ڕاگەیاندنی کۆنفرانسەکە');
  });

  it('still strips the English openings that already worked', async () => {
    const text = 'I need a poster for the launch, keep it formal\n\nNATIONAL ACCREDITATION CONFERENCE\n\nSeptember 9, 2026, Erbil';
    const draft = await prepare(text);
    expect(draft.headlineEn).toBe('NATIONAL ACCREDITATION CONFERENCE');
  });

  it('routes a brand name that carries a Sorani suffix to its client', async () => {
    const draft = await prepare('بانگهێشتنامەیەک بۆ KAAEی\n\nکۆنفرانسی ساڵانە');
    expect(draft.clientId).toBe('c1000000-0000-4000-8000-000000000002');
  });

  it('does not route on a brand name welded onto the end of a Kurdish word', async () => {
    // \b sees a word boundary wherever the script changes, so "rona" stuck to the end of a Kurdish
    // word scoped the request to a client the sender never named. An unscoped request waits for the
    // art director instead, which is the safe side of Invariant #4.
    const draft = await prepare('داواکاری دیزاین بۆ کۆمپانیایrona\n\nناونیشانی ڕووداوەکە');
    expect(draft.clientId).toBeNull();
  });
});
