/**
 * Requester messages ChatInbox sends on its own, for an answer Core gave without words (see index.ts).
 * Every Sorani line awaits native review (SORANI_REVIEW.md).
 */
import type { PhraseBook } from './types.js';

export const INBOX_MESSAGES = {
  /** An answer to the design's one question was taken and the design carries on. */
  answerTaken: {
    en: "Thanks, I'll use that and carry on with the same design.",
    ckb: 'سوپاس، ئەوە بەکاردەهێنم و هەمان دیزاین تەواو دەکەم.',
  },
  /** A photo with two designs waiting for changes (the text path asks in Core's own words). */
  whichWaitingDesign: {
    en: 'More than one of your designs is waiting for changes. Which one is this for? Just tell me its name.',
    ckb: 'زیاتر لە یەک دیزاین چاوەڕێی گۆڕانکارییەکانی تۆن. ئەمە بۆ کامیانە؟ ناوەکەی بنووسە.',
  },
  /** A button under an old draft, or a reply no current design knows. */
  staleButton: {
    en: 'That design is now with the office. If anything should change, just tell me here.',
    ckb: 'ئەو دیزاینە ئێستا لای ئۆفیسەکەیە. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ.',
  },
  /** Nothing after "/new", or a group "/task" with nothing after it. */
  whatToDesign: {
    en: 'What would you like designed? Tell me in your own words, with the text that should go on it.',
    ckb: 'چیت دەوێت دیزاین بکرێت؟ بە وشەی خۆت پێم بڵێ، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت.',
  },
  /** A late change Core gave no words for: the office was told. */
  lateChangeReview: {
    en: "Got it. The office is checking this design now, and I've passed your message to them.",
    ckb: 'تێگەیشتم. ئۆفیسەکە ئێستا سەیری ئەم دیزاینە دەکات، و پەیامەکەتم پێیان گەیاند.',
  },
  lateChangeDelivering: {
    en: "This design is being sent to you now; I've passed your message to the office.",
    ckb: 'ئەم دیزاینە ئێستا بۆت دەنێردرێت؛ پەیامەکەتم گەیاندە ئۆفیسەکە.',
  },
  lateChangeDelivered: {
    en: "This design was already delivered; I've passed your message to the office.",
    ckb: 'ئەم دیزاینە پێشتر گەیەندرابوو؛ پەیامەکەتم گەیاندە ئۆفیسەکە.',
  },
  /** No office chat to alert: the words are kept for the office, who read them before sending. */
  lateChangeKept: {
    en: "Got it. I've kept your message for the office; they'll see it before the design is sent.",
    ckb: 'تێگەیشتم. پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ پێش ناردنی دیزاینەکە دەیبینن.',
  },
  /** The day's automatic design allowance is used up: the office has the change. */
  changeToOffice: {
    en: "I've passed your change to the office; they'll make it and send the design here. There's no need to send it again.",
    ckb: 'گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە؛ ئەوان دەیکەن و دیزاینەکە لێرە بۆت دەنێرن. پێویست ناکات دووبارەی بنێریتەوە.',
  },
  /** An answer or a change the bot could not safely apply by itself: the office finishes it. */
  answerToOffice: {
    en: "I've passed your answer to the office; they'll finish this design and send it here.",
    ckb: 'وەڵامەکەتم گەیاندە ئۆفیسەکە؛ ئەوان ئەم دیزاینە تەواو دەکەن و لێرە بۆت دەنێرن.',
  },
  changeToOfficeToFinish: {
    en: "I've passed your change to the office; they'll finish this design and send it here.",
    ckb: 'گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە؛ ئەوان ئەم دیزاینە تەواو دەکەن و لێرە بۆت دەنێرن.',
  },
  /** The message could not be read after several tries (a dead letter): the office has it. */
  couldNotRead: {
    en: "Sorry, I couldn't read that message just now. I've passed it to the office and they'll follow up here.",
    ckb: 'ببورە، ئێستا نەمتوانی ئەو پەیامە بخوێنمەوە. گەیاندمە ئۆفیسەکە و لێرە وەڵامت دەدەنەوە.',
  },
} as const satisfies PhraseBook;
