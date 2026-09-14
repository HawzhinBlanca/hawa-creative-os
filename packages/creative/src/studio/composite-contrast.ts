import { PNG } from 'pngjs';
import type { StudioLayoutV2, Box, TextElement } from './layout-v2.js';
import { hexToRgb } from './color-science.js';

export function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function rgbToLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function hexToLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLuminance(r, g, b);
}

export function calculateLuminanceContrastRatio(lum1: number, lum2: number): number {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface BoxContrastEvaluation {
  copyIndex: number;
  p05: number;
  min: number;
  median: number;
  max: number;
  required: number;
  passed: boolean;
}

export interface CompositeContrastResult {
  passed: boolean;
  p05PerBox: Record<number, number>;
  evaluations: BoxContrastEvaluation[];
  failures: BoxContrastEvaluation[];
}

/**
 * Computes the 5th-percentile (p05) contrast ratio of text against
 * the underlying pixels of the rendered no-text composite.
 *
 * p05 guarantees that at least 95% of background pixels behind the text
 * satisfy or exceed the contrast requirement, preventing legible text from
 * washing out against noisy or shaded background regions.
 */
export function computeBoxP05Contrast(
  composite: PNG,
  box: Box,
  textColorHex: string,
  sampleStep = 1
): number {
  const textLum = hexToLuminance(textColorHex);

  const startX = Math.max(0, Math.floor(box.x));
  const endX = Math.min(composite.width - 1, Math.floor(box.x + box.width));
  const startY = Math.max(0, Math.floor(box.y));
  const endY = Math.min(composite.height - 1, Math.floor(box.y + box.height));

  const ratios: number[] = [];

  for (let y = startY; y <= endY; y += sampleStep) {
    for (let x = startX; x <= endX; x += sampleStep) {
      const idx = (y * composite.width + x) * 4;
      const r = composite.data[idx];
      const g = composite.data[idx + 1];
      const b = composite.data[idx + 2];
      const a = composite.data[idx + 3];

      // Alpha composite over white if transparent
      let effR = r;
      let effG = g;
      let effB = b;
      if (a < 255) {
        const alpha = a / 255;
        effR = Math.round(r * alpha + 255 * (1 - alpha));
        effG = Math.round(g * alpha + 255 * (1 - alpha));
        effB = Math.round(b * alpha + 255 * (1 - alpha));
      }

      const bgLum = rgbToLuminance(effR, effG, effB);
      const ratio = calculateLuminanceContrastRatio(textLum, bgLum);
      ratios.push(ratio);
    }
  }

  if (ratios.length === 0) return 21.0; // fallback maximum if outside bounds

  ratios.sort((a, b) => a - b);
  const p05Index = Math.min(ratios.length - 1, Math.floor(0.05 * ratios.length));
  return parseFloat(ratios[p05Index].toFixed(2));
}

/**
 * Evaluates all text boxes in a StudioLayoutV2 layout against the rendered
 * no-text composite PNG buffer.
 */
export function evaluateCompositeContrast(
  compositePngBuffer: Buffer,
  layout: StudioLayoutV2,
  sampleStep = 2
): CompositeContrastResult {
  const composite = PNG.sync.read(compositePngBuffer);
  const p05PerBox: Record<number, number> = {};
  const evaluations: BoxContrastEvaluation[] = [];
  const failures: BoxContrastEvaluation[] = [];

  for (const t of layout.text) {
    const isLarge = t.fontSize >= 32 || (t.fontSize >= 24 && Boolean(t.bold));
    const required = isLarge ? 3.0 : 4.5;
    const p05 = computeBoxP05Contrast(composite, t, t.color, sampleStep);
    p05PerBox[t.copyIndex] = p05;

    const passed = p05 >= required;
    const evaluation: BoxContrastEvaluation = {
      copyIndex: t.copyIndex,
      p05,
      min: p05,
      median: p05,
      max: p05,
      required,
      passed,
    };

    evaluations.push(evaluation);
    if (!passed) {
      failures.push(evaluation);
    }
  }

  return {
    passed: failures.length === 0,
    p05PerBox,
    evaluations,
    failures,
  };
}
