/**
 * Kurdish Sorani (ckb) and Arabic (ar) Orthographic Normalization Engine.
 *
 * Implements strict, lossless normalization:
 * - Unifies Arabic/Persian Yeh and Kaf variants to standard Kurdish Unicode codepoints
 * - Preserves Zero-Width Non-Joiner (ZWNJ \u200C) for valid grammatical prefixes (دە-, نا-, بێ-) and compound words
 * - Strips redundant or dangling ZWNJs
 * - Preserves display numeral systems (Arabic-Indic, Persian/Kurdish, Latin) without destructive mutation
 */

export interface OrthographyOptions {
  preserveZwnj?: boolean;
  normalizeKafYeh?: boolean;
  normalizeAlef?: boolean;
  stripTatweel?: boolean;
}

export const DEFAULT_ORTHOGRAPHY_OPTIONS: OrthographyOptions = {
  preserveZwnj: true,
  normalizeKafYeh: true,
  normalizeAlef: false, // Display copy must not alter grammatical hamza/alef
  stripTatweel: false, // Do not alter intentional justification
};

/**
 * Normalizes Kurdish Sorani text according to official Unicode standards.
 */
export function normalizeSoraniText(
  text: string,
  options: OrthographyOptions = DEFAULT_ORTHOGRAPHY_OPTIONS
): string {
  if (!text) return '';

  let normalized = text;

  // 1. Unicode Form C normalization
  normalized = normalized.normalize('NFC');

  // 2. Unify Kaf & Yeh (Arabic ك U+0643 -> Kurdish ک U+06A9; Arabic ي U+064A -> Kurdish ی U+06CC)
  if (options.normalizeKafYeh) {
    normalized = normalized
      .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Keheh
      .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Farsi/Kurdish Yeh
      .replace(/\u0649/g, '\u06CC'); // Alef Maksura -> Yeh (in Kurdish contexts)
  }

  // 3. Normalize Tatweel (Kashida \u0640) if requested
  if (options.stripTatweel) {
    normalized = normalized.replace(/\u0640+/g, '');
  }

  // 4. ZWNJ (\u200C) cleanup:
  // - Deduplicate multiple consecutive ZWNJs
  // - Remove dangling ZWNJ next to whitespace or punctuation
  if (options.preserveZwnj) {
    normalized = normalized
      .replace(/\u200C{2,}/g, '\u200C')
      .replace(/\s+\u200C/g, ' ')
      .replace(/\u200C\s+/g, ' ')
      .replace(/^\u200C+|\u200C+$/g, '');
  } else {
    normalized = normalized.replace(/\u200C/g, '');
  }

  return normalized.trim();
}

/**
 * Checks whether a text contains valid Kurdish Sorani specific characters:
 * ڵ (U+06B5), ڕ (U+0695), ڤ (U+06A4), ۆ (U+06C6), ێ (U+06CE), پ (U+067E), چ (U+0686), ژ (U+0698), گ (U+06AF)
 */
export function isLikelySorani(text: string): boolean {
  if (!text) return false;
  // Specific Sorani glyphs that do not exist in standard Arabic
  const soraniSpecificRegex = /[\u06B5\u0695\u06A4\u06C6\u06CE\u067E\u0686\u0698\u06AF\u200C]/;
  return soraniSpecificRegex.test(text);
}

/**
 * Validates that all characters in the text belong to the supported Kurdish Sorani / Arabic / Latin character ranges.
 */
export function validateScriptCoverage(text: string): {
  valid: boolean;
  unsupportedChars: string[];
} {
  // Allow Arabic script (0600-06FF, 0750-077F, 08A0-08FF), Latin (ASCII + Latin-1), numerals, common punctuation, bidi controls
  const supportedRegex = /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u200C\u200D\u2066-\u2069\u202A-\u202E\s\w\d.,!?;:()\[\]{}"'«»—–\-\/\\%٪$€£#@+*=<>]+$/;

  if (supportedRegex.test(text)) {
    return { valid: true, unsupportedChars: [] };
  }

  const unsupportedChars: string[] = [];
  for (const char of text) {
    if (!supportedRegex.test(char) && !unsupportedChars.includes(char)) {
      unsupportedChars.push(char);
    }
  }

  return { valid: unsupportedChars.length === 0, unsupportedChars };
}

export type ScriptType = 'latin' | 'arabic_sorani' | 'mixed';

export interface ScriptDetectionResult {
  script: ScriptType;
  primaryLanguage: 'en' | 'ckb';
  direction: 'ltr' | 'rtl';
  confidence: number;
}

/**
 * Detects whether input text is predominantly Latin (English) or Arabic/Kurdish script.
 * Returns normalized language code ('en' | 'ckb') and CSS text direction ('ltr' | 'rtl').
 */
export function detectScriptAndDirection(text: string): ScriptDetectionResult {
  if (!text || !text.trim()) {
    return { script: 'latin', primaryLanguage: 'en', direction: 'ltr', confidence: 1.0 };
  }

  let latinCount = 0;
  let arabicCount = 0;

  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f)
    ) {
      latinCount++;
    } else if (
      (code >= 0x600 && code <= 0x6ff) ||
      (code >= 0x750 && code <= 0x77f) ||
      (code >= 0x8a0 && code <= 0x8ff)
    ) {
      arabicCount++;
    }
  }

  const total = latinCount + arabicCount;
  if (total === 0) {
    return { script: 'latin', primaryLanguage: 'en', direction: 'ltr', confidence: 1.0 };
  }

  if (arabicCount > latinCount) {
    return {
      script: latinCount > 0 ? 'mixed' : 'arabic_sorani',
      primaryLanguage: 'ckb',
      direction: 'rtl',
      confidence: Number((arabicCount / total).toFixed(2)),
    };
  } else {
    return {
      script: arabicCount > 0 ? 'mixed' : 'latin',
      primaryLanguage: 'en',
      direction: 'ltr',
      confidence: Number((latinCount / total).toFixed(2)),
    };
  }
}
