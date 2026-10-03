import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, type Kysely } from '@hawa/db';
import {
  ACCESS_MESSAGES, ALBUM_MESSAGES, CLIENT_QUESTION_MESSAGES, CONVERSATION_MESSAGES, INBOX_MESSAGES, INTAKE_LIMIT_MESSAGES,
  LIFECYCLE_MESSAGES, MEDIA_MESSAGES, NAMING_MESSAGES, OFFICE_MESSAGES, OUTCOME_MESSAGES, PENDING_ROUND_MESSAGES, ROUTING_MESSAGES,
  SOURCE_MESSAGES, WITHDRAW_MESSAGES, requesterLang, type PhraseBook,
} from '@hawa/integrations';
import { ConversationHarness, type Inbound, type Person } from './conversation-harness.js';
import { Play, frictionIssues } from './conversation-script.js';

/**
 * Conversation fuzz (QA, 2026-10-03). The brief phrasing fuzz holds the first message; live bugs come from the turns
 * after it (a change that opened a new paid request, "never mind" that withdrew a design, a thumbs-down answered
 * "Thank you", a stale question that delivered a refused draft). This plays seeded multi-turn conversations through
 * the worker's ChatInbox, Core's real `/v1/internal/telegram/intake`, TelegramSender and RequestLifecycle
 * (fixtures/conversation-harness.ts: real test Postgres, the requester intent model off, no model or Canva call; a
 * draft is made ready and delivered by the harness's office steps, never by a design run).
 *
 * A conversation is an opening brief (KAAE named, or not and the "who is it for?" question answered or left open),
 * then 1–4 follow-ups drawn from families office staff really use: a change, an opinion (good or bad), a status
 * question, a deadline, a cancel and its "yes"/"no", thanks or small talk, a second new brief, a redo, and a reply to
 * an older bot message; the design moves on between turns (designing → with the office → delivered). Sorani turns are
 * only strings already in this repository's tests and labelled NLU fixture; a few Arabic phrasings are included.
 *
 * Every requester turn is held to:
 *  J1 no design round starts and no request opens unless the words are an explicit new brief or redo (a change may
 *     start a round of its own design: J3), and a round started when a draft finishes carries a change that was said;
 *  J2 a cancel always asks first, and only "yes" to that question withdraws; nothing else withdraws;
 *  J3 a change never opens a request and never drops the words: they reach a round, the kept words, or the office;
 *  J4 every reply is natural language (no command, "/", internal code or id) and in the requester's language;
 *  J5 thanks and small talk never start a round, ask a question, or cancel;
 *  J6 a negative opinion is never answered with thanks;
 *  J7 when a reply says the words were passed on, an office member was alerted in the same turn.
 *
 * The 320 conversations run in four shards, one per test file (conversation-fuzz.test.ts and conversation-fuzz-2/3/4),
 * each on its own database clone. Every shard writes output/research/2026-10-03-conversation-fuzz/violations-<k>of4.json
 * (no times, one conversation per line), and the counts are pinned: a ratchet that only goes down.
 */

// --- the ratchet ---------------------------------------------------------------------------------------------
/**
 * Pinned on 2026-10-03. On `claude/release-3` @ b56020bf (live) the 320 conversations broke the invariants 69 times: J1 11,
 * J2 41, J3 15, J4 0, J5 2, J6 0, J7 0 (report: output/research/2026-10-03-conversation-fuzz/REPORT.md). The fixes on
 * `claude/convfuzz` (ADR-284 addendum "conversation fuzz") took every count to zero. Each shard holds these counts for its
 * own conversations; lower them when a fix lands, never raise them.
 */
export const CONVERSATION_FUZZ_BASELINE = { total: 0, J1: 0, J2: 0, J3: 0, J4: 0, J5: 0, J6: 0, J7: 0 };
/**
 * Friction the invariants do not name, held where the same fixes left it: an opinion asked "Is this a change to …, or a
 * new design?" (35 before), "I don't have a design in progress" said while a brief waits for "who is it for?" (8
 * before), and a message left with no reply (0 before). A change asked "which design?" with two designs open is right.
 */
export const CONVERSATION_FUZZ_FRICTION = { opinionAskedChangeOrNew: 0, nothingInProgressWhileBriefWaits: 0, noReply: 0 };

// --- deterministic generation --------------------------------------------------------------------------------
const SEED = 20261004;
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

