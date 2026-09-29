/** Requester messages: who may use the bot (see index.ts). Every Sorani line awaits native review (SORANI_REVIEW.md). */
import type { PhraseBook } from './types.js';

export const ACCESS_MESSAGES = {
  /** A sender outside the intake list (N5): said at most once per chat per day, nothing else is kept. */
  notAllowed: {
    en: 'Hi! This design assistant is only set up for the Hawa office team. Please ask the office to add you.',
    ckb: 'سڵاو! ئەم یاریدەدەرەی دیزاین تەنها بۆ تیمی ئۆفیسی هاوا ئامادە کراوە. تکایە داوا لە ئۆفیسەکە بکە زیادت بکەن.',
  },
} as const satisfies PhraseBook;
