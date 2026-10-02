/**
 * Requester messages: a brief the bot cannot start by itself (ADR-250, friction 4). A message asking for
 * more designs than one request holds, or for a size outside what the design path makes, opens nothing;
 * the office has the words and follows up. The requester is never told to send it again in groups or to
 * choose a size. Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{count}` is how many designs the message asks for; `{size}` the size as they asked ("3000 × 3000").
 */
import type { PhraseBook } from './types.js';

export const INTAKE_LIMIT_MESSAGES = {
  /** More designs than one message can start; the office has it. */
  tooManyPassed: {
    en: "This asks for {count} designs, more than I can start from one message, so I've passed it to the office. They'll follow up with you here.",
    ckb: 'ئەمە داوای {count} دیزاین دەکات، کە لەوە زیاترە لە یەک نامەدا دەستیان پێبکەم، بۆیە ناردم بۆ ئۆفیسەکە. لێرە وەڵامت دەدەنەوە.',
  },
  /** The same, with no office chat to tell: the words are kept for the office. */
  tooManyKept: {
    en: "This asks for {count} designs, more than I can start from one message, so I've kept it for the office. They'll follow up with you here.",
    ckb: 'ئەمە داوای {count} دیزاین دەکات، کە لەوە زیاترە لە یەک نامەدا دەستیان پێبکەم، بۆیە بۆ ئۆفیسەکەم هەڵگرت. لێرە وەڵامت دەدەنەوە.',
  },
  /** A size the design path does not make; the office chooses one that works. */
  sizePassed: {
    en: "I can't make a design at {size} myself, so I've passed your message to the office. They'll find a size that works and follow up with you here.",
    ckb: 'خۆم ناتوانم دیزاینێک بە قەبارەی {size} دروست بکەم، بۆیە پەیامەکەتم گەیاندە ئۆفیسەکە. قەبارەیەکی گونجاو دەدۆزنەوە و لێرە وەڵامت دەدەنەوە.',
  },
  /** The same, with no office chat to tell. */
  sizeKept: {
    en: "I can't make a design at {size} myself, so I've kept your message for the office. They'll find a size that works and follow up with you here.",
    ckb: 'خۆم ناتوانم دیزاینێک بە قەبارەی {size} دروست بکەم، بۆیە پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت. قەبارەیەکی گونجاو دەدۆزنەوە و لێرە وەڵامت دەدەنەوە.',
  },
} as const satisfies PhraseBook;
