import type {
  Box,
  CompositionRecord,
  Hex,
  OrnamentElement,
  PhotoElement,
  ShapeElement,
  ShapeGradient,
  StudioLayoutV2,
  TextElement,
} from './layout-v2.js';
import { HOUSE_RULES, getSafeZoneBox, logoClearZone, minLogoWidth, requiredContrast } from './house-rules.js';
import { balancedBoxWidths, measureTextGeometry } from './render-layout-v2.js';
import { calculateLuminanceContrastRatio, hexToLuminance } from './composite-contrast.js';
import { fillColoursUnder } from './shape-gradient.js';
import { sunburstRadius } from './brand-elements.js';
import { admitPageGrammarFromReference } from './page-grammar-admission.js';

/**
 * ADR-238: a client's page grammar, read from its reference pack (`rules.pageGrammar`), and the
 * layout primitives it is built from.
 *
 * A guideline page is a grammar more than a palette: a header (the logo, a letter-spaced section
 * label and a thin rule with a gold segment), a serif title with a short gradient bar under it, an
 * italic lead, body text, rounded cards, and a gradient rule at the foot; a cover is a gradient
 * ground with a centred logo, title, bar and tracked subtitle. Shared code names no client: every
 * colour, face and proportion here comes from the reference (KAAE: kaae-reference.json, from the 2025
 * Excellence Edition guideline), and a reference with no grammar gets none of this.
 *
 * The primitives are ordinary shapes, tagged with `primitive` and drawn with the shape gradient,
 * shadow and radius the renderer and the Canva deck already carry, so every one stays a native,
 * editable shape in the deck. `composeGrammarLayout` sets a whole design from them, measured with
 * the renderer's own text measurement; `conformToPageGrammar` restyles a layout the model drew.
 */

export interface GradientStop {
  at: number;
  color: Hex;
}

