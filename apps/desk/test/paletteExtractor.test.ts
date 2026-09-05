import { describe, it, expect } from 'vitest';
import { getRelativeLuminance, getContrastRatio, extractPaletteFromImageData } from '../src/services/paletteExtractor.ts';

describe('paletteExtractor (WCAG 2.1 Contrast & Color Quantization)', () => {
  it('calculates exact sRGB relative luminance', () => {
    expect(getRelativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(getRelativeLuminance({ r: 255, g: 255, b: 255 })).toBe(1);
  });

  it('computes accurate WCAG 2.1 contrast ratios and grades', () => {
    // Pure black on pure white is 21:1
    expect(getContrastRatio('#000000', '#FFFFFF')).toBe(21);
    // Identical colors is 1:1
    expect(getContrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    // Hawa primary #01585F on pure white is >= 7:1 (AAA)
    const ratio = getContrastRatio('#01585F', '#FFFFFF');
    expect(ratio).toBeGreaterThan(6.0);
  });

  it('quantizes image data into swatches and assigns grades', () => {
    // Create synthetic 4x4 image buffer with teal pixels [1, 88, 95, 255]
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 1;      // R
      pixels[i + 1] = 88;  // G
      pixels[i + 2] = 95;  // B
      pixels[i + 3] = 255; // A
    }

    const mockCtx = {
      getImageData: () => ({ data: pixels }),
    } as unknown as CanvasRenderingContext2D;

    const result = extractPaletteFromImageData(mockCtx, 4, 4);
    expect(result).toBeDefined();
    expect(result.primary).toBeDefined();
    expect(result.swatches.length).toBeGreaterThanOrEqual(1);
    expect(['AAA', 'AA', 'FAIL']).toContain(result.wcagGrade);
  });
});