type Lang = 'en' | 'ckb' | 'ar';
type Family = 'change' | 'opinion-pos' | 'opinion-neg' | 'status' | 'deadline' | 'cancel' | 'confirm-yes' | 'confirm-no' |
  'thanks' | 'smalltalk' | 'new-brief' | 'redo';
type Stage = 'designing' | 'in_review' | 'delivered';
interface Turn { family: Family; text: string; lang: Lang; replyToFirst: boolean; advance: 'none' | 'draft' | 'deliver' }
interface Convo { id: string; lang: Lang; opening: string; kaaeNamed: boolean; answerClient: boolean; turns: Turn[] }

// English, as office staff write it.
const EN: Record<Exclude<Family, 'new-brief'>, readonly string[]> = {
  change: ['make the title bigger', 'can we lose the subtitle', 'use blue instead', 'add our logo', 'the date should be 20 October',
    'change the date to 5 November', 'please make the logo smaller', 'can you make the background darker', 'put the logo at the top',
    'remove the phone number', "the venue is wrong, it's Rotana Hotel", 'make the text bold', 'use our brand colours',
    'can you add the time, 10 AM', 'bigger font please', 'less text please', 'move the logo to the left'],
  'opinion-pos': ['love it', 'looks great', 'my boss is happy with it', '👍', 'perfect', "it's beautiful", 'wow nice', 'the client loves it', 'good job'],
  'opinion-neg': ['looks cheap', '👎', 'not quite', "I don't like it", 'hmm not what I expected', "it's ugly", 'too busy', 'the colours are awful',
    'not good', 'meh'],
  status: ['any update?', 'is it ready?', 'how is it going?', 'when will it be ready?', 'any news on the poster?', 'still waiting', 'where is my design?'],
  deadline: ['need it by tomorrow', 'we need it by Thursday', "it's urgent", 'can you have it ready by 5 pm?', 'please finish it before the weekend',
    'asap please'],
  cancel: ['forget it', 'never mind', 'cancel please', "we don't need it anymore", 'please cancel the poster', 'cancel it',
    "stop, we don't need it", 'the event was cancelled'],
  'confirm-yes': ['yes', 'yes please', 'yeah'],
  'confirm-no': ['no', 'no, keep it', 'nope'],
  thanks: ['thanks', 'thank you!', 'thanks a lot 🙏', 'ok thanks', 'great, thank you'],
  smalltalk: ['hi', 'good morning', 'how are you?', 'ok', '👌', 'hello again', 'have a nice day'],
  redo: ['redo it', 'can you make another version?', 'try again please', 'do it again, better'],
};
// Sorani: only strings already in this repository (fixtures/nlu-eval/utterances.json, requester-turn-confirmations,
// requester-intake-hunt3); the English meaning of each is in that fixture's notes.
const CKB: Record<Exclude<Family, 'new-brief'>, readonly string[]> = {
  change: ['لۆگۆکە گەورەتر بکە و بەروارەکە بگۆڕە بۆ ٥', 'ببورە، ڕەنگەکەی بکە بە سەوز', 'ڕەنگی باگراوندەکە بگۆڕە', 'ڕەنگەکە تۆختر بکە',
    'بەروارەکە بگۆڕە بۆ ٥ی تشرینی دووەم', 'ژمارەی تەلەفۆنەکە لاببە', 'بەروارەکە هەڵەیە، ١٥ی تشرینی یەکەمە', 'ناونیشانەکە گەورەتر بکە',
    'وێنەکە بگۆڕە بە وێنەی هۆڵەکە', 'ناوی شوێنەکە هەڵەیە', 'لە جیاتی شین، سەوز بەکاربهێنە'],
  'opinion-pos': ['زۆر جوانە، کڕیارەکە حەزی لێ دەکات', 'دەستخۆش', 'دەستت خۆش بێت'],
  'opinion-neg': ['دیزاینەکە ناشیرینە', 'پەسەند نییە'],
  status: ['ئامادەیە؟', 'کەی تەواو دەبێت؟', 'پۆستەرەکە چی بوو؟', 'کەی ئامادە دەبێت؟', 'هیچ هەواڵێک هەیە؟', 'پۆستەرەکە گەیشتە کوێ؟'],
  deadline: ['تا پێنجشەممەی داهاتوو پێویستمانە', 'تا سبەی پێویستمانە', 'شەممە پێویستمانە', 'پێش کۆتایی هەفتە', 'زۆر پەلەمانە', 'بەپەلە تکایە'],
  cancel: ['پێویست ناکات', 'ڕاوەستە', 'هەڵیبوەشێنەوە', 'پێویستمان نییە', 'وازی لێ بێنە', 'تکایە پۆستەرەکە هەڵبوەشێنەوە', 'پێویست ناکات، هەڵیبوەشێنەوە'],
  'confirm-yes': ['بەڵێ'],
  'confirm-no': ['نەخێر'],
  thanks: ['سوپاس', 'زۆر سوپاس', 'سوپاست دەکەم', 'مەمنون'],
  smalltalk: ['سڵاو', 'چۆنی'],
  redo: ['باش نییە، دووبارەی بکەرەوە', 'دیزاینێکی باشتر بکە وەک ئەوانەی پێشوو'],
};
// Arabic: a few plain office phrasings (request, thanks, cancel).
const AR: Partial<Record<Family, readonly string[]>> = {
  thanks: ['شكرا جزيلا', 'شكراً'],
  cancel: ['ألغِ التصميم من فضلك', 'لا نحتاجه بعد الآن'],
};
const AR_BRIEFS = ['مرحبا، نريد بوستر لمؤتمر KAAE السنوي يوم ١٥ تشرين الأول في فندق روتانا'];

