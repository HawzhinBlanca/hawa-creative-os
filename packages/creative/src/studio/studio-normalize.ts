import type { StudioLayoutV2 } from './layout-v2.js';

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

  if (!lyt.logo) {
    const logoMinPx = Math.max(100, Math.round(width * 0.08));
    lyt.logo = {
      x: Math.round(width / 2 - logoMinPx / 2),
      y: lyt.grid.margin,
      width: logoMinPx,
      height: Math.round(logoMinPx / logoAspect),
    };
  } else {
    lyt.logo.width = Math.max(100, lyt.logo.width || 100);
    lyt.logo.height = Math.round(lyt.logo.width / logoAspect);
    const maxLogoX = width - lyt.grid.margin - lyt.logo.width;
    const maxLogoY = height - lyt.grid.margin - lyt.logo.height;
    lyt.logo.x = Math.max(lyt.grid.margin, Math.min(lyt.logo.x ?? lyt.grid.margin, maxLogoX));
    lyt.logo.y = Math.max(lyt.grid.margin, Math.min(lyt.logo.y ?? lyt.grid.margin, maxLogoY));
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

    const maxTextX = width - lyt.grid.margin - t.width;
    const maxTextY = height - lyt.grid.margin - t.height;
    if (maxTextX >= lyt.grid.margin) {
      t.x = Math.max(lyt.grid.margin, Math.min(t.x ?? lyt.grid.margin, maxTextX));
    }
    if (maxTextY >= lyt.grid.margin) {
      t.y = Math.max(lyt.grid.margin, Math.min(t.y ?? lyt.grid.margin, maxTextY));
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
  aspect: number
): T {
  const box = layout.logo;
  if (!box || !(aspect > 0) || !(box.width > 0) || !(box.height > 0)) return layout;
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  layout.logo = {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
  return layout;
}
