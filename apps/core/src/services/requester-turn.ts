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
 *  - only a new brief opens a request; a message that could be either asks one short question.
 */
import { escapeTelegramHtml } from '@hawa/integrations';
import { CHANGE_CUES, classifyWithHeuristics, containsKeyword, isAcknowledgement, isSoraniText } from './telegram-classifier.js';

export type TurnIntent = 'acknowledgement' | 'status' | 'approval' | 'cancel' | 'deadline' | 'change' |
  'new_brief' | 'conversation' | 'unclear';

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
}

export type Lang = 'en' | 'ckb';
export const langOf = (text: string): Lang => (isSoraniText(text) ? 'ckb' : 'en');

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
}

/** A question this bot asked the sender, still open: its own update, the words it holds, the options. */
export interface PendingAsk {
  updateId: number;
  intent: Exclude<TurnIntent, 'acknowledgement' | 'status' | 'new_brief' | 'conversation'>;
  words: string;
  options: Array<{ requestId: string; title: string }>;
  allowNew: boolean;
}

export type TurnPlan =
  | { kind: 'open'; text: string; instructionOnly: boolean; resolves?: number }
  | { kind: 'revise'; requestId: string; directive: string; resolves?: number }
  | { kind: 'note'; note: 'change' | 'cancel'; requestId: string; words: string; resolves?: number }
  | { kind: 'tell'; note: 'approval' | 'deadline'; requestId: string; words: string; resolves?: number }
  | { kind: 'reply'; what: 'thanks' | 'status' | 'nothing-to-change'; requestIds: string[] }
  /** Words about a design this bot cannot find (a reply to an old message): passed to the office. */
  | { kind: 'forward'; words: string }
  | ({ kind: 'ask' } & Omit<PendingAsk, 'updateId'>)
  | { kind: 'passive'; reason: string }
  | { kind: 'conversation' };

// ---------------------------------------------------------------------------------------------
// Reading the words
// ---------------------------------------------------------------------------------------------

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

const CANCEL_EN = new RegExp(
  '^(?:(?:just|kindly)\\s+)?(?:cancel|stop|scrap|drop|abort|withdraw|forget(?:\\s+about)?|never\\s?mind|nvm|' +
  "don'?t\\s+(?:do|make|bother\\s+with|continue(?:\\s+with)?|proceed(?:\\s+with)?)|no\\s+need\\s+(?:for|to\\s+(?:do|make))|" +
  "(?:we|i)\\s+(?:don'?t|do\\s+not|no\\s+longer)\\s+need|(?:we|i)\\s+(?:want|would\\s+like)\\s+to\\s+cancel|" +
  "(?:it'?s|it\\s+is)\\s+(?:cancel+ed|not\\s+needed)|not\\s+needed|no\\s+longer\\s+needed)" +
  '(?:\\s+(?:it|that|this|them|these|everything|all(?:\\s+of\\s+(?:it|them))?|' +
  '(?:the|my|our|this|that)\\s+(?:[\\p{L}\\d\'-]+\\s+){0,3}?(?:request|order|job|design|poster|flyer|banner|invitation|card|post|story|work|one|thing)s?))?' +
  '(?:\\s+(?:any\\s?more|now|for\\s+now|then|please|thanks?|thank\\s+you))*[\\s!.]*$', 'iu');
/** Sorani: cancel it, stop it, not needed, we don't need it, don't make it, leave it, give it up. */
const CANCEL_CKB = ['هەڵیوەشێنەوە', 'هەڵبوەشێنەوە', 'هەڵوەشێنەوە', 'هەڵیبوەشێنەوە', 'ڕایبگرە', 'بیوەستێنە',
  'ڕاوەستە', 'پێویست ناکات', 'پێویستمان نییە', 'پێویستم نییە', 'مەیکە', 'لێی گەڕێ', 'وازی لێ بێنە'];

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

/** A request for a new design ("Can you make a poster for Nawroz?"), greeting or not. */
export function asksForNewDesign(text: string): boolean {
  const t = clean(text);
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
  if (core.length > 160 || !any(core, APPROVAL_PHRASES)) return false;
  let rest = core;
  for (const phrase of APPROVAL_PHRASES) rest = rest.replace(new RegExp(phrase.replace(/\s+/g, '\\s+'), 'giu'), ' ');
  rest = rest.replace(PRAISE, ' ').replace(/[\s,،!.:;-]+/g, ' ').trim();
  return !readsAsChange(rest) && !asksForNewDesign(text);
}

