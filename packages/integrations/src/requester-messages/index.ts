/**
 * Everything the bot says to a requester, in one place (ADR-145).
 *
 * Requesters are the office's clients and colleagues: non-technical people who write in English,
 * Sorani Kurdish or both. What they hear never names a command, never asks them to reply to a
 * particular message, never asks for a format or a keyword, and never shows the office's own words
 * (task ids, revisions, the Desk, the lifecycle). Office-facing alerts are not here: they keep their
 * precise terms and stay beside the code that sends them.
 *
 * Every phrase has an English and a Sorani version. Every Sorani version is new or reworded and waits
 * for a native speaker's review before release: plans/lean-design-implementation-2026-09-28/
 * SORANI_REVIEW.md lists them all (a test keeps that list in step with this catalogue).
 *
 * Placeholders are `{name}`. Values are inserted as given: a caller that sends HTML escapes them (see
 * `bold`), and a caller that sends plain text passes plain text.
 */
import { SOURCE_MESSAGES } from './sources.js';
import { MEDIA_MESSAGES } from './media.js';
import { INBOX_MESSAGES } from './inbox.js';
import { ACCESS_MESSAGES } from './access.js';
import { ROUTING_MESSAGES } from './routing.js';
import { CONVERSATION_MESSAGES } from './conversation.js';
import { LIFECYCLE_MESSAGES } from './lifecycle.js';
import { OUTCOME_MESSAGES } from './outcomes.js';
import { ALBUM_MESSAGES } from './albums.js';
import { OFFICE_MESSAGES } from './office.js';
// ADR-230: withdrawing a request.
import { WITHDRAW_MESSAGES } from './withdraw.js';
import { PENDING_ROUND_MESSAGES } from './pending-round.js';
import { NAMING_MESSAGES } from './naming.js';
// ADR-235: who a design is for.
import { CLIENT_QUESTION_MESSAGES } from './client-question.js';
// ADR-250: a brief the bot cannot start by itself.
import { INTAKE_LIMIT_MESSAGES } from './intake-limits.js';

import type { Phrase, PhraseBook, RequesterLang } from './types.js';

export type { Phrase, PhraseBook, RequesterLang } from './types.js';
/** ADR-231: a design's name as a requester reads it. */
export { requesterTitleName, trimTitleMarks } from './titles.js';

const letters = (text: string, script: RegExp) => Array.from(text).filter((ch) => script.test(ch) && /\p{L}/u.test(ch)).length;
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;

/**
 * The language to answer in: Sorani when the message is written mostly in Arabic script (Sorani uses
 * it), English when mostly in Latin letters. A mixed message follows the script with more letters; a
 * tie goes to Sorani, since a Sorani requester often writes names and brands in Latin letters. A
 * message with no letters (an emoji, a number, a photo without a caption) takes `fallback`.
 */
export function requesterLang(text: string | null | undefined, fallback: RequesterLang = 'en'): RequesterLang {
  const t = String(text ?? '');
  const arabic = letters(t, ARABIC_SCRIPT);
  const latin = letters(t, LATIN_SCRIPT);
  if (!arabic && !latin) return fallback;
  return arabic >= latin ? 'ckb' : 'en';
}

/** Fills `{name}` placeholders; an unknown placeholder is left as it is, so a test can see it. */
export function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole);
}

/** The phrase in the requester's language, with its placeholders filled. */
export function say(phrase: Phrase, lang: RequesterLang, params: Record<string, string | number> = {}): string {
  return fill(phrase[lang], params);
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A design's name as the requester sees it: bold, escaped for Telegram HTML. */
export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

/**
 * ADR-200 addendum: the name of a request opened from words that name no design ("do a better
 * design", "make me a nice poster"), for the office: "New design request from Sewa". The requester
 * hears "your design" in its place (`isNeutralRequestTitle`), never the sentence they sent.
 */
export function neutralRequestTitle(senderName: string | null | undefined): string {
  const name = Array.from(String(senderName ?? '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
  return `New design request from ${name || 'a requester'}`;
}
export const isNeutralRequestTitle = (name: string | null | undefined) => /^New design request from\s/.test(String(name ?? '').trim());

/** The whole catalogue, by section: the review list and the wording tests read it. */
export const REQUESTER_CATALOGUE = {
  sources: SOURCE_MESSAGES,
  media: MEDIA_MESSAGES,
  inbox: INBOX_MESSAGES,
  access: ACCESS_MESSAGES,
  routing: ROUTING_MESSAGES,
  conversation: CONVERSATION_MESSAGES,
  lifecycle: LIFECYCLE_MESSAGES,
  outcomes: OUTCOME_MESSAGES,
  albums: ALBUM_MESSAGES,
  /** ADR-040 addendum: to an office member deciding on a draft in Telegram (office terms allowed). */
  office: OFFICE_MESSAGES,
  /** ADR-230: a request withdrawn by its requester or the office, or a cancel that came too late. */
  withdraw: WITHDRAW_MESSAGES,
  /** ADR-230 addendum: changes sent while a design was being made. */
  pendingRound: PENDING_ROUND_MESSAGES,
  /** ADR-230 addendum (L16): a request whose title names nothing, by when it was sent and its words. */
  naming: NAMING_MESSAGES,
  /** ADR-235: who a design is for, asked when nothing names the organisation. */
  clientQuestion: CLIENT_QUESTION_MESSAGES,
  /** ADR-250: a brief the bot cannot start by itself (too many designs, an unsupported size). */
  intakeLimits: INTAKE_LIMIT_MESSAGES,
} as const satisfies Record<string, PhraseBook>;

export { SOURCE_MESSAGES, MEDIA_MESSAGES, INBOX_MESSAGES, ACCESS_MESSAGES, ROUTING_MESSAGES, CONVERSATION_MESSAGES,
  LIFECYCLE_MESSAGES, OUTCOME_MESSAGES, ALBUM_MESSAGES, OFFICE_MESSAGES };
export { WITHDRAW_MESSAGES, PENDING_ROUND_MESSAGES, NAMING_MESSAGES, CLIENT_QUESTION_MESSAGES, INTAKE_LIMIT_MESSAGES };
