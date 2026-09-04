/**
 * Kurdish Sorani & Arabic RTL Typography Service
 * Enforces Unicode UAX #9 Directional Isolation (Invariant #8),
 * Kurdish ligature metrics, and numeral conversions.
 */

export const SORANI_SPECIFIC_CHARS = ['ڕ', 'ڵ', 'ێ', 'ۆ', 'ە', 'ڤ', 'ژ', 'چ', 'پ', 'گ', 'ک'] as const;
export const SORANI_HIGH_ASCENDERS = ['ڵ', 'ۆ', 'ێ'] as const;
export const SORANI_LOW_DESCENDERS = ['ڕ'] as const;

const EASTERN_KURDISH_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const WESTERN_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const RTL_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

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

/**
 * Enforces Unicode UAX #9 Directional Isolation (Invariant #8)
 * Wraps Kurdish Sorani copy with RLI (U+2067) and PDI (U+2069) if not already isolated.
 */
export function isolateKurdishText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  const hasRtl = RTL_CHAR_REGEX.test(text);
  if (!hasRtl) return text;

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

export interface KurdishTypographyClearance {
  safe: boolean;
  hasHighAscenders: boolean;
  hasLowDescenders: boolean;
  recommendedLineHeight: number;
  recommendedVerticalPaddingPx: number;
  issues: string[];
}

/**
 * Validates clearance of Kurdish Sorani ligatures (ک, گ, ڵ, ۆ, ڕ, ێ)
 * Diacritics such as small v / haftok require line-height >= 1.4 and vertical padding >= 2px
 * to guarantee zero ascender/descender clipping.
 */
export function checkKurdishTypographyClearance(
  text: string,
  lineHeight: number,
  verticalPaddingPx: number = 0
): KurdishTypographyClearance {
  const hasHigh = SORANI_HIGH_ASCENDERS.some((c) => text.includes(c));
  const hasLow = SORANI_LOW_DESCENDERS.some((c) => text.includes(c));
  const issues: string[] = [];

  const recommendedLineHeight = (hasHigh || hasLow) ? 1.48 : 1.35;
  const recommendedVerticalPaddingPx = (hasHigh || hasLow) ? 4 : 2;

  if ((hasHigh || hasLow) && lineHeight < 1.38) {
    issues.push(`Line-height ${lineHeight} is below 1.40 threshold for Kurdish diacritics.`);
  }

  if ((hasHigh || hasLow) && verticalPaddingPx < 2) {
    issues.push(`Vertical padding ${verticalPaddingPx}px is below 2px safety margin.`);
  }

  return {
    safe: issues.length === 0,
    hasHighAscenders: hasHigh,
    hasLowDescenders: hasLow,
    recommendedLineHeight,
    recommendedVerticalPaddingPx,
    issues,
  };
}
