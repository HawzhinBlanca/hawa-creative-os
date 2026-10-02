import { describe, expect, it } from 'vitest';
import { askText, langOf, noteText, parseChoice, planTurn, readIntentByRules, statusText, thanksText,
  type ChatRequestView, type PendingAsk, type TurnInput } from '../src/services/requester-turn.js';

/**
 * ADR-251: what a requester's short words do when they could end a design, answer a question, or only
 * ask for a moment (bug hunt 2, 2026-10-02, friction 1, 2, 10 and 11). Sorani lines carry their
 * meaning in a comment.
 */
const NOW = Date.parse('2026-10-02T09:00:00Z');
const view = (requestId: string, stage: ChatRequestView['stage'], title: string, minutesAgo = 5): ChatRequestView => ({
  requestId, stage, rev: 2, currentTaskId: `${requestId}-task`, clientId: 'c', title,
  activeAt: new Date(NOW - minutesAgo * 60_000).toISOString(), createdAt: new Date(NOW - (minutesAgo + 1) * 60_000).toISOString(),
  question: null, requesterId: '1',
});
const input = (text: string, requests: ChatRequestView[], extra: Partial<TurnInput> = {}): TurnInput => ({
  text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: '1', officeIds: [],
  group: false, addressed: true, pendingAsk: null, now: NOW, ...extra,
});
const NAWROZ = view('A', 'in_review', 'KAAE: Nawroz Poster');

describe('friction 1: a cancel word with nothing named asks before it withdraws', () => {
  it.each(['never mind', 'ok never mind', 'stop', 'no need', 'no, stop', 'cancel', 'not needed', 'nvm',
    // ADR-263: "forget it" is a dismissal like "never mind"; it names nothing for certain.
    'forget it', 'forget about it', 'just forget it',
    // "stop" (Sorani)
    'ڕاوەستە',
    // "no need" (Sorani)
    'پێویست ناکات',
  ])('"%s" asks "Do you want me to cancel …?" about the only design', (words) => {
    const reading = readIntentByRules(words);
    expect(reading.intent).toBe('cancel');
    expect(reading.bareCancel).toBe(true);
    const plan = planTurn(input(words, [NAWROZ]));
    expect(plan).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false, options: [{ requestId: 'A' }] });
    // Said as a reply to the design's own message, it still asks.
    expect(planTurn(input(words, [NAWROZ], { bound: ['A'] }))).toMatchObject({ kind: 'ask', intent: 'cancel' });
  });

  it.each(['cancel it', 'cancel the poster', 'never mind, cancel it', "we don't need it anymore", 'stop it', 'forget the poster',
    "forget it, we don't need it anymore", "it's not needed",
    // "cancel it" (Sorani)
    'هەڵیبوەشێنەوە',
  ])('"%s" names the design, and withdraws the only one as before', (words) => {
    expect(readIntentByRules(words).bareCancel).toBeUndefined();
    expect(planTurn(input(words, [NAWROZ]))).toMatchObject({ kind: 'note', note: 'cancel', requestId: 'A' });
  });

  it('the question names the design in natural words, in both languages', () => {
    const plan = planTurn(input('never mind', [NAWROZ]));
    if (plan.kind !== 'ask') throw new Error('expected a question');
    expect(askText(plan, 'en', NOW)).toBe('Do you want me to cancel <b>Nawroz Poster</b>?');
    expect(askText(plan, 'ckb', NOW)).toBe('دەتەوێت <b>Nawroz Poster</b> هەڵبوەشێنمەوە؟');
  });

  const asked: PendingAsk = { updateId: 7, intent: 'cancel', words: 'never mind', options: [{ requestId: 'A', title: NAWROZ.title }], allowNew: false };
  it.each(['yes', 'yes please', 'yeah cancel it', 'ok', 'بەڵێ'])('"%s" to the question withdraws it', (words) => {
    expect(planTurn(input(words, [NAWROZ], { pendingAsk: asked }))).toMatchObject({ kind: 'note', note: 'cancel', requestId: 'A', resolves: 7 });
  });
  it.each(['no', 'nope', 'no thanks', 'no, keep it', "don't cancel it", 'continue', 'نەخێر'])('"%s" to the question keeps the design and says where it stands', (words) => {
    expect(planTurn(input(words, [NAWROZ], { pendingAsk: asked }))).toEqual({ kind: 'reply', what: 'status', requestIds: ['A'] });
  });
  it('"no, the Nawroz one" never answers yes to "Do you want me to cancel …?"', () => {
    expect(parseChoice('no, the Nawroz one', asked)).toBeNull();
  });
});