export interface GrammarType {
  fontFamily: string;
  bold?: boolean;
  italic?: boolean;
  color: Hex;
  colorOnDark?: Hex;
  /** Size as a share of the canvas width. */
  sizeShare: number;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface GrammarCard {
  fill: Hex;
  title: Hex;
  text: Hex;
  edge?: Hex;
  edgeShare?: number;
}

/** ADR-262: one poster composition's colours (all from the client's palette). */
export interface PosterVariantSpec {
  /** The ground, where the composition has its own (cream). */
  ground?: Hex;
  title: Hex;
  lead: Hex;
  body: Hex;
  /** The first detail line (a date) where it sits straight on the ground. */
  detail: Hex;
  /** The details card, where the composition sets one of its own (cream). */
  panel?: Hex;
  panelTitle?: Hex;
  panelText?: Hex;
  /** The call to action's pill and its text. */
  pill: Hex;
  pillText: Hex;
  sunburst: { color: Hex; opacity: number };
}

/**
 * ADR-262: how the client's posters are composed (KAAE: from the office's own published posts), as
 * distinct from its guideline's document pages: the title's range as shares of the width, the logo's
 * width, the gold bar's width, the negative-space ceiling, and the three compositions' colours.
 */
export interface PosterGrammar {
  source?: string;
  titleSizeShare: { min: number; max: number };
  logoWidthShare: number;
  titleBarWidthShare: number;
  negativeSpaceMax: number;
  /**
   * The smallest size of the details (the date, the place, the lead) as a share of the width. A post
   * is seen about 390 points wide on a phone, so 0.04 sets them at about 16 points there; the type
   * scale's first step over the body was 0.035, and the details read small under a poster title.
   */
  detailSizeShareMin?: number;
  navy: PosterVariantSpec;
  cream: PosterVariantSpec;
  band: PosterVariantSpec;
}

export interface PageGrammar {
  page: { background: Hex; marginShare: number };
  header: {
    logoWidthShare: number;
    rule: { color: Hex; opacity: number; thicknessShare: number };
    accent: { widthShare: number; thicknessShare: number; stops: GradientStop[] };
    label: GrammarType;
  };
  title: GrammarType;
  titleBar: { widthShare: number; heightShare: number; gapShare: number; stops: GradientStop[] };
  lead: GrammarType;
  body: GrammarType;
  cards: {
    radiusShare: number;
    shadow: { color: Hex; opacity: number; blurShare: number; offsetShare: number };
    plain: GrammarCard;
    brand: GrammarCard;
    tint: GrammarCard;
    dark: GrammarCard;
  };
  stat: { fontFamily: string; bold?: boolean; colorOnDark: Hex; colorOnLight: Hex; labelColor: Hex; labelColorOnDark: Hex };
  footRule: { heightShare: number; stops: GradientStop[] };
  cover: {
    angle: number;
    stops: GradientStop[];
    logoWidthShare: number;
    title: Hex;
    subtitle: { fontFamily: string; color: Hex; letterSpacing: number; sizeShare: number };
    body: Hex;
  };
  elements: {
    sunburst: { color: Hex; opacityOnLight: number; colorOnDark: Hex; opacityOnDark: number; rays: number };
    trianglePattern: { color: Hex; opacityOnLight: number; colorOnDark: Hex; opacityOnDark: number };
  };
  /** ADR-262: the poster compositions; a grammar without them composes pages and covers only. */
  poster?: PosterGrammar;
}

/** The same admission contract Core checks before composition and paid calls. */
export function pageGrammarFromRaw(rawRef: unknown): PageGrammar | undefined {
  return admitPageGrammarFromReference(rawRef);
}

// ---------------------------------------------------------------------------------------------
// Primitives

const r = (v: number) => Math.round(v);

/** The representative colour of a gradient: the stop nearest its middle. */
function middleStop(stops: GradientStop[]): Hex {
  return [...stops].sort((a, b) => Math.abs(a.at - 0.5) - Math.abs(b.at - 0.5))[0].color;
}

export function gradientOf(stops: GradientStop[], angle = 0): ShapeGradient {
  return { angle, stops: stops.map((s) => ({ at: s.at, color: s.color.toUpperCase() })) };
}

/**
 * The guideline header: a thin rule across the content width, and its gold gradient segment under
 * the logo, set on the line just outside the logo's clear space (nothing enters the clear space).
 */
export function headerPrimitives(g: PageGrammar, W: number, contentX: number, contentW: number, ruleY: number, rtl = false): ShapeElement[] {
  const ruleT = Math.max(2, r(g.header.rule.thicknessShare * W));
  const accentT = Math.max(ruleT + 1, r(g.header.accent.thicknessShare * W));
  const accentW = r(g.header.accent.widthShare * W);
  // The guideline keeps its header as is in a Sorani page (p.10): the logo and its gold segment left.
  void rtl;
  return [
    { kind: 'rect', role: 'rule', primitive: 'header_rule', x: contentX, y: ruleY + r((accentT - ruleT) / 2), width: contentW, height: ruleT,
      color: g.header.rule.color, opacity: g.header.rule.opacity },
    { kind: 'roundRect', role: 'rule', primitive: 'header_accent', x: contentX, y: ruleY, width: accentW, height: accentT, radius: r(accentT / 2),
      color: middleStop(g.header.accent.stops), gradient: gradientOf(g.header.accent.stops, 0) },
  ];
}

/** The short gold gradient bar under a title, at the title's start edge (its end edge in Sorani). */
export function titleBarPrimitive(g: PageGrammar, W: number, title: Box, align: 'left' | 'right' | 'center'): ShapeElement {
  const width = r(g.titleBar.widthShare * W);
  const height = Math.max(4, r(g.titleBar.heightShare * W));
  const x = align === 'left' ? title.x : align === 'right' ? title.x + title.width - width : r(title.x + (title.width - width) / 2);
  return {
    kind: 'roundRect', role: 'accent', primitive: 'title_bar', x: r(x), y: r(title.y + title.height + g.titleBar.gapShare * W), width, height,
    radius: r(height / 2), color: middleStop(g.titleBar.stops), gradient: gradientOf(g.titleBar.stops, 0),
  };
}

export type CardKind = 'plain' | 'brand' | 'tint' | 'dark';

/** A rounded card with the grammar's soft shadow; a tint card also gets its gold edge on the start side. */
export function cardPrimitives(g: PageGrammar, W: number, kind: CardKind, box: Box, rtl = false): ShapeElement[] {
  const spec = g.cards[kind];
  const radius = Math.max(4, r(g.cards.radiusShare * W));
  const sh = g.cards.shadow;
  const card: ShapeElement = {
    kind: 'roundRect', role: 'panel', primitive: 'card', surface: 'card', ...intBox(box), radius, color: spec.fill,
    shadow: { color: sh.color, opacity: sh.opacity, blur: Math.min(80, r(sh.blurShare * W)), offsetY: Math.min(80, r(sh.offsetShare * W)) },
  };
  if (!spec.edge) return [card];
  const ew = Math.max(3, r((spec.edgeShare ?? 0.005) * W));
  return [card, {
    kind: 'roundRect', role: 'accent', primitive: 'card_edge', x: rtl ? card.x + card.width - ew : card.x, y: card.y, width: ew, height: card.height,
    radius: r(ew / 2), color: spec.edge,
  }];
}

/** The gradient rule at the foot of a page (KAAE: Blue to Midnight to Gold to Sun, p.7). */
export function footRulePrimitive(g: PageGrammar, W: number, contentX: number, contentW: number, y: number): ShapeElement {
  const height = Math.max(3, r(g.footRule.heightShare * W));
  return { kind: 'roundRect', role: 'rule', primitive: 'foot_rule', x: contentX, y, width: contentW, height, radius: r(height / 2),
    color: middleStop(g.footRule.stops), gradient: gradientOf(g.footRule.stops, 0) };
}

/** A cover's ground: the whole canvas in the grammar's gradient. */
export function coverGroundPrimitive(g: PageGrammar, W: number, H: number): ShapeElement {
  return { kind: 'rect', role: 'panel', primitive: 'cover_ground', x: 0, y: 0, width: W, height: H,
    color: g.cover.stops[g.cover.stops.length - 1].color, gradient: gradientOf(g.cover.stops, g.cover.angle) };
}

// ---------------------------------------------------------------------------------------------
// Composition

export interface ComposeGrammarInput {
  width: number;
  height: number;
  grammar: PageGrammar;
  copy: { text: Record<number, string>; scripts?: Record<number, 'latin' | 'arabic'> };
  /** The brief's role per copy block. */
  roles: Record<number, string | undefined>;
  logoAspect: number;
  logoMinimumWidthPx?: number;
  logoClearSpacePx?: number;
  /** The client's own clear space as a share of the logo's height (KAAE: its K, 0.15). */
  logoClearSpaceShare?: number;
  tone: 'page' | 'cover';
  /** page: `brand_card` (details on a KAAE Blue card) or `cards` (on white cards, side by side for a date and a place); cover: `pattern` (centred, the triangle band) or `sunburst` (start side, the sunburst). */
  variant?: string;
  /** One photo, set in a rounded card under the lead (a page only). */
  photo?: { photoIndex: number; width: number; height: number; focus?: { x: number; y: number } };
  /** A page ground the requester named (a light palette colour, such as cream); the grammar's page otherwise. */
  pageBackground?: Hex;
  fonts?: { arabicDisplay?: string; arabicBody?: string };
  fontsDir?: string;
}

/** A design the grammar cannot carry at the house's smallest sizes. */
export class GrammarInfeasibleError extends Error {
  readonly code = 'GRAMMAR_INFEASIBLE';
  constructor(reason: string) {
    super(`GRAMMAR_INFEASIBLE: ${reason}`);
    this.name = 'GrammarInfeasibleError';
  }
}

type UnitKind = 'label' | 'title' | 'lead' | 'meta' | 'body' | 'cta' | 'footer';
interface Block {
  copyIndex: number;
  text: string;
  arabic: boolean;
  role: TextElement['role'];
}
interface Unit {
  kind: UnitKind;
  blocks: Block[];
}
export type GrammarUnit = Unit;

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

/** The copy in order, grouped into the grammar's units: consecutive dates and places share a card. */
export function grammarUnits(input: Pick<ComposeGrammarInput, 'copy' | 'roles'>): Unit[] {
  const indices = Object.keys(input.copy.text).map(Number).sort((a, b) => a - b);
  const roleOf = (i: number) => (input.roles[i] || '').toLowerCase();
  const titleAt = indices.find((i) => roleOf(i) === 'title') ?? indices[0];
  const units: Unit[] = [];
  for (const i of indices) {
    const text = input.copy.text[i] ?? '';
    const arabic = (input.copy.scripts?.[i] ?? (ARABIC.test(text) ? 'arabic' : 'latin')) === 'arabic';
    const role = roleOf(i);
    let kind: UnitKind;
    let elRole: TextElement['role'];
    if (i === titleAt) [kind, elRole] = ['title', 'title'];
    else if (role === 'eyebrow' && i < titleAt) [kind, elRole] = ['label', 'eyebrow'];
    else if (role === 'subtitle' || role === 'eyebrow') [kind, elRole] = ['lead', 'subtitle'];
    else if (role === 'date' || role === 'venue') [kind, elRole] = ['meta', role as TextElement['role']];
    else if (role === 'cta' && text.length <= 90 && !text.includes('\n')) [kind, elRole] = ['cta', 'cta'];
    else if (role === 'footer') [kind, elRole] = ['footer', 'footer'];
    else [kind, elRole] = ['body', 'body'];
    const block = { copyIndex: i, text, arabic, role: elRole };
    const last = units[units.length - 1];
    if (kind === 'meta' && last?.kind === 'meta') last.blocks.push(block);
    else units.push({ kind, blocks: [block] });
  }
  // Only the first lead after the title is the lead; later subtitles read as body lines.
  let leadSeen = false;
  for (const u of units) {
    if (u.kind !== 'lead') continue;
    if (leadSeen) {
      u.kind = 'body';
      u.blocks.forEach((b) => (b.role = 'body'));
    }
    leadSeen = true;
  }
  return units;
}

function intBox(b: Box): Box {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, width: Math.max(1, Math.round(b.x + b.width) - x), height: Math.max(1, Math.round(b.y + b.height) - y) };
}

