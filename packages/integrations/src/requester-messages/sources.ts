/** Requester messages: voice notes and PDFs (see index.ts). Every Sorani line awaits native review (SORANI_REVIEW.md). */
import type { PhraseBook } from './types.js';

export const SOURCE_MESSAGES = {
  /** No organisation could be told from the chat or the words. */
  askClientVoice: {
    en: 'Thanks for the voice note! Which organisation is it for?',
    ckb: 'سوپاس بۆ دەنگەکە! بۆ کام دامەزراوەیە؟',
  },
  askClientPdf: {
    en: 'Thanks for the PDF! Which organisation is it for?',
    ckb: 'سوپاس بۆ PDFـەکە! بۆ کام دامەزراوەیە؟',
  },
  /** The answer named no organisation the office works with. */
  clientNotFound: {
    en: "I couldn't find that organisation. Which organisation is it for? If it's a new one, the office can add it.",
    ckb: 'ئەو دامەزراوەیەم نەدۆزییەوە. بۆ کام دامەزراوەیە؟ ئەگەر نوێیە، ئۆفیسەکە دەتوانێت زیادی بکات.',
  },
  /** One design waits for the requester's changes: this recording or file may be about it. */
  askChangeOrNew: {
    en: 'Is this for a change to {title}, or for a new design?',
    ckb: 'ئەمە بۆ گۆڕانکارییە لە {title}، یان بۆ دیزاینێکی نوێیە؟',
  },
  /** Several designs wait: which one, or a new one. `{list}` is numbered, one per line. */
  askWhichDesign: {
    en: 'Which design is this for?\n{list}',
    ckb: 'ئەمە بۆ کام دیزاینە؟\n{list}',
  },
  newDesignOption: {
    en: 'A new design',
    ckb: 'دیزاینێکی نوێ',
  },
  /** A voice note turned into text: the requester confirms it or corrects it. */
  heard: {
    en: 'Here is what I heard:\n\n«{text}»\n\nIs this exactly the text for the design? If not, send me the corrected text.',
    ckb: 'ئەمە ئەوەیە کە بیستم:\n\n«{text}»\n\nئایا ئەمە ڕێک دەقی دیزاینەکەیە؟ ئەگەر نا، دەقە ڕاستکراوەکەم بۆ بنێرە.',
  },
  /** A PDF whose text is short enough to confirm as it is. */
  readPdf: {
    en: 'Here is the text I found in your PDF:\n\n«{text}»\n\nIs this exactly the text for the design? If not, send me the corrected text.',
    ckb: 'ئەمە ئەو دەقەیە کە لە PDFـەکەتدا دۆزیمەوە:\n\n«{text}»\n\nئایا ئەمە ڕێک دەقی دیزاینەکەیە؟ ئەگەر نا، دەقە ڕاستکراوەکەم بۆ بنێرە.',
  },
  /** A PDF with more text than one design takes: the requester sends the words to use. */
  readPdfLong: {
    en: 'Thanks, I have read your PDF. It has a lot of text, so please send me the exact words that should go on the design. It starts:\n\n«{text}…»',
    ckb: 'سوپاس، PDFـەکەتم خوێندەوە. دەقێکی زۆری تێدایە، بۆیە تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن. سەرەتاکەی ئەمەیە:\n\n«{text}…»',
  },
  /** A long voice note: the requester sends the words to print. */
  heardLong: {
    en: 'Thanks, I have listened to your voice note. It has a lot of words, so please send me the exact words that should go on the design. It starts:\n\n«{text}…»',
    ckb: 'سوپاس، گوێم لە دەنگەکەت گرت. وشەیەکی زۆری تێدایە، بۆیە تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن. سەرەتاکەی ئەمەیە:\n\n«{text}…»',
  },
  /** "No" to the words shown: the corrected text is asked for. */
  sendCorrected: {
    en: 'No problem. Please send me the text exactly as it should appear on the design.',
    ckb: 'کێشە نییە. تکایە دەقەکەم بۆ بنێرە، ڕێک وەک ئەوەی دەبێت لەسەر دیزاینەکە دەربکەوێت.',
  },
  /** "Yes" when the words were too long to confirm as they are, or none could be read. */
  sendExactWords: {
    en: 'Please send me the words that should go on the design, exactly as they should read.',
    ckb: 'تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن، ڕێک وەک ئەوەی دەبێت بخوێنرێنەوە.',
  },
  /** A confirmation that names no voice note or PDF of this sender. */
  sourceNotFound: {
    en: "I couldn't find the voice note or PDF you mean. Could you send it again?",
    ckb: 'ئەو دەنگ یان PDFـەی مەبەستتە نەمدۆزییەوە. دەتوانیت دووبارە بینێریتەوە؟',
  },
  /** A voice note that could not be turned into text here. */
  voiceNoText: {
    en: "Thanks, I've saved your voice note, but I couldn't turn it into text here. Could you type the words that should go on the design? The office can listen to it too.",
    ckb: 'سوپاس، دەنگەکەتم هەڵگرت، بەڵام نەمتوانی لێرە بیکەمە دەق. دەتوانیت ئەو وشانە بنووسیت کە دەبێت لەسەر دیزاینەکە بن؟ ئۆفیسەکەش دەتوانێت گوێی لێ بگرێت.',
  },
  /** A PDF whose text could not be read. */
  pdfNoText: {
    en: "I couldn't read the text in that PDF. Could you paste the words for the design here? The office can look at the file too.",
    ckb: 'نەمتوانی دەقی ناو ئەو PDFـە بخوێنمەوە. دەتوانیت وشەکانی دیزاینەکە لێرە بنووسیت؟ ئۆفیسەکەش دەتوانێت سەیری فایلەکە بکات.',
  },
  /** A "PDF" that is not one, or is too large. */
  fileUnreadable: {
    en: "I couldn't open that file. Could you send it again, or paste the text here?",
    ckb: 'نەمتوانی ئەو فایلە بکەمەوە. دەتوانیت دووبارە بینێریتەوە، یان دەقەکە لێرە بنووسیت؟',
  },
  /** A recording that could not be played. */
  voiceUnplayable: {
    en: "I couldn't play that recording. Could you record it again, or type the text here?",
    ckb: 'نەمتوانی ئەو تۆمارە لێبدەم. دەتوانیت دووبارە تۆماری بکەیتەوە، یان دەقەکە لێرە بنووسیت؟',
  },
  voiceTooLong: {
    en: "That recording is longer than ten minutes, which is more than I can use. Could you send a shorter one, or type the text here?",
    ckb: 'ئەو تۆمارە لە دە خولەک درێژترە، کە زیاترە لەوەی بتوانم بەکاری بهێنم. دەتوانیت دانەیەکی کورتتر بنێریت، یان دەقەکە لێرە بنووسیت؟',
  },
  /** Something about the file did not add up (sent twice with different content, or already used). */
  fileProblem: {
    en: "Something went wrong with that file, so I couldn't use it. Could you send it again?",
    ckb: 'کێشەیەک لەگەڵ ئەو فایلەدا هەبوو، بۆیە نەمتوانی بەکاری بهێنم. دەتوانیت دووبارە بینێریتەوە؟',
  },
  /** The organisation is no longer active. */
  clientInactive: {
    en: "I can't take designs for that organisation right now. Please check with the office.",
    ckb: 'ئێستا ناتوانم دیزاین بۆ ئەو دامەزراوەیە وەربگرم. تکایە لەگەڵ ئۆفیسەکە قسە بکە.',
  },
} as const satisfies PhraseBook;
