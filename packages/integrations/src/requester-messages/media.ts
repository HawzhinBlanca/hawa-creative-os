/** Requester messages: photos, files, videos and edits (see index.ts). Every Sorani line awaits native review (SORANI_REVIEW.md). */
import type { PhraseBook } from './types.js';

export const MEDIA_MESSAGES = {
  /** A photo with no words: kept until the words arrive. */
  photoHeld: {
    en: "Got the photo. Send me the text for the design and I'll use it with the photo.",
    ckb: 'وێنەکەم وەرگرت. دەقی دیزاینەکەم بۆ بنێرە و لەگەڵ وێنەکە بەکاری دەهێنم.',
  },
  /** A photo sent just before the words: it goes with the request the words opened or changed. */
  photoUsedWithWords: {
    en: "I'll use the photo you sent with this.",
    ckb: 'ئەو وێنەیەی ناردت لەگەڵ ئەمەدا بەکاردەهێنم.',
  },
  /** A photo sent just after a brief whose design has not started using pictures yet. */
  photoAdded: {
    en: "Got the photo. I've added it to {title}.",
    ckb: 'وێنەکەم وەرگرت و بۆ {title} زیادم کرد.',
  },
  /** A photo sent just after a brief whose design is already under way, or is with a designer. */
  photoPassed: {
    en: "Got the photo. {title} is already being made, so I've passed the photo to the office to use.",
    ckb: 'وێنەکەم وەرگرت. {title} پێشتر دەستی پێکراوە، بۆیە وێنەکەم گەیاندە ئۆفیسەکە بۆ ئەوەی بەکاری بهێنن.',
  },
  /** Photos whose design the bot cannot tell (they answer a design that no longer waits). */
  photosUnplaced: {
    en: "Got the photos, but I'm not sure which design they're for. Please send them again together with what you'd like designed.",
    ckb: 'وێنەکانم وەرگرت، بەڵام دڵنیا نیم بۆ کام دیزاینن. تکایە دووبارە بیاننێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  /** A picture that could not be opened (damaged, or not really a picture). */
  photoUnreadable: {
    en: "I couldn't open that picture. Could you send it again as a photo?",
    ckb: 'نەمتوانی ئەو وێنەیە بکەمەوە. دەتوانیت دووبارە وەک وێنە بینێریتەوە؟',
  },
  /** ADR-156: a logo sent as an SVG file, passed to the office for the sender's one open design. */
  svgPassedForDesign: {
    en: "Thanks for the logo. I can't place this kind of file myself, so I've passed it to the office to add to {title}.",
    ckb: 'سوپاس بۆ لۆگۆکە. خۆم ناتوانم ئەم جۆرە فایلە دابنێم، بۆیە گەیاندمە ئۆفیسەکە بۆ ئەوەی بۆ {title} زیادی بکەن.',
  },
  /** ADR-156: an SVG file with no single open design it belongs to: the office has it. */
  svgPassed: {
    en: "Thanks for the file. I can't place this kind of file myself, so I've passed it to the office; they'll follow up here.",
    ckb: 'سوپاس بۆ فایلەکە. خۆم ناتوانم ئەم جۆرە فایلە دابنێم، بۆیە گەیاندمە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
  /** ADR-156: the same, with no office chat to tell: it is kept for the office. */
  svgKept: {
    en: "Thanks for the file. I can't place this kind of file myself, so I've kept it for the office; they'll follow up here.",
    ckb: 'سوپاس بۆ فایلەکە. خۆم ناتوانم ئەم جۆرە فایلە دابنێم، بۆیە بۆ ئۆفیسەکەم هەڵگرت؛ لێرە وەڵامت دەدەنەوە.',
  },
  /** A video, a round video message or a GIF with no words. */
  videoNotUsed: {
    en: "Thanks! I can't put videos on a design. Could you send a photo instead? You can also just tell me what the design should say.",
    ckb: 'سوپاس! ناتوانم ڤیدیۆ لەسەر دیزاین دابنێم. دەتوانیت لە جیاتی ئەوە وێنەیەک بنێریت؟ یان تەنها پێم بڵێ دیزاینەکە چی لەسەر بنووسرێت.',
  },
  /** A video with words: the words are used, the video is not. */
  videoWordsUsed: {
    en: "I can't put the video itself on a design, so I've used your words. Send photos if you'd like pictures on it.",
    ckb: 'ناتوانم خودی ڤیدیۆکە لەسەر دیزاین دابنێم، بۆیە وشەکانتم بەکارهێنا. ئەگەر وێنەت دەوێت لەسەری بێت، وێنە بنێرە.',
  },
  /** A file that is not a picture, a PDF or a recording. */
  fileUnsupported: {
    en: "I couldn't open that file. Could you send it as a photo or a PDF, or paste the text here?",
    ckb: 'نەمتوانی ئەو فایلە بکەمەوە. دەتوانیت وەک وێنە یان PDF بینێریت، یان دەقەکە لێرە بنووسیت؟',
  },
  /** An edit to words the bot is still holding (a photo, a voice note or a PDF not yet used). */
  editApplied: {
    en: "I saw your edit, and I'll use the new words.",
    ckb: 'دەستکارییەکەتم بینی، و وشە نوێیەکان بەکاردەهێنم.',
  },
  /** An edit to the words of a design that is already being made or is with the office. */
  editPassed: {
    en: "I saw your edit to {title}. I've passed the new wording to the office so it's used.",
    ckb: 'دەستکارییەکەتم لە {title} بینی. دەقە نوێیەکەم گەیاندە ئۆفیسەکە بۆ ئەوەی بەکاری بهێنن.',
  },
  /**
   * ADR-252 (friction 13): an edit to the words of a design already sent to the requester. The sent
   * design keeps its old words; "so it's used" was untrue. The office decides whether to change it.
   */
  editPassedDelivered: {
    en: "I saw your edit to {title}. It was already sent with the old wording, so I've passed the new wording to the office; they'll follow up here.",
    ckb: 'دەستکارییەکەتم لە {title} بینی. پێشتر بە دەقە کۆنەکەوە نێردرابوو، بۆیە دەقە نوێیەکەم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
  /** An edit the bot could not place (a fallback). */
  editSeen: {
    en: 'I saw your edit. If anything should change, just tell me here.',
    ckb: 'دەستکارییەکەتم بینی. ئەگەر شتێک پێویستی بە گۆڕین هەیە، تەنها لێرە پێم بڵێ.',
  },
  /** An edit to a message the bot cannot link to anything current. */
  editForwarded: {
    en: "I saw your edit and passed it to the office; they'll follow up here.",
    ckb: 'دەستکارییەکەتم بینی و گەیاندمە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە.',
  },
} as const satisfies PhraseBook;
