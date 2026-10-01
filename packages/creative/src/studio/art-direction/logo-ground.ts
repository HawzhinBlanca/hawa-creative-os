import { PNG } from 'pngjs';
import type { Box, LogoGroundRecord, OverlayElement, ShapeElement, StudioLayoutV2 } from '../layout-v2.js';
import { photoRecipeOf } from '../layout-v2.js';
import { getSafeZoneBox, logoClearZone, usesGuidelineClearSpace } from '../house-rules.js';
import { brandTones } from './solver.js';
import { calculateLuminanceContrastRatio, rgbToLuminance } from '../composite-contrast.js';
import { coverCrop } from '../photo-crop.js';
import { renderLayoutV2ToSvg, svgToPngAsync, type RenderLayoutOptions } from '../render-layout-v2.js';

/**
 * ADR-180 (owner, 2026-09-30: "current design has logo background"): the logo sat in a heavy navy
 * square the size of its whole clear space, drawn by the hero_storyboard recipe whatever lay under it,
 * and every other recipe gave it a cream tab whenever it touched a photo. The office sets its logo on
 * the picture, the fade, the plate, the card or the paper, and lifts it only where the picture is busy.
 *
 * So the logo now goes bare, and its ground is measured on the rendered pixels: the logo's contrast
 * on what is under it (the 95th percentile over its ink, so its lettering and outline must read, not
 * every pale ray), and how busy that ground is (the standard deviation of its luma under the logo
 * box). A quiet ground keeps the logo bare. Otherwise the calmer top corner is tried; then the
 * lightest radial scrim that makes it read (weakest first, in the tone nearest the ground); and only when no scrim
 * does, a thin cream rounded tab, the logo plus a few pixels. Nothing behind the logo ever reaches
 * beyond its clear-space box (`logoBackingExcess`, a hard-QA defect). No model is called: each try is
 * a render of the clear-space box alone.
 */

/** The logo's ink must reach this contrast on its ground: WCAG's 3:1 for graphics. */
export const LOGO_MIN_CONTRAST = 3;
/** A ground busier than this under the logo box (luma standard deviation, 0..1) is lifted. */
export const LOGO_MAX_BUSYNESS = 0.12;
/** The scrims tried, lightest first: centre opacity. */
const SCRIM_OPACITIES = [0.45, 0.65, 0.85];

export interface LogoGroundReading {
  contrast: number;
  busyness: number;
  /** Share of the logo box the logo's ink covers, as drawn. */
  inkShare: number;
  /** The ground's mean luma under the logo box, 0..1. */
  luma: number;
}

const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const holds = (outer: Box, inner: Box, slack = 0) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
const intBox = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });

/** A shape that backs the logo: a filled overlay tab holding it. */
export function isLogoBackingShape(s: ShapeElement, logo: Box): boolean {
  return s.layer === 'overlay' && s.role === 'panel' && s.surface === 'tab' && s.fill !== 'none' && holds(s, logo, 1);
}

/** A radial scrim behind the logo. */
export function isLogoScrim(o: OverlayElement, logo: Box): boolean {
  return o.direction === 'radial' && hit(o, logo);
}

/** A solid tab behind the logo reaches at most this share of the logo's height past each side. */
export const LOGO_TAB_MAX_PAD_SHARE = 0.4;

/**
 * How far anything behind the logo reaches beyond what it may cover, in pixels (0 when it stays
 * inside). A soft scrim may cover the logo's clear-space box and no more. A solid tab is thin: the
 * logo plus at most LOGO_TAB_MAX_PAD_SHARE of its height on each side, never its whole clear space (the
 * navy square of 2026-09-30 filled exactly that box). A card or plate the logo sits on is the design's
 * surface, not a backing: only a tab holding the logo and a radial scrim under it count.
 */
