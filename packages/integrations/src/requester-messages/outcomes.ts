/**
 * Requester messages: outcomes (see index.ts). What the requester hears when a draft run ends
 * (apps/core/src/services/canva-status-message.ts), when the approved design is delivered
 * (apps/worker/src/delivery-notification.ts, lifecycle/delivery.ts), and when a request could not be
 * started or its outcome recorded. The office's facts (task ids, review links, the archive, the
 * production log, check names) stay in the office's own alerts and the Desk.
 * Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * `{title}` is the design's name (bold in HTML, as is in plain text), `{question}` and `{options}` a
 * question and its numbered answers, `{list}` a bulleted list of asks, `{link}` a link.
 */
import type { PhraseBook } from './types.js';

export const OUTCOME_MESSAGES = {
  /** #17: a draft exists and the office is checking it. */
  draftReady: {
    en: "Your draft of {title} is ready, and the office is giving it a final check. They'll send it to you here once it's approved. If anything should change, just tell me.",
    ckb: 'ڕەشنووسی {title} ئامادەیە و ئۆفیسەکە بۆ دواجار سەیری دەکات. کە پەسەند کرا لێرە بۆت دەنێردرێت. ئەگەر شتێک پێویستی بە گۆڕین هەیە، تەنها پێم بڵێ.',
  },
  /** #18: a draft exists but an automatic check did not pass. */
  draftBeingFixed: {
    en: 'Your draft of {title} is made; the office is fixing a small detail before you get it.',
    ckb: 'ڕەشنووسی {title} دروست کرا؛ ئۆفیسەکە پێش ئەوەی بۆت بێت وردەکارییەکی بچووک چاک دەکات.',
  },
  /** #19: no organisation could be told from the brief, so no draft was started. */
  organisationUnknown: {
    en: "I couldn't tell which organisation {title} is for, so a designer at the office will make it and send it to you here.",
    ckb: 'نەمزانی {title} بۆ کام دامەزراوەیە، بۆیە دیزاینەرێک لە ئۆفیسەکە دروستی دەکات و لێرە بۆت دەنێرێت.',
  },
  /** #20 and #24: made by hand (queued for a designer, or no brand reference for the organisation). */
  designerMakes: {
    en: 'A designer will make {title} and send it to you here.',
    ckb: 'دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** #23: text the automatic draft cannot set safely. */
  designerSetsText: {
    en: 'A designer will set the text of {title} by hand and send it to you here.',
    ckb: 'دیزاینەرێک دەقی {title} بە دەست دادەنێت و لێرە بۆت دەنێرێت.',
  },
  /** #21: a change made by hand on the current design. */
  designerMakesChange: {
    en: 'A designer will make this change to {title} by hand and send it to you here.',
    ckb: 'دیزاینەرێک ئەم گۆڕانکارییە لە {title} بە دەست دەکات و لێرە بۆت دەنێرێت.',
  },
  /** #22: no words to print were found. */
  textNeeded: {
    en: 'What text should go on {title}? Send it just as you would like it to read.',
    ckb: 'چ دەقێک دەبێت لەسەر {title} بێت؟ بە هەمان شێوە بینێرە کە دەتەوێت بخوێندرێتەوە.',
  },
  /** #25: a design already exists for this request. */
  alreadyInProgress: {
    en: "{title} is already being worked on; you'll get it here.",
    ckb: 'ئێستا کار لەسەر {title} دەکرێت؛ لێرە بۆت دێت.',
  },
  /** #26: the run's result could not be confirmed. */
  officeCheckingDraft: {
    en: 'The office is checking the draft of {title} and will send it to you here.',
    ckb: 'ئۆفیسەکە سەیری ڕەشنووسی {title} دەکات و لێرە بۆت دەنێرێت.',
  },
  /** #27: one question before a change, with answer buttons under it. */
  questionWithButtons: {
    en: 'One question about {title} before I make your change:\n\n{question}\n\n{options}\n\nTap an answer below, or answer in your own words. Everything else you asked for goes into the same draft.',
    ckb: 'پرسیارێک دەربارەی {title} پێش ئەوەی گۆڕانکارییەکەت بکەم:\n\n{question}\n\n{options}\n\nلە خوارەوە وەڵامێک هەڵبژێرە، یان بە وشەی خۆت وەڵام بدەرەوە. هەموو ئەوانی تری داوات کردووە دەچنە هەمان ڕەشنووسەوە.',
  },
  /** Under #27: the parts of the change no automatic edit can make. */
  designerMakesPart: {
    en: 'A designer will make this part by hand:\n{list}',
    ckb: 'دیزاینەرێک ئەم بەشە بە دەست دەکات:\n{list}',
  },
  /** #28: a change no automatic edit can make; nothing new was made. */
  changeByDesignerList: {
    en: 'A designer will make this part of your change to {title} by hand:\n{list}\nYour last draft stays as it is. Anything else to change? Just write it.',
    ckb: 'دیزاینەرێک ئەم بەشەی گۆڕانکارییەکەت لە {title} بە دەست دەکات:\n{list}\nدوایین ڕەشنووست وەک خۆی دەمێنێتەوە. شتێکی تر هەیە بگۆڕدرێت؟ تەنها بینووسە.',
  },
  changeByDesigner: {
    en: 'A designer will make your change to {title} by hand. Your last draft stays as it is. Anything else to change? Just write it.',
    ckb: 'دیزاینەرێک گۆڕانکارییەکەت لە {title} بە دەست دەکات. دوایین ڕەشنووست وەک خۆی دەمێنێتەوە. شتێکی تر هەیە بگۆڕدرێت؟ تەنها بینووسە.',
  },
  /** #29 and #30: stopped by a check, or failed; the office was alerted. */
  officeWillFinish: {
    en: 'The office will finish {title} and send it to you here.',
    ckb: 'ئۆفیسەکە {title} تەواو دەکات و لێرە بۆت دەنێرێت.',
  },

  /** #31: the approved design, delivered. */
  delivered: {
    en: 'Here is your final {title}. 🎉',
    ckb: 'فەرموو، ئەمە وەشانی کۆتایی {title}. 🎉',
  },
  /** #31 when Telegram did not confirm a file arrived. */
  deliveredUnconfirmed: {
    en: "I've sent your final {title}, but Telegram didn't confirm that it arrived. The office will check, and send it again if it didn't.",
    ckb: 'وەشانی کۆتایی {title}م بۆ ناردیت، بەڵام تێلێگرام دڵنیایی نەدا کە گەیشتووە. ئۆفیسەکە سەیری دەکات، و ئەگەر نەگەیشتبوو دووبارە دەینێرێتەوە.',
  },
  deliveredInDrive: {
    en: 'Also in Google Drive:',
    ckb: 'هەروەها لە گووگڵ درایڤدا:',
  },
  /** The link text for a delivery folder, when the files are not named. */
  deliveryFolder: {
    en: 'the delivery folder',
    ckb: 'بوخچەی گەیاندن',
  },
  /** #32: the caption on each delivered file. */
  deliveredCaption: {
    en: '{title}, final',
    ckb: '{title}، وەشانی کۆتایی',
  },

  /** A request that could not be started at all. */
  couldNotStart: {
    en: "Sorry, I couldn't start your design request. The office has been told and will follow up with you here.",
    ckb: 'ببورە، نەمتوانی داواکاری دیزاینەکەت دەست پێ بکەم. ئۆفیسەکە ئاگادار کرایەوە و لێرە بەدواداچوونت بۆ دەکات.',
  },
  /** A run that finished while Core could not record it. */
  draftMadeNotSaved: {
    en: "Your draft of {title} is made, but I couldn't finish saving it. The office will follow up with you here.",
    ckb: 'ڕەشنووسی {title} دروست کرا، بەڵام نەمتوانی بە تەواوی پاشەکەوتی بکەم. ئۆفیسەکە لێرە بەدواداچوونت بۆ دەکات.',
  },
  couldNotFinish: {
    en: "I couldn't finish {title} automatically. The office will follow up with you here.",
    ckb: 'نەمتوانی {title} بە شێوەی خۆکار تەواو بکەم. ئۆفیسەکە لێرە بەدواداچوونت بۆ دەکات.',
  },
} as const satisfies PhraseBook;
