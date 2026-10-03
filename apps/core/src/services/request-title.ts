/**
 * A new request's title, made from the requester's words without a model (ADR-182, ADR-180, ADR-231).
 *
 * The title is the office's name for a design and, without its "Client: " prefix, the requester's. It is
 * made from the first line of the brief as people say it: no greeting, no request around it, no
 * direction mark at its edges, and the client named once. On 2026-10-01 at 13:58Z the words "Can you
 * make an Instagram post announcing our Assessment Literacy Workshop for school principals? It's on
 * 15 October 2026 …" became "Instagram post announcing our Assessment Lite…": the format and the verb
 * around the subject were kept, and the subject cut off. ADR-231 strips that lead-in too and keeps the
 * subject ("Assessment Literacy Workshop").
 *
 * Pure. `chat-campaign-intake.ts` calls `requestTitle`; it is the fallback whenever no grounded
 * headline names the design.
 */
import { requestOperatingSubject } from '@hawa/domain';
import { TITLE_CUT_LENGTH, trimTitleMarks } from '@hawa/integrations';
import { afterPossessive, cutText, startsWithName } from '../core-helpers.js';
import { ADDRESS_WORDS, GREETING_WORDS } from './greetings.js';

const TITLE_NOUNS = 'poster|postr|flyer|banner|design|invitation|invite|card|post|story|brochure|certificate|announcement|graphic|cover|leaflet|infographic|thumbnail|ad|advert';
/** A greeting and whom it greets ("Hi there,", Sorani "hello brother", greetings.ts) before the name. */
const TITLE_GREETING = new RegExp(`^(?:(?:${GREETING_WORDS}|dear\\s+(?:${ADDRESS_WORDS}))(?:[\\s,،]+(?:${ADDRESS_WORDS}))*(?=[\\s,،!.:-]|$)[\\s,،!.:-]*)+`, 'iu');
const TITLE_REQUEST = new RegExp('^(?:(?:and|also|so|ok(?:ay)?|please|pls|plz|kindly)\\s+)*' +
  '(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?(?:make|mak|create|design|prepare|produce|do)\\s+(?:us\\s+|me\\s+)?|' +
  "(?:we|i)\\s+(?:need|want|would\\s+like|'d\\s+like)\\s+|(?:please\\s+)?(?:make|mak|create|design|prepare|produce)\\s+(?:us\\s+|me\\s+)?)?" +
  "(?:(?:a|an|another|one\\s+more|new|the)\\s+)?" +
  `(?=(?:[\\p{L}'-]+\\s+){0,2}(?:${TITLE_NOUNS})s?\\b)`, 'iu');
/**
 * ADR-284 addendum (follow-up, 2026-10-03): a design asked for as "something": "we need something for our staff
 * picnic …", "could you do something for the science fair …", "we're hoping for something for the graduation
 * party …" were named after the request ("There, we need something for our staff picnic").
 */
const TITLE_SOMETHING = new RegExp('^(?:(?:and|also|so|ok(?:ay)?|please)\\s+)*(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?(?:make|create|design|prepare|produce|do|get)\\s+(?:us\\s+|me\\s+)?|' +
  "(?:can|could|may)\\s+(?:we|i)\\s+(?:please\\s+)?(?:get|have)\\s+|(?:we|i)\\s*(?:need|want|(?:'d|’d|\\s+would)\\s+(?:like|love)|(?:'re|’re|\\s+are|'m|’m|\\s+am)\\s+(?:hoping|looking)\\s+for)\\s+)" +
  '(?:something|anything)\\s+(?:(?:nice|simple|special|small|quick)\\s+)?(?:for|about|to\\s+(?:announce|promote|advertise|celebrate))\\s+(?:(?:our|my|the|this|their|a|an)\\s+)?', 'iu');