const EVENTS = ['Assessment Literacy Workshop', 'Teacher Appreciation Day', 'Open Day', 'Graduation Ceremony', 'Nawroz Celebration', 'Book Fair',
  'Science Camp', 'Quality Assurance Workshop', 'Parents Meeting', 'Career Fair', 'Research Day'];
const DATES = ['15 October 2026', '5 November 2026', '20 March 2027', '12 November 2026'];
const VENUES = ['Rotana Hotel, Erbil', 'the KAAE hall, Erbil', 'Saad Abdullah Hall', 'Sami Abdulrahman Park'];
function englishBrief(kaae: boolean, event = pick(EVENTS)): string {
  const date = pick(DATES), venue = pick(VENUES);
  const at = venue.startsWith('the ') ? `in ${venue}` : `at ${venue}`;
  return kaae
    ? pick([`Can you make a poster for KAAE's ${event} on ${date} ${at}?`, `Please make a KAAE poster for the ${event}, ${date}, ${venue}.`,
      `Hi, we need an Instagram post for the KAAE ${event} on ${date} ${at}. Thanks!`])
    : pick([`Please make a poster for the ${event} on ${date} ${at}.`, `Could you design a flyer for our ${event}? It's on ${date} ${at}.`,
      `Hello, can we get a poster for the ${event} on ${date} ${at}?`]);
}
// Sorani briefs: whole briefs from the repository's tests (KAAE named), and one that names nobody.
const CKB_BRIEFS = ['سڵاو، دەتوانن پۆستەرێکمان بۆ دروست بکەن بۆ ئاهەنگی نەورۆزی KAAE لە ٢٠ی ئازار لە پارکی سامی عەبدولڕەحمان؟',
  'پۆستەرێکی نوێمان دەوێت بۆ خولی ڕاهێنانی مامۆستایان، ١٠ی تشرینی دووەم کاتژمێر ٩ی بەیانی لە هۆڵی KAAE',
  'سڵاو، پۆستەرێکمان دەوێت بۆ ئاهەنگی دەرچوونی KAAE\nبەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا',
  'پۆستەرێک بۆ ئاهەنگی نەورۆزی KAAE، ٢٠ی ئازاری ٢٠٢٧، پارکی سامی عەبدولڕەحمان'];
const CKB_BRIEF_NO_CLIENT = 'سڵاو کاکە تکایە پۆستەرێکمان بۆ دروست بکەن بۆ سیمیناری ددان لە ٢٥ی مانگ لە هۆڵی سەعد عەبدوڵڵا';
const CKB_SECOND_BRIEF = 'سوپاس، پۆستەرێکی نوێ بۆ ڕۆژی کراوە';

