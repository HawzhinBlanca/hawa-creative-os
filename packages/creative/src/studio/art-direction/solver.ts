import type {
  Box,
  Hex,
  OverlayElement,
  PhotoElement,
  RecipeId,
  ShapeElement,
  StudioLayoutV2,
  TextElement,
} from '../layout-v2.js';
import { balancedBoxWidths, measureTextGeometry } from '../render-layout-v2.js';
import { HOUSE_RULES, getSafeZoneBox, isStoryFormat, logoClearZone, minLogoWidth, requiredContrast } from '../house-rules.js';
import { calculateLuminanceContrastRatio, hexToLuminance } from '../composite-contrast.js';
import { hexToRgb } from '../color-science.js';
import { maxStrokeWidth } from '../studio-normalize.js';
import type { QuietArea } from './recipes.js';

/**
 * ADR-170: the recipe solver. It turns the layout model's art-direction choice (a recipe, which
 * photo is the hero and which a texture, which copy block goes where, a few bounded parameters)
 * into a complete StudioLayoutV2 with the geometry a designer would give it, deterministically:
 * the same choice, copy, photos and canvas always give the same layout.
 *
 * Every size is measured, not guessed: each block is set in its admitted face and wrapped by the
 * renderer's own measurement, the title and body sizes are the largest that fit the text zone at the
 * house leading, and the fade, plate or card is then sized around the text it carries. The layout
 * the solver returns already satisfies the house rules the validator checks (safe area, logo clear
 * space, the type ladder, copy order, declared contrast), so preparation leaves it as it is.
 *
 * Photos are never flipped for right-to-left copy (rulebook item 9): text blocks change sides and
 * alignment, the photos and their crops stay where they are.
 */

export const TEXT_SLOTS = ['title', 'accent', 'body', 'cta', 'meta', 'footer'] as const;
/**
 * Where a copy block goes in a recipe. `title` is the bold main line; `accent` the gold line of a
 * two-colour title (above or below the title, by copy order); `body` the small light text; `cta` a
 * call to action set in a pill (a URL, "Register now"); `meta` a date, time or place; `footer` a
 * small closing line.
 */
export type TextSlot = (typeof TEXT_SLOTS)[number];

export interface ArtDirectionParams {
  /** Share of the canvas the fade covers, 0.35..0.55 (hero_fade_report). */
  fadeShare?: number;
  /** The tone of the surface text sits on where the recipe lets it vary. */
  surfaceTone?: 'navy' | 'cream';
  /** A gold outer frame (series, carousels) or a thin inset line (single report posts). */
  frame?: 'none' | 'outer' | 'inset';
  /** Text alignment: `start` is left for Latin, right for Sorani. */
  align?: 'start' | 'center';
}

export interface ArtDirectionChoice {
  recipe: RecipeId;
  conceptNote?: string;
  /** 0..1, how typical the model judged this concept (for divergence; not used by the geometry). */
  typicality?: number;
  heroPhotoIndex: number | null;
  texturePhotoIndex: number | null;
  cutoutPhotoIndex: number | null;
  slots: Array<{ copyIndex: number; slot: TextSlot }>;
  /** Words of a single title block to set in gold, exactly as they appear in the copy. */
  titleAccentWords?: string | null;
  params: ArtDirectionParams;
}

export interface SolverPhoto {
  photoIndex: number;
  /** The photo's own pixel size. */
  width: number;
  height: number;
  /** The detector's face focus (share of width and height). */
  focus?: { x: number; y: number };
  /** The local analysis' centre of detail, used when there is no face. */
  salient?: { x: number; y: number };
  /** Where the photo is calm. */
  quiet?: QuietArea;
  /** Mean luminance (0..1) of the photo's quiet band, when known. */
  quietLuminance?: number;
  /** The cut-out's size when a person cut out of this photo passed its checks. */
  cutoutSize?: { width: number; height: number };
}

export interface SolveRecipeInput {
  width: number;
  height: number;
  choice: ArtDirectionChoice;
  copy: { text: Record<number, string>; scripts?: Record<number, 'latin' | 'arabic'> };
  /** The brief's role per copy block, used where the choice leaves a block without a slot. */
  briefRoles?: Record<number, string>;
  /** Every content photo of the request, by photoIndex. */
  photos: SolverPhoto[];
  palette: string[];
  logoAspect: number;
  logoMinimumWidthPx?: number;
  logoClearSpacePx?: number;
  fonts?: { latinDisplay?: string; latinBody?: string; arabicDisplay?: string; arabicBody?: string };
  fontsDir?: string;
}

/** A choice this canvas and copy cannot carry: the candidate is dropped, never forced into shape. */
export class RecipeInfeasibleError extends Error {
  readonly code = 'RECIPE_INFEASIBLE';
  constructor(recipe: RecipeId, reason: string) {
    super(`RECIPE_INFEASIBLE: ${recipe}: ${reason}`);
    this.name = 'RecipeInfeasibleError';
  }
}

// ---------------------------------------------------------------------------------------------
// Brand tones

export interface BrandTones {
  /** Darkest blue-leaning colour: fades, scrims, plates. */
  navy: Hex;
  /** A second, lighter navy for plates on navy and accents on cream. */
  deep: Hex;
  /** The warm accent: the gold line, rules, pills, frames. */
  gold: Hex;
  /** The warm light: cards and paper. */
  cream: Hex;
  /** The lightest: the main title line on navy. */
  white: Hex;
}

function hue([r, g, b]: [number, number, number]): { h: number; s: number } {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const R = r / 255, G = g / 255, B = b / 255;
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max };
}

/** The brand's tones read off its palette: every colour the solver uses is one of the palette's own. */
export function brandTones(palette: string[]): BrandTones {
  if (!palette.length) throw new Error('brandTones: the client names no palette');
  const colours = [...new Set(palette.map((c) => c.toUpperCase()))];
  const lum = (c: string) => hexToLuminance(c);
  const byLum = [...colours].sort((a, b) => lum(a) - lum(b));
  const bluish = (c: string) => {
    const [r, g, b] = hexToRgb(c);
    return b > r && b >= g;
  };
  const darkBlues = byLum.filter((c) => bluish(c) && lum(c) < 0.12);
  const navy = darkBlues[0] ?? byLum[0];
  const deep = darkBlues[1] ?? navy;
  const warm = colours
    .map((c) => ({ c, ...hue(hexToRgb(c)) }))
    .filter((x) => x.s > 0.45 && x.h >= 20 && x.h <= 70 && lum(x.c) > 0.2)
    .sort((a, b) => b.s - a.s);
  const gold = warm[0]?.c ?? colours.map((c) => ({ c, ...hue(hexToRgb(c)) })).sort((a, b) => b.s - a.s)[0].c;
  const light = byLum.filter((c) => lum(c) > 0.7);
  const white = light[light.length - 1] ?? byLum[byLum.length - 1];
  const cream = light.find((c) => c !== white && hue(hexToRgb(c)).s > 0.01) ?? white;
  return { navy, deep, gold, cream, white };
}

const contrast = (a: Hex, b: Hex) => calculateLuminanceContrastRatio(hexToLuminance(a), hexToLuminance(b));

