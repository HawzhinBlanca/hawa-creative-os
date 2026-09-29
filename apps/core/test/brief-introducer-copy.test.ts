import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake, isCopyIntroducer } from '../src/services/chat-campaign-intake.js';
import { savedDesignCopy } from '../src/services/saved-design-copy.js';
import { designName } from '../src/services/requester-turn.js';

/**
 * Production, 2026-09-29: a Telegram album caption ended its instructions with "Here is the text and
 * the photos:" on a line of its own. Intake took that line for copy: the task was titled
 * "KAAE: Here is the text and the photos:…" and it became copy block 0 of the design. A line that
 * introduces the text is an instruction; the lines after it are the copy, one block each, in order.
 *
 * ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
 * lifecycle (lifecycle-internal.routes.ts), so the reading is asserted on that draft.
 */
function prepare(text: string) {
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `introducer-${randomUUID()}`, sourceChannelId: `introducer-${randomUUID()}`,
    senderName: 'Office', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

type Block = { text: string; role?: string; language?: string; direction?: string };
const blocks = (draft: { exactCopy: unknown[] }) => draft.exactCopy as Block[];
const texts = (draft: { exactCopy: unknown[] }) => blocks(draft).map((block) => block.text);

// The owner's caption, verbatim (curly apostrophes included).
const OWNER_INSTRUCTIONS =
  'Design a professional report cover for KAAE using only the provided field-visit photos and the provided text. Arrange the supplied photos in a clean, structured collage across the upper and middle sections. Use KAAE’s navy blue, yellow, and white brand colors, with a dark navy overlay or gradient toward the lower section to create a clear text area. Place the KAAE logo near the top and use a thin yellow border as a framing element. Keep the provided title, subtitle, supporting text, and website exactly as written, without rewriting or shortening them. Use bold white and yellow typography with clear hierarchy. The overall design should feel modern, formal, institutional, educational, and suitable for an official KAAE report cover. Do not generate new photos or replace the supplied ones and you don’t have to use all the photos, choose the best ones based on your design.';
const OWNER_CAPTION = `${OWNER_INSTRUCTIONS}

Here is the text and the photos:

KAAE K-12 Pilot Study
Field Visit Report

Insights from KAAE school field visits and next steps toward`;

describe('a line that introduces the text is not copy', () => {
  it('reads the owner’s album caption of 2026-09-29: the introducer is an instruction, each line after it is copy', async () => {
    const draft = await prepare(OWNER_CAPTION);

    expect(draft.clientId).toBe('c1000000-0000-4000-8000-000000000002');
    expect(draft.headlineEn).toBe('KAAE K-12 Pilot Study');
    expect(draft.title.startsWith('KAAE: KAAE K-12 Pilot Study')).toBe(true);
    expect(texts(draft)).toEqual([
      'KAAE K-12 Pilot Study',
      'Field Visit Report',
      'Insights from KAAE school field visits and next steps toward',
    ]);
    expect(blocks(draft).map((b) => b.role)).toEqual(['headline', 'body', 'body']);
    expect(blocks(draft).every((b) => b.language === 'en' && b.direction === 'ltr')).toBe(true);
    expect(draft.designInstructions).toContain(OWNER_INSTRUCTIONS);
    expect(draft.designInstructions).toContain('Here is the text and the photos:');
    for (const block of texts(draft)) expect(block).not.toContain('Here is the text');
    expect(draft.title).not.toContain('Here is the text');
  });

  it('reads a Sorani request whose copy follows "دەقەکە:"', async () => {
    const instructions = 'تکایە پۆستەرێک بۆ کەی ئەی ئەی دروست بکە بە ڕەنگی شین و زەرد، لۆگۆکە لە سەرەوە دابنێ';
    const draft = await prepare(`${instructions}\n\nدەقەکە:\nکۆنفرانسی نیشتمانی متمانەبەخشین\n٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر`);

    expect(draft.headlineCkb).toBe('کۆنفرانسی نیشتمانی متمانەبەخشین');
    expect(draft.title).toBe('KAAE: کۆنفرانسی نیشتمانی متمانەبەخشین…');
    expect(texts(draft)).toEqual([
      'کۆنفرانسی نیشتمانی متمانەبەخشین',
      '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر',
    ]);
    expect(blocks(draft).every((b) => b.language === 'ckb' && b.direction === 'rtl')).toBe(true);
    expect(draft.designInstructions).toContain(instructions);
    expect(draft.designInstructions).toContain('دەقەکە:');
  });

  it('reads an introducer on the first line of a Sorani request', async () => {
    const draft = await prepare('ئەمە دەقەکەیە:\nکۆنفرانسی ساڵانەی کەی ئەی ئەی\nهەولێر، ٢٠٢٦');

    expect(draft.headlineCkb).toBe('کۆنفرانسی ساڵانەی کەی ئەی ئەی');
    expect(texts(draft)).toEqual(['کۆنفرانسی ساڵانەی کەی ئەی ئەی', 'هەولێر، ٢٠٢٦']);
    expect(draft.designInstructions).toBe('ئەمە دەقەکەیە:');
  });

  it('reads English instructions, "Here is the text:" and mixed English and Sorani lines, each in its own script', async () => {
    const draft = await prepare(
      'Please design a KAAE poster in navy and yellow, formal and clean.\n\nHere is the text:\nKAAE Annual Conference\nکۆنفرانسی ساڵانەی کەی ئەی ئەی',
    );

    expect(texts(draft)).toEqual(['KAAE Annual Conference', 'کۆنفرانسی ساڵانەی کەی ئەی ئەی']);
    expect(blocks(draft).map((b) => [b.language, b.direction])).toEqual([['en', 'ltr'], ['ckb', 'rtl']]);
    expect(draft.title).toBe('KAAE: KAAE Annual Conference…');
    expect(draft.designInstructions).toBe('Please design a KAAE poster in navy and yellow, formal and clean.\nHere is the text:');
  });

  it('keeps an invitation’s own "Speakers:" and "Date:" lines as copy', async () => {
    const draft = await prepare(
      'I need an invitation for KAAE, keep it formal\n\nNational Accreditation Forum\n\nSpeakers:\nDr. Ahmed Ali\nDr. Sara Omar\n\nDate:\n9 September 2026, Erbil',
    );

    expect(draft.headlineEn).toBe('National Accreditation Forum');
    expect(texts(draft)).toEqual([
      'National Accreditation Forum',
      'Speakers:\nDr. Ahmed Ali\nDr. Sara Omar',
      'Date:\n9 September 2026, Erbil',
    ]);
    expect(draft.designInstructions).toBe('I need an invitation for KAAE, keep it formal');
  });

  it('keeps today’s paragraph blocks when no line introduces the text', async () => {
    const draft = await prepare(
      'I need a poster for the launch, keep it formal\n\nK-12 STANDARDS FRAMEWORK\nEDITION 2.0\n\nNow available at kaae.org.',
    );

    expect(draft.headlineEn).toBe('K-12 STANDARDS FRAMEWORK');
    expect(texts(draft)).toEqual(['K-12 STANDARDS FRAMEWORK\nEDITION 2.0', 'Now available at kaae.org.']);
    expect(draft.designInstructions).toBe('I need a poster for the launch, keep it formal');
  });

  it('names introducers, and not copy that happens to end with a colon', () => {
    for (const line of [
      'Here is the text and the photos:', 'The text:', 'Text:', 'Text to use:', 'Please use this text:',
      'Here are the words:', 'Below is the copy:', 'Copy for the poster:', 'And here is the wording:',
      'دەقەکە:', 'ئەمە دەقەکەیە:', 'دەق و وێنەکان:', 'ئەمانە دەقەکانن:', 'نووسینەکە:', 'ئەم دەقە بنووسە:',
    ]) expect(isCopyIntroducer(line), line).toBe(true);
    for (const line of [
      'Speakers:', 'Date:', 'Mission:', 'Agenda:', 'Content Strategy Workshop:', 'Words of wisdom:',
      'Here is the text and the photos', 'KAAE K-12 Pilot Study', 'وشەی سەرۆک:', 'بەروار:',
      'Details:',
    ]) expect(isCopyIntroducer(line), line).toBe(false);
  });
});

/**
 * Task ba4469f2 was stored by the old intake: copy block 0 the introducer, the title and subtitle one
 * paragraph. An office retry (ADR-142) designs that stored task again, so the copy it reads and the
 * name the requester hears follow the new rule without rewriting the stored request.
 */
describe('a request stored before the fix is read by the same rule (ADR-142)', () => {
  const stored = { payload: { title: 'KAAE: Here is the text and the photos:…', designInstructions: OWNER_INSTRUCTIONS,
    exactCopy: [
      { id: 'copy_0', role: 'headline', text: 'Here is the text and the photos:' },
      { id: 'copy_1', role: 'body', text: 'KAAE K-12 Pilot Study\nField Visit Report' },
      { id: 'copy_2', role: 'body', text: 'Insights from KAAE school field visits and next steps toward' },
    ] } };

  it('reads the owner\'s stored copy as the three lines, the introducer among the instructions', () => {
    const read = savedDesignCopy(stored, '');
    expect(read.copy).toEqual(['KAAE K-12 Pilot Study', 'Field Visit Report', 'Insights from KAAE school field visits and next steps toward']);
    expect(read.instructions).toContain(OWNER_INSTRUCTIONS);
    expect(read.instructions).toContain('Here is the text and the photos:');
  });

  it('leaves stored copy without an introducer as it was, paragraphs included', () => {
    const plain = { payload: { exactCopy: [{ text: 'Speakers:' }, { text: 'Dr. Aram\nDr. Shno' }] } };
    expect(savedDesignCopy(plain, '').copy).toEqual(['Speakers:', 'Dr. Aram\nDr. Shno']);
  });

  it('names a task titled from its introducer "your design" to the requester, and any other title as before', () => {
    expect(designName('KAAE: Here is the text and the photos:…', 'en')).toBe(designName('', 'en'));
    expect(designName('KAAE: KAAE K-12 Pilot Study…', 'en')).toBe('<b>KAAE K-12 Pilot Study…</b>');
  });
});