const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The composer's type scale: a major third. */
const TYPE_RATIO = 1.25;
/** The smallest title step: 1.25^4 is 2.44 times the body, over the house's 2.2. */
const MIN_TITLE_STEP = 4;

interface Sizes {
  title: number;
  titleStep: number;
  lead: number;
  meta: number;
  body: number;
  footer: number;
  label: number;
}

/**
 * Sets a design from the grammar. Every block is measured in the face it is set in, the type scale is
 * the largest at which the copy fits between the header and the foot rule (the title on at most three
 * lines), and what room is left is shared out between the units. Deterministic: the same copy, canvas
 * and grammar always give the same design.
 */
export function composeGrammarLayout(input: ComposeGrammarInput): StudioLayoutV2 {
  const { width: W, height: H, grammar: g } = input;
  const units = grammarUnits(input);
  if (!units.some((u) => u.kind === 'title')) throw new GrammarInfeasibleError('no title');
  // ADR-262: with poster rules the title is the poster's display moment: the largest step of the
  // scale within the poster's title range that fits, growing to fill its block. Without them, at most
  // the grammar's own sizes.
  // Every poster-sized title at every scale first; then the grammar's own title size (the only pass
  // without poster rules), whose failure at its last scale is reported as before.
  const passes = input.grammar.poster ? [true, false] : [false];
  for (const posterPass of passes) {
    for (let f = 1; f >= 0.55 - 1e-9; f -= 0.05) {
      for (const titleStep of posterPass ? titleSteps(input, f) : [undefined]) {
        const layout = attempt(input, units, f, false, titleStep);
        if (!layout) continue;
        // A poster step that fits but fails the finished checks (a lead the larger title moved onto a
        // lighter part of a gradient) gives way to the next one.
        if (!posterPass) return attempt(input, units, f, true, titleStep)!;
        try {
          return attempt(input, units, f, true, titleStep)!;
        } catch (err) {
          if (!(err instanceof GrammarInfeasibleError)) throw err;
        }
      }
    }
  }
  throw new GrammarInfeasibleError(`the copy does not fit ${W}x${H} at the house's smallest sizes`);
}

/** The body size the page composer sets at scale `f`. */
function pageBodySize(input: ComposeGrammarInput, f: number): number {
  return Math.max(Math.ceil(HOUSE_RULES.minBodyShareOfWidth * input.width), r(input.grammar.body.sizeShare * input.width * f));
}

/**
 * The poster-sized title steps to try, largest first: every step of the scale whose size lies in the
 * poster's title range (at least the smallest step at or over its minimum). When none fits at any
 * scale, the composer falls back to the grammar's own title size, as before ADR-262.
 */
function titleSteps(input: ComposeGrammarInput, f: number): number[] {
  const P = input.grammar.poster;
  // A page with a photo keeps the photo as its focal point (a poster-sized title halved it in the
  // proof renders): its title stays at the grammar's own size.
  if (!P || input.photo) return [];
  const body = pageBodySize(input, f);
  const lo = P.titleSizeShare.min * input.width;
  const hi = P.titleSizeShare.max * input.width;
  const steps: number[] = [];
  for (let n = 10; n >= MIN_TITLE_STEP; n--) {
    const size = body * Math.pow(TYPE_RATIO, n);
    if (size <= hi + 1 && size >= lo - 1) steps.push(n);
  }
  if (!steps.length) {
    let n = MIN_TITLE_STEP;
    while (n < 10 && body * Math.pow(TYPE_RATIO, n) < lo) n++;
    steps.push(n);
  }
  return steps;
}

