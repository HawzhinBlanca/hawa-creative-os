/**
 * One reading of a `line` shape, shared by the preview renderer and the Canva transfer.
 *
 * A line is stored as a box. The renderer used to draw that box corner to corner once it was more
 * than 2px thick, so a 3px rule came out tilted by 3px, and it took the box HEIGHT as the stroke
 * width whatever the orientation, so a 6x202 vertical accent was painted as a 202px slab. The
 * transfer flattened every line to `h: 0`, turning the same accent into a 6px dash. Both shipped in
 * the 2026-09-18 qualification run (briefs 09, 11, 12, 13, 15, 16) and passed every gate.
 *
 * The line runs along the long side of its box, through the middle of the short side. The short side
 * is its thickness unless a stroke width is given. The schema has `rotation` for anything diagonal.
 */
export interface LineGeometry {
  orientation: 'horizontal' | 'vertical';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

export function lineGeometry(shape: { x: number; y: number; width: number; height: number; strokeWidth?: number }): LineGeometry {
  const vertical = shape.height > shape.width;
  const thickness = Math.max(1, vertical ? shape.width : shape.height);
  const strokeWidth = shape.strokeWidth && shape.strokeWidth > 0 ? shape.strokeWidth : thickness;
  if (vertical) {
    const cx = shape.x + shape.width / 2;
    return { orientation: 'vertical', x1: cx, y1: shape.y, x2: cx, y2: shape.y + shape.height, strokeWidth };
  }
  const cy = shape.y + shape.height / 2;
  return { orientation: 'horizontal', x1: shape.x, y1: cy, x2: shape.x + shape.width, y2: cy, strokeWidth };
}
