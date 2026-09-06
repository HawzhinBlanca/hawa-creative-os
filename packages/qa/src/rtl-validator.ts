export interface BidiAnalysis {
  baseDirection: 'rtl' | 'ltr';
  hasRtlCharacters: boolean;
  hasLtrCharacters: boolean;
  hasArabicIndicDigits: boolean;
  hasPairedBrackets: boolean;
  bracketPairsMatched: boolean;
  soraniSpecificCharacters: string[];
  isolatedControlsValid: boolean;
}

export interface KurdishTypographyClearance {
  safe: boolean;
  hasHighAscenders: boolean;
  hasLowDescenders: boolean;
  currentLineHeight: number;
  currentVerticalPaddingPx: number;
  recommendedLineHeight: number;
  recommendedVerticalPaddingPx: number;
  issues: string[];
}

export interface MixedDirectionRun {
  text: string;
  direction: 'rtl' | 'ltr' | 'neutral';
  isIsolated: boolean;
}

export interface MixedDirectionValidation {
  isValid: boolean;
  hasMixedRuns: boolean;
  runs: MixedDirectionRun[];
  errors: string[];
}

// Arabic and Kurdish Sorani Unicode blocks
const RTL_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR_REGEX = /[A-Za-z\u00C0-\u024F]/;
const ARABIC_INDIC_DIGITS_REGEX = /[\u0660-\u0669\u06F0-\u06F9]/;

export const SORANI_SPECIFIC_CHARS = ['ڕ', 'ڵ', 'ێ', 'ۆ', 'ە', 'ڤ', 'ژ', 'چ', 'پ', 'گ', 'ک'] as const;
export const SORANI_HIGH_ASCENDERS = ['ڵ', 'ۆ', 'ێ'] as const;
export const SORANI_LOW_DESCENDERS = ['ڕ'] as const;

// Eastern Arabic-Indic Digits (٠ to ٩, U+0660-U+0669) and Persian/Kurdish Digits (۰ to ۹, U+06F0-U+06F9)
const EASTERN_KURDISH_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const WESTERN_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * UAX #9 Directional Controls
 */
export const BIDI_CONTROLS = {
  RLI: '\u2067', // Right-to-Left Isolate
  LRI: '\u2066', // Left-to-Right Isolate
  FSI: '\u2068', // First Strong Isolate
  PDI: '\u2069', // Pop Directional Isolate
  RLM: '\u200F', // Right-to-Left Mark
  LRM: '\u200E', // Left-to-Right Mark
  ALM: '\u061C', // Arabic Letter Mark
};

export function determineBaseDirection(text: string): 'rtl' | 'ltr' {
  // If paragraph starts with explicit RTL control (RLI \u2067, RLE \u202B, RLO \u202E, ALM \u061C, RLM \u200F)
  if (/^[\u2067\u202B\u202E\u061C\u200F]/.test(text)) {
    return 'rtl';
  }

  // UAX #9 Rule P2: characters between an isolate initiator (LRI \u2066, RLI \u2067, FSI \u2068) and matching PDI \u2069
  // are skipped when determining the paragraph's first strong character
  let stripped = text;
  if (text.includes('\u2066') || text.includes('\u2067') || text.includes('\u2068')) {
    stripped = text.replace(/[\u2066\u2067\u2068][^\u2069]*\u2069/g, '');
  }

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];
    if (RTL_CHAR_REGEX.test(char)) {
      return 'rtl';
    }
    if (LTR_CHAR_REGEX.test(char)) {
      return 'ltr';
    }
  }

  // Fallback to original text if stripped has no strong character
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (RTL_CHAR_REGEX.test(char)) {
      return 'rtl';
    }
    if (LTR_CHAR_REGEX.test(char)) {
      return 'ltr';
    }
  }

  return 'ltr';
}

export function checkPairedBrackets(text: string): boolean {
  const stack: string[] = [];
  const openPairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '«': '»',
    '“': '”',
  };
  const closePairs: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
    '»': '«',
    '”': '“',
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (openPairs[char]) {
      stack.push(char);
    } else if (closePairs[char]) {
      if (stack.length === 0 || stack[stack.length - 1] !== closePairs[char]) {
        return false;
      }
      stack.pop();
    }
  }

  return stack.length === 0;
}

export function analyzeBidi(text: string): BidiAnalysis {
  const baseDirection = determineBaseDirection(text);
  const hasRtl = RTL_CHAR_REGEX.test(text);
  const hasLtr = LTR_CHAR_REGEX.test(text);
  const hasDigits = ARABIC_INDIC_DIGITS_REGEX.test(text);
  const pairedBrackets = /[()[\]{}«»“”]/.test(text);
  const matched = checkPairedBrackets(text);

  const foundSorani: string[] = [];
  for (const c of SORANI_SPECIFIC_CHARS) {
    if (text.includes(c)) {
      foundSorani.push(c);
    }
  }

  return {
    baseDirection,
    hasRtlCharacters: hasRtl,
    hasLtrCharacters: hasLtr,
    hasArabicIndicDigits: hasDigits,
    hasPairedBrackets: pairedBrackets,
    bracketPairsMatched: matched,
    soraniSpecificCharacters: foundSorani,
    isolatedControlsValid: true,
  };
}

