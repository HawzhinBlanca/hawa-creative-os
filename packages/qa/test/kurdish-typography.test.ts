import { describe, it, expect } from 'vitest';
import {
  analyzeBidi,
  determineBaseDirection,
  isolateKurdishText,
  stripBidiControls,
  toEasternKurdishDigits,
  toWesternDigits,
  checkKurdishTypographyClearance,
  validateMixedDirectionRuns,
  SORANI_SPECIFIC_CHARS,
  SORANI_HIGH_ASCENDERS,
  SORANI_LOW_DESCENDERS,
  BIDI_CONTROLS,
} from '../src/rtl-validator.js';

describe('Horizon 2: Kurdish Sorani & Arabic RTL Typography Supremacy', () => {
  describe('Glyph & Ligature Identification', () => {
    it('accurately detects all Kurdish Sorani specific characters', () => {
      const sample = 'سڵاو لە ڕێگای کۆمپانیا بەپێی گۆڕانکاری';
      const analysis = analyzeBidi(sample);

      expect(analysis.baseDirection).toBe('rtl');
      expect(analysis.hasRtlCharacters).toBe(true);
      // Must identify Kurdish Sorani distinct letters
      expect(analysis.soraniSpecificCharacters).toContain('ڵ'); // lam with small v
      expect(analysis.soraniSpecificCharacters).toContain('ڕ'); // reh with small v below
      expect(analysis.soraniSpecificCharacters).toContain('ێ'); // yeh with small v
      expect(analysis.soraniSpecificCharacters).toContain('ۆ'); // oe
      expect(analysis.soraniSpecificCharacters).toContain('پ'); // peh
      expect(analysis.soraniSpecificCharacters).toContain('گ'); // gaf
      expect(analysis.soraniSpecificCharacters).toContain('ک'); // keheh
    });

    it('verifies all Kurdish Sorani specific characters constant are non-empty', () => {
      expect(SORANI_SPECIFIC_CHARS.length).toBeGreaterThanOrEqual(10);
      expect(SORANI_HIGH_ASCENDERS).toContain('ڵ');
      expect(SORANI_HIGH_ASCENDERS).toContain('ۆ');
      expect(SORANI_HIGH_ASCENDERS).toContain('ێ');
      expect(SORANI_LOW_DESCENDERS).toContain('ڕ');
    });
  });

  describe('Ascender & Descender Diacritic Clearance Safety', () => {
    it('flags tight line-height (< 1.38) when tall ascenders or low descenders are present', () => {
      const kurdishHeadline = 'هێزی ڕاستەقینە، بەرهەمی پشتڕاستکراو';
      // High ascenders (ێ) and low descenders (ڕ) present
      const clearanceTight = checkKurdishTypographyClearance(kurdishHeadline, 1.25, 0);

      expect(clearanceTight.safe).toBe(false);
      expect(clearanceTight.hasHighAscenders).toBe(true);
      expect(clearanceTight.hasLowDescenders).toBe(true);
      expect(clearanceTight.issues.length).toBeGreaterThanOrEqual(1);
      expect(clearanceTight.recommendedLineHeight).toBe(1.45);
      expect(clearanceTight.recommendedVerticalPaddingPx).toBe(4);
    });

    it('passes clearance when adequate line-height and vertical padding are provided', () => {
      const kurdishHeadline = 'هێزی ڕاستەقینە، بەرهەمی پشتڕاستکراو';
      const clearanceSafe = checkKurdishTypographyClearance(kurdishHeadline, 1.5, 4);

      expect(clearanceSafe.safe).toBe(true);
      expect(clearanceSafe.issues.length).toBe(0);
    });

    it('allows slightly tighter line-height when no tall/low diacritics exist', () => {
      const plainText = 'سەبا دەستکەوت';
      const clearance = checkKurdishTypographyClearance(plainText, 1.36, 2);

      expect(clearance.safe).toBe(true);
    });
  });

  describe('Unicode UAX #9 Directional Isolation (Invariant #8)', () => {
    it('wraps Kurdish copy in RLI (U+2067) and PDI (U+2069) when unisolated', () => {
      const rawCopy = 'نرخی تایبەت: ٢٥٬٠٠٠ دینار';
      const isolated = isolateKurdishText(rawCopy);

      expect(isolated.startsWith(BIDI_CONTROLS.RLI)).toBe(true);
      expect(isolated.endsWith(BIDI_CONTROLS.PDI)).toBe(true);
      expect(isolated).toBe(`\u2067${rawCopy}\u2069`);
    });

    it('is idempotent: does not duplicate isolation controls if already wrapped', () => {
      const rawCopy = 'نرخی تایبەت';
      const wrappedOnce = isolateKurdishText(rawCopy);
      const wrappedTwice = isolateKurdishText(wrappedOnce);

      expect(wrappedTwice).toBe(wrappedOnce);
      expect(wrappedTwice.split('\u2067').length - 1).toBe(1);
    });

    it('does not isolate pure Latin text', () => {
      const latin = 'Hawa Creative OS — Pro Studio';
      expect(isolateKurdishText(latin)).toBe(latin);
    });

    it('strips bidi controls cleanly for raw comparisons', () => {
      const isolated = '\u2067پشتڕاستکراو\u2069';
      expect(stripBidiControls(isolated)).toBe('پشتڕاستکراو');
    });
  });

  describe('Kurdish & Arabic Digit Script Conversion', () => {
    it('converts Western digits to Eastern Kurdish numerals for prices and numbers', () => {
      const priceWestern = '25,000 IQD';
      const priceEastern = toEasternKurdishDigits(priceWestern);

      expect(priceEastern).toBe('۲۵,۰۰۰ IQD');
    });

    it('converts Eastern Kurdish numerals back to Western digits without corruption', () => {
      const phoneEastern = '٠٧٥٠ ١٢٣ ٤٥٦٧';
      const phoneWestern = toWesternDigits(phoneEastern);

      expect(phoneWestern).toBe('0750 123 4567');
    });

    it('roundtrips Kurdish phone numbers and IQD prices safely', () => {
      const original = '0750 123 4567 — 50000 IQD';
      const eastern = toEasternKurdishDigits(original);
      const restored = toWesternDigits(eastern);

      expect(restored).toBe(original);
    });
  });

  describe('Mixed-Direction Bidi Stability Stress-Test', () => {
    it('handles mixed English product name + Kurdish copy + Western numbers', () => {
      const mixed = 'iPhone 16 Pro Max (128GB) — بۆ هەنگاوی داهاتوو';
      const validation = validateMixedDirectionRuns(mixed);

      expect(validation.hasMixedRuns).toBe(true);
      expect(validation.isValid).toBe(true);

      const baseDir = determineBaseDirection(mixed);
      expect(baseDir).toBe('ltr'); // First strong character is 'i' (LTR)
    });

    it('handles Kurdish copy with embedded Latin brand and phone number', () => {
      const kurdishLead = 'داواکاری لە NOVA ONE بکە لە ڕێگەی +964 750 123 4567';
      const baseDir = determineBaseDirection(kurdishLead);

      expect(baseDir).toBe('rtl'); // First strong character is 'د' (RTL)
    });

    it('resolves base direction correctly when Latin product name is wrapped in RLI', () => {
      const isolatedLead = '\u2067NOVA ONE\u2069 — بەرهەمی نوێ';
      const baseDir = determineBaseDirection(isolatedLead);

      // Rule P2: characters between RLI and PDI are skipped, first strong outside is 'ب' (RTL)
      expect(baseDir).toBe('rtl');
    });
  });
});
