import { describe, expect, it } from 'vitest';
import { continuesBrief } from '../src/services/lifecycle-brief-parts.js';
import { asksForNewDesign, isPlainQuestion, planTurn, readIntentByRules, readsAsBriefContinuation, slowDesigns, statusText,
  withoutBotMentions, type ChatRequestView, type TurnInput } from '../src/services/requester-turn.js';

/**
 * ADR-182: the rules behind the natural-language stress suite's fixes (natural-language-stress.test.ts
 * plays the conversations; these pin the readings). Sorani lines carry their meaning in a comment.
 */
describe('cancelling said around other words', () => {
  it.each(['never mind, cancel it', 'no need anymore, thanks', 'no, stop', 'ok forget it, sorry', 'no need anymore',
    // "No, cancel it"
    'نا، هەڵیبوەشێنەوە',
  ])('"%s" is a cancellation', (words) => {
    expect(readIntentByRules(words).intent).toBe('cancel');
  });

  it.each(['no need to change the logo, but make the title bigger', 'stop using red, use blue'])('"%s" is not', (words) => {
    expect(readIntentByRules(words).intent).not.toBe('cancel');
  });
});

describe('asking where a design is, impatiently', () => {
  it.each(['??', 'hello??', 'this is useless, where is my poster???', 'why is it taking so long??', 'still nothing'])(
    '"%s" asks how the design is going', (words) => {
      expect(readIntentByRules(words).intent).toBe('status');
    });

  it('a slow design is said to be slow', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const r: ChatRequestView = { requestId: 'r1', stage: 'designing', rev: 1, currentTaskId: 't1', clientId: null, title: 'KAAE: Members evening…',
      activeAt: '2026-09-30T11:00:00Z', createdAt: '2026-09-30T11:00:00Z', question: null, requesterId: null };
    expect(slowDesigns([r], now)).toEqual([r]);
    expect(slowDesigns([{ ...r, activeAt: '2026-09-30T11:50:00Z' }], now)).toEqual([]);
    expect(statusText([r], 'en', new Set(['r1']))).toMatch(/taking longer than usual/);
    expect(statusText([r], 'en')).toMatch(/usually takes a few minutes/);
  });
});

describe('deadlines in Sorani words', () => {
  it.each([
    // "We need it by next Thursday"
    'تا پێنجشەممەی داهاتوو پێویستمانە',
    // "We need it on Saturday"
    'شەممە پێویستمانە',
    // "Before the end of the week"
    'پێش کۆتایی هەفتە',
  ])('"%s" is a deadline', (words) => {
    expect(readIntentByRules(words).intent).toBe('deadline');
  });
});

describe('questions the bot cannot answer', () => {
  it.each(['how much does a poster cost?', 'do you have our logo already?', 'can you make videos?',
    // "How much is a poster?"
    'نرخی پۆستەرێک چەندە؟',
  ])('"%s" is a question, not a design request', (words) => {
    expect(asksForNewDesign(words)).toBe(false);
    expect(isPlainQuestion(words)).toBe(true);
  });

  it('a request phrased as a question is still a request', () => {
    expect(asksForNewDesign('Can you make a poster for Nawroz?')).toBe(true);
    // "Can you make us a poster for Nawroz?"
    expect(asksForNewDesign('دەتوانن پۆستەرێکمان بۆ دروست بکەن بۆ نەورۆز؟')).toBe(true);
  });

  it('is passed to the office, with nothing open or with a design on the way', () => {
    const plan = planTurn(input('how much does a poster cost?', []));
    expect(plan).toEqual({ kind: 'forward', words: 'how much does a poster cost?', question: true });
    expect(planTurn(input('can you make videos?', []))).toMatchObject({ kind: 'forward', question: true });
  });
});

describe('short complete briefs are drafted', () => {
  it.each([
    'Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.',
    // "Make a poster with these photos for KAAE's graduation, 12 October, Rotana hotel"
    'پۆستەرێک بەم وێنانە دروست بکە بۆ دەرچوونی KAAE، ١٢ی تشرینی یەکەم، هۆتێلی ڕۆتانا',
  ])('"%s" carries its copy', (words) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'new_brief', explicitNew: true, instructionOnly: false });
  });

  it('a request with no copy still goes to a person', () => {
    expect(readIntentByRules('make me a nice poster')).toMatchObject({ intent: 'new_brief', instructionOnly: true });
  });
});