function phrase(family: Family, lang: Lang, opening: string): { text: string; lang: Lang } {
  if (family === 'new-brief') {
    if (lang === 'ckb') return { text: chance(0.5) ? CKB_SECOND_BRIEF : pick(CKB_BRIEFS.filter((b) => b !== opening)), lang };
    // A second brief always names its own event, and says it is new half the time.
    const brief = englishBrief(true, pick(EVENTS.filter((e) => !opening.includes(e))));
    return { text: chance(0.5) ? `Another one please: ${brief}` : brief, lang: 'en' };
  }
  if (lang === 'ar' && AR[family] && chance(0.7)) return { text: pick(AR[family]!), lang: 'ar' };
  if (lang === 'ckb' || (lang === 'ar')) return { text: pick(CKB[family]), lang: 'ckb' };
  return { text: pick(EN[family]), lang: 'en' };
}

const FOLLOW_UPS: Array<[Family, number]> = [['change', 22], ['opinion-pos', 9], ['opinion-neg', 11], ['status', 9], ['deadline', 7],
  ['cancel', 14], ['thanks', 9], ['smalltalk', 6], ['new-brief', 6], ['redo', 5], ['confirm-yes', 1], ['confirm-no', 1]];
function weighted(): Family {
  const total = FOLLOW_UPS.reduce((n, [, w]) => n + w, 0);
  let r = rng() * total;
  for (const [f, w] of FOLLOW_UPS) if ((r -= w) < 0) return f;
  return 'change';
}

function generate(n: number): Convo[] {
  const out: Convo[] = [];
  for (let i = 0; i < n; i++) {
    const lang: Lang = i % 10 === 9 ? 'ar' : i % 4 === 1 ? 'ckb' : 'en';
    const kaaeNamed = lang === 'ar' ? true : lang === 'ckb' ? !chance(0.2) : chance(0.6);
    const opening = lang === 'ar' ? pick(AR_BRIEFS) : lang === 'ckb' ? (kaaeNamed ? pick(CKB_BRIEFS) : CKB_BRIEF_NO_CLIENT) : englishBrief(kaaeNamed);
    const answerClient = kaaeNamed || chance(0.8);
    const turns: Turn[] = [];
    const count = 1 + Math.floor(rng() * 4);
    let stage = 0; // 0 designing, 1 with the office, 2 delivered
    for (let k = 0; k < count; k++) {
      const prev = turns.at(-1);
      // A cancel is followed by its answer most of the time, as a person answers "Do you want me to cancel …?".
      const family: Family = prev?.family === 'cancel' && chance(0.75) ? (chance(0.6) ? 'confirm-yes' : 'confirm-no') : weighted();
      let advance: Turn['advance'] = 'none';
      if (family !== 'confirm-yes' && family !== 'confirm-no' && stage < 2 && chance(k === 0 ? 0.45 : 0.35)) {
        advance = stage === 0 ? 'draft' : 'deliver';
        stage++;
      }
      const said = phrase(family, lang, opening);
      turns.push({ family, text: said.text, lang: said.lang, replyToFirst: k > 0 && family !== 'confirm-yes' && family !== 'confirm-no' && chance(0.12), advance });
    }
    out.push({ id: `c${String(i).padStart(3, '0')}-${lang}`, lang, opening, kaaeNamed, answerClient, turns });
  }
  return out;
}

// --- what a bot message is: the catalogue phrase it was made from ---------------------------------------------
const BOOKS: Record<string, PhraseBook> = { SOURCE: SOURCE_MESSAGES, MEDIA: MEDIA_MESSAGES, INBOX: INBOX_MESSAGES, ACCESS: ACCESS_MESSAGES,
  ROUTING: ROUTING_MESSAGES, CONVERSATION: CONVERSATION_MESSAGES, LIFECYCLE: LIFECYCLE_MESSAGES, OUTCOME: OUTCOME_MESSAGES, ALBUM: ALBUM_MESSAGES,
  OFFICE: OFFICE_MESSAGES, WITHDRAW: WITHDRAW_MESSAGES, PENDING: PENDING_ROUND_MESSAGES, NAMING: NAMING_MESSAGES,
  CLIENT: CLIENT_QUESTION_MESSAGES, LIMIT: INTAKE_LIMIT_MESSAGES };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATES = Object.entries(BOOKS).flatMap(([book, phrases]) => Object.entries(phrases).flatMap(([key, p]) =>
  (['en', 'ckb'] as const).map((lang) => ({ key: `${book}.${key}`, lang, en: p.en,
    re: new RegExp(`^${escape(p[lang].trim()).replace(/\\\{\w+\\\}/g, '[\\s\\S]*?')}$`, 'u') }))));
