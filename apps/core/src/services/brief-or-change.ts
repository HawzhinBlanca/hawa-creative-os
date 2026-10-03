/**
 * ADR-250 (live L19, 2026-10-02): words the rules read as a brief of their own, sent while the chat has
 * a design on the way, that edit that design.
 *
 * "can you take KAAE's out of the title? just Quality Assurance Workshop", sent while the poster it
 * came from waited for the office's approval, was read as a full new brief (it names an event, the
 * workshop, in more than eight words), and a request that waits for the office is no design "waiting
 * for the requester's changes", so `planTurn` opened a second request and a second paid round. The
 * words name a part of a design the chat already has ("the title") and say what to do with it ("take
 * … out"): they are a change, kept for the office on that design (ADR-230) or a round on a design that
 * waits for changes. Words that only repeat the name of a design on the way, without copy of their
 * own, may be its corrected copy: the requester is asked "a change to it, or a new design?".
 *
 * Words with copy of their own (an event with its date or time, or several event details), a request
 * for a design ("Can you make a poster for …"), "/new", or a chat with nothing on the way are left as
 * the rules read them: a new brief opens, as before.
 */
import { carriesBriefCopy, corePhrase, planTurn, type ChatRequestView, type IntentReading, type TurnInput,
  type TurnPlan } from './requester-turn.js';

/** Stages of a design still on the way: a change to it is still possible before it reaches the requester. */
const ON_THE_WAY: ReadonlyArray<ChatRequestView['stage']> = ['designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering'];

/** A part of a design the chat already has, named as that one ("the title", "its logo", "this poster"). */
const PART_EN = '(?:title|headline|heading|sub-?title|sub-?heading|tagline|slogan|name|text|wording|words?|line|sentence|caption|' +
  'logo|date|time|venue|location|address|phone(?:\\s+number)?|colou?rs?|background|photo|picture|image|font|spelling|border|frame|' +
  'design|poster|flyer|banner|draft|card|invitation|post|story)';
const DEFINITE_PART_EN = new RegExp(`\\b(?:the|its|this|that|your|our)\\s+(?:[\\p{L}'’-]+\\s+){0,2}?${PART_EN}s?\\b|\\b(?:it|this\\s+one)\\b`, 'iu');
/** Sorani: the same parts, made definite ("ناونیشانەکە", the title) or pointed at ("ئەم پۆستەرە", this poster). */
const DEFINITE_PART_CKB = /(?:ناونیشان|سەردێڕ|ناو|دەق|نووسین|لۆگۆ|لۆگۆی|ڕەنگ|بەروار|کات|شوێن|وێنە|فۆنت|باکگراوند|باگراوند|پۆستەر|دیزاین|ڕستە|دێڕ)(?:ەکە|ەکان)|(?:ئەم|ئەو)\s+(?:پۆستەر|دیزاین)ە/u;

/** Words that undo or replace something already there: the requester is editing, not briefing. */
const EDITS_EN = /\b(?:take|get|leave|cut|keep|strip)\s+(?:\S+\s+){0,5}?(?:out|off|away)\b|\b(?:remove|delete|drop|erase|omit|get\s+rid\s+of|rename|retitle|shorten|reword|rephrase|replace|swap|change|fix|correct|without)\b|\binstead\b|\brather\s+than\b|\bshould\s+(?:only\s+|just\s+)?(?:be|say|read)\b/iu;
/** Words that add or arrange: an edit when said of a part of a current design, but a brief may say them too. */
const ARRANGES_EN = /\b(?:make|put|add|move|use|write|spell|enlarge|increase|decrease)\b/iu;
const EDITS_CKB = /(?:لاببە|لابە|لابدە|لابەرە|لاببەن|بسڕەوە|بسڕنەوە|دەربهێنە|دەریبهێنە|بگۆڕە|بیگۆڕە|بگۆڕن|چاک\s*بکە|ڕاست\s*بکەرەوە|لە\s+جیاتی)/u;

/**
 * Hunt 3 (2026-10-03): event copy said as an update of an event already known, not as a brief of its own: an apology
 * or a correction first ("sorry the workshop date is 16 October 2026"), a definite subject said to be somewhere or
 * at some time ("it's at the Divan hotel now, …", "the seminar is on 16 October …"), or a move ("we moved the
 * workshop to …", "postponed", "now", "instead"). Each opened a second request that drafted by itself while the
 * design it updated was on the way. The requester is asked "a change to it, or a new design?".
 */
const UPDATES_EN = /^(?:(?:sorry|actually|oh|oops|correction|update|small\s+change)\b|(?:it'?s|it\s+is|it\s+will\s+be|it'?ll\s+be|the\s+[\p{L}'’-]+(?:\s+[\p{L}'’-]+)?\s+(?:is|are|will\s+be|was|has\s+been|got)\b))|\b(?:now|instead|any\s?more|moved|postponed|rescheduled|delayed|brought\s+forward|changed)\b/iu;
/** Sorani: sorry, now, was postponed, was changed. Needs native review. */
const UPDATES_CKB = /^(?:ببورە|ئێستا)(?![\p{L}\p{M}])|(?:دواخرا|دواخراوە|گۆڕدرا|گۆڕا)(?![\p{L}\p{M}])/u;