// ---------------------------------------------------------------------------------------------
// Text blocks

interface Block {
  copyIndex: number;
  slot: TextSlot;
  role: TextElement['role'];
  text: string;
  arabic: boolean;
}

/** The slot a block the choice left out takes, from the brief's role. */
function slotFromRole(role: string | undefined): TextSlot {
  switch (role) {
    case 'title': return 'title';
    case 'eyebrow': case 'subtitle': return 'accent';
    case 'cta': return 'cta';
    case 'date': case 'venue': return 'meta';
    case 'footer': return 'footer';
    default: return 'body';
  }
}

/** One slot per copy block, in copy order; exactly one title, and an accent only beside it. */
export function normalizeSlots(input: Pick<SolveRecipeInput, 'choice' | 'copy' | 'briefRoles'>): Array<{ copyIndex: number; slot: TextSlot }> {
  const indices = Object.keys(input.copy.text).map(Number).sort((a, b) => a - b);
  const given = new Map<number, TextSlot>();
  for (const s of input.choice.slots || []) {
    if (indices.includes(s.copyIndex) && (TEXT_SLOTS as readonly string[]).includes(s.slot) && !given.has(s.copyIndex)) given.set(s.copyIndex, s.slot);
  }
  const slots = indices.map((i) => ({ copyIndex: i, slot: given.get(i) ?? slotFromRole(input.briefRoles?.[i]) }));
  // Exactly one title: the first the model named, else the brief's, else the first block.
  const titles = slots.filter((s) => s.slot === 'title');
  if (titles.length === 0) {
    const briefTitle = indices.find((i) => input.briefRoles?.[i] === 'title');
    const at = slots.find((s) => s.copyIndex === (briefTitle ?? indices[0]))!;
    at.slot = 'title';
  }
  for (const extra of slots.filter((s) => s.slot === 'title').slice(1)) extra.slot = 'accent';
  // An accent line is half of a two-colour title: it must sit next to the title in the copy.
  const titleAt = slots.findIndex((s) => s.slot === 'title');
  slots.forEach((s, k) => {
    if (s.slot === 'accent' && Math.abs(k - titleAt) !== 1) s.slot = 'body';
  });
  // At most one accent line.
  let accentSeen = false;
  for (const s of slots) {
    if (s.slot !== 'accent') continue;
    if (accentSeen) s.slot = 'body';
    accentSeen = true;
  }
  // A call to action is short: longer copy is body text, never cut to fit a pill.
  for (const s of slots) {
    const text = (input.copy.text[s.copyIndex] || '').trim();
    if (s.slot === 'cta' && (text.length > 48 || text.includes('\n'))) s.slot = 'body';
  }
  return slots;
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

function blocksOf(input: SolveRecipeInput): Block[] {
  return normalizeSlots(input).map(({ copyIndex, slot }) => {
    const text = input.copy.text[copyIndex] ?? '';
    const arabic = (input.copy.scripts?.[copyIndex] ?? (ARABIC.test(text) ? 'arabic' : 'latin')) === 'arabic';
    const role: TextElement['role'] =
      slot === 'title' ? 'title' : slot === 'accent' ? 'subtitle' : slot === 'cta' ? 'cta' : slot === 'footer' ? 'footer'
        : slot === 'meta' ? (input.briefRoles?.[copyIndex] === 'venue' ? 'venue' : 'date') : 'body';
    return { copyIndex, slot, role, text, arabic };
  });
}

interface TypeScale {
  title: number;
  accent: number;
  body: number;
  footer: number;
}

interface SetBlock {
  block: Block;
  el: TextElement;
  /** Measured height of its lines at its leading. */
  height: number;
  /** Measured width of its widest line. */
  lineWidth: number;
  lines: number;
}

interface Palette {
  title: Hex;
  accent: Hex;
  body: Hex;
  /** Pill fill and the text on it. */
  pill: Hex;
  pillText: Hex;
}

/** Text colours on a surface: navy (fade, scrim, plate) or cream (card, paper). */
function surfacePalette(tones: BrandTones, surface: 'navy' | 'cream'): Palette {
  if (surface === 'navy') {
    return { title: tones.white, accent: tones.gold, body: tones.cream, pill: tones.gold, pillText: tones.navy };
  }
  // Gold on cream reads at under 2:1, so on a card the accent line is the brand's second navy.
  return { title: tones.navy, accent: tones.deep, body: tones.navy, pill: tones.gold, pillText: tones.navy };
}

// ---------------------------------------------------------------------------------------------
// The solver

export function solveRecipe(input: SolveRecipeInput): StudioLayoutV2 {
  const { width: W, height: H } = input;
  const recipe = input.choice.recipe;
  if (recipe === 'typographic') throw new RecipeInfeasibleError(recipe, 'the typographic archetypes are drawn by the layout model, not the solver');
  const ctx = new SolveContext(input);
  switch (recipe) {
    case 'hero_fade_report': return ctx.heroFadeReport();
    case 'hero_card': return ctx.heroCard();
    case 'hero_plate': return ctx.heroPlate();
    case 'scrim_caption': return ctx.scrimCaption();
    case 'sky_title': return ctx.skyTitle();
    case 'cutout_speaker': return ctx.cutoutSpeaker();
    case 'fade_to_paper': return ctx.fadeToPaper();
  }
  throw new RecipeInfeasibleError(recipe, `unknown recipe ${String(recipe)} for ${W}x${H}`);
}

/** Margin: 7% of the short edge, never under the house's 6%. */
function marginFor(W: number, H: number): number {
  const s = Math.min(W, H);
  return Math.max(Math.ceil(HOUSE_RULES.safeMarginShare * s), Math.round(0.07 * s));
}

class SolveContext {
  readonly W: number;
  readonly H: number;
  readonly s: number;
  readonly m: number;
  readonly wide: boolean;
  readonly story: boolean;
  readonly safe: Box;
  readonly tones: BrandTones;
  readonly blocks: Block[];
  readonly rtl: boolean;
  readonly recipe: RecipeId;
  readonly shapes: ShapeElement[] = [];
  readonly overlays: OverlayElement[] = [];
  readonly photos: PhotoElement[] = [];
  readonly fonts: Required<NonNullable<SolveRecipeInput['fonts']>>;

  constructor(readonly input: SolveRecipeInput) {
    this.W = input.width;
    this.H = input.height;
    this.s = Math.min(this.W, this.H);
    this.m = marginFor(this.W, this.H);
    this.wide = this.W / this.H >= 1.3;
    this.story = isStoryFormat(this.W, this.H);
    this.safe = getSafeZoneBox(this.W, this.H, this.m);
    this.tones = brandTones(input.palette);
    this.blocks = blocksOf(input);
    this.rtl = this.blocks.filter((b) => b.arabic).length > this.blocks.length / 2;
    this.recipe = input.choice.recipe;
    this.fonts = {
      latinDisplay: input.fonts?.latinDisplay || 'Verdana',
      latinBody: input.fonts?.latinBody || 'Verdana',
      arabicDisplay: input.fonts?.arabicDisplay || 'Noto Sans Arabic',
      arabicBody: input.fonts?.arabicBody || 'Noto Sans Arabic',
    };
  }

  // ----- photos --------------------------------------------------------------------------------

  photo(index: number | null | undefined): SolverPhoto | undefined {
    if (index === null || index === undefined) return undefined;
    return this.input.photos.find((p) => p.photoIndex === index);
  }

  hero(): SolverPhoto {
    const hero = this.photo(this.input.choice.heroPhotoIndex) ?? this.input.photos[0];
    if (!hero) throw new RecipeInfeasibleError(this.recipe, 'no photo to be the hero');
    return hero;
  }

  texture(hero: SolverPhoto): SolverPhoto | undefined {
    const t = this.photo(this.input.choice.texturePhotoIndex);
    return t && t.photoIndex !== hero.photoIndex ? t : undefined;
  }

  /** The point of a photo its crop keeps in view: the faces, else its detail, else a little above centre. */
  focusOf(p: SolverPhoto): { x: number; y: number } {
    const f = p.focus ?? p.salient ?? { x: 0.5, y: 0.45 };
    return { x: round3(f.x), y: round3(f.y) };
  }

  placeHero(p: SolverPhoto, box: Box, role: PhotoElement['role'] = 'hero'): PhotoElement {
    const el: PhotoElement = { photoIndex: p.photoIndex, role, ...intBox(box), radius: 0, focus: this.focusOf(p) };
    this.photos.push(el);
    return el;
  }

  /**
   * How much a photo is enlarged to cover a box: over about 2 it looks soft, so a recipe that would
   * fill the whole canvas with a small landscape photo gives it the part of the canvas it can cover.
   */
  static upscale(p: SolverPhoto, box: { width: number; height: number }): number {
    return Math.max(box.width / p.width, box.height / p.height);
  }

  // ----- logo ------------------------------------------------------------------------------------

  logoSize(): { width: number; height: number } {
    const aspect = this.input.logoAspect > 0 ? this.input.logoAspect : 1;
    const minW = Math.max(minLogoWidth(this.W), this.input.logoMinimumWidthPx ?? 0);
    let width = Math.max(minW, Math.round(0.1 * Math.min(this.W, 1.25 * this.H)));
    let height = Math.round(width / aspect);
    // Keep the official aspect within the 1% the validator allows after rounding.
    while (Math.abs(width / height - aspect) / aspect > 0.009 && width < minW + 40) {
      width += 1;
      height = Math.round(width / aspect);
    }
    return { width, height };
  }

  logoClear(logo: Box): Box {
    return logoClearZone(logo, this.input.logoClearSpacePx);
  }

  /** The logo in a top corner of the safe area: the start corner, or the given one. */
  logoAt(corner: 'top-start' | 'top-end' | 'top-center' | 'bottom-center' | 'bottom-end'): Box {
    const { width, height } = this.logoSize();
    const left = this.safe.x;
    const right = this.safe.x + this.safe.width - width;
    const startX = this.rtl ? right : left;
    const endX = this.rtl ? left : right;
    const x = corner === 'top-start' ? startX : corner === 'top-end' || corner === 'bottom-end' ? endX : Math.round((this.W - width) / 2);
    const y = corner.startsWith('bottom') ? this.safe.y + this.safe.height - height : this.safe.y;
    return { x, y, width, height };
  }

  // ----- type ------------------------------------------------------------------------------------

  /** The type scale at a factor of the canvas's natural sizes; the title at least 2.2x the body. */
  typeScale(factor: number): TypeScale {
    const minBody = Math.ceil(HOUSE_RULES.minBodyShareOfWidth * this.W);
    const body = Math.max(minBody, Math.round(0.026 * this.s * Math.min(1, factor + 0.12)));
    const title = Math.max(Math.ceil(HOUSE_RULES.titleToBodyMin * body), Math.round(0.066 * this.s * factor));
    return { title, accent: Math.round(title * 0.92), body, footer: Math.max(HOUSE_RULES.minFontPx, Math.min(body, Math.round(body * 0.82))) };
  }

  sizeOf(b: Block, scale: TypeScale): number {
    switch (b.slot) {
      case 'title': return scale.title;
      case 'accent': return scale.accent;
      case 'footer': return scale.footer;
      default: return scale.body;
    }
  }

  element(b: Block, box: Box, fontSize: number, color: Hex, align: 'start' | 'center'): TextElement {
    const display = b.slot === 'title' || b.slot === 'accent' || b.slot === 'cta';
    const rangeKey = b.arabic ? 'arabic' : 'latin';
    const lh = HOUSE_RULES.lineHeight[rangeKey];
    const lineHeight = b.arabic ? (display ? 1.6 : 1.7) : display ? 1.2 : 1.4;
    const el: TextElement = {
      copyIndex: b.copyIndex,
      role: b.role,
      ...intBox(box),
      fontSize,
      lineHeight: Math.min(lh.max, Math.max(lh.min, lineHeight)),
      fontFamily: b.arabic ? (display ? this.fonts.arabicDisplay : this.fonts.arabicBody) : display ? this.fonts.latinDisplay : this.fonts.latinBody,
      color,
      align: align === 'center' ? 'center' : b.arabic ? 'right' : 'left',
      bold: display,
      ...(b.arabic ? { rtl: true, letterSpacing: 0 } : {}),
    };
    return el;
  }

  measure(el: TextElement, text: string): { height: number; lineWidth: number; lines: number } {
    const [m] = measureTextGeometry({ text: [el] } as StudioLayoutV2, { [el.copyIndex]: text }, this.input.fontsDir ? { fontsDir: this.input.fontsDir } : {});
    if (!m || m.status !== 'measured') {
      throw new RecipeInfeasibleError(this.recipe, `copy block ${el.copyIndex} cannot be measured (${m && m.status === 'unmeasured' ? m.reason : 'no measurement'})`);
    }
    return { height: m.requiredHeightPx, lineWidth: m.maxLineWidthPx, lines: m.lineCount };
  }

  /**
   * Sets a group of blocks in a column `width` wide at a type scale: each block measured at its size
   * and wrapped to the column. Returns the blocks with their heights; the caller stacks them.
   */
  setGroup(blocks: Block[], width: number, scale: TypeScale, colours: Palette, align: 'start' | 'center'): SetBlock[] {
    return blocks.map((b) => {
      const fontSize = this.sizeOf(b, scale);
      const color = b.slot === 'title' ? colours.title : b.slot === 'accent' ? colours.accent : b.slot === 'cta' ? colours.pillText : colours.body;
      const el = this.element(b, { x: 0, y: 0, width: Math.round(width), height: 10 }, fontSize, color, align);
      const measured = this.measure(el, b.text);
      return { block: b, el, ...measured };
    });
  }

  /** The gap above a block, by what it follows. */
  gapBefore(prev: SetBlock, next: SetBlock): number {
    const t = (x: SetBlock) => x.block.slot;
    if ((t(prev) === 'title' && t(next) === 'accent') || (t(prev) === 'accent' && t(next) === 'title')) return Math.round(0.16 * prev.el.fontSize);
    if (t(next) === 'cta') return Math.round(1.6 * next.el.fontSize);
    if (t(prev) === 'title' || t(prev) === 'accent') return Math.round(0.55 * prev.el.fontSize);
    return Math.round(0.7 * next.el.fontSize);
  }

  /** Extra room a pill needs above and below its line. */
  pillPad(b: SetBlock): { x: number; y: number } {
    return { x: Math.round(0.9 * b.el.fontSize), y: Math.round(0.42 * b.el.fontSize) };
  }

  /** The height of a stacked group, with the pills' padding. */
  stackHeight(set: SetBlock[]): number {
    let h = 0;
    set.forEach((b, i) => {
      if (i > 0) h += this.gapBefore(set[i - 1], b);
      // Each block's box is its lines plus one pixel of slack (placeStack); a pill adds its padding.
      h += b.height + (b.block.slot === 'cta' ? 2 * this.pillPad(b).y : 1);
    });
    return h;
  }

  /**
   * Finds the largest type scale at which the groups fit their boxes (title at most `titleLines`
   * lines). `fits` receives the set groups and says whether they fit.
   */
  fitScale(
    groups: Array<{ blocks: Block[]; width: number; colours: Palette; align: 'start' | 'center' }>,
    fits: (sets: SetBlock[][]) => boolean,
    titleLines = 2
  ): SetBlock[][] {
    for (let factor = 1; factor >= 0.5; factor -= 0.04) {
      const scale = this.typeScale(factor);
      const sets = groups.map((g) => this.setGroup(g.blocks, g.width, scale, g.colours, g.align));
      const flat = sets.flat();
      const titleOk = flat.every((b) => (b.block.slot === 'title' || b.block.slot === 'accent' ? b.lines <= titleLines : true));
      const bodyOk = flat.every((b) => (b.block.slot === 'cta' ? b.lines === 1 : b.lines <= 8));
      if (titleOk && bodyOk && fits(sets)) return sets;
    }
    throw new RecipeInfeasibleError(this.recipe, `the copy does not fit ${this.W}x${this.H} at the house's smallest sizes`);
  }

  /**
   * Places a stacked group in a column: `x`..`x + width`, from `top` down. Each block's box is its
   * measured lines, one pixel of slack, the column's width; a pill hugs its text.
   */
  placeStack(set: SetBlock[], x: number, width: number, top: number, align: 'start' | 'center', colours: Palette): TextElement[] {
    const out: TextElement[] = [];
    let y = top;
    set.forEach((b, i) => {
      if (i > 0) y += this.gapBefore(set[i - 1], b);
      if (b.block.slot === 'cta') {
        const pad = this.pillPad(b);
        const textW = Math.min(width - 2 * pad.x, b.lineWidth + 6);
        const pillW = textW + 2 * pad.x;
        const pillH = b.height + 2 * pad.y;
        // A pill takes the design's start side: right in a Sorani design, even for a Latin URL.
        const start = b.block.arabic || this.rtl ? x + width - pillW : x;
        const pillX = align === 'center' ? x + (width - pillW) / 2 : start;
        this.shapes.push({
          kind: 'roundRect', role: 'panel', layer: 'overlay', surface: 'pill',
          ...intBox({ x: pillX, y, width: pillW, height: pillH }), radius: Math.round(pillH / 2), color: colours.pill,
        });
        out.push({ ...b.el, ...intBox({ x: pillX + pad.x, y: y + pad.y, width: textW, height: b.height + 1 }), align: 'center' });
        y += pillH;
        return;
      }
      out.push({ ...b.el, ...intBox({ x, y, width, height: b.height + 1 }) });
      y += b.height + 1;
    });
    return out;
  }

  /** The blocks of the given slots, in copy order. */
  pick(slots: TextSlot[]): Block[] {
    return this.blocks.filter((b) => slots.includes(b.slot));
  }

  /** The copy index order holds when every block of `upper` comes before every block of `lower`. */
  static ordered(upper: Block[], lower: Block[]): boolean {
    return !upper.length || !lower.length || Math.max(...upper.map((b) => b.copyIndex)) < Math.min(...lower.map((b) => b.copyIndex));
  }

  align(): 'start' | 'center' {
    return this.input.choice.params?.align === 'center' ? 'center' : 'start';
  }

  // ----- frames ----------------------------------------------------------------------------------

  /** A gold frame: `outer` a border at the canvas edge, `inset` a thin line inside it. Returns its inner inset. */
  frame(kind: 'outer' | 'inset' | 'none'): number {
    if (kind === 'none') return 0;
    if (kind === 'outer') {
      const stroke = maxStrokeWidth('frame', this.W, this.H);
      this.shapes.push({
        kind: 'rect', role: 'frame', layer: 'overlay', fill: 'none', color: this.tones.gold, strokeColor: this.tones.gold, strokeWidth: stroke,
        x: Math.round(stroke / 2), y: Math.round(stroke / 2), width: this.W - 2 * Math.round(stroke / 2), height: this.H - 2 * Math.round(stroke / 2),
      });
      return stroke;
    }
    const inset = Math.round(0.032 * this.s);
    const stroke = Math.max(2, Math.round(0.0028 * this.s));
    this.shapes.push({
      kind: 'rect', role: 'frame', layer: 'overlay', fill: 'none', color: this.tones.gold, strokeColor: this.tones.gold, strokeWidth: stroke,
      x: inset, y: inset, width: this.W - 2 * inset, height: this.H - 2 * inset,
    });
    return inset + stroke;
  }

  // ----- finishing -------------------------------------------------------------------------------

  finish(parts: {
    background: Hex;
    text: TextElement[];
    logo: Box;
    titleZone: Box;
    hero?: SolverPhoto;
    texture?: SolverPhoto;
    cutout?: SolverPhoto;
    art?: StudioLayoutV2['art'];
  }): StudioLayoutV2 {
    const used = new Set(this.photos.map((p) => p.photoIndex));
    const layout: StudioLayoutV2 = {
      version: 2,
      width: this.W,
      height: this.H,
      grid: { margin: this.m, columns: 12, gutter: Math.round(0.02 * this.s), baseline: 8 },
      background: { color: parts.background },
      shapes: this.shapes,
      text: [...parts.text].sort((a, b) => a.copyIndex - b.copyIndex),
      logo: intBox(parts.logo),
      photos: this.photos,
      ...(this.overlays.length ? { overlays: this.overlays } : {}),
      ...(parts.art ? { art: parts.art } : {}),
      artDirection: {
        recipe: this.recipe,
        ...(this.input.choice.conceptNote ? { conceptNote: this.input.choice.conceptNote.slice(0, 400) } : {}),
        titleZone: intBox(parts.titleZone),
        ...(parts.hero ? { heroPhotoIndex: parts.hero.photoIndex } : {}),
        ...(parts.texture ? { texturePhotoIndex: parts.texture.photoIndex } : {}),
        ...(parts.cutout ? { cutoutPhotoIndex: parts.cutout.photoIndex } : {}),
        omittedPhotos: this.input.photos.map((p) => p.photoIndex).filter((i) => !used.has(i)).sort((a, b) => a - b),
        rtl: this.rtl,
      },
    };
    this.applyTitleAccent(layout);
    this.balanceWidows(layout);
    this.checkLayout(layout);
    return layout;
  }

  /**
   * A block that would end on one stranded word gets the narrower box `balancedBoxWidths` finds, at
   * the same line count, anchored on its alignment: what the pipeline's balanceLineBreaks does for
   * the typographic path, done here because preparation leaves a solved recipe alone.
   */
  balanceWidows(layout: StudioLayoutV2): void {
    const text = Object.fromEntries(this.blocks.map((b) => [b.copyIndex, b.text]));
    const widths = balancedBoxWidths(layout, text, this.input.fontsDir ? { fontsDir: this.input.fontsDir } : {});
    for (const t of layout.text) {
      const w = widths[t.copyIndex];
      if (!w || w >= t.width || t.role === 'cta') continue;
      const shift = t.align === 'right' ? t.width - w : t.align === 'center' ? Math.round((t.width - w) / 2) : 0;
      t.x += shift;
      t.width = w;
    }
  }

  /** Gold words inside a single title block ("MEET KAAE AT" of "MEET KAAE AT THE FORUM"), Latin only. */
  applyTitleAccent(layout: StudioLayoutV2): void {
    const words = (this.input.choice.titleAccentWords || '').trim();
    if (!words || this.blocks.some((b) => b.slot === 'accent')) return;
    const title = layout.text.find((t) => t.role === 'title');
    const block = this.blocks.find((b) => b.slot === 'title');
    if (!title || !block || block.arabic) return;
    // Whole words of the copy, exactly: never copy the model wrote itself.
    const copyWords = block.text.split(/\s+/).filter(Boolean);
    const want = words.split(/\s+/).filter(Boolean);
    const found = copyWords.some((_, a) => want.every((w, k) => copyWords[a + k] === w));
    if (!found || want.length >= copyWords.length) return;
    const onNavy = contrast(this.tones.gold, layout.background.color) >= requiredContrast(title.fontSize, true);
    const surface = this.surfaceBehind(layout, title);
    if (!onNavy && surface !== this.tones.navy && surface !== this.tones.deep) return;
    if (contrast(this.tones.gold, surface) < requiredContrast(title.fontSize, true)) return;
    title.accentColor = this.tones.gold;
    title.accentText = want.join(' ');
  }

  surfaceBehind(layout: StudioLayoutV2, t: Box): Hex {
    for (let i = layout.shapes.length - 1; i >= 0; i--) {
      const s = layout.shapes[i];
      if (s.fill === 'none' || s.role !== 'panel') continue;
      if (t.x >= s.x - 1 && t.y >= s.y - 1 && t.x + t.width <= s.x + s.width + 1 && t.y + t.height <= s.y + s.height + 1) return s.color;
    }
    for (const o of layout.overlays ?? []) {
      if (t.x >= o.x && t.y >= o.y && t.x + t.width <= o.x + o.width && t.y + t.height <= o.y + o.height) return o.color;
    }
    return layout.background.color;
  }

  /**
   * What the solver promises the validator: every block inside the safe area, clear of the logo's
   * clear space and of every other block, and legible against the surface it declares.
   */
  checkLayout(layout: StudioLayoutV2): void {
    const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const inside = (outer: Box, inner: Box) =>
      inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
    const clear = this.logoClear(layout.logo);
    if (!inside(this.safe, layout.logo)) throw new RecipeInfeasibleError(this.recipe, 'the logo leaves the safe area');
    for (const t of layout.text) {
      if (!inside(this.safe, t)) throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} leaves the safe area`);
      if (hit(t, clear)) throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} is in the logo's clear space`);
      for (const u of layout.text) if (u !== t && hit(t, u)) throw new RecipeInfeasibleError(this.recipe, `copy blocks ${t.copyIndex} and ${u.copyIndex} overlap`);
      const surface = this.surfaceBehind(layout, t);
      const ratio = contrast(t.color, surface);
      if (ratio < requiredContrast(t.fontSize, Boolean(t.bold))) {
        throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} is ${ratio.toFixed(2)}:1 on its surface`);
      }
    }
  }

  // ===============================================================================================
  // Recipes

  /**
   * Reference example 3. The hero fills the canvas from the top and runs off three edges; a navy fade
   * rises over its lower part; a second photo, if chosen, is blended into the fade; the title (a
   * white line and a gold line), the body and the call to action sit on the fade, anchored to the
   * bottom margin. On a wide canvas the fade and the text take the start side instead.
   */
  heroFadeReport(): StudioLayoutV2 {
    const hero = this.hero();
    const texture = this.texture(hero);
    const align = this.align();
    const inner = this.frame(this.input.choice.params?.frame === 'outer' ? 'outer' : this.input.choice.params?.frame === 'none' ? 'none' : 'inset');
    const colours = surfacePalette(this.tones, 'navy');
    const logo = this.logoAt('top-start');
    const all = this.blocks;
    const fadeShare = clamp(this.input.choice.params?.fadeShare ?? 0.46, 0.35, 0.55);

    if (this.wide) {
      // The start side is the text column; the fade runs from it across the photo.
      const colW = Math.round(0.46 * this.W);
      const colX = this.rtl ? this.W - this.m - colW : this.m;
      const top = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.03 * this.H);
      const bottom = this.safe.y + this.safe.height;
      const [set] = this.fitScale([{ blocks: all, width: colW, colours, align }], ([g]) => this.stackHeight(g) <= bottom - top);
      const h = this.stackHeight(set);
      const y = Math.round(top + (bottom - top - h) / 2);
      const text = this.placeStack(set, colX, colW, y, align, colours);
      const heroBox = this.rtl ? { x: 0, y: 0, width: Math.round(0.72 * this.W), height: this.H } : { x: Math.round(0.28 * this.W), y: 0, width: Math.round(0.72 * this.W), height: this.H };
      this.placeHero(hero, SolveContext.upscale(hero, this.canvas()) <= 1.6 ? this.canvas() : heroBox);
      const fadeW = Math.round(0.72 * this.W);
      if (texture) {
        const tex = this.placeHero(texture, { x: this.rtl ? this.W - fadeW : 0, y: 0, width: fadeW, height: this.H }, 'texture');
        tex.fade = { edge: this.rtl ? 'left' : 'right', length: 0.55 };
        tex.opacity = 0.85;
      }
      this.overlays.push({
        kind: 'gradient', purpose: 'fade', color: this.tones.navy, direction: this.rtl ? 'to-right' : 'to-left',
        x: this.rtl ? this.W - fadeW : 0, y: 0, width: fadeW, height: this.H,
        stops: [{ at: 0, opacity: 0 }, { at: 0.3, opacity: 0.8 }, { at: 0.55, opacity: 0.93 }, { at: 1, opacity: 0.97 }],
      });
      return this.finish({ background: this.tones.navy, text, logo, titleZone: { x: colX, y, width: colW, height: h }, hero, texture });
    }

    // Portrait and square: the text column is the safe area's width, anchored to its bottom.
    const colX = Math.max(this.safe.x, inner + Math.round(0.035 * this.s));
    const colW = this.W - 2 * colX;
    const bottom = this.safe.y + this.safe.height;
    const maxText = Math.round(0.62 * (fadeShare + 0.08) * this.H);
    const [set] = this.fitScale([{ blocks: all, width: colW, colours, align }], ([g]) => this.stackHeight(g) <= maxText);
    const h = this.stackHeight(set);
    const textTop = bottom - h;
    // The fade starts far enough above the text that the text sits where it is at least ~80% navy.
    const fadeH = Math.round(Math.max(fadeShare * this.H, (this.H - textTop) / 0.66));
    const fadeTop = this.H - fadeH;
    if (textTop < logo.y + logo.height * 2 || fadeTop < 0.2 * this.H) throw new RecipeInfeasibleError(this.recipe, 'the copy is too long for a fade');
    const text = this.placeStack(set, colX, colW, textTop, align, colours);
    // The hero covers the canvas down into the fade; a small landscape photo is not blown up to fill
    // a tall canvas, it stops where the fade has closed over it.
    const full = this.canvas();
    // With a texture the hero stops where the texture takes over, so a landscape hero keeps its whole
    // width (reference example 3 shows the whole room); without one it runs on under the fade.
    const heroBottom = SolveContext.upscale(hero, full) <= 1.25 ? this.H
      : Math.min(this.H, Math.round(fadeTop + (texture ? 0.32 : 0.62) * fadeH));
    this.placeHero(hero, { x: 0, y: 0, width: this.W, height: heroBottom });
    if (texture) {
      const texTop = Math.round(fadeTop - 0.06 * fadeH);
      const tex = this.placeHero(texture, { x: 0, y: texTop, width: this.W, height: this.H - texTop }, 'texture');
      tex.fade = { edge: 'top', length: 0.3 };
      tex.opacity = 0.9;
    }
    this.overlays.push({
      kind: 'gradient', purpose: 'fade', color: this.tones.navy, direction: 'to-bottom',
      x: 0, y: fadeTop, width: this.W, height: fadeH,
      stops: texture
        ? [{ at: 0, opacity: 0 }, { at: 0.24, opacity: 0.6 }, { at: 0.46, opacity: 0.8 }, { at: 0.72, opacity: 0.92 }, { at: 1, opacity: 0.96 }]
        : [{ at: 0, opacity: 0 }, { at: 0.26, opacity: 0.72 }, { at: 0.42, opacity: 0.88 }, { at: 0.7, opacity: 0.95 }, { at: 1, opacity: 0.97 }],
    });
    return this.finish({ background: this.tones.navy, text, logo, titleZone: { x: colX, y: textTop, width: colW, height: h }, hero, texture });
  }

  canvas(): Box {
    return { x: 0, y: 0, width: this.W, height: this.H };
  }

  /**
   * Reference examples 1-2. A gold outer frame; the hero fills the frame; a cream card with a soft
   * shadow holds the title and body in navy; a navy tab holding the logo straddles the card's top.
   */
  heroCard(): StudioLayoutV2 {
    const hero = this.hero();
    const frame = this.frame('outer');
    this.placeHero(hero, { x: frame, y: frame, width: this.W - 2 * frame, height: this.H - 2 * frame });
    const colours = surfacePalette(this.tones, 'cream');
    const align = this.input.choice.params?.align === 'start' ? 'start' : 'center';
    const cardInset = frame + Math.round((this.wide ? 0.03 : 0.045) * this.W);
    const cardW = this.wide ? Math.round(0.46 * this.W) : this.W - 2 * cardInset;
    const cardX = this.wide ? (this.rtl ? this.W - cardInset - cardW : cardInset) : cardInset;
    const padX = Math.round(0.06 * Math.min(cardW, this.s));
    const logoSize = this.logoSize();
    const tabPadY = Math.round(0.22 * logoSize.height);
    const tabPadX = Math.round(0.35 * logoSize.height);
    const tabH = logoSize.height + 2 * tabPadY;
    const clearBelowLogo = Math.max(Math.round(0.5 * logoSize.height), this.input.logoClearSpacePx ?? 0);
    // Text starts below the logo's clear space; the logo is centred on the card's top edge.
    const padTop = Math.round(logoSize.height / 2 + clearBelowLogo + 0.02 * this.s);
    const padBottom = Math.round(0.045 * this.s);
    const cardBottom = Math.min(this.safe.y + this.safe.height + Math.round(0.02 * this.s), this.H - frame - Math.round(0.035 * this.s));
    const colW = cardW - 2 * padX;
    const maxCard = Math.round((this.wide ? 0.8 : 0.4) * this.H);
    const [set] = this.fitScale(
      [{ blocks: this.blocks, width: colW, colours, align }],
      ([g]) => padTop + this.stackHeight(g) + padBottom <= maxCard,
      2
    );
    const h = this.stackHeight(set);
    const cardH = Math.max(Math.round((this.wide ? 0.4 : 0.23) * this.H), padTop + h + padBottom);
    const cardY = cardBottom - cardH;
    this.shapes.push({
      kind: 'rect', role: 'panel', layer: 'overlay', surface: 'card', color: this.tones.cream, x: cardX, y: cardY, width: cardW, height: cardH,
      shadow: { color: this.tones.navy, opacity: 0.35, blur: Math.round(0.02 * this.s), offsetY: Math.round(0.008 * this.s) },
    });
    const textTop = cardY + padTop + Math.round((cardH - padTop - padBottom - h) / 2);
    const text = this.placeStack(set, cardX + padX, colW, textTop, align, colours);
    const tabW = logoSize.width + 2 * tabPadX;
    const tabX = align === 'center' ? Math.round(cardX + (cardW - tabW) / 2) : this.rtl ? cardX + cardW - padX - tabW : cardX + padX;
    const tabY = Math.round(cardY - tabH / 2);
    this.shapes.push({ kind: 'rect', role: 'panel', layer: 'overlay', surface: 'tab', color: this.tones.navy, x: tabX, y: tabY, width: tabW, height: tabH });
    const logo = { x: tabX + tabPadX, y: tabY + tabPadY, width: logoSize.width, height: logoSize.height };
    return this.finish({ background: this.tones.navy, text, logo, titleZone: { x: cardX, y: cardY, width: cardW, height: cardH }, hero });
  }

  /**
   * Reference example 8. The hero fills the canvas; the title sits on a navy plate with a soft
   * shadow in the upper third, under the logo; the other lines sit on a scrim at the bottom.
   */
  heroPlate(): StudioLayoutV2 {
    const hero = this.hero();
    this.placeHero(hero, this.canvas());
    this.frame(this.input.choice.params?.frame === 'inset' ? 'inset' : 'none');
    const logo = this.logoAt('top-center');
    const navy = surfacePalette(this.tones, 'navy');
    let head = this.pick(['title', 'accent']);
    let rest = this.pick(['body', 'cta', 'meta', 'footer']);
    if (!SolveContext.ordered(head, rest)) {
      head = this.blocks;
      rest = [];
    }
    const plateColW = Math.round((this.wide ? 0.6 : 0.78) * this.W);
    const padX = Math.round(0.045 * this.s);
    const padY = Math.round(0.035 * this.s);
    const plateTop = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.025 * this.s);
    const bottom = this.safe.y + this.safe.height;
    const restW = this.safe.width;
    const sets = this.fitScale(
      [
        { blocks: head, width: plateColW - 2 * padX, colours: navy, align: 'center' },
        ...(rest.length ? [{ blocks: rest, width: restW, colours: navy, align: 'center' as const }] : []),
      ],
      ([h, r]) => plateTop + this.stackHeight(h) + 2 * padY <= (this.wide ? 0.62 : 0.5) * this.H && (!r || this.stackHeight(r) <= (this.wide ? 0.3 : 0.3) * this.H)
    );
    const headSet = sets[0];
    const hh = this.stackHeight(headSet);
    const widest = Math.max(...headSet.map((b) => b.lineWidth));
    const plateW = Math.min(plateColW, widest + 2 * padX + 8);
    const plateX = Math.round((this.W - plateW) / 2);
    const plateH = hh + 2 * padY;
    this.shapes.push({
      kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: this.tones.deep === this.tones.navy ? this.tones.navy : this.tones.deep,
      x: plateX, y: plateTop, width: plateW, height: plateH, radius: Math.round(0.012 * this.s),
      shadow: { color: '#000000' === this.tones.navy ? this.tones.navy : this.tones.navy, opacity: 0.45, blur: Math.round(0.022 * this.s), offsetY: Math.round(0.01 * this.s) },
    });
    // The plate's own colour decides the text colours: the second navy still carries white and gold.
    const text = this.placeStack(headSet, plateX + padX, plateW - 2 * padX, plateTop + padY, 'center', navy);
    if (sets[1]) {
      const rh = this.stackHeight(sets[1]);
      const rTop = bottom - rh;
      text.push(...this.placeStack(sets[1], this.safe.x, restW, rTop, 'center', navy));
      const scrimH = Math.round(Math.min(this.H * 0.55, (this.H - rTop) / 0.6));
      this.overlays.push({
        kind: 'gradient', purpose: 'scrim', color: this.tones.navy, direction: 'to-bottom', x: 0, y: this.H - scrimH, width: this.W, height: scrimH,
        stops: [{ at: 0, opacity: 0 }, { at: 0.38, opacity: 0.8 }, { at: 1, opacity: 0.94 }],
      });
    }
    return this.finish({ background: this.tones.navy, text, logo, titleZone: { x: plateX, y: plateTop, width: plateW, height: plateH }, hero });
  }

  /**
   * Reference example 7. The group photo untouched and full-bleed; a navy scrim rises from the
   * bottom; the caption sits on it with a short gold rule under the title.
   */
  scrimCaption(): StudioLayoutV2 {
    const hero = this.hero();
    this.placeHero(hero, this.canvas());
    const inner = this.frame(this.input.choice.params?.frame === 'inset' ? 'inset' : 'none');
    const colours = surfacePalette(this.tones, 'navy');
    const align = this.align();
    const logo = this.logoAt('top-start');
    const colX = Math.max(this.safe.x, inner + Math.round(0.035 * this.s));
    const colW = this.wide ? Math.round(0.7 * this.W) : this.W - 2 * colX;
    const x = this.wide && this.rtl ? this.W - colX - colW : colX;
    const bottom = this.safe.y + this.safe.height;
    const ruleGap = Math.round(0.05 * this.s);
    const [set] = this.fitScale([{ blocks: this.blocks, width: colW, colours, align }], ([g]) => this.stackHeight(g) + ruleGap <= (this.wide ? 0.6 : 0.4) * this.H);
    // The rule sits in its own gap under the headline, centred in it.
    const headEnd = set.reduce((k, b, i) => (b.block.slot === 'title' || b.block.slot === 'accent' ? i : k), 0);
    const h = this.stackHeight(set) + (headEnd < set.length - 1 ? ruleGap : 0);
    const top = bottom - h;
    const upper = this.placeStack(set.slice(0, headEnd + 1), x, colW, top, align, colours);
    const upperBottom = Math.max(...upper.map((t) => t.y + t.height));
    const ruleW = Math.round(0.14 * Math.min(this.W, colW * 1.5));
    const ruleH = Math.max(3, Math.round(0.004 * this.s));
    const lowerSet = set.slice(headEnd + 1);
    let text = upper;
    if (lowerSet.length) {
      const gapAfter = this.gapBefore(set[headEnd], set[headEnd + 1]) + ruleGap;
      const lowerTop = upperBottom + gapAfter;
      text = [...upper, ...this.placeStack(lowerSet, x, colW, lowerTop, align, colours)];
      const ruleY = Math.round(upperBottom + (gapAfter - ruleH) / 2);
      const ruleX = align === 'center' ? Math.round(x + (colW - ruleW) / 2) : this.rtl ? x + colW - ruleW : x;
      this.shapes.push({ kind: 'rect', role: 'rule', layer: 'overlay', color: this.tones.gold, x: ruleX, y: ruleY, width: ruleW, height: ruleH });
    }
    const scrimH = Math.round(Math.min(0.7 * this.H, (this.H - top) / 0.62));
    this.overlays.push({
      kind: 'gradient', purpose: 'scrim', color: this.tones.navy, direction: 'to-bottom', x: 0, y: this.H - scrimH, width: this.W, height: scrimH,
      stops: [{ at: 0, opacity: 0 }, { at: 0.36, opacity: 0.8 }, { at: 1, opacity: 0.95 }],
    });
    return this.finish({ background: this.tones.navy, text, logo, titleZone: { x, y: top, width: colW, height: h }, hero });
  }

  /**
   * Reference example 11. The scenic photo fills the canvas; the title is set in its quiet sky (or
   * floor) on a soft scrim of the tone the sky already has: cream over a bright sky with navy type,
   * navy over a dark one with white type. The logo takes the opposite end.
   */
  skyTitle(): StudioLayoutV2 {
    const hero = this.hero();
    this.placeHero(hero, this.canvas());
    const quiet = hero.quiet === 'bottom' ? 'bottom' : 'top';
    const bright = (hero.quietLuminance ?? 0.7) >= 0.45;
    const tone = this.input.choice.params?.surfaceTone ?? (bright ? 'cream' : 'navy');
    const colours = surfacePalette(this.tones, tone);
    const scrimColour = tone === 'cream' ? this.tones.cream : this.tones.navy;
    const logo = this.logoAt(quiet === 'top' ? 'bottom-center' : 'top-center');
    const colW = this.wide ? Math.round(0.62 * this.W) : this.safe.width;
    const x = Math.round((this.W - colW) / 2);
    const [set] = this.fitScale([{ blocks: this.blocks, width: colW, colours, align: 'center' }], ([g]) => this.stackHeight(g) <= (this.wide ? 0.56 : 0.36) * this.H);
    const h = this.stackHeight(set);
    const top = quiet === 'top' ? this.safe.y + Math.round(0.02 * this.s) : this.safe.y + this.safe.height - h;
    const text = this.placeStack(set, x, colW, top, 'center', colours);
    // The scrim reaches far enough past the text that the text sits where it is at least ~70% opaque.
    const reach = Math.min(this.H, Math.ceil(((quiet === 'top' ? top + h : this.H - top) + 2) / 0.66));
    this.overlays.push({
      kind: 'gradient', purpose: 'scrim', color: scrimColour, direction: quiet === 'top' ? 'to-top' : 'to-bottom',
      x: 0, y: quiet === 'top' ? 0 : this.H - reach, width: this.W, height: reach,
      stops: [{ at: 0, opacity: 0 }, { at: 0.34, opacity: 0.72 }, { at: 1, opacity: 0.86 }],
    });
    return this.finish({ background: tone === 'cream' ? this.tones.cream : this.tones.navy, text, logo, titleZone: { x, y: top, width: colW, height: h }, hero });
  }

  /**
   * Reference examples 4-5. The person cut out of their photo stands at the bottom-left corner,
   * bleeding off the bottom edge, on navy with the sunburst behind them; the text column sits beside
   * them. The same geometry in both languages: the Sorani text is right-aligned in the same column.
   */
  cutoutSpeaker(): StudioLayoutV2 {
    const person = this.photo(this.input.choice.cutoutPhotoIndex) ?? this.input.photos.find((p) => p.cutoutSize);
    if (!person?.cutoutSize) throw new RecipeInfeasibleError(this.recipe, 'no person cut out of a photo');
    const colours = surfacePalette(this.tones, 'navy');
    const colX = this.wide ? Math.round(0.46 * this.W) : Math.round(0.4 * this.W);
    // The person's box ends where the text column starts: the person stands beside the copy, never under it.
    const personW = Math.min(Math.round((this.wide ? 0.4 : 0.56) * this.W), colX - Math.round(0.02 * this.W));
    const personH = Math.round((this.wide ? 0.92 : 0.64) * this.H);
    const box = { x: 0, y: this.H - personH, width: personW, height: personH };
    this.photos.push({ photoIndex: person.photoIndex, role: 'portrait', treatment: 'cutout', ...intBox(box) });
    const logo = this.logoAt('top-start');
    const colW = this.safe.x + this.safe.width - colX;
    const top = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.03 * this.s);
    const limit = (this.wide ? this.safe.y + this.safe.height : Math.min(this.safe.y + this.safe.height, box.y + 0.45 * personH)) - top;
    const [set] = this.fitScale([{ blocks: this.blocks, width: colW, colours, align: 'start' }], ([g]) => this.stackHeight(g) <= limit, 3);
    const text = this.placeStack(set, colX, colW, top, 'start', colours);
    const h = this.stackHeight(set);
    // The rays radiate from behind the person; the text column is outside the art box, so the art is
    // never behind the copy.
    const art: StudioLayoutV2['art'] = {
      source: 'procedural', motif: 'sun-rays', opacity: 0.35,
      box: intBox({ x: 0, y: Math.round(this.H - personH * 1.05), width: Math.min(colX - Math.round(0.01 * this.W), personW), height: Math.round(personH * 1.05) }),
      calmRegion: intBox({ x: 0, y: Math.round(this.H - personH * 1.05), width: Math.min(colX - Math.round(0.01 * this.W), personW), height: Math.round(personH * 1.05) }),
    };
    return this.finish({ background: this.tones.navy, text, logo, titleZone: { x: colX, y: top, width: colW, height: h }, cutout: person, art });
  }

  /**
   * Reference example 6. Cream paper; the photo rises from the bottom and fades into the paper; the
   * title sits on a navy plate under the logo and the other lines in navy on the paper.
   */
  fadeToPaper(): StudioLayoutV2 {
    const hero = this.hero();
    const cream = surfacePalette(this.tones, 'cream');
    const navy = surfacePalette(this.tones, 'navy');
    const logo = this.logoAt('top-start');
    let head = this.pick(['title', 'accent']);
    let rest = this.pick(['body', 'cta', 'meta', 'footer']);
    if (!SolveContext.ordered(head, rest)) {
      head = this.blocks.filter((b) => b.slot === 'title');
      rest = this.blocks.filter((b) => b.slot !== 'title');
      if (!SolveContext.ordered(head, rest)) throw new RecipeInfeasibleError(this.recipe, 'the title does not come first in the copy');
    }
    const padX = Math.round(0.04 * this.s);
    const padY = Math.round(0.03 * this.s);
    // On a wide canvas the photo takes the end half and the paper column stops short of it.
    const colW = this.wide ? Math.round(0.47 * this.W) - this.safe.x : this.safe.width;
    const x = this.rtl ? this.safe.x + this.safe.width - colW : this.safe.x;
    const top = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.02 * this.s);
    const photoTopMin = Math.round((this.wide ? 0 : 0.42) * this.H);
    const sets = this.fitScale(
      [
        { blocks: head, width: colW - 2 * padX, colours: navy, align: 'start' },
        ...(rest.length ? [{ blocks: rest, width: colW, colours: cream, align: 'start' as const }] : []),
      ],
      ([h, r]) => {
        const total = this.stackHeight(h) + 2 * padY + (r ? Math.round(0.03 * this.s) + this.stackHeight(r) : 0);
        return this.wide ? total <= this.safe.height - (top - this.safe.y) : top + total <= Math.round(0.62 * this.H);
      }
    );
    const hh = this.stackHeight(sets[0]);
    const widest = Math.max(...sets[0].map((b) => b.lineWidth));
    const plateW = Math.min(colW, widest + 2 * padX + 8);
    const plateX = this.rtl ? x + colW - plateW : x;
    this.shapes.push({
      kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: this.tones.navy, x: plateX, y: top, width: plateW, height: hh + 2 * padY,
    });
    const text = this.placeStack(sets[0], plateX + padX, plateW - 2 * padX, top + padY, 'start', navy);
    let bottomOfText = top + hh + 2 * padY;
    if (sets[1]) {
      const rTop = bottomOfText + Math.round(0.03 * this.s);
      text.push(...this.placeStack(sets[1], x, colW, rTop, 'start', cream));
      bottomOfText = rTop + this.stackHeight(sets[1]);
    }
    if (this.wide) {
      const photoW = Math.round(0.5 * this.W);
      const ph = this.placeHero(hero, { x: this.rtl ? 0 : this.W - photoW, y: 0, width: photoW, height: this.H });
      ph.fade = { edge: this.rtl ? 'right' : 'left', length: 0.45 };
    } else {
      const photoTop = Math.max(photoTopMin, bottomOfText + Math.round(0.02 * this.s));
      const ph = this.placeHero(hero, { x: 0, y: photoTop, width: this.W, height: this.H - photoTop });
      ph.fade = { edge: 'top', length: 0.45 };
    }
    return this.finish({ background: this.tones.cream, text, logo, titleZone: { x: plateX, y: top, width: plateW, height: hh + 2 * padY }, hero });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

function round3(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
}

/** A box on whole pixels, as the schema requires. */
function intBox(b: Box): Box {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, width: Math.max(1, Math.round(b.x + b.width) - x), height: Math.max(1, Math.round(b.y + b.height) - y) };
}
