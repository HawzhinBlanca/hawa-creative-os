import type { Box, OrnamentElement } from './layout-v2.js';

/**
 * ADR-238: the brand elements of a client guideline's elements page, as vector art drawn from
 * geometry alone (no image, no font): a quarter-disc `sunburst` with five rays round its arc, and a
 * `triangle_pattern`, a mosaic of alternating triangles that fades toward one edge. KAAE's 2025
 * guideline shows both on p.13 (navy and grey sunbursts; navy and blue patterns fading upward).
 *
 * The preview inlines this markup; the Canva deck places the same markup baked to a transparent PNG
 * (an element the client can move, resize or delete). `assets/elements/*.svg` are these functions'
 * output at their reference sizes, for a designer to place by hand; a test keeps them in step.
 */

const num = (v: number) => (Math.round(v * 100) / 100).toString();

/** The disc's centre and the direction its arc faces, for each corner. */
function cornerGeometry(el: Box & { corner?: OrnamentElement['corner'] }) {
  const corner = el.corner ?? 'bottom-left';
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  return {
    cx: right ? el.x + el.width : el.x,
    cy: bottom ? el.y + el.height : el.y,
    sx: right ? -1 : 1,
    sy: bottom ? -1 : 1,
  };
}

/** The quarter disc's radius in a box: the rays reach 1.42 radii, inside the box. */
export function sunburstRadius(box: Pick<Box, 'width' | 'height'>): number {
  return Math.min(box.width, box.height) / 1.45;
}

/** A sunburst's markup: one path for the quarter disc, five lines for its rays. */
export function sunburstSvg(el: Pick<OrnamentElement, 'x' | 'y' | 'width' | 'height' | 'color' | 'opacity' | 'corner'>, id: string): string {
  const { cx, cy, sx, sy } = cornerGeometry(el);
  const r = sunburstRadius(el);
  // The arc, from the disc's edge along one side of the box to the edge along the other.
  const disc =
    `M ${num(cx)} ${num(cy)} L ${num(cx + sx * r)} ${num(cy)} ` +
    `A ${num(r)} ${num(r)} 0 0 ${sx * sy > 0 ? 1 : 0} ${num(cx)} ${num(cy + sy * r)} Z`;
  const stroke = Math.max(1.5, 0.022 * r);
  // Five rays round the arc, as on the guideline's elements page: evenly from 8 to 82 degrees.
  const rays = [8, 26.5, 45, 63.5, 82].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const ux = sx * Math.cos(a);
    const uy = sy * Math.sin(a);
    const r0 = 1.14 * r;
    const r1 = 1.4 * r;
    return `<line x1="${num(cx + ux * r0)}" y1="${num(cy + uy * r0)}" x2="${num(cx + ux * r1)}" y2="${num(cy + uy * r1)}" stroke="${el.color}" stroke-width="${num(stroke)}" stroke-linecap="butt"/>`;
  });
  return `<g id="${id}" opacity="${el.opacity}"><path d="${disc}" fill="${el.color}"/>${rays.join('')}</g>`;
}

/** Triangle height in a pattern band: about twelve rows in the band, never under 10 px. */
export function trianglePatternRowHeight(box: Pick<Box, 'width' | 'height'>): number {
  return Math.max(10, Math.min(box.height / 8, box.width / 24));
}

/**
 * A triangle pattern's markup: rows of alternating up and down triangles, inset so a thin line of
 * the ground shows between them, each row a little more transparent toward the faded edge.
 */
export function trianglePatternSvg(el: Pick<OrnamentElement, 'x' | 'y' | 'width' | 'height' | 'color' | 'opacity' | 'fade'>, id: string): string {
  const th = trianglePatternRowHeight(el);
  const tw = th * 1.155; // equilateral
  const rows = Math.max(1, Math.floor(el.height / th));
  const cols = Math.max(1, Math.floor((el.width - tw / 2) / (tw / 2)));
  const inset = 0.12;
  const x0 = el.x + (el.width - (cols + 1) * (tw / 2)) / 2;
  const y0 = el.y + (el.height - rows * th) / 2;
  const fadeToTop = (el.fade ?? 'to-top') === 'to-top';
  const polys: string[] = [];
  for (let r = 0; r < rows; r++) {
    // Share of the way toward the solid edge: 0 at the faded edge, 1 at the solid one.
    const toward = rows === 1 ? 1 : fadeToTop ? r / (rows - 1) : 1 - r / (rows - 1);
    const rowOpacity = Math.round(Math.pow(toward, 1.4) * 100) / 100;
    if (rowOpacity <= 0.02) continue;
    const top = y0 + r * th;
    const pts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const left = x0 + c * (tw / 2);
      const up = (r + c) % 2 === 0;
      // The triangle's corners, pulled toward its centre by `inset` for the thin gap between tiles.
      const corners: Array<[number, number]> = up
        ? [[left + tw / 2, top], [left + tw, top + th], [left, top + th]]
        : [[left, top], [left + tw, top], [left + tw / 2, top + th]];
      const mx = (corners[0][0] + corners[1][0] + corners[2][0]) / 3;
      const my = (corners[0][1] + corners[1][1] + corners[2][1]) / 3;
      pts.push(corners.map(([x, y]) => `${num(x + (mx - x) * inset)},${num(y + (my - y) * inset)}`).join(' '));
    }
    polys.push(`<g opacity="${rowOpacity}">${pts.map((p) => `<polygon points="${p}"/>`).join('')}</g>`);
  }
  return `<g id="${id}" fill="${el.color}" opacity="${el.opacity}">${polys.join('')}</g>`;
}

/** An ornament's markup at its place on the canvas. */
export function ornamentSvg(el: OrnamentElement, id: string): string {
  return el.kind === 'sunburst' ? sunburstSvg(el, id) : trianglePatternSvg(el, id);
}

/** An ornament as a standalone SVG document of its own box (the deck's baked element, the asset files). */
export function ornamentSvgDocument(el: OrnamentElement, id = 'element'): string {
  const local = { ...el, x: 0, y: 0 };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${el.width}" height="${el.height}" viewBox="0 0 ${el.width} ${el.height}">` +
    `${ornamentSvg(local, id)}</svg>`
  );
}

/** The reference vector assets: what `assets/elements/*.svg` hold. */
export const BRAND_ELEMENT_ASSETS: Record<string, OrnamentElement> = {
  'sunburst-quarter.svg': { kind: 'sunburst', x: 0, y: 0, width: 600, height: 600, color: '#0A1628', opacity: 1, corner: 'bottom-left' },
  'triangle-mosaic.svg': { kind: 'triangle_pattern', x: 0, y: 0, width: 1200, height: 400, color: '#2C5282', opacity: 1, fade: 'to-top' },
};
