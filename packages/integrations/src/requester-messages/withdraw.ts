/**
 * Requester messages: withdrawing a request (ADR-230, see index.ts). A cancel the bot is sure of closes
 * the request (RequestLifecycle's withdraw) and the requester hears it plainly; a cancel it is not sure
 * of is asked about first; a design already approved or sent cannot be withdrawn, and the requester is
 * told so truthfully. Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{title}` is a design's name as the requester sees it (bold).
 */
import type { PhraseBook } from './types.js';

export const WITHDRAW_MESSAGES = {
  /** The requester's cancel closed the request. */
  withdrawn: {
    en: 'Cancelled {title}. Nothing more will be made for it.',
    ckb: '{title} هەڵوەشێنرایەوە. هیچی تر بۆی دروست ناکرێت.',
  },
  /** The office cancelled the request in its Desk. */
  withdrawnByOffice: {
    en: 'The office has cancelled {title}, so nothing more will be made for it. Tell me whenever you need a new design.',
    ckb: 'ئۆفیسەکە {title}ی هەڵوەشاندەوە، بۆیە هیچی تر بۆی دروست ناکرێت. هەر کاتێک دیزاینێکی نوێت پێویست بوو پێم بڵێ.',
  },
  /** A cancel the bot cannot place for certain (it went by which design moved last): asked first. */
  askCancel: {
    en: 'Do you want me to cancel {title}?',
    ckb: 'دەتەوێت {title} هەڵبوەشێنمەوە؟',
  },
  // A cancel that came too late: the design was already approved or sent. The office was told.
  tooLateApproved: {
    en: "{title} was already approved, so I can't cancel it myself. I've told the office.",
    ckb: '{title} پێشتر پەسەند کرابوو، بۆیە خۆم ناتوانم هەڵیبوەشێنمەوە. بە ئۆفیسەکەم ڕاگەیاند.',
  },
  tooLateDelivering: {
    en: "{title} is already being sent to you, so I can't stop it. I've told the office.",
    ckb: '{title} ئێستا بۆت دەنێردرێت، بۆیە ناتوانم ڕایبگرم. بە ئۆفیسەکەم ڕاگەیاند.',
  },
  tooLateDelivered: {
    en: "{title} was already sent to you, so there is nothing left to cancel. I've told the office.",
    ckb: '{title} پێشتر بۆت نێردرابوو، بۆیە هیچ نەماوە هەڵبوەشێنرێتەوە. بە ئۆفیسەکەم ڕاگەیاند.',
  },
  /** The same, with no office chat to tell: the words are kept for the office. */
  tooLateKept: {
    en: "{title} can't be cancelled from here any more. I've kept your message for the office.",
    ckb: '{title} چیتر لێرەوە هەڵناوەشێنرێتەوە. نامەکەتم بۆ ئۆفیسەکە هەڵگرت.',
  },
  // ADR-230 addendum (L12): a cancel with nothing it could withdraw.
  nothingToCancel: {
    en: "There's nothing open for me to cancel right now.",
    ckb: 'ئێستا هیچ داواکارییەکی کراوە نییە کە هەڵیبوەشێنمەوە.',
  },
  deliveredNotCancellable: {
    en: '{title} was already delivered, so there is nothing to cancel there.',
    ckb: '{title} پێشتر گەیەندرابوو، بۆیە هیچ نییە لەوێ هەڵبوەشێنرێتەوە.',
  },
} as const satisfies PhraseBook;