const TITLE_NOUN_PLEASE = new RegExp(`^(?:${TITLE_NOUNS})s?\\s+(?:please|pls|plz)\\s*[:,-]\\s*`, 'iu');
/**
 * ADR-231: the format and the verb before the subject: "Instagram post announcing our …", "a poster
 * promoting the …", "flyer about our …", "story to announce …", "banner for our …". "Poster for the
 * graduation ceremony" keeps its words: "for" is a lead-in only before "our" or "my".
 */
const TITLE_FORMAT_LEAD = new RegExp('^(?:(?:a|an|the|one)\\s+)?' +
  '(?:(?:instagram|insta|facebook|fb|linkedin|twitter|tiktok|whatsapp|telegram|social[\\s-]+media|web|website|digital|printed|print|a[345]|square|vertical|story)\\s+)*' +
  `(?:${TITLE_NOUNS})s?\\s+` +
  '(?:announcing|advertising|promoting|introducing|celebrating|about|(?:to\\s+)?(?:announce|promote|advertise|celebrate|introduce)|' +
  'inviting\\s+(?:\\p{L}+\\s+){0,2}to|for(?=\\s+(?:our|my)\\b))\\s+(?:(?:our|my|the|this|a|an)\\s+)?', 'iu');
/**
 * Live 2026-10-02 (canary chat): "a Canary Test poster for the Autumn Fair on 1 November …" was titled
 * "Canary Test poster for the Autumn Fair on 1 N…". A client's or brand's name before the format, and
 * "for the" before a capitalised name, are lead-ins too. Both are case-sensitive (no `i` flag: under
 * `iu`, \p{Lu} matches any letter), so "poster for the graduation ceremony" keeps its words.
 */
const NAME_BEFORE_FORMAT = new RegExp(`^(?:\\p{Lu}[\\p{L}\\p{N}&'’-]*\\s+){1,3}(?=(?:${TITLE_NOUNS})s?\\s)`, 'u');
const FORMAT_FOR_THE_NAME = new RegExp(`^(?:${TITLE_NOUNS})s?\\s+for\\s+(?:the\\s+)?(?=\\p{Lu})`, 'u');
/** Small words inside a name ("Festival of Lights", "Art & Music Week"): kept between capitalised words. */
const NAME_JOINERS = /^(?:of|and|&|for|in|on|the|to|at|de|al|el)$/iu;

/**
 * The subject after a format lead-in, as far as its first sentence goes; a run of capitalised words
 * at its start ("Assessment Literacy Workshop for school principals") is its name.
 */
