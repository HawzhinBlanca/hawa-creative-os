import type { Box, CompositionRecord, Hex, OrnamentElement, ShapeElement, StudioLayoutV2, TextElement } from './layout-v2.js';
import { HOUSE_RULES, getSafeZoneBox, isDisplayText, logoClearZone, minLogoWidth } from './house-rules.js';
import { lineInkClears, measureLineInkClearance, measureTextGeometry, measureWrappedLines } from './render-layout-v2.js';
import { PosterDisplayFaceError, posterDisplayStyle, posterLabelStyle, withPosterDisplayStyle, type PosterDisplayStyle } from './poster-display.js';
import { hexToLuminance } from './composite-contrast.js';
import { sunburstRadius } from './brand-elements.js';
import { computeNegativeSpace } from './design-metrics.js';
import { computeLayoutMetrics } from './layout-metrics.js';
import { negativeSpacePassingInterval } from './negative-space-policy.js';
import {
  GrammarInfeasibleError,
  balanceGrammarLines,
  checkGrammarLayout,
  coverGroundPrimitive,
  footRulePrimitive,
  gradientOf,
  grammarUnits,
  readsOn,
  surfaceColoursUnder,
  type ComposeGrammarInput,
  type GrammarUnit,
  type PageGrammar,
  type PosterGrammar,
  type PosterVariantSpec,
} from './page-grammar.js';

/**
 * ADR-271: the client's poster compositions. The guideline (KAAE: the 2025 Excellence Edition) sets
 * the palette, the logo, the faces and the brand elements; the office's own published posts set how
 * a poster is composed: one dominant display title, a navy or cream ground or a full-width title
 * band, the details grouped at the foot, and a visible brand element. Every colour, face and
 * proportion comes from the reference's `pageGrammar.poster`; shared code names no client.
 *
 * The three are different compositions, not one layout in three colourways (ADR-271 section 8):
 *
 * - `navy`: the cover's navy gradient over the whole canvas, the sunburst at the top right beside the
 *   logo, the big white title lowered under it with a gold bar and a Sun lead, the details as a block
 *   across the content width under it, a gold pill for the call to action.
 * - `cream`: a cream ground, the big Royal title at the top, the details on a Royal card on the far
 *   side with the gold pill bridging its lower edge, a gold sunburst in the near bottom corner.
 * - `band`: the white page with a gradient band under the logo holding the display title, the details
 *   on a KAAE Blue card under the start of the title, a gold pill, the guideline's triangle pattern
 *   rising from the foot, and the gradient rule.
 *
 * A title-only brief (a title and at most a lead) is composed as such: the lead a size up as the
 * strong secondary (on cream, on the card opposite the title). No copy is added.
 *
 * The title is set as large as the copy allows between the poster's shares of the width (it grows to
 * fill its block), on the one declared type scale. Deterministic and measured with the renderer's
 * own text measurement, like the page composer.
 */

export const POSTER_VARIANTS = ['navy', 'cream', 'band'] as const;
export type PosterVariant = (typeof POSTER_VARIANTS)[number];

const r = (v: number) => Math.round(v);
const TYPE_RATIO = 1.25;
/** Hard QA's alignment threshold (`POOR_GRID_ALIGNMENT`). */
const ALIGNMENT_PASS = 0.7;
/** The smallest clear gap between the foot's parts (the card, the pill, the brand element, the rule), as a share of the height. */
export const FOOT_GAP_SHARE = 0.03;
/**
 * The widest gap the composer leaves between two blocks (the logo, the head, the foot), as a share of
 * the height: under the negative-space metric's internal-gap penalty (0.22), which counts a wider one dead.
 */
const MAX_GAP_SHARE = 0.18;

function intBox(b: Box): Box {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, width: Math.max(1, Math.round(b.x + b.width) - x), height: Math.max(1, Math.round(b.y + b.height) - y) };
}
/** The x of the layout grid's lines, as hard QA's alignment check reads them (`computeLayoutMetrics`). */
function gridLinesX(W: number, margin: number, gutter: number, columns = 12): number[] {
  const col = (W - 2 * margin - (columns - 1) * gutter) / columns;
  const lines = [margin, W - margin, Math.round(W / 2)];
  for (let c = 0; c < columns; c++) lines.push(Math.round(margin + c * (col + gutter)), Math.round(margin + c * (col + gutter) + col));
  return lines.sort((a, b) => a - b);
}
/** The grid line nearest x, or, with a direction, the nearest at or past it that way (x when none is within reach). */
function snapX(lines: number[], x: number, reach: number, way: 'nearest' | 'up' | 'down' = 'nearest'): number {
  const ok = lines.filter((g) => Math.abs(g - x) <= reach && (way === 'nearest' || (way === 'up' ? g >= x : g <= x)));
  return ok.length ? ok.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a)) : x;
}
const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

interface PosterSizes { title: number; titleStep: number; lead: number; strongLead: number; meta: number; body: number; footer: number; label: number }

/**
 * The type sizes for a title size: a body on the major-third scale under it, as near the grammar's body
 * as the poster allows. The details (the lead, the date and place) take the first step over the body at
 * or above the poster's smallest detail size, so they still read under a poster-sized title.
 */
