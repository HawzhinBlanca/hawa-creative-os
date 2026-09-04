import { describe, it, expect } from 'vitest';
import {
  normalizeSoraniText,
  isLikelySorani,
  validateScriptCoverage,
  extractProtectedTokens,
} from '../src/index.js';

describe('Domain: Kurdish Sorani Orthography & Enhanced Token Extraction', () => {
  describe('normalizeSoraniText', () => {
    it('normalizes Arabic Kaf and Yeh to standard Kurdish codepoints', () => {
      // Arabic Kaf U+0643 -> Kurdish Keheh U+06A9
      // Arabic Yeh U+064A -> Kurdish Yeh U+06CC
      const input = 'كوردستان و هەولێر و دهۆك'; // with Arabic kaf
      const normalized = normalizeSoraniText(input);
      expect(normalized).toBe('کوردستان و هەولێر و دهۆک');
      expect(normalized.includes('\u0643')).toBe(false);
      expect(normalized.includes('\u06A9')).toBe(true);
    });

    it('preserves legitimate ZWNJ in grammatical compound words', () => {
      // دە‌نووسێت (with ZWNJ \u200C)
      const compoundWord = 'دە\u200Cنووسێت';
      const normalized = normalizeSoraniText(compoundWord, { preserveZwnj: true });
      expect(normalized).toBe('دە\u200Cنووسێت');
    });

    it('cleans dangling or duplicate ZWNJs at word boundaries', () => {
      const dirty = '\u200Cکتێب\u200C\u200Cەکان \u200C ';
      const cleaned = normalizeSoraniText(dirty, { preserveZwnj: true });
      expect(cleaned).toBe('کتێب\u200Cەکان');
    });

    it('preserves Kurdish distinct consonants and vowels (ڕ, ڵ, ڤ, ۆ, ێ, پ, چ, ژ, گ)', () => {
      const allSorani = 'پێنج چوار ژ ژمارە گەورە ڕۆژ هەڵبژاردن دەڤەر';
      const normalized = normalizeSoraniText(allSorani);
      expect(normalized).toBe(allSorani);
    });
  });

  describe('isLikelySorani', () => {
    it('identifies Sorani Kurdish texts containing language-distinct glyphs', () => {
      expect(isLikelySorani('هەولێر پایتەختی هەرێمی کوردستانە')).toBe(true); // contains ێ, گ, ۆ
      expect(isLikelySorani('دە‌چین بۆ بازاڕ')).toBe(true); // contains ZWNJ, چ, ڕ
    });

    it('returns false for pure standard Arabic without Sorani-specific letters', () => {
      expect(isLikelySorani('مرحبا بكم في فندق أستر')).toBe(false);
      expect(isLikelySorani('Hello World')).toBe(false);
    });
  });

  describe('validateScriptCoverage', () => {
    it('approves complete mixed Kurdish Sorani, Arabic, English, and digits', () => {
      const text = 'ئۆفەری Aster Hotel بە ٢٥٬٠٠٠ دینار (Call: 07501234567) داشکاندنی 25%!';
      const res = validateScriptCoverage(text);
      expect(res.valid).toBe(true);
      expect(res.unsupportedChars).toHaveLength(0);
    });

    it('flags unmapped foreign alphabets', () => {
      const text = 'Kurdish text with Cyrillic: Привет';
      const res = validateScriptCoverage(text);
      expect(res.valid).toBe(false);
      expect(res.unsupportedChars).toContain('П');
    });
  });

  describe('extractProtectedTokens enhanced coverage', () => {
    it('extracts multi-currency price tokens in Latin, Arabic-Indic, and Persian digits', () => {
      const text = 'Prices: $50, 100,000 IQD, 75€, 25 EUR, ٢٥٬٠٠٠ دینار, ٥٠٠٠ د.ع, داشکاندنی ٥٠٪';
      const tokens = extractProtectedTokens(text);
      const priceTokens = tokens.filter((t) => t.type === 'price');

      expect(priceTokens.some((t) => t.raw === '$50')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '100,000 IQD')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '75€')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '25 EUR')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '٢٥٬٠٠٠ دینار')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '٥٠٠٠ د.ع')).toBe(true);
      expect(priceTokens.some((t) => t.raw === '٥٠٪')).toBe(true);
    });

    it('extracts Iraqi mobile phone formats', () => {
      const text = 'Contact Korek: 0750 123 4567 or Asiacell: +9647701234567 or Zain: 0780-123-4567';
      const tokens = extractProtectedTokens(text);
      const phones = tokens.filter((t) => t.type === 'phone');

      expect(phones).toHaveLength(3);
      expect(phones.some((t) => t.normalized === '07501234567')).toBe(true);
      expect(phones.some((t) => t.normalized === '+9647701234567')).toBe(true);
      expect(phones.some((t) => t.normalized === '07801234567')).toBe(true);
    });

    it('extracts hashtags, emails, URLs, and dates', () => {
      const text = 'سەردانی www.asterhotel.krd بکەن یان ئیمەیڵ بۆ info@aster.krd بنێرن تا بەرواری 2026-09-04 #هاوین٢٠٢٦';
      const tokens = extractProtectedTokens(text);

      expect(tokens.some((t) => t.type === 'url' && t.raw.includes('www.asterhotel.krd'))).toBe(true);
      expect(tokens.some((t) => t.type === 'url' && t.raw === 'info@aster.krd')).toBe(true);
      expect(tokens.some((t) => t.type === 'date' && t.raw === '2026-09-04')).toBe(true);
      expect(tokens.some((t) => t.type === 'hashtag' && t.raw === '#هاوین٢٠٢٦')).toBe(true);
    });
  });
});