function readsAsCancel(core: string): boolean {
  if (!core || core.length > 160) return false;
  if (CANCEL_EN.test(core)) return true;
  return isSoraniText(core) && core.split(/\s+/).length <= 4 && any(core, CANCEL_CKB);
}

function readsAsStatus(core: string): boolean {
  if (!core || core.length > 140) return false;
  if (STATUS_EN.some((p) => p.test(core))) return !asksForNewDesign(core);
  if (!isSoraniText(core) || core.length > 80) return false;
  return (containsKeyword(core, STATUS_CKB_WHEN) && any(core, STATUS_CKB_WITH)) || any(core, STATUS_CKB);
}

function readsAsDeadline(text: string, core: string): boolean {
  if (!core || core.length > 160 || asksForNewDesign(text)) return false;
  if (URGENT.test(core)) return true;
  if (DEADLINE_WHEN.test(core) && DEADLINE_NEED.test(core)) return true;
  if (/^(?:by|before)\s+/i.test(core) && DEADLINE_WHEN.test(core)) return true;
  return isSoraniText(core) && core.length <= 100 && any(core, DEADLINE_CKB);
}

const FULL_BRIEF_REASON = 'Complete design brief with structured copy and event details detected';
const EXPLICIT_NEW = /\b(?:new\s+(?:poster|design|flyer|banner|brief|invitation|one|request)|another\s+(?:poster|design|event|flyer|banner|one|invitation))\b|(?:دیزاینێکی\s+نوێ|پۆستەری\s+نوێ|داواکارییەکی\s+نوێ)/iu;

/**
 * The rules' reading of a message, without context. Order matters: approval and thanks before
 * anything that could start work; cancel, status and deadline before a change; a request for a new
 * design before a change ("can you make a poster" is new, "can you make the poster brighter" is not).
 */
export function readIntentByRules(text: string): IntentReading {
  const t = clean(text);
  const core = corePhrase(t);
  const rules = (intent: TurnIntent, reason: string, extra: Partial<IntentReading> = {}): IntentReading =>
    ({ intent, reason, source: 'rules', ...extra });
  if (!t) return rules('conversation', 'No words');
  if (t.startsWith('/')) return rules('conversation', 'A chat command');
  if (readsAsApproval(t, core)) return rules('approval', 'Approval words; the office decides');
  if (isAcknowledgement(t) || (core && isAcknowledgement(core) && core.length <= 60)) return rules('acknowledgement', 'Thanks, an OK or a receipt');
  if (readsAsCancel(core)) return rules('cancel', 'Asks to cancel or stop');
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
    return rules('new_brief', designRequest ? 'Asks for a new design' : 'Said to be a new design', {
      explicitNew: true, substantial,
      instructionOnly: heuristics.kind !== 'new_brief' || heuristics.isInstructionOnly === true || (!substantial && !fullBrief),
    });
  }
  if (!fullBrief && readsAsChange(t)) return rules('change', 'Asks for a change or a correction');
  if (heuristics.kind === 'new_brief') {
    return rules(substantial ? 'new_brief' : 'unclear', substantial ? 'Carries copy or event detail'
      : 'A short message that could be a new brief or a note about a current design',
    { substantial, instructionOnly: heuristics.isInstructionOnly === true });
  }
  if (heuristics.kind === 'feedback') return rules('change', 'Asks for a change or a correction');
  return rules('conversation', heuristics.reason);
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
/** "change", "the same", "yes", "that one"; Sorani "yes", "edit", "the same". */
const SAYS_CHANGE = /^(?:(?:a\s+)?change|(?:the\s+)?same(?:\s+one)?|yes|yeah|yep|that\s+one|this\s+one|edit|revise|revision|correction)\b|^(?:بەڵێ|بەلێ|دەستکاری|هەمان|گۆڕانکاری)/iu;
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

/** An answer to an open question, or null when the message is not one (it is then read on its own). */
export function parseChoice(text: string, ask: Pick<PendingAsk, 'options' | 'allowNew'>): { option: number } | { new: true } | null {
  const t = corePhrase(text).replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d).toLowerCase();
  if (!t || t.length > 80) return null;
  const n = ask.options.length;
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
    if (n === 1 && ask.allowNew && /^(?:no|nope|نەخێر|نا)\b/iu.test(t)) return { new: true };
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