function posterSizes(g: PageGrammar, W: number, title: number, detailMin = 0): PosterSizes | undefined {
  const minBody = Math.max(Math.ceil(HOUSE_RULES.minBodyShareOfWidth * W), r(0.85 * g.body.sizeShare * W));
  const maxBody = r(1.2 * g.body.sizeShare * W);
  const want = g.body.sizeShare * W;
  let best: { body: number; n: number } | undefined;
  for (let n = 5; n <= 8; n++) {
    const body = r(title / Math.pow(TYPE_RATIO, n));
    if (body < minBody || body > maxBody) continue;
    if (!best || Math.abs(body - want) < Math.abs(best.body - want)) best = { body, n };
  }
  if (!best) return undefined;
  const step = (k: number) => r(best!.body * Math.pow(TYPE_RATIO, k));
  let detail = 1;
  while (detail < best.n - 2 && step(detail) < detailMin * W) detail++;
  // A title-only brief's lead, the poster's strong secondary: a step over the details while the title
  // stays the one dominant display moment (at least 2.2 times it, four steps of the scale).
  const strong = Math.max(detail, Math.min(detail + 1, best.n - 4));
  return {
    title: step(best.n), titleStep: best.n, lead: step(detail), strongLead: step(strong), meta: step(detail), body: best.body,
    footer: Math.max(HOUSE_RULES.minFontPx, step(-1)), label: Math.max(HOUSE_RULES.minFontPx, best.body),
  };
}

/**
 * Sets one of the poster compositions. The title takes the largest size, from the poster's largest
 * share of the width down to its smallest, at which the whole poster fits; under the smallest the
 * composition is infeasible and the caller skips it.
 */
export function composePosterLayout(input: ComposeGrammarInput & { variant: PosterVariant }): StudioLayoutV2 {
  const { width: W, grammar: g } = input;
  const P = g.poster;
  if (!P) throw new GrammarInfeasibleError('the grammar has no poster compositions');
  if (!(POSTER_VARIANTS as readonly string[]).includes(input.variant)) throw new GrammarInfeasibleError(`unknown poster variant ${input.variant}`);
  const units = grammarUnits(input);
  if (!units.some((u) => u.kind === 'title')) throw new GrammarInfeasibleError('no title');
  const hi = r(P.titleSizeShare.max * W);
  const lo = r(P.titleSizeShare.min * W);
  let fallback: StudioLayoutV2 | undefined;
  const floor = negativeSpacePassingInterval('measured_lines').min + 0.04;
  // The details at the poster's smallest detail size first; a composition that cannot hold them there
  // (a band under a long Sorani title) keeps the scale's first step over the body rather than dropping out.
  for (const detailMin of [...new Set([P.detailSizeShareMin ?? 0, 0])]) {
    // The brand element in its composition's own place first (navy: the top right; cream: on the
    // block's horizon; band: the pattern rising from the foot), a smaller title rather than an element
    // pushed to whichever corner is left; else wherever it fits.
    for (const home of [true, false]) {
      for (let size = hi; size >= lo; size -= 2) {
        const sizes = posterSizes(g, W, size, detailMin);
        if (!sizes || sizes.title > hi + 1 || sizes.title < lo) continue;
        // The details in their column beside the brand element, else across the content width.
        for (const fullWidth of [false, true]) {
          const layout = attemptPoster(input, units, sizes, P, fullWidth, home);
          if (!layout) continue;
          // The poster fills its canvas: the largest title that fits with its negative space between the
          // studio's floor (a crowded poster fails the same metric) and the poster's ceiling.
          const ns = negativeSpaceOf(layout, input);
          if (ns <= P.negativeSpaceMax && ns >= floor) return layout;
          if (ns >= floor) fallback ??= layout;
        }
      }
    }
    if (fallback) return fallback;
  }
  throw new GrammarInfeasibleError(`the copy does not fit a ${input.variant} poster at ${W}x${input.height} with a title of at least ${lo}px`);
}

/** The measured negative space of a composed poster (the share of the canvas with no content). */
export function negativeSpaceOf(layout: StudioLayoutV2, input: Pick<ComposeGrammarInput, 'copy' | 'fontsDir'>): number {
  const ns = computeNegativeSpace(layout, measureWrappedLines(layout, input.copy.text, input.fontsDir ? { fontsDir: input.fontsDir } : {}));
  const fraction = (ns.details as { fraction?: number } | undefined)?.fraction;
  return typeof fraction === 'number' ? fraction : 1;
}

