import type { StudioLayoutV2, PhotoElement, TextElement } from '@hawa/creative';
import type { EditOp } from './stages/edit.stage.js';

/**
 * The operation catalogue's appliers (research 2026-09-23, REVISION_TAXONOMY_AND_OPERATIONS.md §5;
 * ADR-032 plan 2.2): the common changes a requester asks for, made by code from the parameters the
 * analysis read out of their words, each with the check that says it shows. A model editing the
 * whole layout JSON could make them too, and sometimes made something else as well; code makes
 * exactly the change, costs nothing, and the edit model is called only for what no rule covers
 * ("spread the text out", "make it more modern").
 */
export interface OpParams {
  /** The text block the ask is about, by copy index. */
  text?: number;
  /** A colour, as the analysis chose it from the brand palette. */
  colour?: string;
  /** The words of a block to colour (an accent). */
  words?: string;
  direction?: 'bigger' | 'smaller';
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center';
  /** The photos the ask is about, by photo index; absent is every photo. */
  photos?: number[];
  mask?: 'circle' | 'arch' | 'none';
  fadeEdge?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  filter?: 'bw' | 'duotone' | 'tint' | 'none';
  cutout?: boolean;
  zoom?: 'in' | 'out';
  outline?: boolean;
  glow?: boolean;
}

/** One size step, as a designer nudges type or a logo: a fifth larger or smaller. */
const STEP = 1.2;
/** How much a zoom in or out tightens or loosens a photo's crop. */
const ZOOM_STEP = 1.3;
const FADE_LENGTH = 0.35;
const OUTLINE_WIDTH = 8;
const GLOW_RADIUS = 30;
const TINT_STRENGTH = 0.35;

export interface OpContext {
  palette: string[];
  /** Which photos have a person cut out that passed its checks. */
  cutoutAvailable: (photoIndex: number) => boolean;
  /** The copy of each block, to find accent words in. */
  copy: string[];
}

const hex = (value: unknown): string | undefined => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined);

