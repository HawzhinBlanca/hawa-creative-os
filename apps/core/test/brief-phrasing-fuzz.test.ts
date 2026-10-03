import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import { isGreetingOnly } from '../src/services/greetings.js';

/**
 * Brief phrasing fuzz (QA, 2026-10-03): a seeded, reproducible set of office briefs, built from the parts real
 * office staff use (openings, request verbs, deliverables, event names, details, closings, layouts), driven
 * through the real route `/v1/internal/telegram/intake` against the per-file test database, with no model call
 * (`requesterIntentModel: null`, no OpenAI key). Every opened draft is checked against five invariants:
 *
 *  I1 every copy line is the requester's own words (whitespace, the ADR-235 first capital and the " · " joiner
 *     between spans aside);
 *  I2 no copy line is a greeting, a thanks or sign-off, a request phrase, a deliverable, the client's name alone,
 *     or a fragment that lost its event (a dangling "for"/"on"/"the");
 *  I3 the title is non-empty, at most 60 characters after its label, has no greeting/thanks/request words, is not
 *     only the client, is not cut with "…" when the event's name fits, and names the event;
 *  I4 the event's name is on some copy line;
 *  I5 KAAE named (or its routing words "accreditation"/"university" used) opens for KAAE; nobody named asks who
 *     it is for, and the brief is then opened by answering "KAAE" so its copy is checked too.
 *
 * Every violation is written to output/research/2026-10-03-brief-fuzz/violations.json (deterministic: no times),
 * and the counts are held to pinned baselines: a ratchet that only goes down. The client named as the addressee
 * ("For KAAE, could you …", fixed in 20ca0671) is held at zero: no such brief prints the client alone or is titled by it.
 * Sorani briefs are only lines and sentences that already exist in this repository's tests, put together line by
 * line; no Sorani is composed here.
 */

// --- the ratchet ---------------------------------------------------------------------------------------------
/** Pinned on 2026-10-03 (claude/briefuzz on release 3, b7541da6). Lower these when a fix lands; never raise them. */
const BASELINE = { total: 490, I1: 0, I2: 232, I3: 185, I4: 32, I5: 41 };

// --- deterministic generation --------------------------------------------------------------------------------
const SEED = 20261003;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const chance = (p: number) => rng() < p;

type ClientMode = 'none' | 'adjective' | 'possessive' | 'trailing' | 'eventName' | 'forClient' | 'fullName' | 'lead';
interface Brief {
  id: string;
  text: string;
  layout: string;
  lang: 'en' | 'ckb';
  /** The event's name as written in the brief: must be on some copy line (I4) and in the title (I3). */
  event: string;
  /** KAAE expected (named, or its routing words used); otherwise no client and the question. */
  expectKaae: boolean;
  clientMode: ClientMode;
}

const OPENINGS = ['', '', '', 'Hi', 'Hello', 'Hi team,', 'Hello everyone!', 'Good morning', 'Good morning team,', 'Salam', 'Salam,',
  'Dear team,', 'Hey guys,', 'Hi there!', 'Dear colleagues,', 'Good afternoon,', 'hello'];
const QUESTION_ASKS = ['Could you make', 'Could you design', 'Could you do', 'Can you create', 'Can you please make', 'Can we get',
  'can u make', 'Would you design', 'Could you please prepare', 'Can I have'];
const STATEMENT_ASKS = ['Please make', 'Please design', 'We need', "I'd like", 'We want', 'Make me', "We'd like", 'I need', 'Pls make'];
const DELIVERABLES = ['a poster', 'a flyer', 'an Instagram post', 'a story', 'an Instagram story', 'a banner', 'an invitation card',
  'a certificate', 'a social media post', 'a post', 'a nice poster'];
const LINKS = ['for', 'for our', 'for the', 'about our', 'announcing our', 'to announce the', 'for the upcoming'];
const EVENTS = ['Assessment Literacy Workshop', 'Teacher Appreciation Day', 'Open Day', 'Graduation Ceremony', 'Nawroz Celebration',
  'Book Fair', 'Science Camp', 'Quality Assurance Workshop', 'Staff Football Tournament', 'Parents Meeting', 'Spring Concert',
  'Career Fair', 'Annual Conference', 'Research Day', 'Leadership Training Course'];
