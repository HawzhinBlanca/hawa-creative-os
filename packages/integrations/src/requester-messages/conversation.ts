/**
 * Requester messages: conversation (see index.ts). What the bot answers when a message opens no
 * design and changes none (apps/core/src/services/lifecycle-chat-answers.ts, the bridge's own
 * `handleCommand`): a greeting, a question, /start and /help, a typed approval, where the chat's
 * designs stand, and lasting preferences said in chat (standing-rules-chat.ts, telegram-rules-intake.ts).
 * The commands themselves keep working for the office's power users; no answer names one.
 * Every Sorani line awaits native review (SORANI_REVIEW.md).
 *
 * Every phrase here is plain text: no HTML and no Markdown marks, since the bridge sends /start's
 * answer in Markdown and Core sends the others in HTML.
 */
import type { PhraseBook } from './types.js';

export const CONVERSATION_MESSAGES = {
  /** /start and /help (F15): how to ask for a design, in plain words. */
  welcome: {
    en: "👋 Hi! Tell me what you'd like designed, in English or Kurdish, with the text that should go on it. You can add photos, a voice note or a PDF, and tell me any changes in your own words. The office checks every design before it's sent to you here.",
    ckb: '👋 سڵاو! پێم بڵێ چیت دەوێت دیزاین بکرێت، بە کوردی یان ئینگلیزی، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت. دەتوانیت وێنە، تۆمارێکی دەنگی یان PDF زیاد بکەیت، و هەر گۆڕانکارییەک بە وشەی خۆت پێم بڵێیت. ئۆفیسەکە پێش ئەوەی هەر دیزاینێک لێرە بۆت بنێردرێت سەیری دەکات.',
  },
  /** A greeting or short chatter (#62). */
  greeting: {
    en: "👋 Hi! What would you like designed? Tell me in your own words, with the text that should go on it.",
    ckb: '👋 سڵاو! چیت دەوێت دیزاین بکرێت؟ بە وشەی خۆت پێم بڵێ، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت.',
  },
  /** A question that is not about a design in progress (#63). */
  question: {
    en: "Happy to help. Tell me what you'd like designed and the text that should go on it, such as the date, time and place.",
    ckb: 'بە خۆشحاڵییەوە. پێم بڵێ چیت دەوێت دیزاین بکرێت و ئەو دەقەی دەبێت لەسەری بێت، وەک بەروار، کات و شوێن.',
  },
  /**
   * A typed /approve, /publish, /revise or /reject (#67). No office alert is sent for it, so the
   * answer claims none.
   */
  officeGivesFinalCheck: {
    en: "Thanks! The office gives every design a final check before it's sent to you. If anything should change, just tell me here.",
    ckb: 'سوپاس! ئۆفیسەکە پێش ناردنی هەر دیزاینێک بۆت، بۆ دواجار سەیری دەکات. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ.',
  },
  /** A typed /redo or /redrive (#73): the office restarts a design; nothing was started. */
  officeRestarts: {
    en: 'The office looks after every design. If something should be made again or changed, just tell me here in your own words.',
    ckb: 'ئۆفیسەکە ئاگای لە هەموو دیزاینەکانە. ئەگەر شتێک دەبێت دووبارە دروست بکرێتەوە یان بگۆڕدرێت، لێرە بە وشەی خۆت پێم بڵێ.',
  },
  /** An office command sent by someone outside the office (#72). */
  officeOnly: {
    en: "That's something the office does.",
    ckb: 'ئەوە کاری ئۆفیسەکەیە.',
  },

  // /status (#71): the chat's latest designs, in words; no ids, no links.
  statusHeader: {
    en: '📊 Your designs',
    ckb: '📊 دیزاینەکانت',
  },
  statusNone: {
    en: "📊 I haven't made any designs for this chat yet. Tell me what you'd like designed.",
    ckb: '📊 هێشتا هیچ دیزاینێکم بۆ ئەم چاتە دروست نەکردووە. پێم بڵێ چیت دەوێت دیزاین بکرێت.',
  },
  statusUnavailable: {
    en: "I can't check on your designs just now. Please ask me again in a minute.",
    ckb: 'ئێستا ناتوانم سەیری دیزاینەکانت بکەم. تکایە دوای خولەکێک دووبارە لێم بپرسەوە.',
  },
  stateDesigning: { en: 'being designed', ckb: 'دیزاین دەکرێت' },
  stateChecking: { en: 'being checked', ckb: 'پشکنینی بۆ دەکرێت' },
  stateInReview: { en: 'with the office for a final check', ckb: 'لای ئۆفیسەکەیە بۆ دوایین پشکنین' },
  stateReplaced: { en: 'replaced by a newer version', ckb: 'وەشانێکی نوێتر جێگەی گرتەوە' },
  stateApproved: { en: 'approved, and will be sent to you shortly', ckb: 'پەسەند کراوە و بەم زووانە بۆت دەنێردرێت' },
  stateDelivering: { en: 'being sent to you now', ckb: 'ئێستا بۆت دەنێردرێت' },
  stateDelivered: { en: 'delivered', ckb: 'گەیەندرا' },
  stateWaitingForAnswer: { en: 'waiting for your answer to a question', ckb: 'چاوەڕێی وەڵامی تۆیە بۆ پرسیارێک' },
  stateNoLongerWaiting: {
    en: 'no longer waiting: answered, or replaced by a newer change',
    ckb: 'چیتر چاوەڕێ ناکات: وەڵام درایەوە، یان گۆڕانکارییەکی نوێتر جێگەی گرتەوە',
  },
  stateDelayed: { en: "delayed; I'm trying again", ckb: 'دواکەوتووە؛ دووبارە هەوڵ دەدەمەوە' },
  stateWithOffice: { en: 'a designer at the office is finishing it', ckb: 'دیزاینەرێک لە ئۆفیسەکە تەواوی دەکات' },
  stateStopped: { en: 'stopped by the office', ckb: 'ئۆفیسەکە ڕایگرت' },
  stateCancelled: { en: 'cancelled', ckb: 'هەڵوەشێنرایەوە' },
  stateInProgress: { en: 'in progress', ckb: 'لە کاردایە' },

  // Lasting preferences ("from now on, put the logo bottom-right"), F17 and #74/#75.
  preferenceSaved: {
    en: 'Noted. From now on every {client} design will follow this:\n"{rule}"\n\nIf you want it changed, just tell me or the office.',
    ckb: 'تێبینی کرا. لەمەودوا هەموو دیزاینێکی {client} ئەمە ڕەچاو دەکات:\n"{rule}"\n\nئەگەر دەتەوێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ.',
  },
  preferenceAlreadySaved: {
    en: 'I already have this for every {client} design:\n"{rule}"\n\nIf you want it changed, just tell me or the office.',
    ckb: 'ئەمە پێشتر بۆ هەموو دیزاینێکی {client} تۆمار کراوە:\n"{rule}"\n\nئەگەر دەتەوێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ.',
  },
  /** Nothing tells which organisation a preference (or the list of them) is for. */
  whichOrganisation: {
    en: 'Which organisation is this for? Please tell me again with its name in the same message.',
    ckb: 'ئەمە بۆ کام دامەزراوەیە؟ تکایە دووبارە پێم بڵێوە و ناوەکەی لە هەمان پەیامدا بنووسە.',
  },
  preferencesNone: {
    en: 'I have no lasting preferences saved for {client} yet. Tell me one in your own words, for example "from now on, put the logo bottom-right", and every later {client} design will follow it.',
    ckb: 'هێشتا هیچ ڕێنماییەکی هەمیشەییم بۆ {client} تۆمار نەکردووە. بە وشەی خۆت یەکێکم پێ بڵێ، بۆ نموونە «لەمەودوا لۆگۆکە لە خوارەوەی لای ڕاست دابنێ»، و هەموو دیزاینێکی دواتری {client} ڕەچاوی دەکات.',
  },
  preferencesHeader: {
    en: 'What every {client} design follows ({count}):',
    ckb: 'ئەوەی هەموو دیزاینێکی {client} ڕەچاوی دەکات ({count}):',
  },
  preferencesMore: {
    en: '… and {count} more.',
    ckb: '… و {count} دانەی تر.',
  },
  preferencesFooter: {
    en: 'A later one wins over an earlier one, and what you ask for in a request wins over both. If one should change, just tell me or the office.',
    ckb: 'ئەوەی دواتر هاتووە لە پێشترەکە بەهێزترە، و ئەوەی لە داواکارییەکدا دەیخوازیت لە هەردووکیان بەهێزترە. ئەگەر یەکێکیان دەبێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ.',
  },
  preferencesRemoved: {
    en: 'No longer applied to {client} designs:',
    ckb: 'چیتر لە دیزاینەکانی {client} جێبەجێ ناکرێت:',
  },
  preferencesUnmatched: {
    en: '{count} of those numbers did not match a saved preference.',
    ckb: '{count} لەو ژمارانە لەگەڵ هیچ ڕێنماییەکی تۆمارکراو نەگونجا.',
  },
} as const satisfies PhraseBook;
