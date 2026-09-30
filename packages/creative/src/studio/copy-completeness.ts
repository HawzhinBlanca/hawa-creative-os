/**
 * Free, deterministic checks that the client's copy reads as finished text (ADR-157).
 *
 * Nothing used to look at the words themselves. The KAAE report cover (2026-09-30) went to review
 * with a subtitle ending "…and next steps toward", and hard QA passed it: every check measured
 * where the copy sits and whether it fits, none whether it stops mid-sentence. These checks never
 * change the copy and never block a design. They are findings for the office's review, because the
 * copy is the client's and only the client can say what the missing words are.
 *
 * What is checked, per copy block:
 *  - the block ends on a word that cannot end a phrase: an English article, conjunction or
 *    preposition from a closed list, or a Sorani one from a smaller closed list. A block ending
 *    in "?" is a question and is not checked ("What are you waiting for?");
 *  - brackets that do not pair, and quotation marks that do not pair;
 *  - copy that arrived as a message caption at the messenger's length limit, when the caller knows
 *    the copy's origin, because the messenger may have cut it.
 *
 * `instructionLanguageFindings` adds one more: the instructions name a language the copy lacks.
 */

export const COPY_COMPLETENESS_VERSION = 'copy-completeness.v1';

export type CopyFindingCode = 'COPY_DANGLING_END' | 'COPY_UNBALANCED' | 'COPY_AT_CAPTION_LIMIT' | 'LANGUAGE_MISSING';

/** A non-blocking review finding. It is shown to the office and never stops a design. */
export interface ReviewFinding {
  code: CopyFindingCode | 'FONT_SUBSTITUTED' | 'CONTRAST_UNMEASURED';
  severity: 'warning';
  copyIndex?: number;
  message: string;
}

/**
 * English words that do not end a finished phrase. Closed and deliberately short: phrasal verbs
 * ("Sign in", "Log on", "Stop by") end on particles legitimately, so "in", "on", "up", "by", "out"
 * and "off" are not here.
 */
export const ENGLISH_DANGLING_WORDS: readonly string[] = [
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'toward', 'towards', 'with', 'from', 'into',
  'onto', 'upon', 'than', 'via', 'including', 'between', 'among', 'amongst', 'amid', 'for', 'at', 'our',
  'your', 'their', 'its', 'whose', 'which', 'that', 'because', 'if', 'as', 'about', 'through', 'across',
];

/**
 * Sorani words that do not end a finished phrase: and, or, but, that, for/to, in/from, with/by,
 * with (together), toward, until, on, about (two forms), because, if, like/as. Written in the
 * normalised form `normaliseSorani` produces. Listed for native review in SORANI_REVIEW.md.
 */
export const SORANI_DANGLING_WORDS: readonly string[] = [
  'و', 'یان', 'بەڵام', 'کە', 'بۆ', 'لە', 'بە', 'لەگەڵ', 'بەرەو', 'تا', 'هەتا', 'لەسەر', 'دەربارەی', 'لەبارەی',
  'چونکە', 'ئەگەر', 'وەک',
];

/** The messenger's caption limit (Telegram): copy this long that arrived as a caption may be cut. */
export const CAPTION_LIMIT_CHARS = 1024;

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/;

/**
 * The Sorani spellings keyboards produce for the same word, made one: Arabic yeh and alef maksura
 * to Farsi yeh, Arabic kaf to keheh, teh marbuta and heh-with-joiner to ae, and tatweel and zero-
 * width marks removed. Heh on its own is kept: in Sorani it is also the consonant h.
 */
export function normaliseSorani(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u0647\u200C/g, '\u06D5')
    .replace(/[\u064A\u0649]/g, 'ی')
    .replace(/\u0643/g, 'ک')
    .replace(/\u0629/g, 'ە')
    .replace(/[\u0640\u200B-\u200F\u2066-\u2069\u202A-\u202E]/g, '');
}

const ENGLISH_SET = new Set(ENGLISH_DANGLING_WORDS);
const SORANI_SET = new Set(SORANI_DANGLING_WORDS.map(normaliseSorani));

