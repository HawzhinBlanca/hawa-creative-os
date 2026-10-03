import type { ShapeElement, StudioLayoutV2 } from './layout-v2.js';
import { getSafeZoneBox } from './house-rules.js';

/**
 * Above this, a strokeWidth the model wrote is read as pixels rather than as a share of the canvas
 * width.
 *
 * Measured over the 200 designs stored under output/proofs/2026-09-18-*: 114 shapes carry a
 * strokeWidth. The 76 the generator read as a fraction scaled to between 1px and 5px, so the model
 * had written at most 0.0046. The other 38 are 1080, 1240, 2160, 2480 or 3840 — in every case
 * exactly 1x or 2x their own canvas width, because the model had written a plain 1 or 2 and meant
 * pixels. The two populations are more than two hundred times apart, so the boundary is not
 * delicate; 0.05 sits near the middle of the gap in log terms and is ten times the largest fraction
 * anything in the corpus actually used. Reading an ambiguous value as pixels can only make a stroke
 * thinner, which is the safe direction.
 */
export const STROKE_WIDTH_PIXEL_THRESHOLD = 0.05;

/**
 * How far a stroke may paint outside the box its shape declares, in pixels, before QA calls it a
 * defect. The heaviest legitimate stroke in the stored corpus is 5px, which reaches 2.5px past each
 * edge; the broken ones reach 540px and more.
 */
export const STROKE_PAINT_TOLERANCE_PX = 4;

/**
 * The heaviest stroke a role may carry on a canvas of this size.
 *
 * Every stroke in the stored corpus that the generator read as a fraction came out between 1px and
 * 5px, at most 0.46% of the canvas short edge. These ceilings are about twice that, so nothing the
 * models have drawn legitimately is clamped, with a floor so a small canvas keeps a usable range.
 * A divider is a hairline in this house style; a panel or frame border may be heavier.
 */
export function maxStrokeWidth(role: ShapeElement['role'], width: number, height: number): number {
  const shortEdge = Math.max(1, Math.min(width, height));
  return role === 'panel' || role === 'frame'
    ? Math.max(12, Math.round(0.02 * shortEdge))
    : Math.max(8, Math.round(0.01 * shortEdge));
}

/**
 * The heaviest stroke this particular shape may carry: its role's ceiling, and never so heavy that
 * the paint reaches further outside the declared box than `STROKE_PAINT_TOLERANCE_PX` or one
 * box-thickness, whichever is larger. A stroke is painted centred on the shape's path, and nothing
 * else in the pipeline measures anything but the declared box, so paint outside it is invisible to
 * overlap, to the metrics and to the safe-area check.
 */
export function allowedStrokeWidth(
  shape: Pick<ShapeElement, 'role' | 'width' | 'height'>,
  canvasWidth: number,
  canvasHeight: number
): number {
  const escape = Math.max(STROKE_PAINT_TOLERANCE_PX, Math.min(shape.width, shape.height));
  return Math.min(maxStrokeWidth(shape.role, canvasWidth, canvasHeight), 2 * escape);
}

/**
 * Reads the strokeWidth of a freshly generated shape in whatever unit the model used, then holds it
 * to what the shape may carry. Values below `STROKE_WIDTH_PIXEL_THRESHOLD` are a share of the
 * canvas width; anything above it is already pixels.
 */
export function resolveStrokeWidth(
  raw: number,
  shape: Pick<ShapeElement, 'role' | 'width' | 'height'>,
  canvasWidth: number,
  canvasHeight: number
): number {
  const px = raw >= STROKE_WIDTH_PIXEL_THRESHOLD ? raw : raw * canvasWidth;
  return Math.min(allowedStrokeWidth(shape, canvasWidth, canvasHeight), Math.max(1, Math.round(px)));
}

/**
 * Repairs a stroke a layout already carries. Stored winners and layouts a refinement model hands
 * back never pass through the generator's scaling, so fixing that alone would leave 38 of the 200
 * designs stored on 2026-09-18 painting a slab over themselves. 34 still carried the slab after
 * preparation, and 31 of those 34 passed hard QA. transfer-v2 turns the value into points at 0.75x,
 * so a 2160px stroke reached Canva as a 1620pt outline.
 *
 * `Math.round(strokeWidth * canvasWidth)` is the operation that created the broken values, so
 * dividing by the canvas width inverts it: every one of the 38 is an exact 1x or 2x, and comes back
 * as the 1px or 2px rule the model asked for. Anything that does not invert to a usable stroke is
 * simply clamped. Mutates and returns the layout.
 */