/** Events whose words route to KAAE by its pack (kaae.json latinAliases "accreditation", "university"). */
const KAAE_WORD_EVENTS = ['Accreditation Seminar', 'University Rankings Forum'];
const DATES = ['15 October 2026', 'October 15', '15/10/2026', 'Monday 12 November', 'next Thursday', '3rd of December', 'Oct. 20', '20 March 2027'];
const TIMES = ['10:00 AM', '2 pm', '9:30', '7pm', ''];
const VENUES = ['the KAAE hall, Erbil', 'Rotana Hotel', 'Saad Abdullah Hall', 'the main campus', 'Sami Abdulrahman Park', ''];
const AUDIENCES = ['for school principals', 'for all teachers', 'for parents and students', '', '', ''];
const CLOSINGS = ['', '', 'Thanks!', 'Thank you so much.', 'Thanks a lot', 'Regards, Sara', 'Best regards,\nAhmed', 'Thanks in advance 🙏',
  'Cheers', 'thank you', 'Many thanks!'];
const CLOSING_NAMES = ['Sara', 'Ahmed'];
const LINE_SUFFIXES = [':', ' with this text:', ' for this:', '.', ' please', '?', ' with these details:'];
const BULLETS = ['- ', '• ', '* '];

const sp = (...parts: string[]) => parts.filter(Boolean).join(' ').replace(/ +([,.?!:])/g, '$1');
const venueAt = (v: string) => (v.startsWith('the ') ? `in ${v}` : `at ${v}`);

function clientParts(mode: ClientMode, deliverable: string, link: string, event: string) {
  // Returns the deliverable, link, event as written, and a trailing sentence when the mode needs one.
  switch (mode) {
    case 'adjective': return { deliverable: deliverable.replace(/^(?:a|an) (nice )?/, (_m, n) => `a ${n ?? ''}KAAE `), link, event, trailing: '' };
    // ADR-253: the possessive is left out of the copy ("KAAE's Book Fair" prints "Book Fair"): the event is the rest.
    case 'possessive': return { deliverable, link: 'for', event: `KAAE's ${event}`, trailing: '' };
    case 'eventName': return { deliverable, link: link.replace(/our$/, 'the'), event: `KAAE ${event}`, trailing: '' };
    case 'trailing': return { deliverable, link, event, trailing: pick(["It's for KAAE.", 'This is for KAAE.', 'For KAAE please.']) };
    case 'forClient': return { deliverable: `${deliverable} for KAAE`, link: link.replace(/^for /, 'about ').replace(/^for$/, 'about'), event, trailing: '' };
    case 'fullName': return { deliverable, link, event, trailing: 'It is for the Kurdistan Accrediting Association for Education.' };
    default: return { deliverable, link, event, trailing: '' };
  }
}

