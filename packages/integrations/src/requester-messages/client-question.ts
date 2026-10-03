/**
 * Requester messages: who a design is for (ADR-235, see index.ts). A brief from a chat that is not bound
 * to an organisation, whose words name none, is kept and its sender is asked, in words, who it is for.
 * The organisations the office works with are listed only to an office member, never to anyone else.
 * Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{list}` is the organisations' names, bold, separated by commas.
 */
import type { PhraseBook } from './types.js';

export const CLIENT_QUESTION_MESSAGES = {
  /** The brief names no organisation and the chat is bound to none. */
  askClient: {
    en: "Who is this design for? Tell me the organisation's name.",
    ckb: 'ئەم دیزاینە بۆ کێیە؟ ناوی دامەزراوەکەم پێ بڵێ.',
  },
  /** The same, to an office member, with the organisations the office works with. */
  askClientNamed: {
    en: "Who is this design for? Tell me the organisation's name.\n\nThe ones I know: {list}.",
    ckb: 'ئەم دیزاینە بۆ کێیە؟ ناوی دامەزراوەکەم پێ بڵێ.\n\nئەوانەی دەیانناسم: {list}.',
  },
  /** "I don't know", "not sure", "just make it": the office chooses. */
  passedToOffice: {
    en: "No problem. I've passed it to the office, and they'll choose the organisation.",
    ckb: 'کێشە نییە. ناردم بۆ ئۆفیسەکە، ئەوان دامەزراوەکە هەڵدەبژێرن.',
  },
  /** An answer that names no organisation the office works with. */
  notMatchedToOffice: {
    en: "I couldn't match that to an organisation I know, so I've passed it to the office to choose.",
    ckb: 'نەمتوانی ئەوە بە دامەزراوەیەک کە دەیناسم ببەستمەوە، بۆیە ناردم بۆ ئۆفیسەکە بۆ ئەوەی هەڵیبژێرن.',
  },
  /** An answer that came long after the question. */
  expiredToOffice: {
    en: "It's been a while since I asked, so I've passed your request to the office to choose the organisation.",
    ckb: 'ماوەیەکە پرسیارەکەم کردووە، بۆیە داواکارییەکەت ناردم بۆ ئۆفیسەکە بۆ ئەوەی دامەزراوەکە هەڵبژێرن.',
  },
  /** Nobody answered within thirty minutes: the office chooses (said once). */
  timedOutToOffice: {
    en: "I haven't heard who this design is for, so I've passed it to the office; they'll pick the organisation.",
    ckb: 'نەمزانی ئەم دیزاینە بۆ کێیە، بۆیە ناردم بۆ ئۆفیسەکە؛ ئەوان دامەزراوەکە هەڵدەبژێرن.',
  },
  /** The organisation named after the brief went to the office: the office is told. `{title}` bold, `{client}` bold. */
  clientNoted: {
    en: "Thanks. I've told the office that {title} is for {client}.",
    ckb: 'سوپاس. بە ئۆفیسەکەم ڕاگەیاند کە {title} بۆ {client}ە.',
  },
  // ADR-284 addendum (live canary 2026-10-03): the request's first answer when the office chooses the organisation,
  // in one message. The requester heard two back to back ("No problem. I've passed it to the office…" and "Got it.
  // A designer will make …"). Each line is the answer above followed by the designer's line of `receivedForDesigner`,
  // in both languages, so no new Sorani wording is introduced. `{title}` is the design's name (bold).
  /** "I don't know", "not sure", "just make it", with the request opened for a designer. */
  passedToOfficeDesigner: {
    en: "No problem. I've passed it to the office, and they'll choose the organisation. A designer will make {title} and send it to you here.",
    ckb: 'کێشە نییە. ناردم بۆ ئۆفیسەکە، ئەوان دامەزراوەکە هەڵدەبژێرن. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** An answer that names no organisation the office works with, with the request opened for a designer. */
  notMatchedToOfficeDesigner: {
    en: "I couldn't match that to an organisation I know, so I've passed it to the office to choose. A designer will make {title} and send it to you here.",
    ckb: 'نەمتوانی ئەوە بە دامەزراوەیەک کە دەیناسم ببەستمەوە، بۆیە ناردم بۆ ئۆفیسەکە بۆ ئەوەی هەڵیبژێرن. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** An answer that came long after the question, with the request opened for a designer. */
  expiredToOfficeDesigner: {
    en: "It's been a while since I asked, so I've passed your request to the office to choose the organisation. A designer will make {title} and send it to you here.",
    ckb: 'ماوەیەکە پرسیارەکەم کردووە، بۆیە داواکارییەکەت ناردم بۆ ئۆفیسەکە بۆ ئەوەی دامەزراوەکە هەڵبژێرن. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** Nobody answered within thirty minutes, with the request opened for a designer. */
  timedOutToOfficeDesigner: {
    en: "I haven't heard who this design is for, so I've passed it to the office; they'll pick the organisation. A designer will make {title} and send it to you here.",
    ckb: 'نەمزانی ئەم دیزاینە بۆ کێیە، بۆیە ناردم بۆ ئۆفیسەکە؛ ئەوان دامەزراوەکە هەڵدەبژێرن. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
} as const satisfies PhraseBook;
