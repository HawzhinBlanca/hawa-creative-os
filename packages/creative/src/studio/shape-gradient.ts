import type { Box, Hex, ShapeElement, ShapeGradient } from './layout-v2.js';
import { hexToRgb } from './color-science.js';

/**
 * ADR-238: a shape's linear gradient, one geometry for the preview, the Canva deck and the contrast
 * model. `angle` is in degrees clockwise from left-to-right (0 runs left to right, 90 top to bottom,
 * 45 from the top-left corner to the bottom-right one) in the shape's own box, scaled with it: the
 * SVG gradient is drawn in objectBoundingBox units and the deck's `a:lin` is written `scaled="1"`, so
 * at 45 degrees both run corner to corner whatever the box's proportions.
 */

const direction = (angle: number) => {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // The gradient line spans the box's projection on the direction, so 0 and 1 land on its corners.
  const k = Math.abs(c) + Math.abs(s) || 1;
  return { c, s, k };
};

/** The SVG gradient's end points in objectBoundingBox units. */
export function gradientEndpoints(angle: number): { x1: number; y1: number; x2: number; y2: number } {
  const { c, s, k } = direction(angle);
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x1: r(0.5 - (k / 2) * c), y1: r(0.5 - (k / 2) * s), x2: r(0.5 + (k / 2) * c), y2: r(0.5 + (k / 2) * s) };
}

/** Where a canvas point falls on a shape's gradient line, 0..1. */
export function gradientT(g: ShapeGradient, box: Box, px: number, py: number): number {
  const { c, s, k } = direction(g.angle);
  const u = box.width > 0 ? (px - box.x) / box.width : 0.5;
  const v = box.height > 0 ? (py - box.y) / box.height : 0.5;
  const t = ((u - 0.5) * c + (v - 0.5) * s) / k + 0.5;
  return Math.min(1, Math.max(0, t));
}

const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** The gradient's colour at `t` (0..1), interpolated in sRGB between its stops, as SVG draws it. */
export function gradientColourAtT(g: ShapeGradient, t: number): Hex {
  const stops = [...g.stops].sort((a, b) => a.at - b.at);
  if (t <= stops[0].at) return stops[0].color;
  const last = stops[stops.length - 1];
  if (t >= last.at) return last.color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.at) {
      const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      return toHex(ca.map((v, j) => v + (cb[j] - v) * f));
    }
  }
  return last.color;
}

/** The gradient's colour at a canvas point inside the shape. */
export function gradientColourAt(g: ShapeGradient, box: Box, px: number, py: number): Hex {
  return gradientColourAtT(g, gradientT(g, box, px, py));
}

/**
 * The colours a box laid over a shape sits on: the shape's own colour, or for a gradient the colours
 * under the box's corners and centre (the gradient is monotone between stops, so the extremes of a
 * box lie at its corners unless a stop falls inside it, which the centre and the stops inside cover).
 */
export function fillColoursUnder(s: Pick<ShapeElement, 'x' | 'y' | 'width' | 'height' | 'color' | 'gradient'>, box: Box): Hex[] {
  if (!s.gradient) return [s.color];
  const g = s.gradient;
  const pts: Array<[number, number]> = [
    [box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height],
    [box.x + box.width / 2, box.y + box.height / 2],
  ];
  const ts = pts.map(([x, y]) => gradientT(g, s, x, y));
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  const inside = g.stops.filter((st) => st.at > lo && st.at < hi).map((st) => st.color);
  return [...new Set([...ts.map((t) => gradientColourAtT(g, t)), ...inside])];
}

/** The SVG `<linearGradient>` for a shape's gradient. */
export function gradientSvgDef(id: string, g: ShapeGradient): string {
  const { x1, y1, x2, y2 } = gradientEndpoints(g.angle);
  const stops = [...g.stops]
    .sort((a, b) => a.at - b.at)
    .map((st) => `<stop offset="${st.at}" stop-color="${st.color}"/>`)
    .join('');
  return `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
}

/** The OOXML `<a:gradFill>` for a shape's gradient: the deck draws it as a native gradient fill. */
export function gradientOoxml(g: ShapeGradient, opacity = 1): string {
  const alpha = opacity < 1 ? `<a:alpha val="${Math.round(Math.max(0, opacity) * 100000)}"/>` : '';
  const stops = [...g.stops]
    .sort((a, b) => a.at - b.at)
    .map((st) => `<a:gs pos="${Math.round(st.at * 100000)}"><a:srgbClr val="${st.color.replace('#', '').toUpperCase()}">${alpha}</a:srgbClr></a:gs>`)
    .join('');
  const ang = Math.round((((g.angle % 360) + 360) % 360) * 60000);
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`;
}