function attemptPoster(input: ComposeGrammarInput & { variant: PosterVariant }, units: GrammarUnit[], sizes: PosterSizes, P: PosterGrammar, fullWidth: boolean, home = false): StudioLayoutV2 | undefined {
  const { width: W, height: H, grammar: g, variant } = input;
  const spec: PosterVariantSpec = P[variant];
  const s = Math.min(W, H);
  const m = Math.max(Math.ceil(HOUSE_RULES.safeMarginShare * s), r(g.page.marginShare * s));
  const safe = getSafeZoneBox(W, H, m);
  const contentX = safe.x;
  const contentW = safe.width;
  const rtl = units.filter((u) => u.blocks.some((b) => b.arabic)).length > units.length / 2;
  const align: 'left' | 'right' = rtl ? 'right' : 'left';
  const arabicDisplay = input.fonts?.arabicDisplay || 'Noto Sans Arabic';
  const arabicBody = input.fonts?.arabicBody || 'Noto Sans Arabic';
  const wide = W / H > 1.25;
  const gutter = r(0.02 * s);
  const grid = gridLinesX(W, m, gutter);
  const band = variant === 'band';
  // The smallest clear gap between the foot's parts: the card, the pill, the brand element and the rule.
  const gapMin = r(FOOT_GAP_SHARE * H);

  // ----- the ground --------------------------------------------------------------------------
  const shapes: ShapeElement[] = [];
  const text: TextElement[] = [];
  let background: Hex;
  if (variant === 'navy') {
    shapes.push(coverGroundPrimitive(g, W, H));
    background = g.cover.stops[g.cover.stops.length - 1].color;
  } else if (variant === 'cream') {
    background = spec.ground ?? g.cards.tint.fill;
  } else {
    background = input.pageBackground && hexToLuminance(input.pageBackground) > 0.7 ? input.pageBackground : g.page.background;
  }

  // ----- the logo, top left as in the guideline's header (p.10 keeps it left in Sorani) ------------
  const aspect = input.logoAspect > 0 ? input.logoAspect : 1;
  const minLogo = Math.max(minLogoWidth(W), input.logoMinimumWidthPx ?? 0);
  let lw = Math.max(minLogo, r(P.logoWidthShare * Math.min(W, 1.25 * H)));
  let lh = r(lw / aspect);
  while (Math.abs(lw / lh - aspect) / aspect > 0.009 && lw < minLogo + 40) {
    lw += 1;
    lh = r(lw / aspect);
  }
  const logo: Box = { x: contentX, y: safe.y, width: lw, height: lh };
  const clearPx = Math.max(input.logoClearSpacePx ?? 0, (input.logoClearSpaceShare ?? 0) * lh);
  // The guideline's own clear space, the height of its K (as the cover keeps it).
  const clear = logoClearZone(logo, clearPx, { clientOnly: true });

  const measure = (el: TextElement, copy: string) => {
    const [mm] = measureTextGeometry({ text: [el] } as StudioLayoutV2, { [el.copyIndex]: copy }, input.fontsDir ? { fontsDir: input.fontsDir } : {});
    if (!mm || mm.status !== 'measured') throw new GrammarInfeasibleError(`copy block ${el.copyIndex} cannot be measured (${mm && mm.status === 'unmeasured' ? mm.reason : 'no measurement'})`);
    return { height: mm.requiredHeightPx + 1, lineWidth: mm.maxLineWidthPx, lines: mm.lineCount };
  };
  type Kind = 'title' | 'lead' | 'label' | 'meta' | 'metaFirst' | 'body' | 'cta' | 'footer';
  // ADR-275: the poster's display title (KAAE: the office's heavy sans capitals), per script, from the
  // reference; undefined keeps the grammar's title face. A face that cannot draw the script makes the
  // composition infeasible rather than drawing half the title in another face.
  const displayStyles = new Map<'latin' | 'arabic', PosterDisplayStyle | undefined>();
  const displayStyle = (script: 'latin' | 'arabic') => {
    if (!displayStyles.has(script)) {
      try {
        displayStyles.set(script, posterDisplayStyle(g, script, input.fontsDir ? { fontsDir: input.fontsDir } : {}));
      } catch (err) {
        if (err instanceof PosterDisplayFaceError) throw new GrammarInfeasibleError(err.message);
        throw err;
      }
    }
    return displayStyles.get(script);
  };
  const labelStyle = posterLabelStyle(g);
  const el = (b: GrammarUnit['blocks'][number], kind: Kind, size: number, color: Hex, w: number, opts: { italic?: boolean; bold?: boolean } = {}): TextElement => {
    const base = plainEl(b, kind, size, color, w, opts);
    if (kind === 'title') {
      const style = displayStyle(b.arabic ? 'arabic' : 'latin');
      // The display leading only at display size (isDisplayText: 0.06 of the width; a wide canvas sets
      // smaller titles); otherwise the face, weight and capitals with the body leading.
      const range = b.arabic ? HOUSE_RULES.lineHeight.arabic : HOUSE_RULES.lineHeight.latin;
      return withPosterDisplayStyle(base, style && !isDisplayText({ role: 'title', fontSize: size }, W) ? { ...style, lineHeight: Math.max(style.lineHeight, range.min) } : style);
    }
    if (kind === 'label' && !b.arabic && labelStyle) return { ...base, ...labelStyle };
    return base;
  };
  const plainEl = (b: GrammarUnit['blocks'][number], kind: Kind, size: number, color: Hex, w: number, opts: { italic?: boolean; bold?: boolean } = {}): TextElement => {
    const lhRange = b.arabic ? HOUSE_RULES.lineHeight.arabic : HOUSE_RULES.lineHeight.latin;
    // The details' lines (a date, a place) share one tight leading, as one group; running text 1.45.
    const wanted = b.arabic ? (kind === 'title' ? 1.6 : 1.7) : kind === 'title' ? 1.2 : kind === 'lead' ? 1.35 : kind === 'meta' || kind === 'metaFirst' ? 1.25 : 1.45;
    // One face per group: the details (the date first, in bold, then the place) are all the body face;
    // only the title takes the display face and the lead the grammar's lead face.
    const family = b.arabic
      ? (kind === 'title' || kind === 'label' || kind === 'cta' ? arabicDisplay : arabicBody)
      : kind === 'title' ? g.title.fontFamily : kind === 'lead' ? g.lead.fontFamily : g.body.fontFamily;
    const tracking = b.arabic ? 0 : kind === 'title' ? (g.title.letterSpacing ?? 0) : kind === 'label' ? (g.header.label.letterSpacing ?? 0) : 0;
    const italic = opts.italic ?? (!b.arabic && kind === 'lead' && variant !== 'navy' && Boolean(g.lead.italic));
    const bold = opts.bold ?? (kind === 'title' || kind === 'metaFirst' || kind === 'label' || kind === 'cta');
    return {
      copyIndex: b.copyIndex, role: b.role, x: 0, y: 0, width: w, height: 10, fontSize: size,
      lineHeight: Math.min(lhRange.max, Math.max(lhRange.min, wanted)),
      ...(tracking ? { letterSpacing: Math.max(-HOUSE_RULES.letterSpacingMaxEm, Math.min(HOUSE_RULES.letterSpacingMaxEm, tracking)) } : {}),
      fontFamily: family, color, align: b.arabic ? 'right' : align,
      ...(bold ? { bold: true } : {}), ...(italic && !b.arabic ? { italic: true } : {}), ...(b.arabic ? { rtl: true, letterSpacing: 0 } : {}),
    };
  };
  /** A block set in a column at x: its measured box (the column's width), or undefined when a word overflows the column. */
  const set = (t: TextElement, copy: string, x: number, w: number, y: number) => {
    const mm = measure({ ...t, width: w }, copy);
    if (mm.lineWidth > w + 2) return undefined;
    return { el: { ...t, ...intBox({ x, y, width: w, height: mm.height }) }, lines: mm.lines, lineWidth: mm.lineWidth };
  };

  // ----- the header label (an eyebrow that opens the copy) on the logo's line ------------------
  const flow = [...units];
  if (flow[0]?.kind === 'label') {
    const b = flow[0].blocks[0];
    const x0 = Math.ceil(clear.x + clear.width) + 1;
    const colW = contentX + contentW - x0;
    const colour = variant === 'navy' ? spec.lead : g.header.label.color;
    const t = el(b, 'label', sizes.label, colour, colW);
    const p = colW > 0 ? set({ ...t, align: 'right' }, b.text, x0, colW, 0) : undefined;
    if (p && p.lines === 1) {
      text.push({ ...p.el, y: r(logo.y + logo.height / 2 - p.el.height / 2) });
      flow.shift();
    }
  }

  // ----- the head (everything up to the title, and the lead after it) and the foot -------------
  const titleAt = flow.findIndex((u) => u.kind === 'title');
  const leadAfter = flow[titleAt + 1]?.kind === 'lead';
  const afterHead = flow.slice(titleAt + (leadAfter ? 2 : 1));
  // A title with at most a lead (no details, no call to action) is composed as such, not as a poster
  // missing its foot: the lead is a strong secondary, a size up; cream sets it on its foot block,
  // where the details would stand.
  const titleOnly = !afterHead.some((u) => u.kind === 'meta' || u.kind === 'body' || u.kind === 'cta' || u.kind === 'lead');
  const leadOnCard = variant === 'cream' && titleOnly && leadAfter;
  const headEnd = leadAfter && !leadOnCard ? titleAt + 1 : titleAt;
  const head = flow.slice(0, headEnd + 1);
  const foot = flow.slice(headEnd + 1);
  const leadSize = titleOnly ? sizes.strongLead : sizes.lead;
  const bandPad = r(0.04 * s);
  const top = Math.ceil(clear.y + clear.height) + r(0.025 * H);
  const bar = { width: r(P.titleBarWidthShare * W), height: Math.max(6, r(1.5 * g.titleBar.heightShare * W)), gap: r(0.022 * W) };

  type Item = { el?: TextElement; shapes: ShapeElement[]; top: number; bottom: number };
  const headItems: Item[] = [];
  let y = band ? top + bandPad : top;
  let titleBox: TextElement | undefined;
  let bandBottom = 0;
  for (const u of head) {
    const b = u.blocks[0];
    if (u.kind === 'title') {
      let titleEl = el(b, 'title', sizes.title, spec.title, contentW);
      let p = set(titleEl, b.text, contentX, contentW, y);
      // A Sorani display title under the body leading keeps its marks clear of the next line, measured
      // (ADR-275): the leading steps up until the ink clears, at most to the body range.
      while (p && b.arabic && titleEl.lineHeight < HOUSE_RULES.lineHeight.arabic.min) {
        const clearance = measureLineInkClearance(p.el, b.text, input.fontsDir ? { fontsDir: input.fontsDir } : {});
        if (!clearance || lineInkClears(clearance)) break;
        titleEl = { ...titleEl, lineHeight: Math.min(HOUSE_RULES.lineHeight.arabic.min, Math.round((titleEl.lineHeight + 0.05) * 100) / 100) };
        p = set(titleEl, b.text, contentX, contentW, y);
      }
      if (!p) return undefined;
      if (p.lines > (b.arabic ? 3 : 4)) return undefined;
      titleBox = p.el;
      // The bar's free end on a grid line, so it lines up with the page as its start does.
      const barW = align === 'right' ? contentX + contentW - snapX(grid, contentX + contentW - bar.width, 0.05 * W) : snapX(grid, contentX + bar.width, 0.05 * W) - contentX;
      const barX = align === 'right' ? contentX + contentW - barW : contentX;
      const barShape: ShapeElement = { kind: 'roundRect', role: 'accent', primitive: 'title_bar', x: barX, y: p.el.y + p.el.height + bar.gap, width: barW, height: bar.height,
        radius: r(bar.height / 2), color: middle(g.titleBar.stops), gradient: gradientOf(g.titleBar.stops, 0) };
      headItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
      y = p.el.y + p.el.height;
      if (band) {
        // The bar bridges the band's lower edge, as the office's elements bridge edges.
        bandBottom = y + bar.gap + r(bar.height / 2);
        barShape.y = bandBottom - r(bar.height / 2);
        headItems.push({ shapes: [barShape], top: barShape.y, bottom: barShape.y + barShape.height });
        y = Math.max(bandBottom + r(0.5 * bandPad), barShape.y + barShape.height) + r(0.022 * H);
      } else {
        headItems.push({ shapes: [barShape], top: barShape.y, bottom: barShape.y + barShape.height });
        y = barShape.y + barShape.height + r(0.03 * H);
      }
    } else {
      // A lead (or a line set above the title in copy order).
      const before = titleBox === undefined;
      const onBand = band && before;
      const colour = variant === 'navy' || onBand ? spec.lead : variant === 'band' ? g.lead.color : spec.lead;
      const p = set(el(b, u.kind === 'lead' ? 'lead' : u.kind === 'label' ? 'label' : 'body', u.kind === 'lead' ? leadSize : sizes.body, colour, contentW), b.text, contentX, contentW, y);
      if (!p) return undefined;
      headItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
      y = p.el.y + p.el.height + r((before ? 0.02 : 0.03) * H);
    }
  }
  if (!titleBox) return undefined;
  const headBottom = Math.max(...headItems.map((i) => i.bottom));

  // ----- the foot: the details, grouped, with the call to action as a pill ---------------------
  const footY = band ? H - r(0.75 * m) - Math.max(3, r(g.footRule.heightShare * W)) : H;
  const limit = band ? Math.min(safe.y + safe.height, footY - gapMin) : safe.y + safe.height;
  const hasBody = foot.some((u) => u.kind === 'body');
  // Navy sets its details straight on the ground across the content width; cream on a full-bleed
  // Royal block that closes the poster; the band on a card in a column under the title's start.
  const colShare = fullWidth || variant !== 'band' ? 1 : wide ? 0.5 : hasBody ? 0.8 : 0.64;
  const colW = r(colShare * contentW);
  const colX = rtl ? contentX + contentW - colW : contentX;
  const pad = r(0.035 * W);
  const panel = variant === 'band';
  const block = variant === 'cream';
  const panelFill = block ? spec.panel! : g.cards.brand.fill;
  const panelTitle = variant === 'cream' ? spec.panelTitle! : g.cards.brand.title;
  const panelText = variant === 'cream' ? spec.panelText! : g.cards.brand.text;
  const footItems: Item[] = [];
  let fy = 0;
  const details = foot.filter((u) => u.kind === 'meta' || u.kind === 'body' || u.kind === 'lead');
  const rest = foot.filter((u) => !details.includes(u));
  // The call to action's pill, measured first: on the band it bridges the card's lower edge (the
  // guideline's "a call-to-action tab straddling a card"), so the card keeps room under its copy.
  const ctaUnit = rest.find((u) => u.kind === 'cta');
  const pillOf = (u: GrammarUnit) => {
    const t = el(u.blocks[0], 'cta', sizes.lead, spec.pillText, colW);
    const mm = measure(t, u.blocks[0].text);
    const padX = r(0.9 * sizes.lead);
    const padY = r(0.45 * sizes.lead);
    return mm.lineWidth + 2 * padX > colW - (panel && details.length ? 2 * pad : 0) + 2 ? undefined : { t, mm, padX, padY, height: mm.height + 2 * padY };
  };
  const ctaPill = ctaUnit ? pillOf(ctaUnit) : undefined;
  const bridge = panel && details.length > 0 && ctaPill !== undefined;
  let card: { x: number; y: number; width: number; height: number; ix: number; inner: number } | undefined;
  if (details.length) {
    const inner = panel ? colW - 2 * pad : colW;
    const ix = panel ? colX + pad : colX;
    const lines: Array<{ t: TextElement; copy: string; meta: boolean }> = [];
    let firstMeta = true;
    for (const u of details) {
      for (const b of u.blocks) {
        const metaFirst = u.kind === 'meta' && firstMeta && !b.arabic;
        if (u.kind === 'meta') firstMeta = false;
        if (u.kind === 'lead' && leadOnCard) {
          // The title-only lead on the card: the strong secondary, upright and bold in the card's title colour.
          lines.push({ t: el(b, 'lead', sizes.strongLead, panelTitle, inner, { italic: false, bold: true }), copy: b.text, meta: false });
          continue;
        }
        const colour = u.kind === 'meta' && (metaFirst || b.role === 'date') ? (variant === 'navy' ? spec.detail : panelTitle) : variant === 'navy' ? spec.body : panelText;
        const kind: Kind = u.kind === 'meta' ? (metaFirst ? 'metaFirst' : 'meta') : 'body';
        lines.push({ t: el(b, kind, u.kind === 'meta' ? sizes.meta : sizes.body, colour, inner), copy: b.text, meta: u.kind === 'meta' });
      }
    }
    const gap = r(0.35 * sizes.meta);
    let ly = fy + (variant === 'navy' ? 0 : pad);
    const placed: TextElement[] = [];
    for (const [i, l] of lines.entries()) {
      if (i) ly += gap;
      const p = set(l.t, l.copy, ix, inner, ly);
      if (!p) return undefined;
      // A date or a place is not broken over two lines while the details could take the content width.
      if (l.meta && p.lines > 1 && !fullWidth && variant !== 'navy') return undefined;
      placed.push(p.el);
      ly = p.el.y + p.el.height;
    }
    // The pill sits inside the card, under its copy. (It straddled the card's lower edge until the
    // blind panel of 2026-10-03, where all three judges read the straddle as an overlap, a slip.)
    const padBottom = !panel ? 0 : bridge ? pad + ctaPill!.height + r(0.6 * gapMin) : pad;
    const h = ly - fy + padBottom;
    // The cream block runs from the foot's top to the canvas's lower edge, full bleed (placed below).
    const cardShapes: ShapeElement[] = block ? [{ kind: 'rect', role: 'panel', surface: 'plate', x: 0, y: fy, width: W, height: h, color: panelFill }] : panel ? [{
      kind: 'roundRect', role: 'panel', primitive: 'card', surface: 'card', x: colX, y: fy, width: colW, height: h,
      radius: Math.max(4, r(g.cards.radiusShare * W)), color: panelFill,
      shadow: { color: g.cards.shadow.color, opacity: g.cards.shadow.opacity, blur: Math.min(80, r(g.cards.shadow.blurShare * W)), offsetY: Math.min(80, r(g.cards.shadow.offsetShare * W)) },
    }] : [];
    for (const t of placed) footItems.push({ el: t, shapes: [], top: t.y, bottom: t.y + t.height });
    footItems.push({ shapes: cardShapes, top: fy, bottom: fy + h });
    card = { x: colX, y: fy, width: colW, height: h, ix, inner };
    // On the cream block the call to action follows the details inside it.
    fy = block ? ly + gapMin : fy + h + gapMin;
  }
  for (const u of rest) {
    const b = u.blocks[0];
    if (u.kind === 'cta') {
      if (u !== ctaUnit || !ctaPill) {
        const t = el(b, 'cta', sizes.lead, block && card ? panelTitle : panel ? g.lead.color : spec.body, colW);
        const p = set(t, b.text, colX, colW, fy);
        if (!p) return undefined;
        footItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
        fy = p.el.y + p.el.height + gapMin;
        continue;
      }
      const { t, mm, padY, padX, height } = ctaPill;
      // Inside the card, the pill starts where the card's copy starts, a padding above its lower edge.
      const startX = bridge ? (rtl ? card!.ix + card!.inner : card!.ix) : rtl ? colX + colW : colX;
      const room = bridge ? card!.inner : colW;
      const py = bridge ? card!.y + card!.height - pad - height : fy;
      // The pill grows to the next grid line, so its free end lines up with the page.
      const natural = mm.lineWidth + 2 * padX + 2;
      const pw = Math.min(room, rtl ? startX - snapX(grid, startX - natural, 0.08 * W, 'down') : snapX(grid, startX + natural, 0.08 * W, 'up') - startX);
      const px = rtl ? startX - pw : startX;
      const pill: ShapeElement = { kind: 'roundRect', role: 'panel', surface: 'pill', x: px, y: py, width: pw, height, radius: r(height / 2), color: spec.pill };
      const tx: TextElement = { ...t, ...intBox({ x: px + Math.round((pw - mm.lineWidth - 4) / 2), y: py + padY, width: mm.lineWidth + 4, height: mm.height }), align: b.arabic ? 'right' : 'left' };
      footItems.push({ el: tx, shapes: [pill], top: py, bottom: py + height });
      fy = Math.max(fy, py + height + gapMin);
    } else {
      // A footer (a web address) or any other line, small, at the foot of the column.
      const colour = variant === 'navy' ? spec.body : block && card ? panelText : g.body.color;
      const p = set(el(b, u.kind === 'footer' ? 'footer' : 'body', u.kind === 'footer' ? sizes.footer : sizes.body, colour, colW), b.text, colX, colW, fy);
      if (!p) return undefined;
      footItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
      fy = p.el.y + p.el.height + r(0.015 * H);
    }
  }
  const footH = footItems.length ? Math.max(...footItems.map((i) => i.bottom)) : 0;
  const minGap = r(0.04 * H);
  const room = limit - headBottom - (footH ? minGap + footH : 0);
  if (room < 0) return undefined;

  // ----- the room left over, placed by composition -----------------------------------------------
  // No gap between two blocks (the logo, the head, the foot) is left wider than MAX_GAP_SHARE of the
  // height, which the negative-space metric counts as dead; what the gaps cannot take stays under the
  // foot. Navy lowers its head under the brand element at the top right; cream keeps the title at the
  // top and its block takes the room, down to the canvas's edge; the band sits under the logo and
  // leaves the room under the foot, where its pattern rises.
  const logoBottom = logo.y + logo.height;
  const gapCap = r(MAX_GAP_SHARE * H);
  const topCap = Math.max(0, gapCap - (top - logoBottom));
  const midCap = Math.max(0, gapCap - minGap);
  let left = room;
  const take = (cap: number) => {
    const v = Math.max(0, Math.min(left, Math.round(cap)));
    left -= v;
    return v;
  };
  let gTop = 0;
  let gMid = 0;
  if (variant === 'navy') {
    gTop = take(topCap);
    if (footH) gMid = take(midCap);
  } else if (variant === 'cream') {
    gTop = take(r(0.03 * H));
    if (footH) gMid = take(midCap);
    if (!card) gTop += take(topCap - gTop);
  } else {
    if (footH) gMid = take(r(0.06 * H));
    const underFoot = take(r(0.3 * H));
    if (footH) gMid += take(midCap - gMid);
    gTop = take(topCap);
    left += underFoot;
  }
  const footTop = headBottom + gTop + minGap + gMid;
  const shift = (i: Item, dy: number): Item => ({ ...i, top: i.top + dy, bottom: i.bottom + dy, ...(i.el ? { el: { ...i.el, y: i.el.y + dy } } : {}), shapes: i.shapes.map((sh) => ({ ...sh, y: sh.y + dy })) });
  const headPlaced = headItems.map((i) => shift(i, gTop));
  const footPlaced = footItems.map((i) => shift(i, footTop));
  for (const i of footPlaced) for (const sh of i.shapes) if (sh.surface === 'plate') sh.height = H - sh.y;
  let bandShape: ShapeElement | undefined;
  if (band) {
    const bandTop = top + gTop;
    bandShape = { kind: 'rect', role: 'panel', x: 0, y: bandTop, width: W, height: bandBottom + gTop - bandTop,
      color: g.cover.stops[g.cover.stops.length - 1].color, gradient: gradientOf(g.cover.stops, 0) };
    shapes.push(bandShape);
  }
  for (const i of [...headPlaced, ...footPlaced]) {
    shapes.push(...i.shapes);
    if (i.el) text.push(i.el);
  }
  if (band) shapes.push(footRulePrimitive(g, W, contentX, contentW, footY));

  // ----- every block reads on what is under it -------------------------------------------------
  const probe = { shapes, background: { color: background } } as Pick<StudioLayoutV2, 'shapes' | 'background'>;
  for (const t of text) {
    const under = surfaceColoursUnder(probe, t);
    if (under.every((c) => readsOn(t.color, c, t.fontSize, Boolean(t.bold)))) continue;
    const fallback = [spec.body, spec.title, '#FFFFFF' as Hex, g.body.color].find((c) => under.every((u) => readsOn(c, u, t.fontSize, Boolean(t.bold))));
    if (!fallback) return undefined;
    t.color = fallback;
  }

  // A one-line block other than the title keeps a box as wide as its line (its aligned edge where it
  // was), so the corners it does not reach stay free for the brand element.
  for (const t of text) {
    if (t.role === 'title') continue;
    const mm = measure(t, input.copy.text[t.copyIndex] ?? '');
    const w = mm.lineWidth + 8;
    if (mm.lines !== 1 || w >= t.width) continue;
    if (t.align === 'right') t.x += t.width - w;
    t.width = w;
  }

  const composition: CompositionRecord = { grammar: 'poster', variant };
  const layout: StudioLayoutV2 = {
    version: 2, width: W, height: H,
    grid: { margin: m, columns: 12, gutter, baseline: 8 },
    typeScale: { base: sizes.body, ratio: TYPE_RATIO },
    background: { color: background },
    shapes,
    text: text.sort((a, b) => a.copyIndex - b.copyIndex),
    logo: intBox(logo),
    composition,
  };
  balanceGrammarLines(layout, input);
  if (bandShape) trimBand(bandShape, layout, titleBox.copyIndex, m, rtl);
  const placedElement = placeBrandElement(layout, { variant, spec, clear, rtl, gapMin, footY: band ? footY : H });
  if (home && !placedElement?.home) return undefined;
  if (placedElement) layout.ornaments = [placedElement.element];
  // The composer promises hard QA's alignment check (a Sorani navy poster measured 0.688 against 0.70:
  // its pill's and gold bar's free edges lined up with nothing).
  if (computeLayoutMetrics(layout).alignmentScore < ALIGNMENT_PASS) return undefined;
  try {
    checkGrammarLayout(layout, clear);
  } catch (err) {
    if (err instanceof GrammarInfeasibleError) return undefined;
    throw err;
  }
  return layout;
}