function attempt(input: ComposeGrammarInput, units: Unit[], f: number, finish: boolean, fixedTitleStep?: number): StudioLayoutV2 | undefined {
  const { width: W, height: H, grammar: g } = input;
  const cover = input.tone === 'cover';
  const s = Math.min(W, H);
  const m = Math.max(Math.ceil(HOUSE_RULES.safeMarginShare * s), Math.round(g.page.marginShare * s));
  const safe = getSafeZoneBox(W, H, m);
  const contentX = safe.x;
  const contentW = safe.width;
  const rtl = units.filter((u) => u.blocks.some((b) => b.arabic)).length > units.length / 2;
  // A cover is centred (p.0); its `sunburst` variant sets the block on the start side with the
  // guideline's sunburst in the far corner (p.13).
  const centred = cover && input.variant !== 'sunburst';
  const align: 'left' | 'right' | 'center' = centred ? 'center' : rtl ? 'right' : 'left';
  const arabicDisplay = input.fonts?.arabicDisplay || 'Noto Sans Arabic';
  const arabicBody = input.fonts?.arabicBody || 'Noto Sans Arabic';

  // One modular scale (a major third) from the body size: the label and footer a step under it, the
  // lead and the details a step over, the title the step nearest the grammar's title size that still
  // leads the body by the house's ratio. The design declares it, so its type scale is measured as set.
  const body = pageBodySize(input, f);
  const step = (n: number) => r(body * Math.pow(TYPE_RATIO, n));
  const lead = step(1);
  const wantTitle = g.title.sizeShare * W * f;
  let titleStep = MIN_TITLE_STEP;
  while (titleStep < 8 && Math.abs(step(titleStep + 1) - wantTitle) < Math.abs(step(titleStep) - wantTitle)) titleStep++;
  if (fixedTitleStep !== undefined) titleStep = fixedTitleStep;
  const sizes: Sizes = {
    title: step(titleStep),
    titleStep,
    lead,
    meta: lead,
    body,
    footer: Math.max(HOUSE_RULES.minFontPx, step(-1)),
    label: Math.max(HOUSE_RULES.minFontPx, step(-1)),
  };
  if (sizes.title <= sizes.lead) return undefined;

  // ----- the logo and the header ----------------------------------------------------------------
  const aspect = input.logoAspect > 0 ? input.logoAspect : 1;
  const minLogo = Math.max(minLogoWidth(W), input.logoMinimumWidthPx ?? 0);
  // ADR-262: with poster rules the header logo is the poster's (KAAE: 0.16 of the width, not the
  // document page's 0.12), so it reads at a thumbnail.
  const headerLogoShare = Math.max(g.header.logoWidthShare, g.poster?.logoWidthShare ?? 0);
  let lw = Math.max(minLogo, r((centred ? g.cover.logoWidthShare : cover ? 1.6 * headerLogoShare : headerLogoShare) * W));
  let lh = r(lw / aspect);
  while (Math.abs(lw / lh - aspect) / aspect > 0.009 && lw < minLogo + 40) {
    lw += 1;
    lh = r(lw / aspect);
  }
  const logo: Box = centred
    ? { x: r((W - lw) / 2), y: safe.y + r(0.03 * H), width: lw, height: lh }
    : { x: cover && rtl ? contentX + contentW - lw : contentX, y: safe.y, width: lw, height: lh };
  const clearPx = Math.max(input.logoClearSpacePx ?? 0, (input.logoClearSpaceShare ?? 0) * lh);
  // A cover keeps the guideline's own clear space (KAAE: the height of the K, p.4) rather than the
  // house's half the logo's height, which set the cover's title far below its logo.
  const clear = logoClearZone(logo, clearPx, { clientOnly: cover });
  const shapes: ShapeElement[] = [];
  const text: TextElement[] = [];
  const ornaments: OrnamentElement[] = [];
  if (cover) shapes.push(coverGroundPrimitive(g, W, H));

  const measure = (el: TextElement, copy: string) => {
    const [mm] = measureTextGeometry({ text: [el] } as StudioLayoutV2, { [el.copyIndex]: copy }, input.fontsDir ? { fontsDir: input.fontsDir } : {});
    if (!mm || mm.status !== 'measured') throw new GrammarInfeasibleError(`copy block ${el.copyIndex} cannot be measured (${mm && mm.status === 'unmeasured' ? mm.reason : 'no measurement'})`);
    return { height: mm.requiredHeightPx + 1, lineWidth: mm.maxLineWidthPx, lines: mm.lineCount };
  };

  const onDark = cover;
  const el = (b: Block, kind: UnitKind | 'cardTitle' | 'cardText' | 'stat', size: number, color: Hex, w: number, alignment = align): TextElement => {
    const display = kind === 'title' || kind === 'cardTitle' || kind === 'stat';
    const spec = kind === 'title' ? g.title : kind === 'lead' ? (cover ? undefined : g.lead) : kind === 'label' ? g.header.label : undefined;
    const lhRange = b.arabic ? HOUSE_RULES.lineHeight.arabic : HOUSE_RULES.lineHeight.latin;
    const wanted = b.arabic ? (display ? 1.6 : 1.7) : kind === 'title' ? (g.title.lineHeight ?? 1.2) : kind === 'lead' ? (g.lead.lineHeight ?? 1.45) : display ? 1.2 : (g.body.lineHeight ?? 1.5);
    const family = b.arabic
      ? (display || kind === 'label' ? arabicDisplay : arabicBody)
      : kind === 'title' ? g.title.fontFamily
        : kind === 'cardTitle' || kind === 'stat' ? g.stat.fontFamily
          : kind === 'lead' && cover ? g.cover.subtitle.fontFamily
            : kind === 'label' ? g.header.label.fontFamily
              : kind === 'lead' ? g.lead.fontFamily : g.body.fontFamily;
    const tracking = b.arabic ? 0
      : kind === 'title' ? (g.title.letterSpacing ?? 0)
        : kind === 'label' ? (g.header.label.letterSpacing ?? 0)
          : kind === 'lead' && cover ? g.cover.subtitle.letterSpacing : 0;
    const italic = !b.arabic && ((kind === 'lead' && !cover && Boolean(g.lead.italic)) || (kind === 'cta' && !cover));
    const bold = display || (kind === 'label' && Boolean(g.header.label.bold)) || (kind === 'cta' && cover);
    void spec;
    return {
      copyIndex: b.copyIndex,
      role: b.role,
      x: 0, y: 0, width: w, height: 10,
      fontSize: size,
      lineHeight: Math.min(lhRange.max, Math.max(lhRange.min, wanted)),
      ...(tracking ? { letterSpacing: Math.max(-HOUSE_RULES.letterSpacingMaxEm, Math.min(HOUSE_RULES.letterSpacingMaxEm, tracking)) } : {}),
      fontFamily: family,
      color,
      align: b.arabic && alignment === 'left' ? 'right' : alignment,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(b.arabic ? { rtl: true, letterSpacing: 0 } : {}),
    };
  };

  // Places a measured block in a column; returns its bottom.
  const place = (t: TextElement, copy: string, x: number, colW: number, y: number): { el: TextElement; bottom: number } => {
    const mm = measure({ ...t, width: colW }, copy);
    const placed = { ...t, ...intBox({ x, y, width: colW, height: mm.height }) };
    return { el: placed, bottom: placed.y + placed.height };
  };

  // The header label (a page whose copy opens with an eyebrow): right of the logo, on the logo's line.
  let ruleY = 0;
  let flowTop: number;
  const unitsToFlow = [...units];
  if (!cover) {
    ruleY = Math.ceil(clear.y + clear.height) + 1;
    const head = headerPrimitives(g, W, contentX, contentW, ruleY, rtl);
    shapes.push(...head);
    flowTop = ruleY + head[1].height + r(0.045 * W);
    const first = unitsToFlow[0];
    if (first?.kind === 'label') {
      const b = first.blocks[0];
      const x0 = Math.ceil(clear.x + clear.width) + 1;
      const colW = contentX + contentW - x0;
      const t = el(b, 'label', sizes.label, g.header.label.color, colW, b.arabic ? 'right' : 'right');
      const mm = measure(t, b.text);
      if (mm.lines === 1 && colW > 0) {
        const y = r(logo.y + logo.height / 2 - mm.height / 2);
        text.push({ ...t, ...intBox({ x: x0, y, width: colW, height: mm.height }) });
        unitsToFlow.shift();
      }
    }
  } else {
    flowTop = Math.ceil(clear.y + clear.height) + r(0.015 * H);
  }

  // ----- the flow -------------------------------------------------------------------------------
  const footH = cover ? 0 : Math.max(3, r(g.footRule.heightShare * W));
  const footY = H - r(0.75 * m) - footH;
  // ADR-262: a cover with the triangle band keeps the band's room when its title grows.
  const bandRoom = cover && fixedTitleStep !== undefined && (input.variant ?? 'pattern') === 'pattern' ? r(0.15 * H) : 0;
  const limit = cover ? safe.y + safe.height - bandRoom : Math.min(safe.y + safe.height, footY - r(0.03 * W));
  const pad = r(0.04 * W);
  const cardGap = r(0.025 * W);
  type Placed = { unit: Unit; top: number; bottom: number; texts: TextElement[]; shapes: ShapeElement[]; photo?: PhotoElement; gapAfter: number };
  const placed: Placed[] = [];
  let y = flowTop;
  let photoPlaced = false;
  let titleSeen = false;
  const variant = input.variant ?? (cover ? 'pattern' : 'brand_card');
  const titleColour = onDark ? g.cover.title : g.title.color;

  for (let k = 0; k < unitsToFlow.length; k++) {
    const u = unitsToFlow[k];
    const top = y;
    const texts: TextElement[] = [];
    const unitShapes: ShapeElement[] = [];
    let photo: PhotoElement | undefined;
    let gapAfter = r(0.03 * W);
    if (u.kind === 'title') {
      const b = u.blocks[0];
      let t = el(b, 'title', sizes.title, titleColour, contentW);
      // A title that would break onto a second line is set on one when it fits at no less than 82%
      // of its size and still leads the body by the house's ratio, as the guideline's titles stand.
      if (fixedTitleStep === undefined && measure(t, b.text).lines > 1) {
        for (let n = sizes.titleStep - 1; n >= MIN_TITLE_STEP; n--) {
          const size = r(sizes.body * Math.pow(TYPE_RATIO, n));
          if (size < 0.82 * sizes.title || size < Math.ceil(HOUSE_RULES.titleToBodyMin * sizes.body) || size <= sizes.lead) break;
          const smaller = el(b, 'title', size, titleColour, contentW);
          if (measure(smaller, b.text).lines === 1) {
            t = smaller;
            break;
          }
        }
      }
      const p = place(t, b.text, contentX, contentW, y);
      const tm = measure({ ...t, width: contentW }, b.text);
      if (tm.lines > 3) return undefined;
      // ADR-262: a title grown to the poster's range never runs a word past its box.
      if (fixedTitleStep !== undefined && tm.lineWidth > contentW + 2) return undefined;
      texts.push(p.el);
      const bar = titleBarPrimitive(g, W, p.el, p.el.align);
      unitShapes.push(bar);
      y = bar.y + bar.height;
      gapAfter = r(0.035 * W);
    } else if (u.kind === 'label') {
      const b = u.blocks[0];
      const p = place(el(b, 'label', sizes.label, onDark ? g.cover.subtitle.color : g.header.label.color, contentW), b.text, contentX, contentW, y);
      texts.push(p.el);
      y = p.bottom;
      gapAfter = r(0.02 * W);
    } else if (u.kind === 'lead') {
      const b = u.blocks[0];
      const colour = onDark ? g.cover.subtitle.color : g.lead.color;
      const p = place(el(b, 'lead', sizes.lead, colour, contentW), b.text, contentX, contentW, y);
      texts.push(p.el);
      y = p.bottom;
      gapAfter = r(0.04 * W);
    } else if (u.kind === 'meta' && cover) {
      for (const [i, b] of u.blocks.entries()) {
        if (i > 0) y += r(0.25 * sizes.meta);
        const p = place(el(b, 'meta', sizes.meta, g.cover.body, contentW), b.text, contentX, contentW, y);
        texts.push(p.el);
        y = p.bottom;
      }
    } else if (u.kind === 'meta' && variant === 'cards' && u.blocks.length === 2) {
      // Two white cards side by side, as the guideline's stat cards stand (p.1): serif lines in KAAE Blue.
      const cw = r((contentW - cardGap) / 2);
      const inner = cw - 2 * pad;
      const ps = u.blocks.map((b) => measure(el(b, 'cardTitle', sizes.meta, g.stat.colorOnLight, inner, 'center'), b.text));
      const ch = Math.max(...ps.map((p) => p.height)) + 2 * pad;
      u.blocks.forEach((b, i) => {
        const startX = rtl ? contentX + contentW - (i + 1) * cw - i * cardGap : contentX + i * (cw + cardGap);
        unitShapes.push(...cardPrimitives(g, W, 'plain', { x: startX, y, width: cw, height: ch }, rtl));
        const t = el(b, 'cardTitle', sizes.meta, g.stat.colorOnLight, inner, 'center');
        texts.push({ ...t, ...intBox({ x: startX + pad, y: y + r((ch - ps[i].height) / 2), width: inner, height: ps[i].height }) });
      });
      y += ch;
    } else if (u.kind === 'meta') {
      // The details on a card: KAAE Blue with a Sun serif first line and white lines (p.2), or white.
      const kind: CardKind = variant === 'cards' ? 'plain' : 'brand';
      const spec = g.cards[kind];
      const inner = contentW - 2 * pad;
      const lines: Array<{ t: TextElement; h: number; b: Block }> = u.blocks.map((b, i) => {
        const titleLine = i === 0 && !b.arabic;
        const t = el(b, titleLine ? 'cardTitle' : 'meta', sizes.meta, titleLine ? spec.title : spec.text, inner);
        return { t, h: measure(t, b.text).height, b };
      });
      const stack = lines.reduce((sum, l, i) => sum + l.h + (i ? r(0.3 * sizes.meta) : 0), 0);
      const ch = stack + 2 * pad;
      unitShapes.push(...cardPrimitives(g, W, kind, { x: contentX, y, width: contentW, height: ch }, rtl));
      let ty = y + pad;
      lines.forEach((l, i) => {
        if (i) ty += r(0.3 * sizes.meta);
        texts.push({ ...l.t, ...intBox({ x: contentX + pad, y: ty, width: inner, height: l.h }) });
        ty += l.h;
      });
      y += ch;
    } else if (u.kind === 'cta' && !cover) {
      // The call to action on a cream card with a gold edge on its start side (p.2).
      const b = u.blocks[0];
      const spec = g.cards.tint;
      const ew = Math.max(3, r((spec.edgeShare ?? 0.005) * W));
      const inner = contentW - 2 * pad - ew;
      const t = el(b, 'cta', sizes.body, spec.text, inner);
      const mm = measure(t, b.text);
      const ch = mm.height + 2 * r(0.75 * pad);
      unitShapes.push(...cardPrimitives(g, W, 'tint', { x: contentX, y, width: contentW, height: ch }, rtl));
      const tx = rtl ? contentX + pad : contentX + ew + pad;
      texts.push({ ...t, ...intBox({ x: tx, y: y + r(0.75 * pad), width: inner, height: mm.height }) });
      y += ch;
    } else if (u.kind === 'body' && variant === 'cards' && !cover) {
      const inner = contentW - 2 * pad;
      const ts = u.blocks.map((b) => {
        const t = el(b, 'body', sizes.body, g.cards.plain.text, inner);
        return { t, h: measure(t, b.text).height };
      });
      const ch = ts.reduce((a, x) => a + x.h, 0) + 2 * pad;
      unitShapes.push(...cardPrimitives(g, W, 'plain', { x: contentX, y, width: contentW, height: ch }, rtl));
      let ty = y + pad;
      for (const x of ts) {
        texts.push({ ...x.t, ...intBox({ x: contentX + pad, y: ty, width: inner, height: x.h }) });
        ty += x.h;
      }
      y += ch;
    } else {
      const b = u.blocks[0];
      const kind: UnitKind = u.kind === 'footer' ? 'footer' : u.kind === 'cta' ? 'cta' : 'body';
      const size = kind === 'footer' ? sizes.footer : sizes.body;
      const colour = onDark ? (kind === 'cta' ? g.cover.subtitle.color : g.cover.body) : g.body.color;
      const p = place(el(b, kind, size, colour, contentW), b.text, contentX, contentW, y);
      texts.push(p.el);
      y = p.bottom;
      gapAfter = r(0.8 * size);
    }
    // The photo, in a rounded card under the lead (or under the title when there is no lead).
    if (u.kind === 'title') titleSeen = true;
    // After the title and its lead (a lead set above the title, in copy order, does not count).
    if (input.photo && !cover && !photoPlaced && titleSeen && (u.kind === 'lead' || (u.kind === 'title' && unitsToFlow[k + 1]?.kind !== 'lead'))) {
      y += gapAfter;
      const minSide = Math.ceil(0.22 * s);
      const natural = r(contentW / (input.photo.width / input.photo.height));
      const remaining = limit - y - restHeightEstimate(unitsToFlow.slice(k + 1), sizes, W);
      const ph = Math.min(natural, Math.max(minSide, remaining));
      if (ph < minSide || y + ph > limit) return undefined;
      const box = { x: contentX, y, width: contentW, height: ph };
      const radius = Math.max(4, r(g.cards.radiusShare * W));
      unitShapes.push(...cardPrimitives(g, W, 'plain', box, rtl));
      photo = { photoIndex: input.photo.photoIndex, role: 'hero', ...intBox(box), radius, ...(input.photo.focus ? { focus: input.photo.focus } : {}) };
      y += ph;
      photoPlaced = true;
      gapAfter = r(0.035 * W);
    }
    placed.push({ unit: u, top, bottom: y, texts, shapes: unitShapes, ...(photo ? { photo } : {}), gapAfter });
    y += gapAfter;
  }
  const contentBottom = placed.length ? placed[placed.length - 1].bottom : flowTop;
  if (contentBottom > limit) return undefined;
  if (input.photo && !photoPlaced) return undefined;
  if (!finish) return {} as StudioLayoutV2;

  // ----- room left over -------------------------------------------------------------------------
  // A cover centres its block in the room under the logo; a page shares the room between its units,
  // each gap growing by at most 6% of the height, and leaves the rest at the foot (as the guideline's
  // pages do).
  let slack = limit - contentBottom;
  const shift: number[] = placed.map(() => 0);
  if (cover) {
    // Leave the foot for the pattern band when the cover carries one.
    const keep = variant === 'pattern' ? r(0.13 * H) : r(0.2 * H);
    const down = Math.max(0, Math.min(r(slack * 0.3), slack - keep));
    for (let i = 0; i < placed.length; i++) shift[i] = down;
    slack -= down;
  } else if (placed.length > 1) {
    const each = Math.min(r(0.06 * H), Math.floor(slack / (placed.length + 1)));
    for (let i = 1; i < placed.length; i++) shift[i] = shift[i - 1] + each;
    slack -= each * (placed.length - 1);
  }
  const photos: PhotoElement[] = [];
  placed.forEach((p, i) => {
    const dy = shift[i];
    for (const t of p.texts) text.push({ ...t, y: t.y + dy });
    for (const sh of p.shapes) shapes.push({ ...sh, y: sh.y + dy });
    if (p.photo) photos.push({ ...p.photo, y: p.photo.y + dy });
  });
  if (!cover) shapes.push(footRulePrimitive(g, W, contentX, contentW, footY));

  // ----- brand elements (subtle, optional, never over copy or the logo's clear space) -----------
  const lastBottom = Math.max(...text.map((t) => t.y + t.height), ...shapes.filter((sh) => sh.primitive !== 'foot_rule' && sh.primitive !== 'cover_ground').map((sh) => sh.y + sh.height));
  const free = (b: Box) => !text.some((t) => hit(t, b)) && !hit(b, clear) && !photos.some((p) => hit(p, b)) &&
    !shapes.some((sh) => sh.primitive !== 'cover_ground' && sh.primitive !== 'foot_rule' && hit(sh, b));
  if (cover && variant === 'pattern') {
    // A band of the triangle pattern rising from the foot (p.13), as tall as the room under the copy allows.
    const top = Math.max(H - r(0.18 * H), lastBottom + r(0.03 * H));
    const band = { x: 0, y: top, width: W, height: H - top };
    if (band.height >= r(0.07 * H) && free(band)) ornaments.push({ kind: 'triangle_pattern', ...band, color: g.elements.trianglePattern.colorOnDark, opacity: g.elements.trianglePattern.opacityOnDark, fade: 'to-top' });
  } else if (cover) {
    // The sunburst in the far bottom corner, its rays toward the copy (p.13).
    const size = Math.min(r(0.42 * W), H - lastBottom - r(0.03 * H));
    if (size >= r(0.2 * W)) {
      const box = { x: rtl ? 0 : W - size, y: H - size, width: size, height: size };
      if (free(box)) ornaments.push({ kind: 'sunburst', ...box, color: g.elements.sunburst.colorOnDark, opacity: g.elements.sunburst.opacityOnDark, corner: rtl ? 'bottom-left' : 'bottom-right' });
    }
  } else {
    const room = footY - r(0.02 * W) - lastBottom;
    const size = Math.min(r(0.34 * W), room);
    if (size >= r(0.18 * W)) {
      const box = { x: rtl ? contentX : contentX + contentW - size, y: footY - r(0.02 * W) - size, width: size, height: size };
      if (free(box) && sunburstRadius(box) > 0) {
        ornaments.push({ kind: 'sunburst', ...box, color: g.elements.sunburst.color, opacity: g.elements.sunburst.opacityOnLight, corner: rtl ? 'bottom-left' : 'bottom-right' });
      }
    }
  }

  const composition: CompositionRecord = { grammar: cover ? 'cover' : 'page', variant };
  const layout: StudioLayoutV2 = {
    version: 2,
    width: W,
    height: H,
    grid: { margin: m, columns: 12, gutter: r(0.02 * s), baseline: 8 },
    typeScale: { base: sizes.body, ratio: TYPE_RATIO },
    background: { color: cover ? g.cover.stops[g.cover.stops.length - 1].color : input.pageBackground && hexToLuminance(input.pageBackground) > 0.7 ? input.pageBackground : g.page.background },
    shapes,
    text: text.sort((a, b) => a.copyIndex - b.copyIndex),
    logo: intBox(logo),
    ...(photos.length ? { photos } : {}),
    ...(ornaments.length ? { ornaments } : {}),
    composition,
  };
  balanceGrammarLines(layout, input);
  checkGrammarLayout(layout, clear);
  return layout;
}

