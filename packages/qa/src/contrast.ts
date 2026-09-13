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

const NAMED_COLORS: Record<string, RgbColor> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  transparent: { r: 255, g: 255, b: 255 }, // Neutral canvas white fallback
  none: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
};

/**
 * Parses a hex color string (e.g. "#164a3a", "#FFF", "rgba(...)") into RGB values.
 */
export function parseColor(colorStr: string): RgbColor {
  if (!colorStr || typeof colorStr !== 'string') return { r: 0, g: 0, b: 0 };

  const trimmed = colorStr.trim().toLowerCase();
  if (NAMED_COLORS[trimmed]) {
    return { ...NAMED_COLORS[trimmed] };
  }

  const hex = trimmed.replace(/^#/, '');

  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return {
      r: Number.isNaN(r) ? 0 : r,
      g: Number.isNaN(g) ? 0 : g,
      b: Number.isNaN(b) ? 0 : b,
    };
  }

  if (hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return {
      r: Number.isNaN(r) ? 0 : r,
      g: Number.isNaN(g) ? 0 : g,
      b: Number.isNaN(b) ? 0 : b,
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return {
      r: Number.isNaN(r) ? 0 : r,
      g: Number.isNaN(g) ? 0 : g,
      b: Number.isNaN(b) ? 0 : b,
    };
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:\s*[/,]\s*[\d.]+%?)?\s*\)$/i);
  if (rgbMatch) {
    const parseComponent = (val: string) => {
      if (val.endsWith('%')) {
        const pct = parseFloat(val);
        return Number.isNaN(pct) ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * 255);
      }
      const num = parseFloat(val);
      return Number.isNaN(num) ? 0 : Math.round(Math.min(255, Math.max(0, num)));
    };
    return {
      r: parseComponent(rgbMatch[1]),
      g: parseComponent(rgbMatch[2]),
      b: parseComponent(rgbMatch[3]),
    };
  }

  const hslMatch = trimmed.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[/,]\s*[\d.]+%?)?\s*\)$/i);
  if (hslMatch) {
    const h = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
    const s = Math.min(100, Math.max(0, parseFloat(hslMatch[2]))) / 100;
    const l = Math.min(100, Math.max(0, parseFloat(hslMatch[3]))) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let [rPrime, gPrime, bPrime] = [0, 0, 0];
    if (h < 60) [rPrime, gPrime, bPrime] = [c, x, 0];
    else if (h < 120) [rPrime, gPrime, bPrime] = [x, c, 0];
    else if (h < 180) [rPrime, gPrime, bPrime] = [0, c, x];
    else if (h < 240) [rPrime, gPrime, bPrime] = [0, x, c];
    else if (h < 300) [rPrime, gPrime, bPrime] = [x, 0, c];
    else [rPrime, gPrime, bPrime] = [c, 0, x];
    return {
      r: Math.round((rPrime + m) * 255),
      g: Math.round((gPrime + m) * 255),
      b: Math.round((bPrime + m) * 255),
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
  const clamp = (v: number) => (Number.isNaN(v) ? 0 : Math.min(255, Math.max(0, v)));
  const [rs, gs, bs] = [clamp(color.r) / 255, clamp(color.g) / 255, clamp(color.b) / 255].map((val) => {
    return val <= 0.04045 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  const lum = 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  return Number.isNaN(lum) ? 0 : lum;
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

  const ratio = (l1 + 0.05) / (l2 + 0.05);
  return Number.isFinite(ratio) ? ratio : 1.0;
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