export function repairStrokeWidths<T extends Pick<StudioLayoutV2, 'width' | 'height' | 'shapes'>>(layout: T): T {
  for (const shape of layout.shapes || []) {
    if (shape.strokeWidth === null || shape.strokeWidth === undefined) continue;
    const allowed = allowedStrokeWidth(shape, layout.width, layout.height);
    if (shape.strokeWidth <= allowed) continue;
    const undone = Math.round(shape.strokeWidth / Math.max(1, layout.width));
    shape.strokeWidth = undone >= 1 && undone <= allowed ? undone : allowed;
  }
  return layout;
}

/**
 * Reads the corner radius of a freshly generated shape in whatever unit the model wrote,
 * and clamps it so the corner curve never exceeds half of the shape's smaller dimension.
 * Values <= 0.05 are a share of the canvas width; anything above is already in pixels.
 */
export function resolveRadius(
  raw: number,
  shape: Pick<ShapeElement, 'width' | 'height'>,
  canvasWidth: number
): number {
  const maxRadius = Math.max(0, Math.floor(Math.min(shape.width, shape.height) / 2));
  const px = raw <= 0.05 ? raw * canvasWidth : raw;
  return Math.min(maxRadius, Math.max(0, Math.round(px)));
}

/**
 * Repairs oversized corner radii on existing stored layouts or refinement outputs.
 * An oversized radius (> min(width, height) / 2) stems from multiplying pixel values
 * by canvas width (e.g. radius: 8640 from 8 * 1080).
 */
export function repairRadii<T extends Pick<StudioLayoutV2, 'width' | 'height' | 'shapes'>>(layout: T): T {
  for (const shape of layout.shapes || []) {
    if (shape.radius === null || shape.radius === undefined) continue;
    const maxRadius = Math.max(0, Math.floor(Math.min(shape.width, shape.height) / 2));
    if (shape.radius <= maxRadius) continue;
    const undone = Math.round(shape.radius / Math.max(1, layout.width));
    shape.radius = undone >= 0 && undone <= maxRadius ? undone : maxRadius;
  }
  return layout;
}

/**
 * The studio's post-generation normalisation: a 6% safe margin, the logo at its real aspect and
 * inside the margins, minimum type sizes, text boxes clamped inside the margins, and any non-panel
 * shape that collides with text or the logo removed. Mutates and returns the layout.
 *
 * Moved here unchanged from the studio's layouts stage so the qualification applies exactly what
 * production applies. Before, production normalised every generated layout and the qualification
 * never did, so the two scored different layouts.
 */
