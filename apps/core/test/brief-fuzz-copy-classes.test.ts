import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import type { ChatIntake } from '../src/services/chat-intake.js';
import { closingStart, copyTitle, extractRequestCopy } from '../src/services/request-copy-extraction.js';

/**
 * Brief phrasing fuzz, the copy classes (ADR-284 addendum "brief phrasing fuzz: copy classes", 2026-10-03). The fuzz
 * report (output/research/2026-10-03-brief-fuzz/REPORT.md) found briefs whose closing, client sentence, "with these
 * details:" tail, list marks, glued greeting, month abbreviation, bare "need a …" or long single sentence were printed
 * as the design's copy (or lost it). Each case here goes through the real route `/v1/internal/telegram/intake`, as the
 * fuzz harness does (no model call), and checks the copy lines the design would print. The controls are words that
 * look like those but are the requester's copy, and stay.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const WORKER = ['worker', 'copy', 'classes', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
const MEMBER0 = 93_400_000;
let next = 0;
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = Array.from({ length: 200 }, (_, i) => String(MEMBER0 + i)).join(',');
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

const message = (chat: number, text: string, answer = false) => {
  const id = 1_600_000_000 + (chat - MEMBER0) * 2 + (answer ? 1 : 0);
  return { update_id: id, message: { message_id: id % 100000, from: { id: chat, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};
const intake = async (update: unknown) => {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const app = createApp({ db, requesterIntentModel: null } as any);
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};

/** The brief through the route (answering "KAAE" when asked who it is for): its printed lines, title and client. */
async function open(brief: string) {
  const chat = MEMBER0 + next++;
  const first = await intake(message(chat, brief));
  const opened = first.clientQuestion === true ? await intake(message(chat, 'KAAE', true)) : first;
  expect(opened.lifecycleAction, JSON.stringify(opened).slice(0, 300)).toBe('open-request');
  const draft = opened.draft as { exactCopy: Array<{ text: string }>; title: string; clientId: string; copyExtraction?: { method: string } };
  const lines = draft.exactCopy.flatMap((b) => b.text.split('\n')).map((l) => l.trim()).filter(Boolean);
  return { lines, title: draft.title, clientId: draft.clientId, method: draft.copyExtraction?.method ?? null };
}

type Case = [brief: string, lines: string[]];
const prints = (cases: Case[]) => it.each(cases)('%j', async (brief, lines) => {
  expect((await open(brief)).lines).toEqual(lines);
});

describe('1. a closing or sign-off is never printed', () => {
  prints([
    ['Could you make a KAAE poster for the Book Fair on 5 November?\nBest regards,\nAhmed', ['Book Fair on 5 November']],
    ['Could you make a KAAE poster for the Book Fair on 5 November? Many thanks!', ['Book Fair on 5 November']],
    ['Please make a KAAE poster for the Science Camp on 20 March 2027 thanks', ['Science Camp on 20 March 2027']],
    ['pls make a KAAE banner to announce the Career Fair October 15 Thanks!', ['Career Fair October 15']],
    ['Hello everyone!\npls make a KAAE invitation card about our Spring Concert 15/10/2026 Best regards,\nAhmed', ['Spring Concert 15/10/2026']],
    ["Salam, can u do a certificate for KAAE's Leadership Training Course 20 March 2027 pls Regards, Sara", ['Leadership Training Course 20 March 2027']],
    ['Make me a post for KAAE with this text:\nresearch day\nFor school principals\nOct. 20 at 10:00 AM\nthe main campus\nMany thanks!',
      ['research day', 'For school principals', 'Oct. 20 at 10:00 AM', 'the main campus']],
    ['hello\nCould you please prepare a KAAE invitation card for this:\nTeacher Appreciation Day\nnext Thursday\nthe KAAE hall, Erbil\nBest regards,\nAhmed',
      ['Teacher Appreciation Day', 'Next Thursday', 'The KAAE hall, Erbil']],
  ]);
  describe('controls: an event named with those words stays', () => {
    prints([
      ['Could you design a KAAE poster for the Thanks Giving Fair on 5 November?', ['Thanks Giving Fair on 5 November']],
      ['Could you design a KAAE poster for the Best Regards Gala on 5 November?', ['Best Regards Gala on 5 November']],
      ['Please make a KAAE poster with this text:\nSpring Concert\n5 November\nMany thanks to our sponsors',
        ['Spring Concert', '5 November', 'Many thanks to our sponsors']],
      ['Can you make a KAAE poster for the Book Fair on 9 November? Thank you for coming to our fair.', ['Book Fair on 9 November', 'Thank you for coming to our fair']],
    ]);
  });
});

