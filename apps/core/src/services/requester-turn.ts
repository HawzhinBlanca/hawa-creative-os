/**
 * What a requester's message means, in the context of the chat's own requests (ADR-144).
 *
 * A requester writes naturally, in English, Sorani or both: "thanks", "when will it be ready?",
 * "the date should be 5 October not 4", "looks good, send it", "cancel that", "we need it by
 * tomorrow", "Hi, can you make a poster for Nawroz?". Before a message is bound to a request or opens
 * one, this module reads it (rules first; a model only for what the rules cannot place, see
 * requester-intent-model.ts) and plans one action against the chat's live requests.
 *
 * Everything here is pure: no database, no HTTP, no model. The intake route gathers the chat's
 * requests, calls `readIntentByRules` and `planTurn`, records the plan once per update, and carries it
 * out. The safety rules are the planner's:
 *  - only a change asked of a request that waits for changes (or answers its question) starts a paid
 *    round, and only when the request is known for certain (a reply, the only candidate, its name in
 *    the words, or a confident model reading): never by recency alone;
 *  - a change while a design is being made, or after it reached the office, is kept on the request
 *    for the office (the late-change store, whose Deliver gate an office member clears in the Desk);
 *  - approval words are passed to the office and approve nothing (ADR-022);
 *  - "send it again", "it didn't arrive", "as a PDF", "to my email", "higher resolution" ask the office
 *    about the files: they are passed on, and are never approval (ADR-156);
 *  - only a new brief opens a request; a message that could be either asks one short question.
 */
import { LIFECYCLE_MESSAGES, NAMING_MESSAGES, ROUTING_MESSAGES, WITHDRAW_MESSAGES, bold, escapeTelegramHtml, isNeutralRequestTitle, requesterLang, say as sayPhrase,
  trimTitleMarks, type Phrase, type RequesterLang } from '@hawa/integrations';
import { asksToUndoCancel, CHANGE_CUES, classifyWithHeuristics, containsKeyword, isAcknowledgement, isSoraniText } from './telegram-classifier.js';
import { isCopyIntroducer } from './request-remarks.js';
import { isIntroducerTitle, withoutMarks } from './draft-title.js';

export type TurnIntent = 'acknowledgement' | 'status' | 'approval' | 'delivery_request' | 'cancel' | 'hold' | 'deadline' |
  'change' | 'new_brief' | 'conversation' | 'unclear';

export interface IntentReading {
  intent: TurnIntent;
  reason: string;
  source: 'rules' | 'model';
  /** new_brief: styling or a request with no copy yet; it opens for a person, never a paid draft. */
  instructionOnly?: boolean;
  /** new_brief: said as new ("new poster", "another design", "can you make a poster"). */
  explicitNew?: boolean;
  /** new_brief: carries enough copy or event detail to be a brief of its own. */
  substantial?: boolean;
  /** Model readings only: the request the model named, and how sure it was. */
  requestId?: string;
  confidence?: number;
  /** conversation: a question the bot cannot answer itself ("how much does a poster cost?"); the office answers it (ADR-182). */
  question?: boolean;
  /**
   * change: the words only refuse ("not approved", "don't send it"; ADR-040 addendum, 2026-10-01). The
   * office hears that the requester is not happy; with nothing said to change, no round starts.
   */
  refusalOnly?: boolean;
  /**
   * ADR-200 addendum (incident 2026-10-01 12:33Z): the words ask to redo a design ("do a better design
   * that's similar to the earlier ones", "try again", Sorani "make it again"), with no new copy and no
   * subject of their own. `redo`: they mean the requester's most recent design. `or-new`: they may also
   * mean a new design ("a better poster for the conference"), so the requester is asked.
   */
  redo?: 'redo' | 'or-new';
  /**
   * ADR-230 addendum (L17): `unclear` words that cancel a whole request in a way the patterns cannot
   * place. They are asked about among the requests that can be withdrawn, never with "a new design".
   */
  cancelWords?: true;
  /**
   * ADR-251 (bug hunt 2, friction 1): a cancel that names nothing ("never mind", "stop", "no need",
   * "ok never mind"). It may be about the last thing said rather than the design, so the requester is
   * asked "Do you want me to cancel …?" first; it never withdraws on its own.
   */
  bareCancel?: true;
}

export type Lang = RequesterLang;
/**
 * The language to answer a message in (ADR-145): the script with more letters, so a Sorani message
 * that names a brand in Latin letters is answered in Sorani, and an English one quoting a Kurdish word
 * in English. ADR-251 (friction 11): a message with no letters (an emoji, a number) is answered in
 * `fallback`, the chat's own language when the caller knows it, else English.
 */
export const langOf = (text: string, fallback: Lang = 'en'): Lang => requesterLang(text, fallback);
/** Whether the words carry any letter to tell their language by (ADR-251). */
export const hasLetters = (text: string): boolean => /\p{L}/u.test(String(text ?? ''));

export type RequestStage = 'designing' | 'awaiting_answer' | 'in_review' | 'manual' | 'approved' |
  'delivering' | 'delivered';

/** One request of the chat, as the planner sees it (lifecycle-chat-target.ts `activeChatRequests`). */
export interface ChatRequestView {
  requestId: string;
  stage: RequestStage;
  rev: number;
  currentTaskId: string;
  clientId: string | null;
  title: string;
  /** When the request last moved (a draft arrived, a stage changed): ISO time. */
  activeAt: string;
  createdAt: string;
  question: { id: string; text: string; options: string[] } | null;
  /** The Telegram user who sent its brief, when known. */
  requesterId: string | null;
  /** Current task is at its requester hold checkpoint, rather than making a draft. */
  requesterHold?: boolean;
  /**
   * ADR-231: the current task's files and final notice reached the requester (Telegram confirmed the
   * notice). A request still `delivering` with this set was sent; only the office's side is unfinished.
   */
  sentToChat?: boolean;
  /** ADR-230 addendum (L16): the start of the requester's own brief, to name a request whose title names nothing. */
  words?: string;
}

/** A question this bot asked the sender, still open: its own update, the words it holds, the options. */
export interface PendingAsk {
  updateId: number;
  intent: Exclude<TurnIntent, 'acknowledgement' | 'status' | 'new_brief' | 'conversation'>;
  words: string;
  /** `askedAt`: when the request was opened (ADR-231), to tell two designs with the same name apart. */
  options: Array<{ requestId: string; title: string; askedAt?: string; words?: string }>;
  allowNew: boolean;
  /**
   * ADR-156: the question was asked about a photo with these words. The photo is kept under the
   * question's own update (`lifecycle_photo_held`), and the answer carries it to the design it names.
   */
  photo?: boolean;
}

/** What a `tell` passes to the office: approval words, a deadline, or a request about the files (ADR-156). */
export type TellNote = 'approval' | 'deadline' | 'delivery';

export type TurnPlan =
  | { kind: 'open'; text: string; instructionOnly: boolean; resolves?: number }
  /** `redo`: redo words (ADR-200 addendum); the requester hears "I'll redo …". */
  | { kind: 'revise'; requestId: string; directive: string; resolves?: number; redo?: true }
  | { kind: 'note'; note: 'change' | 'cancel' | 'hold'; requestId: string; words: string; resolves?: number; redo?: true }
  /** ADR-200 addendum: redo words about a design delivered within `REDO_WINDOW_MS`: a new round of it. */
  | { kind: 'redo'; requestId: string; directive: string; resolves?: number }
  | { kind: 'tell'; note: TellNote; requestId: string; words: string; resolves?: number }
  /** `nothing-to-cancel` (ADR-230 addendum): a cancel with no request it could withdraw; `requestIds` are named. */
  | { kind: 'reply'; what: 'thanks' | 'status' | 'nothing-to-change' | 'nothing-to-cancel'; requestIds: string[] }
  /**
   * Words about a design this bot cannot find (a reply to an old message), or a question it cannot
   * answer (`question`, ADR-182): passed to the office.
   */
  | { kind: 'forward'; words: string; question?: true }
  /** `redo`: a question about redo words, worded so ("Which one should I redo: …?"). */
  | ({ kind: 'ask'; redo?: 'redo' | 'or-new' } & Omit<PendingAsk, 'updateId'>)
  | { kind: 'passive'; reason: string }
  | { kind: 'conversation' };

// ---------------------------------------------------------------------------------------------
// Reading the words
// ---------------------------------------------------------------------------------------------

/**
 * ADR-182: the words without a mention of a bot ("@hawa_office_bot make a poster …"): in a group the
 * mention says who is addressed, and is not part of a brief's copy or of what a message means. Every
 * Telegram bot's username ends in "bot"; people's mentions stay.
 */
