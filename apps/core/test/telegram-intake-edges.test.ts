import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';

/**
 * HUNT (2026-09-24): inputs a real office sends. ADR-135 stage 2 deleted the legacy webhook these
 * cases drove (with its 20 MB, HEIC, greeting-reply and sticker cases); a new Telegram request is the
 * draft prepareChatCampaignDraft builds for the lifecycle, and its title is what the office and the
 * requester read.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('review of 2026-09-24: intake edges', () => {
  it('the request title never cuts an emoji in half', async () => {
    // The title is the headline cut to 45 UTF-16 units; the emoji straddles unit 45.
    const headline = 'KAAE ' + 'a'.repeat(39) + '🎓 Graduation Day';
    expect(headline.charCodeAt(44)).toBeGreaterThanOrEqual(0xd800);
    const text = `${headline}\n\nJune 1, 2027, Erbil`;
    const draft = await createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(55000000 + Math.floor(Math.random() * 1e6)),
      senderName: 'Office', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
    });
    // ADR-180: the headline already names the client, so it is not prefixed with it again.
    expect(draft.title.startsWith('KAAE aaaa')).toBe(true);
    expect(LONE_SURROGATE.test(draft.title)).toBe(false);
  });
});