export function logoBackingExcess(layout: Pick<StudioLayoutV2, 'logo' | 'shapes' | 'overlays'> & Partial<Pick<StudioLayoutV2, 'composition'>>, clearSpacePx = 0): number {
  if (!layout.logo) return 0;
  const clear = logoClearZone(layout.logo, clearSpacePx, { clientOnly: usesGuidelineClearSpace(layout) });
  const pad = Math.min(clear.x < layout.logo.x ? layout.logo.x - clear.x : 0, LOGO_TAB_MAX_PAD_SHARE * layout.logo.height);
  const thin = { x: layout.logo.x - pad, y: layout.logo.y - pad, width: layout.logo.width + 2 * pad, height: layout.logo.height + 2 * pad };
  const backings: Array<[Box, Box]> = [
    ...(layout.shapes ?? []).filter((s) => isLogoBackingShape(s, layout.logo)).map((s): [Box, Box] => [s, thin]),
    ...(layout.overlays ?? []).filter((o) => isLogoScrim(o, layout.logo)).map((o): [Box, Box] => [o, clear]),
  ];
  let excess = 0;
  for (const [b, limit] of backings) {
    excess = Math.max(excess, limit.x - b.x, limit.y - b.y, b.x + b.width - (limit.x + limit.width), b.y + b.height - (limit.y + limit.height));
  }
  return Math.max(0, Math.round(excess));
}

/** The luma (0..1, gamma-encoded) of a pixel. */
const luma = (d: Buffer, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

/**
 * Reads the logo's ground from two renders of the same region, with and without the logo: the ground's
 * busyness under the logo box, and the logo's contrast on it over its ink (the pixels the logo changes).
 * `region` is where the renders were taken on the canvas; `logo` is in canvas pixels.
 */
export function readLogoGround(withLogo: PNG, ground: PNG, region: Box, logo: Box): LogoGroundReading {
  const x0 = Math.max(0, Math.round(logo.x - region.x)), y0 = Math.max(0, Math.round(logo.y - region.y));
  const x1 = Math.min(ground.width, Math.round(logo.x + logo.width - region.x)), y1 = Math.min(ground.height, Math.round(logo.y + logo.height - region.y));
  let n = 0, sum = 0, sq = 0;
  const contrasts: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * ground.width + x) * 4;
      const l = luma(ground.data, i);
      n++; sum += l; sq += l * l;
      const d = withLogo.data;
      const g = ground.data;
      // A pixel the logo changes is its ink, as drawn over this ground.
      if (Math.max(Math.abs(d[i] - g[i]), Math.abs(d[i + 1] - g[i + 1]), Math.abs(d[i + 2] - g[i + 2])) > 24) {
        contrasts.push(calculateLuminanceContrastRatio(rgbToLuminance(d[i], d[i + 1], d[i + 2]), rgbToLuminance(g[i], g[i + 1], g[i + 2])));
      }
    }
  }
  const mean = n ? sum / n : 0;
  const busyness = n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
  contrasts.sort((a, b) => a - b);
  // Too little ink changes the picture to be read: the logo does not show at all.
  const contrast = contrasts.length >= 0.02 * n ? contrasts[Math.min(contrasts.length - 1, Math.floor(0.95 * contrasts.length))] : 1;
  return { contrast: Math.round(contrast * 100) / 100, busyness: Math.round(busyness * 1000) / 1000, inkShare: n ? contrasts.length / n : 0, luma: Math.round(mean * 1000) / 1000 };
}

/** Whether a reading lets the logo stand bare. */
/**
 * Whether a reading lets the logo stand bare: a calm ground it reads on at 3:1, or at least nine
 * tenths as well as on the white it was drawn for (`native`). A small logo's thin lettering is
 * softened by its own scaling, so on plain white it may measure under 3:1 and still be the logo as
 * the office publishes it.
 */
export function logoGroundQuiet(r: LogoGroundReading, native = LOGO_MIN_CONTRAST / 0.9): boolean {
  return r.contrast >= Math.min(LOGO_MIN_CONTRAST, 0.9 * native) && r.busyness <= LOGO_MAX_BUSYNESS;
}

/** The logo's own contrast on white, at the size it is drawn: what it reads like as designed. */
export async function nativeLogoContrast(layout: StudioLayoutV2, options: RenderLayoutOptions): Promise<number> {
  const { noTextSvg, files } = renderLayoutV2ToSvg(layout, options);
  const logo = noTextSvg.match(/<image id="logo"[^>]*\/>/)?.[0];
  if (!logo) return 1;
  const { x, y, width, height } = layout.logo;
  const open = `<svg width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`;
  const white = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#FFFFFF"/>`;
  const [a, b] = await Promise.all([
    svgToPngAsync(`${open}${white}${logo}</svg>`, width, height, options, files),
    svgToPngAsync(`${open}${white}</svg>`, width, height, options, files),
  ]);
  return readLogoGround(PNG.sync.read(a), PNG.sync.read(b), { x, y, width, height }, layout.logo).contrast;
}

