/**
 * WCAG 2.2 Color Contrast & Luminance Engine.
 *
 * Implements W3C WCAG 2.2 specifications for Relative Luminance and Contrast Ratio:
 * https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

export interface RgbColor {
  r: number; // 0 - 255
  g: number; // 0 - 255
  b: number; // 0 - 255
}

/**
 * Parses a hex color string (e.g. "#164a3a", "#FFF", "rgba(...)") into RGB values.
 */
export function parseColor(colorStr: string): RgbColor {
  if (!colorStr) return { r: 0, g: 0, b: 0 };

  const hex = colorStr.trim().replace(/^#/, '');

  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  }

  const rgbMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    };
  }

  // Default fallback to black
  return { r: 0, g: 0, b: 0 };
}

/**
 * Computes the relative luminance of an sRGB color per WCAG formula:
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 */
export function getRelativeLuminance(color: RgbColor): number {
  const [rs, gs, bs] = [color.r / 255, color.g / 255, color.b / 255].map((val) => {
    return val <= 0.04045 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Computes the contrast ratio between two colors:
 * (L1 + 0.05) / (L2 + 0.05) where L1 is the lighter color.
 */
export function getContrastRatio(colorA: string | RgbColor, colorB: string | RgbColor): number {
  const rgbA = typeof colorA === 'string' ? parseColor(colorA) : colorA;
  const rgbB = typeof colorB === 'string' ? parseColor(colorB) : colorB;

  const lumA = getRelativeLuminance(rgbA);
  const lumB = getRelativeLuminance(rgbB);

  const l1 = Math.max(lumA, lumB);
  const l2 = Math.min(lumA, lumB);

  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Checks compliance with WCAG 2.2 AA and AAA levels.
 *
 * Normal text:
 * - AA: >= 4.5:1
 * - AAA: >= 7.0:1
 *
 * Large text (>= 24px regular or >= 18.66px bold):
 * - AA: >= 3.0:1
 * - AAA: >= 4.5:1
 */
export function evaluateContrastCompliance(
  foreground: string,
  background: string,
  fontSizePx: number = 16,
  isBold: boolean = false
): {
  ratio: number;
  isLargeText: boolean;
  passesAA: boolean;
  passesAAA: boolean;
} {
  const ratio = getContrastRatio(foreground, background);
  const isLargeText = fontSizePx >= 24 || (isBold && fontSizePx >= 18.5);

  const minAA = isLargeText ? 3.0 : 4.5;
  const minAAA = isLargeText ? 4.5 : 7.0;

  return {
    ratio: Math.round(ratio * 100) / 100,
    isLargeText,
    passesAA: ratio >= minAA,
    passesAAA: ratio >= minAAA,
  };
}
