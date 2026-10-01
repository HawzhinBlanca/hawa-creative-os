/**
 * Requester messages: changes sent while a design was being made (ADR-230 addendum, see index.ts). When
 * the draft finishes with such changes kept, the next round starts with them and the requester hears
 * so; when it cannot start, the office has them and the requester hears that. Every Sorani line awaits
 * native review (SORANI_REVIEW.md).
 *
 * `{title}` is a design's name as the requester sees it (bold); `{changes}` their own words, quoted.
 */
import type { PhraseBook } from './types.js';

export const PENDING_ROUND_MESSAGES = {
  /** The first draft finished before the changes; the next round with them has started. */
  addingChanges: {
    en: "Your first draft of {title} is done. I'm now adding what you asked while it was being made: {changes}. The office checks the new version before it comes to you.",
    ckb: 'یەکەم ڕەشنووسی {title} تەواو بوو. ئێستا ئەوەی لە کاتی دروستکردنیدا داوات کرد زیادی دەکەم: {changes}. ئۆفیسەکە پێش ئەوەی وەشانە نوێیەکە بۆت بێت سەیری دەکات.',
  },
  /** A new round could not start: the office has the changes. */
  changesWithOffice: {
    en: 'Your draft of {title} was finished before your changes could be added: {changes}. The office has them and will see to them before the design comes to you.',
    ckb: 'ڕەشنووسی {title} پێش ئەوەی گۆڕانکارییەکانت زیاد بکرێن تەواو بوو: {changes}. ئۆفیسەکە ئاگاداریانە و پێش ئەوەی دیزاینەکە بۆت بێت جێبەجێیان دەکات.',
  },
  /** The same, with no office chat to tell: the words are kept for the office. */
  changesKept: {
    en: "Your draft of {title} was finished before your changes could be added: {changes}. I've kept them for the office, which checks the design before it comes to you.",
    ckb: 'ڕەشنووسی {title} پێش ئەوەی گۆڕانکارییەکانت زیاد بکرێن تەواو بوو: {changes}. بۆ ئۆفیسەکەم هەڵگرتن، کە پێش ئەوەی دیزاینەکە بۆت بێت سەیری دەکات.',
  },
} as const satisfies PhraseBook;