function subjectName(rest: string): string {
  const sentence = rest.split(/[?؟!]|\.(?=\s|$)|\n/u)[0].replace(/[\s,:;،]+$/u, '').trim();
  const words = sentence.split(/\s+/).filter(Boolean);
  const named: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const capital = /^[\p{Lu}\d]/u.test(word);
    if (capital) { named.push(word); continue; }
    // "Autumn Fair on 1 November": a joiner before a number starts the date, not more of the name.
    if (named.length && NAME_JOINERS.test(word) && words[i + 1] && /^\p{Lu}/u.test(words[i + 1])) { named.push(word); continue; }
    break;
  }
  return named.length >= 2 ? named.join(' ').replace(/[\s,:;،'’-]+$/u, '') : sentence;
}

/**
 * ADR-182: a design's name as people say it: its first line without the greeting and the request
 * around it ("Hi, we need a poster for the graduation ceremony" → "Poster for the graduation
 * ceremony", "Another poster please: KAAE staff football tournament" → "KAAE staff football
 * tournament"). The requester hears the name in every answer ("I'm making a first draft of …"), which
 * read "a first draft of Hi, we need a poster for …". A line that is nothing but a request keeps its
 * words. ADR-231: "an Instagram post announcing our Assessment Literacy Workshop …" → "Assessment
 * Literacy Workshop".
 */
export function spokenTitle(line: string): string {
  const greeted = line.replace(TITLE_GREETING, '');
  const something = TITLE_SOMETHING.exec(greeted);
  if (something) {
    const subject = subjectName(greeted.slice(something[0].length));
    if (/\p{L}/u.test(subject)) return subject.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  const lead = greeted.replace(TITLE_REQUEST, '').replace(TITLE_NOUN_PLEASE, '');
  const unnamed = lead.replace(NAME_BEFORE_FORMAT, '');
  const format = TITLE_FORMAT_LEAD.exec(lead) ?? TITLE_FORMAT_LEAD.exec(unnamed) ?? FORMAT_FOR_THE_NAME.exec(unnamed);
  if (format) {
    const subject = subjectName((format.input === lead ? lead : unnamed).slice(format[0].length));
    if (subject.split(/\s+/).filter(Boolean).length >= 2) return subject.replace(/^[a-z]/, (c) => c.toUpperCase());
  }
  if (lead === line) return line;
  const said = lead.replace(/[\s?؟.!,:]+$/u, '').trim();
  return said.split(/\s+/).filter(Boolean).length < 2 ? line : said.replace(/^[a-z]/, (c) => c.toUpperCase());
}

// --- the name without its date, time and place (ADR-284 addendum, live canary 2026-10-03) ---------------

const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const MONTH_AT = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\p{L}*';
const MONTH_NAME = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
/** A day: "9 October", "October 9", "9/10", "the 9th", "tomorrow". A weekday needs a word before it (below). */
const DAY = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_AT}|${MONTH_AT}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\d{1,2}\\s*[/.]\\s*\\d{1,2}(?:\\s*[/.]\\s*\\d{2,4})?\\b|the\\s+\\d{1,2}(?:st|nd|rd|th)\\b)`;
const HOUR = '(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?![\\p{L}])|\\d{1,2}:\\d{2}\\b|noon\\b|midday\\b|midnight\\b)';
const VENUE_WORD = '(?:hall|hotel|hotell?|ballroom|room|auditorium|theat(?:re|er)|cent(?:re|er)|mall|park|stadium|campus|library|gallery|gardens?|museum|school|university|college|office|building|square|restaurant|cafe|club|venue|lobby|courtyard|arena|citadel)';
/** Where a Sorani month starts (a headline cut at 65 characters may end inside "تشرینی دووەم"). */
const MONTHS_CKB = 'کانوونی|شوبات|ئازار|نیسان|ئایار|حوزەیران|تەمموز|ئاب|ئەیلوول|تشرینی|' +
  'خاکەلێوە|گوڵان|جۆزەردان|پووشپەڕ|گەلاوێژ|خەرمانان|ڕەزبەر|گەڵاڕێزان|سەرماوەز|بەفرانبار|ڕێبەندان|ڕەشەمە';
const DIGIT_CKB = '[\\d٠-٩۰-۹]';
/** Sorani: a day of a month ("٢٠ی ئازار", "٢٥ی مانگ"), a date with slashes, an hour ("کاتژمێر ٥"), a weekday ("ڕۆژی پێنجشەممە"). */
const DAY_CKB = `(?:(?:ڕێکەوتی|بەرواری)\\s+)?(?:${DIGIT_CKB}{1,2}\\s*ی?\\s*(?:${MONTHS_CKB}|مانگ)|${DIGIT_CKB}{1,2}\\s*/\\s*${DIGIT_CKB}{1,2}|کاتژمێر\\s*${DIGIT_CKB}|ڕۆژی\\s+(?:شەممە|یەکشەممە|دووشەممە|سێشەممە|چوارشەممە|پێنجشەممە|هەینی))`;
const VENUE_CKB = '(?:هۆڵی|هۆتێلی|پارکی|سەنتەری|ناوەندی|زانکۆی|قوتابخانەی)';

/**
 * Where the date, time or place said after a design's name starts, as people write them after the name:
 * " on Thursday 9 October", " at 10am", " this Thursday", " next week", " from 9 to 12 November",
 * ", 8 November", " in June", " in the main hall" (a place: only after a name of two words or more, so
 * "Art in the Park" keeps its words), and the Sorani " لە ٢٠ی ئازار", "، ١٢ی تشرینی یەکەم", " لە هۆڵی …".
 * A weekday needs a word before it ("on", "this", "next", a comma): "Black Friday Sale" is a name.
 */
const TAILS: Array<{ re: RegExp; twoWords?: true }> = [
  { re: new RegExp(`(?:\\s+(?:on|from|starting|until|till|by|every)\\s+(?:the\\s+)?|\\s*[,;–—]\\s*|\\s+-\\s+|\\s+)${DAY}`, 'iu') },
  { re: new RegExp(`(?:\\s+(?:on|this|next|coming|every)\\s+|\\s*[,;–—]\\s*)${WEEKDAY}\\b`, 'iu') },
  { re: /\s+(?:this|next|coming)\s+(?:week(?:end)?|month|year|term|semester)\b|\s+(?:tomorrow|today|tonight)\b/iu },
  { re: new RegExp(`\\s+(?:from|between)\\s+(?:the\\s+)?(?:\\d|${WEEKDAY}\\b|${MONTH_AT}\\s+\\d)`, 'iu') },
  { re: new RegExp(`(?:\\s+(?:at|from|@)\\s+|\\s*[,;–—]\\s*|\\s+)${HOUR}`, 'iu') },
  { re: new RegExp(`\\s+in\\s+(?:early\\s+|late\\s+|mid-?)?${MONTH_NAME}\\b`, 'iu') },
  { re: new RegExp(`\\s+(?:in|at)\\s+(?:the\\s+)?(?:[\\p{L}\\p{N}'’&.-]+\\s+){0,4}?${VENUE_WORD}\\b`, 'iu'), twoWords: true },
  { re: /\s+(?:in|at)\s+the\s+\S/iu, twoWords: true },
  { re: new RegExp(`(?:\\s+لە\\s+|\\s*[،,]\\s*|\\s+)${DAY_CKB}`, 'u') },
  { re: new RegExp(`(?:\\s+لە\\s+|\\s*[،,]\\s*)${VENUE_CKB}\\s`, 'u'), twoWords: true },
];
/**
 * "for school principals", "for all students": who it is for, at the end of the name, said with a word for
 * people. "Invitation card for the graduation ceremony" names its event, and "Run for Hope" is a name.
 */
const AUDIENCE = /\s+for\s+(?:(?:the|our|all|every|new)\s+)?(?:[\p{L}-]+\s+){0,2}(?:principals|deans|students|pupils|teachers|parents|staff|members|employees|families|children|kids|alumni|graduates|everyone|public|participants|attendees|guests|professors|lecturers|academics|doctors|nurses|youth|women|men|managers|leaders|colleagues|faculty|trainees|beginners|researchers|volunteers|partners|customers|clients)$/iu;
/** A head that is a sentence rather than a name ("we're hoping for something …", "could we get …"). */
const NOT_A_NAME = /\b(?:i|i'm|we|we're|we'd|you|could|can|would|will|need|want|like|hoping|make|do|get|please|something|anything)\b/iu;
const FORMAT_ONLY = new RegExp(`^(?:(?:a|an|the|our|my|this)\\s+)?(?:${TITLE_NOUNS})s?$`, 'iu');
/** Small words kept small inside a title-cased name. */
const SMALL_WORDS = /^(?:a|an|the|and|or|of|for|in|on|at|to|by|with|from|&)$/iu;

const wordsOf = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
/** The name before `index`, without the separators and small words left at its end. */
const headAt = (name: string, index: number) => name.slice(0, index).replace(/(?:[\s,;:–—·-]+|\s+(?:and|or|on|at|in|for|the|from|لە|و))+$/iu, '').trim();
/** A head that still names something: a word with letters, and more than a format ("Poster"). */
const namesSomething = (head: string, twoWords: boolean) => {
  const words = wordsOf(head);
  return words.length >= (twoWords ? 2 : 1) && words.some((w) => /\p{L}/u.test(w)) && !FORMAT_ONLY.test(head);
};

/**
 * ADR-284 addendum (live canary 2026-10-03): "Hi! Could you make a poster announcing our staff workshop on
 * Thursday 9 October at 10am in the main hall?" was named "Staff workshop on Thursday 9 October at 10am in
 * the main…" to the requester and the office. A title names the thing ("Staff Workshop"): the name stops
 * before the date, time or place said after it, and, when the name is still longer than `fit`, before an
 * audience said in small letters ("for school principals"). A name the requester wrote whole keeps their
 * words and casing; a Latin name taken out of a longer phrase is title-cased as people write event names.
 * Only the title changes: the copy keeps every word. A name that would lose its last word stays as it was.
 */
export function titleName(line: string, fit = TITLE_CUT_LENGTH): string {
  const name = line.replace(/[\s?؟!.,،:;]+$/u, '').trim();
  let cut = -1;
  for (const tail of TAILS) {
    const m = tail.re.exec(name);
    if (m && m.index > 0 && (cut < 0 || m.index < cut) && namesSomething(headAt(name, m.index), Boolean(tail.twoWords))) cut = m.index;
  }
  let head = cut > 0 ? headAt(name, cut) : name;
  // An audience goes with the date it was said beside, or when the name would not fit whole.
  const audience = (cut > 0 || Array.from(head).length > fit) ? AUDIENCE.exec(head) : null;
  if (audience && audience.index > 0) {
    const named = headAt(head, audience.index);
    if (namesSomething(named, true) && !NOT_A_NAME.test(named)) head = named;
  }
  if (head === name) return line;
  const words = head.split(/\s+/);
  // Title case only for a short Latin name (a sentence left by an unrecognised lead-in keeps its casing).
  if (/[؀-ۿ]/u.test(head) || words.length > 6) return head;
  return words.map((word, i) => (i > 0 && SMALL_WORDS.test(word)) || /\p{Lu}/u.test(word) ? word
    : word.replace(/^\p{Ll}/u, (c) => c.toUpperCase())).join(' ');
}

/**
 * A request's title from its headline (the first line that names it) and its label (the client's short
 * name, else the sender's): "<label>: <name>…", or "<name>…" when the name already starts with the
 * label ("KAAE K-12 Pilot Study…", never "KAAE: KAAE K-12 Pilot Study…"), with no direction mark at
 * either edge. A name that starts with a client label as a possessive is titled without it (ADR-253).
 * `rawText` lets an operating subject ("a poster for the …") name a headline that is only a
 * date or a role (`requestOperatingSubject`).
 */
export function requestTitle(input: { headline: string; label: string; rawText?: string;
  /** ADR-253: the label is the client's short name (not the sender's): its possessive is left out. */
  clientLabel?: boolean }): string {
  const label = trimTitleMarks(input.label);
  const headline = input.rawText !== undefined ? requestOperatingSubject(input.rawText, input.headline) ?? input.headline : input.headline;
  const said = trimTitleMarks(spokenTitle(trimTitleMarks(headline)));
  // ADR-253 (L21): "KAAE's Quality Assurance Workshop" is titled "KAAE: Quality Assurance Workshop…", the
  // same form as any other title, never "KAAE's …" beside a sibling's "KAAE: …".
  // ADR-284 addendum (live canary 2026-10-03): the name without the date, time and place said after it.
  const line = titleName((input.clientLabel && label && afterPossessive(said, label)) || said);
  if (!line) return `${label}: no copy sent`;
  // ADR-255 (live 2026-10-02): "…" says the name was cut; a whole name ("Harvest Fair") ends as it is.
  const cut = cutText(line, TITLE_CUT_LENGTH);
  const name = cut === line ? line : `${trimTitleMarks(cut)}…`;
  return label && !startsWithName(line, label) ? `${label}: ${name}` : name;
}