function rgb(colour: string): [number, number, number] {
  const n = parseInt(colour.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The brand colour nearest to one asked for, so no off-brand colour reaches a design. */
export function nearestBrand(colour: string, palette: string[]): string | undefined {
  const brand = palette.map(hex).filter((c): c is string => Boolean(c));
  const asked = hex(colour);
  if (!asked || !brand.length) return undefined;
  const [r, g, b] = rgb(asked);
  const distance = (c: string) => {
    const [x, y, z] = rgb(c);
    return (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
  };
  return brand.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

const luminance = (colour: string) => {
  const [r, g, b] = rgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The darkest brand colour and the brightest that is not white: the two ends of a brand duotone. */
function duotoneEnds(palette: string[]): { dark: string; light: string } | undefined {
  const brand = palette.map(hex).filter((c): c is string => Boolean(c)).sort((a, b) => luminance(a) - luminance(b));
  if (brand.length < 2) return undefined;
  const coloured = brand.filter((c) => c !== '#FFFFFF');
  return { dark: brand[0], light: coloured[coloured.length - 1] ?? brand[brand.length - 1] };
}

/** The brand accent: the most saturated palette colour, for outlines, glows and tints asked for without a colour. */
function brandAccent(palette: string[]): string | undefined {
  const brand = palette.map(hex).filter((c): c is string => Boolean(c));
  const saturation = (c: string) => {
    const [r, g, b] = rgb(c);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  return brand.sort((a, b) => saturation(b) - saturation(a))[0];
}

type Applied = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Applied => ({ ok: false, reason });
const OK: Applied = { ok: true };

function textOf(layout: StudioLayoutV2, p: OpParams): TextElement | undefined {
  return typeof p.text === 'number' ? layout.text.find((t) => t.copyIndex === p.text) : undefined;
}

function photosOf(layout: StudioLayoutV2, p: OpParams): PhotoElement[] {
  const all = layout.photos ?? [];
  return Array.isArray(p.photos) && p.photos.length ? all.filter((ph) => p.photos!.includes(ph.photoIndex)) : all;
}

/**
 * Makes one ask on the layout, in place, when a rule covers it with the parameters given. Returns
 * whether it was made, or why not (the ask then goes to the edit model).
 */
export function applyOp(
  layout: StudioLayoutV2,
  op: EditOp | undefined,
  p: OpParams,
  ctx: OpContext,
  /**
   * The design the steps are measured from (the one the client received). A size or zoom step is one
   * step from it, however often the rule is made again: made again on the edit model's answer, a step
   * measured from the answer compounded (a title ×1.2 twice, 2026-09-24 review).
   */
  base: StudioLayoutV2 = layout
): Applied {
  switch (op) {
    case 'text_colour': {
      const t = textOf(layout, p);
      const colour = p.colour ? nearestBrand(p.colour, ctx.palette) : undefined;
      if (!t || !colour) return fail('which text or which colour is not clear');
      t.color = colour;
      return OK;
    }
    case 'accent': {
      const t = textOf(layout, p);
      const colour = p.colour ? nearestBrand(p.colour, ctx.palette) : undefined;
      const words = typeof p.words === 'string' ? p.words.trim() : '';
      const copy = t ? ctx.copy[t.copyIndex] ?? '' : '';
      if (!t || !colour || !words || !copy.includes(words)) return fail('the words to colour are not on the design as written');
      t.accentText = words;
      t.accentColor = colour;
      return OK;
    }
    case 'font_size': {
      const t = textOf(layout, p);
      if (!t || !p.direction) return fail('which text, or bigger or smaller, is not clear');
      const factor = p.direction === 'bigger' ? STEP : 1 / STEP;
      const from = textOf(base, p) ?? t;
      t.fontSize = Math.max(8, Math.round(from.fontSize * factor));
      // The box grows or shrinks with its type, downward from its top, so the words still fit.
      t.height = Math.max(1, Math.round(from.height * factor));
      return OK;
    }
    case 'font_weight_or_style': {
      const t = textOf(layout, p);
      if (!t || (typeof p.bold !== 'boolean' && typeof p.italic !== 'boolean')) return fail('which text, or which weight, is not clear');
      if (typeof p.bold === 'boolean') t.bold = p.bold;
      if (typeof p.italic === 'boolean') t.italic = p.italic;
      return OK;
    }
    case 'align_or_spacing': {
      // Alignment is a rule; spacing ("spread it out", "less empty space") is layout, for the model.
      if (!p.align) return fail('spacing is laid out by the edit');
      const blocks = typeof p.text === 'number' ? layout.text.filter((t) => t.copyIndex === p.text) : layout.text;
      if (!blocks.length) return fail('which text is not clear');
      for (const t of blocks) t.align = p.align;
      return OK;
    }
    case 'logo_move_or_scale': {
      const logo = layout.logo;
      if (!logo || (!p.corner && !p.direction)) return fail('where or how big is not clear');
      const m = layout.grid?.margin ?? Math.round(Math.min(layout.width, layout.height) * 0.06);
      if (p.direction) {
        const from = base.logo ?? logo;
        const factor = p.direction === 'bigger' ? STEP : 1 / STEP;
        const width = Math.max(1, Math.round(from.width * factor));
        const height = Math.max(1, Math.round(from.height * factor));
        if (width > layout.width - 2 * m || height > layout.height - 2 * m) return fail('the logo would not fit inside the margins');
        // A logo against a margin stays against it as it grows or shrinks, as a designer resizes it
        // from its corner; one in open space keeps its centre. Either way it stays inside the margins
        // (scaled from its centre, a corner logo crossed the margin and the edit was refused). Only the
        // size is measured from the parent; where the logo is, is where it is now, so a move made in the
        // same edit (a rule's corner, or the model's) is kept (review of 2026-09-24).
        const near = 2;
        const atLeft = logo.x <= m + near;
        const atRight = logo.x + logo.width >= layout.width - m - near;
        const atTop = logo.y <= m + near;
        const atBottom = logo.y + logo.height >= layout.height - m - near;
        const x = atRight ? logo.x + logo.width - width : atLeft ? logo.x : logo.x + (logo.width - width) / 2;
        const y = atBottom ? logo.y + logo.height - height : atTop ? logo.y : logo.y + (logo.height - height) / 2;
        logo.width = width;
        logo.height = height;
        logo.x = Math.round(Math.min(layout.width - m - width, Math.max(m, x)));
        logo.y = Math.round(Math.min(layout.height - m - height, Math.max(m, y)));
      }
      if (p.corner) {
        const right = layout.width - m - logo.width;
        const bottom = layout.height - m - logo.height;
        const centre = Math.round((layout.width - logo.width) / 2);
        logo.x = p.corner.endsWith('left') ? m : p.corner.endsWith('right') ? right : centre;
        logo.y = p.corner.startsWith('top') ? m : bottom;
      }
      return OK;
    }
    case 'photo_filter': {
      const photos = photosOf(layout, p);
      if (!photos.length || !p.filter) return fail('which photo or which colour treatment is not clear');
      for (const ph of photos) {
        if (p.filter === 'none') delete ph.filter;
        else if (p.filter === 'bw') ph.filter = { kind: 'bw' };
        else if (p.filter === 'duotone') {
          const ends = duotoneEnds(ctx.palette);
          if (!ends) return fail('the brand palette has no two colours for a duotone');
          ph.filter = { kind: 'duotone', ...ends };
        } else {
          const colour = (p.colour && nearestBrand(p.colour, ctx.palette)) || brandAccent(ctx.palette);
          if (!colour) return fail('no brand colour to tint with');
          ph.filter = { kind: 'tint', color: colour, strength: TINT_STRENGTH };
        }
      }
      return OK;
    }
    case 'photo_mask': {
      const photos = photosOf(layout, p).filter((ph) => ph.treatment !== 'cutout');
      if (!photos.length || !p.mask) return fail('which photo or which shape is not clear');
      for (const ph of photos) {
        if (p.mask === 'none') {
          delete ph.mask;
          continue;
        }
        ph.mask = p.mask;
        // A circle is round only in a square box: the box becomes the square inside it, centred.
        if (p.mask === 'circle' && ph.width !== ph.height) {
          const side = Math.min(ph.width, ph.height);
          ph.x = Math.round(ph.x + (ph.width - side) / 2);
          ph.y = Math.round(ph.y + (ph.height - side) / 2);
          ph.width = side;
          ph.height = side;
        }
      }
      return OK;
    }
    case 'photo_fade': {
      const photos = photosOf(layout, p);
      if (!photos.length || !p.fadeEdge) return fail('which photo or which edge is not clear');
      for (const ph of photos) {
        if (p.fadeEdge === 'none') delete ph.fade;
        else ph.fade = { edge: p.fadeEdge, length: FADE_LENGTH };
      }
      return OK;
    }
    case 'photo_outline_or_glow': {
      const photos = photosOf(layout, p).filter((ph) => ph.treatment === 'cutout');
      if (!photos.length) return fail('only a person cut out of their photo can have an outline or a glow');
      if (typeof p.outline !== 'boolean' && typeof p.glow !== 'boolean') return fail('outline or glow is not clear');
      const colour = (p.colour && nearestBrand(p.colour, ctx.palette)) || brandAccent(ctx.palette);
      if (!colour) return fail('no brand colour to draw it in');
      for (const ph of photos) {
        if (p.outline === true) ph.outline = { color: colour, width: OUTLINE_WIDTH };
        if (p.outline === false) delete ph.outline;
        if (p.glow === true) ph.glow = { color: colour, radius: GLOW_RADIUS };
        if (p.glow === false) delete ph.glow;
      }
      return OK;
    }
    case 'photo_cutout': {
      if (typeof p.cutout !== 'boolean') return fail('cut out or framed is not clear');
      const photos = photosOf(layout, p);
      if (!photos.length) return fail('which photo is not clear');
      if (p.cutout && photos.some((ph) => !ctx.cutoutAvailable(ph.photoIndex))) return fail('a clean cut-out of that photo could not be made');
      for (const ph of photos) {
        if (p.cutout) {
          ph.treatment = 'cutout';
          delete ph.mask;
          delete ph.zoom;
        } else {
          ph.treatment = 'framed';
          delete ph.outline;
          delete ph.glow;
        }
      }
      return OK;
    }
    case 'photo_crop': {
      const photos = photosOf(layout, p).filter((ph) => ph.treatment !== 'cutout');
      if (!photos.length || !p.zoom) return fail('which photo, or closer or wider, is not clear');
      const zoomOf = (ph: PhotoElement) => {
        const from = base.photos?.find((q) => q.photoIndex === ph.photoIndex);
        return typeof from?.zoom === 'number' ? from.zoom : 1;
      };
      // Wider than the whole photo in its box is not a crop: the box has to change, which is the edit's.
      if (p.zoom === 'out' && photos.every((ph) => zoomOf(ph) <= 1)) return fail('the photo already shows all of itself in its box; showing more needs a bigger box');
      for (const ph of photos) {
        const now = zoomOf(ph);
        const next = p.zoom === 'in' ? now * ZOOM_STEP : now / ZOOM_STEP;
        const zoom = Math.round(Math.min(3, Math.max(1, next)) * 100) / 100;
        if (zoom === 1) delete ph.zoom;
        else ph.zoom = zoom;
      }
      return OK;
    }
    case 'background_colour': {
      const colour = p.colour ? nearestBrand(p.colour, ctx.palette) : undefined;
      if (!colour) return fail('which colour is not clear');
      layout.background = { ...layout.background, color: colour };
      return OK;
    }
    default:
      return fail('laid out by the edit');
  }
}

/**
 * Whether a rule's change shows on the final design (the op's own check, not "something changed"):
 * the text is that colour, the logo is in that corner, the photos carry that treatment. An ask whose
 * check fails is reported not done, whatever else changed.
 */
export function verifyOp(parent: StudioLayoutV2, final: StudioLayoutV2, op: EditOp | undefined, p: OpParams, ctx: OpContext): boolean {
  const before = textOf(parent, p);
  const after = textOf(final, p);
  const photos = photosOf(final, p);
  switch (op) {
    case 'text_colour':
      return Boolean(after && p.colour && after.color?.toUpperCase() === nearestBrand(p.colour, ctx.palette));
    case 'accent':
      return Boolean(after && p.colour && after.accentText === p.words?.trim() && after.accentColor?.toUpperCase() === nearestBrand(p.colour, ctx.palette));
    case 'font_size':
      return Boolean(before && after && (p.direction === 'bigger' ? after.fontSize > before.fontSize : after.fontSize < before.fontSize));
    case 'font_weight_or_style':
      return Boolean(after && (typeof p.bold !== 'boolean' || Boolean(after.bold) === p.bold) && (typeof p.italic !== 'boolean' || Boolean(after.italic) === p.italic));
    case 'align_or_spacing':
      return Boolean(p.align) && (typeof p.text === 'number' ? after?.align === p.align : final.text.every((t) => t.align === p.align));
    case 'logo_move_or_scale': {
      const was = parent.logo;
      const logo = final.logo;
      if (!logo || !was) return false;
      const sized = !p.direction || (p.direction === 'bigger' ? logo.width > was.width : logo.width < was.width);
      const cx = logo.x + logo.width / 2;
      const cy = logo.y + logo.height / 2;
      const placed =
        !p.corner ||
        ((p.corner.endsWith('left') ? cx < final.width / 3 : p.corner.endsWith('right') ? cx > (2 * final.width) / 3 : Math.abs(cx - final.width / 2) < final.width / 6) &&
          (p.corner.startsWith('top') ? cy < final.height / 3 : cy > (2 * final.height) / 3));
      return sized && placed;
    }
    case 'photo_filter':
      return photos.length > 0 && photos.every((ph) => (p.filter === 'none' ? !ph.filter : ph.filter?.kind === p.filter));
    case 'photo_mask': {
      const framed = photos.filter((ph) => ph.treatment !== 'cutout');
      return framed.length > 0 && framed.every((ph) => (p.mask === 'none' ? !ph.mask : ph.mask === p.mask));
    }
    case 'photo_fade':
      return photos.length > 0 && photos.every((ph) => (p.fadeEdge === 'none' ? !ph.fade : ph.fade?.edge === p.fadeEdge));
    case 'photo_outline_or_glow': {
      const people = photos.filter((ph) => ph.treatment === 'cutout');
      return people.length > 0 && people.every((ph) => (typeof p.outline !== 'boolean' || Boolean(ph.outline) === p.outline) && (typeof p.glow !== 'boolean' || Boolean(ph.glow) === p.glow));
    }
    case 'photo_cutout':
      return photos.length > 0 && photos.every((ph) => (p.cutout ? ph.treatment === 'cutout' : ph.treatment !== 'cutout'));
    case 'photo_crop': {
      const was = (i: number) => parent.photos?.find((q) => q.photoIndex === i)?.zoom ?? 1;
      const framed = photos.filter((ph) => ph.treatment !== 'cutout');
      if (!framed.length) return false;
      if (p.zoom === 'in') return framed.every((ph) => (ph.zoom ?? 1) > was(ph.photoIndex));
      // Wider: every photo that was cropped shows more, and one already whole stays whole. Heads matched
      // across portraits often leave one at zoom 1, and requiring it to go lower still reported a made
      // change as not done and paid for an edit call (review of 2026-09-24).
      const cropped = framed.filter((ph) => was(ph.photoIndex) > 1);
      return cropped.length > 0 && cropped.every((ph) => (ph.zoom ?? 1) < was(ph.photoIndex)) &&
        framed.filter((ph) => was(ph.photoIndex) <= 1).every((ph) => (ph.zoom ?? 1) <= 1);
    }
    case 'background_colour':
      return Boolean(p.colour && final.background?.color?.toUpperCase() === nearestBrand(p.colour, ctx.palette));
    default:
      return false;
  }
}

/** The ops a rule covers. An ask of any other kind goes to the edit model. */
export const RULE_OPS: ReadonlySet<EditOp> = new Set<EditOp>([
  'text_colour', 'accent', 'font_size', 'font_weight_or_style', 'align_or_spacing', 'logo_move_or_scale',
  'photo_filter', 'photo_mask', 'photo_fade', 'photo_outline_or_glow', 'photo_cutout', 'photo_crop', 'background_colour',
]);

/** The parameters the analysis gave, kept to their types; anything else is dropped. */
export function opParams(value: unknown): OpParams {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => (allowed.includes(v[key] as T) ? (v[key] as T) : undefined);
  const out: OpParams = {};
  if (Number.isInteger(v.text) && (v.text as number) >= 0) out.text = v.text as number;
  if (hex(v.colour)) out.colour = hex(v.colour);
  if (typeof v.words === 'string' && v.words.trim()) out.words = v.words.trim().slice(0, 200);
  const direction = pick('direction', ['bigger', 'smaller'] as const);
  if (direction) out.direction = direction;
  if (typeof v.bold === 'boolean') out.bold = v.bold;
  if (typeof v.italic === 'boolean') out.italic = v.italic;
  const align = pick('align', ['left', 'center', 'right'] as const);
  if (align) out.align = align;
  const corner = pick('corner', ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'] as const);
  if (corner) out.corner = corner;
  if (Array.isArray(v.photos)) {
    const photos = v.photos.filter((i): i is number => Number.isInteger(i) && (i as number) >= 0);
    if (photos.length) out.photos = photos;
  }
  const mask = pick('mask', ['circle', 'arch', 'none'] as const);
  if (mask) out.mask = mask;
  const fadeEdge = pick('fadeEdge', ['top', 'bottom', 'left', 'right', 'none'] as const);
  if (fadeEdge) out.fadeEdge = fadeEdge;
  const filter = pick('filter', ['bw', 'duotone', 'tint', 'none'] as const);
  if (filter) out.filter = filter;
  if (typeof v.cutout === 'boolean') out.cutout = v.cutout;
  const zoom = pick('zoom', ['in', 'out'] as const);
  if (zoom) out.zoom = zoom;
  if (typeof v.outline === 'boolean') out.outline = v.outline;
  if (typeof v.glow === 'boolean') out.glow = v.glow;
  return out;
}

/** The JSON schema of the parameters, as the analysis is asked for them. */
export const OP_PARAMS_SCHEMA = {
  type: 'object',
  description:
    'Only what the ask states or clearly means, else leave the field out: text (copy index of the block), colour (a hex from the brand palette), words (the exact words of a block to colour), direction (bigger|smaller), bold, italic, align (left|center|right), corner (top-left|top-right|bottom-left|bottom-right|top-center|bottom-center), photos (photo indexes; leave out for all photos), mask (circle|arch|none), fadeEdge (top|bottom|left|right|none), filter (bw|duotone|tint|none), cutout (true to cut out, false to frame again), zoom (in|out), outline, glow (true to add, false to take off).',
  properties: {
    text: { type: 'integer' },
    colour: { type: 'string' },
    words: { type: 'string' },
    direction: { type: 'string', enum: ['bigger', 'smaller'] },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    corner: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'] },
    photos: { type: 'array', items: { type: 'integer' } },
    mask: { type: 'string', enum: ['circle', 'arch', 'none'] },
    fadeEdge: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'none'] },
    filter: { type: 'string', enum: ['bw', 'duotone', 'tint', 'none'] },
    cutout: { type: 'boolean' },
    zoom: { type: 'string', enum: ['in', 'out'] },
    outline: { type: 'boolean' },
    glow: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;
