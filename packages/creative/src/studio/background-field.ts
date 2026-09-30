import { z } from 'zod';
import { hexToRgb } from './color-science.js';

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