/**
 * A block that would end on one stranded word ("Accreditation Cycle / 2027") gets the narrower box
 * `balancedBoxWidths` finds at the same line count, anchored on its alignment.
 */
export function balanceGrammarLines(layout: StudioLayoutV2, input: ComposeGrammarInput): void {
  const widths = balancedBoxWidths(layout, input.copy.text, input.fontsDir ? { fontsDir: input.fontsDir } : {});
  for (const t of layout.text) {
    const w = widths[t.copyIndex];
    if (!w || w >= t.width || t.role === 'cta' || t.role === 'eyebrow') continue;
    const shift = t.align === 'right' ? t.width - w : t.align === 'center' ? Math.round((t.width - w) / 2) : 0;
    t.x += shift;
    t.width = w;
  }
}

/** A rough height of the units still to come, so a photo leaves them room. */
function restHeightEstimate(rest: Unit[], sizes: Sizes, W: number): number {
  let h = 0;
  for (const u of rest) {
    const lines = u.blocks.reduce((a, b) => a + Math.max(1, Math.ceil(b.text.length / 42)), 0);
    const size = u.kind === 'meta' ? sizes.meta : u.kind === 'lead' ? sizes.lead : sizes.body;
    h += lines * size * 1.5 + (u.kind === 'meta' || u.kind === 'cta' ? 0.08 * W : 0.03 * W);
  }
  return h;
}