export function withoutBotMentions(text: string): string {
  if (!text.includes('@')) return text;
  const without = text.replace(/(^|[\s,،(])@[A-Za-z][A-Za-z0-9_]{2,}bot\b[,:،]?[^\S\n]*/gi, '$1');
  return without === text ? text : without.replace(/^\s+/, '').replace(/[^\S\n]+$/, '');
}

/** Skin tones, variation selectors and direction marks carry no meaning here. */
const clean = (text: string) => text.replace(/[\u{1F3FB}-\u{1F3FF}️‎‏]/gu, '').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();

/** Politeness around the point of a message: "ok, sorry, please …", "… thanks". */
const LEAD = /^(?:(?:ok(?:ay)?|sorry|actually|please|pls|plz|hi|hello|hey|oh|um+|so|and|also|dear|salam|well|ah|سڵاو|ببورە|تکایە|باشە|ئەی)[\s,،!.:-]+)+/iu;
const TAIL = /(?:[\s,،!.:-]+(?:please|pls|plz|thanks?|thank\s+you|thx|سوپاس|تکایە|زۆر\s+سوپاس))+[\s!.،]*$/iu;
export function corePhrase(text: string): string {
  let t = clean(text);
  for (let i = 0; i < 3; i++) {
    const next = t.replace(LEAD, '').replace(TAIL, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

const any = (text: string, phrases: readonly string[]) => phrases.some((p) => containsKeyword(text, p));

/** "send it", "go ahead", "بینێرە" (send it): the requester is happy. Approval itself stays in the Desk. */
const APPROVAL_PHRASES = [
  'send it', 'send them', 'send it over', 'send it to me', 'send it to us', 'send the final', 'send the file',
  'send the files', 'send the final version', 'you can send', 'go ahead', 'approve', 'approved', 'we approve',
  'i approve', 'ready to print', 'ready to publish', 'good to go', 'ok to print', 'okay to print', 'print it',
  'publish it', 'finalize it', 'finalise it', 'no changes', 'no change needed', 'no changes needed',
  'nothing to change', 'keep it as is', 'leave it as is', 'fine as is', 'as it is',
  // Sorani: send it, send it to us, send (plural), approved, I approve it, we approved it, we agree,
  // no change needed, there is no change, print it, publish it.
  'بینێرە', 'بۆمان بنێرە', 'بینێرن', 'بنێرە', 'پەسەندە', 'پەسەندی دەکەم', 'پەسەندمان کرد', 'ڕەزامەندین',
  'گۆڕانکاری ناوێت', 'هیچ گۆڕانکارییەک نییە', 'چاپی بکە', 'بڵاوی بکەرەوە',
];
/** Praise that goes with approval and is not a change: "looks good", "perfect". */
const PRAISE = /\b(?:it\s+)?(?:looks?|is|it'?s)?\s*(?:very\s+|really\s+|so\s+)?(?:good|great|perfect|fine|nice|lovely|excellent|beautiful|amazing|all\s+good|ok(?:ay)?)\b/giu;

/**
 * ADR-040 addendum (incident 2026-10-01): approval words that refuse it: "the design is not approved",
 * "don't send it", "I can't approve this", "isn't ready"; Sorani "not approved", "I don't approve it",
 * "don't send it". "Approved" and "send it" are approval phrases, so these read as approval until a
 * refusal is looked for first. Office and requester readings both use it.
 */
export const REFUSAL = /\b(?:not|isn'?t|is\s+not|aren'?t|wasn'?t|never)\s+(?:yet\s+)?(?:approved?|ready|good|ok(?:ay)?|fine|acceptable)\b|\b(?:don'?t|do\s+not|doesn'?t|does\s+not|never|can'?t|cannot|can\s+not|won'?t|will\s+not|wouldn'?t|shouldn'?t|should\s+not|mustn'?t|must\s+not)\s+(?:yet\s+)?(?:send|approve|ship|publish|print|deliver|post|share|forward|e-?mail)\b|(?:پەسەند\s*نییە|پەسەند\s*نەکراوە|پەسەندی\s*ناکەم|پەسەندی\s*ناکەین|مەینێرە|مەنێرە|نەینێرە|نەنێرە|مەینێرن|نەینێرن)/giu;
/** Words around a refusal that say nothing more about the draft. */
const REFUSAL_FILLER = /\b(?:the|this|that|it|its|them|design|draft|poster|picture|one|is|yet|sorry|please|so|and|but|i|we|you|to|me|us|now|again|anyone|anything)\b|(?:دیزاینەکە|ئەمە|ئەوە|هێشتا)/giu;

/** Whether the words refuse approval or sending ("not approved", "don't send it"). */
export function refusesApproval(text: string): boolean {
  REFUSAL.lastIndex = 0;
  return REFUSAL.test(text);
}

/** What a refusal says beyond refusing: at least two words of it are what to change. */
export function saysMoreThanRefusal(text: string): boolean {
  return text.replace(REFUSAL, ' ').replace(REFUSAL_FILLER, ' ').split(/[\s,،.!?؟:;…-]+/u).filter(Boolean).length >= 2;
}

/**
 * ADR-156 (audit #9): words that ask the office about the files themselves: to send them again, that
 * they did not arrive, in another format, to an email address or another app, or at a higher
 * resolution. "Send it again" contains "send it", but it is never approval: the office hears it.
 */
const DELIVERY_EN: RegExp[] = [
  /\bre-?send\b/i,
  /\b(?:send|share|forward|give)\b[^.!?\n]{0,40}\b(?:again|once\s+more|one\s+more\s+time)\b/i,
  /\b(?:did(?:n'?t|\s+not)|has(?:n'?t|\s+not)|have(?:n'?t|\s+not)|never)\s+(?:arrive[d]?|come|came|reach(?:ed)?|receive[d]?|get|got)\b/i,
  /\b(?:not|never)\s+(?:yet\s+)?(?:received|arrived|delivered)\b/i,
  /\b(?:can'?t|cannot|could(?:n'?t|\s+not)|unable\s+to)\s+(?:open|download|find|see)\s+(?:it|them|the\s+(?:file|link|pdf|png|jpe?g|design|image|attachment)s?)\b/i,
  /\b(?:to|by|via|through|over|on)\s+(?:my\s+|our\s+|the\s+|his\s+|her\s+)?(?:e-?mail|gmail|whats\s?app|viber)\b/i,
  /\be-?mail\s+(?:it|them|me|us)\b/i,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
];
/** A file format or a resolution: about the files, unless the words name a part of the design ("a higher resolution logo"). */
const DELIVERY_FORMAT_EN: RegExp[] = [
  /\b(?:as|in|into)\s+(?:a\s+|an\s+)?(?:pdf|png|jpe?g|svg|tiff?|eps|psd|word\s+file|docx?)\b/i,
  /\b(?:pdf|png|jpe?g|svg|tiff?|eps|psd)\s+(?:version|file|format|copy)\b/i,
  /\b(?:high(?:er)?|better|full|max(?:imum)?|original|print)[-\s]?(?:res(?:olution)?|quality|size)\b|\bhi-?res\b/i,
];
const DESIGN_PART = /\b(?:logo|photo|image|picture|background|icon|font|text|title|colou?r)s?\b/i;
/** Words that make the message a change after all ("the email on the poster should be …", "add my email"). */
const DELIVERY_IS_CHANGE = /\b(?:should|must)\s+(?:be|say|read|show)\b|\binstead\s+of\b|\b(?:wrong|typo|mistake|incorrect)\b|\b(?:add|include|put|write|remove|delete|change|replace)\b/i;
/**
 * Sorani: send it again (three spellings), it did not arrive, it has not arrived, it did not reach me,
 * by email, to the email, my email, high quality, high resolution.
 */
const DELIVERY_CKB = ['دووبارە بینێرەوە', 'دووبارە بنێرەوە', 'دووبارەی بنێرەوە', 'نەگەیشت', 'نەگەیشتووە', 'پێم نەگەیشت',
  'بە ئیمەیڵ', 'بۆ ئیمەیڵ', 'ئیمەیڵەکەم', 'کوالیتی بەرز', 'ڕیزۆلووشنی بەرز'];

function readsAsDeliveryRequest(text: string, core: string): boolean {
  if (!core || core.length > 300 || asksForNewDesign(text) || DELIVERY_IS_CHANGE.test(core)) return false;
  if (DELIVERY_EN.some((p) => p.test(core)) || any(core, DELIVERY_CKB)) return true;
  if (DESIGN_PART.test(core)) return false;
  // A file type named among Sorani words: "بە pdf بینێرە" (send it as a PDF).
  return DELIVERY_FORMAT_EN.some((p) => p.test(core)) || (isSoraniText(core) && /\b(?:pdf|png|jpe?g|svg)\b/i.test(core));
}

const CANCEL_VERB = '(?:cancel|stop|scrap|drop|abort|withdraw|forget(?:\\s+about)?|never\\s?mind|nvm|' +
  "don'?t\\s+(?:do|make|bother\\s+with|continue(?:\\s+with)?|proceed(?:\\s+with)?)|no\\s+need\\s+(?:for|to\\s+(?:do|make))|no\\s+need|" +
  "(?:we|i)\\s+(?:don'?t|do\\s+not|no\\s+longer)\\s+need|(?:we|i)\\s+(?:want|would\\s+like)\\s+to\\s+cancel|" +
  "(?:it'?s|it\\s+is)\\s+(?:cancel+ed|not\\s+needed)|not\\s+needed|no\\s+longer\\s+needed)";
/** What a cancel may name: the whole request (a pronoun, or a noun for a job), never a part of a design. */
const CANCEL_OBJECT = '(?:it|that|this|them|these|everything|all(?:\\s+of\\s+(?:it|them))?|' +
  '(?:the|my|our|this|that)\\s+(?:[\\p{L}\\d\'-]+\\s+){0,3}?(?:request|order|job|design|poster|flyer|banner|invitation|card|post|story|work|one|thing)s?)';
const CANCEL_POLITE = '(?:\\s+(?:any\\s?more|now|for\\s+now|then|please|thanks?|thank\\s+you))*[\\s!.]*$';
const CANCEL_EN = new RegExp(`^(?:(?:just|kindly)\\s+)?${CANCEL_VERB}(?:\\s+${CANCEL_OBJECT})?${CANCEL_POLITE}`, 'iu');
/**
 * ADR-230 addendum (live 2026-10-01 15:08Z, L12): "also cancel the other one I opened by mistake this
 * afternoon". After the verb and a whole-request object, a clause may say which request it is: who made
 * it and when ("I opened by mistake", "I sent this morning", "that we ordered"), or when ("from earlier",
 * "this afternoon", "just now"). The object stays required, so "cancel the gold border" is a change.
 */
const CANCEL_WHEN = '(?:this\\s+(?:morning|afternoon|evening)|today|yesterday|earlier(?:\\s+today)?|before|just\\s+now|a\\s+(?:moment|minute|while|bit)\\s+ago|last\\s+night)';
const CANCEL_WHICH = '(?:\\s+(?:(?:that|which)\\s+)?(?:i|we)\\s+(?:just\\s+)?(?:opened|sent|made|asked\\s+(?:for|you\\s+for)|ordered|requested|started|created|wrote|submitted)' +
  `(?:\\s+(?:it|you|by\\s+(?:mistake|accident)|in\\s+error|${CANCEL_WHEN}|here|earlier))*` +
  `|\\s+(?:from|of)\\s+${CANCEL_WHEN}|\\s+${CANCEL_WHEN}|\\s+(?:opened|sent|made)\\s+by\\s+(?:mistake|accident)|\\s+by\\s+(?:mistake|accident))`;
const CANCEL_DESCRIBED = new RegExp(`^(?:(?:just|kindly)\\s+)?${CANCEL_VERB}\\s+${CANCEL_OBJECT}(?:${CANCEL_WHICH})+${CANCEL_POLITE}`, 'iu');
/** A cancel verb and a whole-request noun in words the patterns above do not place (the router reads them). */
const CANCEL_SOMEWHERE = new RegExp(`\\b(?:cancel|withdraw|scrap|abort)\\b.*\\b(?:request|order|job|design|poster|flyer|banner|invitation|card|one)s?\\b`, 'iu');
/** Sorani: cancel it, stop it, not needed, we don't need it, don't make it, leave it, give it up. */
const CANCEL_CKB = ['هەڵیوەشێنەوە', 'هەڵبوەشێنەوە', 'هەڵوەشێنەوە', 'هەڵیبوەشێنەوە', 'ڕایبگرە', 'بیوەستێنە',
  'ڕاوەستە', 'پێویست ناکات', 'پێویستمان نییە', 'پێویستم نییە', 'مەیکە', 'لێی گەڕێ', 'وازی لێ بێنە'];
/**
 * ADR-251 (friction 1): a cancel that names what it cancels: the verb with a whole-request object ("cancel
 * it", "don't make the poster"), a description ("the one I sent this morning"), or a verb said of "it"
 * ("it's not needed"). Sorani words that carry their object: all of `CANCEL_CKB` but "stop" and "no need".
 */
const CANCEL_EN_NAMED = new RegExp(`^(?:(?:just|kindly)\\s+)?${CANCEL_VERB}\\s+${CANCEL_OBJECT}${CANCEL_POLITE}`, 'iu');
const CANCEL_SAID_OF_IT = /^(?:(?:just|kindly)\s+)?(?:it'?s|it\s+is)\s/iu;
/** Sorani: stop, no need. */
const CANCEL_CKB_BARE = ['ڕاوەستە', 'پێویست ناکات'];
const CANCEL_CKB_NAMED = CANCEL_CKB.filter((p) => !CANCEL_CKB_BARE.includes(p));

/** A temporary stop of the design, never a quoted instruction or a pause of a design element. */
export function readsAsHold(text: string): boolean {
  const t = corePhrase(text);
  if (!t || t.length > 500) return false;
  // Pronouns must name the whole job, not a design element ("hold this button", "pause it animation").
  const wholeJobTail = '(?=$|[\\s,.!:-]+(?:please\\b|for\\s+now\\b|until\\b|while\\b|because\\b|we\\b|i\\b)|[,.!:-])';
  return /^(?:(?:wait|hold\s+on|hang\s+on)[\s,.!:-]+)?(?:don['’]?t|do\s+not)\s+(?:make|start|continue|proceed\s+with)\s+(?:it|them|this|that|(?:the|these|those)\s+(?:designs?|posters?|drafts?))\s+(?:yet|for\s+now)\b/i.test(t) ||
    new RegExp('^(?:hold|pause)\\s+(?:it|them|this|that|(?:the|these|those)\\s+(?:designs?|posters?|drafts?))' + wholeJobTail, 'i').test(t) ||
    new RegExp('^put\\s+(?:it|them|this|that|(?:the|these|those)\\s+(?:designs?|posters?|drafts?))\\s+on\\s+hold' + wholeJobTail, 'i').test(t) ||
    // ADR-251 (friction 10): a bare "wait" / "hold on" asks for a moment and pauses nothing (`ASKS_FOR_A_MOMENT`);
    // a bare Sorani "stop" is a cancel that names nothing, and is asked about.
    /^ڕایبگرە(?:[\s،,.!]|$)/u.test(t) || /^ڕاوەستە[\s،,]+[^\s،,.!]/u.test(t);
}

/**
 * ADR-251 (bug hunt 2, friction 10): "wait", "hold on", "one moment" said alone ask the bot for a moment,
 * usually before more words. They pause nothing; the requester's design goes on.
 */
const ASKS_FOR_A_MOMENT = /^(?:wait|hold\s+on|hang\s+on|one\s+(?:moment|minute|min|sec(?:ond)?)|just\s+a\s+(?:moment|minute|min|sec(?:ond)?)|a\s+moment)(?:\s+(?:wait|please))*[\s!.…]*$/iu;

const STATUS_EN: RegExp[] = [
  /^(?:so\s+)?when\s+(?:will|would|can|could|is|are|do|does|should|shall)\b[^?]*\b(?:ready|done|finish(?:ed)?|complete(?:d)?|be\s+sent|be\s+delivered|arrive|get\s+(?:it|them|the\s+\p{L}+)|receive|see\s+(?:it|them|the\s+\p{L}+)|have\s+(?:it|them|the\s+\p{L}+))\b/iu,
  /^when\s*\?+$/i,
  /^how\s+(?:long|soon|much\s+longer)\b/i,
  /^(?:any|some)\s+(?:update|news|progress|word)s?\b/i,
  /^(?:what'?s|what\s+is)\s+(?:the\s+)?(?:status|update|progress|eta|news)\b/i,
  /^(?:status|eta|update)\s*\??$/i,
  /^(?:is|are)\s+(?:it|they|the\s+\p{L}+(?:\s+\p{L}+)?|my\s+\p{L}+|our\s+\p{L}+)\s+(?:ready|done|finished|complete|coming|on\s+(?:its|the)\s+way|sent)(?:\s+yet)?\b/iu,
  /^how'?s\s+(?:it|the\s+\p{L}+|my\s+\p{L}+|our\s+\p{L}+)(?:\s+(?:going|coming(?:\s+along)?))?\s*\??$/iu,
  /^how\s+is\s+(?:it|the\s+\p{L}+|my\s+\p{L}+|our\s+\p{L}+)\s+(?:going|coming(?:\s+along)?)\b/iu,
  /^(?:where\s+is|where'?s)\s+(?:it|my|our|the)\b/i,
  /^(?:(?:i'?m|we'?re|we\s+are|i\s+am)\s+)?still\s+waiting\b/i,
  /^(?:did|have)\s+you\s+(?:start(?:ed)?|finish(?:ed)?|made|done)\b/i,
  // ADR-182: "??" and "hello??" after a wait.
  /^[?؟]+$/,
  /^(?:hello|hi|hey|salam|slaw|سڵاو)\s*[?؟]{2,}$/iu,
];
/**
 * ADR-182: "where is my poster" or "why is it taking so long" anywhere in a frustrated message ("this
 * is useless, where is my poster???"), unless the message also asks for a change.
 */
const STATUS_ANYWHERE_EN: RegExp[] = [
  /\bwhere\s+(?:is|are|'s)\s+(?:my|our|the)\s+\p{L}+/iu,
  /\b(?:taking|takes|take|took)\s+(?:so|too|this|that)\s+long\b/i,
  /\bstill\s+(?:not\s+(?:ready|done|here|finished)|nothing|no\s+(?:news|poster|design|reply))\b/i,
];
/** Sorani: "when" with ready / done / arrives / you send; any news; what happened; is it ready / done. */
const STATUS_CKB_WHEN = 'کەی';
const STATUS_CKB_WITH = ['ئامادە', 'تەواو', 'دەگات', 'دەنێرن', 'دەنێریت', 'دەینێرن', 'دەینێریت'];
const STATUS_CKB = ['هیچ هەواڵێک', 'چی بوو', 'گەیشتە کوێ', 'ئامادەیە', 'ئامادە بوو', 'تەواو بوو'];

const DEADLINE_WHEN = /\b(?:by|before|until|no\s+later\s+than|for)\s+(?:tomorrow|tonight|today|this\s+(?:morning|afternoon|evening|week(?:end)?)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|noon|midday|midnight|the\s+(?:morning|afternoon|evening|weekend|end\s+of\s+(?:the\s+)?(?:day|week))|\d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\p{L}*)\b/iu;
const DEADLINE_NEED = /\b(?:need(?:ed|s)?|want(?:ed)?|must|has\s+to|have\s+to|should|required|due|deadline|ready|done|urgent|(?:have|get)\s+(?:it|them))\b/i;
const URGENT = /^(?:(?:it'?s|this\s+is|very|quite|really|super)\s+)*(?:urgent(?:ly)?|asap|as\s+soon\s+as\s+possible|high\s+priority|a\s+rush(?:\s+job)?|rush(?:\s+(?:it|job))?|we\s+are\s+in\s+a\s+hurry|hurry(?:\s+up)?)(?:\s+please)?[\s!.]*$/i;
/** Sorani: by tomorrow, by today, before tomorrow, by the evening, urgent, it is urgent, we are in a hurry. */
const DEADLINE_CKB = ['تا سبەی', 'تا ئەمڕۆ', 'پێش سبەی', 'تا ئێوارە', 'بەپەلە', 'پەلەیە', 'زۆر پەلەمانە'];
/**
 * ADR-182: a Sorani day in words: a weekday (Saturday … Friday, "-ی" joins it to what follows),
 * tomorrow, today, next week, the end of the week.
 */
const DAY_CKB = '(?:ڕۆژی\\s+)?(?:(?:یەک|دوو|سێ|چوار|پێنج)?شەممە|هەینی|سبەی|ئەمڕۆ|هەفتەی\\s+داهاتوو|کۆتایی\\s+هەفتە)';
/** "by / before / until" a day ("تا پێنجشەممەی داهاتوو", by next Thursday). */
const DEADLINE_BY_CKB = new RegExp(`(?:^|\\s)(?:تا|هەتا|پێش)\\s+${DAY_CKB}`, 'u');
/** A day with "we need it", "it is needed", "it must be ready" ("پێنجشەممە پێویستمانە", we need it Thursday). */
const DEADLINE_DAY_CKB = new RegExp(DAY_CKB, 'u');
const DEADLINE_NEED_CKB = /پێویست|دەمانەوێت|دەمەوێت|ئامادە\s*بێت|ئامادەی\s+بکە|تەواو\s*بێت/u;

/** Corrections and additions to a design ("the date should be 5 October not 4", "also add our logo"). */
const CORRECTION_EN: RegExp[] = [
  /\b(?:should|must|needs?\s+to|has\s+to|have\s+to)\s+(?:be|say|read|show)\b/i,
  /\b(?:is|are|was|were)\s+(?:wrong|incorrect|misspelled|a\s+typo)\b/i,
  /\b(?:typo|mistake|misspell\p{L}*|wrong|incorrect)\b/iu,
  /\binstead\s+of\b/i,
  /\bnot\s+\d/i,
  /\bcorrection\b/i,
  /\b(?:also|and|please|can\s+you|could\s+you|would\s+you)\s+(?:add|include|put|remove|delete|drop|change|use|write|mention|insert|make|move|fix|replace)\b/i,
  /^(?:add|include|put|remove|delete|insert|write|mention|use|replace|swap|change|fix|move|resize|make|increase|decrease|enlarge|shrink)\b/i,
  /\b(?:bigger|smaller|larger|darker|lighter|brighter|bolder|thinner|wider|narrower|higher|lower)\b/i,
  /^(?:the\s+)?(?:date|time|day|venue|place|location|address|phone(?:\s+number)?|number|name|title|price|hall|hotel|email|website|logo|colou?r|font)\s+(?:is|are|will\s+be|has\s+changed|changed|now)\b/i,
];
/** Sorani: change, change it, add, add it, remove, remove it, is wrong, wrong, bigger, smaller, instead of,
 * put, write, make it into, darker, lighter, edit, fix, correct it. */
const CORRECTION_CKB = ['بگۆڕە', 'بیگۆڕە', 'زیاد بکە', 'زیادی بکە', 'لاببە', 'لایبە', 'هەڵەیە', 'هەڵە',
  'گەورەتر', 'بچووکتر', 'لە جیاتی', 'دابنێ', 'بنووسە', 'بکە بە', 'تۆختر', 'کاڵتر', 'دەستکاری', 'چاک بکە',
  'ڕاست بکەرەوە'];

/** A design the requester asks to have made: "a poster", "another flyer", "پۆستەرێک" (a poster). */
const DESIGN_NOUNS = 'poster|flyer|banner|design|invitation|invite|card|post|story|brochure|certificate|announcement|graphic|cover|ad|advert|leaflet|infographic|thumbnail';
const NEW_DESIGN_EN = new RegExp(
  `\\b(?:a|an|another|new|one\\s+more|two|three|some|\\d+)\\s+(?:[\\p{L}\\d'-]+\\s+){0,3}?(?:${DESIGN_NOUNS})s?\\b`, 'iu');
const OPENS_WITH_DESIGN = new RegExp(`^(?:${DESIGN_NOUNS})s?\\s+(?:for|about|of|announcing|to\\s+announce)\\b`, 'i');
const ASKS_TO_MAKE_EN = /\b(?:can|could|would|will)\s+(?:you|u|we)\b|\b(?:make|create|design|prepare|produce|draw|do)\b|\b(?:i|we)\s+(?:need|want|would\s+like|'d\s+like)\b|\bneed\s+(?:a|an)\b|\bplease\b/i;
/** Sorani design nouns with the indefinite ending "-ێک" (a …) or "نوێ" (new). */
const NEW_DESIGN_CKB = /(?:پۆستەر|دیزاین|بانەر|فلایەر|بانگهێشت|کارت|پۆست|بڕوانامە|ستۆری)(?:ێک|ی\s+نوێ|\s+نوێ|ێکی\s+نوێ)/u;
/** Sorani: make, make (plural), prepare, design, we want, I want, we need, make for us. */
const ASKS_TO_MAKE_CKB = ['دروست بکە', 'دروستبکە', 'دروست بکەن', 'ئامادە بکە', 'دیزاین بکە', 'دەمانەوێت',
  'دەمەوێت', 'پێویستمان', 'بۆمان بکە', 'بکەن', 'بکە'];

/**
 * ADR-182: a question about price or time that names a design ("how much does a poster cost?", Sorani
 * "how much is a poster?") asks the office something; it is not a request to make one.
 */
const PRICE_EN = /\b(?:how\s+much|prices?|costs?|charges?|fees?)\b/i;
const PRICE_CKB = /(?:نرخ|چەندە|بە\s*چەند|چەند\s+دەکات|چەندی\s+تێ)/u;
const MAKE_EN = /\b(?:make|create|design|prepare|produce|draw)\s+(?:a|an|me|us|one|two|three|\d+)\b/i;
const MAKE_CKB = ['دروست بکە', 'دروستبکە', 'دروست بکەن', 'ئامادە بکە', 'دیزاین بکە', 'بۆمان بکە'];
function asksAboutPrice(t: string): boolean {
  return /[?؟]\s*$/.test(t) && (PRICE_EN.test(t) || PRICE_CKB.test(t)) && !MAKE_EN.test(t) && !any(t, MAKE_CKB);
}

/** A request for a new design ("Can you make a poster for Nawroz?"), greeting or not. */
export function asksForNewDesign(text: string): boolean {
  const t = clean(text);
  if (asksAboutPrice(t)) return false;
  if (NEW_DESIGN_CKB.test(t) && (any(t, ASKS_TO_MAKE_CKB) || t.length <= 200)) return true;
  if (OPENS_WITH_DESIGN.test(corePhrase(t))) return true;
  return NEW_DESIGN_EN.test(t) && ASKS_TO_MAKE_EN.test(t);
}

/** Words that ask for a change to a design ("make the title bigger", "the date is wrong"). */
export function readsAsChange(text: string): boolean {
  const t = corePhrase(text);
  if (!t) return false;
  // "What fonts can you use?" asks about the office, not for a change.
  if (/^(?:what|which|how|who|where|when|why)\b[^\n]*\?\s*$/i.test(t) &&
      !/\b(?:wrong|typo|mistake|incorrect|should\s+be)\b/i.test(t)) return false;
  if (CORRECTION_EN.some((p) => p.test(t)) || any(t, CORRECTION_CKB)) return true;
  // The heuristics' own revision reading, as when a design is known to be active.
  if (classifyWithHeuristics(t, true, false).kind === 'feedback') return true;
  return t.length <= 200 && CHANGE_CUES.some((cue) => containsKeyword(t, cue)) &&
    /\b(?:make|use|put|change|add|remove|move|replace|swap|fix|resize|instead)\b/i.test(t);
}

function readsAsApproval(text: string, core: string): boolean {
  if (core.length > 160 || !any(core, APPROVAL_PHRASES) || refusesApproval(core)) return false;
  let rest = core;
  for (const phrase of APPROVAL_PHRASES) rest = rest.replace(new RegExp(phrase.replace(/\s+/g, '\\s+'), 'giu'), ' ');
  rest = rest.replace(PRAISE, ' ').replace(/[\s,،!.:;-]+/g, ' ').trim();
  return !readsAsChange(rest) && !asksForNewDesign(text);
}

/**
 * ADR-182: words said around a cancellation, each its own clause: "never mind, cancel it", "no, stop",
 * "no need anymore, thanks", "ok forget it, sorry". Sorani: sorry, no, OK, thanks.
 */
const CANCEL_FILLER = /^(?:ok(?:ay)?|no|nope|sorry|thanks?|thank\s+you|please|actually|well|sadly|unfortunately|hm+|ببورە|نا|نەخێر|باشە|سوپاس|تکایە)$/iu;
/**
 * ADR-230 addendum (live 2026-10-01 16:08Z, L17): why the requester cancels, said after it ("cancel the
 * Teacher Appreciation Day poster, it was only a test"): a test, a mistake, the event moved or called
 * off, plans changed, not needed any more. A closed list: a clause that asks for a change is not one.
 * ADR-239 follow-up: "it was by mistake" and "I sent it by mistake" are mistakes too.
 */
const CANCEL_REASON = new RegExp('^(?:(?:because|since|cause|cos)\\s+)?(?:sorry\\s+)?(?:' + [
  "(?:it|this|that)(?:'s|\\s+(?:was|is))\\s+(?:only\\s+|just\\s+)?(?:a\\s+)?(?:test|trial|mistake|an?\\s+error|error|the\\s+wrong\\s+one|wrong)",
  // ADR-239 follow-up (canary 2026-10-02): "it was by mistake", "I sent it by mistake", "it was sent by accident".
  "(?:(?:it|this|that)(?:'s|\\s+(?:was|is))\\s+|(?:i|we)\\s+)?(?:(?:sent|opened|made|ordered|asked\\s+for)\\s+(?:(?:it|this|that)\\s+)?)?by\\s+(?:mistake|accident)",
  'my\\s+(?:mistake|bad|fault)',
  '(?:only\\s+|just\\s+)?(?:a\\s+)?test(?:ing)?', 'wrong\\s+one',
  "(?:we|i|they)(?:'ve|\\s+have)?\\s+(?:postponed|cancel+ed|moved|delayed|changed|called\\s+off)\\s+(?:it|the\\s+(?:event|date|plans?|meeting|ceremony|party|conference|day))",
  '(?:the\\s+)?(?:event|meeting|ceremony|party|conference|celebration|day)\\s+(?:was|is|has\\s+been|got)\\s+(?:cancel+ed|postponed|called\\s+off|moved|delayed)',
  '(?:the\\s+)?plans?\\s+(?:have\\s+|has\\s+)?changed', "(?:we|i)(?:'ve|\\s+have)?\\s+changed\\s+(?:our|my)\\s+minds?",
  "(?:we|i)\\s+(?:don'?t|do\\s+not|no\\s+longer)\\s+need\\s+(?:it|this|that|them)(?:\\s+any\\s?more)?", "(?:it'?s|it\\s+is)\\s+no\\s+longer\\s+needed",
  'not\\s+needed(?:\\s+any\\s?more)?', 'no\\s+longer\\s+needed',
].join('|') + ')(?:\\s+(?:any\\s?more|sorry|thanks?|thank\\s+you))*$', 'iu');

const cancelClauses = (core: string) =>
  core.split(/\s*[,،;.!:–—]+\s*|\s+-\s+|\s+(?=(?:because|since)\s)/iu).map((c) => c.trim()).filter(Boolean);
const cancelsClause = (c: string) => CANCEL_EN.test(c) || CANCEL_DESCRIBED.test(c) || (isSoraniText(c) && c.split(/\s+/).length <= 4 && any(c, CANCEL_CKB));

function readsAsCancel(core: string): boolean {
  if (!core || core.length > 160) return false;
  if (cancelsClause(core)) return true;
  // Several clauses: one of them cancels, and the rest only surround it, or say why (ADR-230 addendum, L17).
  const clauses = cancelClauses(core);
  if (clauses.length < 2) return false;
  return clauses.some(cancelsClause) && clauses.every((c) => cancelsClause(c) || CANCEL_FILLER.test(c) || CANCEL_REASON.test(c));
}

/**
 * ADR-251 (friction 1): whether a cancel names nothing it cancels: no clause of it has a whole-request
 * object or a description ("never mind", "ok never mind", "no, stop", "no need anymore"; Sorani "stop",
 * "no need"). Such words withdrew the chat's only design unasked; they are asked about first.
 */
export function cancelNamesNothing(core: string): boolean {
  const names = (c: string) => CANCEL_DESCRIBED.test(c) || CANCEL_EN_NAMED.test(c) || (CANCEL_SAID_OF_IT.test(c) && CANCEL_EN.test(c)) ||
    (isSoraniText(c) && any(c, CANCEL_CKB_NAMED));
  return ![core, ...cancelClauses(core)].some(names);
}

function readsAsStatus(core: string): boolean {
  if (!core || core.length > 140) return false;
  if (STATUS_EN.some((p) => p.test(core))) return !asksForNewDesign(core);
  if (STATUS_ANYWHERE_EN.some((p) => p.test(core))) return !asksForNewDesign(core) && !readsAsChange(core);
  if (!isSoraniText(core) || core.length > 80) return false;
  return (containsKeyword(core, STATUS_CKB_WHEN) && any(core, STATUS_CKB_WITH)) || any(core, STATUS_CKB);
}

/** A date or a time of day ("5 October", "October 5", "7pm", "19:30"). */
const DATE_OR_TIME_EN = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\p{L}*|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\p{L}*\s+\d{1,2}\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/iu;
/**
 * ADR-182: a date or a time in Sorani, in either kind of digit: a day of a month by its Iraqi or its
 * Kurdish name ("١٢ی تشرینی یەکەم", 12 October; "٢٠ی ئازار", 20 March), a date written with slashes
 * ("١٢/١٠/٢٠٢٦"), or an hour ("کاتژمێر ٥", five o'clock).
 */
const MONTHS_CKB = 'کانوونی\\s+(?:دووەم|یەکەم)|شوبات|ئازار|نیسان|ئایار|حوزەیران|تەمموز|ئاب|ئەیلوول|تشرینی\\s+(?:یەکەم|دووەم)|' +
  'خاکەلێوە|گوڵان|جۆزەردان|پووشپەڕ|گەلاوێژ|خەرمانان|ڕەزبەر|گەڵاڕێزان|سەرماوەز|بەفرانبار|ڕێبەندان|ڕەشەمە';
const DATE_OR_TIME_CKB = new RegExp(`[\\d٠-٩۰-۹]{1,2}\\s*ی?\\s*(?:${MONTHS_CKB})|[\\d٠-٩۰-۹]{1,2}\\s*/\\s*[\\d٠-٩۰-۹]{1,2}(?:\\s*/\\s*[\\d٠-٩۰-۹]{2,4})?|کاتژمێر\\s*[\\d٠-٩۰-۹]{1,2}`, 'u');
const DATE_OR_TIME = { test: (text: string) => DATE_OR_TIME_EN.test(text) || DATE_OR_TIME_CKB.test(text) };
/**
 * Words that name an event or its details, in English and Sorani (day, time, place, hall, invitation,
 * seminar, conference, celebration, festival; ADR-182: graduation, hotel, park, meeting, exhibition).
 */
const EVENT_WORDS = /\b(?:date|time|venue|location|hall|auditorium|hotel|stadium|campus|rsvp|cordially|invitation|ceremony|conference|seminar|workshop|party|dinner|meeting|graduation|wedding|festival|celebration|exhibition|fair|concert|launch|tournament|forum|summit|symposium|lecture|open\s+day)\b|(?:ڕۆژ|کات|شوێن|هۆڵ|بانگهێشت|سیمینار|کۆنفرانس|ئاهەنگ|فێستیڤاڵ|دەرچوون|هۆتێل|پارک|کۆبوونەوە|پێشانگا|نەورۆز)/giu;

/**
 * ADR-156 (audit #15): a deadline said beside the event's own copy ("Invitation card for the graduation
 * ceremony at the hotel, 5 October 7pm, needed by Thursday") is a brief with a deadline, not only a
 * deadline. Without the words that give the deadline, the rest still names the event and a date or a
 * time, or several event details.
 */
export function carriesBriefCopy(core: string): boolean {
  const rest = core.replace(DEADLINE_WHEN, ' ')
    .replace(/\b(?:needed|need(?:s|ed)?\s+(?:it|them)|required|due|urgent(?:ly)?|asap)\b/gi, ' ');
  const events = rest.match(EVENT_WORDS)?.length ?? 0;
  const words = rest.split(/\s+/).filter(Boolean).length;
  if (DATE_OR_TIME.test(rest) && (events > 0 || new RegExp(`\\b(?:${DESIGN_NOUNS})s?\\b`, 'i').test(rest))) return true;
  return events >= 2 && words >= 10;
}

function readsAsDeadline(text: string, core: string): boolean {
  if (!core || core.length > 160 || asksForNewDesign(text) || carriesBriefCopy(core)) return false;
  if (URGENT.test(core)) return true;
  if (DEADLINE_WHEN.test(core) && DEADLINE_NEED.test(core)) return true;
  if (/^(?:by|before)\s+/i.test(core) && DEADLINE_WHEN.test(core)) return true;
  if (!isSoraniText(core) || core.length > 100) return false;
  return any(core, DEADLINE_CKB) || DEADLINE_BY_CKB.test(core) || (DEADLINE_DAY_CKB.test(core) && DEADLINE_NEED_CKB.test(core));
}

/**
 * ADR-200 addendum: a line that names no design: redo words, words about quality ("make me a nice
 * poster"), chat, or a question. A request opened from such words is never named with them (the
 * incident's request was "do a better design thats similar to earlier o…"): it is named neutrally
 * (`neutralRequestTitle`), and the words stay its instructions. A line with copy, a date, an event, a
 * subject ("for the graduation") or a name ("KAAE", "Nawroz") names its design.
 */
const QUALITY_EN = /\b(?:better|nicer|nice|beautiful|good|great|professional|modern|attractive|elegant|improve\w*|again|similar)\b/i;
const QUALITY_CKB = /(?:باشتر|جوانتر|جوان|باش|دووبارە|هاوشێوە)/u;
const A_NAME = /(?<!^)\b[A-Z]\p{L}+|\b[A-Z]{2,}\b|\d/u;
export function isWeakBriefLine(line: string): boolean {
  const t = corePhrase(String(line ?? ''));
  if (!t) return true;
  if (readsAsRedo(t, t)) return true;
  if (carriesBriefCopy(t) || DATE_OR_TIME.test(t) || (t.match(EVENT_WORDS)?.length ?? 0) > 0 ||
      OWN_SUBJECT_EN.test(t) || OWN_SUBJECT_CKB.test(t) || A_NAME.test(t)) return false;
  if (/[?؟]\s*$/u.test(t)) return true;
  const quality = QUALITY_EN.test(t) || QUALITY_CKB.test(t);
  if (new RegExp(`\\b(?:${DESIGN_NOUNS})s?\\b`, 'i').test(t) || NEW_DESIGN_CKB.test(t)) return quality;
  const reading = readIntentByRules(t).intent;
  return quality || ['acknowledgement', 'conversation', 'status', 'approval', 'cancel', 'hold'].includes(reading);
}

const FULL_BRIEF_REASON = 'Complete design brief with structured copy and event details detected';
const EXPLICIT_NEW = /\b(?:new\s+(?:poster|design|flyer|banner|brief|invitation|one|request)|another\s+(?:poster|design|event|flyer|banner|one|invitation))\b|(?:دیزاینێکی\s+نوێ|پۆستەری\s+نوێ|داواکارییەکی\s+نوێ)/iu;

/**
 * ADR-200 addendum (incident 2026-10-01 12:33Z): words that ask for a design again, better, or another
 * version of it. The owner had been sent the final K-12 Pilot Study design four hours before and wrote
 * "do a better design thats similar to earlier ones"; "a … design" read as a new brief, and a designer
 * was given a request named with that sentence.
 */
const REDO_EN: RegExp[] = [
  // redo it, re-do, redesign it, remake it, rework it, start over, start again
  /\b(?:re-?do|re-?design|re-?make|re-?work)\b|\bstart\s+(?:it\s+)?(?:over|again|from\s+scratch)\b/i,
  // do it again, make it again, try again, design it once more
  /\b(?:do|make|try|design|create|prepare)\s+(?:(?:it|this|that|them|one|the\s+(?:design|poster|flyer|banner))\s+)?(?:again|once\s+more|one\s+more\s+time)\b/i,
  // another try, one more attempt, give it another go
  /\b(?:another|one\s+more|a\s+second|a\s+new)\s+(?:try|attempt|go|shot)\b/i,
  // make it better, make it look nicer, do (it) better, improve it
  /\b(?:make|do|get)\s+(?:it|this|that|them)\s+(?:look\s+)?(?:better|nicer|more\s+(?:beautiful|professional|attractive|appealing|elegant|modern))\b|\bdo\s+(?:it\s+)?better\b|\bimprove\s+(?:it|this|that|on\s+it|the\s+(?:design|poster))\b/i,
  // a better design, a nicer one, an improved version
  new RegExp(`\\b(?:a|an|another|one\\s+more|some)\\s+(?:better|nicer|improved|more\\s+(?:beautiful|professional|attractive|modern))\\s+(?:version|take|option|variation|one|${DESIGN_NOUNS})s?\\b`, 'i'),
  // another version, a different version, a new take
  /\b(?:another|new|different|second|better|improved|alternative)\s+(?:version|variation|take)s?\b/i,
];
/**
 * Sorani: make it again / redo it (several spellings), make it better / nicer, a better design / poster
 * / version, another or a new version, try once more, make it once more, start again from the beginning.
 */
const REDO_CKB: RegExp[] = [
  /دووبارە\s*(?:ی\s*)?(?:بیکەرەوە|بکەرەوە|بیکەنەوە|بکەنەوە|(?:دروست|دیزاین|ئامادە)\s*(?:ی\s*)?(?:بکەرەوە|بکەنەوە))/u,
  /(?:باشتر|جوانتر)(?:ی)?\s*(?:بکە|بکەن|بیکە|بیکەن|دروست\s*بکە)(?![\p{L}\p{M}])/u,
  /(?:دیزاینێکی|پۆستەرێکی|وەشانێکی|دانەیەکی)\s+(?:باشتر|جوانتر)/u,
  /وەشانێکی\s+(?:تر|دیکە|نوێ)/u,
  /(?:هەوڵێکی|جارێکی)\s+(?:تر|دیکە)\s+(?:بدە|بدەرەوە|هەوڵ\s*بدە|دروستی?\s*بکە|بیکە|بکەرەوە)/u,
  /لە\s*سەرەتاوە\s+(?:دەست\s*پێ\s*بکەرەوە|دروستی\s*بکەرەوە)/u,
];
/** "similar to the earlier ones", "like the previous designs", "like before"; Sorani "like the previous ones". */
const SIMILAR_EN = /\b(?:similar\s+to|(?<!\b(?:i|we|you|they|really|do|don'?t|did|didn'?t)\s)like|same\s+(?:style|look|feel)\s+as|in\s+the\s+(?:same\s+)?style\s+of|matching)\s+(?:the\s+|my\s+|our\s+|your\s+)?(?:earlier|previous|past|older|old|last|other|before)(?:\s+(?:ones?|designs?|posters?|works?|times?))?\b|(?<!\b(?:i|we|you|they|really|do|don'?t|did|didn'?t)\s)\blike\s+(?:before|last\s+time|you\s+did\s+before)\b/i;
const SIMILAR_CKB = /(?:وەک|هاوشێوەی|لە\s+شێوەی|بە\s+شێوەی)\s+(?:ئەوانەی\s+|ئەوەی\s+|دیزاینەکانی\s+)?(?:پێشوو|پێشتر|جاران|کۆن)/u;
/** "don't redo it", "no need to try again"; Sorani "don't redo it", "no need". */
const NOT_REDO = /\b(?:don'?t|do\s+not|no\s+need\s+to|never|stop)\s+(?:re-?do|re-?design|re-?make|try(?:ing)?\s+again|do(?:ing)?\s+it\s+again|mak(?:e|ing)\s+(?:it|another)|chang)/i;
const NOT_REDO_CKB = /مەیکەرەوە|دووبارەی\s+مەکەرەوە|پێویست\s+ناکات/u;
/**
 * A subject of the words' own: "for the conference", "about Nawroz", Sorani "for the conference". It may
 * be a new design, so the requester is asked. "for me", "for printing", "for now" name none.
 */
const OWN_SUBJECT_EN = /\b(?:for|about|announcing|to\s+announce|celebrating)\s+(?:the\s+|our\s+|my\s+|a\s+|an\s+)?(?!(?:me|us|it|this|that|them|now|today|tomorrow|tonight|once|real|sure|free|print(?:ing)?|instagram|facebook|social\s+media|the\s+same)\b)\p{L}/iu;
const OWN_SUBJECT_CKB = /(?:^|\s)بۆ\s+(?!(?:من|ئێمە|ئەمە|ئەوە|ئێستا|چاپ)(?:\s|$))\S/u;

/**
 * Whether the words ask to redo a design: 'redo' (the most recent), 'or-new' (or a new design), or
 * null. Words with copy, a date or a time, or that ask about status, cancel, hold, or the files, are
 * not; neither is a redo said no to ("don't redo it").
 */
export function readsAsRedo(text: string, core = corePhrase(text)): 'redo' | 'or-new' | null {
  if (!core || core.length > 300 || core.split(/\s+/).length > 40) return null;
  if (NOT_REDO.test(core) || NOT_REDO_CKB.test(core)) return null;
  if (carriesBriefCopy(core) || DATE_OR_TIME.test(core)) return null;
  if (readsAsStatus(core) || readsAsCancel(core) || readsAsHold(core) || readsAsDeliveryRequest(text, core)) return null;
  const redo = REDO_EN.some((p) => p.test(core)) || REDO_CKB.some((p) => p.test(core));
  const similar = SIMILAR_EN.test(core) || SIMILAR_CKB.test(core);
  if (!redo && !similar) return null;
  const ownSubject = OWN_SUBJECT_EN.test(core) || OWN_SUBJECT_CKB.test(core) || EXPLICIT_NEW.test(core) ||
    (core.match(EVENT_WORDS)?.length ?? 0) > 0;
  if (redo) return ownSubject ? 'or-new' : 'redo';
  // "Similar to the earlier ones" alone is the latest design again, in that style; a design asked for
  // with it ("a poster like the previous ones") may be a new one in that style; one with a subject of
  // its own ("a poster for Nawroz like the previous ones") is a new brief with a note on style.
  if (ownSubject) return null;
  return NEW_DESIGN_EN.test(core) || NEW_DESIGN_CKB.test(core) ? 'or-new' : 'redo';
}

/**
 * The rules' reading of a message, without context. Order matters: approval and thanks before
 * anything that could start work; cancel, status and deadline before a change; a request for a new
 * design before a change ("can you make a poster" is new, "can you make the poster brighter" is not).
 */
export function readIntentByRules(text: string, options: { redo?: boolean } = {}): IntentReading {
  const t = clean(text);
  const core = corePhrase(t);
  const rules = (intent: TurnIntent, reason: string, extra: Partial<IntentReading> = {}): IntentReading =>
    ({ intent, reason, source: 'rules', ...extra });
  if (!t) return rules('conversation', 'No words');
  if (t.startsWith('/')) return rules('conversation', 'A chat command');
  // ADR-252 (friction 7): "sorry I cancelled by mistake, please continue" takes back a cancel. It is the
  // conversation's to answer honestly (lifecycle-chat-answers.ts), never a change of another open design.
  if (asksToUndoCancel(core)) return rules('conversation', 'Takes back a cancel');
  // ADR-200 addendum: "do a better design", "not good, do it again", "try again" ask for the latest
  // design again. Read before a refusal ("not good") or a new brief ("a … design"); words sent with a
  // photo or an album are material, and are read as before (`redo: false`).
  const redo = options.redo === false ? null : readsAsRedo(t, core);
  if (redo === 'redo') return rules('change', 'Asks to redo the most recent design', { redo });
  if (redo === 'or-new') return rules('unclear', 'Asks to redo a design, or for a new one', { redo, instructionOnly: true });
  // ADR-040 addendum (2026-10-01): "not approved", "don't send it" are never happiness, nor a request
  // for the files ("don't send it again"): the requester is not happy, and what else they say is the change.
  if (refusesApproval(core) && !asksForNewDesign(t)) {
    return saysMoreThanRefusal(core) ? rules('change', 'Refuses the draft and says what to change')
      : rules('change', 'Refuses the draft; the office hears the requester is not happy', { refusalOnly: true });
  }
  if (readsAsDeliveryRequest(t, core)) return rules('delivery_request', 'Asks the office about the files (again, a format, an email, a resolution)');
  if (readsAsApproval(t, core)) return rules('approval', 'Approval words; the office decides');
  if (isAcknowledgement(t) || (core && isAcknowledgement(core) && core.length <= 60)) return rules('acknowledgement', 'Thanks, an OK or a receipt');
  // ADR-251 (friction 10): "wait", "hold on" alone ask for a moment; nothing is paused.
  if (ASKS_FOR_A_MOMENT.test(core)) return rules('acknowledgement', 'Asks for a moment; nothing is paused');
  if (readsAsHold(core)) return rules('hold', 'Asks to pause the current design');
  if (readsAsCancel(core)) {
    return rules('cancel', 'Asks to cancel or stop', cancelNamesNothing(core) ? { bareCancel: true } : {});
  }
  // ADR-230 addendum (L12): cancel words about a whole request that the patterns cannot place are never
  // read as a certain change of the latest design; they are unclear, and the intake router reads them
  // (ADR-144's one call per update, within the allowance) before anything is kept or asked.
  if (core.length <= 160 && CANCEL_SOMEWHERE.test(core) && !readsAsHold(core)) return rules('unclear', 'Cancel words the rules cannot place', { instructionOnly: true, cancelWords: true });
  if (readsAsStatus(core)) return rules('status', 'Asks how a design is going');
  if (readsAsDeadline(t, core)) return rules('deadline', 'Gives a deadline or urgency');

  const heuristics = classifyWithHeuristics(t, false, false);
  // "From now on, always put the logo bottom-right": a rule for later designs (lifecycle-chat-answers.ts).
  if (heuristics.kind === 'standing_rule') return rules('conversation', 'A lasting preference');
  const words = t.split(/\s+/).filter(Boolean).length;
  const fullBrief = heuristics.kind === 'new_brief' && heuristics.reason === FULL_BRIEF_REASON;
  const eventWords = /\b(date|time|venue|location|hall|auditorium|hotel|rsvp|cordially|invitation|ceremony|conference|seminar|workshop|party|dinner|meeting)\b/i.test(t) ||
    /(ڕۆژ|کات|شوێن|هۆڵ|بانگهێشت|سیمینار|کۆنفرانس)/u.test(t);
  const substantial = fullBrief || words >= 20 || (eventWords && words >= 8) || t.split(/\n\s*\n/).length >= 2;
  const designRequest = asksForNewDesign(t);
  const explicitNew = EXPLICIT_NEW.test(t) || designRequest;
  if (explicitNew) {
    // ADR-182: a short request that names the event with its date or time ("Another poster please: KAAE
    // staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium") carries its copy,
    // and is drafted as a longer one is, instead of going to a designer by hand.
    const complete = substantial || (words >= 6 && carriesBriefCopy(core));
    return rules('new_brief', designRequest ? 'Asks for a new design' : 'Said to be a new design', {
      explicitNew: true, substantial: complete,
      instructionOnly: heuristics.kind !== 'new_brief' || heuristics.isInstructionOnly === true || (!complete && !fullBrief),
    });
  }
  // ADR-231 (live 2026-10-01 14:03Z): "can you also make videos?" asks what the office makes. It is the
  // office's question to answer, never a change kept on a design (that one held Deliver until read).
  if (!fullBrief && asksWhatTheOfficeMakes(core)) return rules('conversation', 'Asks what the office makes', { question: true });
  if (!fullBrief && readsAsChange(t)) return rules('change', 'Asks for a change or a correction');
  // ADR-182: "how much is a poster?" names a design but asks a question the office answers.
  if (!fullBrief && !substantial && isPlainQuestion(core)) return rules('conversation', 'A question', { question: true });
  if (heuristics.kind === 'new_brief') {
    return rules(substantial ? 'new_brief' : 'unclear', substantial ? 'Carries copy or event detail'
      : 'A short message that could be a new brief or a note about a current design',
    { substantial, instructionOnly: heuristics.isInstructionOnly === true });
  }
  if (heuristics.kind === 'feedback') return rules('change', 'Asks for a change or a correction');
  // ADR-156 (audit #15): event copy with a deadline beside it is a brief, even where the heuristics
  // read it as chat ("Invitation card for the graduation ceremony …, 5 October 7pm, needed by Thursday").
  if (substantial && carriesBriefCopy(core)) {
    return rules('new_brief', 'Carries event copy and a date', { substantial: true, instructionOnly: false });
  }
  return rules('conversation', heuristics.reason,
    heuristics.kind === 'question' || isPlainQuestion(core) ? { question: true } : {});
}

/**
 * ADR-182: a message that goes on with a brief its sender is still sending (the brief is held a few
 * seconds for photos, ADR-143): people type a brief as several short messages ("Hi, we need a poster
 * for the graduation" / "Date: 12 October at 5 pm" / "Venue: the main hall"), add a line of style
 * ("and use our blue colours"), or send "please make a poster from this" after a forward. Such a
 * message is part of the brief. A message that stands on its own is not: thanks, a question, a status
 * question, a cancellation, another design asked for with its own copy, or a correction of what was
 * just sent ("sorry, the date is the 5th"), which is kept for the office as before.
 */
const REFERS_BACK = /\b(?:from|with|using|of|for|about|on)\s+(?:this|that|these|those|it|the\s+(?:above|message|text|forward(?:ed)?(?:\s+message)?|invitation|details|info(?:rmation)?))\b|\b(?:above|below)\b|(?:لەمە|بەمە|بۆ\s+ئەمە|لەم\s+نامەیە|سەرەوە|خوارەوە)/iu;
const CORRECTION_CUES = /\b(?:sorry|wrong|typo|mistake|incorrect|instead\s+of|not\s+(?:the\s+)?\d|should\s+(?:be|say|read)|actually)\b|(?:ببورە|هەڵە|نەک\b|لە\s+جیاتی)/iu;
const LABELLED_LINE = /^[\p{L}\p{M} ]{2,30}\s*:\s*\S/u;
export function readsAsBriefContinuation(text: string, soFar = ''): boolean {
  const t = clean(text);
  if (!t || t.startsWith('/') || t.length > 4000) return false;
  const reading = readIntentByRules(t);
  if (reading.intent === 'new_brief' && REFERS_BACK.test(t) && !reading.substantial) return true;
  switch (reading.intent) {
    case 'unclear': return true;
    case 'change': case 'deadline': return !CORRECTION_CUES.test(t);
    // Event details ("on 1 March at 10, in the university hall") complete a brief that did not yet
    // give its date or time; after a brief that already did, they are a brief of their own.
    case 'new_brief': return !reading.explicitNew && (!reading.substantial || !DATE_OR_TIME.test(clean(soFar)));
    case 'conversation': return !reading.question && (DATE_OR_TIME.test(t) || LABELLED_LINE.test(t));
    default: return false;
  }
}

/**
 * ADR-182: a question put to the bot ("how much does a poster cost?", "do you have our logo already?",
 * Sorani "how much is a poster?"), not a request for a design, a change or a status. Its answer is the
 * office's.
 */
/**
 * ADR-231: a question about what the office makes or does ("can you also make videos?", "do you design
 * logos?", "could you print banners too?"; Sorani "do you make videos too?"), not about a design of
 * this chat: its object names no design of theirs ("the title", "it", "our poster") and asks for no
 * change ("bigger", "again"). A request for a design ("can you make a poster for Nawroz?") is read as
 * a new brief before this.
 */
const CAPABILITY_EN = /^(?:(?:hi|hello|hey|and|also|so|ok(?:ay)?|please|btw)[\s,!]+)*(?:can|could|do|does|will|would)\s+(?:you|u|you\s+guys|the\s+office|your\s+(?:team|office))\s+(?:also\s+|even\s+|still\s+)?(?:make|do|design|create|produce|edit|print|draw|film|shoot|animate|offer|handle)\s+(?:also\s+)?(?!(?:the|this|that|these|those|it|its|them|my|our|your|his|her|their|one|some|any)\b)([\p{L}\d'’ &/-]{2,40}?)(?:\s+(?:too|as\s+well|also|for\s+(?:us|me)))?\s*[?؟]$/iu;
const CHANGE_WORDS_EN = /\b(?:bigger|smaller|larger|brighter|darker|bolder|lighter|thinner|thicker|wider|narrower|longer|shorter|higher|lower|more|less|again|better|different|changes?|edits?|corrections?)\b/i;
/** Sorani: "do you (also) make / design / prepare …?" in the present tense, about no design of theirs ("…ەکە"). */
const CAPABILITY_CKB = /(?:دروست|دیزاین|ئامادە|چاپ)\s*(?:ی?ش\s*)?دەکەن\s*[؟?]$/u;
export function asksWhatTheOfficeMakes(core: string): boolean {
  const t = clean(core);
  if (!t || t.length > 120 || !/[?؟]\s*$/u.test(t)) return false;
  const m = CAPABILITY_EN.exec(t);
  if (m) return !CHANGE_WORDS_EN.test(m[1]);
  return isSoraniText(t) && CAPABILITY_CKB.test(t) && !/\S+ەکە(?:ی|ت|م|مان|یان)?(?=[\s?؟]|$)/u.test(t) && !/(?:ئەمە|ئەوە|ئەم|ئەو)\s/u.test(t);
}

const QUESTION_START_EN = /^(?:how|what|which|who|whom|whose|where|when|why|do|does|did|is|are|was|were|can|could|would|will|should|may|have|has)\b/i;
const QUESTION_WORD_CKB = /(?:ئایا|چۆن|چییە|چی|کێ|کوێ|کەی|بۆچی|چەند|نرخ)/u;
export function isPlainQuestion(core: string): boolean {
  const t = clean(core);
  if (!t || t.length > 300 || !/[?؟]\s*$/.test(t)) return false;
  return QUESTION_START_EN.test(t) || (isSoraniText(t) && QUESTION_WORD_CKB.test(t));
}

// ---------------------------------------------------------------------------------------------
// Answers to a question this bot asked ("Which design is this for? 1. … 2. …")
// ---------------------------------------------------------------------------------------------

const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
/** Ordinal answers, said on their own ("second", "the 2nd one", "دووەم" second). */
const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1, one: 1, 'یەکەم': 1, 'یەکەمیان': 1,
  second: 2, '2nd': 2, two: 2, 'دووەم': 2, 'دووەمیان': 2,
  third: 3, '3rd': 3, three: 3, 'سێیەم': 3, 'سێیەمیان': 3,
  fourth: 4, '4th': 4, four: 4, 'چوارەم': 4, 'چوارەمیان': 4,
  fifth: 5, '5th': 5, five: 5, 'پێنجەم': 5, 'پێنجەمیان': 5,
};
/** "the", "number", "option", "ئەوەی" (the one that is) before an answer; "one", "design", "please" after it. */
const bareAnswer = (t: string) => t.replace(/^(?:the|number|no\.?|option|#|ئەوەی|ژمارە)\s*/iu, '')
  .replace(/\s+(?:one|design|poster|please|thanks?|تکایە)$/iu, '').replace(/[.!]+$/, '').trim();
/** "new", "a new one", "separate", "نوێ" (new), "تازە" (new). */
const SAYS_NEW = /^(?:(?:a|it'?s\s+a|its\s+a|this\s+is\s+a)\s+)?(?:new|separate|different|another)(?:\s+(?:one|design|request|poster|flyer|brief))?\b|^(?:نوێ|تازە|دیزاینی\s+نوێ|دیزاینێکی\s+نوێ)/iu;
/**
 * "change", "the same", "yes", "that one"; Sorani "yes", "edit", "the same". ADR-251 (friction 2): also
 * "it's a change", "the old one", "the existing one", said after a "no" to "change or new?".
 */
const SAYS_CHANGE = /^(?:(?:it'?s|its|it\s+is|this\s+is)\s+)?(?:(?:a\s+)?change|(?:the\s+)?same(?:\s+one)?|yes|yeah|yep|that\s+one|this\s+one|edit|revise|revision|correction|re-?do|(?:the\s+)?(?:old|existing|current|earlier|previous)(?:\s+(?:one|design|poster|request))?$)\b|^(?:بەڵێ|بەلێ|دەستکاری|هەمان|گۆڕانکاری|دووبارە)/iu;
/**
 * ADR-251 (friction 2): "no" said alone ("no", "nope", Sorani "no"); "no thanks" is "no" once its thanks
 * are taken off (`corePhrase`). Only this, to "Is this a change to …, or a new design?", means new.
 */
const BARE_NO = /^(?:no+|nope|nah|نەخێر|نا)[\s!.]*$/iu;
/** A "no" that leads other words ("no, it's a change", "no it's for Nawroz"): the rest says what is meant. */
const LEADING_NO = /^(?:no|nope|nah|نەخێر|نا)(?![\p{L}\p{N}])[\s,،.!:;-]*/iu;
/**
 * ADR-251 (friction 1): "no" to "Do you want me to cancel …?": "no", "no, keep it", "don't cancel it",
 * "continue"; Sorani "no", "continue".
 */
const KEEPS_IT = /^(?:no+|nope|nah|not\s+really|(?:no[\s,]+)?(?:don'?t|do\s+not)(?:\s+cancel(?:\s+(?:it|that|this))?)?|(?:no[\s,]+)?(?:keep\s+(?:it|going|that|this)|continue|carry\s+on|go\s+on|go\s+ahead\s+with\s+it)|نەخێر|نا|(?:نا[\s،,]+)?بەردەوام\s+بە)[\s!.]*$/iu;
export const keepsIt = (text: string): boolean => KEEPS_IT.test(corePhrase(text).toLowerCase());
const SAYS_LAST = /^(?:(?:the\s+)?(?:last|latest|newest|most\s+recent)(?:\s+one)?|کۆتایی|دوایین|دواییان)$/iu;

const tokens = (text: string) => new Set(clean(text).toLowerCase().normalize('NFKC')
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= (isSoraniText(w) ? 3 : 4) && !STOP.has(w)));
const STOP = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'please', 'design', 'poster', 'flyer',
  'banner', 'invitation', 'about', 'there', 'their', 'what', 'when', 'make', 'change', 'thanks', 'دیزاین', 'دیزاینەکە', 'پۆستەرەکە']);

/** The one option whose title shares the most words with the text, if exactly one shares any. */
export function titleMatch(text: string, options: Array<{ title: string }>): number | null {
  const said = tokens(text);
  if (!said.size) return null;
  const scores = options.map((o) => [...tokens(o.title)].filter((w) => said.has(w)).length);
  const best = Math.max(0, ...scores);
  if (best === 0) return null;
  const winners = scores.filter((s) => s === best).length;
  return winners === 1 ? scores.indexOf(best) : null;
}

/**
 * An answer to an open question, or null when the message is not one (it is then read on its own).
 * `adds`: a new design chosen with words of its own ("no, it's for Nawroz"), which go with its brief.
 */
export function parseChoice(text: string, ask: Pick<PendingAsk, 'options' | 'allowNew'>): { option: number } | { new: true; adds?: string } | null {
  const said = corePhrase(text);
  const t = said.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d).toLowerCase();
  if (!t || t.length > 80) return null;
  const n = ask.options.length;
  // ADR-251 (friction 2): a "no" that leads other words is read by the rest of them ("no, it's a change",
  // "no, the old one", "no it's for Nawroz"). To a question with no "new design" in it ("Do you want me to
  // cancel …?", "Is this for …?") it never picks the design asked about.
  const leadingNo = LEADING_NO.exec(t);
  if (leadingNo && leadingNo[0].length < t.length) {
    if (!ask.allowNew) return null;
    const rest = said.slice(leadingNo[0].length).trim();
    const inner = rest ? parseChoice(rest, ask) : null;
    if (inner) return inner;
    // "No, it's for Nawroz" about another design: a new one, for what it names.
    if (n === 1 && (OWN_SUBJECT_EN.test(rest) || OWN_SUBJECT_CKB.test(rest))) return { new: true, adds: rest };
    return null;
  }
  const number = /^(?:(?:number|no\.?|option|#)\s*)?(\d{1,2})(?:\s*[.)])?$/.exec(t) ??
    /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+one)?$/.exec(t);
  if (number) {
    const k = Number(number[1]);
    if (k >= 1 && k <= n) return { option: k - 1 };
    if (ask.allowNew && k === n + 1) return { new: true };
    return null;
  }
  if (t.split(/\s+/).length <= 4) {
    // "new", "a new one": a longer message that starts with "new poster …" is a brief of its own.
    if (ask.allowNew && SAYS_NEW.test(t)) return { new: true };
    const k = ORDINALS[bareAnswer(t)];
    if (k) {
      if (k <= n) return { option: k - 1 };
      if (ask.allowNew && k === n + 1) return { new: true };
      return null;
    }
    if (SAYS_LAST.test(t) && n > 1) return { option: n - 1 };
    if (n === 1 && SAYS_CHANGE.test(t)) return { option: 0 };
    // "OK" answers "is this for …?", not "change or new?".
    if (n === 1 && !ask.allowNew && /^(?:ok(?:ay)?|sure|correct|right|باشە|ڕاستە)(?![\p{L}\p{N}])/iu.test(t)) return { option: 0 };
    if (n === 1 && ask.allowNew && BARE_NO.test(t)) return { new: true };
  }
  // A design's name ("the Nawroz one"), in a short answer: a longer message is read on its own.
  if (t.split(/\s+/).length > 6) return null;
  const named = titleMatch(t, ask.options);
  return named === null ? null : { option: named };
}

// ---------------------------------------------------------------------------------------------
// Choosing the request, and the plan
// ---------------------------------------------------------------------------------------------

/** Stages in which a request can take a change (directly, as a pending change, or as a late one). */
const CHANGEABLE: RequestStage[] = ['designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering', 'delivered'];
/** Stages a cancel, an approval or a deadline can still concern. */
const OPEN_STAGES: RequestStage[] = ['designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering'];

/** Waits for the requester's changes (the office asked for them) or for an answer. */
export const waitsForRequester = (r: ChatRequestView) =>
  r.stage === 'awaiting_answer' || (r.stage === 'manual' && r.rev >= 3);

export interface TurnInput {
  text: string;
  reading: IntentReading;
  requests: ChatRequestView[];
  /** Requests the message replies to (a bot message about it, or its brief). */
  bound: string[];
  /** The message is a reply to something no request knows. */
  unboundReply: boolean;
  senderId: string;
  officeIds: string[];
  group: boolean;
  /** Addressed to the bot in a group: a reply to it, a mention of it, or a command. */
  addressed: boolean;
  /** The message replies to the bot's question itself. */
  repliedToAsk?: boolean;
  /**
   * The message replies to a message of the bot that no current request knows (an old draft of the
   * deleted intake, a notice of a finished request). Its words are about another design: they are
   * never applied to a current request without the requester saying which.
   */
  foreignReply?: boolean;
  pendingAsk: PendingAsk | null;
  now: number;
}

const byActivity = (a: ChatRequestView, b: ChatRequestView) =>
  Date.parse(b.activeAt) - Date.parse(a.activeAt) || b.createdAt.localeCompare(a.createdAt);

type Picked = { request: ChatRequestView; how: 'reply' | 'only' | 'named' | 'model' | 'recent' } |
  { ambiguous: ChatRequestView[] } | { none: true };

/**
 * The request a message concerns: the one it replies to, else the only candidate, else the one its
 * words name, else (only where `recency` allows) one clearly more recent than the rest.
 */
function pickRequest(input: TurnInput, candidates: ChatRequestView[], recency: boolean): Picked {
  const bound = candidates.filter((r) => input.bound.includes(r.requestId));
  if (bound.length === 1) return { request: bound[0], how: 'reply' };
  if (input.bound.length && !bound.length) {
    const outside = input.requests.filter((r) => input.bound.includes(r.requestId));
    if (outside.length === 1) return { request: outside[0], how: 'reply' };
  }
  const pool = bound.length > 1 ? bound : candidates;
  if (pool.length === 0) return { none: true };
  if (pool.length === 1) return { request: pool[0], how: 'only' };
  if (input.reading.source === 'model' && input.reading.requestId) {
    const named = pool.find((r) => r.requestId === input.reading.requestId);
    if (named) return { request: named, how: 'model' };
  }
  const named = titleMatch(input.text, pool);
  if (named !== null) return { request: pool[named], how: 'named' };
  if (recency) {
    const [latest, next] = [...pool].sort(byActivity);
    if (latest && next && Date.parse(latest.activeAt) - Date.parse(next.activeAt) >= 10 * 60_000) {
      return { request: latest, how: 'recent' };
    }
  }
  return { ambiguous: [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}

/** Stages a request can be withdrawn from (ADR-230): nothing has been approved for it. */
const WITHDRAWABLE: RequestStage[] = ['designing', 'awaiting_answer', 'manual', 'in_review'];
const BAGHDAD_MS = 3 * 60 * 60_000;

/**
 * ADR-230 addendum (L12): which of the withdrawable requests the words describe. "the one I just sent",
 * "the last one" is the newest; "the first one" the oldest; "this morning / this afternoon / this
 * evening / today / yesterday" those opened then (office time, UTC+3); "the other one" not the design the
 * chat was last about. A description that matches none leaves the list as it was.
 */
export function describedForCancel(words: string, candidates: ChatRequestView[], all: ChatRequestView[], now: number): ChatRequestView[] {
  const t = words.toLowerCase();
  let pool = candidates;
  const keep = (next: ChatRequestView[]) => { if (next.length) pool = next; };
  const byCreated = [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (/\b(?:just\s+(?:now|sent|opened|made|asked)|(?:the\s+)?(?:last|latest|newest|most\s+recent)|a\s+(?:moment|minute|bit)\s+ago)\b/.test(t)) keep(byCreated.slice(-1));
  else if (/\b(?:the\s+)?(?:first|oldest|earliest)\b/.test(t)) keep(byCreated.slice(0, 1));
  const local = (iso: string) => new Date(Date.parse(iso) + BAGHDAD_MS);
  const today = new Date(now + BAGHDAD_MS).toISOString().slice(0, 10);
  const yesterday = new Date(now + BAGHDAD_MS - 86_400_000).toISOString().slice(0, 10);
  const period = /\bthis\s+morning\b/.test(t) ? [5, 12] : /\bthis\s+afternoon\b/.test(t) ? [12, 17]
    : /\bthis\s+evening\b|\btonight\b/.test(t) ? [17, 24] : null;
  if (period) keep(pool.filter((r) => local(r.createdAt).toISOString().slice(0, 10) === today &&
    local(r.createdAt).getUTCHours() >= period[0] && local(r.createdAt).getUTCHours() < period[1]));
  else if (/\btoday\b/.test(t)) keep(pool.filter((r) => local(r.createdAt).toISOString().slice(0, 10) === today));
  else if (/\byesterday\b/.test(t)) keep(pool.filter((r) => local(r.createdAt).toISOString().slice(0, 10) === yesterday));
  if (/\b(?:the\s+)?other\s+(?:one|request|design|poster|order)\b/.test(t)) {
    const latest = [...all].sort(byActivity)[0];
    if (latest) keep(pool.filter((r) => r.requestId !== latest.requestId));
  }
  return pool;
}

/**
 * ADR-230 addendum (L12): a cancel without a reply. It withdraws only what can be withdrawn: the words'
 * description narrows those; one named for certain (by its name, or the router sure of it) is withdrawn;
 * one found any other way is asked about by name ("Do you want me to cancel …?"), unless it is the only
 * design in the chat. With nothing withdrawable, a design approved or being sent is told too late (as
 * ADR-230 did), and with nothing open at all the requester hears so, naming what was delivered.
 */
function planCancel(input: TurnInput, open: ChatRequestView[], changeable: ChatRequestView[], words: string,
  reading: IntentReading, ask: (intent: PendingAsk['intent'], among: ChatRequestView[], allowNew: boolean) => TurnPlan,
  confirm = false): TurnPlan {
  const withdrawable = open.filter((r) => WITHDRAWABLE.includes(r.stage));
  if (!withdrawable.length) {
    if (open.length) {
      const picked = pickRequest(input, open, true);
      if ('request' in picked) return (confirm ? null : applyTo('cancel', picked.request, words, picked.how, reading.confidence)) ?? ask('cancel', [picked.request], false);
      if ('ambiguous' in picked) return ask('cancel', picked.ambiguous, false);
    }
    return { kind: 'reply', what: 'nothing-to-cancel', requestIds: [...changeable].sort(byActivity).slice(0, 3).map((r) => r.requestId) };
  }
  // `confirm`: the words are not certainly a cancel; even a design they name is asked about first.
  const note = (r: ChatRequestView): TurnPlan => confirm ? ask('cancel', [r], false) : ({ kind: 'note', note: 'cancel', requestId: r.requestId, words });
  if (reading.source === 'model' && reading.requestId && (reading.confidence ?? 0) >= 0.85) {
    const sure = withdrawable.find((r) => r.requestId === reading.requestId);
    if (sure) return note(sure);
  }
  const described = describedForCancel(words, withdrawable, changeable, input.now);
  const named = titleMatch(input.text, described);
  if (named !== null) return note(described[named]);
  if (described.length === 1) {
    // "cancel it" with one design in the chat is about that design; with others about (delivered ones,
    // too late to cancel), the one it can be is asked about by name.
    return changeable.length === 1 ? note(described[0]) : ask('cancel', described, false);
  }
  return ask('cancel', [...described].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), false);
}

const options = (requests: ChatRequestView[]) => requests.map((r) => ({ requestId: r.requestId, title: r.title, askedAt: r.createdAt,
  ...(r.words ? { words: r.words.slice(0, 120) } : {}) }));

/** A change bound to one request: a paid round when it waits for changes, else kept for the office. */
function changeFor(request: ChatRequestView, words: string, how: string, confidence: number | undefined,
  resolves?: number): TurnPlan | null {
  if (waitsForRequester(request)) {
    // Recency never starts a paid round, and a model's pick only when it is sure.
    if (how === 'recent' || (how === 'model' && (confidence ?? 0) < 0.85)) return null;
    return { kind: 'revise', requestId: request.requestId, directive: words, ...(resolves ? { resolves } : {}) };
  }
  return { kind: 'note', note: 'change', requestId: request.requestId, words, ...(resolves ? { resolves } : {}) };
}

/**
 * A change whose words only refuse ("not approved", "don't send it") never starts a paid round: with a
 * design waiting for the requester's changes it goes to the office; otherwise it is kept for the office
 * as any change is (ADR-040 addendum, 2026-10-01).
 */
function changeOrRefusal(reading: Pick<IntentReading, 'refusalOnly'>, request: ChatRequestView, words: string, how: string,
  confidence: number | undefined, resolves?: number): TurnPlan | null {
  if (reading.refusalOnly && waitsForRequester(request)) return { kind: 'forward', words };
  return changeFor(request, words, how, confidence, resolves);
}

/**
 * The plan for an answer to the bot's question about kept words. Approval or change words are read
 * again by the current rules (ADR-040 addendum, 2026-10-01): words kept as approval that now refuse
 * ("the design is not approved, ...") are the requester not being happy, never happiness.
 */
function answerPlan(ask: PendingAsk, chosen: ChatRequestView): TurnPlan | null {
  // ADR-200 addendum: "which one should I redo?" or "redo it, or a new design?" answered with a design.
  if (!ask.photo && readIntentByRules(ask.words).redo) return redoFor(chosen, ask.words, ask.updateId);
  if (ask.intent === 'approval' || ask.intent === 'change') {
    const again = readIntentByRules(ask.words);
    if (ask.intent === 'approval' && again.intent !== 'approval') {
      return again.intent === 'change' ? changeOrRefusal(again, chosen, ask.words, 'named', undefined, ask.updateId)
        : { kind: 'forward', words: ask.words };
    }
    if (ask.intent === 'change' && again.refusalOnly) return changeOrRefusal(again, chosen, ask.words, 'named', undefined, ask.updateId);
  }
  return applyTo(ask.intent, chosen, ask.words, 'named', undefined, ask.updateId);
}

/** A brief opened after "new" was chosen drafts automatically only when it carries its own copy. */
export function opensForAPerson(words: string): boolean {
  const reading = readIntentByRules(words);
  return reading.intent !== 'new_brief' || !reading.substantial || reading.instructionOnly === true;
}

/** Whether the words repeat much of an existing request's title (a corrected copy, not a new design). */
function overlapsRequest(text: string, requests: ChatRequestView[]): boolean {
  const said = tokens(text);
  return requests.some((r) => {
    const title = [...tokens(r.title)];
    const shared = title.filter((w) => said.has(w)).length;
    return title.length > 0 && shared >= 2 && shared / title.length >= 0.5;
  });
}

/** Applies an intent to one chosen request (after a question, or when the request is known). */
function applyTo(intent: PendingAsk['intent'], request: ChatRequestView, words: string, how: string,
  confidence: number | undefined, resolves?: number): TurnPlan | null {
  const r = resolves ? { resolves } : {};
  switch (intent) {
    case 'hold': return { kind: 'note', note: 'hold', requestId: request.requestId, words, ...r };
    // ADR-230: a cancel withdraws the request, so it is carried out only when the design is certain (a
    // reply, the only one, named, or a question answered); one picked by recency is asked about first.
    case 'cancel': return resolves || ['reply', 'only', 'named'].includes(how)
      ? { kind: 'note', note: 'cancel', requestId: request.requestId, words, ...r } : null;
    case 'approval': return { kind: 'tell', note: 'approval', requestId: request.requestId, words, ...r };
    case 'deadline': return { kind: 'tell', note: 'deadline', requestId: request.requestId, words, ...r };
    case 'delivery_request': return { kind: 'tell', note: 'delivery', requestId: request.requestId, words, ...r };
    default: return changeFor(request, words, how, confidence, resolves);
  }
}

/**
 * ADR-200 addendum: how long after delivery redo words ("do a better one", "try again") still mean a
 * delivered design. Other words mean a delivered design for `DELIVERED_LIVE_MS`, as before; the chat's
 * requests are read with this longer window (`activeChatRequests`).
 */
export const REDO_WINDOW_DAYS = 7;
export const REDO_WINDOW_MS = REDO_WINDOW_DAYS * 24 * 60 * 60_000;
export const DELIVERED_LIVE_MS = 3 * 24 * 60 * 60_000;
/** Designs that moved closer together than this are not told apart by which came last. */
export const REDO_APART_MS = 10 * 60_000;
const deliveredWithin = (r: ChatRequestView, now: number, ms: number) =>
  r.stage !== 'delivered' || now - Date.parse(r.activeAt) <= ms;
/**
 * ADR-231: a design the requester has seen a draft of: with the office, approved, being sent or sent,
 * or sent back to them for changes (rev 3 or more in `manual`). A request opened for a designer, or one
 * still being made for the first time, has none: redo words are not about it while another has one.
 */
export const hasDraft = (r: ChatRequestView) =>
  ['in_review', 'approved', 'delivering', 'delivered'].includes(r.stage) || (r.stage === 'manual' && r.rev >= 3);

/**
 * Redo words applied to one design (ADR-200 addendum): a delivered design starts a new round of its
 * own request, with the words as the change; one that waits for the requester's changes starts its
 * round as any change does; anywhere else (being made, with the office, with a designer) the words
 * are kept on it for the office. The words are named as the design's ("I'll redo …").
 */
function redoFor(request: ChatRequestView, words: string, resolves?: number): TurnPlan {
  const r = resolves ? { resolves } : {};
  if (request.stage === 'delivered') return { kind: 'redo', requestId: request.requestId, directive: words, ...r };
  if (waitsForRequester(request)) return { kind: 'revise', requestId: request.requestId, directive: words, redo: true, ...r };
  return { kind: 'note', note: 'change', requestId: request.requestId, words, redo: true, ...r };
}

/**
 * Redo words are about the requester's most recent design: the one the message replies to, the one
 * the words or a sure model reading name, else the one that moved last, when no other moved within
 * `REDO_APART_MS` of it. Two close together: "Which one should I redo: A or B?". Words that may also
 * be a new design: "Do you mean redo A, or a new design?". Null: no recent design to redo, or a reply
 * to something else; the words are then read as before.
 *
 * ADR-231 (live 2026-10-01): with no reply, only designs the requester has seen a draft of are
 * candidates while there is one (`hasDraft`). "Do a better design that's similar to the earlier ones"
 * was bound to a request opened by mistake for a designer an hour later, which had nothing to redo.
 */
function planRedo(input: TurnInput, words: string, mayAct: (r: ChatRequestView) => boolean): TurnPlan | null {
  const { reading, now } = input;
  const recent = input.requests.filter((r) => CHANGEABLE.includes(r.stage) && mayAct(r) && deliveredWithin(r, now, REDO_WINDOW_MS));
  const bound = recent.filter((r) => input.bound.includes(r.requestId));
  if (input.bound.length && !bound.length) return null;
  const orNew = reading.redo === 'or-new';
  const askRedo = (among: ChatRequestView[], allowNew: boolean): TurnPlan => ({ kind: 'ask', intent: allowNew ? 'unclear' : 'change',
    words, options: options(among), allowNew, redo: allowNew ? 'or-new' : 'redo' });
  if (bound.length === 1) return orNew ? askRedo(bound, true) : redoFor(bound[0], words);
  const drafted = recent.filter(hasDraft);
  const pool = bound.length > 1 ? bound : drafted.length ? drafted : recent;
  if (!pool.length) return null;
  // The intake router's pick (asked when the rules could not tell), when it is sure enough to start a round.
  if (reading.source === 'model' && reading.requestId && (reading.confidence ?? 0) >= 0.85) {
    const named = pool.find((r) => r.requestId === reading.requestId);
    if (named) return redoFor(named, words);
  }
  const named = pool.length > 1 ? titleMatch(words, pool) : null;
  if (named !== null) return orNew ? askRedo([pool[named]], true) : redoFor(pool[named], words);
  const [latest, next] = [...pool].sort(byActivity);
  const clear = !next || Date.parse(latest.activeAt) - Date.parse(next.activeAt) >= REDO_APART_MS;
  const oldestFirst = [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (orNew) return askRedo(clear ? [latest] : oldestFirst, true);
  return clear ? redoFor(latest, words) : askRedo(oldestFirst, false);
}

/** What to do with this message. Pure: the route records the plan once per update and carries it out. */
export function planTurn(full: TurnInput): TurnPlan {
  // Delivered designs older than DELIVERED_LIVE_MS concern redo words only (ADR-200 addendum).
  // ADR-230 addendum (L17): a closed request (withdrawn, rejected, expired) is never offered or acted on.
  full = { ...full, requests: full.requests.filter((r) => CHANGEABLE.includes(r.stage)) };
  const input: TurnInput = { ...full, requests: full.requests.filter((r) => deliveredWithin(r, full.now, DELIVERED_LIVE_MS)) };
  const { reading, requests } = input;
  // The words as sent (line breaks included): they become a brief, a directive or a note.
  const words = input.text.trim();
  const office = input.officeIds.includes(input.senderId);
  // In a group, only the request's own requester (or an office member) may change it (F8).
  const mayAct = (r: ChatRequestView) => !input.group || office || !r.requesterId || r.requesterId === input.senderId;

  // 1. An answer to the question this bot just asked the sender.
  // A reply to some other request's message is about that request, not an answer to the question.
  if (input.pendingAsk && (input.repliedToAsk || !input.bound.length)) {
    // ADR-251 (friction 1): "no" to "Do you want me to cancel …?" keeps the design going; the requester
    // hears where it stands.
    if (input.pendingAsk.intent === 'cancel' && keepsIt(words)) {
      const asked = input.pendingAsk.options.map((o) => o.requestId);
      return { kind: 'reply', what: 'status', requestIds: requests.filter((r) => asked.includes(r.requestId)).map((r) => r.requestId) };
    }
    const choice = parseChoice(words, input.pendingAsk);
    if (choice) {
      const ask = input.pendingAsk;
      if ('new' in choice) {
        // ADR-251 (friction 2): "no, it's for Nawroz" about another design. A design of the chat that the
        // added words name is asked about; otherwise a new design opens with them under its words.
        if (choice.adds) {
          const others = requests.filter((r) => CHANGEABLE.includes(r.stage) && !ask.options.some((o) => o.requestId === r.requestId) && mayAct(r));
          const named = titleMatch(choice.adds, others);
          if (named !== null) return { kind: 'ask', intent: 'unclear', words: ask.words, options: options([others[named]]), allowNew: true };
        }
        const text = choice.adds ? `${ask.words}\n${choice.adds}` : ask.words;
        return { kind: 'open', text, instructionOnly: opensForAPerson(text), resolves: ask.updateId };
      }
      const among = !ask.photo && readIntentByRules(ask.words).redo ? full.requests : requests;
      const chosen = among.find((r) => r.requestId === ask.options[choice.option]?.requestId);
      if (chosen && mayAct(chosen)) {
        const plan = answerPlan(ask, chosen);
        if (plan) return plan;
      }
      if (!chosen) return { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
    }
  }

  // 2. Groups: only what is addressed to the bot, or a clear brief, is acted on (F8).
  const ownBound = requests.some((r) => input.bound.includes(r.requestId) && mayAct(r));
  if (input.group && !input.addressed && !ownBound) {
    const clearBrief = reading.intent === 'new_brief' && (reading.explicitNew ||
      /\n\s*[_\-=*]{3,}\s*\n/.test(input.text) || /\n\s*(?:content|copy|text|details|دەق|ناوەڕۆک)\s*:/i.test(input.text));
    if (!clearBrief) return { kind: 'passive', reason: 'Group conversation not addressed to the bot' };
  }
  // A group member's words about someone else's request stay passive: only its requester and the
  // office change it.
  if (input.group && input.bound.length && !ownBound && reading.intent !== 'new_brief') {
    return { kind: 'passive', reason: 'Words about another member\'s request' };
  }

  // ADR-200 addendum: redo words are about the requester's most recent design, delivered ones included
  // (within REDO_WINDOW_MS). A reply to a bot message no request knows is read as before.
  if (reading.redo && !input.foreignReply) {
    const redo = planRedo(full, words, mayAct);
    if (redo) return redo;
  }

  const changeable = requests.filter((r) => CHANGEABLE.includes(r.stage) && mayAct(r));
  const open = requests.filter((r) => OPEN_STAGES.includes(r.stage) && mayAct(r));
  const ask = (intent: PendingAsk['intent'], among: ChatRequestView[], allowNew: boolean): TurnPlan =>
    ({ kind: 'ask', intent, words, options: options(among), allowNew });

  // 3. A reply to a bot message about no current request: thanks, a status question, chatter and a
  // brief of its own are read as usual; anything else is about another design, so the requester is
  // asked which current design they mean, or, with none, the words go to the office.
  // Asked about the files of that other design (ADR-156): the office finds them.
  if (input.foreignReply && reading.intent === 'delivery_request') return { kind: 'forward', words };
  // ADR-182: a reply to a message about a design this chat no longer has on the way (delivered days
  // ago) is about that design: its words go to the office, never "I have nothing in progress".
  const boundElsewhere = input.bound.length > 0 && !requests.some((r) => input.bound.includes(r.requestId));
  if (boundElsewhere && !['acknowledgement', 'status', 'conversation'].includes(reading.intent) &&
      !(reading.intent === 'new_brief' && (reading.explicitNew || reading.substantial))) {
    return { kind: 'forward', words };
  }
  if (input.foreignReply && !['acknowledgement', 'status', 'conversation'].includes(reading.intent) &&
      !(reading.intent === 'new_brief' && (reading.explicitNew || reading.substantial))) {
    const among = [...(reading.intent === 'change' || reading.intent === 'unclear' || reading.intent === 'new_brief' ? changeable : open)]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const intent: PendingAsk['intent'] = reading.intent === 'new_brief' ? 'unclear' : reading.intent as PendingAsk['intent'];
    return among.length ? ask(intent, among, intent === 'unclear') : { kind: 'forward', words };
  }

  switch (reading.intent) {
    case 'acknowledgement':
      return { kind: 'reply', what: 'thanks', requestIds: requests.filter(waitsForRequester).map((r) => r.requestId) };
    case 'status': {
      const bound = requests.filter((r) => input.bound.includes(r.requestId));
      const shown = (bound.length ? bound : requests).slice().sort(byActivity).slice(0, 3);
      return { kind: 'reply', what: 'status', requestIds: shown.map((r) => r.requestId) };
    }
    case 'conversation':
      // ADR-182: a question the bot cannot answer is the office's, not a prompt for a brief.
      return reading.question ? { kind: 'forward', words, question: true } : { kind: 'conversation' };
    case 'cancel':
      // ADR-230 addendum (L12): a cancel withdraws, so it looks only at requests that can be withdrawn.
      // ADR-251 (friction 1): one that names nothing ("never mind", "stop") is asked about first.
      if (!input.bound.length) return planCancel(input, open, changeable, words, reading, ask, reading.bareCancel === true);
      // falls through: a reply names its design, and a design too late to cancel is told so (ADR-230).
    case 'approval':
    case 'deadline':
    case 'hold': {
      const picked = pickRequest(input, open, true);
      // ADR-251 (friction 1): "stop" said as a reply to a design's message is asked about too.
      if ('request' in picked && reading.intent === 'cancel' && reading.bareCancel) return ask('cancel', [picked.request], false);
      if ('request' in picked) return applyTo(reading.intent, picked.request, words, picked.how, reading.confidence) ?? ask(reading.intent, [picked.request], false);
      if ('ambiguous' in picked) return ask(reading.intent, picked.ambiguous, false);
      // Nothing open: thanks, or where the chat stands, is all there is to say.
      return { kind: 'reply', what: reading.intent === 'approval' ? 'thanks' : 'status', requestIds: [] };
    }
    case 'delivery_request': {
      // ADR-156: about the files of a design, delivered ones included: the office hears it, and nothing
      // is approved or sent by itself. A design this chat no longer lists is the office's to find.
      const picked = pickRequest(input, changeable, true);
      if ('request' in picked) return applyTo('delivery_request', picked.request, words, picked.how, reading.confidence)!;
      if ('ambiguous' in picked) return ask('delivery_request', picked.ambiguous, false);
      return { kind: 'forward', words };
    }
    case 'new_brief': {
      if (reading.explicitNew || !changeable.length) {
        return { kind: 'open', text: words, instructionOnly: reading.instructionOnly === true };
      }
      const bound = changeable.filter((r) => input.bound.includes(r.requestId));
      if (bound.length) return ask('unclear', bound, true);
      if (reading.substantial) {
        // A full brief opens, unless it repeats the words of a design that waits for the requester's
        // changes: then it may be that design's corrected copy, and the requester is asked.
        const similar = changeable.filter((r) => waitsForRequester(r) && overlapsRequest(words, [r]));
        if (!similar.length) return { kind: 'open', text: words, instructionOnly: reading.instructionOnly === true };
        return ask('unclear', similar, true);
      }
      return ask('unclear', [...changeable].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), true);
    }
    case 'change': {
      if (!changeable.length) {
        // Nothing to change. A reply (to anything) is answered so; a plain message is read as it
        // always was: a styling message opens as a manual request, a question is answered.
        if (input.bound.length || input.unboundReply) return { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
        // "Not approved", "don't send it" with no design to place them on: the office hears them.
        if (reading.refusalOnly) return { kind: 'forward', words };
        // ADR-200 addendum: "do a better design" with no recent design to redo asks for one: a designer
        // takes it (named neutrally, intake's title rule), as it did before redo words were read.
        if (reading.redo && asksForNewDesign(words)) return { kind: 'open', text: words, instructionOnly: true };
        const h = classifyWithHeuristics(words, false, false);
        if (h.kind === 'new_brief') return { kind: 'open', text: words, instructionOnly: true };
        // ADR-182: "can you make videos?" reads like a change but asks the office a question.
        return isPlainQuestion(words) ? { kind: 'forward', words, question: true } : { kind: 'conversation' };
      }
      const picked = pickRequest(input, changeable, true);
      if ('request' in picked) {
        return changeOrRefusal(reading, picked.request, words, picked.how, reading.confidence) ?? ask('change', [picked.request], false);
      }
      if ('ambiguous' in picked) return ask('change', picked.ambiguous, false);
      return { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
    }
    case 'unclear': {
      // ADR-230 addendum (L17): words that cancel in a way the rules cannot place are asked about among
      // the requests that can be withdrawn, by name, never with "a new design" and never withdrawn unasked.
      if (reading.cancelWords && !input.bound.length) return planCancel(input, open, changeable, words, reading, ask, true);
      const bound = changeable.filter((r) => input.bound.includes(r.requestId));
      if (bound.length === 1) return changeFor(bound[0], words, 'reply', undefined) ?? ask('unclear', bound, true);
      if (!changeable.length) {
        const h = classifyWithHeuristics(words, false, false);
        return h.kind === 'new_brief' ? { kind: 'open', text: words, instructionOnly: h.isInstructionOnly === true } : { kind: 'conversation' };
      }
      return ask('unclear', [...(bound.length ? bound : changeable)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), true);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What the requester hears: the catalogue's routing phrases (ADR-145, packages/integrations/src/
// requester-messages/routing.ts), in the requester's language. The office's alerts stay here.
// ---------------------------------------------------------------------------------------------

const say = (phrase: Phrase, lang: Lang, params: Record<string, string | number> = {}) => sayPhrase(phrase, lang, params);
/**
 * A design's name in bold. ADR-251 (friction 11): one with no name of its own is "your design" in the
 * requester's language, never the English words inside a Sorani sentence.
 */
const title = (r: { title: string }, lang: Lang = 'en') => {
  const name = shortTitle(r.title);
  return bold(name === 'your design' ? say(LIFECYCLE_MESSAGES.yourDesign, lang) : name);
};
/**
 * ADR-231: a stored title that is a sentence naming no design (four words or more, read as redo, quality
 * words or chat). A short name ("Report", "Nawroz") is a name.
 */
const sentenceTitle = (name: string) => {
  const line = name.replace(/…$/u, '');
  return line.split(/\s+/).filter(Boolean).length >= 4 && isWeakBriefLine(line);
};
export function shortTitle(value: string): string {
  // ADR-040 addendum (2026-10-01): a title stored before ADR-180 or ADR-142 is shown as a new one would
  // be: no direction mark ("KAAE: \u200FKAAE K-12…"), and no introducer line as the design's name.
  const name = withoutMarks(String(value || '').replace(/^[^:]{1,40}:\s*/, ''));
  // ADR-231: a title stored before ADR-200's title rule from words that name no design ("do a better
  // design thats similar to earlier o…") is "your design", as a new one would be.
  const t = name && !isIntroducerTitle(name) && !isNeutralRequestTitle(name) && !sentenceTitle(name) ? name : 'your design';
  return Array.from(t).length > 60 ? `${Array.from(t).slice(0, 59).join('')}…` : t;
}

/**
 * A design's name as a requester sees it, in bold (HTML), or "your design" in their language when the
 * request carries no name.
 */
export function designName(value: string | null | undefined, lang: Lang): string {
  // A task titled before 2026-09-29 from the line that introduced its text ("KAAE: Here is the text
  // and the photos:…", task ba4469f2) has no name the requester would know: it is "your design" (ADR-142).
  const name = String(value ?? '').replace(/^[^:]{1,40}:\s*/, '').replace(/…$/, '').trim();
  if (name && isCopyIntroducer(name)) return say(LIFECYCLE_MESSAGES.yourDesign, lang);
  return String(value ?? '').trim() ? title({ title: String(value) }, lang) : say(LIFECYCLE_MESSAGES.yourDesign, lang);
}

const STATUS_LINE: Record<RequestStage | 'manual-waiting', Phrase> = {
  designing: ROUTING_MESSAGES.statusDesigning,
  manual: ROUTING_MESSAGES.statusManual,
  'manual-waiting': ROUTING_MESSAGES.statusWaitingForChanges,
  awaiting_answer: ROUTING_MESSAGES.statusAwaitingAnswer,
  in_review: ROUTING_MESSAGES.statusInReview,
  approved: ROUTING_MESSAGES.statusApproved,
  delivering: ROUTING_MESSAGES.statusDelivering,
  delivered: ROUTING_MESSAGES.statusDelivered,
};

/**
 * ADR-231: the stage a requester is told about. A request still `delivering` whose files and final
 * notice reached them (`sentToChat`) was delivered, as far as they can tell: "being sent to you now"
 * five hours after it arrived was untrue (live 2026-10-01).
 */
export const spokenStage = (r: Pick<ChatRequestView, 'stage' | 'sentToChat'>): RequestStage =>
  r.stage === 'delivering' && r.sentToChat ? 'delivered' : r.stage;

const IRAQ_OFFSET_MS = 3 * 60 * 60_000;
const iraqDay = (at: number) => Math.floor((at + IRAQ_OFFSET_MS) / 86_400_000);
/** When a design was asked for, in the requester's words ("asked for today at 08:44"). */
function askedWhen(at: number, now: number, lang: Lang): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 2) return say(ROUTING_MESSAGES.askedJustNow, lang);
  if (minutes < 60) return say(ROUTING_MESSAGES.askedMinutesAgo, lang, { n: minutes });
  const local = new Date(at + IRAQ_OFFSET_MS);
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const days = iraqDay(now) - iraqDay(at);
  if (days <= 0) return say(ROUTING_MESSAGES.askedToday, lang, { time });
  if (days === 1) return say(ROUTING_MESSAGES.askedYesterday, lang, { time });
  return say(ROUTING_MESSAGES.askedDaysAgo, lang, { n: days });
}

/**
 * ADR-230 addendum (L16): the start of a requester's own words, quoted (HTML): at most six words and 40
 * characters, with "…" when cut. Empty for words that are a neutral name ("New design request from …").
 */
export function openingWords(words: string | null | undefined, html = true): string {
  const t = withoutMarks(String(words ?? '').replace(/\s+/g, ' ').trim()).replace(/…$/u, '');
  if (!t || isNeutralRequestTitle(t)) return '';
  const all = t.split(' ');
  let cut = all.slice(0, 6).join(' ');
  if (cut.length > 40) cut = `${Array.from(cut).slice(0, 39).join('').trimEnd()}`;
  const more = cut.length < t.length;
  const shown = cut.replace(/[\s,.;:!?]+$/u, '');
  return `“${html ? escapeTelegramHtml(shown) : shown}${more ? '…' : ''}”`;
}

/** When a request was sent, in the requester's words ("today at 15:33"), office time. */
export function sentWhen(at: number, now: number, lang: Lang): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 2) return say(NAMING_MESSAGES.sentJustNow, lang);
  if (minutes < 60) return say(NAMING_MESSAGES.sentMinutesAgo, lang, { n: minutes });
  const local = new Date(at + IRAQ_OFFSET_MS);
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const days = iraqDay(now) - iraqDay(at);
  if (days <= 0) return say(NAMING_MESSAGES.sentToday, lang, { time });
  if (days === 1) return say(NAMING_MESSAGES.sentYesterday, lang, { time });
  return say(NAMING_MESSAGES.sentDaysAgo, lang, { n: days });
}

/**
 * ADR-230 addendum (L16): a request's name as the requester reads it (HTML). One whose stored title
 * names nothing ("your design") is named by when it was sent and the start of their words: "the one you
 * sent today at 15:33 (“do a better design thats similar…”)". Its words are the brief's own, or the
 * stored title when that is the sentence they sent.
 */
export function requestLabel(r: { title: string; askedAt?: string; words?: string }, lang: Lang, now = Date.now()): string {
  if (shortTitle(r.title) !== 'your design') return title(r, lang);
  const at = r.askedAt ? Date.parse(r.askedAt) : NaN;
  const words = openingWords(r.words) || openingWords(r.title.replace(/^[^:]{1,40}:\s*/, ''));
  if (!Number.isFinite(at)) return words ? `${say(LIFECYCLE_MESSAGES.yourDesign, lang)} (${words})` : say(LIFECYCLE_MESSAGES.yourDesign, lang);
  const when = sentWhen(at, now, lang);
  return words ? say(NAMING_MESSAGES.theOneYouSent, lang, { when, words }) : say(NAMING_MESSAGES.theOneYouSentPlain, lang, { when });
}

/**
 * ADR-231: each design's name as the requester reads it (bold HTML). Designs that share a name are told
 * apart by when each was asked for ("KAAE K-12 Pilot Study… (asked for today at 08:44)"), or, asked for
 * within the same minute or with no time known, by their order ("version 2"). The live status of
 * 2026-10-01 named "KAAE K-12 Pilot Study…" twice with nothing between them.
 */
export function distinctNames(items: ReadonlyArray<{ requestId: string; title: string; askedAt?: string; words?: string }>, lang: Lang,
  now: number): Map<string, string> {
  const names = new Map<string, string>();
  const groups = new Map<string, typeof items[number][]>();
  for (const item of items) {
    const key = shortTitle(item.title).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    // ADR-230 addendum (L16): requests with no name of their own are each named by when and their words.
    if (shortTitle(group[0].title) === 'your design') { for (const g of group) names.set(g.requestId, requestLabel(g, lang, now)); continue; }
    if (group.length === 1) { names.set(group[0].requestId, title(group[0], lang)); continue; }
    const when = group.map((g) => (g.askedAt && Number.isFinite(Date.parse(g.askedAt)) ? askedWhen(Date.parse(g.askedAt), now, lang) : ''));
    const byTime = when.every((w) => w) && new Set(when).size === when.length;
    const order = [...group].sort((a, b) => String(a.askedAt ?? '').localeCompare(String(b.askedAt ?? '')));
    group.forEach((g, i) => names.set(g.requestId, `${title(g, lang)} (${byTime ? when[i]
      : say(ROUTING_MESSAGES.versionN, lang, { n: order.indexOf(g) + 1 })})`));
  }
  return names;
}

/**
 * `slow`: designs taking longer than usual that the office was just told about (ADR-182): their line
 * says so, instead of "the draft usually takes a few minutes" to someone who has waited an hour.
 * ADR-231: each line is true for its stage (`spokenStage`); a stage this answer has no words for (a
 * closed request) is not listed; designs with the same name are told apart (`distinctNames`).
 */
export function statusText(requests: ChatRequestView[], lang: Lang, slow: ReadonlySet<string> = new Set(), now = Date.now()): string {
  const shown = requests.filter((r) => r.stage in STATUS_LINE);
  if (!shown.length) return say(ROUTING_MESSAGES.statusNothingOpen, lang);
  const names = distinctNames(shown.map((r) => ({ requestId: r.requestId, title: r.title, askedAt: r.createdAt, words: r.words })), lang, now);
  return shown.map((r) => {
    const stage = spokenStage(r);
    const key = stage === 'manual' && r.rev >= 3 ? 'manual-waiting' : stage;
    const q = r.question?.text ? escapeTelegramHtml(r.question.text) : '';
    const name = names.get(r.requestId) ?? title(r, lang);
    if (stage === 'designing' && r.requesterHold) return say(ROUTING_MESSAGES.statusHeld, lang, { title: name });
    if (stage === 'designing' && slow.has(r.requestId)) return say(ROUTING_MESSAGES.statusDesigningSlow, lang, { title: name });
    return say(STATUS_LINE[key], lang, { title: name, question: q });
  }).join('\n\n');
}

/** ADR-182: how long a design may take before a requester asking about it is told it is slow. */
export const SLOW_DESIGN_MS = 30 * 60_000;

/** The designs among `requests` still being designed after `SLOW_DESIGN_MS`. */
export function slowDesigns(requests: ChatRequestView[], now: number): ChatRequestView[] {
  return requests.filter((r) => r.stage === 'designing' && !r.requesterHold && now - Date.parse(r.activeAt) > SLOW_DESIGN_MS);
}

// ---------------------------------------------------------------------------------------------
// What the office hears. ADR-231 (live 2026-10-01): the office read "The requester in chat 7191500129
// …", "Task 030996c1-…, request 3a4c6ac4-…" and "Deliver will ask someone in the Desk to read and
// acknowledge these words first". An alert now names the requester and the design in plain sentences,
// quotes the requester's words exactly as sent, and keeps one short last line for finding the task in
// the Desk's search.
// ---------------------------------------------------------------------------------------------

/**
 * Who wrote, as an office member knows them: the first and last name Telegram sends with the message
 * (`from`), else their @username; null when it carries neither.
 */
export function requesterName(from: unknown): string | null {
  const f = from && typeof from === 'object' ? from as { first_name?: unknown; last_name?: unknown; username?: unknown } : {};
  const part = (v: unknown) => (typeof v === 'string' ? trimTitleMarks(v).replace(/\s+/g, ' ') : '');
  const name = [part(f.first_name), part(f.last_name)].filter(Boolean).join(' ');
  const username = part(f.username);
  const said = name || (username ? `@${username.replace(/^@/, '')}` : '');
  return said ? Array.from(said).slice(0, 80).join('') : null;
}

/** The subject of an office alert: the requester's name, else "A requester". */
export const whoWrote = (name: string | null | undefined): string => name?.trim() || 'A requester';

/** The last line of an office alert: the short task ids the Desk's search finds. */
export const deskSearchLine = (taskIds: readonly string[]): string =>
  `Desk search: ${[...new Set(taskIds.map((id) => id.slice(0, 8)))].join(', ')}`;

const quotedWords = (words: string) => (words.length > 1500 ? `${words.slice(0, 1500)}…` : words);

/** The office's alert when a requester asks about a design that is taking longer than usual. */
export function slowDesignOfficeAlert(who: string, slow: ChatRequestView[], now: number): string {
  return [`${who} asked how their design is going, and it is taking longer than usual. Please check on it and answer them in the chat.`,
    ...slow.map((r) => `"${shortTitle(r.title)}" has been in design for ${Math.round((now - Date.parse(r.activeAt)) / 60_000)} minutes.`),
    '', deskSearchLine(slow.map((r) => r.currentTaskId)),
  ].join('\n');
}

export function thanksText(waiting: ChatRequestView[], lang: Lang): string {
  if (waiting.length !== 1) return say(ROUTING_MESSAGES.thanks, lang);
  return say(ROUTING_MESSAGES.thanksOneWaiting, lang, { title: title(waiting[0], lang) });
}

/** `alerted`: the office chat was told; without one the words are only kept for the office. */
export function forwardText(lang: Lang, alerted: boolean, question = false): string {
  if (question) return say(alerted ? ROUTING_MESSAGES.questionPassed : ROUTING_MESSAGES.questionKept, lang);
  return say(alerted ? ROUTING_MESSAGES.forwardedToOffice : ROUTING_MESSAGES.keptForOffice, lang);
}

/**
 * ADR-182: the office's alert for a question the bot cannot answer (plain text, the words as sent).
 * ADR-231: it holds no design back; the requester was told the office will reply.
 */
export function questionOfficeAlert(who: string, words: string): string {
  return [`${who} asked a question the bot cannot answer. Nothing was changed and no design is held back; please answer them in the chat.`,
    '', 'Their question:', quotedWords(words)].join('\n');
}

/** The office's alert for words about a design this bot cannot link to a current request. */
export function forwardOfficeAlert(who: string, words: string): string {
  return [`${who} replied to an older message from the bot, about a design that is no longer open in their chat. Nothing was changed; please answer them in the chat.`,
    '', 'Their words:', quotedWords(words)].join('\n');
}

/**
 * The office's alert for words the bot could not apply because their design moved on while they were
 * read (a round planned on it could not start, ADR-156). The requester was told the office has them.
 */
export function conflictOfficeAlert(who: string, words: string): string {
  return [`${who} sent words the bot could not apply: their design changed while the words were being read, so nothing was started. Please read them and answer in the chat.`,
    '', 'Their words:', quotedWords(words)].join('\n');
}

export function nothingToChangeText(lang: Lang): string {
  return say(ROUTING_MESSAGES.nothingToChange, lang);
}

/** ADR-231: `now` dates the names of designs that share one ("asked for today at 08:44"). */
export function askText(plan: Extract<TurnPlan, { kind: 'ask' }>, lang: Lang, now = Date.now()): string {
  const names = distinctNames(plan.options, lang, now);
  const named = (o: { requestId: string; title: string }) => names.get(o.requestId) ?? title(o, lang);
  // ADR-200 addendum: a question about redo words names the designs and what would happen to them.
  if (plan.redo === 'or-new' && plan.options.length === 1) return say(ROUTING_MESSAGES.askRedoOrNew, lang, { title: title(plan.options[0], lang) });
  if (plan.redo === 'redo' && plan.options.length > 1) {
    return say(ROUTING_MESSAGES.askWhichRedo, lang, { list: plan.options.map((o, i) => `${i + 1}. ${named(o)}`).join('\n') });
  }
  if (plan.options.length === 1 && plan.allowNew) return say(ROUTING_MESSAGES.askChangeOrNew, lang, { title: named(plan.options[0]) });
  if (plan.options.length === 1) {
    return say(plan.intent === 'cancel' ? WITHDRAW_MESSAGES.askCancel : ROUTING_MESSAGES.askIsThisOne, lang, { title: named(plan.options[0]) });
  }
  const list = plan.options.map((o, i) => `${i + 1}. ${named(o)}`);
  if (plan.allowNew) list.push(`${plan.options.length + 1}. ${say(ROUTING_MESSAGES.aNewDesign, lang)}`);
  return say(ROUTING_MESSAGES.askWhichDesign, lang, { list: list.join('\n') });
}

/**
 * ADR-200 addendum: the requester's answer to redo words, naming the design: a new round started
 * (`started`), words added to a design still being made, or passed to the office.
 * ADR-231 (live 2026-10-01): "I'll redo …" only when the round started. Otherwise the words were kept
 * for the office, and the requester hears that, with the reason nothing started: the design is still
 * being made, with the office, already approved or sent, delivered, or with a designer.
 */
export function redoText(stage: string, requestTitle: string, lang: Lang, started = false): string {
  const t = { title: title({ title: requestTitle }, lang) };
  if (started) return say(ROUTING_MESSAGES.redoStarted, lang, t);
  const phrase = stage === 'designing' || stage === 'awaiting_answer' ? ROUTING_MESSAGES.redoWhileDesigning
    : stage === 'manual' ? ROUTING_MESSAGES.redoPassedDesigner
      : stage === 'approved' || stage === 'delivering' ? ROUTING_MESSAGES.redoPassedApproved
        : stage === 'delivered' ? ROUTING_MESSAGES.redoPassedDelivered : ROUTING_MESSAGES.redoWithOffice;
  return say(phrase, lang, t);
}

/** The requester's answer to a note kept on a request (a change or a cancel). */
export function noteText(note: 'change' | 'cancel' | 'hold', stage: string, requestTitle: string, lang: Lang, held = false, redo = false): string {
  if (redo && note === 'change') return redoText(stage, requestTitle, lang);
  const t = { title: title({ title: requestTitle }, lang) };
  if (note === 'cancel') return say(ROUTING_MESSAGES.cancelAsked, lang, t);
  if (note === 'hold') return say(held ? ROUTING_MESSAGES.holdConfirmed : ROUTING_MESSAGES.holdAsked, lang, t);
  // ADR-230 section 6: a change kept while a draft is being made is applied in a new round when it finishes.
  if (stage === 'designing') return say(ROUTING_MESSAGES.changeAddedNextRound, lang, t);
  if (stage === 'manual' || stage === 'awaiting_answer') return say(ROUTING_MESSAGES.changeAddedWhileDesigning, lang, t);
  if (stage === 'delivering') return say(ROUTING_MESSAGES.changePassedDelivering, lang, t);
  if (stage === 'delivered') return say(ROUTING_MESSAGES.changePassedDelivered, lang, t);
  return say(ROUTING_MESSAGES.changePassedInReview, lang, t);
}

/**
 * The requester's answer when approval, timing or file words were passed to the office. `alerted`: the
 * office chat was told; a request about the files with no office chat to tell is only kept (ADR-156).
 */
export function tellText(note: TellNote, requestTitle: string, lang: Lang, alerted = true): string {
  if (note === 'delivery') {
    return alerted ? say(ROUTING_MESSAGES.deliveryRequestPassed, lang, { title: title({ title: requestTitle }, lang) })
      : say(ROUTING_MESSAGES.keptForOffice, lang);
  }
  return say(note === 'approval' ? ROUTING_MESSAGES.approvalPassed : ROUTING_MESSAGES.deadlinePassed, lang,
    { title: title({ title: requestTitle }, lang) });
}

const TELL_STAGE: Record<RequestStage, string> = {
  designing: 'still being designed', awaiting_answer: 'waiting for their answer to a question', in_review: 'waiting for office review',
  manual: 'with a designer', approved: 'approved', delivering: 'being delivered', delivered: 'delivered',
};

/** The office's alert for approval, timing or file words (plain text: the words are quoted as sent). */
export function tellOfficeAlert(note: TellNote, input: { who: string; taskId: string; title: string; words: string;
  stage?: RequestStage }): string {
  const name = `"${shortTitle(input.title)}"`;
  return [
    note === 'approval'
      ? `${input.who} says they are happy with ${name}. Nothing was approved by this: an office member still approves it in the Desk.`
      : note === 'delivery'
        ? `${input.who} asks about the files of ${name}${input.stage ? ` (${TELL_STAGE[input.stage]})` : ''}: to send them again, in another format, to an address or at a higher resolution. Nothing was sent automatically; please answer them in the chat.`
        : `${input.who} gave a deadline or asked for speed on ${name}.`,
    '',
    'Their words:',
    quotedWords(input.words),
    '',
    deskSearchLine([input.taskId]),
  ].join('\n');
}