/** The catalogue keys a sent message was made from (whole, or paragraph by paragraph). */
function keysOf(text: string): string[] {
  const plain = text.trim();
  const whole = TEMPLATES.filter((t) => t.re.test(plain)).map((t) => t.key);
  if (whole.length) return [...new Set(whole)];
  return [...new Set(plain.split(/\n\n+/).flatMap((part) => TEMPLATES.filter((t) => t.re.test(part.trim())).map((t) => t.key)))];
}
/** Phrases that tell the requester their words went to the office (J7). */
const PASSED = new Set(Object.entries(BOOKS).flatMap(([book, phrases]) => Object.entries(phrases)
  .filter(([, p]) => /\b(?:passed|told the office|let the office know|asked the office)\b/i.test(p.en)).map(([key]) => `${book}.${key}`)));
const THANKING = new Set(Object.entries(BOOKS).flatMap(([book, phrases]) => Object.entries(phrases)
  .filter(([, p]) => /^(?:🙏\s*)?(?:thanks|thank you)\b/i.test(p.en.trim())).map(([key]) => `${book}.${key}`)));
const ASK_CANCEL = new Set(['WITHDRAW.askCancel', 'WITHDRAW.askCancelBoth', 'WITHDRAW.askCancelAll']);
const QUESTIONS = new Set(Object.entries(BOOKS).flatMap(([book, phrases]) => Object.entries(phrases)
  .filter(([key, p]) => /^ask/.test(key) || /\?\s*$/.test(p.en.trim())).map(([key]) => `${book}.${key}`)));

/** The language a reply is in, ignoring names in bold (a design's name keeps the language it was written in). */
function replyLang(text: string): Lang | null {
  const bare = text.replace(/<b>[\s\S]*?<\/b>/g, ' ').replace(/<[^>]+>/g, ' ');
  const lang = requesterLang(bare, 'en');
  return /\p{L}/u.test(bare) ? lang : null;
}

// --- the run -----------------------------------------------------------------------------------------------
type Inv = 'J1' | 'J2' | 'J3' | 'J4' | 'J5' | 'J6' | 'J7';
interface Violation { invariant: Inv; code: string; turn: number; detail: string }
interface TurnRecord { k: number; family: Family | 'opening' | 'client-answer'; text: string; stage: string; replyToFirst?: boolean;
  bot: string[]; keys: string[]; office: number; opened: number; designs: number; revisions: number; kept: number; withdrawn: boolean }
interface Outcome { id: string; turns: TurnRecord[]; violations: Violation[]; friction: string[] }

