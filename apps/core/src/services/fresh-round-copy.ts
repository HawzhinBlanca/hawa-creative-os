/**
 * ADR-233: what a fresh round (a redo, or changes sent while the first draft was being made) carries.
 *
 * A fresh round is a new design of its request: the request's copy, photos and format, with the
 * requester's words as art direction for the studio, never as text to print. Changes sent while the
 * first draft was made may also add or alter the design's words ("also please add that seats are
 * limited", live test L8). Those are applied to the copy only when the words to print can be rebuilt
 * from the requester's own message by ADR-232's grounding guard, and an alteration only when the words
 * it replaces stand exactly once in the copy. Anything else about the text (a removal, "add the date",
 * "change the time") cannot be applied safely: the round does not start and the draft goes to the
 * office with the changes listed (ADR-230 §6's fallback). No model is asked.
 */
import { groundLine, readsAsInstruction } from './request-copy-extraction.js';

const ws = (text: string) => text.replace(/\s+/g, ' ').trim();
const isArabic = (text: string) => /[؀-ۿ]/.test(text);
const MAX_BLOCKS = 16;

/** The line a fresh round adds to the design instructions: the requester's words, as direction. */
export function freshDirectionLine(kind: 'redo' | 'pending_changes', directive: string): string {
  const words = ws(directive).slice(0, 2000);
  return kind === 'redo'
    ? `Redo requested: make a new, different design of this request (the earlier design stays as it is). The requester's words about the earlier version, as art direction, not text to print: "${words}"`
    : `Changes the requester sent while the first draft was being made, as art direction (any words to print are already in the copy): "${words}"`;
}

export interface CopyBlock { id: string; role: string; text: string; language: string; direction: string; approved: boolean; protectedTokens?: unknown[] }
export interface CopyFields { headlineEn?: string | null; headlineCkb?: string | null; copyEn?: string | null; copyCkb?: string | null }

export type PendingCopyPlan =
  | { ok: true; exactCopy: CopyBlock[]; fields: CopyFields;
      applied: Array<{ words: string; kind: 'added' | 'altered'; text: string; replaced?: string }>; direction: string[] }
  | { ok: false; words: string; why: string };

// Words before the change itself: "also", "and", "please", "can you" …
const LEAD = /^(?:(?:and|also|oh|ok|okay|sorry|plus|pls|please|kindly|then|one more thing|can you|could you|would you|can u|could u|you can|we need to|i need you to|i forgot to)[\s,:!-]+)+/iu;
const TAIL = /(?:[\s,]+(?:too|as well|also|please|pls|thanks|thank you|if possible))+[.!?]*$|[.!?]+$/iu;
const WHERE = /\s+(?:to|on|in|at|under|below|above|near)\s+(?:the\s+)?(?:design|poster|post|flyer|image|picture|graphic|card|bottom|top|end|footer|header|title|headline|corner)(?:\s+of\s+(?:it|the\s+\w+))?$/iu;
const ADD = /^(?:add|include|mention|write|say|put|state|insert)\b\s*/iu;
// "add that …", "add a line saying …", "add: …" name the words to print themselves.
const EXPLICIT = /^(?:(?:in\s+)?that\b|a\s+(?:line|note|sentence)\s+(?:saying|that\s+says|that\s+reads)\b|(?:the\s+)?(?:line|sentence|words?|text)\s*:|saying\b|:)\s*/iu;
const QUOTED = /^["“„«']([^"“”„«»]{1,300})["”»']$/u;
const DETERMINER = /^(?:the|a|an|our|my|their|your|its|this|that|these|those|some|more|another|bigger|larger|smaller)\b/iu;
const VISUAL = /\b(?:logos?|photos?|pictures?|images?|qr|icons?|border|frame|shadows?|colou?rs?|background|fonts?|pattern|illustrations?|graphics?|stickers?|map|arrow|shapes?)\b/iu;
const ALTER = /^(?:change|replace|correct|update|fix|swap)\s+(?:the\s+\w+\s+)?(?:from\s+)?(?<from>.+?)\s+(?:to|with|into|by|say|read)\s+(?<to>.+)$/iu;
const REMOVE = /^(?:remove|delete|drop|take\s+out|cut|leave\s+out|don'?t\s+(?:show|include|mention|write))\b/iu;
// About the words of the design, though not an add or an alteration we can match.
const ABOUT_TEXT = /\b(?:text|wording|words?|title|headline|date|time|spelling|typo|line|sentence|phone|number|address|name|price|venue|location|caption|copy|hashtag|link|website|email)\b/iu;
// How the words look, not what they say: art direction.
const STYLE = /\b(?:bigger|smaller|larger|bold(?:er)?|colou?r(?:ed|s)?|fonts?|darker|lighter|brighter|cent(?:re|er)(?:ed)?|move|higher|lower|left|right|position|spacing|size|clearer|readable|visible|stand\s+out|thinner|thicker|italic|underline)\b/iu;
// Sorani for add, write, put, change, remove: about the words, with no grounded reading here.
const CKB_TEXT_CHANGE = /(?:زیاد\s*(?:ی\s*)?بکە|بنووسە|دابنێ|بگۆڕە|لاببە|بسڕەوە|ڕاست\s*بکەرەوە)/u;
const GENERIC = new Set([...'text wording words word title headline date time spelling typo line sentence phone number address name price venue location caption copy hashtag link website email the a an our my of'.split(' ')]);

const unquote = (text: string) => { const m = QUOTED.exec(text.trim()); return m ? m[1].trim() : text.trim(); };

/** Where `needle` stands in `hay` at word boundaries, ignoring case: every start index. */
function wordMatches(hay: string, needle: string): number[] {
  const at: number[] = [];
  const lower = hay.toLowerCase(), n = needle.toLowerCase();
  if (!n || lower.length !== hay.length) return at;
  const word = /[\p{L}\p{N}\p{M}]/u;
  for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + 1)) {
    const before = i > 0 ? hay[i - 1] : '', after = hay[i + n.length] ?? '';
    if ((word.test(n[0]) && before && word.test(before)) || (word.test(n[n.length - 1]) && after && word.test(after))) continue;
    at.push(i);
  }
  return at;
}

