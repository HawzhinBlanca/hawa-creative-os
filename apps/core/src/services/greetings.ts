/**
 * ADR-284 addendum (follow-up, 2026-10-03): the greetings and forms of address requesters open a brief with, in
 * English, Sorani and Arabic. They are never a design's copy or its name. The copy reader
 * (request-copy-extraction.ts), the laid-out brief's reader (chat-campaign-intake.ts) and the title
 * (request-title.ts) share these words.
 *
 * A Sorani brief opened "hello brother" (سڵاو کاکە) or "good morning" (بەیانی باش) above its request, and the
 * greeting was printed as the design's headline and became its name: only "سڵاو" alone and "بەڕێزان" were
 * known. Sorani and Arabic words are matched without `\b` (ASCII only), so each is followed by a separator
 * where it is used. Every Sorani and Arabic word here needs a native speaker's review.
 */

/**
 * Greetings: hi, hello, hey, good morning/afternoon/evening/day, salam; Sorani hello (two spellings), salam,
 * good morning, good evening, good day, sirs; Arabic hello, peace be upon you, good morning, good evening.
 */
export const GREETING_WORDS = [
  'hi', 'hello', 'hey', 'hiya', 'greetings', 'good\\s+(?:morning|afternoon|evening|day)', 'salam', 'salaam', 'slaw', 'silav',
  'سڵاو', 'سلاو', 'سلام', 'بەیانی\\s+باش', 'ئێوارە\\s+باش', 'ڕۆژ\\s*باش', 'بەڕێزان',
  'مرحبا', 'مرحباً', 'أهلا', 'اهلا', 'السلام\\s+عليكم', 'سلام\\s+عليكم', 'صباح\\s+الخير', 'مساء\\s+الخير',
].join('|');

/**
 * Who is greeted: team, all, everyone, there, …; Sorani brother/sir (کاکە, کاک), sister (خوشکە), friends
 * (هاوڕێیان, برادەران), dear ones (ئازیزان), sirs and sir (بەڕێزان, بەڕێز); Arabic teacher/sir, brother.
 */
export const ADDRESS_WORDS = [
  'team', 'all', 'everyone', 'everybody', 'guys', 'friends', 'there', 'colleagues', 'sir', 'sirs', 'madam',
  'کاکە', 'کاک', 'خوشکە', 'هاوڕێیان', 'برادەران', 'ئازیزان', 'بەڕێزان', 'بەڕێز',
  'استاذ', 'أستاذ', 'اخي', 'أخي',
].join('|');

/** After a Sorani or Arabic word: a separator or the end (`\b` does not see those letters). */
const END = '(?=[\\s,،!.:؛-]|$)';

/** A line or sentence that is only a greeting, with whom it greets ("Hi team!", "Good morning everyone,"). */
export const GREETING_ONLY = new RegExp(`^(?:${GREETING_WORDS}|dear)${END}(?:[\\s,،]+(?:${ADDRESS_WORDS})${END})*[\\s,!.،:؛🙏👋]*$`, 'iu');

export const isGreetingOnly = (text: string): boolean => GREETING_ONLY.test(String(text ?? '').trim());
