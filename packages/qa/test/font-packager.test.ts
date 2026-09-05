import { describe, it, expect } from 'vitest';
import {
  generateKurdishFontFaceCss,
  generateSpecimenHtml,
  packageKurdishWebFont,
  KURDISH_UNICODE_RANGE,
  KURDISH_FALLBACK_STACK,
} from '../src/font-packager.js';
import { KURDISH_SORANI_GLYPH_TABLE } from '../src/font-inspector.js';

describe('Kurdish WebFont Packager (B-040, FR-037)', () => {
  it('generates standard @font-face CSS with Kurdish unicode-range and diacritic metric overrides', () => {
    const css = generateKurdishFontFaceCss({
      fontFamily: 'RonaKurdishDisplay',
      fontUrl: '/v1/fonts/cdn/RonaKurdishDisplay/font.woff2',
      format: 'woff2',
    });

    expect(css).toContain("@font-face");
    expect(css).toContain("font-family: 'RonaKurdishDisplay'");
    expect(css).toContain(`unicode-range: ${KURDISH_UNICODE_RANGE}`);
    expect(css).toContain('ascent-override: 95%');
    expect(css).toContain('descent-override: 25%');
    expect(css).toContain('line-gap-override: 15%');
    expect(css).toContain("local('Vazirmatn')");
    expect(css).toContain("local('Noto Sans Arabic')");
    expect(css).toContain('.kurdish-text-ronakurdishdisplay');
  });

  it('generates interactive specimen HTML with Kurdish Sorani sample copy', () => {
    const fakeCoverage = {
      fontName: 'Vazirmatn-Bold',
      format: 'TrueType',
      metadata: { family: 'Vazirmatn', subfamily: 'Bold', fullName: 'Vazirmatn Bold', format: 'TrueType' as const },
      totalRequired: 32,
      presentCount: 32,
      missingCount: 0,
      coveragePercentage: 100,
      status: 'AAA_COMPLIANT' as const,
      presentGlyphs: [],
      missingGlyphs: [],
      hasZwnj: true,
      diacriticClearanceRatio: 1.52,
      specimenText: 'هەولێر',
      samplePhrases: ['سلێمانی پایتەختی ڕۆشنبیرییە', 'دهۆک دڵی بادینانە'],
    };

    const html = generateSpecimenHtml({
      fontFamily: 'Vazirmatn',
      coverage: fakeCoverage,
      cssContent: '/* Test CSS */',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ckb"');
    expect(html).toContain('AAA_COMPLIANT');
    expect(html).toContain('100% Kurdish Sorani Coverage');
    expect(html).toContain('سلێمانی پایتەختی ڕۆشنبیرییە');
  });

  it('packages an inspected font buffer into a complete WebFont bundle', () => {
    // Generate synthetic mock font buffer
    const mockBuffer = new Uint8Array(128);
    const pkg = packageKurdishWebFont(mockBuffer, 'NovaKurdishSans');

    expect(pkg.family).toBe('NovaKurdishSans');
    expect(pkg.cssBundle).toContain("@font-face");
    expect(pkg.cssBundle).toContain("font-family: 'NovaKurdishSans'");
    expect(pkg.specimenHtml).toContain('NovaKurdishSans');
    expect(pkg.cdnSnippet).toContain('/v1/fonts/cdn/NovaKurdishSans/style.css');
    expect(pkg.sha256Hex).toHaveLength(64);
    expect(pkg.fontBytes).toBeInstanceOf(Uint8Array);
  });
});
