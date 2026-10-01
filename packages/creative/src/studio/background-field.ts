import { z } from 'zod';
import { hexToRgb } from './color-science.js';
import { rgbToLuminance } from './luminance.js';
import type { Box } from './layout-v2.js';

export const FIELD_DIRECTIONS = ['to-right', 'to-bottom', 'to-left', 'to-top'] as const;
export const backgroundFieldSchema = z.object({
  kind: z.literal('linear'),
  direction: z.enum(FIELD_DIRECTIONS),
  stops: z.array(z.object({ at: z.number().min(0).max(1), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict()).min(2).max(4),
}).strict().superRefine((field, ctx) => {
  if (field.stops[0].at !== 0 || field.stops[field.stops.length - 1].at !== 1 ||
      field.stops.some((s, i) => i > 0 && s.at <= field.stops[i - 1].at)) {
    ctx.addIssue({ code: 'custom', message: 'BACKGROUND_FIELD: stops must ascend strictly from 0 to 1' });
  }
});
export type BackgroundField = z.infer<typeof backgroundFieldSchema>;

/** Closed scene-node serialization; caller content never enters markup unvalidated. */
export function backgroundFieldSvg(field: BackgroundField, width: number, height: number): { defs: string; svg: string } {
  const f = backgroundFieldSchema.parse(field);
  if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 4000)) throw new Error('BACKGROUND_FIELD: invalid canvas');
  const coords = { 'to-right': 'x1="0%" y1="0%" x2="100%" y2="0%"', 'to-bottom': 'x1="0%" y1="0%" x2="0%" y2="100%"',
    'to-left': 'x1="100%" y1="0%" x2="0%" y2="0%"', 'to-top': 'x1="0%" y1="100%" x2="0%" y2="0%"' };
  return {
    defs: `<linearGradient id="background-field" ${coords[f.direction]} color-interpolation="sRGB">${f.stops.map(s => `<stop offset="${s.at}" stop-color="${s.color}"/>`).join('')}</linearGradient>`,
    svg: `<rect id="background-field-node" width="${width}" height="${height}" fill="url(#background-field)"/>`,
  };
}

/** OOXML gradient parameters match the renderer's directional sRGB field. */
export function backgroundFieldDrawingMl(field: BackgroundField): string {
  const f = backgroundFieldSchema.parse(field);
  const angle = { 'to-right': 0, 'to-bottom': 5400000, 'to-left': 10800000, 'to-top': 16200000 }[f.direction];
  return `<a:gradFill rotWithShape="0"><a:gsLst>${f.stops.map(s => `<a:gs pos="${Math.round(s.at * 100000)}"><a:srgbClr val="${s.color.slice(1)}"/></a:gs>`).join('')}</a:gsLst><a:lin ang="${angle}" scaled="0"/></a:gradFill>`;
}

/** Conservative channel envelope, covering every interpolated color rather than endpoints alone. */
export function backgroundFieldRgbBounds(field: BackgroundField): { min: [number, number, number]; max: [number, number, number] } {
  const colors = backgroundFieldSchema.parse(field).stops.map(s => hexToRgb(s.color));
  return { min: [0, 1, 2].map(i => Math.min(...colors.map(c => c[i]))) as [number, number, number],
    max: [0, 1, 2].map(i => Math.max(...colors.map(c => c[i]))) as [number, number, number] };
}

/** ADR198: conservative enclosure of the actual field under a box, never endpoint sampling. */
export function backgroundFieldLuminanceBounds(field: BackgroundField, width: number, height: number, box: Box): { min: number; max: number } {
  const f = backgroundFieldSchema.parse(field);
  const unknown = { min: 0, max: 1 };
  if (![width, height, box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0 ||
      box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height) return unknown;
  const vertical = f.direction === 'to-bottom' || f.direction === 'to-top';
  const length = vertical ? height : width;
  const origin = vertical ? box.y : box.x;
  const extent = vertical ? box.height : box.width;
  let start = Math.max(0, (origin - 1) / length);
  let end = Math.min(1, (origin + extent + 1) / length);
  if (f.direction === 'to-top' || f.direction === 'to-left') [start, end] = [1 - end, 1 - start];
  let min = 1, max = 0;
  for (let i = 1; i < f.stops.length; i++) {
    const a = f.stops[i - 1], b = f.stops[i];
    const lo = Math.max(start, a.at), hi = Math.min(end, b.at);
    if (lo > hi) continue;
    const from = hexToRgb(a.color), to = hexToRgb(b.color);
    const rgb = (at: number) => from.map((v, c) => v + (to[c] - v) * (at - a.at) / (b.at - a.at));
    // Linear sRGB channels stay within these endpoint envelopes even if luminance turns inside.
    // The +/-1 guard encloses 8-bit rounding; it is not an inferred native renderer tolerance.
    for (let step = 0; step < 32; step++) {
      const left = rgb(lo + (hi - lo) * step / 32), right = rgb(lo + (hi - lo) * (step + 1) / 32);
      const low = left.map((v, c) => Math.max(0, Math.min(v, right[c]) - 1));
      const high = left.map((v, c) => Math.min(255, Math.max(v, right[c]) + 1));
      min = Math.min(min, rgbToLuminance(low[0], low[1], low[2]));
      max = Math.max(max, rgbToLuminance(high[0], high[1], high[2]));
    }
  }
  return { min: Math.max(0, min - 1e-12), max: Math.min(1, max + 1e-12) };
}
