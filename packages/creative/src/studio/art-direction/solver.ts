import { applyContentBackground, BackgroundInfeasibleError, type BackgroundPlanningInput } from '../background-planning.js';
import { declaredTextContrast, declaredColorContrast } from '../composite-contrast.js';
import { HERO_SHARP_UPSCALE } from '../layout-v2.js';
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
import { COPY_WIDTH_TOLERANCE_PX, HOUSE_RULES, getSafeZoneBox, isStoryFormat, logoClearZone, minLogoWidth, requiredContrast } from '../house-rules.js';
import { calculateLuminanceContrastRatio, hexToLuminance } from '../composite-contrast.js';
import { hexToRgb } from '../color-science.js';
import { maxStrokeWidth } from '../studio-normalize.js';
import { coverCrop } from '../photo-crop.js';
import { photoUpscale } from '../photo-cutout.js';
import { packPhotoSequence } from './photo-packing.js';
import { ALIGNMENT_POLICY, computeLayoutMetrics } from '../layout-metrics.js';
import { rankPhotosForHero, type QuietArea } from './recipes.js';
import { candidateRecipeTypeScales, type RecipeTypeScale as TypeScale } from './type-scale-search.js';
import { recipePhotoMinimum, type PhotoSelection } from '../photo-selection.js';
import { protectedCropFocus, protectedRegionsOnCanvas, type SourceRegion, type RegionStatus } from '../protected-regions.js';
import { PosterDisplayFaceError, posterDisplayStyle, withPosterDisplayStyle } from '../poster-display.js';
import { GrammarInfeasibleError, composeGrammarLayout, conformMarksToPageGrammar, type PageGrammar } from '../page-grammar.js';

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
  backgroundIntent?: 'documentary' | 'editorial' | 'showcase';
  backgroundMode?: 'solid' | 'gradient';
  backgroundColorIndex?: number | null;
  /** A gold outer frame (series, carousels) or a thin inset line (single report posts). */
  frame?: 'none' | 'outer' | 'inset';
  /** Text alignment: `start` is left for Latin, right for Sorani. */
  align?: 'start' | 'center';
  /**
   * ADR-236: the light page when surfaceTone is cream: the brand's cream (the default) or white
   * (the brand guideline's own pages, or a requester who asks for white).
   */
  paper?: 'cream' | 'white';
}

export interface ArtDirectionChoice {
  recipe: RecipeId;
  conceptNote?: string;
  /** 0..1, how typical the model judged this concept (for divergence; not used by the geometry). */
  typicality?: number;
  heroPhotoIndex: number | null;
  texturePhotoIndex: number | null;
  /** Ordered supporting source indices; bounded and validated by the solver. */
  supportingPhotoIndices?: number[];
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
  /** The tallest face's height as a share of the photo's height, when the detector found a face. */
  faceShare?: number;
  regions?: SourceRegion[];
  regionStatus?: RegionStatus;
  /** The local analysis' centre of detail, used when there is no face. */
  salient?: { x: number; y: number };
  /** Where the photo is calm. */
  quiet?: QuietArea;
  /** Mean luminance (0..1) of the photo's quiet band, when known. */
  quietLuminance?: number;
  /** The cut-out's size when a person cut out of this photo passed its checks. */
  cutoutSize?: { width: number; height: number };
  /** Actual retained PNG pixels; null records that an existing cutout could not be measured. */
  cutoutPixelSize?: { width: number; height: number } | null;
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
  photoSelection?: PhotoSelection;
  palette: string[];
  logoAspect: number;
  logoMinimumWidthPx?: number;
  logoClearSpacePx?: number;
  fonts?: { latinDisplay?: string; latinBody?: string; arabicDisplay?: string; arabicBody?: string };
  fontsDir?: string;
  backgroundPlanning?: BackgroundPlanningInput;
  /**
   * ADR-238: the client's page grammar (its reference's `rules.pageGrammar`). With one, a light
   * concept is set in the grammar's faces and colours with its title bar and foot rule, and
   * fade_to_paper on white is the guideline's own page: the header, the title and its bar, the lead,
   * the photo in a rounded card, the details on cards and the foot rule.
   */
  grammar?: PageGrammar;
  /** ADR-238: the client's logo clear space as a share of the logo's height. */
  logoClearSpaceShare?: number;
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
  // A short line beside the title that the brief calls its subtitle is the title's gold line, not
  // body text (rulebook item 8). In the live trial of 2026-09-30 the layout model set the owner's
  // "Field Visit Report", the report's own name, at body size under "KAAE K-12 Pilot Study".
  if (!slots.some((s) => s.slot === 'accent')) {
    const at = slots.findIndex((s) => s.slot === 'title');
    for (const k of [at + 1, at - 1]) {
      const s = slots[k];
      const role = s ? input.briefRoles?.[s.copyIndex] : undefined;
      if (s?.slot === 'body' && (role === 'subtitle' || role === 'eyebrow') && isHeadlineLine(input.copy.text[s.copyIndex] || '')) {
        s.slot = 'accent';
        break;
      }
    }
  }
  // A call to action is short: longer copy is body text, never cut to fit a pill.
  for (const s of slots) {
    const text = (input.copy.text[s.copyIndex] || '').trim();
    if (s.slot === 'cta' && (text.length > 48 || text.includes('\n'))) s.slot = 'body';
  }
  return slots;
}

/** A line that reads as part of a title: a few words on one line, not a finished sentence. */
function isHeadlineLine(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 48 && !t.includes('\n') && t.split(/\s+/).length <= 7 && !/[.!?؟،]$/.test(t);
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

interface SetBlock {
  block: Block;
  el: TextElement;
  /** Measured height of its lines at its leading. */
  height: number;
  /** Measured width of its widest line. */
  lineWidth: number;
  lines: number;
  /** The measure it was set at: the column, or the narrower body measure. */
  width: number;
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
    case 'hero_storyboard': return ctx.heroStoryboard();
    case 'editorial_split': return ctx.editorialSplit();
    case 'photo_diptych': return ctx.editorialPhotos(true);
    case 'photo_sequence': return ctx.editorialPhotos(false);
    case 'photo_mosaic': return ctx.editorialMosaic();
    case 'hero_card': return ctx.heroCard();
    case 'hero_plate': return ctx.heroPlate();
    case 'scrim_caption': return ctx.scrimCaption();
    case 'sky_title': return ctx.skyTitle();
    case 'cutout_speaker': return ctx.cutoutSpeaker();
    case 'fade_to_paper': return ctx.fadeToPaper();
  }
  throw new RecipeInfeasibleError(recipe, `unknown recipe ${String(recipe)} for ${W}x${H}`);
}

