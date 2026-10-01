/**
 * Requester messages: naming a request whose stored title names nothing (ADR-230 addendum, L16; see
 * index.ts). A request opened from words that name no design ("do a better design thats similar to
 * earlier ones") was called "your design", which names nothing when there are several. It is named by
 * when it was sent and the start of the requester's own words. Every Sorani line awaits native review.
 *
 * `{when}` is one of the `sent…` phrases; `{words}` the start of their words, quoted.
 */
import type { PhraseBook } from './types.js';

export const NAMING_MESSAGES = {
  theOneYouSent: { en: 'the one you sent {when} ({words})', ckb: 'ئەوەی {when} ناردت ({words})' },
  theOneYouSentPlain: { en: 'the one you sent {when}', ckb: 'ئەوەی {when} ناردت' },
  sentJustNow: { en: 'just now', ckb: 'ئێستا' },
  sentMinutesAgo: { en: '{n} minutes ago', ckb: 'پێش {n} خولەک' },
  sentToday: { en: 'today at {time}', ckb: 'ئەمڕۆ کاتژمێر {time}' },
  sentYesterday: { en: 'yesterday at {time}', ckb: 'دوێنێ کاتژمێر {time}' },
  sentDaysAgo: { en: '{n} days ago', ckb: 'پێش {n} ڕۆژ' },
} as const satisfies PhraseBook;