/** Renders the design's no-text composite over `region` only, with and without the logo. */
async function renderRegion(layout: StudioLayoutV2, region: Box, options: RenderLayoutOptions): Promise<{ withLogo: PNG; ground: PNG }> {
  const { noTextSvg, files } = renderLayoutV2ToSvg(layout, options);
  const crop = (svg: string) => svg.replace(
    /<svg width="\d+" height="\d+" viewBox="0 0 \d+ \d+"/,
    `<svg width="${region.width}" height="${region.height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}"`
  );
  const bare = noTextSvg.replace(/<image id="logo"[^>]*\/>/, '');
  const [a, b] = await Promise.all([
    svgToPngAsync(crop(noTextSvg), region.width, region.height, options, files),
    svgToPngAsync(crop(bare), region.width, region.height, options, files),
  ]);
  return { withLogo: PNG.sync.read(a), ground: PNG.sync.read(b) };
}

/** The region a logo's ground is read over: its clear-space box, on the canvas. */
function regionFor(layout: StudioLayoutV2, logo: Box, clearSpacePx: number): Box {
  const c = logoClearZone(logo, clearSpacePx);
  const x = Math.max(0, Math.floor(c.x)), y = Math.max(0, Math.floor(c.y));
  return { x, y, width: Math.max(2, Math.min(layout.width, Math.ceil(c.x + c.width)) - x), height: Math.max(2, Math.min(layout.height, Math.ceil(c.y + c.height)) - y) };
}

/** Measures the logo's ground in a layout as it would be rendered. */
export async function measureLogoGround(layout: StudioLayoutV2, options: RenderLayoutOptions, clearSpacePx = 0): Promise<LogoGroundReading> {
  const region = regionFor(layout, layout.logo, clearSpacePx);
  const { withLogo, ground } = await renderRegion(layout, region, options);
  return readLogoGround(withLogo, ground, region, layout.logo);
}

/** Where the faces the detector found land on the canvas, for the photos placed in a layout. */
export function faceBoxesOf(
  layout: Pick<StudioLayoutV2, 'photos'>,
  photos: Array<{ photoIndex: number; width: number; height: number; focus?: { x: number; y: number }; faceShare?: number }>
): Box[] {
  const out: Box[] = [];
  for (const el of layout.photos ?? []) {
    const p = photos.find((q) => q.photoIndex === el.photoIndex);
    if (!p?.focus || !p.faceShare || el.treatment === 'cutout' || el.role === 'texture') continue;
    const crop = coverCrop(el, p, el.focus ?? p.focus);
    const scale = el.height / crop.sh;
    const cx = el.x + (p.focus.x * p.width - crop.sx) * scale;
    const cy = el.y + (p.focus.y * p.height - crop.sy) * scale;
    const half = 0.75 * p.faceShare * p.height * scale;
    out.push({ x: cx - half, y: cy - half, width: 2 * half, height: 2 * half });
  }
  return out;
}

export interface SettleLogoOptions {
  /** Render options with the client's logo and the photos, as the preview is drawn. */
  render: RenderLayoutOptions;
  /** The client's minimum clear space around the logo, in pixels. */
  clearSpacePx?: number;
  /** Faces on the canvas the logo must not cover. */
  faces?: Box[];
  /** The client's palette: its cream and navy are the scrim's and the tab's tones. */
  palette: string[];
}

/**
 * The same logo box at the other top corner of the safe area, when it is at one: kept only when its
 * clear space touches no copy, no face, and no plate, card or pill it would half cover.
 */
function mirroredCorner(layout: StudioLayoutV2, opts: SettleLogoOptions): Box | undefined {
  const { logo } = layout;
  // The solver's safe area: its margin is the layout's grid margin.
  const safe = getSafeZoneBox(layout.width, layout.height, layout.grid.margin);
  const left = safe.x, right = safe.x + safe.width - logo.width;
  if (Math.abs(logo.y - safe.y) > 1) return undefined;
  const x = Math.abs(logo.x - left) <= 1 ? right : Math.abs(logo.x - right) <= 1 ? left : undefined;
  if (x === undefined) return undefined;
  const moved = { ...logo, x };
  const clear = logoClearZone(moved, opts.clearSpacePx ?? 0);
  if (layout.text.some((t) => hit(t, clear))) return undefined;
  if ((opts.faces ?? []).some((f) => hit(f, moved))) return undefined;
  if (layout.shapes.some((s) => s.layer === 'overlay' && s.fill !== 'none' && hit(s, clear) && !holds(s, clear))) return undefined;
  return moved;
}