/** What the composer promises the validator: copy clear of the logo's clear space and of each other, legible. */
export function checkGrammarLayout(layout: StudioLayoutV2, clear: Box): void {
  for (const t of layout.text) {
    if (hit(t, clear)) throw new GrammarInfeasibleError(`copy block ${t.copyIndex} is in the logo's clear space`);
    for (const u of layout.text) if (u !== t && hit(t, u)) throw new GrammarInfeasibleError(`copy blocks ${t.copyIndex} and ${u.copyIndex} overlap`);
    const under = surfaceColoursUnder(layout, t);
    const worst = Math.min(...under.map((c) => calculateLuminanceContrastRatio(hexToLuminance(t.color), hexToLuminance(c))));
    if (worst < requiredContrast(t.fontSize, Boolean(t.bold))) {
      throw new GrammarInfeasibleError(`copy block ${t.copyIndex} is ${worst.toFixed(2)}:1 on its surface`);
    }
  }
}

/** The colours under a text box: the topmost filled panel holding it, else the background. */
export function surfaceColoursUnder(layout: Pick<StudioLayoutV2, 'shapes' | 'background'>, box: Box): Hex[] {
  const shapes = layout.shapes || [];
  for (let i = shapes.length - 1; i >= 0; i--) {
    const sh = shapes[i];
    if (sh.fill === 'none' || sh.role !== 'panel') continue;
    if (box.x >= sh.x - 1 && box.y >= sh.y - 1 && box.x + box.width <= sh.x + sh.width + 1 && box.y + box.height <= sh.y + sh.height + 1) {
      return fillColoursUnder(sh, box);
    }
  }
  return [layout.background.color];
}

