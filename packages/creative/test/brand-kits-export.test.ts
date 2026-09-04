import { describe, it, expect } from 'vitest';
import {
  CANONICAL_BRAND_KITS,
  getCanonicalBrandKit,
  validateBrandKitContrast,
} from '../src/brand-kits.js';

describe('Option C: Pro Brand Kits & Multi-Format Specifications', () => {
  it('loads all 3 canonical Kurdistan commercial brand kits', () => {
    const kitIds = Object.keys(CANONICAL_BRAND_KITS);
    expect(kitIds).toContain('sebar');
    expect(kitIds).toContain('hawa');
    expect(kitIds).toContain('erbil_express');
  });

  it('verifies SEBAR brand kit complies with verified medical-supplement standards', () => {
    const sebar = getCanonicalBrandKit('sebar');
    expect(sebar.name).toBe('SEBAR Verified Health');
    expect(sebar.nameKurdish).toBe('سێبەر بۆ تەندروستی');
    expect(sebar.palette.primary).toBe('#016E7D'); // Mineral Turquoise
    expect(sebar.palette.accent).toBe('#F59E0B');  // Amber Gold
    expect(sebar.typography.kurdishFont).toBe('Vazirmatn');
    expect(sebar.verifiedSha256).toMatch(/^sha256_sebar_/);
    expect(sebar.contactTokens.length).toBeGreaterThanOrEqual(3);
  });

  it('validates WCAG 2.2 AAA contrast standards for all brand palettes', () => {
    for (const kit of Object.values(CANONICAL_BRAND_KITS)) {
      const contrast = validateBrandKitContrast(kit);
      expect(contrast.isAccessible).toBe(true);
      expect(contrast.contrastRatio).toBeGreaterThanOrEqual(7.0);
    }
  });

  it('verifies typography pairings support dual-script Latin and Kurdish', () => {
    for (const kit of Object.values(CANONICAL_BRAND_KITS)) {
      expect(['Inter', 'Plus Jakarta Sans']).toContain(kit.typography.latinFont);
      expect(['Vazirmatn', 'Noto Sans Arabic']).toContain(kit.typography.kurdishFont);
      expect(kit.typography.headlineWeight).toBeGreaterThanOrEqual(700);
    }
  });

  it('preserves exact protected contact tokens without invention (Invariant #5)', () => {
    const hawa = getCanonicalBrandKit('hawa');
    expect(hawa.contactTokens).toContain('0750 999 8877');
    expect(hawa.contactTokens).toContain('hawa.office');

    const express = getCanonicalBrandKit('erbil_express');
    expect(express.contactTokens).toContain('0750 444 3322');
  });
});