/** Closing punctuation a finished line may carry after its last word; it is not a word. */
const TRAILING_MARKS = /[\s.,;!\u2026\u060C\u061B\u06D4"'\u201D\u2019\u00BB\u203A)\]}\u2013\u2014-]+$/u;

/** The last word of a block and whether the block ends as a question. */
function lastWord(text: string): { word: string; question: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/[?\u061F]\s*["'\u201D\u2019\u00BB\u203A)\]]*$/u.test(trimmed)) return { word: '', question: true };
  const body = trimmed.replace(TRAILING_MARKS, '');
  const match = body.match(/([\p{L}\p{M}\u200C'\u2019]+)$/u);
  return match ? { word: match[1], question: false } : null;
}

/** The word a block ends on when that word cannot end a phrase, else null. */
export function danglingFinalWord(text: string): string | null {
  const last = lastWord(text);
  if (!last || last.question || !last.word) return null;
  if (ARABIC_LETTER.test(last.word)) return SORANI_SET.has(normaliseSorani(last.word)) ? last.word : null;
  return ENGLISH_SET.has(last.word.toLowerCase().replace(/[\u2019']/g, "'")) ? last.word : null;
}

const BRACKETS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '\uFD3E': '\uFD3F' };
/** Quote pairs counted, not nested: in right-to-left copy « and » are typed either way round. */
const QUOTE_PAIRS: Array<[string, string]> = [['\u201C', '\u201D'], ['\u00AB', '\u00BB'], ['\u2039', '\u203A']];

/** What does not pair in a block: a description per problem, empty when everything pairs. */
export function unbalancedMarks(text: string): string[] {
  const problems: string[] = [];
  const closers = new Map(Object.entries(BRACKETS).map(([open, close]) => [close, open]));
  const stack: string[] = [];
  for (const ch of text) {
    if (BRACKETS[ch]) stack.push(ch);
    else if (closers.has(ch)) {
      if (stack[stack.length - 1] === closers.get(ch)) stack.pop();
      else {
        problems.push(`"${ch}" closes nothing`);
        break;
      }
    }
  }
  if (!problems.length && stack.length) problems.push(`"${stack[stack.length - 1]}" is never closed`);
  const straight = [...text].filter((ch) => ch === '"').length;
  if (straight % 2) problems.push('an odd number of " marks');
  for (const [open, close] of QUOTE_PAIRS) {
    const opens = [...text].filter((ch) => ch === open).length;
    const closes = [...text].filter((ch) => ch === close).length;
    // Some keyboards type the same curly mark on both sides; an even total of one kind still pairs.
    if (opens !== closes && (opens + closes) % 2) problems.push(`${open} and ${close} do not pair`);
  }
  return problems;
}

export interface CopyOrigin {
  /** The copy arrived as a message caption. */
  kind: 'caption';
  /** Its length in characters as received. */
  length: number;
  /** The messenger's caption limit; Telegram's 1024 when absent. */
  limit?: number;
}

/**
 * Review findings for the client's copy, by copyIndex. Pure: the same copy always yields the same
 * findings, and the copy is never changed.
 */
export function checkCopyCompleteness(
  copy: Record<number, string>,
  options: { origin?: CopyOrigin } = {}
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const key of Object.keys(copy).map(Number).sort((a, b) => a - b)) {
    const text = copy[key];
    if (typeof text !== 'string' || !text.trim()) continue;
    const dangling = danglingFinalWord(text);
    if (dangling) {
      findings.push({
        code: 'COPY_DANGLING_END',
        severity: 'warning',
        copyIndex: key,
        message: `COPY_DANGLING_END: block ${key} ends on "${dangling}", which does not end a phrase; the copy may be cut short. Check the wording with the requester.`,
      });
    }
    const marks = unbalancedMarks(text);
    if (marks.length) {
      findings.push({
        code: 'COPY_UNBALANCED',
        severity: 'warning',
        copyIndex: key,
        message: `COPY_UNBALANCED: block ${key} has ${marks.join('; ')}; the copy may be incomplete.`,
      });
    }
  }
  const origin = options.origin;
  if (origin?.kind === 'caption' && origin.length >= (origin.limit ?? CAPTION_LIMIT_CHARS)) {
    findings.push({
      code: 'COPY_AT_CAPTION_LIMIT',
      severity: 'warning',
      message: `COPY_AT_CAPTION_LIMIT: the copy arrived as a caption of ${origin.length} characters, the messenger's limit; the end may have been cut.`,
    });
  }
  return findings;
}

type Language = 'English' | 'Kurdish' | 'Arabic';

/** Language names in instructions, English and Sorani, and the script each needs in the copy. */
const LANGUAGE_NAMES: Array<{ language: Language; script: 'latin' | 'arabic'; pattern: RegExp }> = [
  { language: 'English', script: 'latin', pattern: /\benglish\b|ئینگلیزی|ئنگلیزی/giu },
  { language: 'Kurdish', script: 'arabic', pattern: /\b(?:kurdish|sorani)\b|کوردی|سۆرانی/giu },
  { language: 'Arabic', script: 'arabic', pattern: /\barabic\b|عەرەبی/giu },
];

/** Words just before a language name that say it is not wanted. */
const NEGATION_BEFORE = /(?:\b(?:no|not|without|never|don'?t|do not|instead of|except)\b|بەبێ|نەک)[\s\p{P}]*(?:\S+\s+)?$/iu;

/** Lines of the copy that are written in each script: two or more words of the script's letters. */
function scriptsPresent(copyTexts: string[]): Set<'latin' | 'arabic'> {
  const present = new Set<'latin' | 'arabic'>();
  for (const line of copyTexts.flatMap((t) => t.split(/\r?\n/))) {
    const words = line.split(/\s+/).filter(Boolean);
    const arabicWords = words.filter((w) => ARABIC_LETTER.test(w)).length;
    const latinWords = words.filter((w) => !ARABIC_LETTER.test(w) && (w.match(new RegExp(LATIN_LETTER, 'g')) || []).length >= 2).length;
    if (arabicWords >= 1) present.add('arabic');
    if (latinWords >= 2 && latinWords > arabicWords) present.add('latin');
  }
  return present;
}

/**
 * A finding for each language the requester's instructions ask for that no line of the copy is
 * written in: "in English and Kurdish" over Kurdish copy alone. A language named only to exclude
 * it ("no English") is not asked for. Kurdish and Arabic share a script and are not told apart.
 */
export function instructionLanguageFindings(instructions: string | undefined, copyTexts: string[]): ReviewFinding[] {
  if (!instructions?.trim()) return [];
  const text = normaliseSorani(instructions);
  const present = scriptsPresent(copyTexts.map(normaliseSorani));
  const findings: ReviewFinding[] = [];
  for (const { language, script, pattern } of LANGUAGE_NAMES) {
    const asked = [...text.matchAll(pattern)].some((m) => !NEGATION_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 24), m.index)));
    if (!asked || present.has(script)) continue;
    findings.push({
      code: 'LANGUAGE_MISSING',
      severity: 'warning',
      message: `LANGUAGE_MISSING: the instructions mention ${language}, but no line of the copy is written in it; check with the requester whether copy is missing.`,
    });
  }
  return findings;
}

/**
 * A copy block's lines grouped by script, in order. A line with any Arabic-script letter is
 * Sorani; a line with Latin letters and none of those is English; a line with neither (a date, a
 * number, punctuation) stays with the line before it. A block of one script returns itself whole,
 * byte for byte.
 *
 * The renderer and the Canva deck set a whole block in one face and one direction, from its
 * script. A Sorani block with an English line in it therefore set that line right to left in the
 * Sorani face. Split, each part is its own block and takes its own face and direction.
 */
export function splitCopyByLineScript(text: string): Array<{ text: string; script: 'latin' | 'arabic' }> {
  const scriptOf = (line: string): 'latin' | 'arabic' | null =>
    ARABIC_LETTER.test(line) ? 'arabic' : LATIN_LETTER.test(line) ? 'latin' : null;
  const whole = ARABIC_LETTER.test(text) ? 'arabic' : 'latin';
  const lines = text.split('\n');
  const groups: Array<{ lines: string[]; script: 'latin' | 'arabic' | null }> = [];
  for (const line of lines) {
    const script = scriptOf(line);
    const last = groups[groups.length - 1];
    if (last && (script === null || last.script === null || last.script === script)) {
      last.lines.push(line);
      if (last.script === null) last.script = script;
    } else groups.push({ lines: [line], script });
  }
  if (groups.length <= 1) return [{ text, script: whole }];
  const parts = groups
    .map((g) => {
      // Blank lines at a part's edges belong to neither part.
      let from = 0;
      let to = g.lines.length;
      while (from < to && !g.lines[from].trim()) from++;
      while (to > from && !g.lines[to - 1].trim()) to--;
      return { text: g.lines.slice(from, to).join('\n'), script: (g.script ?? whole) as 'latin' | 'arabic' };
    })
    .filter((p) => p.text.trim());
  return parts.length > 1 ? parts : [{ text, script: whole }];
}