// ---------------------------------------------------------------------------------------------
// Conforming a model-drawn layout

/**
 * Restyles a layout the model drew to the grammar, keeping its geometry: titles in the grammar's
 * serif and colour, the first subtitle as the italic lead, body in the body face, labels tracked; a
 * shape the model tagged with a primitive gets the primitive's fill, gradient, radius and shadow; the
 * page gets its foot rule, and its title its bar, where they fit clear of copy and of the logo's clear
 * space. Sorani blocks keep their admitted faces (the grammar's faces are Latin).
 */
export interface ConformGrammarOptions {
  logoClearSpacePx?: number;
  /** The client's clear space as a share of the logo's height. */
  logoClearSpaceShare?: number;
  /** The client's admitted Sorani faces: a display face outside them becomes the first; body takes `arabicBody`. */
  arabicDisplayFonts?: string[];
  arabicBody?: string;
}

export function conformToPageGrammar(layout: StudioLayoutV2, g: PageGrammar, options: ConformGrammarOptions = {}): StudioLayoutV2 {
  return conformMarksToPageGrammar(conformTypeToPageGrammar(layout, g, options), g, options);
}

/**
 * The type half of `conformToPageGrammar`: faces, weights, italics and tracking by role. It changes
 * how wide the copy sets, so the pipeline applies it before it fits boxes to their copy; a layout
 * already set in the grammar's faces (a solved recipe) does not need it.
 */
export function conformTypeToPageGrammar(layout: StudioLayoutV2, g: PageGrammar, options: ConformGrammarOptions = {}): StudioLayoutV2 {
  const dark = hexToLuminance(layout.background.color) < 0.2;
  const latin = (t: TextElement) => !t.rtl;
  let leadSeen = false;
  for (const t of layout.text) {
    if (!latin(t)) {
      const body = t.role === 'body' || t.role === 'footer';
      if (body && options.arabicBody) t.fontFamily = options.arabicBody;
      else if (!body && options.arabicDisplayFonts?.length && !options.arabicDisplayFonts.includes(t.fontFamily)) t.fontFamily = options.arabicDisplayFonts[0];
      continue;
    }
    if (t.role === 'title') {
      t.fontFamily = g.title.fontFamily;
      t.bold = true;
      t.italic = false;
      t.letterSpacing = g.title.letterSpacing ?? 0;
    } else if ((t.role === 'subtitle') && !leadSeen) {
      leadSeen = true;
      t.fontFamily = g.lead.fontFamily;
      t.italic = Boolean(g.lead.italic) && !dark;
      t.bold = false;
    } else if (t.role === 'eyebrow') {
      t.fontFamily = g.header.label.fontFamily;
      t.bold = Boolean(g.header.label.bold);
      t.italic = false;
    } else {
      t.fontFamily = g.body.fontFamily;
      t.italic = false;
    }
  }
  return layout;
}

/**
 * The marks half of `conformToPageGrammar`: tagged primitives drawn in the grammar's fills,
 * gradients, radius and shadow, and the foot rule and the title bar added where they fit clear of
 * copy, photos and the logo's clear space. Geometry of the copy is untouched.
 */
export function conformMarksToPageGrammar(layout: StudioLayoutV2, g: PageGrammar, options: ConformGrammarOptions = {}): StudioLayoutV2 {
  const W = layout.width;
  const dark = hexToLuminance(layout.background.color) < 0.2;
  const latin = (t: TextElement) => !t.rtl;
  for (const s of layout.shapes) {
    if (!s.primitive) continue;
    if (s.primitive === 'title_bar' || s.primitive === 'header_accent') {
      const stops = s.primitive === 'title_bar' ? g.titleBar.stops : g.header.accent.stops;
      s.kind = 'roundRect';
      s.gradient = gradientOf(stops, 0);
      s.color = middleStop(stops);
      s.radius = Math.round(Math.min(s.height, s.width) / 2);
    } else if (s.primitive === 'foot_rule') {
      s.gradient = gradientOf(g.footRule.stops, 0);
      s.color = middleStop(g.footRule.stops);
    } else if (s.primitive === 'header_rule') {
      s.color = g.header.rule.color;
      s.opacity = g.header.rule.opacity;
    } else if (s.primitive === 'card') {
      s.kind = 'roundRect';
      s.surface = s.surface ?? 'card';
      s.radius = Math.max(4, Math.round(g.cards.radiusShare * W));
      const sh = g.cards.shadow;
      s.shadow = { color: sh.color, opacity: sh.opacity, blur: Math.min(80, Math.round(sh.blurShare * W)), offsetY: Math.min(80, Math.round(sh.offsetShare * W)) };
    } else if (s.primitive === 'cover_ground') {
      s.gradient = gradientOf(g.cover.stops, g.cover.angle);
      s.color = g.cover.stops[g.cover.stops.length - 1].color;
    }
  }
  // A dark design is the grammar's cover: its gradient ground under everything, where every block
  // set straight on the ground still reads on the colours the gradient puts under it.
  if (dark && !layout.shapes.some((s) => s.primitive === 'cover_ground')) {
    const ground = coverGroundPrimitive(g, W, layout.height);
    const onGround = layout.text.filter((t) => surfaceColoursUnder(layout, t).length === 1 && surfaceColoursUnder(layout, t)[0] === layout.background.color);
    const reads = onGround.every((t) => fillColoursUnder(ground, t).every((c) => readsOn(t.color, c, t.fontSize, Boolean(t.bold))));
    if (reads) {
      layout.shapes.unshift(ground);
      layout.background = { color: ground.color };
    }
  }
  // The foot rule, where the page has room for it under its last block.
  if (!dark && !layout.shapes.some((s) => s.primitive === 'foot_rule')) {
    const m = layout.grid?.margin ?? Math.round(0.07 * Math.min(W, layout.height));
    const h = Math.max(3, Math.round(g.footRule.heightShare * W));
    const y = layout.height - Math.round(0.75 * m) - h;
    const rule = footRulePrimitive(g, W, m, W - 2 * m, y);
    const clear = logoClearZone(layout.logo, Math.max(options.logoClearSpacePx ?? 0, (options.logoClearSpaceShare ?? 0) * layout.logo.height));
    const blocked = [...layout.text, ...(layout.photos ?? [])].some((b) => hit(b, { ...rule, y: rule.y - 8, height: rule.height + 16 })) || hit(rule, clear);
    if (!blocked) layout.shapes.push(rule);
  }
  // The bar under the title, where the gap below it holds it clear of the next block.
  const title = layout.text.find((t) => t.role === 'title' && latin(t));
  if (title && !layout.shapes.some((s) => s.primitive === 'title_bar')) {
    const bar = titleBarPrimitive(g, W, title, title.align);
    const clear = logoClearZone(layout.logo, Math.max(options.logoClearSpacePx ?? 0, (options.logoClearSpaceShare ?? 0) * layout.logo.height));
    const room = { ...bar, y: bar.y - 2, height: bar.height + Math.round(0.012 * W) };
    const blocked = layout.text.some((t) => t !== title && hit(t, room)) || layout.shapes.some((s) => s.role !== 'panel' && hit(s, room)) || hit(bar, clear) ||
      bar.y + bar.height > layout.height;
    if (!blocked) layout.shapes.push(bar);
  }
  return layout;
}

