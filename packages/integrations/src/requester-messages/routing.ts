/**
 * Requester messages: routing (see index.ts). What Core answers when it reads a requester's message
 * against the chat's own requests (ADR-144, apps/core/src/services/requester-turn.ts): thanks, where a
 * design stands, a change or a cancel kept for the office, approval or timing words passed on, and the
 * one short question when it cannot tell which design is meant. The English wording is ADR-144's
 * (section 2.9). Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{title}` is a design's name as the requester sees it (bold), `{question}` a question's words, and
 * `{list}` a numbered list of designs.
 */
import type { PhraseBook } from './types.js';

export const ROUTING_MESSAGES = {
  statusHeld: {
    en: '{title} is paused at your request. New design work is waiting for the office to resume it; work already admitted may still finish.',
    ckb: '{title} بە داواکاریی تۆ ڕاگیراوە. کاری نوێی دیزاین چاوەڕێیە ئۆفیسەکە دووبارە دەستی پێ بکاتەوە؛ کاری پێشتر دەستپێکراو لەوانەیە تەواو بێت.',
  },
  // Where a design stands ("how is my poster?", "when will it be ready?").
  statusDesigning: {
    en: '{title} is being designed right now. The draft usually takes a few minutes; the office checks it before it comes to you.',
    ckb: '{title} ئێستا دیزاین دەکرێت. ڕەشنووسەکە زۆرجار چەند خولەکێک دەخایەنێت؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات.',
  },
  // ADR-182: asked about a design still being made after half an hour; the office was just told.
  statusDesigningSlow: {
    en: "{title} is taking longer than usual. I've asked the office to look into it; they'll follow up here.",
    ckb: '{title} لە ئاسایی زیاتر دەخایەنێت. داوام لە ئۆفیسەکە کرد سەیری بکەن؛ لێرە وەڵامت دەدەنەوە.',
  },
  statusManual: {
    en: 'A designer at the office is working on {title}. It will be sent here when it is ready.',
    ckb: 'دیزاینەرێک لە ئۆفیسەکە کار لەسەر {title} دەکات. کە ئامادە بوو لێرە بۆت دەنێردرێت.',
  },
  statusWaitingForChanges: {
    en: '{title} is waiting for your changes. Just tell me what you would like changed.',
    ckb: '{title} چاوەڕێی گۆڕانکارییەکانی تۆیە. تەنها پێم بڵێ چیت دەوێت بگۆڕدرێت.',
  },
  statusAwaitingAnswer: {
    en: '{title} is waiting for your answer to one question: {question}',
    ckb: '{title} چاوەڕێی وەڵامی تۆیە بۆ یەک پرسیار: {question}',
  },
  statusInReview: {
    en: '{title} is with the office for a final check. It will be sent here once they approve it.',
    ckb: '{title} لای ئۆفیسەکەیە بۆ دوایین پشکنین. کە پەسەندیان کرد لێرە بۆت دەنێردرێت.',
  },
  statusApproved: {
    en: '{title} is approved and will be sent to you shortly.',
    ckb: '{title} پەسەند کراوە و بەم زووانە بۆت دەنێردرێت.',
  },
  statusDelivering: {
    en: '{title} is being sent to you now.',
    ckb: '{title} ئێستا بۆت دەنێردرێت.',
  },
  statusDelivered: {
    en: '{title} has been delivered.',
    ckb: '{title} گەیەندرا.',
  },
  statusNothingOpen: {
    en: "I don't have a design in progress in this chat right now. Tell me what you'd like designed.",
    ckb: 'ئێستا هیچ دیزاینێکم لەم چاتەدا لە دەستدا نییە. پێم بڵێ چیت دەوێت دیزاین بکرێت.',
  },

  // Thanks, "ok", 👍.
  thanks: {
    en: '🙏 Thank you.',
    ckb: '🙏 سوپاس.',
  },
  thanksOneWaiting: {
    en: "🙏 Thank you.\n\nWhenever you're ready, just tell me what to change on {title}.",
    ckb: '🙏 سوپاس.\n\nهەر کاتێک ئامادە بوویت، پێم بڵێ چی لە {title} بگۆڕم.',
  },

  // Words about a design this bot can no longer link to a current request.
  forwardedToOffice: {
    en: "I've passed your message to the office; they'll follow up here.",
    ckb: 'پەیامەکەتم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
  keptForOffice: {
    en: "I've kept your message for the office; they'll follow up here.",
    ckb: 'پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ لێرە وەڵامت دەدەنەوە.',
  },
  // ADR-182: a question the bot cannot answer itself (a price, whether they have the logo): the office does.
  questionPassed: {
    en: "I can't answer that myself, so I've passed your question to the office; they'll reply here.",
    ckb: 'ناتوانم خۆم وەڵامی ئەوە بدەمەوە، بۆیە پرسیارەکەتم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
  questionKept: {
    en: "I can't answer that myself, so I've kept your question for the office; they'll reply here.",
    ckb: 'ناتوانم خۆم وەڵامی ئەوە بدەمەوە، بۆیە پرسیارەکەتم بۆ ئۆفیسەکە هەڵگرت؛ لێرە وەڵامت دەدەنەوە.',
  },
  nothingToChange: {
    en: "I don't have a design in progress here to change. Tell me what you'd like designed, with the text that should go on it.",
    ckb: 'ئێستا هیچ دیزاینێکم لە دەستدا نییە بۆ گۆڕین. پێم بڵێ چیت دەوێت دیزاین بکرێت، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت.',
  },

  // The one short question when the message could mean more than one thing.
  askChangeOrNew: {
    en: 'Is this a change to {title}, or a new design? Just say “change” or “new”.',
    ckb: 'ئەمە گۆڕانکارییە لە {title}، یان دیزاینێکی نوێیە؟ تەنها بنووسە «گۆڕانکاری» یان «نوێ».',
  },
  askCancel: {
    en: 'Do you want me to ask the office to cancel {title}? Just say “yes”.',
    ckb: 'دەتەوێت داوا لە ئۆفیسەکە بکەم {title} هەڵبوەشێنێتەوە؟ تەنها بنووسە «بەڵێ».',
  },
  askIsThisOne: {
    en: 'Is this for {title}? Just say “yes”.',
    ckb: 'ئەمە بۆ {title}ە؟ تەنها بنووسە «بەڵێ».',
  },
  askWhichDesign: {
    en: 'Which design is this for?\n{list}\n\nAnswer with the number or the name.',
    ckb: 'ئەمە بۆ کام دیزاینە؟\n{list}\n\nبە ژمارە یان ناو وەڵام بدەرەوە.',
  },
  /** The last line of the "which design?" list when the message may be a new brief. */
  aNewDesign: {
    en: 'A new design',
    ckb: 'دیزاینێکی نوێ',
  },

  // A change or a cancel kept on a request for the office.
  cancelAsked: {
    en: "OK. I've asked the office to cancel {title}.",
    ckb: 'باشە. داوام لە ئۆفیسەکە کرد کە {title} هەڵبوەشێنێتەوە.',
  },
  holdConfirmed: {
    en: "I've paused {title}. New design work will wait until the office resumes it; work already in progress may still finish.",
    ckb: '{title} ڕاگیرا. کاری نوێی دیزاین چاوەڕێ دەکات تا ئۆفیس دووبارە دەستی پێبکات؛ کاری پێشتر دەستپێکراو لەوانەیە تەواو بێت.',
  },
  holdAsked: {
    en: "I've asked the office to hold {title}. I'll keep your message with the design.",
    ckb: 'داوام لە ئۆفیس کرد {title} ڕابگرێت. نامەکەت لەگەڵ دیزاینەکە دەپارێزم.',
  },
  changeAddedWhileDesigning: {
    en: "Got it. I've added that to {title}; the office will see it before the design is sent to you.",
    ckb: 'تێگەیشتم. ئەوەم بۆ {title} زیاد کرد؛ ئۆفیسەکە پێش ناردنی دیزاینەکە دەیبینێت.',
  },
  changePassedInReview: {
    en: "Got it. The office is checking {title} now, and I've passed your change to them.",
    ckb: 'تێگەیشتم. ئۆفیسەکە ئێستا سەیری {title} دەکات، و گۆڕانکارییەکەتم پێیان گەیاند.',
  },
  changePassedDelivering: {
    en: "{title} is being sent to you now; I've passed your change to the office.",
    ckb: '{title} ئێستا بۆت دەنێردرێت؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە.',
  },
  changePassedDelivered: {
    en: "{title} was already delivered; I've passed your change to the office.",
    ckb: '{title} پێشتر گەیەندرابوو؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە.',
  },

  // Approval or timing words, passed to the office (they approve nothing).
  approvalPassed: {
    en: "Thanks! I've told the office you're happy with {title}. They give it a final check before it's sent.",
    ckb: 'سوپاس! بە ئۆفیسەکەم ڕاگەیاند کە تۆ ڕازیت بە {title}. پێش ناردن بۆ دواجار سەیری دەکەن.',
  },
  deadlinePassed: {
    en: "Noted. I've told the office about the timing for {title}.",
    ckb: 'تێبینی کرا. سەبارەت بە کاتی {title} ئۆفیسەکەم ئاگادار کردەوە.',
  },
  /**
   * ADR-156: "send it again", "it didn't arrive", "as a PDF", "to my email", "higher resolution": the
   * office has the request about the files (nothing is sent or approved by itself).
   */
  deliveryRequestPassed: {
    en: "Got it. I've passed your request about {title} to the office; they'll follow up here.",
    ckb: 'تێگەیشتم. داواکارییەکەتم سەبارەت بە {title} گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
} as const satisfies PhraseBook;
