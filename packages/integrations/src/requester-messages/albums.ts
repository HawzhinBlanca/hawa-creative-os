/**
 * Requester messages: photo albums (ADR-143's wording, moved here by ADR-145; see index.ts). Every
 * Sorani line awaits native review (SORANI_REVIEW.md). `{count}` is written in the reader's digits.
 */
import type { PhraseBook } from './types.js';

export const ALBUM_MESSAGES = {
  question: {
    en: 'I have your {count} photos. What would you like me to design with them? Please tell me what it is for and the exact words to put on it.',
    ckb: '{count} وێنەکەتم پێگەیشت. دەتەوێت چ دیزاینێکیان پێ دروست بکەم؟ تکایە بۆم بنووسە بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن.',
  },
  followUp: {
    en: 'Happy to. What should I design with these photos? Tell me what it is for and the exact words to put on it.',
    ckb: 'بە دڵخۆشییەوە. چ دیزاینێک بەم وێنانە دروست بکەم؟ پێم بڵێ بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن.',
  },
  /** ADR-145: no longer "reply to it with this photo": the photo is simply sent again with the change. */
  latePhoto: {
    en: "This photo arrived after I had started your design, so it isn't part of it. When the draft is ready, just send the photo again and tell me what to change.",
    ckb: 'ئەم وێنەیە دوای دەستپێکردنی دیزاینەکەت گەیشت، بۆیە بەشێک نییە لێی. کاتێک ڕەشنووسەکە ئامادە بوو، تەنها وێنەکە دووبارە بنێرەوە و پێم بڵێ چی بگۆڕدرێت.',
  },
  /**
   * ADR-160: the album's caption reached Telegram's caption limit, so Telegram kept only its start.
   * `{tail}` is the last few words that arrived. Nothing is designed until the rest arrives (or the
   * wait ends).
   */
  captionCut: {
    en: 'I have your photos, but Telegram cut your text short: it stops at "…{tail}". Please send me the rest, or the whole text again, and I\'ll use it with these photos.',
    ckb: 'وێنەکانتم پێگەیشت، بەڵام تێلیگرام دەقەکەتی کورت کردەوە: لە «…{tail}» دەوەستێت. تکایە ئەوەی ماوەتەوە بۆم بنێرە، یان هەموو دەقەکە دووبارە بنێرەوە، و لەگەڵ ئەم وێنانە بەکاری دەهێنم.',
  },
  /** ADR-160: asked again (the requester said "ok" or "yes"): shorter than the first question. */
  captionCutAgain: {
    en: 'I still need the rest of your text after "…{tail}". Please send it as a message, or send the whole text again.',
    ckb: 'هێشتا پێویستم بە ماوەی دەقەکەتە دوای «…{tail}». تکایە وەک نامەیەک بینێرە، یان هەموو دەقەکە دووبارە بنێرەوە.',
  },
  /** ADR-160: the requester called the held album off ("cancel", "never mind"). */
  captionCutCancelled: {
    en: "OK, I won't make anything with these photos. Send them again whenever you're ready.",
    ckb: 'باشە، هیچ شتێک بەم وێنانە دروست ناکەم. هەر کاتێک ئامادە بوویت دووبارە بیاننێرەوە.',
  },
  /** ADR-160: the rest did not come within the wait, and what arrived is not enough for a design. */
  captionCutLapsed: {
    en: "I didn't receive the rest of your text, so I haven't started a design with these photos. Whenever you're ready, send the photos again and then the whole text as a message.",
    ckb: 'ماوەی دەقەکەتم پێنەگەیشت، بۆیە هێشتا دیزاینم بەم وێنانە دەست پێنەکردووە. هەر کاتێک ئامادە بوویت، وێنەکان دووبارە بنێرەوە و پاشان هەموو دەقەکە وەک نامەیەک بنێرە.',
  },
  photoMissing: {
    en: 'One of your photos could not be saved, so I have not started a design. Please send the photos again.',
    ckb: 'یەکێک لە وێنەکانت پاشەکەوت نەکرا، بۆیە هێشتا دیزاینم دەست پێنەکردووە. تکایە وێنەکان دووبارە بنێرەوە.',
  },
  onePhoto: {
    en: 'I received only one photo from this album. Please send the photos again together with what you would like designed.',
    ckb: 'تەنها یەک وێنەم لەم ئەلبومە پێگەیشت. تکایە وێنەکان دووبارە بنێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  captions: {
    en: 'Your photos came with different captions, so I am not sure which one is the brief. Please send the brief again as one message.',
    ckb: 'وێنەکانت چەند نووسینێکی جیاوازیان لەگەڵ بوو، بۆیە نازانم کامیان داواکارییەکەیە. تکایە داواکارییەکە وەک یەک نامە دووبارە بنێرەوە.',
  },
  mixedReplies: {
    en: 'Some of these photos answer a different message than the others. Please send them again together, with one brief.',
    ckb: 'هەندێک لەم وێنانە وەڵامی نامەیەکی جیاوازن. تکایە وەک یەک ئەلبوم لەگەڵ یەک داواکاری دووبارە بیاننێرەوە.',
  },
  noAlbum: {
    en: 'I could not find photos from you waiting in this chat. Please send the photos again with what you would like designed.',
    ckb: 'هیچ وێنەیەکی چاوەڕوانکراوی تۆم لەم چاتەدا نەدۆزییەوە. تکایە وێنەکان دووبارە بنێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  /** ADR-145 rewordings of the album refusals the audit listed (rows 36-43, 47): plain, no jargon. */
  tooMany: {
    en: 'That is more than ten photos, which is more than one design can use. Please send up to ten, with what you would like designed.',
    ckb: 'ئەوە زیاتر لە دە وێنەیە، کە زیاترە لەوەی یەک دیزاین بتوانێت بەکاری بهێنێت. تکایە تا دە وێنە بنێرە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  notPhotos: {
    en: 'I can only use photos in a design, not videos or other files. Please send just the photos again, with what you would like designed.',
    ckb: 'تەنها دەتوانم وێنە لە دیزایندا بەکاربهێنم، نەک ڤیدیۆ یان فایلی تر. تکایە تەنها وێنەکان دووبارە بنێرەوە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  photoUnreadable: {
    en: 'One of these photos could not be opened. Please send the photos again.',
    ckb: 'یەکێک لەم وێنانە نەکرایەوە. تکایە وێنەکان دووبارە بنێرەوە.',
  },
  notFound: {
    en: 'I could not find the photos you mean. Please send them again with what you would like designed.',
    ckb: 'ئەو وێنانەی مەبەستتە نەمدۆزییەوە. تکایە دووبارە بیاننێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  alreadyStarted: {
    en: 'I have already started a design with these photos, so I did not start another one.',
    ckb: 'پێشتر دیزاینێکم بەم وێنانە دەست پێکردووە، بۆیە یەکێکی ترم دەست پێنەکرد.',
  },
  needsTwo: {
    en: 'I did not receive all of these photos. Please send them again together.',
    ckb: 'هەموو ئەم وێنانەم پێنەگەیشت. تکایە پێکەوە دووبارە بیاننێرەوە.',
  },
  somethingWrong: {
    en: 'Something went wrong with these photos. Please send them again, with what you would like designed.',
    ckb: 'کێشەیەک لەگەڵ ئەم وێنانەدا ڕوویدا. تکایە دووبارە بیاننێرەوە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت.',
  },
  tooLarge: {
    en: 'These photos are too large together. Please send fewer or smaller photos.',
    ckb: 'ئەم وێنانە پێکەوە زۆر گەورەن. تکایە ژمارەیەکی کەمتر یان وێنەی بچووکتر بنێرە.',
  },
} as const satisfies PhraseBook;