/**
 * ADR-180: gives a solved recipe's logo the lightest ground treatment its pixels need, and records it
 * (`artDirection.logoGround`). A layout outside a recipe is returned as it is. Any logo backing the
 * solver left is taken away first: the pixels decide.
 */
export async function settleLogoGround(layout: StudioLayoutV2, opts: SettleLogoOptions): Promise<StudioLayoutV2> {
  if (!photoRecipeOf(layout) || !layout.logo || !(opts.render.logoDataUri || opts.render.logoPath)) return layout;
  const clearSpacePx = opts.clearSpacePx ?? 0;
  const { cream, navy } = brandTones(opts.palette);
  const bare: StudioLayoutV2 = {
    ...layout,
    shapes: layout.shapes.filter((s) => !isLogoBackingShape(s, layout.logo) || layout.artDirection?.recipe === 'hero_card'),
    ...(layout.overlays ? { overlays: layout.overlays.filter((o) => !isLogoScrim(o, layout.logo)) } : {}),
  };
  const record = (l: StudioLayoutV2, treatment: LogoGroundRecord['treatment'], r: LogoGroundReading, moved: boolean): StudioLayoutV2 => ({
    ...l,
    artDirection: { ...l.artDirection!, logoGround: { treatment, contrast: Math.min(21, Math.max(1, r.contrast)), busyness: Math.min(1, r.busyness), ...(moved ? { moved: true } : {}) } },
  });
  // The hero_card wordmark tab is the recipe's own surface (rulebook item 4): the logo already reads on it.
  const onSurface = bare.shapes.some((s) => s.layer === 'overlay' && s.role === 'panel' && s.fill !== 'none' && holds(s, bare.logo, 1));
  const here = await measureLogoGround(bare, opts.render, clearSpacePx);
  if (onSurface) return record(bare, 'none', here, false);
  const native = await nativeLogoContrast(bare, opts.render);
  const quiet = (r: LogoGroundReading) => logoGroundQuiet(r, native);
  if (quiet(here)) return record(bare, 'none', here, false);
  const other = mirroredCorner(bare, opts);
  if (other) {
    const movedLayout = { ...bare, logo: other };
    const there = await measureLogoGround(movedLayout, opts.render, clearSpacePx);
    if (quiet(there)) return record(movedLayout, 'none', there, true);
  }
  // The lightest scrim that makes it read, no larger than the clear-space box, in the tone nearest the
  // ground so it shows least (cream on a pale wall, navy on a dark coat), else the other tone.
  const clear = intBox(logoClearZone(bare.logo, clearSpacePx));
  if ((bare.overlays?.length ?? 0) < 6) {
    const tones = here.luma >= 0.5 ? [cream, navy] : [navy, cream];
    for (const opacity of SCRIM_OPACITIES) {
      for (const color of tones) {
        const scrim: OverlayElement = {
          kind: 'gradient', purpose: 'scrim', direction: 'radial', color, ...clear,
          stops: [{ at: 0, opacity }, { at: 0.55, opacity: Math.round(0.85 * opacity * 1000) / 1000 }, { at: 1, opacity: 0 }],
        };
        const tried: StudioLayoutV2 = { ...bare, overlays: [...(bare.overlays ?? []), scrim] };
        const reading = await measureLogoGround(tried, opts.render, clearSpacePx);
        if (quiet(reading)) return record(tried, 'scrim', reading, false);
      }
    }
  }
  // Only then a thin cream tab: the logo and a few pixels, rounded, well inside its clear space.
  const pad = Math.max(4, Math.round(0.07 * bare.logo.height));
  const tabBox = intBox({ x: bare.logo.x - pad, y: bare.logo.y - pad, width: bare.logo.width + 2 * pad, height: bare.logo.height + 2 * pad });
  const tab: ShapeElement = { kind: 'roundRect', role: 'panel', layer: 'overlay', surface: 'tab', color: cream, ...tabBox, radius: Math.round(0.2 * tabBox.height) };
  const tabbed: StudioLayoutV2 = { ...bare, shapes: [...bare.shapes, tab] };
  return record(tabbed, 'tab', await measureLogoGround(tabbed, opts.render, clearSpacePx), false);
}