function englishBrief(i: number): Brief {
  const layouts = ['one-sentence', 'request+details', 'request-line+copy-lines', 'bullets', 'quoted', 'event-first', 'casual'];
  const layout = layouts[i % layouts.length];
  const kaaeWord = chance(0.06);
  let eventName = kaaeWord ? pick(KAAE_WORD_EVENTS) : pick(EVENTS);
  if (chance(0.25)) eventName = eventName.toLowerCase();
  const modes: ClientMode[] = ['none', 'none', 'none', 'adjective', 'possessive', 'trailing', 'eventName', 'forClient', 'fullName'];
  let mode: ClientMode = pick(modes);
  if (i % 40 === 7) mode = 'lead';
  const opening = pick(OPENINGS);
  const openSep = opening && chance(0.4) ? '\n' : ' ';
  const question = chance(0.6);
  const ask = question ? pick(QUESTION_ASKS) : pick(STATEMENT_ASKS);
  const end = question ? '?' : '.';
  const parts = clientParts(mode, pick(DELIVERABLES), pick(LINKS), eventName);
  const date = pick(DATES), time = pick(TIMES), venue = pick(VENUES), audience = pick(AUDIENCES);
  const closing = pick(CLOSINGS);
  const opener = (s: string) => (opening ? `${opening}${openSep}${s}` : s);
  const lead = mode === 'lead' ? 'For KAAE, ' : '';
  const askWords = lead ? ask.charAt(0).toLowerCase() + ask.slice(1) : ask;
  const when = sp(`on ${date}`, time ? `at ${time}` : '');
  let text: string;
  switch (layout) {
    case 'one-sentence':
      text = sp(opener(sp(lead + askWords, parts.deliverable, parts.link, parts.event, audience, when, venue ? venueAt(venue) : '') + end), parts.trailing, closing);
      break;
    case 'request+details':
      text = sp(opener(sp(lead + askWords, parts.deliverable, parts.link, parts.event) + end),
        sp(`It's on ${date}`, time ? `at ${time}` : '', venue ? venueAt(venue) : '') + '.', audience ? `It is ${audience}.` : '', parts.trailing, closing);
      break;
    case 'request-line+copy-lines': {
      const event = mode === 'possessive' || mode === 'eventName' ? parts.event : eventName;
      const requestLine = sp(lead + askWords, parts.deliverable) + pick(LINE_SUFFIXES);
      text = [opening, requestLine, event, audience ? audience.charAt(0).toUpperCase() + audience.slice(1) : '', sp(date, time ? `at ${time}` : ''),
        venue, parts.trailing, closing].filter(Boolean).join('\n');
      parts.event = event;
      break;
    }
    case 'bullets': {
      const event = mode === 'possessive' || mode === 'eventName' ? parts.event : eventName;
      const b = pick(BULLETS);
      text = [opening, sp(lead + askWords, parts.deliverable, 'with these details') + ':', `${b}${event}`, `${b}${sp(date, time)}`,
        venue ? `${b}${venue}` : '', parts.trailing, closing].filter(Boolean).join('\n');
      parts.event = event;
      break;
    }
    case 'quoted': {
      const q = pick([['"', '"'], ['“', '”']]);
      const says = chance(0.5) ? 'that says' : parts.link;
      text = sp(opener(sp(lead + askWords, parts.deliverable, says, `${q[0]}${parts.event}${q[1]}`, when, venue ? venueAt(venue) : '') + end), parts.trailing, closing);
      break;
    }
    case 'event-first': {
      const own = parts.event.startsWith('KAAE') ? parts.event : `${pick(['Our', 'The'])} ${parts.event}`;
      text = sp(opener(sp(own, `is on ${date}`, venue ? venueAt(venue) : '') + '.'), sp(lead + askWords, parts.deliverable, 'for it') + end, parts.trailing, closing);
      break;
    }
    default: {
      // Casual: "need a poster for the open day next thursday pls", "poster for KAAE open day 15/10".
      const casual = pick(['need', 'pls make', 'can u do', 'we need']);
      text = sp(opener(sp(lead ? 'For KAAE,' : '', casual, parts.deliverable, parts.link, parts.event, date, chance(0.5) ? 'pls' : '')), parts.trailing, closing);
    }
  }
  // KAAE is named when its code is anywhere in the words (a venue such as "the KAAE hall" names it too) or its
  // routing words are used ("accreditation", "university"); its full English name counts as naming it.
  const expectKaae = mode !== 'none' || kaaeWord || /\bKAAE\b|accreditation|university/i.test(text);
  return { id: `en-${String(i).padStart(3, '0')}`, text, layout, lang: 'en', event: parts.event.replace(/^KAAE's /, ''), expectKaae, clientMode: mode };
}

// Sorani: existing strings only (canary-friction-2026-10-03, request-copy-extraction, kurdish-intake-no-invented-copy,
// brief-introducer-copy, requester-intake-hunt3, telegram-classifier tests), put together line by line.
const CKB_GREETINGS = ['', 'سڵاو', 'سڵاو کاکە', 'سڵاو بەڕێزان', 'بەیانی باش'];
const CKB_ASKS = ['تکایە پۆستەرێک دروست بکە بۆ KAAE', 'تکایە پۆستەرێک بۆ KAAE دروست بکەن', 'تکایە پۆستێک بۆ کەی ئەی ئەی دروست بکە'];
const CKB_EVENTS = ['کۆنفرانسی ساڵانەی متمانەبەخشین', 'کۆنفرانسی نیشتمانی متمانەبەخشین', 'دەستپێکردنی باوەڕپێدانی زانکۆکان بۆ ٢٠٢٦'];
const CKB_DETAILS = ['٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا', '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر', 'بەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا', 'هەولێر، ٢٠٢٦'];
const CKB_CLOSINGS = ['', 'سوپاس', 'زۆر سوپاس'];
/** Whole Sorani briefs from the tests, with the event each names (from their expected titles). */
const CKB_SENTENCES: Array<[string, string]> = [
  ['سڵاو، دەتوانن پۆستەرێکمان بۆ دروست بکەن بۆ ئاهەنگی نەورۆزی KAAE لە ٢٠ی ئازار لە پارکی سامی عەبدولڕەحمان؟', 'ئاهەنگی نەورۆزی KAAE'],
  ['پۆستەرێک بەم وێنانە دروست بکە بۆ دەرچوونی KAAE، ١٢ی تشرینی یەکەم، هۆتێلی ڕۆتانا', 'دەرچوونی KAAE'],
  ['سڵاو، پۆستەرێکمان دەوێت بۆ ئاهەنگی دەرچوونی KAAE\nبەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا', 'ئاهەنگی دەرچوونی KAAE'],
  ['پۆستەرێکی نوێمان دەوێت بۆ خولی ڕاهێنانی مامۆستایان، ١٠ی تشرینی دووەم کاتژمێر ٩ی بەیانی لە هۆڵی KAAE', 'خولی ڕاهێنانی مامۆستایان'],
  ['تکایە پۆستێکی ئینستاگرام دروست بکە بۆ وۆرکشۆپی هەڵسەنگاندن بۆ بەڕێوەبەرانی قوتابخانەکان. لە ١٥ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ١٠:٠٠ لە هۆڵی KAAE، هەولێر. تۆمارکردن بەخۆڕاییە.', 'وۆرکشۆپی هەڵسەنگاندن'],
  ['پۆستەرێک بۆ ئاهەنگی نەورۆزی KAAE، ٢٠ی ئازاری ٢٠٢٧، پارکی سامی عەبدولڕەحمان', 'ئاهەنگی نەورۆزی KAAE'],
  ['تکایە پۆستەرێک بۆ کەی ئەی ئەی دروست بکە بە ڕەنگی شین و زەرد، لۆگۆکە لە سەرەوە دابنێ\n\nدەقەکە:\nکۆنفرانسی نیشتمانی متمانەبەخشین\n٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا، هەولێر', 'کۆنفرانسی نیشتمانی متمانەبەخشین'],
  ['Please design a KAAE poster in navy and yellow, formal and clean.\n\nHere is the text:\nKAAE Annual Conference\nکۆنفرانسی ساڵانەی کەی ئەی ئەی', 'KAAE Annual Conference'],
];

function soraniBriefs(): Brief[] {
  const out: Brief[] = CKB_SENTENCES.map(([text, event], i) => ({ id: `ckb-s${i}`, text, layout: 'sorani-sentence', lang: 'ckb', event, expectKaae: true, clientMode: 'adjective' }));
  for (let i = 0; i < 40; i++) {
    const event = pick(CKB_EVENTS);
    const sep = chance(0.3) ? '\n\n' : '\n';
    const text = [pick(CKB_GREETINGS), pick(CKB_ASKS), event, pick(CKB_DETAILS), pick(CKB_CLOSINGS)].filter(Boolean).join(sep);
    out.push({ id: `ckb-${String(i).padStart(2, '0')}`, text, layout: 'sorani-lines', lang: 'ckb', event, expectKaae: true, clientMode: 'adjective' });
  }
  return out;
}

function generate(): Brief[] {
  const all = [...Array.from({ length: 380 }, (_, i) => englishBrief(i)), ...soraniBriefs()];
  const seen = new Set<string>();
  return all.filter((b) => (seen.has(b.text) ? false : (seen.add(b.text), true)));
}

// --- the invariants ------------------------------------------------------------------------------------------
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const trimMarks = (s: string) => s.replace(/^[\s\-•*·]+|[\s.,!?؟،:;🙏]+$/gu, '');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** I1: the line is the requester's own characters (modulo whitespace, the first capital, and the span joiners). */
function ownWords(brief: string, line: string): boolean {
  const src = norm(brief);
  const has = (part: string, from = 0) => {
    const p = norm(part);
    for (const cand of [p, lowerFirst(p)]) { const at = src.indexOf(cand, from); if (at >= 0) return at + cand.length; }
    return -1;
  };
  if (has(line) >= 0) return true;
  let from = 0;
  for (const part of norm(line).split(/ · |، /u)) {
    const at = has(part, from);
    if (at < 0) return false;
    from = at;
  }
  return true;
}

const GREETING_START = /^(?:hi|hello|hey|salam|good\s+(?:morning|afternoon|evening)|dear\s+(?:team|colleagues|all))\b|^(?:سڵاو|بەیانی باش)/iu;
const THANKS = /\b(?:thanks?|thank\s+you|regards|cheers|sincerely)\b|^(?:زۆر\s+)?سوپاس/iu;
const REQUEST = /\b(?:(?:could|can|would|will)\s+(?:you|u|we|i)|please\s+(?:make|design|do|create|prepare)|pls\s+make|we\s+(?:need|want)|i\s+need|i'?d\s+like|we'?d\s+like|make\s+(?:me|us)|can\s+u\s+do)\b|^need\b|تکایە|دروست\s+بکە/iu;
const DELIVERABLE = /^(?:(?:a|an|the)\s+)?(?:nice\s+)?(?:kaae\s+)?(?:instagram\s+|social\s+media\s+)?(?:poster|flyer|post|story|banner|invitation\s+card|card|certificate)s?\b/iu;
const CLIENT_ALONE = /^(?:(?:for|the|it'?s\s+for|this\s+is\s+for|it\s+is\s+for)\s+)*(?:kaae(?:'s)?|kurdistan\s+accrediting\s+association\s+for\s+education|کەی ئەی ئەی)(?:\s+please)?$/iu;
const DANGLING = /^(?:on|at|in|for|and|of|to|with|about)$|\b(?:for|on|at|in|the|our|of|to|a|an|and|with|about|announcing)$/iu;

function lineProblems(line: string): string[] {
  const t = trimMarks(norm(line));
  const out: string[] = [];
  if (!t) return ['empty-line'];
  if (isGreetingOnly(t) || GREETING_START.test(t)) out.push('greeting');
  if (THANKS.test(t) || CLOSING_NAMES.includes(t)) out.push('thanks-or-sign-off');
  if (REQUEST.test(t)) out.push('request-phrase');
  if (DELIVERABLE.test(t)) out.push('deliverable');
  if (CLIENT_ALONE.test(t)) out.push('client-alone');
  if (DANGLING.test(t)) out.push('dangling-fragment');
  // A list mark the requester typed to lay the brief out ("- ", "* ", "• ") is not a word to print.
  if (/^\s*[-*•]\s/u.test(line)) out.push('list-mark');
  return out;
}

const eventIn = (text: string, event: string) => norm(text).toLowerCase().includes(norm(event).toLowerCase());

interface Violation { id: string; invariant: 'I1' | 'I2' | 'I3' | 'I4' | 'I5'; code: string; detail: string }
/** What the route did with one brief: kept in the report beside its violations. */
interface Outcome { id: string; layout: string; clientMode: ClientMode; brief: string; event: string; expectKaae: boolean;
  asked: boolean; clientId: string | null; copy: string[]; title: string | null;
  /** How the copy was taken (copyExtraction.method: quoted, rules, none), or null when the extraction did not run. */
  method: string | null; violations: Array<Pick<Violation, 'invariant' | 'code' | 'detail'>> }

function check(b: Brief, draft: { exactCopy?: Array<{ text: string }>; title?: string; clientId?: string | null;
  copyExtraction?: { method?: string } } | null,
  routing: { asked: boolean; action: string; clientId: string | null; answer?: string }): Outcome {
  const copy = (draft?.exactCopy ?? []).map((c) => c.text);
  const title = draft?.title ?? null;
  const out: Violation[] = [];
  const v = (invariant: Violation['invariant'], code: string, detail: string) =>
    out.push({ id: b.id, invariant, code, detail });
  const outcome = (): Outcome => ({ id: b.id, layout: b.layout, clientMode: b.clientMode, brief: b.text,
    event: b.event, expectKaae: b.expectKaae, asked: routing.asked, clientId: routing.clientId, copy, title,
    method: draft?.copyExtraction?.method ?? null, violations: out.map(({ invariant, code, detail }) => ({ invariant, code, detail })) });
  // I5 first: routing.
  if (b.expectKaae && routing.clientId !== KAAE) v('I5', routing.asked ? 'kaae-named-but-asked' : 'kaae-named-not-resolved', `${routing.action}${routing.answer ? `: ${routing.answer.slice(0, 120)}` : ''}`);
  if (!b.expectKaae && !routing.asked) v('I5', routing.clientId ? 'client-guessed' : 'no-client-not-asked', `${routing.action}, clientId ${routing.clientId}`);
  if (!draft) { v('I4', 'not-opened', routing.action); return outcome(); }
  // I1, I2: every line.
  for (const block of copy) {
    if (!ownWords(b.text, block)) v('I1', 'not-own-words', block);
    // A laid-out block keeps its line breaks: each printed line is checked on its own.
    for (const line of block.split('\n')) for (const p of lineProblems(line)) v('I2', p, line);
  }
  // I4: the event's name.
  if (!copy.length) v('I4', 'no-copy', 'opened without copy (for a designer)');
  else if (!copy.some((line) => eventIn(line, b.event))) v('I4', 'event-missing', `event "${b.event}" on no line`);
  // I3: the title.
  if (!title || !norm(title)) v('I3', 'empty-title', String(title));
  else {
    const name = title.replace(/^(?:KAAE|Sewa):\s+/u, '');
    if (name.length > 60) v('I3', 'title-too-long', `${name.length} chars`);
    if (GREETING_START.test(name)) v('I3', 'title-greeting', name);
    if (THANKS.test(name)) v('I3', 'title-thanks', name);
    if (REQUEST.test(name)) v('I3', 'title-request-words', name);
    if (DELIVERABLE.test(name)) v('I3', 'title-deliverable', name);
    if (CLIENT_ALONE.test(trimMarks(name)) || /^KAAE$/i.test(title.trim())) v('I3', 'title-client-only', title);
    if (/^[\-•*·]/u.test(name)) v('I3', 'title-starts-with-mark', name);
    if (/\b(?:is|are|on|at|in|for|the|our|of|to|and|with|about)$/iu.test(name)) v('I3', 'title-dangling-word', name);
    if (name.endsWith('…') && norm(b.event).length <= 60) v('I3', 'title-cut', name);
    else if (!eventIn(name, b.event.replace(/^KAAE(?:'s)?\s+/u, ''))) v('I3', 'title-misses-event', name);
  }
  return outcome();
}

// --- the route -----------------------------------------------------------------------------------------------
const WORKER = ['worker', 'brief', 'fuzz', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
const BRIEFS = generate();
/** Each brief comes from its own office member, in their own private chat (no state carried between briefs). */
const MEMBER0 = 93_100_000;
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = BRIEFS.map((_, i) => String(MEMBER0 + i)).join(',');
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

/** Update ids follow the brief's index (the brief, then the answer), so a run is the same whatever the interleaving. */
const message = (chat: number, text: string, answer = false) => {
  const id = 1_500_000_000 + (chat - MEMBER0) * 2 + (answer ? 1 : 0);
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

async function run(b: Brief, chat: number): Promise<Outcome> {
  const first = await intake(message(chat, b.text));
  let draft = first.lifecycleAction === 'open-request' ? first.draft : null;
  const asked = first.clientQuestion === true;
  const routing = { asked, action: String(first.lifecycleAction), clientId: (first.draft?.clientId ?? null) as string | null,
    answer: first.chatAnswer?.text as string | undefined };
  if (asked) {
    // Answer the question, as the office would, so the copy of the kept brief is checked too.
    const opened = await intake(message(chat, 'KAAE', true));
    draft = opened.lifecycleAction === 'open-request' ? opened.draft : null;
  }
  return check(b, draft, routing);
}

describe('brief phrasing fuzz: office briefs through the real intake route (QA ratchet)', () => {
  it(`${BRIEFS.length} seeded briefs hold the copy, title and client invariants no worse than the pinned baseline`, async () => {
    expect(BRIEFS.length).toBeGreaterThanOrEqual(300);
    const queue = BRIEFS.map((b, i) => [b, MEMBER0 + i] as const);
    const outcomes: Outcome[] = new Array(queue.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (cursor < queue.length) {
        const at = cursor++;
        outcomes[at] = await run(queue[at][0], queue[at][1]);
      }
    }));
    const counted = outcomes.flatMap((o) => o.violations.map((x) => ({ id: o.id, ...x })));
    const by = (inv: string) => counted.filter((x) => x.invariant === inv).length;
    const counts = { total: counted.length, I1: by('I1'), I2: by('I2'), I3: by('I3'), I4: by('I4'), I5: by('I5') };
    const briefsWithViolations = new Set(counted.map((x) => x.id)).size;
    const byCode: Record<string, number> = {};
    for (const x of counted) byCode[`${x.invariant} ${x.code}`] = (byCode[`${x.invariant} ${x.code}`] ?? 0) + 1;
    // The report: deterministic (no times), one brief per line, so a fix shows as a small diff.
    const here = dirname(fileURLToPath(import.meta.url));
    const out = resolve(here, '../../../output/research/2026-10-03-brief-fuzz/violations.json');
    mkdirSync(dirname(out), { recursive: true });
    const rows = (xs: unknown[]) => `[\n${xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
    writeFileSync(out, `{\n  "seed": ${SEED},\n  "briefs": ${BRIEFS.length},\n  "briefsWithViolations": ${briefsWithViolations},\n` +
      `  "counts": ${JSON.stringify(counts)},\n  "byCode": ${JSON.stringify(byCode)},\n` +
      `  "failing": ${rows(outcomes.filter((o) => o.violations.length))},\n` +
      `  "passing": ${rows(outcomes.filter((o) => !o.violations.length).map((o) => ({ id: o.id, layout: o.layout, clientMode: o.clientMode, brief: o.brief })))}\n}\n`);
    console.log(JSON.stringify({ briefs: BRIEFS.length, briefsWithViolations, counts, byCode }, null, 1));
    for (const key of Object.keys(BASELINE) as Array<keyof typeof BASELINE>) expect(counts[key], key).toBeLessThanOrEqual(BASELINE[key]);
    // 20ca0671 (client named as the addressee): "For KAAE, could you …" never prints the client alone, nor is titled by it.
    const addressee = outcomes.filter((o) => o.clientMode === 'lead')
      .flatMap((o) => o.violations.filter((x) => ['client-alone', 'title-client-only'].includes(x.code)).map((x) => `${o.id}: ${x.detail}`));
    expect(outcomes.filter((o) => o.clientMode === 'lead').length).toBeGreaterThanOrEqual(8);
    expect(addressee).toEqual([]);
  }, 120_000);
});
