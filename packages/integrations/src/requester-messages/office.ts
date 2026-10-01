/**
 * Office messages (ADR-040 addendum, 2026-09-30): what the bot says to an office member who approves,
 * sends back or rejects a draft in their private Telegram chat, in plain words
 * (apps/core/src/services/office-telegram-turn.ts). Office members are not requesters: they may be told
 * of Hawa Desk and Canva, but never asked for a command or a format. Every Sorani line awaits native
 * review (SORANI_REVIEW.md).
 *
 * `{title}` is the design's name (bold), `{requester}` who asked for it (bold, or "you"), `{words}` the
 * requester's own words (quoted), `{list}` numbered design names. HTML callers escape every value.
 */
import type { PhraseBook } from './types.js';

export const OFFICE_MESSAGES = {
  /** Approved through the Desk's own path, and its delivery started. */
  approvedSending: {
    en: 'Approved. Sending {title} to {requester} now.',
    ckb: 'پەسەند کرا. ئێستا {title} بۆ {requester} دەنێرم.',
  },
  /** The office member's words went back as the Desk's "Request Revision": the requester is asked next. */
  sentBack: {
    // ADR-182: {requester} is "the requester" when their name is unknown, so it no longer starts a sentence.
    en: 'Sent back for changes with your words. I have sent your note on {title} to {requester}; the next draft starts once they answer.',
    ckb: 'بە وشەکانی خۆت بۆ گۆڕانکاری گەڕێندرایەوە. تێبینییەکەتم لەسەر {title} بۆ {requester} نارد؛ ڕەشنووسی داهاتوو دوای وەڵامی ئەو دەست پێدەکات.',
  },
  /** The same, for the office member's own request (the owner): they are asked as the requester next. */
  sentBackOwn: {
    en: 'Sent back for changes with your words. I have asked you, as the one who asked for {title}, what to change; the next draft starts once you answer.',
    ckb: 'بە وشەکانی خۆت بۆ گۆڕانکاری گەڕێندرایەوە. وەک داواکاری {title} لێت پرسیم چی بگۆڕدرێت؛ ڕەشنووسی داهاتوو دوای وەڵامەکەت دەست پێدەکات.',
  },
  /** Rejected through the Desk's reject path; the requester is not sent anything by it. */
  rejected: {
    en: 'Rejected: {title}. Nothing was sent to {requester}.',
    ckb: 'ڕەتکرایەوە: {title}. هیچ شتێک بۆ {requester} نەنێردرا.',
  },
  /** Several drafts wait and nothing says which one. */
  whichDraft: {
    en: 'Which draft do you mean?\n{list}\n\nAnswer with the number or the name.',
    ckb: 'مەبەستت کام ڕەشنووسە؟\n{list}\n\nبە ژمارە یان ناو وەڵام بدەرەوە.',
  },
  /**
   * ADR-040 addendum (incident 2026-10-01): an answer to a question the bot asked too long ago, or under
   * reading rules that have since changed. Nothing is done with it. ADR-239: plain chat, no reply target
   * (it said "please reply to the draft picture with what you want").
   */
  lostTrack: {
    en: 'I\'ve lost track of that question, so I haven\'t done anything. Just tell me again what you\'d like me to do with the draft.',
    ckb: 'ئەو پرسیارەم لێ ون بوو، بۆیە هیچم نەکرد. تەنها جارێکی تر پێم بڵێ دەتەوێت چی لە ڕەشنووسەکە بکەم.',
  },
  /**
   * ADR-040 addendum (2026-10-01): each draft in the "which draft?" list says what tells it apart from
   * the others: when it was sent to this member, how many photos its request has, which is the newest,
   * and who asked for it when they are not all the same person. `{n}` is a count, `{time}` a 24-hour
   * clock time in Iraq, `{when}` one of the times below.
   */
  sentWhen: {
    en: 'sent {when}',
    ckb: '{when} نێردرا',
  },
  justNow: {
    en: 'just now',
    ckb: 'ئێستا',
  },
  aMinuteAgo: {
    en: 'a minute ago',
    ckb: 'پێش خولەکێک',
  },
  minutesAgo: {
    en: '{n} minutes ago',
    ckb: 'پێش {n} خولەک',
  },
  todayAt: {
    en: 'today {time}',
    ckb: 'ئەمڕۆ {time}',
  },
  yesterdayAt: {
    en: 'yesterday {time}',
    ckb: 'دوێنێ {time}',
  },
  daysAgo: {
    en: '{n} days ago',
    ckb: 'پێش {n} ڕۆژ',
  },
  noPhotos: {
    en: 'no photos',
    ckb: 'بێ وێنە',
  },
  onePhoto: {
    en: '1 photo',
    ckb: '1 وێنە',
  },
  photos: {
    en: '{n} photos',
    ckb: '{n} وێنە',
  },
  newest: {
    en: 'newest',
    ckb: 'نوێترین',
  },
  fromRequester: {
    en: 'from {requester}',
    ckb: 'داواکراوە لەلایەن {requester}',
  },
  /**
   * Words with no reply, applied to the draft whose picture this member was sent last (within two
   * hours, with no other draft sent close to it): the answer names it first, so a wrong guess shows.
   */
  aboutDraft: {
    en: 'About the {title} draft I sent you {when}:',
    ckb: 'دەربارەی ڕەشنووسی {title} کە {when} بۆم ناردیت:',
  },
  /** Words about a draft that say neither approve, change nor reject. */
  whatToDo: {
    en: 'What should I do with {title}: approve it and send it, send it back with changes, or reject it? Just tell me in your own words.',
    ckb: 'چی لە {title} بکەم: پەسەندی بکەم و بینێرم، بۆ گۆڕانکاری بیگەڕێنمەوە، یان ڕەتی بکەمەوە؟ تەنها بە وشەکانی خۆت پێم بڵێ.',
  },
  /** The requester wrote after the draft reached the office: nothing is approved until someone has read it. */
  lateWords: {
    en: 'Not approved yet: {requester} wrote after {title} reached the office:\n\n{words}\n\nShould I approve it and send it anyway, or send it back with a change?',
    ckb: 'هێشتا پەسەند نەکراوە: {requester} دوای ئەوەی {title} گەیشتە ئۆفیس ئەمەی نووسی:\n\n{words}\n\nسەرەڕای ئەمە پەسەندی بکەم و بینێرم، یان بە گۆڕانکارییەک بیگەڕێنمەوە؟',
  },
  /** Someone decided first (in Hawa Desk or here): approved, being sent or sent. */
  alreadyApproved: {
    en: '{title} was already approved, so I did nothing more.',
    ckb: '{title} پێشتر پەسەند کرابوو، بۆیە هیچی ترم نەکرد.',
  },
  alreadySentBack: {
    en: '{title} was already sent back for changes, so I did nothing more.',
    ckb: '{title} پێشتر بۆ گۆڕانکاری گەڕێندرابووەوە، بۆیە هیچی ترم نەکرد.',
  },
  alreadyRejected: {
    en: '{title} was already rejected, so I did nothing more.',
    ckb: '{title} پێشتر ڕەتکرابووەوە، بۆیە هیچی ترم نەکرد.',
  },
  /** The picture answered is of an earlier draft; a newer one waits. */
  olderDraft: {
    en: 'That picture is of an earlier draft of {title}, so I did nothing. A newer draft is waiting for review.',
    ckb: 'ئەو وێنەیە هی ڕەشنووسێکی پێشووی {title}ـە، بۆیە هیچم نەکرد. ڕەشنووسێکی نوێتر چاوەڕێی پێداچوونەوەیە.',
  },
  /** The design is being made, or waits for its requester: nothing to decide now. */
  notWaiting: {
    en: '{title} is not waiting for review right now, so I did nothing.',
    ckb: '{title} ئێستا چاوەڕێی پێداچوونەوە نییە، بۆیە هیچم نەکرد.',
  },
  /** The Desk's QA gate: the latest automatic check did not pass. */
  checkFailed: {
    en: "I can't approve {title}: its automatic check did not pass. Tell me what to change, or fix it in Canva and check it again in Hawa Desk.",
    ckb: 'ناتوانم {title} پەسەند بکەم: پشکنینە خۆکارەکەی سەرنەکەوت. پێم بڵێ چی بگۆڕدرێت، یان لە Canva چاکی بکە و دووبارە لە Hawa Desk بیپشکنەوە.',
  },
  /** The picture sent here is not the checked file that would be delivered (or none was sent here). */
  useDesk: {
    en: "I can't approve {title} from Telegram: the picture you were sent is not the checked file that would be delivered. Please approve it in Hawa Desk.",
    ckb: 'ناتوانم لە تێلێگرامەوە {title} پەسەند بکەم: ئەو وێنەیەی بۆت نێردرا ئەو فایلە پشکنراوە نییە کە دەنێردرێت. تکایە لە Hawa Desk پەسەندی بکە.',
  },
  /** Named-reviewer deployments (ADR-064): a decision needs a signed-in, assigned reviewer. */
  namedReviewer: {
    en: 'Decisions here need a named reviewer signed in to Hawa Desk, so {title} was not changed.',
    ckb: 'بڕیاردان لێرە پێویستی بە پێداچوونەوەکارێکی ناودارە کە لە Hawa Desk چووبێتە ژوورەوە، بۆیە {title} نەگۆڕدرا.',
  },
  /** A request opened for a designer by hand has no automatic next round (ADR-126). */
  madeByHand: {
    en: "{title} is being made by hand, so it can't go back for automatic changes. Approve or reject it here, or change it in Hawa Desk.",
    ckb: '{title} بە دەست دروست دەکرێت، بۆیە ناتوانرێت بۆ گۆڕانکاری خۆکار بگەڕێندرێتەوە. لێرە پەسەندی بکە یان ڕەتی بکەرەوە، یان لە Hawa Desk بیگۆڕە.',
  },
  /** Approved, but the requester wrote in the moment between: the Desk's delivery holds it. */
  approvedNotSent: {
    en: 'Approved, but not sent yet: {requester} has just written about {title}:\n\n{words}\n\nOpen Hawa Desk to read it and send the design.',
    ckb: 'پەسەند کرا، بەڵام هێشتا نەنێردراوە: {requester} ئێستا دەربارەی {title} نووسیویەتی:\n\n{words}\n\nHawa Desk بکەرەوە بۆ خوێندنەوەی و ناردنی دیزاینەکە.',
  },
  /** Approved, and the delivery was refused for a reason the office must look at. */
  approvedSendFailed: {
    en: 'Approved, but sending {title} could not start. Please send it from Hawa Desk.',
    ckb: 'پەسەند کرا، بەڵام ناردنی {title} دەستی پێنەکرد. تکایە لە Hawa Deskـەوە بینێرە.',
  },
  /** The Desk's path refused for another reason: nothing changed. */
  notRecorded: {
    en: "I couldn't record that for {title}, so nothing was changed. Please use Hawa Desk.",
    ckb: 'نەمتوانی ئەوە بۆ {title} تۆمار بکەم، بۆیە هیچ شتێک نەگۆڕدرا. تکایە Hawa Desk بەکاربهێنە.',
  },
  /**
   * ADR-180: the last line of a draft's photo alert (ADR-155 addendum), now that office members decide
   * in Telegram (ADR-040 addendum). It said "Approve or send it back in Hawa Desk on the office
   * computer". ADR-239: plain chat (natural language only): it said "Reply to this picture with
   * “approved” …". The office chat reads words with no reply as about this draft (ADR-200), and a reply
   * still works.
   */
  draftAlertDecide: {
    en: 'Just say “approved” to send it to {requester}, or tell me what to change. You can also decide in Hawa Desk.',
    ckb: 'تەنها بڵێ «پەسەندە» بۆ ئەوەی بۆ {requester} بنێردرێت، یان پێم بڵێ چی بگۆڕدرێت. دەشتوانیت لە Hawa Desk بڕیار بدەیت.',
  },
  /**
   * ADR-200: before an approval sends a draft to someone other than the approving member, the bot asks
   * once, naming the draft and who gets it. A plain yes sends it; anything else is read as a new message.
   */
  confirmSend: {
    en: 'Send {title} to {requester} now?',
    ckb: 'ئایا ئێستا {title} بۆ {requester} بنێرم؟',
  },
  /** ADR-200: the same, for an approval of the member's own design whose words or draft were not certain. */
  confirmSendOwn: {
    en: 'Approve {title} and send it to you now?',
    ckb: '{title} پەسەند بکەم و ئێستا بۆت بنێرم؟',
  },
  /** ADR-200: a yes to a "Send … now?" asked too long ago: nothing was sent, and it is asked again. */
  askedAgain: {
    en: 'I asked about {title} a while ago, so I haven\'t sent anything yet.',
    ckb: 'ماوەیەک لەمەوبەر دەربارەی {title} پرسیم، بۆیە هێشتا هیچم نەناردووە.',
  },
  /** ADR-200: a no to "Send … now?": nothing is sent, and the draft keeps waiting. */
  notSent: {
    en: 'OK, I haven\'t sent {title}. It is still waiting; tell me what to change, or say send it when it\'s ready.',
    ckb: 'باشە، {title}م نەنارد. هێشتا چاوەڕێیە؛ پێم بڵێ چی بگۆڕم، یان هەر کاتێک ئامادە بوو بڵێ بینێرە.',
  },
  /** ADR-200: a question about a draft: what the office knows of it, then what to do. `{photos}` is a photo count line. */
  draftFacts: {
    en: '{title} is from {requester}, sent to you {when}, with {photos}. What would you like me to do with it?',
    ckb: '{title}: داواکار {requester}، {when} بۆت نێردرا، {photos}. دەتەوێت چی لێ بکەم؟',
  },
  /** Who asked for the design, when it is the office member themselves. */
  you: {
    en: 'you',
    ckb: 'تۆ',
  },
  /** Who asked for the design, when their name is not known. */
  theRequester: {
    en: 'the requester',
    ckb: 'داواکارەکە',
  },
} as const satisfies PhraseBook;
