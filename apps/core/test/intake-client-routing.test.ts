import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';

/**
 * HUNT: intake names a request's client from substrings of common Sorani words. "دروستی" (the
 * Drustee alias) is inside "تەندروستی" (health) and is the everyday "دروستی بکە" (make it);
 * "پارەدان" (payment) names FastPay; "دەرمان" (medicine) names Drustee. These aliases resolve to the
 * seeded Drustee and FastPay client rows (CLIENT_ALIAS_TO_UUID), so the request would be scoped to a
 * client the sender never named (Invariant #4) and drafted automatically for it.
 *
 * ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
 * lifecycle (lifecycle-internal.routes.ts), so the routing is asserted on that draft.
 */
const DRUSTEE = 'c1000000-0000-4000-8000-000000000003';

function send(text: string) {
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `hunt-routing-${randomUUID()}`, sourceChannelId: `hunt-routing-${randomUUID()}`,
    senderName: 'Office', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

describe('review of 2026-09-24: a client is never named by a word inside another word', () => {
  it('"Ministry of Health" (وەزارەتی تەندروستی) is not a Drustee request, and is not drafted automatically', async () => {
    // Moved from telegram-requester-loop.test.ts, which drove the deleted legacy webhook: the request
    // was scoped to the seeded Drustee row and queued for an automatic draft.
    const draft = await send('بانگهێشت بۆ سیمیناری وەزارەتی تەندروستی\n\n١٢ی تشرینی یەکەم، هۆڵی ئاسیا، هەولێر');
    expect(draft.clientId).toBeNull();
    expect(draft.clientId).not.toBe(DRUSTEE);
    expect(draft.autoGenerate).toBe(false);
  });

  it('"make it" (دروستی بکە) is not a Drustee request', async () => {
    const draft = await send('ئەم پۆستەرە دروستی بکە\n\nڕۆژی مامۆستا\n١ی ئادار ٢٠٢٧');
    expect(draft.clientId).toBeNull();
  });

  it('"membership fee payment" (پارەدانی ئابوونە) is not a FastPay request', async () => {
    const draft = await send('ئاگاداری\n\nدوا وادەی پارەدانی ئابوونەی ئەندامان ٣٠ی ئەیلوولە');
    expect(draft.clientId).toBeNull();
  });
});
