/**
 * Requester messages: lifecycle (see index.ts). What RequestLifecycle says as a request moves
 * (apps/worker/src/lifecycle/request-lifecycle.ts): the first answer to a brief, the office's note,
 * the reminders; and Core's question before a change (apps/core/src/services/lifecycle-projection.ts).
 * Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{title}` is the design's name (bold), `{question}` the question (bold), `{options}` its numbered
 * answers, `{comment}` the office's own words. HTML callers escape every value they insert.
 */
import type { PhraseBook } from './types.js';

export const LIFECYCLE_MESSAGES = {
  /** A design's name when the request carries none. */
  yourDesign: {
    en: 'your design',
    ckb: 'دیزاینەکەت',
  },
  /** #9: a brief a designer makes by hand. */
  receivedForDesigner: {
    en: 'Got it. A designer will make {title} and send it to you here.',
    ckb: 'تێگەیشتم. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** #10: a brief this bot drafts first. */
  receivedDrafting: {
    en: "Got it. I'm making a first draft of {title}; the office checks it before you get it.",
    ckb: 'تێگەیشتم. یەکەم ڕەشنووسی {title} دروست دەکەم؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات.',
  },
  /** #11: the office asked for changes to the draft. */
  officeNote: {
    en: 'The office has a note on {title}:\n\n{comment}\n\nWhat would you like changed? Just write it here.',
    ckb: 'ئۆفیسەکە تێبینییەکی لەسەر {title} هەیە:\n\n{comment}\n\nچیت دەوێت بگۆڕدرێت؟ تەنها لێرە بینووسە.',
  },
  /** #14: one question before a change is made. */
  oneQuestion: {
    en: 'One question about {title}:\n\n{question}\n\n{options}\n\nAnswer with a number or in your own words.',
    ckb: 'پرسیارێک دەربارەی {title}:\n\n{question}\n\n{options}\n\nبە ژمارە یان بە وشەی خۆت وەڵام بدەرەوە.',
  },
  /** #12: the question is still open. */
  questionReminder: {
    en: '{title} is still waiting for one answer:\n\n{question}\n\n{options}\n\nAnswer with a number or in your own words.',
    ckb: '{title} هێشتا چاوەڕێی یەک وەڵامە:\n\n{question}\n\n{options}\n\nبە ژمارە یان بە وشەی خۆت وەڵام بدەرەوە.',
  },
  /** #13: the office's note is still waiting for the requester's changes. */
  changesReminder: {
    en: '{title} is still waiting for your changes. What should I change?',
    ckb: '{title} هێشتا چاوەڕێی گۆڕانکارییەکانی تۆیە. چی بگۆڕم؟',
  },
  /** #15: an outcome that needs a person, when there is no office chat to alert. */
  officeWillFollowUp: {
    en: 'Someone from the office will follow up here.',
    ckb: 'کەسێک لە ئۆفیسەکە لێرە بەدواداچوونی بۆ دەکات.',
  },
} as const satisfies PhraseBook;