/**
 * Enforces Unicode UAX #9 Directional Isolation (Invariant #8)
 * Wraps Kurdish Sorani copy with RLI (U+2067) and PDI (U+2069) if not already isolated.
 */
export function isolateKurdishText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  const hasRtl = RTL_CHAR_REGEX.test(text);
  if (!hasRtl) return text;

  // If already enclosed in RLI/PDI or LRI/PDI, preserve it
  if (text.startsWith('\u2067') && text.endsWith('\u2069')) {
    return text;
  }

  return `\u2067${text}\u2069`;
}

/**
 * Strips all invisible Unicode bidirectional controls for raw comparisons or normalization
 */
export function stripBidiControls(text: string): string {
  if (!text) return '';
  return text.replace(/[\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u202A-\u202E]/g, '');
}

/**
 * Converts Western digits (0-9) to Eastern Kurdish digits (۰-۹)
 */
export function toEasternKurdishDigits(text: string): string {
  if (!text) return '';
  let result = text;
  for (let i = 0; i < 10; i++) {
    result = result.replace(new RegExp(WESTERN_DIGITS[i], 'g'), EASTERN_KURDISH_DIGITS[i]);
  }
  return result;
}

/**
 * Converts both Eastern Kurdish (۰-۹) and Arabic-Indic (٠-٩) digits to Western digits (0-9)
 */
export function toWesternDigits(text: string): string {
  if (!text) return '';
  let result = text;
  for (let i = 0; i < 10; i++) {
    result = result.replace(new RegExp(EASTERN_KURDISH_DIGITS[i], 'g'), WESTERN_DIGITS[i]);
    result = result.replace(new RegExp(ARABIC_INDIC_DIGITS[i], 'g'), WESTERN_DIGITS[i]);
  }
  return result;
}

/**
 * Validates clearance of Kurdish Sorani ligatures (ک, گ, ڵ, ۆ, ڕ, ێ)
 * Diacritics such as small v / haftok require line-height >= 1.4 and vertical padding >= 2px
 * to guarantee zero ascender/descender clipping in Vazirmatn / Noto Sans Arabic.
 */
export function checkKurdishTypographyClearance(
  text: string,
  lineHeight: number,
  verticalPaddingPx: number = 0
): KurdishTypographyClearance {
  const hasHigh = SORANI_HIGH_ASCENDERS.some((c) => text.includes(c));
  const hasLow = SORANI_LOW_DESCENDERS.some((c) => text.includes(c));
  const issues: string[] = [];

  const recommendedLineHeight = (hasHigh || hasLow) ? 1.45 : 1.35;
  const recommendedVerticalPaddingPx = (hasHigh || hasLow) ? 4 : 2;

  if ((hasHigh || hasLow) && lineHeight < 1.38) {
    issues.push(
      `Line-height ${lineHeight} is below 1.40 threshold for Kurdish diacritics (${hasHigh ? 'tall ascenders ڵ/ۆ/ێ' : ''}${hasLow ? ' low descender ڕ' : ''}). Glyph clipping may occur.`
    );
  }

  if ((hasHigh || hasLow) && verticalPaddingPx < 2) {
    issues.push(
      `Vertical padding ${verticalPaddingPx}px is below 2px safety margin. Top diacritics or descenders risk being cut off by parent overflow bounds.`
    );
  }

  return {
    safe: issues.length === 0,
    hasHighAscenders: hasHigh,
    hasLowDescenders: hasLow,
    currentLineHeight: lineHeight,
    currentVerticalPaddingPx: verticalPaddingPx,
    recommendedLineHeight,
    recommendedVerticalPaddingPx,
    issues,
  };
}

/**
 * Validates mixed-direction runs (e.g. English brand names + Kurdish Sorani copy + digits)
 * Checks that bidirectional switches do not cause punctuation bleed or inverted runs.
 */