describe('friction 2: only a bare "no" to "change or new?" means a new design', () => {
  const one = { options: [{ requestId: 'A', title: 'Nawroz Poster' }], allowNew: true };
  const teachers = { options: [{ requestId: 'B', title: 'Teachers Workshop' }], allowNew: true };
  it.each(['no', 'nope', 'no thanks', 'no!', 'نەخێر'])('"%s" is new', (words) => {
    expect(parseChoice(words, one)).toEqual({ new: true });
  });
  it.each(["no, it's a change", 'no, the old one', 'no, the same one', 'no, change'])('"%s" is a change to the design asked about', (words) => {
    expect(parseChoice(words, one)).toEqual({ option: 0 });
  });
  it('"no, new" and "no, a new one" are new', () => {
    expect(parseChoice('no, new', one)).toEqual({ new: true });
    expect(parseChoice('no, a new one', one)).toEqual({ new: true });
  });
  it('"no it\'s for nawroz" names the design asked about: a change to it', () => {
    expect(parseChoice("no it's for nawroz", one)).toEqual({ option: 0 });
  });
  it('"no it\'s for nawroz" asked about another design is a new one, and keeps what it adds', () => {
    expect(parseChoice("no it's for nawroz", teachers)).toEqual({ new: true, adds: "it's for nawroz" });
    const ask: PendingAsk = { updateId: 9, intent: 'unclear', words: 'a poster with the date 21 March', ...teachers };
    const plan = planTurn(input("no it's for nawroz", [view('B', 'in_review', 'Teachers Workshop')], { pendingAsk: ask }));
    expect(plan).toMatchObject({ kind: 'open', resolves: 9, text: "a poster with the date 21 March\nit's for nawroz" });
  });
  it('"no it\'s for nawroz" asked about another design, with a Nawroz design in the chat, asks about that one', () => {
    const ask: PendingAsk = { updateId: 9, intent: 'unclear', words: 'the date should be 21 March', ...teachers };
    const plan = planTurn(input("no it's for nawroz", [view('B', 'in_review', 'Teachers Workshop'), view('A', 'in_review', 'Nawroz Poster', 60)],
      { pendingAsk: ask }));
    expect(plan).toMatchObject({ kind: 'ask', intent: 'unclear', allowNew: true, words: 'the date should be 21 March', options: [{ requestId: 'A' }] });
  });
});

describe('friction 10: a bare "wait" pauses nothing', () => {
  it.each(['wait', 'wait!', 'ok wait', 'hold on', 'hang on', 'one moment', 'wait please'])('"%s" is acknowledged, never a pause', (words) => {
    const reading = readIntentByRules(words);
    expect(reading.intent).toBe('acknowledgement');
    const plan = planTurn(input(words, [NAWROZ]));
    expect(plan.kind).toBe('reply');
    expect(plan).not.toMatchObject({ kind: 'note' });
  });
  it.each(["wait, don't make it yet", 'pause it please', 'put the poster on hold'])('"%s" still pauses', (words) => {
    expect(readIntentByRules(words).intent).toBe('hold');
    expect(planTurn(input(words, [NAWROZ]))).toMatchObject({ kind: 'note', note: 'hold', requestId: 'A' });
  });
});

describe('friction 11: Sorani writers hear Sorani', () => {
  it('a message with no letters is answered in the chat\'s language', () => {
    expect(langOf('👍', 'ckb')).toBe('ckb');
    expect(langOf('2', 'ckb')).toBe('ckb');
    expect(langOf('👍')).toBe('en');
    // A message with letters keeps its own language.
    expect(langOf('thanks', 'ckb')).toBe('en');
  });
  it('a design with no name is "your design" in Sorani inside a Sorani sentence', () => {
    const unnamed = view('U', 'awaiting_answer', 'New design request from Hawzhin');
    // The status names it by when it was sent, in Sorani.
    expect(statusText([unnamed], 'ckb', new Set(), NOW)).not.toContain('your design');
    for (const said of [thanksText([unnamed], 'ckb'), noteText('cancel', 'in_review', unnamed.title, 'ckb'),
      noteText('change', 'in_review', unnamed.title, 'ckb')]) {
      expect(said).not.toContain('your design');
      expect(said).toContain('دیزاینەکەت');
    }
    expect(thanksText([unnamed], 'en')).toContain('<b>your design</b>');
  });
});