/** A box grown by d on every side. */
const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d });

/**
 * The poster's visible brand element, clear by `gapMin` of everything that carries or frames content:
 * the copy, the cards, the pills, the title band and bar, the foot rule, and the logo's clear space.
 *
 * - navy: the sunburst at the top right, beside the logo and over the lowered title;
 * - cream: the sunburst standing on the Royal block's upper edge at the far side, a sun on the horizon;
 * - band: the guideline's triangle pattern rising from the foot (p.13) under the details, where the
 *   room is; the sunburst in a free corner when there is none.
 */
function placeBrandElement(layout: StudioLayoutV2, o: { variant: PosterVariant; spec: PosterVariantSpec; clear: Box; rtl: boolean; gapMin: number; footY: number }): { element: OrnamentElement; home: boolean } | undefined {
  const { width: W, height: H } = layout;
  // The cover's gradient carries the element. The cream block is a ground too: the sunburst stands on
  // its upper edge, a sun on the horizon, and never runs onto it (the renderer draws elements under
  // every shape but the cover's ground, so on the block it would be hidden).
  const block = layout.shapes.find((sh) => sh.surface === 'plate' && sh.width >= W);
  const content: Box[] = [...layout.text, ...layout.shapes.filter((sh) => sh.primitive !== 'cover_ground' && sh !== block)];
  const blocked = (b: Box) => hit(b, o.clear) || content.some((c) => hit(grow(c, o.gapMin), b)) || (block !== undefined && hit(b, block));
  const bottom = block ? block.y : o.footY === H ? H : o.footY - o.gapMin;
  if (o.variant === 'band' && o.spec.pattern) {
    const contentBottom = Math.max(...content.filter((c) => (c as ShapeElement).primitive !== 'foot_rule').map((c) => c.y + c.height));
    const h = Math.min(bottom - (contentBottom + o.gapMin), r(0.3 * H));
    const box: Box = { x: 0, y: bottom - h, width: W, height: h };
    if (h >= r(0.1 * H) && !blocked(box)) return { element: { kind: 'triangle_pattern', ...box, color: o.spec.pattern.color, opacity: o.spec.pattern.opacity, fade: 'to-top' }, home: true };
  }
  type Corner = NonNullable<OrnamentElement['corner']>;
  const near: Corner = o.rtl ? 'bottom-right' : 'bottom-left';
  const far: Corner = o.rtl ? 'bottom-left' : 'bottom-right';
  const corners: Corner[] = o.variant === 'navy' ? ['top-right', far, near] : o.variant === 'cream' ? [far, near, 'top-right'] : [far, near, 'top-right'];
  const cornerBox = (corner: Corner, size: number): Box => ({
    x: corner.endsWith('right') ? W - size : 0, y: corner.startsWith('bottom') ? bottom - size : 0, width: size, height: size,
  });
  // The first corner, in the composition's order, that holds a sunburst of a third of the short side;
  // else the largest that holds one at all.
  const short = Math.min(W, H);
  let best: { corner: Corner; size: number } | undefined;
  for (const corner of corners) {
    let size = r(0.62 * short);
    while (size >= r(0.2 * short) && blocked(cornerBox(corner, size))) size -= r(0.02 * short);
    if (size < r(0.2 * short)) continue;
    if (size >= r(0.33 * short)) {
      best = { corner, size };
      break;
    }
    if (!best || size > best.size) best = { corner, size };
  }
  if (!best || sunburstRadius({ width: best.size, height: best.size }) <= 0) return undefined;
  return {
    element: { kind: 'sunburst', ...cornerBox(best.corner, best.size), color: o.spec.sunburst.color, opacity: o.spec.sunburst.opacity, corner: best.corner },
    // The sunburst is home in its composition's first place (navy, cream), never for the band (its pattern is).
    home: !(o.variant === 'band' && o.spec.pattern) && best.corner === corners[0] && (block !== undefined || o.variant !== 'cream'),
  };
}

/**
 * The band runs from the edge the title starts at to a margin past its longest line, as the office's
 * title tabs do, unless that leaves only a sliver of the page beside it. A full-width band under a
 * short Sorani title made the poster too dense to pass the studio's negative-space floor.
 */
function trimBand(band: ShapeElement, layout: StudioLayoutV2, titleIndex: number, margin: number, rtl: boolean): void {
  const title = layout.text.find((t) => t.copyIndex === titleIndex);
  if (!title) return;
  const W = layout.width;
  const end = rtl ? title.x - margin : title.x + title.width + margin;
  const width = rtl ? W - Math.max(0, end) : Math.min(W, end);
  if (W - width < 0.15 * W) return;
  band.x = rtl ? W - width : 0;
  band.width = width;
}

function middle(stops: Array<{ at: number; color: Hex }>): Hex {
  return [...stops].sort((a, b) => Math.abs(a.at - 0.5) - Math.abs(b.at - 0.5))[0].color;
}