/**
 * The copy of a fresh round for changes sent while its first draft was made: the parent's copy with
 * every change that adds or alters words applied, or the first change that cannot be applied safely.
 * Changes that are not about the words (colours, photos, layout) are returned as direction.
 */
export function planPendingCopyChanges(exactCopy: unknown[], fields: CopyFields, changes: string[]): PendingCopyPlan {
  const blocks = exactCopy.map((b) => ({ ...(b as CopyBlock) }));
  if (!blocks.length || blocks.some((b) => !b || typeof b.text !== 'string')) return { ok: false, words: changes[0] ?? '', why: 'the design has no copy to change' };
  const next: CopyFields = { ...fields };
  const applied: Extract<PendingCopyPlan, { ok: true }>['applied'] = [];
  const direction: string[] = [];
  for (const raw of changes) {
    const words = ws(raw);
    const body = words.replace(LEAD, '');
    const offset = words.length - body.length;
    const unsafe = (why: string): PendingCopyPlan => ({ ok: false, words, why });
    if (CKB_TEXT_CHANGE.test(body)) return unsafe('a change to the words in Sorani is left to the office');
    if (REMOVE.test(body) && ABOUT_TEXT.test(body) && !STYLE.test(body)) return unsafe('removing words from the design is left to the office');
    const add = ADD.exec(body);
    if (add) {
      let rest = body.slice(add[0].length);
      const explicit = EXPLICIT.exec(rest);
      if (explicit) rest = rest.slice(explicit[0].length);
      rest = rest.replace(TAIL, '').replace(WHERE, '').replace(TAIL, '').trim();
      const quoted = QUOTED.test(rest);
      const text = unquote(rest);
      if (!text) return unsafe('no words to add were given');
      if (!explicit && !quoted) {
        // "add the logo", "add more photos": art direction. "add the date", "add our phone number": the
        // words to print are not in the message, so nothing is made up.
        if (VISUAL.test(text.split(/\s+/).slice(0, 4).join(' '))) { direction.push(words); continue; }
        if (DETERMINER.test(text)) return unsafe('the words to add were not given');
      }
      const start = offset + body.indexOf(rest) + (quoted ? 1 : 0);
      const grounded = groundLine(words, text, [[0, Math.max(0, start)]]);
      if (!grounded.ok) return unsafe(`the words to add could not be taken from the message (${grounded.why})`);
      if (blocks.length >= MAX_BLOCKS) return unsafe('the design already carries as many lines as it can');
      if (blocks.some((b) => ws(b.text).toLowerCase() === grounded.text.toLowerCase())) { applied.push({ words, kind: 'added', text: grounded.text }); continue; }
      const ar = isArabic(grounded.text);
      blocks.push({ id: `pending_copy_${blocks.length}`, role: 'body', text: grounded.text, language: ar ? 'ckb' : 'en',
        direction: ar ? 'rtl' : 'ltr', approved: true, protectedTokens: [] });
      const key = ar ? 'copyCkb' : 'copyEn';
      next[key] = [next[key], grounded.text].filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).join('\n');
      applied.push({ words, kind: 'added', text: grounded.text });
      continue;
    }
    const alter = ALTER.exec(body.replace(TAIL, ''));
    if (alter?.groups) {
      const from = unquote(alter.groups.from.replace(/^the\s+/iu, ''));
      const to = unquote(alter.groups.to.replace(TAIL, '').trim());
      const hits = blocks.flatMap((b, i) => wordMatches(b.text, from).map((at) => ({ i, at })));
      // "change the time to 11:00" names a field, not words: which words to replace is not certain.
      if (!from || from.toLowerCase().split(/\s+/).every((w) => GENERIC.has(w.replace(/[^\p{L}\p{N}]/gu, '')))) return unsafe('the words to change are not quoted from the design');
      if (hits.length !== 1) return unsafe(hits.length ? 'the words to change stand more than once in the design' : 'the words to change are not in the design as written');
      if (!to || readsAsInstruction(to) || VISUAL.test(to)) return unsafe('the new words could not be taken from the message');
      const grounded = groundLine(words, to, []);
      if (!grounded.ok) return unsafe(`the new words could not be taken from the message (${grounded.why})`);
      const { i, at } = hits[0];
      const old = blocks[i].text.slice(at, at + from.length);
      blocks[i] = { ...blocks[i], text: `${blocks[i].text.slice(0, at)}${grounded.text}${blocks[i].text.slice(at + from.length)}` };
      for (const key of ['headlineEn', 'headlineCkb', 'copyEn', 'copyCkb'] as const) {
        const value = next[key];
        if (typeof value !== 'string') continue;
        const found = wordMatches(value, from);
        if (found.length === 1) next[key] = `${value.slice(0, found[0])}${grounded.text}${value.slice(found[0] + from.length)}`;
      }
      applied.push({ words, kind: 'altered', text: grounded.text, replaced: old });
      continue;
    }
    if (ABOUT_TEXT.test(body) && !VISUAL.test(body) && !STYLE.test(body)) return unsafe('it is about the words of the design, and what to print could not be read from it safely');
    direction.push(words);
  }
  return { ok: true, exactCopy: blocks, fields: next, applied, direction };
}