const WORKER = ['conversation', 'fuzz', 'worker'].join('_');
const OFFICE: Person[] = [{ id: 94_100_001, name: 'Office A' }, { id: 94_100_002, name: 'Office B' }];
/**
 * One harness plays every conversation, each in its own private chat with its own requester (the office is the same
 * two members): a harness per conversation spent most of the run building the app and moving every row's clock.
 */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function play(c: Convo, db: Kysely<Database>, owner: Kysely<Database>, at: { harness: ConversationHarness | null }): Promise<Outcome> {
  const office = OFFICE;
  const h = at.harness ??= new ConversationHarness({ db, owner, office, workerToken: WORKER });
  const p = new Play(h, office);
  const officeIds = office.map((m) => String(m.id));
  const violations: Violation[] = [];
  const friction: string[] = [];
  const turns: TurnRecord[] = [];
  const v = (invariant: Inv, code: string, turn: number, detail: string) => violations.push({ invariant, code, turn, detail: detail.slice(0, 240) });
  /** The chat's open request (the first this conversation opened that is still open). */
  const currentStage = async () => {
    const rs = await h.requests(p.chatId);
    const open = rs.filter((r) => !['withdrawn', 'rejected', 'cancelled', 'closed'].includes(r.stage));
    return { all: rs, stage: open.length ? open.map((r) => r.stage).join('+') : rs.length ? `closed:${rs.map((r) => r.stage).join('+')}` : 'none' };
  };
  /** One message from the requester, with everything that happened while it was the latest step. */
  const send = async (k: number, family: TurnRecord['family'], text: string, replyTo?: number) => {
    // The message, then the settles it asks for (a brief waits 15 s for photos): everything the bot said or started
    // until the next message belongs to this turn. Messages are 30 s apart (fewer clock moves keep the run short).
    const before = { opened: h.t.opened.length, designs: h.t.designs.length, revisions: h.t.revisions.length, kept: h.t.kept.length };
    const { all: rsBefore, stage } = await currentStage();
    const inbound: Inbound = await p.say(text, { after: 0, ...(replyTo ? { replyTo } : {}) });
    await h.wait(30_000);
    const sent = h.saidFor(inbound);
    const bot = sent.filter((s) => s.chatId === p.chatId).map((s) => s.text);
    const officeMsgs = h.t.sent.filter((s) => s.step === inbound.step && officeIds.includes(s.chatId));
    const rsAfter = await h.requests(p.chatId);
    const withdrawn = rsAfter.some((r) => r.stage === 'withdrawn' && rsBefore.find((b) => b.requestId === r.requestId)?.stage !== 'withdrawn') ||
      h.t.answers.get(inbound.updateId)?.lifecycleAction === 'withdraw';
    const rec: TurnRecord = { k, family, text, stage, ...(replyTo ? { replyToFirst: true } : {}), bot, keys: [...new Set(bot.flatMap(keysOf))],
      office: officeMsgs.length, opened: h.t.opened.length - before.opened, designs: h.t.designs.length - before.designs,
      revisions: h.t.revisions.length - before.revisions, kept: h.t.kept.length - before.kept, withdrawn };
    turns.push(rec);
    return { rec, inbound, officeMsgs, newRevisions: h.t.revisions.slice(before.revisions), keptNow: h.t.kept.slice(before.kept) };
  };

  // The opening brief, and the answer to "who is it for?" when it is asked.
  const first = await send(0, 'opening', c.opening);
  if (first.rec.keys.some((key) => key.startsWith('CLIENT.askClient')) && c.answerClient) await send(0, 'client-answer', 'KAAE');
  let lastAsk: string[] = turns.at(-1)!.keys;
  for (const [i, turn] of c.turns.entries()) {
    const k = i + 1;
    // The office's side moves the design on between messages: a draft made ready, then delivered.
    const req = h.t.opened.find((o) => o.chatId === p.chatId);
    const designsBefore = h.t.designs.length;
    if (turn.advance !== 'none' && req) {
      const { all } = await currentStage();
      const now = all.find((r) => r.requestId === req.requestId)?.stage;
      try {
        if (turn.advance === 'draft' && now === 'designing') await h.draftReady(req.requestId, 2 * 60_000);
        else if (turn.advance === 'deliver' && now === 'in_review') await h.delivered(req.requestId, 60_000);
        else if (turn.advance === 'deliver' && now === 'designing') await h.draftReady(req.requestId, 2 * 60_000);
      } catch (error) {
        friction.push(`office step ${turn.advance} at ${now}: ${String((error as Error).message).slice(0, 120)}`);
      }
      // J1 (a round started when a draft finished): it must carry a change the requester said.
      const started = h.t.designs.slice(designsBefore);
      if (started.length) {
        const said = turns.filter((t) => t.k > 0).map((t) => t.family);
        if (!said.some((f) => f === 'change' || f === 'redo' || f === 'opinion-neg')) {
          v('J1', 'round-after-draft-without-change', k, `families said: ${said.join(', ') || 'none'}`);
        } else if (!said.some((f) => f === 'change' || f === 'redo')) {
          v('J1', 'round-after-draft-from-opinion', k, `families said: ${said.join(', ')}`);
        }
      }
    }
    const replyTo = turn.replyToFirst ? h.said(p.chatId)[0]?.messageId : undefined;
    const { rec, officeMsgs, newRevisions, keptNow } = await send(k, turn.family, turn.text, replyTo);
    const asked = rec.keys.some((key) => QUESTIONS.has(key));
    // A cancel asked about by name, or by which design it is for (several open): asked first either way.
    const askedCancel = rec.keys.some((key) => ASK_CANCEL.has(key) || key === 'ROUTING.askWhichDesign' || key === 'ROUTING.askIsThisOne');
    const open = !rec.stage.startsWith('closed') && rec.stage !== 'none';
    // J1
    if (rec.opened && turn.family !== 'new-brief') v('J1', `request-opened-by-${turn.family}`, k, turn.text);
    if (rec.designs && !['new-brief', 'redo', 'change'].includes(turn.family)) v('J1', `round-started-by-${turn.family}`, k, turn.text);
    // J2
    if (rec.withdrawn) {
      if (turn.family !== 'confirm-yes') v('J2', turn.family === 'cancel' ? 'withdrew-without-asking' : `withdrew-on-${turn.family}`, k, turn.text);
      else if (!lastAsk.some((key) => ASK_CANCEL.has(key))) v('J2', 'yes-withdrew-unasked', k, `previous: ${lastAsk.join(',')}`);
    }
    if (turn.family === 'cancel' && open && /designing|in_review|awaiting_answer|manual/.test(rec.stage) && !rec.withdrawn && !askedCancel) {
      v('J2', 'cancel-not-asked', k, `${turn.text} → ${rec.keys.join(',') || rec.bot.join(' | ').slice(0, 120)}`);
    }
    if (turn.family === 'confirm-yes' && lastAsk.some((key) => ASK_CANCEL.has(key)) && !rec.withdrawn) {
      v('J2', 'yes-not-honoured', k, `${turn.text} → ${rec.keys.join(',')}`);
    }
    // J3
    if (turn.family === 'change') {
      if (rec.opened) v('J3', 'change-opened-request', k, turn.text);
      const words = norm(turn.text);
      const reached = newRevisions.some((r) => norm(r.directive).includes(words)) || keptNow.length > 0 ||
        officeMsgs.some((m) => norm(m.text).includes(words));
      if (!reached && !asked && open) v('J3', 'change-words-dropped', k, `${turn.text} at ${rec.stage} → ${rec.keys.join(',') || rec.bot.join(' | ').slice(0, 120)}`);
      if (asked && open) friction.push(`turn ${k}: change asked (${rec.keys.join(',')}): ${turn.text}`);
    }
    if ((turn.family === 'opinion-pos' || turn.family === 'opinion-neg') && rec.keys.includes('ROUTING.askChangeOrNew')) {
      friction.push(`turn ${k}: opinion asked "a change or a new design?": ${turn.text}`);
    }
    if (rec.stage === 'none' && rec.keys.includes('ROUTING.statusNothingOpen') && turns.some((t) => t.keys.some((x) => x.startsWith('CLIENT.askClient')))) {
      friction.push(`turn ${k}: "nothing in progress" while the brief waits for who it is for: ${turn.text}`);
    }
    // J4
    if (!rec.bot.length) friction.push(`turn ${k}: no reply to "${turn.text}" at ${rec.stage}`);
    for (const said of rec.bot) {
      for (const issue of frictionIssues(said)) v('J4', `unnatural: ${issue}`, k, said);
      if (/LIFECYCLE_|[A-Z]{3,}_[A-Z_]{3,}/.test(said)) v('J4', 'internal-code', k, said);
      const got = replyLang(said);
      const want: Lang = turn.lang === 'ar' ? 'ckb' : /\p{L}/u.test(turn.text) ? turn.lang : c.lang === 'en' ? 'en' : 'ckb';
      if (got && got !== want) v('J4', `wrong-language-${want}-got-${got}`, k, `${turn.text} → ${said}`);
    }
    // J5
    if (turn.family === 'thanks' || turn.family === 'smalltalk') {
      if (rec.designs || rec.opened) v('J5', `${turn.family}-started-work`, k, turn.text);
      if (asked) v('J5', `${turn.family}-asked`, k, `${turn.text} → ${rec.keys.join(',')}`);
      if (rec.withdrawn) v('J5', `${turn.family}-cancelled`, k, turn.text);
    }
    // J6
    if (turn.family === 'opinion-neg' && rec.keys.some((key) => THANKING.has(key))) v('J6', 'thanked-for-negative', k, `${turn.text} → ${rec.keys.join(',')}`);
    // J7
    if (rec.keys.some((key) => PASSED.has(key)) && !officeMsgs.length) v('J7', 'passed-on-but-office-not-alerted', k, `${turn.text} → ${rec.keys.filter((x) => PASSED.has(x)).join(',')}`);
    if (rec.kept && !officeMsgs.length) friction.push(`turn ${k}: words kept for the office with no alert (${rec.keys.join(',')}): ${turn.text}`);
    lastAsk = rec.keys;
  }
  return { id: c.id, turns, violations, friction };
}