describe('2. a sentence naming the client is never printed', () => {
  prints([
    ["Could you make a poster for the Book Fair on 5 November? It's for KAAE.", ['Book Fair on 5 November']],
    ['Could you make a poster for the Book Fair on 5 November? This is for KAAE.', ['Book Fair on 5 November']],
    ['Could you make a poster for the Book Fair on 5 November? For KAAE please.', ['Book Fair on 5 November']],
    ['Could you make a poster for the Book Fair on 5 November? It is for the Kurdistan Accrediting Association for Education.', ['Book Fair on 5 November']],
    ['need a certificate for our Quality Assurance Workshop 3rd of December pls It is for the Kurdistan Accrediting Association for Education. Regards, Sara',
      ['Quality Assurance Workshop 3rd of December']],
    ["Good afternoon,\nMake me a certificate for this:\nAccreditation Seminar\n15/10/2026 at 9:30\nIt's for KAAE.\nThanks!", ['Accreditation Seminar', '15/10/2026 at 9:30']],
    ['We need a post for this:\nParents Meeting\nMonday 12 November at 9:30\nthe KAAE hall, Erbil\nIt is for the Kurdistan Accrediting Association for Education.\nRegards, Sara',
      ['Parents Meeting', 'Monday 12 November at 9:30', 'the KAAE hall, Erbil']],
  ]);
  describe('controls: the client inside the copy stays', () => {
    prints([
      ['Could you design a poster for the KAAE Open Day on 5 November?', ['KAAE Open Day on 5 November']],
      ['Could you design a KAAE poster for the Book Fair on 5 November? Free for KAAE members.', ['Book Fair on 5 November', 'Free for KAAE members']],
    ]);
  });
});

describe('3. "with these details:" and list marks are never printed', () => {
  prints([
    ['Hi team,\ncan u make a KAAE post with these details:\n- Nawroz Celebration\n- 3rd of December\n- Sami Abdulrahman Park',
      ['Nawroz Celebration', '3rd of December', 'Sami Abdulrahman Park']],
    ['Hello\nCan you create a KAAE poster with this text:\nQuality Assurance Workshop\nFor all teachers\n3rd of December at 7pm',
      ['Quality Assurance Workshop', 'For all teachers', '3rd of December at 7pm']],
    ['Make me a KAAE story with these details:\n* nawroz celebration\n* 20 March 2027\n* the main campus', ['nawroz celebration', '20 March 2027', 'the main campus']],
    ["We'd like a KAAE Instagram post with these details:\n- Parents Meeting\n- 15 October 2026\n- Saad Abdullah Hall",
      ['Parents Meeting', '15 October 2026', 'Saad Abdullah Hall']],
    ['Good afternoon,\nPlease make a KAAE poster with these details:\n• Assessment Literacy Workshop\n• October 15 2 pm\n• Saad Abdullah Hall',
      ['Assessment Literacy Workshop', 'October 15 2 pm', 'Saad Abdullah Hall']],
    ['Good morning team,\nWe want a poster for KAAE with these details:\n* Teacher Appreciation Day\n* 3rd of December 7pm\n* Saad Abdullah Hall',
      ['Teacher Appreciation Day', '3rd of December 7pm', 'Saad Abdullah Hall']],
  ]);
  it('the title names the event, not the tail or a list mark', async () => {
    expect((await open('Hi team,\ncan u make a KAAE post with these details:\n- Nawroz Celebration\n- 3rd of December\n- Sami Abdulrahman Park')).title)
      .toBe('KAAE: Nawroz Celebration');
    expect((await open('Make me a KAAE story with these details:\n* Research Day\n* 20 March 2027\n* the main campus')).title).toBe('KAAE: Research Day');
  });
  describe('controls: quoted and laid-out copy stays as typed', () => {
    prints([
      ['Could you design a KAAE flyer that says "Grand Opening Sale" and "50% off everything" on 5 November?', ['Grand Opening Sale', '50% off everything', '5 November']],
      ['Please design a KAAE poster.\n\nHere is the text:\nKAAE Annual Conference\n9 September 2026 - Saad Abdullah Hall',
        ['KAAE Annual Conference', '9 September 2026 - Saad Abdullah Hall']],
    ]);
  });
});

