import { describe, expect, it } from 'vitest';
import { reconsiderNewBrief } from '../src/services/brief-or-change.js';
import { planTurn, readIntentByRules, type ChatRequestView, type TurnInput, type TurnPlan } from '../src/services/requester-turn.js';

/**
 * ADR-272: the rules-only requester reading, after the 2026-10-02 NLU evaluation (plans/nlu-eval-2026-10-02).
 * Phrases are the evaluation's failures and their held-out paraphrases; Sorani lines carry their meaning in a
 * comment. Every plan here is what Core's intake plans with the model reading off: `readIntentByRules`, then
 * `planTurn`, then ADR-250's `reconsiderNewBrief`.
 */
const NOW = Date.parse('2026-10-02T09:00:00Z');
const view = (requestId: string, stage: ChatRequestView['stage'], title: string, minutesAgo = 5, rev = 2): ChatRequestView => ({
  requestId, stage, rev, currentTaskId: `${requestId}-task`, clientId: 'kaae', title,
  activeAt: new Date(NOW - minutesAgo * 60_000).toISOString(), createdAt: new Date(NOW - (minutesAgo + 1) * 60_000).toISOString(),
  question: null, requesterId: '1',
});
const QA = 'KAAE: Quality Assurance Workshop';
const IN_REVIEW = view('A', 'in_review', QA);
const DESIGNING = view('A', 'designing', QA);
const TWO_OPEN = [view('A', 'in_review', QA, 6), view('B', 'designing', 'KAAE: Teacher Appreciation Day', 3)];

function plan(text: string, requests: ChatRequestView[]): TurnPlan {
  const input: TurnInput = { text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: '1',
    officeIds: [], group: false, addressed: true, pendingAsk: null, now: NOW };
  const first = planTurn(input);
  return reconsiderNewBrief(input, first)?.plan ?? first;
}

describe('costly errors: nothing opened or withdrawn unless meant', () => {
  // Review of ADR-272 (2026-10-02): "something for" + a time read as a new design and opened a request
  // while one was being made; before ADR-272 it was a deadline. A time is when, not what.
  it.each(['we need something for tomorrow', 'we need something for tomorrow morning please', 'I need something for next week',
    'we need something for Monday', 'could you do something for this weekend'])(
    '"%s" said while a design is being made opens nothing', (words) => {
      expect(plan(words, [DESIGNING]).kind).not.toBe('open');
    });

  it('"something for" an event still opens a brief', () => {
    expect(plan('we need something for Nawroz', [DESIGNING])).toMatchObject({ kind: 'open' });
    expect(plan('we need something for the science fair next month', [])).toMatchObject({ kind: 'open' });
  });

  // "stop working on it" asked "change or new?" before and after ADR-272: cancel words never offer a new design.
  it('"stop working on it" is "stop it"; with "for now" it is a pause', () => {
    expect(plan('stop working on it', [DESIGNING])).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'A' }] });
    expect(plan('please stop working on the poster', [DESIGNING])).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'A' }] });
    expect(plan('stop working on it for now', [DESIGNING])).toMatchObject({ kind: 'note', note: 'hold', requestId: 'A' });
    expect(plan('stop working on the logo', [DESIGNING])).not.toMatchObject({ note: 'cancel' });
  });

  // Before ADR-272 "don't go ahead yet" contained "go ahead" and told the office it was approved.
  it.each(["don't go ahead yet", "please don't proceed for now", "don't start yet"])('"%s" pauses the design', (words) => {
    expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'note', note: 'hold', requestId: 'A' });
  });

  it.each(['forget about it', 'forget it', 'just forget it', 'oh well, forget about it then', 'ok forget it, sorry'])(
    '"%s" is a dismissal like "never mind": asked about, never withdrawn', (words) => {
      expect(readIntentByRules(words)).toMatchObject({ intent: 'cancel', bareCancel: true });
      expect(plan(words, [DESIGNING])).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false });
    });

  it.each(['forget the poster', "forget it, we don't need it anymore", 'forget about the workshop poster'])(
    '"%s" names the design, and is asked about before it is withdrawn (conversation fuzz, J2)', (words) => {
      expect(plan(words, [DESIGNING])).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'A' }] });
    });

  it.each([
    'the workshop is for university deans, not school principals',
    'the workshop is in the main hall, not the library',
    'the ceremony is at the hotel, not at the campus',
    "it's for the teachers, not the parents",
    'the event is on Thursday, not Wednesday',
  ])('"%s" corrects the design in review: kept for the office, never a second request', (words) => {
    expect(readIntentByRules(words).intent).toBe('change');
    expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'note', note: 'change', requestId: 'A' });
  });

  it('a correction with its own date and time is still a brief (ADR-250 decides)', () => {
    expect(readIntentByRules('the workshop is for deans, not principals, on 5 November at 10 am').intent).toBe('new_brief');
  });

  it.each([
    // "make another design, it should be better"
    'دیزاینێکی تر دروست بکە باشتر بێت',
    'can you make another design? a nicer one',
    'do another one, but better',
  ])('"%s" said on a draft redoes it; it opens nothing', (words) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'change', redo: 'redo' });
    expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'note', note: 'change', requestId: 'A', redo: true });
  });

  it('"another poster for the open day, a better one" names its own subject, so it asks', () => {
    expect(readIntentByRules('another poster for the open day, a better one')).toMatchObject({ intent: 'unclear', redo: 'or-new' });
  });

  it('a new design with its own event still opens while another is in review', () => {
    expect(plan("Can you also make a flyer for the parents' evening on 12 November at 6 pm?", [IN_REVIEW])).toMatchObject({ kind: 'open' });
    expect(plan('We also need a banner for the science fair, 3 December at the campus', [DESIGNING])).toMatchObject({ kind: 'open' });
  });
});