/**
 * Registers one shard of the fuzz (conversations i with i % shards === shard - 1) in the calling test file. Each shard is
 * its own test file, so each gets its own database clone and they run side by side: one file played the 320
 * conversations in five and a half minutes, most of it moving every row's clock in a database that kept growing.
 */
export function defineConversationFuzz(shard: number, shards: number): void {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await db.destroy(); await owner.destroy(); });
  const ALL = generate(Number(process.env.HAWA_CONVFUZZ_N ?? 320));
  const CONVOS = ALL.filter((_, i) => i % shards === shard - 1);
  const at: { harness: ConversationHarness | null } = { harness: null };
describe(`conversation fuzz ${shard}/${shards}: multi-turn requester conversations through the real intake path (QA ratchet)`, () => {
  it(`${CONVOS.length} seeded conversations hold J1–J7 no worse than the pinned baseline`, async () => {
    const outcomes: Outcome[] = [];
    for (const c of CONVOS) {
      try {
        outcomes.push(await play(c, db, owner, at));
      } catch (error) {
        outcomes.push({ id: c.id, turns: [], violations: [], friction: [`crashed: ${String((error as Error).stack ?? error).slice(0, 400)}`] });
      }
    }
    const all = outcomes.flatMap((o) => o.violations.map((x) => ({ id: o.id, ...x })));
    const by = (inv: Inv) => all.filter((x) => x.invariant === inv).length;
    const counts = { total: all.length, J1: by('J1'), J2: by('J2'), J3: by('J3'), J4: by('J4'), J5: by('J5'), J6: by('J6'), J7: by('J7') };
    const byCode: Record<string, number> = {};
    for (const x of all) byCode[`${x.invariant} ${x.code}`] = (byCode[`${x.invariant} ${x.code}`] ?? 0) + 1;
    const turnsPlayed = outcomes.reduce((n, o) => n + o.turns.length, 0);
    const crashed = outcomes.filter((o) => o.friction.some((f) => f.startsWith('crashed'))).length;
    const here = dirname(fileURLToPath(import.meta.url));
    // HAWA_CONVFUZZ_OUT: another directory (a measurement of other code, such as the release before a fix).
    const name = `violations-${shard}of${shards}.json`;
    const out = process.env.HAWA_CONVFUZZ_OUT ? resolve(process.env.HAWA_CONVFUZZ_OUT, name)
      : resolve(here, '../../../../output/research/2026-10-03-conversation-fuzz', name);
    mkdirSync(dirname(out), { recursive: true });
    const rows = (xs: unknown[]) => `[\n${xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
    writeFileSync(out, `{\n  "seed": ${SEED},\n  "shard": "${shard}/${shards}",\n  "conversations": ${CONVOS.length},\n  "turns": ${turnsPlayed},\n  "crashed": ${crashed},\n` +
      `  "counts": ${JSON.stringify(counts)},\n  "byCode": ${JSON.stringify(byCode)},\n` +
      `  "failing": ${rows(outcomes.filter((o) => o.violations.length))},\n` +
      `  "friction": ${rows(outcomes.filter((o) => o.friction.length).map((o) => ({ id: o.id, friction: o.friction })))},\n` +
      `  "passing": ${rows(outcomes.filter((o) => !o.violations.length).map((o) => ({ id: o.id, turns: o.turns.map((t) => `${t.family}@${t.stage}: ${t.text}`) })))}\n}\n`);
    console.log(JSON.stringify({ conversations: CONVOS.length, turns: turnsPlayed, crashed, counts, byCode }, null, 1));
    expect(crashed).toBe(0);
    // No model, Canva or other paid provider was called by any conversation (the harness records each one).
    expect(at.harness?.t.paidCalls ?? []).toEqual([]);
    const noted = (cue: string) => outcomes.reduce((n, o) => n + o.friction.filter((f) => f.includes(cue)).length, 0);
    const friction = { opinionAskedChangeOrNew: noted('opinion asked "a change or a new design?"'),
      nothingInProgressWhileBriefWaits: noted('"nothing in progress" while the brief waits'), noReply: noted(': no reply to ') };
    for (const key of Object.keys(CONVERSATION_FUZZ_FRICTION) as Array<keyof typeof CONVERSATION_FUZZ_FRICTION>) {
      expect(friction[key], key).toBeLessThanOrEqual(CONVERSATION_FUZZ_FRICTION[key]);
    }
    for (const key of Object.keys(CONVERSATION_FUZZ_BASELINE) as Array<keyof typeof CONVERSATION_FUZZ_BASELINE>) {
      expect(counts[key], key).toBeLessThanOrEqual(CONVERSATION_FUZZ_BASELINE[key]);
    }
  }, 900_000);
});
}