describe('4 and 7. an event-first brief prints the event and its date, split only at "is on"', () => {
  prints([
    ['Hello, our Open Day is on 5 November. Could you make a KAAE poster for it?', ['Open Day', '5 November']],
    ["KAAE's Research Day is on 15 October 2026 at Rotana Hotel. Please design a nice poster for it.", ['Research Day', '15 October 2026 at Rotana Hotel']],
    ['Hello Our Open Day is on 5 November. Could you design a KAAE poster for it?', ['Open Day', '5 November']],
    ['Good morning Our Parents Meeting is on 15/10/2026. can u make a nice KAAE poster for it?', ['Parents Meeting', '15/10/2026']],
    ['Salam The graduation ceremony is on 3rd of December in the main campus. We want a KAAE banner for it.', ['Graduation ceremony', '3rd of December in the main campus']],
  ]);
  describe('controls', () => {
    prints([
      ['KAAE Open Day is on 5 November. Could you make a poster for it?', ['KAAE Open Day', '5 November']],
      ['The Book Fair is open to everyone on 5 November. Could you make a KAAE poster for it?', ['The Book Fair is open to everyone on 5 November']],
      ['The workshop is for all teachers and is on 5 November. Could you make a KAAE poster for it?', ['The workshop is for all teachers and is on 5 November']],
      ['Could you design a KAAE poster for Hello Kitty Day on 5 November?', ['Hello Kitty Day on 5 November']],
    ]);
  });
});

describe('6. the client named after "for" with more words is never printed', () => {
  prints([
    ['Salam\nCould you do a flyer for KAAE please\nAssessment Literacy Workshop\n3rd of December at 7pm',
      ['Assessment Literacy Workshop', '3rd of December at 7pm']],
    ["Hi\nI'd like an Instagram post for KAAE with these details:\n• Assessment Literacy Workshop\n• October 15 9:30\n• Rotana Hotel\nThanks in advance 🙏",
      ['Assessment Literacy Workshop', 'October 15 9:30', 'Rotana Hotel']],
    // Sorani: the request names KAAE in Sorani spelling (lines from this repository's tests).
    ['سڵاو\nتکایە پۆستێک بۆ کەی ئەی ئەی دروست بکە\nکۆنفرانسی ساڵانەی متمانەبەخشین\nشوێن: هۆتێلی ڕۆتانا',
      ['کۆنفرانسی ساڵانەی متمانەبەخشین', 'شوێن: هۆتێلی ڕۆتانا']],
  ]);
});

describe('9. a month abbreviation does not end a sentence', () => {
  prints([
    ["Could you design a KAAE poster for the Open Day? It's on Oct. 20 in the main campus.", ['Open Day', 'Oct. 20 in the main campus']],
    ['Could you design a KAAE poster for the Book Fair on 5 Nov. 2026?', ['Book Fair on 5 Nov. 2026']],
    ['We need a post announcing the KAAE Teacher Appreciation Day on Sept. 20 at 9:30. Many thanks!', ['KAAE Teacher Appreciation Day on Sept. 20 at 9:30']],
  ]);
});

describe('10. a bare "need a …" asks for the design', () => {
  prints([
    ['need a KAAE poster for the Book Fair on 5 November.', ['Book Fair on 5 November']],
    ['Dear team, need a post to announce the KAAE Annual Conference 15 October 2026 thank you', ['KAAE Annual Conference 15 October 2026']],
  ]);
  describe('control: "need a card" said to the audience stays', () => {
    prints([
      ['Could you design a KAAE poster for the Book Fair on 5 November? Students need a card to enter.',
        ['Book Fair on 5 November', 'Students need a card to enter']],
    ]);
  });
});

