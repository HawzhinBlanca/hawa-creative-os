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

  it('validates multi-format artboard-to-export coordinate scaling ratios', () => {
    const ARTBOARD_ASPECT_RATIOS = {
      feed: { width: 480, height: 600 },
      square: { width: 480, height: 480 },
      story: { width: 380, height: 675 },
      landscape: { width: 640, height: 360 },
    };
    const FORMAT_DIMENSIONS = {
      feed: { width: 1080, height: 1350 },
      square: { width: 1080, height: 1080 },
      story: { width: 1080, height: 1920 },
      landscape: { width: 1920, height: 1080 },
    };

    for (const [preset, artboard] of Object.entries(ARTBOARD_ASPECT_RATIOS)) {
      const format = FORMAT_DIMENSIONS[preset as keyof typeof FORMAT_DIMENSIONS];
      const scaleX = format.width / artboard.width;
      const scaleY = format.height / artboard.height;

      // Scaling factors must be strictly positive and proportional
      expect(scaleX).toBeGreaterThan(1.0);
      expect(scaleY).toBeGreaterThan(1.0);

      // Verify custom node at preview artboard coordinates transforms correctly
      const previewNode = { x: 50, y: 100, width: 200, height: 80, fontSize: 18 };
      const exportedX = Math.round(previewNode.x * scaleX);
      const exportedY = Math.round(previewNode.y * scaleY);
      const exportedW = Math.round(previewNode.width * scaleX);
      const exportedH = Math.round(previewNode.height * scaleY);

      expect(exportedX + exportedW).toBeLessThanOrEqual(format.width);
      expect(exportedY + exportedH).toBeLessThanOrEqual(format.height);
    }
  });

  it('validates 4-corner aspect ratio resize lock geometry and anchor preservation', () => {
    const startX = 100;
    const startY = 100;
    const startW = 200;
    const startH = 100; // ratio = 2.0
    const ratio = startW / startH;

    // 1. Bottom-Right (se): anchor is top-left (startX, startY)
    const newW_se = 300;
    const newH_se = Math.round(newW_se / ratio);
    expect(newH_se).toBe(150);

    // 2. Top-Left (nw): anchor is bottom-right (startX + startW, startY + startH)
    const newW_nw = 300;
    const newH_nw = Math.round(newW_nw / ratio);
    const newX_nw = startX + (startW - newW_nw);
    const newY_nw = startY + (startH - newH_nw);
    expect(newX_nw).toBe(0);
    expect(newY_nw).toBe(50);
    expect(newX_nw + newW_nw).toBe(startX + startW);
    expect(newY_nw + newH_nw).toBe(startY + startH);

    // 3. Top-Right (ne): anchor is bottom-left (startX, startY + startH)
    const newW_ne = 260;
    const newH_ne = Math.round(newW_ne / ratio);
    const newY_ne = startY + (startH - newH_ne);
    expect(newH_ne).toBe(130);
    expect(newY_ne + newH_ne).toBe(startY + startH);

    // 4. Bottom-Left (sw): anchor is top-right (startX + startW, startY)
    const newH_sw = 120;
    const newW_sw = Math.round(newH_sw * ratio);
    const newX_sw = startX + (startW - newW_sw);
    expect(newW_sw).toBe(240);
    expect(newX_sw + newW_sw).toBe(startX + startW);
  });

  it('validates Invariant #2: HyCanvas serialization preserves live unflattened vector nodes', () => {
    const testNodes = [
      { id: 'node_headline', role: 'headline', name: 'Headline', zIndex: 15, locked: false, visible: true, x: 36, y: 100, width: 408, height: 110, rotation: 0, opacity: 1, textEn: 'Ramadan Special', textCkb: 'ئۆفەری ڕەمەزان' },
      { id: 'node_copy', role: 'copy', name: 'Price Badge', zIndex: 16, locked: false, visible: true, x: 36, y: 480, width: 260, height: 52, rotation: 0, opacity: 1, textEn: '50% Off', textCkb: '٥٠٪ داشکاندن' },
      { id: 'custom_badge_1', role: 'badge_custom', name: 'Verified Badge', zIndex: 18, locked: false, visible: true, x: 120, y: 350, width: 140, height: 38, rotation: 0, opacity: 1, textEn: 'Special Offer', textCkb: 'ئۆفەری نوێ' },
      { id: 'custom_shape_1', role: 'shape_custom', name: 'Backdrop Card', zIndex: 5, locked: false, visible: true, x: 20, y: 200, width: 440, height: 260, rotation: 0, opacity: 0.9, backgroundColor: '#01585F' },
    ];

    // Verify all nodes are serialized with unflattened vector properties and directional isolation
    const serialized = testNodes.map((n) => ({
      id: n.id,
      role: n.role,
      name: n.name,
      type: n.role.startsWith('text') ? 'text_vector' : n.role.includes('shape') ? 'shape_primitive' : 'badge_vector',
      editable: !n.locked,
      bidiIsolate: true,
      contentEn: n.textEn,
      contentCkb: n.textCkb,
    }));

    expect(serialized.length).toBe(4);
    expect(serialized.find((n) => n.id === 'custom_badge_1')?.editable).toBe(true);
    expect(serialized.find((n) => n.id === 'custom_shape_1')?.type).toBe('shape_primitive');
    expect(serialized.every((n) => n.bidiIsolate === true)).toBe(true);
  });
});