/** Words that name an event: a brief may name its own; an edit names the design's. */
const NAMES_EVENT = /\b(?:workshop|seminar|conference|ceremony|party|dinner|meeting|graduation|wedding|festival|celebration|exhibition|fair|concert|launch|tournament|forum|summit|symposium|lecture|open\s+day|training|course|competition|campaign)\b|(?:سیمینار|کۆنفرانس|ئاهەنگ|فێستیڤاڵ|کۆبوونەوە|پێشانگا|وۆرکشۆپ|خول)/iu;

const STOP = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'please', 'design', 'poster', 'flyer', 'banner',
  'invitation', 'about', 'there', 'their', 'what', 'when', 'make', 'change', 'thanks', 'just', 'title', 'only',
  // Words many designs' names share: a name is repeated by its own words, not by "evening" or "workshop".
  'workshop', 'seminar', 'conference', 'ceremony', 'party', 'dinner', 'meeting', 'graduation', 'wedding', 'festival',
  'celebration', 'exhibition', 'concert', 'launch', 'tournament', 'forum', 'summit', 'symposium', 'lecture', 'training',
  'course', 'competition', 'campaign', 'event', 'evening', 'night', 'morning', 'annual', 'week', 'story', 'post', 'card']);
/** Dates are no name: a month and a number are shared by any two designs of the same week. */
const DATE_WORD = /^(?:\p{N}+|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u;
const tokens = (text: string) => new Set(String(text).toLowerCase().normalize('NFKC')
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w) && !DATE_WORD.test(w)));

/** Whether the words repeat most of a design's name (two words or more, half of its name or more). */
function repeatsName(text: string, requests: ChatRequestView[]): boolean {
  const said = tokens(text);
  return requests.some((r) => {
    const name = [...tokens(String(r.title).replace(/^[^:]{1,40}:\s*/, ''))];
    const shared = name.filter((w) => said.has(w)).length;
    return name.length > 0 && shared >= 2 && shared / name.length >= 0.5;
  });
}

/**
 * How words the rules read as a brief of their own edit a design on the way: 'change' (they undo or
 * replace a part of it), 'unclear' (they arrange a part of it, or repeat its name, and may still be a
 * new design), or null (a brief).
 */
export function editsADesignOnTheWay(text: string, requests: ChatRequestView[]): 'change' | 'unclear' | null {
  const core = corePhrase(text);
  if (!core || core.length > 400 || core.split(/\s+/).length > 60) return null;
  const repeats = repeatsName(core, requests);
  // An event with its date or time, or several event details: copy of its own, a brief. With the name of
  // a design on the way it may be that design's corrected copy, or a new edition: the requester is asked.
  if (carriesBriefCopy(core)) return repeats || UPDATES_EN.test(core) || UPDATES_CKB.test(core) ? 'unclear' : null;
  const part = DEFINITE_PART_EN.test(core) || DEFINITE_PART_CKB.test(core);
  if (part && (EDITS_EN.test(core) || EDITS_CKB.test(core))) {
    // "Remove the logo from the poster for our graduation ceremony" may be a brief that names its own event:
    // a change only when it names no event, or the event of a design on the way.
    return repeats || !NAMES_EVENT.test(core) ? 'change' : 'unclear';
  }
  if (part && ARRANGES_EN.test(core)) return 'unclear';
  return repeats ? 'unclear' : null;
}

/**
 * The plan for words `planTurn` would open as a new request (ADR-250): a change to the design on the way
 * they edit, or the question "a change to it, or a new design?". Null: the words open, as planned.
 */
export function reconsiderNewBrief(input: TurnInput, plan: TurnPlan): { reading: IntentReading; plan: TurnPlan } | null {
  const { reading } = input;
  // Hunt 3: words short of a brief of their own (an event named without its date) are read as unclear, and asked
  // "a change to it, or a new design?"; when they certainly edit a part of the design on the way ("the title should
  // just be Quality Assurance Workshop for university deans") they are its change, as when they read as a brief.
  const unclear = reading.intent === 'unclear' && !reading.cancelWords && !reading.redo;
  if ((reading.intent !== 'new_brief' && !unclear) || reading.explicitNew || reading.source !== 'rules') return null;
  // A brief planTurn opens, or asks about ("a change to it, or a new design?") because it repeats a design's words.
  const asked = plan.kind === 'ask' && plan.allowNew && !plan.redo && !plan.photo;
  if (!(plan.kind === 'open' && !plan.resolves) && !asked) return null;
  const office = input.officeIds.includes(input.senderId);
  // In a group, only a request's own requester (or an office member) changes it (F8).
  const onTheWay = input.requests.filter((r) => ON_THE_WAY.includes(r.stage) &&
    (!input.group || office || !r.requesterId || r.requesterId === input.senderId));
  if (!onTheWay.length) return null;
  const how = editsADesignOnTheWay(input.text, onTheWay);
  // Already asked about: only words that certainly edit the design are taken as its change.
  if (!how || (asked && how !== 'change')) return null;
  const again: IntentReading = { ...reading, intent: how, substantial: false, instructionOnly: true,
    reason: how === 'change' ? 'Edits a part of a design on the way (ADR-250)' : 'Names a design on the way; may be a change or a new design (ADR-250)' };
  // Only the designs on the way are offered; a delivered one is no target of words read as a brief.
  const next = planTurn({ ...input, reading: again, requests: input.requests.filter((r) => ON_THE_WAY.includes(r.stage)) });
  return ['note', 'revise', 'ask'].includes(next.kind) ? { reading: again, plan: next } : null;
}