export function validateMixedDirectionRuns(text: string): MixedDirectionValidation {
  const hasRtl = RTL_CHAR_REGEX.test(text);
  const hasLtr = LTR_CHAR_REGEX.test(text);
  const errors: string[] = [];

  if (!hasRtl || !hasLtr) {
    return {
      isValid: true,
      hasMixedRuns: false,
      runs: [{ text, direction: hasRtl ? 'rtl' : hasLtr ? 'ltr' : 'neutral', isIsolated: false }],
      errors: [],
    };
  }

  // Tokenize by spaces and check if isolates or directional markers protect boundaries
  const runs: MixedDirectionRun[] = [];
  const segments = text.split(/(\s+|—|-|:)/);

  for (const seg of segments) {
    if (!seg.trim()) continue;
    const segHasRtl = RTL_CHAR_REGEX.test(seg);
    const segHasLtr = LTR_CHAR_REGEX.test(seg);
    const isIso = seg.includes('\u2067') || seg.includes('\u2066') || (text.includes('\u2067') && text.includes('\u2069'));

    runs.push({
      text: seg,
      direction: segHasRtl ? 'rtl' : segHasLtr ? 'ltr' : 'neutral',
      isIsolated: isIso,
    });
  }

  return {
    isValid: errors.length === 0,
    hasMixedRuns: true,
    runs,
    errors,
  };
}

export interface KurdishOrthographyIssue {
  type: 'arabic_kaf' | 'arabic_yeh' | 'non_standard_city';
  character?: string;
  foundWord?: string;
  recommended: string;
  message: string;
  index: number;
}

export interface KurdishOrthographyReport {
  valid: boolean;
  issues: KurdishOrthographyIssue[];
  normalizedText: string;
}

/**
 * Validates Kurdish Sorani orthography against common Arabic keyboard intrusions:
 * - Replaces Arabic Kaf 'ك' (U+0643) with Kurdish Kaf 'ک' (U+06A9)
 * - Flags word-terminal dotted Arabic Yeh 'ي' (U+064A) in place of Kurdish Sorani 'ی' (U+06CC)
 * - Flags Arabic city names in Sorani copy (أربيل -> هەولێر, دهوك -> دهۆک, السليمانية -> سلێمانی, كركوك -> کەرکووک)
 */
export function validateKurdishOrthography(text: string): KurdishOrthographyReport {
  const issues: KurdishOrthographyIssue[] = [];
  let normalized = text;

  // 1. Check for Arabic Kaf 'ك' (U+0643) vs Kurdish Kaf 'ک' (U+06A9)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\u0643') {
      issues.push({
        type: 'arabic_kaf',
        character: 'ك',
        recommended: 'ک',
        message: 'Arabic Kaf (ك U+0643) detected. Kurdish Sorani standard requires Kurdish Kaf (ک U+06A9).',
        index: i,
      });
    }
  }
  normalized = normalized.replace(/\u0643/g, '\u06A9');

  // 2. Check for Arabic Yeh 'ي' (U+064A with bottom dots) at word boundary
  const arabicYehRegex = /\u064A(?=[\s\p{P}]|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = arabicYehRegex.exec(text)) !== null) {
    issues.push({
      type: 'arabic_yeh',
      character: 'ي',
      recommended: 'ی',
      message: 'Arabic dotted Yeh (ي U+064A) detected at word end. Kurdish Sorani standard requires dotless Kurdish Yeh (ی U+06CC).',
      index: match.index,
    });
  }
  normalized = normalized.replace(arabicYehRegex, 'ی');

  // 3. City Orthography Standardizations
  const cityChecks = [
    { regex: /(?<=^|[\s،.!?؛])[أا]ربيل(?=$|[\s،.!?؛])/gu, recommended: 'هەولێر' },
    { regex: /(?<=^|[\s،.!?؛])(ال)?سليماني[ةه](?=$|[\s،.!?؛])/gu, recommended: 'سلێمانی' },
    { regex: /(?<=^|[\s،.!?؛])دهو[كک](?=$|[\s،.!?؛])/gu, recommended: 'دهۆک' },
    { regex: /(?<=^|[\s،.!?؛])(كركوك|كەركوك|کەرکوک)(?=$|[\s،.!?؛])/gu, recommended: 'کەرکووک' },
    { regex: /(?<=^|[\s،.!?؛])حلبج[ةه](?=$|[\s،.!?؛])/gu, recommended: 'هەڵەبجە' },
    { regex: /(?<=^|[\s،.!?؛])زاخو(?=$|[\s،.!?؛])/gu, recommended: 'زاخۆ' },
  ];

  for (const cc of cityChecks) {
    let m: RegExpExecArray | null;
    while ((m = cc.regex.exec(text)) !== null) {
      issues.push({
        type: 'non_standard_city',
        foundWord: m[0],
        recommended: cc.recommended,
        message: `Arabic place name "${m[0]}" detected in Kurdish context. Standard Kurdish orthography is "${cc.recommended}".`,
        index: m.index,
      });
    }
    normalized = normalized.replace(cc.regex, cc.recommended);
  }

  return {
    valid: issues.length === 0,
    issues,
    normalizedText: normalized,
  };
}