/**
 * ADR-238: where a design departs from the client's page grammar, in words: what the judge's and the
 * visual review's guideline-fidelity rule names, and what the guideline prior counts.
 * - a flat dark panel laid over a gradient cover (the guideline's cover has none);
 * - a dark design with no gradient cover ground;
 * - a light page without the header rule and its gold segment, the gold bar under its title, or the
 *   gradient rule at its foot;
 * - a Latin block outside the guideline's faces, or a Sorani block outside the admitted ones.
 */
export function guidelineDeviations(layout: StudioLayoutV2, g: PageGrammar, options: { arabicFonts?: string[] } = {}): string[] {
  const out: string[] = [];
  const has = (p: string) => layout.shapes.some((s) => s.primitive === p);
  const area = layout.width * layout.height;
  const dark = hexToLuminance(layout.background.color) < 0.2 || has('cover_ground');
  if (dark) {
    if (!has('cover_ground')) out.push('a dark design without the guideline cover\'s gradient ground');
    const flat = layout.shapes.filter((s) => s.role === 'panel' && s.primitive !== 'cover_ground' && s.fill !== 'none' && !s.gradient &&
      hexToLuminance(s.color) < 0.2 && s.width * s.height > 0.08 * area);
    if (flat.length && has('cover_ground')) out.push('a flat dark panel on the gradient cover');
  } else if (layout.composition?.grammar === 'poster') {
    // ADR-262: a light poster (cream, or the white page with its title band) is composed as the
    // office's posters are, not as the guideline's document page: it keeps the gold bar.
    if (!has('title_bar')) out.push('no gold bar under the title');
  } else {
    if (!has('header_rule') || !has('header_accent')) out.push('no header rule with its gold segment');
    if (!has('title_bar')) out.push('no gold bar under the title');
    if (!has('foot_rule')) out.push('no gradient rule at the foot');
  }
  const latinFaces = new Set([g.title.fontFamily, g.lead.fontFamily, g.body.fontFamily, g.header.label.fontFamily, g.stat.fontFamily, g.cover.subtitle.fontFamily]);
  const offLatin = [...new Set(layout.text.filter((t) => !t.rtl && !latinFaces.has(t.fontFamily)).map((t) => t.fontFamily))];
  if (offLatin.length) out.push(`a typeface outside the guideline (${offLatin.join(', ')})`);
  if (options.arabicFonts?.length) {
    const offArabic = [...new Set(layout.text.filter((t) => t.rtl && !options.arabicFonts!.includes(t.fontFamily)).map((t) => t.fontFamily))];
    if (offArabic.length) out.push(`a Sorani typeface outside the admitted ones (${offArabic.join(', ')})`);
  }
  return out;
}

/**
 * ADR-238: the guideline-fidelity rule the judge and the visual review read with the client's house
 * rules, from its page grammar: a design that departs from the guideline counts against it. Within
 * the judge's 240-character limit for one rule (MAX_JUDGE_HOUSE_RULE_CHARS).
 */
export function guidelineFidelityRule(g: PageGrammar): string {
  const faces = [...new Set([g.title.fontFamily, g.lead.fontFamily, g.body.fontFamily])].join(', ');
  // ADR-262: a client with poster rules is told a poster needs only the bar, so the rule does not
  // count the office's own poster compositions against themselves.
  const page = g.poster ? 'a document page lacking header rule, gold title bar or foot rule (a poster: the bar)'
    : 'a page without the header rule and gold segment, the gold title bar or the foot rule';
  return `Guideline fidelity (brand fit): count against a design a flat dark panel on the gradient cover; ${page}; a face other than ${faces} or the Sorani sans.`;
}

/** The grammar in words, for the layout model's request (the system prompt names no client). */
export function pageGrammarPrompt(g: PageGrammar): string {
  return [
    `Page: background ${g.page.background}, margins ${Math.round(g.page.marginShare * 100)}% of the short side.`,
    `Header: the logo top-left (about ${Math.round(g.header.logoWidthShare * 100)}% of the width); an eyebrow, if the copy opens with one, at the top right in ${g.header.label.fontFamily} bold ${g.header.label.color}, tracked; under them a thin rule (primitive "header_rule") with a gold segment under the logo (primitive "header_accent").`,
    `Title: ${g.title.fontFamily} bold ${g.title.color} (${g.cover.title} on a dark ground), left-aligned (right in Sorani), with a short bar under it (primitive "title_bar", about ${Math.round(g.titleBar.widthShare * 100)}% of the width).`,
    `Lead (the first subtitle): ${g.lead.fontFamily} italic ${g.lead.color}. Body: ${g.body.fontFamily} ${g.body.color}.`,
    `Cards (primitive "card", role "panel"): rounded, soft shadow; white with ${g.cards.plain.title} titles, ${g.cards.brand.fill} with white text and ${g.cards.brand.title} card titles, or ${g.cards.tint.fill} with a ${g.cards.tint.edge} edge on the start side (primitive "card_edge", role "accent").`,
    `Foot: a gradient rule across the content width near the bottom (primitive "foot_rule").`,
    `Cover (dark ground): the whole canvas in a gradient (primitive "cover_ground", role "panel"), a centred logo, a ${g.cover.title} title, the bar, a ${g.cover.subtitle.color} tracked subtitle.`,
  ].join(' ');
}

/** Whether a colour reads on a surface at the size and weight of a block. */
export function readsOn(color: Hex, surface: Hex, fontSize: number, bold: boolean): boolean {
  return calculateLuminanceContrastRatio(hexToLuminance(color), hexToLuminance(surface)) >= requiredContrast(fontSize, bold);
}