describe('a brief typed as several messages', () => {
  it.each([
    ['Date: 12 October 2026 at 5 pm', 'Hi, we need a poster for the KAAE graduation ceremony'],
    ['Venue: University of Kurdistan main hall', 'Hi, we need a poster for the KAAE graduation ceremony\nDate: 12 October 2026 at 5 pm'],
    ['and use our blue colours please', 'KAAE members evening\nDate: 4 December 2026, 7 pm'],
    ['please make a poster from this', 'KAAE Quality Assurance Seminar\n3 December 2026, 11 am'],
    // "on 1 March at 10 in the morning, at the university hall", after "Hello, we want a poster for KAAE / for the teachers' day celebration"
    ['ڕۆژی ١ی ئازار کاتژمێر ١٠ی بەیانی لە هۆڵی زانکۆ', 'سڵاو، پۆستەرێکمان دەوێت بۆ KAAE\nبۆ ئاهەنگی ڕۆژی مامۆستا'],
  ])('"%s" goes on with the brief', (words, soFar) => {
    expect(readsAsBriefContinuation(words, soFar)).toBe(true);
  });

  it.each([
    ['thanks', 'KAAE members evening'],
    ['is it ready?', 'KAAE members evening'],
    ['cancel that', 'KAAE members evening'],
    ['sorry, the date is the 5th not the 4th', 'KAAE members evening\nDate: 4 December 2026'],
    ['Another poster please: KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium.', 'KAAE members evening'],
    ['Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm at the stadium', 'KAAE members evening\nDate: 4 December 2026, 7 pm'],
  ])('"%s" stands on its own', (words, soFar) => {
    expect(readsAsBriefContinuation(words, soFar)).toBe(false);
  });

  const typed = { windowSeconds: 15, continues: (text: string, soFar: string) => readsAsBriefContinuation(text, soFar) };
  const part = (text: string, date: number, forwarded = false) => ({ text, date, forwarded, reply: false });

  it('joins within the brief\'s hold, and not after it', () => {
    const first = part('Hi, we need a poster for the KAAE graduation ceremony', 100);
    expect(continuesBrief(first, part('Date: 12 October 2026 at 5 pm', 106), 5, typed)).toEqual({ separator: '\n', typed: true });
    expect(continuesBrief(first, part('Date: 12 October 2026 at 5 pm', 130), 5, typed)).toBeNull();
    // Without the typed reading (as before ADR-182) only a Telegram split or forwards join.
    expect(continuesBrief(first, part('Date: 12 October 2026 at 5 pm', 106), 5)).toBeNull();
  });

  it('a forward sent right after its instruction joins it', () => {
    expect(continuesBrief(part('Can you make a poster from the message below?', 100),
      part('KAAE Open Day\nSaturday 7 November 2026', 104, true), 5, typed)).toEqual({ separator: '\n\n', typed: true });
  });
});

describe('the bot\'s name in a group', () => {
  it('is not part of the words', () => {
    expect(withoutBotMentions('@hawa_office_bot KAAE members evening\nDate: 4 December')).toBe('KAAE members evening\nDate: 4 December');
    expect(withoutBotMentions('hi @hawa_office_bot is the poster ready?')).toBe('hi is the poster ready?');
    // People's names stay.
    expect(withoutBotMentions('please ask @dara_k about the logo')).toBe('please ask @dara_k about the logo');
  });
});

describe('a reply to a message about a design no longer on the way', () => {
  it('goes to the office, never "nothing in progress"', () => {
    const plan = planTurn({ ...input('the phone number on this is wrong, it should be 0750 123 4567', []), bound: ['old-request'] });
    expect(plan).toEqual({ kind: 'forward', words: 'the phone number on this is wrong, it should be 0750 123 4567' });
  });
});

function input(text: string, requests: ChatRequestView[]): TurnInput {
  return { text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: '1', officeIds: [],
    group: false, addressed: true, pendingAsk: null, now: Date.now() };
}