export function normalizeStudioLayout(
  lyt: any,
  width: number,
  height: number,
  logoAspect: number = 1.0
): StudioLayoutV2 {
  if (!lyt) lyt = {};
  if (!lyt.shapes) lyt.shapes = [];
  if (!lyt.text) lyt.text = [];
  if (!lyt.width) lyt.width = width;
  if (!lyt.height) lyt.height = height;

  const shortEdge = Math.min(width, height);
  const minSafeMargin = Math.floor(0.06 * shortEdge);
  if (!lyt.grid) {
    lyt.grid = {
      margin: minSafeMargin,
      columns: 12,
      gutter: 16,
      baseline: 8,
    };
  } else {
    lyt.grid.margin = Math.max(minSafeMargin, lyt.grid.margin || minSafeMargin);
  }
  const safe = getSafeZoneBox(width, height, lyt.grid.margin);
  const left = Math.max(lyt.grid.margin, safe.x);
  const top = Math.max(lyt.grid.margin, safe.y);
  const right = Math.min(width - lyt.grid.margin, safe.x + safe.width);
  const bottom = Math.min(height - lyt.grid.margin, safe.y + safe.height);

  if (!lyt.logo) {
    const logoMinPx = Math.max(100, Math.round(width * 0.08));
    lyt.logo = {
      x: Math.round(width / 2 - logoMinPx / 2),
      y: top,
      width: logoMinPx,
      height: Math.round(logoMinPx / logoAspect),
    };
  } else {
    lyt.logo.width = Math.max(100, lyt.logo.width || 100);
    lyt.logo.height = Math.round(lyt.logo.width / logoAspect);
    const maxLogoX = right - lyt.logo.width;
    const maxLogoY = bottom - lyt.logo.height;
    if (maxLogoX >= left) lyt.logo.x = Math.max(left, Math.min(lyt.logo.x ?? left, maxLogoX));
    if (maxLogoY >= top) lyt.logo.y = Math.max(top, Math.min(lyt.logo.y ?? top, maxLogoY));
  }

  if (lyt.art) {
    if (!lyt.art.box) {
      lyt.art.box = { x: 0, y: 0, width: lyt.width, height: lyt.height };
    }
    if (!lyt.art.calmRegion) {
      lyt.art.calmRegion = { ...lyt.art.box };
    }
  }

  const minBodyPx = Math.ceil(0.016 * width);
  for (const t of lyt.text) {
    if (t.role === 'body') t.fontSize = Math.max(t.fontSize || 0, minBodyPx);
    else if (t.role === 'footer') t.fontSize = Math.max(t.fontSize || 0, 12);
    else t.fontSize = Math.max(t.fontSize || 0, 12);

    const maxTextX = right - t.width;
    const maxTextY = bottom - t.height;
    if (maxTextX >= left) {
      t.x = Math.max(left, Math.min(t.x ?? left, maxTextX));
    }
    if (maxTextY >= top) {
      t.y = Math.max(top, Math.min(t.y ?? top, maxTextY));
    }
  }

  const roleSizes: Record<string, number> = {};
  for (const t of lyt.text) {
    roleSizes[t.role] = Math.max(roleSizes[t.role] || 0, t.fontSize);
  }
  const titleSize = roleSizes['title'];
  const subtitleSize = roleSizes['subtitle'];
  const dateVenueSize = Math.max(roleSizes['date'] || 0, roleSizes['venue'] || 0);
  if (titleSize && subtitleSize && dateVenueSize && subtitleSize < dateVenueSize && titleSize > dateVenueSize) {
    for (const t of lyt.text) {
      if (t.role === 'subtitle') {
        t.fontSize = dateVenueSize;
      }
    }
  }

  const checkBoxesIntersect = (a: any, b: any) =>
    !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

  repairStrokeWidths(lyt as StudioLayoutV2);
  repairRadii(lyt as StudioLayoutV2);

  lyt.shapes = (lyt.shapes || []).map((s: any) => {
    if (s.role === 'frame') return { ...s, role: 'panel' };
    return s;
  }).filter((s: any) => {
    if (s.role === 'panel') return true;
    const hitsText = lyt.text.some((t: any) => checkBoxesIntersect(s, t));
    const hitsLogo = lyt.logo ? checkBoxesIntersect(s, lyt.logo) : false;
    return !hitsText && !hitsLogo;
  });

  return lyt as StudioLayoutV2;
}

/**
 * Fits a logo of the real aspect inside the box a layout reserved for it, centred — the way CSS
 * object-fit: contain does. It never grows the box, so correcting the aspect cannot push the logo
 * into the title below it.
 *
 * The generator plans the logo box without knowing the emblem's shape, and the studio used to fix
 * the aspect by growing the height from the width. Five of the twenty production-model winners
 * reserved boxes 1.15 to 1.55 wide for KAAE's square emblem; grown to square, each extends up to
 * 68px further down the canvas than the layout planned for.
 */
export function fitLogoToAspect<T extends { logo?: { x: number; y: number; width: number; height: number } }>(
  layout: T,
  aspect: number,
  /** When given, a box attached to the left or right margin keeps that edge instead of centring. */
  canvas?: { width: number; margin: number }
): T {
  const box = layout.logo;
  if (!box || !(aspect > 0) || !(box.width > 0) || !(box.height > 0)) return layout;
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  const attached = canvas
    ? Math.abs(box.x - canvas.margin) <= 2
      ? 'left'
      : Math.abs(box.x + box.width - (canvas.width - canvas.margin)) <= 2
        ? 'right'
        : null
    : null;
  const x = attached === 'left' ? box.x : attached === 'right' ? box.x + box.width - width : box.x + (box.width - width) / 2;
  layout.logo = {
    x: Math.round(x),
    y: Math.round(box.y + (box.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
  return layout;
}