describe('11. a long one-sentence brief keeps its copy, split at its audience and date', () => {
  it('splits before the length check instead of opening with no copy', async () => {
    const got = await open('We want a post for the upcoming KAAE Quality Assurance Workshop for parents and students on Monday 12 November at 2 pm in the main campus. Many thanks!');
    expect(got.method).toBe('rules');
    expect(got.lines).toEqual(['Upcoming KAAE Quality Assurance Workshop', 'For parents and students', 'Monday 12 November at 2 pm in the main campus']);
    expect(got.clientId).toBe(KAAE);
  });
  it('a headline that fits is not split', async () => {
    expect((await open('Could you make a KAAE poster for the Parents Meeting for all teachers on 20 March 2027 at 9:30?')).lines)
      .toEqual(['Parents Meeting for all teachers on 20 March 2027 at 9:30']);
  });
});

describe('the copy reader alone (no route)', () => {
  const prepared = (words: string): ChatIntake => ({ platform: 'telegram', sourceEventId: 'lc-x-r0', sourceChannelId: '64000001',
    rawText: words, title: 'x', clientId: KAAE, designInstructions: '',
    exactCopy: [{ id: 'copy_0', role: 'headline', text: words, language: 'en', direction: 'ltr', approved: true, protectedTokens: [] }],
    autoGenerate: true } as ChatIntake);
  const printed = async (words: string) => ((await extractRequestCopy(prepared(words), { model: null, tenantId: 't', updateId: 1,
    senderName: 'Requester' })).exactCopy as Array<{ text: string }>).map((b) => b.text);

  it('a headline that names nothing is titled by the next copy line, never only "KAAE: "', () => {
    expect(copyTitle('With these details', 'KAAE', true, ['Nawroz Celebration', '3rd of December'])).toBe('KAAE: Nawroz Celebration');
    expect(copyTitle('with this text:', 'KAAE', true, ['- Research Day'])).toBe('KAAE: Research Day');
    expect(copyTitle('', 'KAAE', true, ['', 'Open Day'])).toBe('KAAE: Open Day');
    expect(copyTitle('- ', 'Sewa', false, ['Spring Concert'])).toBe('Sewa: Spring Concert');
    // Nothing names it: the label alone, never "KAAE: ".
    expect(copyTitle('With these details', 'KAAE', true)).toBe('KAAE');
    // A headline that names something keeps its title; the next lines are not read.
    expect(copyTitle('Book Fair', 'KAAE', true, ['5 November'])).toBe('KAAE: Book Fair');
    expect(copyTitle('Details Day', 'KAAE', true, ['5 November'])).toBe('KAAE: Details Day');
  });

  it('a bare "want a …" at the start of a brief asks for the design (class 10)', async () => {
    expect(await printed('want a KAAE flyer for the Science Camp on 20 March 2027')).toEqual(['Science Camp on 20 March 2027']);
  });

  it.each([
    ['Book Fair on 5 November. Thanks!', 'Book Fair on 5 November.'],
    ['Book Fair on 5 November Many thanks!', 'Book Fair on 5 November'],
    ['Book Fair on 5 November\nBest regards,\nAhmed', 'Book Fair on 5 November'],
    ['Book Fair 15/10/2026 pls Regards, Sara', 'Book Fair 15/10/2026'],
    ['Book Fair next Thursday Thanks a lot', 'Book Fair next Thursday'],
    ['Book Fair 3rd of December Cheers', 'Book Fair 3rd of December'],
    // Stays: one closing word glued to a name, a closing inside the copy, an event named with those words, "RSVP please".
    ['A Night of Thanks', 'A Night of Thanks'],
    ['Many thanks to our sponsors', 'Many thanks to our sponsors'],
    ['Spring Concert\nMany thanks to our sponsors', 'Spring Concert\nMany thanks to our sponsors'],
    ['Best Regards Gala', 'Best Regards Gala'],
    ['Thanks Giving Fair on 5 November', 'Thanks Giving Fair on 5 November'],
    ['Gala dinner. RSVP please', 'Gala dinner. RSVP please'],
  ])('the closing of %j', (text, kept) => {
    expect(text.slice(0, closingStart(text)).trimEnd()).toBe(kept);
  });
});
