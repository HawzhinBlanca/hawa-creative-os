import type { Box, OverlayElement, ShapeElement, StudioLayoutV2 } from '../layout-v2.js';

/**
 * ADR-170: what a block of text sits on in an art-directed design. Rulebook item 3: text always sits
 * on something, a plate, a card, a pill, or a navy fade or scrim, never bare on a busy photo. The
 * validator admits text over a photo only when one of these carries it, and hard QA then holds it to
 * its contrast measured on the rendered pixels (ADR-157 D7).
 */

/** An overlay carries text where it is at least this opaque over the text's whole extent. */
export const OVERLAY_CARRY_MIN_OPACITY = 0.55;

/** The opacity an overlay has at a share (0..1) of its length, interpolated between its stops. */
export function overlayOpacityAt(o: Pick<OverlayElement, 'stops'>, at: number): number {
  const stops = [...o.stops].sort((a, b) => a.at - b.at);
  if (!stops.length) return 0;
  if (at <= stops[0].at) return stops[0].opacity;
  for (let i = 1; i < stops.length; i++) {
    if (at <= stops[i].at) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = b.at === a.at ? 1 : (at - a.at) / (b.at - a.at);
      return a.opacity + (b.opacity - a.opacity) * t;
    }
  }
  return stops[stops.length - 1].opacity;
}

function contains(outer: Box, inner: Box, slack = 0): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/** The least opacity an overlay has anywhere over `box`, or 0 when the box is not inside it. */
export function overlayOpacityOver(o: OverlayElement, box: Box): number {
  if (!contains(o, box, 1)) return 0;
  // The share along the overlay's direction of each end of the box.
  const along = (v: number, start: number, length: number) => Math.min(1, Math.max(0, (v - start) / Math.max(1, length)));
  let a: number, b: number;
  if (o.direction === 'radial') {
    // The farthest corner of the box from the centre, as a share of the way out to the ellipse.
    const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    const far = Math.max(...[[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(([x, y]) => Math.hypot((x - cx) / Math.max(1, o.width / 2), (y - cy) / Math.max(1, o.height / 2))));
    if (far >= 1) return 0;
    // Distance is continuous over a rectangle. The nearest point is the centre projected
    // onto the rectangle; inspecting only its farthest corner misses interior clear rings.
    const nearX = Math.max(box.x, Math.min(cx, box.x + box.width));
    const nearY = Math.max(box.y, Math.min(cy, box.y + box.height));
    a = Math.hypot((nearX - cx) / Math.max(1, o.width / 2), (nearY - cy) / Math.max(1, o.height / 2));
    b = far;
  } else switch (o.direction) {
    case 'to-bottom': a = along(box.y, o.y, o.height); b = along(box.y + box.height, o.y, o.height); break;
    case 'to-top': a = 1 - along(box.y + box.height, o.y, o.height); b = 1 - along(box.y, o.y, o.height); break;
    case 'to-right': a = along(box.x, o.x, o.width); b = along(box.x + box.width, o.x, o.width); break;
    default: a = 1 - along(box.x + box.width, o.x, o.width); b = 1 - along(box.x, o.x, o.width); break;
  }
  // ADR198: a piecewise-linear opacity reaches its minimum at an endpoint or a stop.
  // Fixed samples can miss arbitrarily narrow clear valleys even in an admitted eight-stop field.
  let least = Math.min(overlayOpacityAt(o, a), overlayOpacityAt(o, b));
  for (const stop of o.stops) if (stop.at >= a && stop.at <= b) least = Math.min(least, stop.opacity);
  return least;
}

/** A shape text can sit on: a filled overlay panel (plate, card, tab, pill). */
export function isSurfaceShape(s: ShapeElement): boolean {
  return s.layer === 'overlay' && s.role === 'panel' && s.fill !== 'none';
}

/**
 * What carries a text box laid over a photo: the topmost filled overlay panel that contains it, or
 * an overlay at least OVERLAY_CARRY_MIN_OPACITY opaque over all of it. Undefined when nothing does.
 */
export function carrierOf(
  layout: Pick<StudioLayoutV2, 'shapes' | 'overlays'>,
  box: Box
): { kind: 'shape'; shape: ShapeElement } | { kind: 'overlay'; overlay: OverlayElement; opacity: number } | undefined {
  const shapes = layout.shapes || [];
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (isSurfaceShape(s) && contains(s, box, 2)) return { kind: 'shape', shape: s };
  }
  const overlays = layout.overlays || [];
  for (let i = overlays.length - 1; i >= 0; i--) {
    const opacity = overlayOpacityOver(overlays[i], box);
    if (opacity >= OVERLAY_CARRY_MIN_OPACITY) return { kind: 'overlay', overlay: overlays[i], opacity };
  }
  return undefined;
}

/**
 * Whether a shape paints over `box`. A shape drawn as a stroke only (a frame or an inset line)
 * paints only its band, so a text box well inside it does not touch it.
 */
export function shapePaintsOver(s: ShapeElement, box: Box): boolean {
  const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  if (!hit(s, box)) return false;
  if (s.fill !== 'none') return true;
  const half = (s.strokeWidth || 1) / 2 + 1;
  const inner = { x: s.x + half, y: s.y + half, width: s.width - 2 * half, height: s.height - 2 * half };
  return !(inner.width > 0 && inner.height > 0 && contains(inner, box));
}
