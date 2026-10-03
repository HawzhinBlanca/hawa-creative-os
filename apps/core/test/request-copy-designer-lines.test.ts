import { describe, expect, it } from 'vitest';
import type { ChatIntake } from '../src/services/chat-intake.js';
import { extractRequestCopy } from '../src/services/request-copy-extraction.js';

/**
 * Bug hunt 3 (2026-10-03): copy taken from a request sentence by the rules (ADR-232's path when no model reading is
 * available). A sentence addressed to the designer ("Don't forget the logo.", "Send it to me by Thursday.") was
 * printed on the design as its copy. Every case here failed before the fix but the audience's own words.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const prepared = (words: string): ChatIntake => ({ platform: 'telegram', sourceEventId: 'lc-x-r0', sourceChannelId: '64000001',
  rawText: words, title: 'x', clientId: KAAE, designInstructions: '',
  exactCopy: [{ id: 'copy_0', role: 'headline', text: words, language: 'en', direction: 'ltr', approved: true, protectedTokens: [] }],
  autoGenerate: true } as ChatIntake);
const printed = async (words: string) => ((await extractRequestCopy(prepared(words), { model: null, tenantId: 't', updateId: 1,
  senderName: 'Requester' })).exactCopy as Array<{ text: string }>).map((b) => b.text);

describe('a sentence to the designer is never printed as the design\'s copy', () => {
  const BRIEF = 'Can you make a poster for the Chess Club tournament? 8 November 2026, 3 pm, Family Mall. ';
  const TO_THE_DESIGNER = ["Don't forget the logo.", 'Do not include prices.', "Don't put any photos.", 'Put it in Kurdish too.',
    'Also in Kurdish please.', 'Send it to me by Thursday.', 'With our logo please.', 'A4 size please.', 'Please hurry.',
    "I'll send the photos later.", 'Ignore the old one.', 'Same style as last time.', 'Something modern.', 'Blue and gold colours.',
    'Nothing too fancy.', 'ASAP please.', 'Urgent!', 'Bigger title please.', 'Keep it simple.', 'Avoid red.',
    'Remember to add the QR code.', 'With 3 photos of the campus.', 'Mention free entry.', 'Let me know if you need anything.', 'Regards, Ahmed',
    'Note: the logo must be on top.', 'PS: use our colours', 'لۆگۆکە لەبیر مەکە'];
  it.each(TO_THE_DESIGNER)('"%s"', async (tail) => {
    expect(await printed(BRIEF + tail)).toEqual(['Chess Club tournament', '8 November 2026, 3 pm, Family Mall']);
  });

  it('words to the event\'s audience stay copy', async () => {
    for (const tail of ["Don't miss it!", 'Please bring your ID.', 'Use code SAVE10 at the door.', 'Send your questions to info@kaae.org.',
      'Join us!', 'Register now.', 'Free entry.', 'Mention this poster for a free coffee.', 'Keep calm and play chess.']) {
      expect(await printed(BRIEF + tail), tail).toEqual(['Chess Club tournament', '8 November 2026, 3 pm, Family Mall', tail.replace(/[.!]+$/u, '')]);
    }
  });
});

describe('quoted words are the headline; the date, time and place said beside them are not lost', () => {
  it.each([
    ['Can you make a poster for "Teacher Appreciation Day" on 20 October 2026 at 2 pm in the KAAE hall?',
      ['Teacher Appreciation Day', '20 October 2026 at 2 pm in the KAAE hall']],
    ['Could you design a poster for our workshop? The title is "Quality Week" and it is on 5 November at 10:00 in Rotana Hotel.',
      ['Quality Week', '5 November at 10:00 in Rotana Hotel']],
    ['Can you make a poster saying “Welcome Students!” for the first day of school on 15 September',
      ['Welcome Students!', 'For the first day of school on 15 September']],
  ])('%s', async (words, expected) => {
    expect(await printed(words)).toEqual(expected);
  });

  it('quotes that carry the copy keep it as before, with nothing added', async () => {
    expect(await printed('Could you design a flyer that says "Grand Opening Sale" and "50% off everything"?')).toEqual(['Grand Opening Sale', '50% off everything']);
    expect(await printed('Please make a poster with the title "Erbil Book Fair". Use our colours.')).toEqual(['Erbil Book Fair']);
  });
});
