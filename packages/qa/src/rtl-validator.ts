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

// Arabic and Kurdish Sorani Unicode blocks
const RTL_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR_REGEX = /[A-Za-z\u00C0-\u024F]/;
const ARABIC_INDIC_DIGITS_REGEX = /[\u0660-\u0669\u06F0-\u06F9]/;
const SORANI_SPECIFIC_CHARS = ['ڕ', 'ڵ', 'ێ', 'ۆ', 'ە', 'ڤ', 'ژ', 'چ', 'پ', 'گ'];

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