/** Body size of the office's report and caption posts, as a share of the width (example 3: ~3.2-3.4%). */
export const OFFICE_BODY_SHARE = 0.033;
/** Body measure of those posts, as a share of the width (example 3: about two thirds). */
export const OFFICE_BODY_MEASURE = 0.68;
/** How opaque a fade or scrim is where it closes over a photo's lower edge. */
const SEALED_OPACITY = 0.98;

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
  /**
   * Type set as the office sets its report and caption posts (example 3): body about 3.2% of the
   * width at a 1.3 leading, on a measure of about two thirds of the width.
   */
  officeType = false;
  /** The widest a body, meta or footer block is set, when narrower than its column. */
  bodyMaxWidth?: number;

  constructor(readonly input: SolveRecipeInput) {
    this.W = input.width;
    this.H = input.height;
    this.s = Math.min(this.W, this.H);
    this.m = marginFor(this.W, this.H);
    this.wide = this.W / this.H >= 1.3;
    this.story = isStoryFormat(this.W, this.H);
    // A story's safe zone takes its own side share (0.06 of the width), narrower than the margin the
    // layout's grid declares (0.07); its sides are drawn in to the margin, so a logo or a block set on
    // the safe area lines up with the grid the layout declares (and hard QA's alignment reads).
    const zone = getSafeZoneBox(this.W, this.H, this.m);
    const side = Math.max(zone.x, this.m);
    this.safe = { x: side, y: zone.y, width: this.W - 2 * side, height: zone.height };
    this.tones = brandTones(input.palette);
    this.blocks = blocksOf(input);
    this.rtl = this.blocks.filter((b) => b.arabic).length > this.blocks.length / 2;
    this.recipe = input.choice.recipe;
    this.fonts = {
      latinDisplay: input.fonts?.latinDisplay || input.grammar?.title.fontFamily || 'Verdana',
      latinBody: input.fonts?.latinBody || input.grammar?.body.fontFamily || 'Verdana',
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
    let focus: { x: number; y: number } | null;
    try { focus = protectedCropFocus(intBox(box), p, this.focusOf(p)); }
    catch { throw new RecipeInfeasibleError(this.recipe, `photo ${p.photoIndex} has invalid subject regions`); }
    if (!focus) throw new RecipeInfeasibleError(this.recipe, `photo ${p.photoIndex} cannot retain every subject in this crop`);
    const el: PhotoElement = { photoIndex: p.photoIndex, role, ...intBox(box), radius: 0, focus };
    this.photos.push(el);
    return el;
  }

  /**
   * Where the hero's faces land on the canvas, as a box, when the detector found faces: the face
   * point mapped through the same cover crop the renderer draws, grown to the tallest face's height
   * and a margin for hair and chin. Undefined for a photo with no detected face.
   */
  faceBox(el: PhotoElement): Box | undefined {
    const p = this.photo(el.photoIndex);
    if (p?.regions?.length && el.treatment !== 'cutout') {
      const boxes = protectedRegionsOnCanvas(el, p);
      const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
      return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
    }
    if (!p?.focus || !p.faceShare || el.treatment === 'cutout') return undefined;
    const crop = coverCrop(el, p, el.focus ?? p.focus);
    const scale = el.height / crop.sh;
    const cx = el.x + (p.focus.x * p.width - crop.sx) * scale;
    const cy = el.y + (p.focus.y * p.height - crop.sy) * scale;
    const half = 0.75 * p.faceShare * p.height * scale;
    return { x: cx - half, y: cy - half, width: 2 * half, height: 2 * half };
  }

  /**
   * The largest full-width, top-anchored box a hero can fill without its pixels being enlarged more
   * than `maxUpscale`: the whole canvas for a photo big enough, otherwise a band as tall as the
   * photo allows, with the canvas's navy below it (the office's example 7 sets a landscape event
   * photo the same way). A 1280x853 album photo stretched over a 1080x1350 canvas was enlarged 1.6x
   * and looked soft in every live trial of 2026-09-30.
   */
  sharpHeroBox(p: SolverPhoto, maxUpscale = HERO_SHARP_UPSCALE): Box {
    const across = this.W / p.width;
    const height = across <= maxUpscale ? Math.floor(maxUpscale * p.height) : Math.round(across * p.height);
    return { x: 0, y: 0, width: this.W, height: Math.min(this.H, Math.max(1, height)) };
  }

  /**
   * An overlay that covers a photo's lower edge closes over it before the edge, so the edge never
   * shows as a line against the navy below: the overlay reaches at least 0.35 of the canvas above
   * the edge and is 98% opaque from the edge down.
   */
  sealPhotoEdge(overlay: OverlayElement, edgeY: number): void {
    if (edgeY >= this.H) return;
    const top = Math.max(0, Math.min(overlay.y, Math.round(edgeY - 0.35 * this.H)));
    // The overlay as it was, as a function of y; then a ramp that closes over the edge. Each point
    // takes the more opaque of the two, so text the overlay carried stays carried.
    const orig = (y: number) => {
      const t = (y - overlay.y) / overlay.height;
      if (t <= 0) return overlay.stops[0].at <= 0 ? overlay.stops[0].opacity : 0;
      const st = overlay.stops;
      for (let i = 1; i < st.length; i++) {
        if (t <= st[i].at) return st[i - 1].opacity + ((st[i].opacity - st[i - 1].opacity) * (t - st[i - 1].at)) / Math.max(1e-9, st[i].at - st[i - 1].at);
      }
      return st[st.length - 1].opacity;
    };
    const ramp: Array<[number, number]> = [[edgeY - 0.22 * this.H, 0], [edgeY - 0.1 * this.H, 0.6], [edgeY, SEALED_OPACITY]];
    const rampAt = (y: number) => {
      if (y <= ramp[0][0]) return 0;
      if (y >= edgeY) return SEALED_OPACITY;
      for (let i = 1; i < ramp.length; i++) {
        if (y <= ramp[i][0]) return ramp[i - 1][1] + ((ramp[i][1] - ramp[i - 1][1]) * (y - ramp[i - 1][0])) / (ramp[i][0] - ramp[i - 1][0]);
      }
      return SEALED_OPACITY;
    };
    const ys = [...new Set([top, ...overlay.stops.map((st) => overlay.y + st.at * overlay.height), ...ramp.map(([y]) => y), this.H]
      .map((y) => Math.round(Math.min(this.H, Math.max(top, y)))))].sort((a, b) => a - b);
    const height = this.H - top;
    let stops = ys.map((y) => ({ at: round3((y - top) / height), opacity: Math.round(Math.min(SEALED_OPACITY, Math.max(orig(y), rampAt(y))) * 1000) / 1000 }));
    stops = stops.filter((st, i) => i === 0 || st.at > stops[i - 1].at);
    // At most eight stops (the schema's limit): the ones nearest in position merge first.
    while (stops.length > 8) {
      let k = 1;
      for (let i = 2; i < stops.length - 1; i++) if (stops[i].at - stops[i - 1].at < stops[k].at - stops[k - 1].at) k = i;
      stops.splice(k, 1);
    }
    overlay.y = top;
    overlay.height = height;
    overlay.stops = stops;
  }

  /** Main source pixels, including contained cutout portraits, as the renderer places them. */
  heroUpscale(): number | undefined {
    const el = this.photos.find((p) => p.role === 'hero') ?? this.photos.find(p => p.treatment === 'cutout');
    const p = el ? this.photo(el.photoIndex) : undefined;
    if (!el || !p) return undefined;
    const cutout = p.cutoutPixelSize === null ? null : p.cutoutPixelSize
      ? { ...p.cutoutPixelSize, placement: p.cutoutSize } : p.cutoutSize;
    return Math.round(photoUpscale(el, { width: p.width, height: p.height, cutout }) * 100) / 100;
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
    // Keep the official aspect within the 1% the validator allows after rounding (searched up from the
    // starting width, which may already be past the minimum).
    const start = width;
    while (Math.abs(width / height - aspect) / aspect > 0.009 && width < start + 40) {
      width += 1;
      height = Math.round(width / aspect);
    }
    return { width, height };
  }

  logoClear(logo: Box): Box {
    return logoClearZone(logo, this.clientClearPx(logo));
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
    const lineHeight = b.arabic ? (display ? 1.6 : 1.7) : display ? 1.2 : this.officeType ? 1.3 : 1.4;
    // ADR-238: with a page grammar the accent line is the guideline's lead (italic, never bold), not a
    // second bold title line; a call to action stays in the display face.
    const lead = Boolean(this.input.grammar) && b.slot === 'accent' && !b.arabic;
    const el: TextElement = {
      copyIndex: b.copyIndex,
      role: b.role,
      ...intBox(box),
      fontSize,
      lineHeight: Math.min(lh.max, Math.max(lh.min, lineHeight)),
      fontFamily: b.arabic ? (display ? this.fonts.arabicDisplay : this.fonts.arabicBody)
        : lead ? this.input.grammar!.lead.fontFamily : display ? this.fonts.latinDisplay : this.fonts.latinBody,
      color,
      align: align === 'center' ? 'center' : b.arabic ? 'right' : 'left',
      bold: display && !lead,
      ...(lead && this.isLight() && this.input.grammar!.lead.italic ? { italic: true } : {}),
      ...(b.arabic ? { rtl: true, letterSpacing: 0 } : {}),
    };
    // ADR-275: with poster display rules (KAAE: the office's heavy sans capitals), a photo design's title
    // takes the same display face as the client's posters. A Sorani title keeps the body leading here:
    // the recipes do not measure line ink, so the tighter display leading stays with the composer.
    if (b.slot === 'title' && this.input.grammar?.poster?.display) {
      let style;
      try {
        style = posterDisplayStyle(this.input.grammar, b.arabic ? 'arabic' : 'latin', this.input.fontsDir ? { fontsDir: this.input.fontsDir } : {});
      } catch (err) {
        if (err instanceof PosterDisplayFaceError) throw new RecipeInfeasibleError(this.recipe, err.message);
        throw err;
      }
      if (style) return withPosterDisplayStyle(el, b.arabic ? { ...style, lineHeight: Math.max(style.lineHeight, lh.min) } : style, this.W);
    }
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
      const bodyish = b.slot === 'body' || b.slot === 'meta' || b.slot === 'footer';
      const measureW = Math.round(bodyish && this.bodyMaxWidth ? Math.min(width, this.bodyMaxWidth) : width);
      const el = this.element(b, { x: 0, y: 0, width: measureW, height: 10 }, fontSize, color, align);
      const measured = this.measure(el, b.text);
      return { block: b, el, ...measured, width: measureW };
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
    titleLines = 2,
    minFactor = 0.5
  ): SetBlock[][] {
    let scales: TypeScale[];
    try {
      scales = candidateRecipeTypeScales({ naturalTitle: 0.066 * this.s,
        naturalBody: this.officeType && !this.wide ? OFFICE_BODY_SHARE * this.W : 0.026 * this.s,
        minimumBody: Math.ceil(HOUSE_RULES.minBodyShareOfWidth * this.W), minimumFont: HOUSE_RULES.minFontPx,
        titleToBodyMinimum: HOUSE_RULES.titleToBodyMin }, minFactor);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new RecipeInfeasibleError(this.recipe, error.message);
    }
    const measuredSizes = new Set<string>();
    for (const scale of scales) {
      // A title-only change does not warrant remeasuring a group containing only body text.
      const sizes = groups.flatMap(g => g.blocks.map(b => this.sizeOf(b, scale))).join(',');
      if (measuredSizes.has(sizes)) continue;
      measuredSizes.add(sizes);
      const sets = groups.map((g) => this.setGroup(g.blocks, g.width, scale, g.colours, g.align));
      const flat = sets.flat();
      const titleOk = flat.every((b) => (b.block.slot === 'title' || b.block.slot === 'accent' ? b.lines <= titleLines : true));
      const bodyOk = flat.every((b) => (b.block.slot === 'cta' ? b.lines === 1 : b.lines <= 8));
      // No word runs past its column (a long word, a URL), and a call to action fits its pill, which is
      // the column less the pill's padding (placeStack): hard QA's COPY_OVERFLOW refuses either.
      const widthOk = flat.every((b) => b.lineWidth <= (b.block.slot === 'cta' ? b.width - 2 * this.pillPad(b).x : b.width + COPY_WIDTH_TOLERANCE_PX));
      if (titleOk && bodyOk && widthOk && fits(sets)) return sets;
    }
    throw new RecipeInfeasibleError(this.recipe, `the copy does not fit ${this.W}x${this.H} at the house's smallest sizes`);
  }

  /**
   * A title set on one line when it fits at no less than 80% of the natural scale, else on two: a
   * two-word break such as "KAAE K-12 / Pilot Study" (live trial, 2026-09-30) is kept for copy that
   * cannot stand on one line. Two lines are then balanced by balanceWidows.
   */
  fitScalePreferOneLine(
    groups: Array<{ blocks: Block[]; width: number; colours: Palette; align: 'start' | 'center' }>,
    fits: (sets: SetBlock[][]) => boolean
  ): SetBlock[][] {
    try {
      return this.fitScale(groups, fits, 1, 0.8);
    } catch (err) {
      if (!(err instanceof RecipeInfeasibleError)) throw err;
      return this.fitScale(groups, fits, 2);
    }
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
      const bw = Math.min(width, b.width);
      const bx = align === 'center' ? x + (width - bw) / 2 : b.block.arabic || this.rtl ? x + width - bw : x;
      out.push({ ...b.el, ...intBox({ x: bx, y, width: bw, height: b.height + 1 }) });
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

  // ----- ground (ADR-236) --------------------------------------------------------------------------

  /** Whether the concept sits on the brand's light page (the guideline's default) rather than navy. */
  isLight(): boolean {
    return this.input.choice.params?.surfaceTone === 'cream';
  }

  /** The light page: cream, or white where the concept names white. */
  paper(): Hex {
    return this.input.choice.params?.paper === 'white' ? this.tones.white : this.tones.cream;
  }

  /** The ground of a recipe that can sit on navy or on the page, and the text colours it carries. */
  ground(): { background: Hex; colours: Palette } {
    return this.isLight()
      ? { background: this.paper(), colours: this.lightColours() }
      : { background: this.tones.navy, colours: surfacePalette(this.tones, 'navy') };
  }

  /**
   * Text colours on the light page: the grammar's (ADR-238: KAAE Blue titles and lead, Midnight body),
   * or the brand tones' navy set (ADR-236) for a client with no grammar.
   */
  lightColours(): Palette {
    const g = this.input.grammar;
    const base = surfacePalette(this.tones, 'cream');
    return g ? { ...base, title: g.title.color, accent: g.lead.color, body: g.body.color } : base;
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
    // Some photo recipes do not reserve a frame in their geometry. Carry an explicitly
    // selected frame as its own thin overlay, using the existing brand/stroke rules.
    // Missing/none remains unframed; recipes that already drew it keep one frame.
    const frame = this.input.choice.params?.frame;
    if ((frame === 'outer' || frame === 'inset') && !this.shapes.some(s => s.role === 'frame')) this.frame(frame);
    // ADR-180: the logo is set bare. Whether its ground needs a scrim or a thin tab is read from the
    // rendered pixels afterwards (settleLogoGround), not assumed from the geometry: a cream tab on
    // every logo that touched a photo was a box the office does not draw on a calm wall or sky.
    const upscale = this.heroUpscale();
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
        ...(upscale ? { heroUpscale: upscale } : {}),
      },
    };
    if (this.input.backgroundPlanning) {
      try {
        applyContentBackground(layout, this.input.palette, { ...this.input.backgroundPlanning, photos: this.input.photos });
      } catch (error) {
        // Reject only this valid-but-unreadable composition. Invalid policy and unexpected errors
        // still stop the call; solveConcepts records and replaces only recipe infeasibility.
        if (!(error instanceof BackgroundInfeasibleError)) throw error;
        throw new RecipeInfeasibleError(this.recipe, error.message);
      }
    }
    this.applyTitleAccent(layout);
    this.balanceWidows(layout);
    if (this.input.grammar && this.isLight() && !layout.composition) {
      // The solver set its blocks in the grammar's faces already (its measurements depend on them):
      // only the grammar's marks are added.
      conformMarksToPageGrammar(layout, this.input.grammar, { logoClearSpacePx: this.clientClearPx(layout.logo) });
    }
    this.checkLayout(layout);
    return layout;
  }

  /** The client's own logo clear space in pixels for a logo box (ADR-238). */
  clientClearPx(logo: Box): number {
    return Math.max(this.input.logoClearSpacePx ?? 0, (this.input.logoClearSpaceShare ?? 0) * logo.height);
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
    if (declaredColorContrast(layout, title, this.tones.gold) < requiredContrast(title.fontSize, true)) return;
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
    // No title, plate or card over a face the detector found in the hero: on 2026-09-30 a navy plate
    // sat across both visitors' faces in the live trial, and every check passed it.
    for (const photo of layout.photos ?? []) {
      const p = this.photo(photo.photoIndex);
      const fallback = this.faceBox(photo);
      const boxes = p?.regions?.length && photo.treatment !== 'cutout' ? protectedRegionsOnCanvas(photo, p) : fallback ? [fallback] : [];
      for (const face of boxes) {
        const covers = [...layout.text, ...layout.shapes.filter((sh) => sh.role === 'panel' && sh.fill !== 'none' && sh.layer === 'overlay'), layout.logo].find((b) => hit(b, face));
        if (covers) throw new RecipeInfeasibleError(this.recipe, `the copy or its plate would cover the faces in photo ${photo.photoIndex}`);
      }
    }
    for (const t of layout.text) {
      if (!inside(this.safe, t)) throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} leaves the safe area`);
      if (hit(t, clear)) throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} is in the logo's clear space`);
      for (const u of layout.text) if (u !== t && hit(t, u)) throw new RecipeInfeasibleError(this.recipe, `copy blocks ${t.copyIndex} and ${u.copyIndex} overlap`);
      const surface = this.surfaceBehind(layout, t);
      const ratio = declaredTextContrast(layout, t);
      if (ratio < requiredContrast(t.fontSize, Boolean(t.bold))) {
        throw new RecipeInfeasibleError(this.recipe, `copy block ${t.copyIndex} is ${ratio.toFixed(2)}:1 on its surface`);
      }
    }
    // Hard QA's alignment check, as the poster and page composers promise it: a title-only cut-out
    // speaker or story mosaic lined up 0.5, and hard QA always refused it (POOR_GRID_ALIGNMENT).
    const alignment = computeLayoutMetrics(layout).alignmentScore;
    if (alignment < ALIGNMENT_POLICY.passScore) {
      throw new RecipeInfeasibleError(this.recipe, `alignment ${alignment} is under hard QA's ${ALIGNMENT_POLICY.passScore}`);
    }
  }

  // ===============================================================================================
  // Recipes

  /** Ordered validated source roles, completing only explicit coverage obligations. */
  selectedPhotos(minimumForRecipe: number, maximum: number): SolverPhoto[] {
    const hero = this.hero();
    maximum=Math.min(maximum,this.input.photoSelection?.maximum ?? maximum);
    const minimum = Math.max(minimumForRecipe, recipePhotoMinimum(this.input.photoSelection, this.input.photos.length));
    const available = new Map(this.input.photos.filter(p => p.photoIndex !== hero.photoIndex).map(p => [p.photoIndex, p]));
    const requested = this.input.choice.supportingPhotoIndices;
    if (requested && (requested.length > maximum - 1 || requested.some(i => !Number.isInteger(i) || !available.has(i))))
      throw new RecipeInfeasibleError(this.recipe, 'invalid supporting photo indices');
    const ranked = rankPhotosForHero(this.input.photos).filter(p => p.photoIndex !== hero.photoIndex).map(p => p.photoIndex);
    const order = [...new Set(requested ?? ranked.slice(0, Math.max(0, minimumForRecipe - 1)))];
    for (const index of ranked) {
      if (order.length >= minimum - 1) break;
      if (!order.includes(index)) order.push(index);
    }
    const result = [hero, ...order.map(i => available.get(i)!)];
    if (result.length < minimum || result.length > maximum)
      throw new RecipeInfeasibleError(this.recipe, `requires ${minimum} photos within capacity ${maximum}`);
    return result;
  }

  editorialColours(): { background: Hex; colours: Palette } {
    const tone = this.input.choice.params.surfaceTone ?? 'cream';
    return { background: tone === 'cream' ? this.paper() : this.tones.navy,
      colours: tone === 'cream' ? this.lightColours() : surfacePalette(this.tones, tone) };
  }

  /** Copy/photo split: side by side for square/wide, editorial header above photo for portrait. */
  editorialSplit(): StudioLayoutV2 {
    const [hero] = this.selectedPhotos(1, 1);
    if (this.W / this.H < .9) return this.editorialPhotos(false, [hero]);
    return this.editorialMosaic([hero]);
  }

  /** Copy column opposite a justified source-aspect image field; no image under text or logo. */
  editorialMosaic(selected = this.selectedPhotos(2, 10)): StudioLayoutV2 {
    const { background, colours } = this.editorialColours();
    const photoW = Math.round(.56 * this.W), gap = Math.round(.045 * this.s);
    const photoX = this.rtl ? 0 : this.W - photoW;
    const copyX = this.rtl ? photoW + gap : this.safe.x;
    const copyW = Math.floor(this.W - photoW - gap - this.safe.x);
    const logo = { ...this.logoAt('top-start'), x: this.rtl ? copyX + copyW - this.logoSize().width : copyX };
    const top = this.logoClear(logo).y + this.logoClear(logo).height + Math.round(.025 * this.s);
    const availableH = this.safe.y + this.safe.height - top;
    const align = this.align();
    const [set] = this.fitScale([{ blocks: this.blocks, width: copyW, colours, align }], ([g]) => this.stackHeight(g) <= availableH, 3);
    const h = this.stackHeight(set), textTop = Math.round(top + Math.max(0, (availableH - h) * .35));
    const area = { x: photoX, y: 0, width: photoW, height: this.H };
    const boxes = selected.length === 1 ? [{ photoIndex: selected[0].photoIndex, ...area }]
      : packPhotoSequence(selected, area, Math.round(.014 * this.s), this.s, this.rtl);
    if (!boxes) throw new RecipeInfeasibleError(this.recipe, 'no readable subject-safe editorial photo field');
    boxes.forEach((b, i) => this.placeHero(selected[i], b, i === 0 ? 'hero' : 'inset'));
    const text = this.placeStack(set, copyX, copyW, textTop, align, colours);
    return this.finish({ background, text, logo, titleZone: { x: copyX, y: textTop, width: copyW, height: h }, hero: selected[0] });
  }

  /** Header above paired/ordered images; source aspects determine unequal widths and row splits. */
  editorialPhotos(pair: boolean, selected = this.selectedPhotos(2, pair ? 2 : 10)): StudioLayoutV2 {
    const { background, colours } = this.editorialColours();
    const logo = this.logoAt('top-start'), align = this.align();
    const clear = this.logoClear(logo), gap = Math.round(.014 * this.s);
    const copyX = this.wide && !this.rtl ? Math.ceil(clear.x + clear.width + .025 * this.s) : this.safe.x;
    const copyRight = this.wide && this.rtl ? Math.floor(clear.x - .025 * this.s) : this.safe.x + this.safe.width;
    const copyW = copyRight - copyX;
    const top = this.wide ? this.safe.y : clear.y + clear.height + Math.round(.025 * this.s);
    const bottom = this.safe.y + this.safe.height;
    const areaFor = (set: SetBlock[]) => {
      const imageTop = Math.ceil(Math.max(top + this.stackHeight(set), clear.y + clear.height) + .04 * this.s);
      return { x: this.safe.x, y: imageTop, width: this.safe.width, height: bottom - imageTop };
    };
    const boxesFor = (area: Box): Array<Box & { photoIndex: number }> | null => {
      let boxes: Array<Box & { photoIndex: number }> | null;
      if (selected.length === 1) boxes = [{ photoIndex: selected[0].photoIndex, x: 0, y: area.y, width: this.W, height: this.H - area.y }];
      else if (pair) {
        const usableW = area.width - gap, aspects = selected.map(p => p.width / p.height);
        const firstW = Math.round(usableW * aspects[0] / (aspects[0] + aspects[1]));
        boxes = selected.map((p, i) => ({ photoIndex: p.photoIndex,
          x: this.rtl ? (i === 0 ? area.x + area.width - firstW : area.x) : (i === 0 ? area.x : area.x + firstW + gap),
          y: area.y, width: i === 0 ? firstW : usableW - firstW, height: area.height }));
      } else boxes = packPhotoSequence(selected, area, gap, this.s, this.rtl);
      if (!boxes || boxes.some((b, i) => Math.min(b.width, b.height) < Math.round(this.s * (i === 0 ? .22 : .12)))) return null;
      try { if (boxes.some((box, i) => !protectedCropFocus(box, selected[i], this.focusOf(selected[i])))) return null; } catch { return null; }
      return boxes;
    };
    // Joint local fit: largest measured type whose header leaves readable, subject-safe photos.
    const [set] = this.fitScale([{ blocks: this.blocks, width: copyW, colours, align }], ([g]) => Boolean(boxesFor(areaFor(g))), 3);
    const h = this.stackHeight(set), boxes = boxesFor(areaFor(set))!;
    boxes.forEach((b, i) => this.placeHero(selected[i], b, i === 0 ? 'hero' : 'inset'));
    const text = this.placeStack(set, copyX, copyW, top, align, colours);
    return this.finish({ background, text, logo, titleZone: { x: copyX, y: top, width: copyW, height: h }, hero: selected[0] });
  }

  heroStoryboard(): StudioLayoutV2 {
    const [hero, ...supporting] = this.selectedPhotos(2, 10);
    const colours = this.input.choice.params.surfaceTone === 'cream' ? this.lightColours() : surfacePalette(this.tones, 'navy');
    const background = this.input.choice.params.surfaceTone === 'cream' ? this.tones.cream : this.tones.navy;
    const align = this.align();
    const bottom = this.safe.y + this.safe.height;
    const [set] = this.fitScale([{ blocks: this.blocks, width: this.safe.width, colours, align }],
      ([g]) => this.stackHeight(g) <= (this.wide ? 0.34 : 0.32) * this.H, 3);
    const h = this.stackHeight(set);
    const textTop = bottom - h;
    const gap = Math.max(8, Math.round(0.014 * this.s));
    const bandH = Math.floor(textTop - 2 * gap);
    const heroW = Math.round((this.input.choice.params.frame === 'outer' ? 0.58 : 0.62) * this.W);
    this.placeHero(hero, { x: 0, y: 0, width: heroW, height: bandH });
    const supportX = heroW + gap;
    const supportW = this.W - supportX;
    const columns = supporting.length > 6 ? 3 : supporting.length > 3 ? 2 : 1;
    const rows = Math.ceil(supporting.length / columns);
    const cellH = (bandH - (rows - 1) * gap) / rows;
    for (let row = 0, at = 0; row < rows; row++) {
      const inRow = Math.min(columns, supporting.length - at);
      const cellW = (supportW - (inRow - 1) * gap) / inRow;
      if (Math.min(cellW, cellH) < Math.round(0.12 * this.s))
        throw new RecipeInfeasibleError(this.recipe, 'supporting photos would be too small; use a larger format or fewer photos with permission');
      for (let col = 0; col < inRow; col++, at++) this.placeHero(supporting[at],
        { x: supportX + col * (cellW + gap), y: row * (cellH + gap), width: cellW, height: cellH }, 'inset');
    }
    const text = this.placeStack(set, this.safe.x, this.safe.width, textTop, align, colours);
    // ADR-180: no box behind the logo. A navy square the size of its whole clear space was drawn here
    // whatever lay under it (owner, 2026-09-30: "current design has logo background"); the logo's
    // ground is now measured on the pixels (settleLogoGround) and lifted only where it is busy.
    const logo = this.logoAt('top-start');
    return this.finish({ background, text, logo, titleZone: { x: this.safe.x, y: textTop, width: this.safe.width, height: h }, hero });
  }

  heroFadeReport(): StudioLayoutV2 {
    const hero = this.hero();
    const texture = this.texture(hero);
    const align = this.align();
    const inner = this.frame(this.input.choice.params?.frame === 'outer' ? 'outer' : this.input.choice.params?.frame === 'none' ? 'none' : 'inset');
    // ADR-236: the fade closes to the page (paper) on a light concept, to navy on a dark one.
    const { background, colours } = this.ground();
    const logo = this.logoAt('top-start');
    const all = this.blocks;
    const fadeShare = clamp(this.input.choice.params?.fadeShare ?? 0.46, 0.35, 0.55);

    if (this.wide) {
      // The start side is the text column; the fade runs from it across the photo.
      const colW = Math.round(0.46 * this.W);
      const colX = this.rtl ? this.W - this.m - colW : this.m;
      const top = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.03 * this.H);
      const bottom = this.safe.y + this.safe.height;
      const [set] = this.fitScalePreferOneLine([{ blocks: all, width: colW, colours, align }], ([g]) => this.stackHeight(g) <= bottom - top);
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
        kind: 'gradient', purpose: 'fade', color: background, direction: this.rtl ? 'to-right' : 'to-left',
        x: this.rtl ? this.W - fadeW : 0, y: 0, width: fadeW, height: this.H,
        stops: [{ at: 0, opacity: 0 }, { at: 0.3, opacity: 0.8 }, { at: 0.55, opacity: 0.93 }, { at: 1, opacity: 0.97 }],
      });
      return this.finish({ background, text, logo, titleZone: { x: colX, y, width: colW, height: h }, hero, texture });
    }

    // Portrait and square: the text column is the safe area's width, anchored to its bottom; the
    // type is set as example 3 sets it.
    const colX = Math.max(this.safe.x, inner + Math.round(0.035 * this.s));
    const colW = this.W - 2 * colX;
    const bottom = this.safe.y + this.safe.height;
    const maxText = Math.round(0.62 * (fadeShare + 0.08) * this.H);
    this.officeType = true;
    this.bodyMaxWidth = Math.round(OFFICE_BODY_MEASURE * this.W);
    // The fade must start below a fifth of the canvas and leave the logo two logo-heights of photo.
    const maxByFade = Math.min(maxText, bottom - Math.ceil((1 - 0.8 * 0.66) * this.H), bottom - (logo.y + 2 * logo.height));
    const [set] = this.fitScalePreferOneLine([{ blocks: all, width: colW, colours, align }], ([g]) => this.stackHeight(g) <= maxByFade);
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
    const fade: OverlayElement = {
      kind: 'gradient', purpose: 'fade', color: background, direction: 'to-bottom',
      x: 0, y: fadeTop, width: this.W, height: fadeH,
      stops: texture
        ? [{ at: 0, opacity: 0 }, { at: 0.24, opacity: 0.6 }, { at: 0.46, opacity: 0.8 }, { at: 0.72, opacity: 0.92 }, { at: 1, opacity: 0.96 }]
        : [{ at: 0, opacity: 0 }, { at: 0.26, opacity: 0.72 }, { at: 0.42, opacity: 0.88 }, { at: 0.7, opacity: 0.95 }, { at: 1, opacity: 0.97 }],
    };
    // Without a texture below it, a hero that stops above the canvas's foot must not show its edge
    // as a line in the fade (run 7 of the live trials, 2026-09-30).
    if (!texture) this.sealPhotoEdge(fade, heroBottom);
    this.overlays.push(fade);
    return this.finish({ background, text, logo, titleZone: { x: colX, y: textTop, width: colW, height: h }, hero, texture });
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
    const [set] = this.fitScalePreferOneLine(
      [{ blocks: this.blocks, width: colW, colours, align }],
      ([g]) => padTop + this.stackHeight(g) + padBottom <= maxCard
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
    // ADR-236: the office's carousel post is already the light one (a cream card on the photo); its
    // ground, under the frame, is the page's paper on a light concept.
    return this.finish({ background: this.isLight() ? this.paper() : this.tones.navy, text, logo, titleZone: { x: cardX, y: cardY, width: cardW, height: cardH }, hero });
  }

  /**
   * Reference example 8. The hero fills the canvas; the title sits on a navy plate with a soft
   * shadow in the upper third, under the logo; the other lines sit on a scrim at the bottom.
   */
  heroPlate(): StudioLayoutV2 {
    const hero = this.hero();
    // The plate goes where the photo is quiet (its top or bottom third, by the brief's reading or
    // else the local measurement), never on what the photo shows: in the live trial of 2026-09-30 it
    // sat across two visitors' faces, then, moved below them, across their bodies. A hero with no
    // quiet top or bottom cannot carry a plate, and the concept goes to another recipe.
    const quiet = hero.quiet === 'top' || hero.quiet === 'bottom' ? hero.quiet : undefined;
    if (!quiet) throw new RecipeInfeasibleError(this.recipe, 'the hero has no quiet top or bottom for the title plate');
    // People stand on the floor: a quiet bottom in a photo with faces is where their bodies are.
    if (quiet === 'bottom' && hero.faceShare) throw new RecipeInfeasibleError(this.recipe, 'the quiet bottom of the hero is where its people stand');
    const heroBox = this.wide ? this.canvas() : this.sharpHeroBox(hero);
    this.placeHero(hero, heroBox);
    this.frame(this.input.choice.params?.frame === 'inset' ? 'inset' : 'none');
    const logo = this.logoAt('top-center');
    const navy = surfacePalette(this.tones, 'navy');
    // ADR-236: the plate is always navy (the guideline's plates and bands); the lines below it sit
    // on the page's paper on a light concept, on a navy scrim on a dark one.
    const { background, colours: restColours } = this.ground();
    let head = this.pick(['title', 'accent']);
    let rest = this.pick(['body', 'cta', 'meta', 'footer']);
    if (!SolveContext.ordered(head, rest)) {
      head = this.blocks;
      rest = [];
    }
    // As wide as the safe area allows, so a title that can stand on one line does.
    const plateColW = this.wide ? Math.round(0.6 * this.W) : this.safe.width;
    const padX = Math.round(0.045 * this.s);
    const padY = Math.round(0.035 * this.s);
    const bottom = this.safe.y + this.safe.height;
    const restW = this.safe.width;
    const underLogo = logo.y + logo.height + Math.round(0.5 * logo.height) + Math.round(0.025 * this.s);
    const heroBottom = heroBox.y + heroBox.height;
    const zone = quiet === 'top'
      ? { top: underLogo, bottom: heroBox.y + Math.round((this.wide ? 0.62 : 0.45) * heroBox.height) }
      : { top: Math.max(underLogo, heroBox.y + Math.round(0.55 * heroBox.height)), bottom: heroBottom - Math.round(0.02 * this.s) };
    const restMax = Math.round(0.3 * this.H);
    const sets = this.fitScalePreferOneLine(
      [
        { blocks: head, width: plateColW - 2 * padX, colours: navy, align: 'center' },
        ...(rest.length ? [{ blocks: rest, width: restW, colours: restColours, align: 'center' as const }] : []),
      ],
      ([h, r]) => this.stackHeight(h) + 2 * padY <= zone.bottom - zone.top && (!r || this.stackHeight(r) <= restMax)
    );
    const headSet = sets[0];
    const hh = this.stackHeight(headSet);
    const widest = Math.max(...headSet.map((b) => b.lineWidth));
    const plateW = Math.min(plateColW, widest + 2 * padX + 8);
    const plateX = Math.round((this.W - plateW) / 2);
    const plateH = hh + 2 * padY;
    const rTop = sets[1] ? bottom - this.stackHeight(sets[1]) : bottom;
    const plateTop = quiet === 'top' ? zone.top : Math.min(zone.bottom, rTop - Math.round(0.03 * this.s)) - plateH;
    if (plateTop < zone.top) throw new RecipeInfeasibleError(this.recipe, 'the quiet region is too small for the title plate');
    this.shapes.push({
      kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: this.tones.deep === this.tones.navy ? this.tones.navy : this.tones.deep,
      x: plateX, y: plateTop, width: plateW, height: plateH, radius: Math.round(0.012 * this.s),
      shadow: { color: this.tones.navy, opacity: 0.45, blur: Math.round(0.022 * this.s), offsetY: Math.round(0.01 * this.s) },
    });
    // The plate's own colour decides the text colours: the second navy still carries white and gold.
    const text = this.placeStack(headSet, plateX + padX, plateW - 2 * padX, plateTop + padY, 'center', navy);
    let scrim: OverlayElement | undefined;
    if (sets[1]) {
      text.push(...this.placeStack(sets[1], this.safe.x, restW, rTop, 'center', restColours));
      const scrimH = Math.round(Math.min(this.H * 0.55, (this.H - rTop) / 0.6));
      scrim = {
        kind: 'gradient', purpose: 'scrim', color: background, direction: 'to-bottom', x: 0, y: this.H - scrimH, width: this.W, height: scrimH,
        stops: [{ at: 0, opacity: 0 }, { at: 0.38, opacity: 0.8 }, { at: 1, opacity: 0.94 }],
      };
    } else if (heroBottom < this.H) {
      scrim = { kind: 'gradient', purpose: 'scrim', color: background, direction: 'to-bottom', x: 0, y: heroBottom, width: this.W, height: this.H - heroBottom,
        stops: [{ at: 0, opacity: 0.97 }, { at: 1, opacity: 0.97 }] };
    }
    if (scrim) {
      this.sealPhotoEdge(scrim, heroBottom);
      this.overlays.push(scrim);
    }
    return this.finish({ background, text, logo, titleZone: { x: plateX, y: plateTop, width: plateW, height: plateH }, hero });
  }

  /**
   * Reference example 7. The group photo untouched and full-bleed; a navy scrim rises from the
   * bottom; the caption sits on it with a short gold rule under the title.
   */
  scrimCaption(): StudioLayoutV2 {
    const hero = this.hero();
    // A landscape photo on a tall canvas keeps its sharpness: a band as tall as it can fill at 1.3x,
    // navy below, the scrim closing over its lower edge (example 7 sets its event photo this way).
    const heroBox = this.wide ? this.canvas() : this.sharpHeroBox(hero);
    this.placeHero(hero, heroBox);
    this.officeType = !this.wide;
    this.bodyMaxWidth = this.wide ? undefined : Math.round(OFFICE_BODY_MEASURE * this.W);
    const inner = this.frame(this.input.choice.params?.frame === 'inset' ? 'inset' : 'none');
    // ADR-236: the caption sits on the page's paper rising over the photo, or on a navy scrim.
    const { background, colours } = this.ground();
    const align = this.align();
    const logo = this.logoAt('top-start');
    const colX = Math.max(this.safe.x, inner + Math.round(0.035 * this.s));
    const colW = this.wide ? Math.round(0.7 * this.W) : this.W - 2 * colX;
    const x = this.wide && this.rtl ? this.W - colX - colW : colX;
    const bottom = this.safe.y + this.safe.height;
    const ruleGap = Math.round(0.05 * this.s);
    const [set] = this.fitScalePreferOneLine([{ blocks: this.blocks, width: colW, colours, align }], ([g]) => this.stackHeight(g) + ruleGap <= (this.wide ? 0.6 : 0.4) * this.H);
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
    // Deep enough that the headline sits where the scrim is already ~80% navy, however tall the copy.
    const scrimH = Math.round(Math.min(this.H, (this.H - top) / 0.62));
    const scrim: OverlayElement = {
      kind: 'gradient', purpose: 'scrim', color: background, direction: 'to-bottom', x: 0, y: this.H - scrimH, width: this.W, height: scrimH,
      stops: [{ at: 0, opacity: 0 }, { at: 0.36, opacity: 0.8 }, { at: 1, opacity: 0.95 }],
    };
    this.sealPhotoEdge(scrim, heroBox.y + heroBox.height);
    this.overlays.push(scrim);
    return this.finish({ background, text, logo, titleZone: { x, y: top, width: colW, height: h }, hero });
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
    const [set] = this.fitScalePreferOneLine([{ blocks: this.blocks, width: colW, colours, align: 'center' }], ([g]) => this.stackHeight(g) <= (this.wide ? 0.56 : 0.36) * this.H);
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
    if (!person?.cutoutSize || person.cutoutPixelSize === null ||
        ![person.cutoutSize.width, person.cutoutSize.height,
          ...(person.cutoutPixelSize ? [person.cutoutPixelSize.width, person.cutoutPixelSize.height] : [])]
          .every(n => Number.isFinite(n) && n > 0))
      throw new RecipeInfeasibleError(this.recipe, 'no usable person cut out of a photo');
    // Preserve the subject evidence guard and the client's requested light/dark ground.
    const { background, colours } = this.ground();
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
    return this.finish({ background, text, logo, titleZone: { x: colX, y: top, width: colW, height: h }, cutout: person, art });
  }

  /**
   * ADR-238: the client guideline's own page with its one photo (KAAE 2025, pp.1-15): the header
   * (logo, label, rule and gold segment), the serif title and its bar, the italic lead, the photo in a
   * rounded card with a soft shadow, the details on cards, and the gradient rule at the foot. Composed
   * by the page grammar; recorded as fade_to_paper on white, the recipe it replaces.
   */
  grammarPage(hero: SolverPhoto): StudioLayoutV2 {
    const roles: Record<number, string> = {};
    for (const b of this.blocks) {
      const asked = this.input.briefRoles?.[b.copyIndex];
      roles[b.copyIndex] = b.slot === 'title' ? 'title' : b.slot === 'accent' ? (asked === 'eyebrow' ? 'eyebrow' : 'subtitle') : b.slot === 'cta' ? 'cta'
        : b.slot === 'footer' ? 'footer' : b.slot === 'meta' ? b.role : (this.input.briefRoles?.[b.copyIndex] === 'eyebrow' ? 'eyebrow' : 'body');
    }
    let layout: StudioLayoutV2;
    try {
      layout = composeGrammarLayout({
        width: this.W,
        height: this.H,
        grammar: this.input.grammar!,
        copy: this.input.copy,
        roles,
        logoAspect: this.input.logoAspect,
        logoMinimumWidthPx: this.input.logoMinimumWidthPx,
        logoClearSpacePx: this.input.logoClearSpacePx,
        logoClearSpaceShare: this.input.logoClearSpaceShare,
        tone: 'page',
        variant: 'brand_card',
        photo: { photoIndex: hero.photoIndex, width: hero.width, height: hero.height, focus: this.focusOf(hero) },
        fonts: { arabicDisplay: this.fonts.arabicDisplay, arabicBody: this.fonts.arabicBody },
        fontsDir: this.input.fontsDir,
      });
    } catch (err) {
      if (err instanceof GrammarInfeasibleError) throw new RecipeInfeasibleError(this.recipe, err.message);
      throw err;
    }
    for (const p of layout.photos ?? []) this.photos.push(p);
    const used = new Set(this.photos.map((p) => p.photoIndex));
    const title = layout.text.find((t) => t.role === 'title')!;
    const upscale = this.heroUpscale();
    layout.artDirection = {
      recipe: this.recipe,
      conceptNote: (this.input.choice.conceptNote || 'The guideline page: header, serif title and gold bar, italic lead, the photo in a rounded card, details on cards, gradient foot rule.').slice(0, 400),
      titleZone: intBox(title),
      heroPhotoIndex: hero.photoIndex,
      omittedPhotos: this.input.photos.map((p) => p.photoIndex).filter((i) => !used.has(i)).sort((a, b) => a - b),
      rtl: this.rtl,
      ...(upscale ? { heroUpscale: upscale } : {}),
    };
    this.checkLayout(layout);
    return layout;
  }

  /**
   * Reference example 6. Cream paper; the photo rises from the bottom and fades into the paper; the
   * title sits on a navy plate under the logo and the other lines in navy on the paper.
   *
   * ADR-236: on white paper (the brand guideline's own pages) the plate becomes the guideline's
   * header: a navy band across the top of the page holding the logo and the title.
   *
   * ADR-238 diverted a light concept on white to the guideline's document page (`grammarPage`).
   * ADR-274: not for a client whose grammar carries poster rules: the photo fades into the white
   * page under the band, as on the office's Call for Peer Evaluators post.
   */
  fadeToPaper(): StudioLayoutV2 {
    const hero = this.hero();
    if (this.input.grammar && !this.input.grammar.poster && this.isLight() && this.input.choice.params?.paper !== 'cream' && !this.wide) return this.grammarPage(hero);
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
    const sets = this.fitScalePreferOneLine(
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
    const band = this.input.choice.params?.paper === 'white' && !this.wide;
    const plateW = band ? colW : Math.min(colW, widest + 2 * padX + 8);
    const plateX = band ? x : this.rtl ? x + colW - plateW : x;
    this.shapes.push(band
      ? { kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: this.tones.navy, x: 0, y: 0, width: this.W, height: top + hh + 2 * padY }
      : { kind: 'rect', role: 'panel', layer: 'overlay', surface: 'plate', color: this.tones.navy, x: plateX, y: top, width: plateW, height: hh + 2 * padY });
    // In the band the title lines up with the logo, at the page's margin.
    const text = band
      ? this.placeStack(sets[0], this.rtl ? x + 2 * padX : x, colW - 2 * padX, top + padY, 'start', navy)
      : this.placeStack(sets[0], plateX + padX, plateW - 2 * padX, top + padY, 'start', navy);
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
    return this.finish({ background: this.paper(), text, logo, titleZone: { x: plateX, y: top, width: plateW, height: hh + 2 * padY }, hero });
  }
}

export { GrammarInfeasibleError };

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