describe('edit words about the design on the way are a change, not "change or new?"', () => {
  it.each([
    'take the phone number out', 'get the QR code off it', 'no KAAE in the headline please', 'no logo on the bottom please',
    'hmm the font is hard to read', 'the text is way too small', 'honestly the colours look a bit dull', 'the photo is cut off',
    'please cancel the gold border', 'cancel the shadow behind the title', 'stop using that font', "please don't use red anywhere",
  ])('"%s" is kept for the office on the design in review', (words) => {
    expect(readIntentByRules(words).intent).toBe('change');
    expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'note', note: 'change', requestId: 'A' });
  });

  it('cancel words said of a part never withdraw, even with a design named', () => {
    expect(readIntentByRules('cancel the logo on the poster').intent).toBe('change');
    expect(plan('please cancel the gold frame on the Teacher Appreciation Day poster', TWO_OPEN))
      .toMatchObject({ kind: 'note', note: 'change', requestId: 'B' });
    // A design's own name that holds a part's word is still the design.
    expect(readIntentByRules('cancel the date night poster').intent).toBe('cancel');
    expect(plan('cancel the Teacher Appreciation Day poster', TWO_OPEN)).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'B' }] });
  });

  it('a change to a design that waits for changes starts its round only as the only candidate', () => {
    const waiting = view('A', 'awaiting_answer', QA, 5, 3);
    expect(plan('the font is hard to read', [waiting])).toMatchObject({ kind: 'revise', requestId: 'A' });
    // Two waiting, close together: never by recency; the requester is asked which.
    const other = view('B', 'awaiting_answer', 'KAAE: Teacher Appreciation Day', 4, 3);
    expect(plan('the font is hard to read', [waiting, other])).toMatchObject({ kind: 'ask', intent: 'change', allowNew: false });
  });

  it('praise is not a change', () => {
    expect(readIntentByRules('the title looks great').intent).not.toBe('change');
    expect(readIntentByRules("it's fine, not a problem").intent).not.toBe('change');
  });
});

