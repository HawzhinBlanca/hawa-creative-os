/**
 * ADR-257: contrast and the safe area measured on the Canva export that ships.
 *
 * Hard QA holds the Studio render to the house safe area and to WCAG AA contrast before the design
 * goes to Canva. Nothing measured the design Canva hands back, which an office member may have edited
 * and Canva has re-rendered. This reads the PNG capture with the text frames of the PPTX captured from
 * the same Canva version: each frame's box is held to the same safe area (`getSafeZoneBox`), and each
 * run's colour to the same contrast (`requiredContrast`) against the background under its box.
 *
 * The PNG already carries the text, so the background is the median luminance of the box's pixels
 * that are not close to any of the frame's run colours (the glyphs and their nearest antialiasing).
 * When almost every pixel is close to the text colour, the text sits on its own colour, and all the
 * pixels are the background.
 */
import { PNG } from 'pngjs';
import type { Box } from './layout-v2.js';
import { getSafeZoneBox, requiredContrast } from './house-rules.js';
import { calculateLuminanceContrastRatio, hexToLuminance, rgbToLuminance } from './composite-contrast.js';
import { hexToRgb } from './color-science.js';

/** EMU per typographic point, and per design pixel (96 dpi): Canva's slide is its design in pixels. */
const EMU_PER_POINT = 12700;
const EMU_PER_PIXEL = 9525;
/** RGB distance within which a pixel counts as the text's own colour, not its background. */
const TEXT_COLOUR_DISTANCE = 48;
/** Below this share of background pixels, the text sits on its own colour. */
const MIN_BACKGROUND_SHARE = 0.1;
/** Pixels sampled per box at most. */
const MAX_SAMPLES = 40000;
/** The slide and the PNG must have the same shape within this share. */
const ASPECT_TOLERANCE = 0.02;

export interface ExportTextFrame {
  text: string;
  /** Slide units (EMU), axis-aligned. */
  box: Box;
  /** How much enclosing groups scale the frame's type. */
  scale?: number;
  runs: Array<{ text: string; color: string | null; colorNote?: string; fontSizePt: number | null; bold: boolean }>;
}

export interface ExportTextLayout {
  slideWidth: number;
  slideHeight: number;
  frames: ExportTextFrame[];
}

export interface ExportMarginResult {
  text: string;
  /** PNG pixels. */
  box: Box;
  inside: boolean;
  edges: Array<'top' | 'bottom' | 'left' | 'right'>;
}

export interface ExportContrastResult {
  text: string;
  color: string;
  background: string;
  ratio: number;
  required: number;
  fontPx: number | null;
  passed: boolean;
}

export interface ExportTextMeasurement {
  canvas: { width: number; height: number };
  safeArea: Box;
  margins: ExportMarginResult[];
  contrast: ExportContrastResult[];
  /** Runs whose colour could not be resolved or whose box lies off the picture: skipped, with why. */
  unmeasured: Array<{ text: string; reason: string }>;
}

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Measures every frame of `layout` on the PNG capture of the same design. Throws when they differ in shape. */
export function measureExportText(pngBytes: Buffer, layout: ExportTextLayout): ExportTextMeasurement {
  const png = PNG.sync.read(pngBytes);
  const { width, height } = png;
  if (!(width > 0 && height > 0 && layout.slideWidth > 0 && layout.slideHeight > 0)) throw new Error('Empty picture or slide');
  const slideAspect = layout.slideWidth / layout.slideHeight;
  if (Math.abs(width / height - slideAspect) / slideAspect > ASPECT_TOLERANCE) {
    throw new Error(`The PNG (${width}x${height}) is not the shape of the PPTX slide`);
  }
  const sx = width / layout.slideWidth, sy = height / layout.slideHeight;
  const safeArea = getSafeZoneBox(width, height);
  const result: ExportTextMeasurement = { canvas: { width, height }, safeArea, margins: [], contrast: [], unmeasured: [] };

  for (const frame of layout.frames) {
    const text = frame.text;
    const box = { x: frame.box.x * sx, y: frame.box.y * sy, width: frame.box.width * sx, height: frame.box.height * sy };
    // One pixel of rounding either way is the PPTX's EMU grid, not a breach.
    const edges: ExportMarginResult['edges'] = [];
    if (box.y < safeArea.y - 1) edges.push('top');
    if (box.y + box.height > safeArea.y + safeArea.height + 1) edges.push('bottom');
    if (box.x < safeArea.x - 1) edges.push('left');
    if (box.x + box.width > safeArea.x + safeArea.width + 1) edges.push('right');
    result.margins.push({ text, box, inside: edges.length === 0, edges });

    const runs = frame.runs.filter((run) => run.text.trim());
    for (const run of runs) {
      if (!run.color) result.unmeasured.push({ text: run.text, reason: run.colorNote || 'colour not resolved' });
    }
    const colours = [...new Set(runs.map((run) => run.color).filter((c): c is string => Boolean(c)))];
    if (!colours.length) continue;

    const x0 = Math.max(0, Math.floor(box.x)), x1 = Math.min(width - 1, Math.ceil(box.x + box.width) - 1);
    const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(height - 1, Math.ceil(box.y + box.height) - 1);
    if (x1 < x0 || y1 < y0) {
      for (const run of runs.filter((r) => r.color)) result.unmeasured.push({ text: run.text, reason: 'its box lies off the picture' });
      continue;
    }
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / MAX_SAMPLES)));
    const inks = colours.map((c) => hexToRgb(c));
    const all: Array<[number, number, number, number]> = [];
    const background: Array<[number, number, number, number]> = [];
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const i = (y * width + x) * 4;
        const a = png.data[i + 3] / 255;
        // A transparent pixel is shown on white, as the composite contrast reads it.
        const r = Math.round(png.data[i] * a + 255 * (1 - a));
        const g = Math.round(png.data[i + 1] * a + 255 * (1 - a));
        const b = Math.round(png.data[i + 2] * a + 255 * (1 - a));
        const pixel: [number, number, number, number] = [rgbToLuminance(r, g, b), r, g, b];
        all.push(pixel);
        if (inks.every(([ir, ig, ib]) => Math.hypot(r - ir, g - ig, b - ib) > TEXT_COLOUR_DISTANCE)) background.push(pixel);
      }
    }
    const pool = background.length >= MIN_BACKGROUND_SHARE * all.length ? background : all;
    pool.sort((p, q) => p[0] - q[0]);
    const median = pool[Math.floor(pool.length / 2)];

    for (const color of colours) {
      const own = runs.filter((run) => run.color === color);
      // The strictest band among the colour's runs: its smallest, non-bold text decides. Sizes are in
      // design pixels, as hard QA's bands are, whatever the resolution of the capture.
      const bands = own.map((run) => {
        const fontPx = run.fontSizePt ? (run.fontSizePt * (frame.scale ?? 1) * EMU_PER_POINT) / EMU_PER_PIXEL : null;
        return { fontPx, required: fontPx === null ? requiredContrast(0, false) : requiredContrast(fontPx, run.bold) };
      }).sort((p, q) => q.required - p.required || (p.fontPx ?? 0) - (q.fontPx ?? 0));
      const ratio = calculateLuminanceContrastRatio(hexToLuminance(color), median[0]);
      result.contrast.push({
        text, color, background: toHex(median[1], median[2], median[3]),
        ratio: Math.round(ratio * 100) / 100, required: bands[0].required,
        fontPx: bands[0].fontPx === null ? null : Math.round(bands[0].fontPx * 10) / 10,
        passed: ratio >= bands[0].required,
      });
    }
  }
  return result;
}