const options = (requests: ChatRequestView[]) => requests.map((r) => ({ requestId: r.requestId, title: r.title }));

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

/** A brief opened after "new" was chosen drafts automatically only when it carries its own copy. */
function opensForAPerson(words: string): boolean {
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
    case 'cancel': return { kind: 'note', note: 'cancel', requestId: request.requestId, words, ...r };
    case 'approval': return { kind: 'tell', note: 'approval', requestId: request.requestId, words, ...r };
    case 'deadline': return { kind: 'tell', note: 'deadline', requestId: request.requestId, words, ...r };
    default: return changeFor(request, words, how, confidence, resolves);
  }
}

/** What to do with this message. Pure: the route records the plan once per update and carries it out. */
export function planTurn(input: TurnInput): TurnPlan {
  const { reading, requests } = input;
  // The words as sent (line breaks included): they become a brief, a directive or a note.
  const words = input.text.trim();
  const office = input.officeIds.includes(input.senderId);
  // In a group, only the request's own requester (or an office member) may change it (F8).
  const mayAct = (r: ChatRequestView) => !input.group || office || !r.requesterId || r.requesterId === input.senderId;

  // 1. An answer to the question this bot just asked the sender.
  // A reply to some other request's message is about that request, not an answer to the question.
  if (input.pendingAsk && (input.repliedToAsk || !input.bound.length)) {
    const choice = parseChoice(words, input.pendingAsk);
    if (choice) {
      const ask = input.pendingAsk;
      if ('new' in choice) return { kind: 'open', text: ask.words, instructionOnly: opensForAPerson(ask.words), resolves: ask.updateId };
      const chosen = requests.find((r) => r.requestId === ask.options[choice.option]?.requestId);
      if (chosen && mayAct(chosen)) {
        const plan = applyTo(ask.intent, chosen, ask.words, 'named', undefined, ask.updateId);
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

  const changeable = requests.filter((r) => CHANGEABLE.includes(r.stage) && mayAct(r));
  const open = requests.filter((r) => OPEN_STAGES.includes(r.stage) && mayAct(r));
  const ask = (intent: PendingAsk['intent'], among: ChatRequestView[], allowNew: boolean): TurnPlan =>
    ({ kind: 'ask', intent, words, options: options(among), allowNew });

  // 3. A reply to a bot message about no current request: thanks, a status question, chatter and a
  // brief of its own are read as usual; anything else is about another design, so the requester is
  // asked which current design they mean, or, with none, the words go to the office.
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
      return { kind: 'conversation' };
    case 'approval':
    case 'deadline':
    case 'cancel': {
      const picked = pickRequest(input, open, true);
      if ('request' in picked) return applyTo(reading.intent, picked.request, words, picked.how, reading.confidence) ?? ask(reading.intent, [picked.request], false);
      if ('ambiguous' in picked) return ask(reading.intent, picked.ambiguous, false);
      // Nothing open: thanks, or where the chat stands, is all there is to say.
      return { kind: 'reply', what: reading.intent === 'approval' ? 'thanks' : 'status', requestIds: [] };
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
        const h = classifyWithHeuristics(words, false, false);
        return h.kind === 'new_brief' ? { kind: 'open', text: words, instructionOnly: true } : { kind: 'conversation' };
      }
      const picked = pickRequest(input, changeable, true);
      if ('request' in picked) {
        return changeFor(picked.request, words, picked.how, reading.confidence) ?? ask('change', [picked.request], false);
      }
      if ('ambiguous' in picked) return ask('change', picked.ambiguous, false);
      return { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
    }
    case 'unclear': {
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
// What the requester hears. New strings only (ADR-144); every Sorani line awaits native review.
// ---------------------------------------------------------------------------------------------

const title = (r: { title: string }) => `<b>${escapeTelegramHtml(shortTitle(r.title))}</b>`;
export function shortTitle(value: string): string {
  const t = String(value || '').replace(/^[^:]{1,40}:\s*/, '').replace(/\s+/g, ' ').trim() || 'your design';
  return Array.from(t).length > 60 ? `${Array.from(t).slice(0, 59).join('')}…` : t;
}

const STATUS_LINE: Record<RequestStage | 'manual-waiting', { en: string; ckb: string }> = {
  designing: { en: '{t} is being designed right now. The draft usually takes a few minutes; the office checks it before it comes to you.',
    ckb: '{t} ئێستا دیزاین دەکرێت. ڕەشنووسەکە زۆرجار چەند خولەکێک دەخایەنێت؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات.' },
  manual: { en: 'A designer at the office is working on {t}. It will be sent here when it is ready.',
    ckb: 'دیزاینەرێک لە ئۆفیسەکە کار لەسەر {t} دەکات. کە ئامادە بوو لێرە بۆت دەنێردرێت.' },
  'manual-waiting': { en: '{t} is waiting for your changes. Just tell me what you would like changed.',
    ckb: '{t} چاوەڕێی گۆڕانکارییەکانی تۆیە. تەنها پێم بڵێ چیت دەوێت بگۆڕدرێت.' },
  awaiting_answer: { en: '{t} is waiting for your answer to one question: {q}',
    ckb: '{t} چاوەڕێی وەڵامی تۆیە بۆ یەک پرسیار: {q}' },
  in_review: { en: '{t} is with the office for a final check. It will be sent here once they approve it.',
    ckb: '{t} لای ئۆفیسەکەیە بۆ دوایین پشکنین. کە پەسەندیان کرد لێرە بۆت دەنێردرێت.' },
  approved: { en: '{t} is approved and will be sent to you shortly.',
    ckb: '{t} پەسەند کراوە و بەم زووانە بۆت دەنێردرێت.' },
  delivering: { en: '{t} is being sent to you now.', ckb: '{t} ئێستا بۆت دەنێردرێت.' },
  delivered: { en: '{t} has been delivered.', ckb: '{t} گەیەندرا.' },
};

export function statusText(requests: ChatRequestView[], lang: Lang): string {
  if (!requests.length) {
    return lang === 'ckb'
      ? 'ئێستا هیچ دیزاینێکم لەم چاتەدا لە دەستدا نییە. پێم بڵێ چیت دەوێت دیزاین بکرێت.'
      : "I don't have a design in progress in this chat right now. Tell me what you'd like designed.";
  }
  return requests.map((r) => {
    const key = r.stage === 'manual' && r.rev >= 3 ? 'manual-waiting' : r.stage;
    const q = r.question?.text ? escapeTelegramHtml(r.question.text) : '';
    return STATUS_LINE[key][lang].replace('{t}', title(r)).replace('{q}', q);
  }).join('\n\n');
}

export function thanksText(waiting: ChatRequestView[], lang: Lang): string {
  const base = lang === 'ckb' ? '🙏 سوپاس.' : '🙏 Thank you.';
  if (waiting.length !== 1) return base;
  return lang === 'ckb'
    ? `${base}\n\nهەر کاتێک ئامادە بوویت، پێم بڵێ چی لە ${title(waiting[0])} بگۆڕم.`
    : `${base}\n\nWhenever you're ready, just tell me what to change on ${title(waiting[0])}.`;
}

/** `alerted`: the office chat was told; without one the words are only kept for the office. */
export function forwardText(lang: Lang, alerted: boolean): string {
  if (!alerted) {
    return lang === 'ckb' ? 'پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ لێرە وەڵامت دەدەنەوە.'
      : "I've kept your message for the office; they'll follow up here.";
  }
  return lang === 'ckb' ? 'پەیامەکەتم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.'
    : "I've passed your message to the office; they'll follow up here.";
}

/** The office's alert for words about a design this bot cannot link to a current request. */
export function forwardOfficeAlert(chatId: string, words: string): string {
  const quoted = words.length > 1500 ? `${words.slice(0, 1500)}…` : words;
  return [`The requester in chat ${chatId} replied to an older bot message that no current design is linked to. Nothing was changed.`,
    '', 'Their words:', quoted].join('\n');
}

export function nothingToChangeText(lang: Lang): string {
  return lang === 'ckb'
    ? 'ئێستا هیچ دیزاینێکم لە دەستدا نییە بۆ گۆڕین. پێم بڵێ چیت دەوێت دیزاین بکرێت، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت.'
    : "I don't have a design in progress here to change. Tell me what you'd like designed, with the text that should go on it.";
}

export function askText(plan: Extract<TurnPlan, { kind: 'ask' }>, lang: Lang): string {
  const list = plan.options.map((o, i) => `${i + 1}. ${title(o)}`);
  if (plan.options.length === 1 && plan.allowNew) {
    return lang === 'ckb'
      ? `ئەمە گۆڕانکارییە لە ${title(plan.options[0])}، یان دیزاینێکی نوێیە؟ تەنها بنووسە «گۆڕانکاری» یان «نوێ».`
      : `Is this a change to ${title(plan.options[0])}, or a new design? Just say “change” or “new”.`;
  }
  if (plan.options.length === 1) {
    const what = plan.intent === 'cancel'
      ? { en: `Do you want me to ask the office to cancel ${title(plan.options[0])}? Just say “yes”.`,
        ckb: `دەتەوێت داوا لە ئۆفیسەکە بکەم ${title(plan.options[0])} هەڵبوەشێنێتەوە؟ تەنها بنووسە «بەڵێ».` }
      : { en: `Is this for ${title(plan.options[0])}? Just say “yes”.`,
        ckb: `ئەمە بۆ ${title(plan.options[0])}ە؟ تەنها بنووسە «بەڵێ».` };
    return what[lang];
  }
  if (plan.allowNew) list.push(`${plan.options.length + 1}. ${lang === 'ckb' ? 'دیزاینێکی نوێ' : 'A new design'}`);
  return lang === 'ckb'
    ? `ئەمە بۆ کام دیزاینە؟\n${list.join('\n')}\n\nبە ژمارە یان ناو وەڵام بدەرەوە.`
    : `Which design is this for?\n${list.join('\n')}\n\nAnswer with the number or the name.`;
}

/** The requester's answer to a note kept on a request (a change or a cancel). */
export function noteText(note: 'change' | 'cancel', stage: string, requestTitle: string, lang: Lang): string {
  const t = title({ title: requestTitle });
  if (note === 'cancel') {
    return lang === 'ckb' ? `باشە. داوام لە ئۆفیسەکە کرد کە ${t} هەڵبوەشێنێتەوە.`
      : `OK. I've asked the office to cancel ${t}.`;
  }
  if (stage === 'designing' || stage === 'manual' || stage === 'awaiting_answer') {
    return lang === 'ckb'
      ? `تێگەیشتم. ئەوەم بۆ ${t} زیاد کرد؛ ئۆفیسەکە پێش ناردنی دیزاینەکە دەیبینێت.`
      : `Got it. I've added that to ${t}; the office will see it before the design is sent to you.`;
  }
  if (stage === 'delivering') {
    return lang === 'ckb' ? `${t} ئێستا بۆت دەنێردرێت؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە.`
      : `${t} is being sent to you now; I've passed your change to the office.`;
  }
  if (stage === 'delivered') {
    return lang === 'ckb' ? `${t} پێشتر گەیەندرابوو؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە.`
      : `${t} was already delivered; I've passed your change to the office.`;
  }
  return lang === 'ckb' ? `تێگەیشتم. ئۆفیسەکە ئێستا سەیری ${t} دەکات، و گۆڕانکارییەکەتم پێیان گەیاند.`
    : `Got it. The office is checking ${t} now, and I've passed your change to them.`;
}

/** The requester's answer when approval or timing words were passed to the office. */
export function tellText(note: 'approval' | 'deadline', requestTitle: string, lang: Lang): string {
  const t = title({ title: requestTitle });
  if (note === 'approval') {
    return lang === 'ckb' ? `سوپاس! بە ئۆفیسەکەم ڕاگەیاند کە تۆ ڕازیت بە ${t}. پێش ناردن بۆ دواجار سەیری دەکەن.`
      : `Thanks! I've told the office you're happy with ${t}. They give it a final check before it's sent.`;
  }
  return lang === 'ckb' ? `تێبینی کرا. سەبارەت بە کاتی ${t} ئۆفیسەکەم ئاگادار کردەوە.`
    : `Noted. I've told the office about the timing for ${t}.`;
}

/** The office's alert for approval or timing words (plain text: the words are quoted as sent). */
export function tellOfficeAlert(note: 'approval' | 'deadline', input: { chatId: string; requestId: string;
  taskId: string; title: string; words: string }): string {
  const words = input.words.length > 1500 ? `${input.words.slice(0, 1500)}…` : input.words;
  return [
    note === 'approval'
      ? `The requester in chat ${input.chatId} says they are happy with "${shortTitle(input.title)}". Nothing was approved: approval stays in the Desk.`
      : `The requester in chat ${input.chatId} gave a deadline or asked for speed on "${shortTitle(input.title)}".`,
    `Task ${input.taskId}, request ${input.requestId}.`,
    '',
    'Their words:',
    words,
  ].join('\n');
}