describe('cancel words never offer a new design', () => {
  it('a Sorani named cancel with its reason asks about the design it names (L17 shape; J2)', () => {
    // "cancel the Teacher Appreciation Day poster, it was only a test"
    const words = 'پۆستەری Teacher Appreciation Day هەڵبوەشێنەوە، تەنها تاقیکردنەوە بوو';
    expect(readIntentByRules(words).intent).toBe('cancel');
    expect(plan(words, TWO_OPEN)).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'B' }] });
  });

  it('Sorani cancel words the rules cannot place are asked about as a cancel', () => {
    // "cancel the Teacher Appreciation Day poster, we'll talk about it later" (an unplaceable reason)
    const words = 'پۆستەری Teacher Appreciation Day هەڵبوەشێنەوە، دواتر قسەی لەسەر دەکەین';
    const reading = readIntentByRules(words);
    expect(reading).toMatchObject({ intent: 'unclear', cancelWords: true });
    const asked = plan(words, TWO_OPEN);
    expect(asked.kind).toBe('ask');
    if (asked.kind === 'ask') expect(asked.allowNew).toBe(false);
  });

  it('no question about words with a cancel verb offers "a new design"', () => {
    for (const words of ['please cancel what I said about the gold', 'cancel my last message']) {
      const asked = plan(words, [IN_REVIEW]);
      if (asked.kind === 'ask') expect(asked.allowNew, words).toBe(false);
    }
  });

  it('"don\'t make it, we\'ll do it ourselves" asks about the design it names (J2)', () => {
    expect(plan("don't make it, we'll do it ourselves", [DESIGNING])).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'A' }] });
  });
});

describe('holds, timing, praise, status, briefs and fragments', () => {
  it.each([
    "don't continue with the design for now, we're waiting for the speaker list",
    "don't go ahead with the poster yet, we're still waiting on the venue",
    "please stop working on it for now, the speakers aren't confirmed",
    'hold off until we have the final speaker list',
    // "don't make it yet, we are waiting for the date"
    'هێشتا دروستی مەکە، چاوەڕێی بەروارەکەین',
  ])('"%s" pauses the design', (words) => {
    expect(plan(words, [DESIGNING])).toMatchObject({ kind: 'note', note: 'hold', requestId: 'A' });
  });

  it('"go ahead" said in the negative is never approval', () => {
    expect(readIntentByRules("don't go ahead with it").intent).not.toBe('approval');
    expect(readIntentByRules('go ahead').intent).toBe('approval');
  });

  it.each(['no rush, next week is fine', 'no hurry, any time next week works', 'take your time, Sunday is fine', 'no rush'])(
    '"%s" tells the office the timing', (words) => {
      expect(plan(words, [DESIGNING])).toMatchObject({ kind: 'tell', note: 'deadline', requestId: 'A' });
    });

  it.each([
    // "very beautiful, the client likes it"
    'زۆر جوانە، کڕیارەکە حەزی لێ دەکات',
    'looks great, the manager loves it', 'beautiful, our team really likes it',
  ])('"%s" is thanks; approval stays the office\'s', (words) => {
    expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'reply', what: 'thanks' });
  });

  it('praise with approval or change words is read by those words', () => {
    expect(readIntentByRules('looks great, the client loves it, send it').intent).toBe('approval');
    expect(readIntentByRules('we love it but make the logo bigger').intent).toBe('change');
  });

  it.each(["how's the workshop poster coming along?", 'how is the teacher day poster going?', 'is the quality workshop poster finished yet?'])(
    '"%s" asks where a design stands', (words) => {
      expect(plan(words, TWO_OPEN)).toMatchObject({ kind: 'reply', what: 'status' });
    });

  it.each([
    'Hey, we need something for the KAAE alumni meetup next month',
    "Hello! I'd like something to promote the summer school",
    'hey, could you do something for the science fair next week?',
  ])('"%s" opens a brief (for a person: it carries no copy)', (words) => {
    expect(plan(words, [])).toEqual({ kind: 'open', text: words, instructionOnly: true });
  });

  it('"something for the title" asks for nothing new', () => {
    expect(readIntentByRules('we need something for the title').intent).not.toBe('new_brief');
  });

  it.each(['for the deans', 'about the gala', 'Nawroz', /* "Nawroz" */ 'نەورۆز'])(
    '"%s" alone, with a design in review, asks "a change, or a new design?"', (words) => {
      expect(plan(words, [IN_REVIEW])).toMatchObject({ kind: 'ask', intent: 'unclear', allowNew: true });
      // With nothing on the way it is read as before: the greeting.
      expect(plan(words, [])).toEqual({ kind: 'conversation' });
    });

  it('a bare "no" on a draft is still the conversation\'s (ADR-252: status and an invitation to say what to change)', () => {
    expect(plan('no', [IN_REVIEW])).toEqual({ kind: 'conversation' });
  });
});
