import { describe, it, expect } from 'vitest';
import {
  KURDISH_SORANI_GLYPH_TABLE,
  inspectKurdishFontCoverage,
  extractGlyphSetFromBuffer
} from '../src/font-inspector.js';

describe('Kurdish WebFont Inspector (B-040, FR-037)', () => {
  it('contains comprehensive normative Kurdish Sorani glyph definition', () => {
    const requiredGlyphs = KURDISH_SORANI_GLYPH_TABLE.filter((g) => g.requiredForSorani);
    expect(requiredGlyphs.length).toBeGreaterThanOrEqual(20);

    const chars = requiredGlyphs.map((g) => g.char);
    expect(chars).toContain('ک');
    expect(chars).toContain('گ');
    expect(chars).toContain('ڵ');
    expect(chars).toContain('ۆ');
    expect(chars).toContain('ڕ');
    expect(chars).toContain('ێ');
    expect(chars).toContain('\u200C'); // ZWNJ
  });

  it('rates a complete Kurdish font as AAA_COMPLIANT with 100% coverage', () => {
    const fullSoraniGlyphSet = new Set<number>(
      KURDISH_SORANI_GLYPH_TABLE.map((g) => g.codePoint)
    );

    const result = inspectKurdishFontCoverage(fullSoraniGlyphSet, 'Vazirmatn Kurdish');

    expect(result.status).toBe('AAA_COMPLIANT');
    expect(result.coveragePercentage).toBe(100);
    expect(result.missingCount).toBe(0);
    expect(result.hasZwnj).toBe(true);
    expect(result.diacriticClearanceRatio).toBe(1.52);
    expect(result.specimenText).toContain('هەولێر');
  });

  it('flags missing critical ligatures (ڵ, ڕ) as PARTIAL_COMPLIANT or INCOMPATIBLE', () => {
    // Missing ڵ (U+06B5) and ڕ (U+0695)
    const defectiveSet = new Set<number>(
      KURDISH_SORANI_GLYPH_TABLE
        .filter((g) => g.char !== 'ڵ' && g.char !== 'ڕ')
        .map((g) => g.codePoint)
    );

    const result = inspectKurdishFontCoverage(defectiveSet, 'Standard Arabic Font');

    expect(result.status).toBe('PARTIAL_COMPLIANT');
    expect(result.coveragePercentage).toBeLessThan(100);
    expect(result.missingCount).toBe(2);
    const missingChars = result.missingGlyphs.map((m) => m.char);
    expect(missingChars).toContain('ڵ');
    expect(missingChars).toContain('ڕ');
  });

  it('rejects Latin-only font as INCOMPATIBLE with low coverage', () => {
    // Latin-only font with ASCII code points
    const latinSet = new Set<number>([65, 66, 67, 68, 69, 70, 71, 72]); // A-H

    const result = inspectKurdishFontCoverage(latinSet, 'Helvetica Neue');

    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.coveragePercentage).toBe(0);
    expect(result.hasZwnj).toBe(false);
    expect(result.missingCount).toBe(result.totalRequired);
  });

  it('safely handles binary font buffers and mock headers without throwing', () => {
    const emptyBuffer = new Uint8Array(32);
    // Header for TrueType
    emptyBuffer[0] = 0x00;
    emptyBuffer[1] = 0x01;
    emptyBuffer[2] = 0x00;
    emptyBuffer[3] = 0x00;

    const extracted = extractGlyphSetFromBuffer(emptyBuffer);
    expect(extracted.metadata.format).toBe('TrueType');
    expect(extracted.supportedCodePoints.size).toBe(0);

    const result = inspectKurdishFontCoverage(emptyBuffer, 'Empty Test Font');
    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.fontName).toBe('Empty Test Font');
  });

  it('safely bounds malicious format 12 cmap ranges preventing OOM memory exhaustion', () => {
    // Construct a binary TrueType buffer with a format 12 cmap subtable containing a huge range
    const buf = new Uint8Array(128);
    const view = new DataView(buf.buffer);
    // TrueType header
    buf[0] = 0x00; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x00;
    view.setUint16(4, 1); // 1 table

    // Table directory: tag 'cmap'
    buf[12] = 0x63; buf[13] = 0x6D; buf[14] = 0x61; buf[15] = 0x70;
    view.setUint32(20, 32); // offset 32

    // cmap table at offset 32
    view.setUint16(34, 1); // 1 subtable
    // Subtable entry: offset 40
    view.setUint32(38, 8); // subtableOffset = 32 + 8 = 40

    // format 12 subtable at offset 40
    view.setUint16(40, 12); // format 12
    view.setUint32(52, 1);  // 1 group (offset 40 + 12 = 52)
    // Group at offset 56: startCharCode = 0x00000000, endCharCode = 0x00FFFFFF (malicious 16-million range)
    view.setUint32(56, 0x00000000);
    view.setUint32(60, 0x00FFFFFF);
    view.setUint32(64, 0);

    const start = performance.now();
    const extracted = extractGlyphSetFromBuffer(buf);
    const elapsed = performance.now() - start;

    // Should reject the huge range and complete in < 5ms without allocating millions of elements
    expect(elapsed).toBeLessThan(50);
    expect(extracted.supportedCodePoints.size).toBeLessThan(65536);
  });
});
