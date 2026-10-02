import type { Box, CompositionRecord, Hex, OrnamentElement, ShapeElement, StudioLayoutV2, TextElement } from './layout-v2.js';
import { HOUSE_RULES, getSafeZoneBox, logoClearZone, minLogoWidth } from './house-rules.js';
import { measureTextGeometry, measureWrappedLines } from './render-layout-v2.js';
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
 * ADR-262: the client's poster compositions. The guideline (KAAE: the 2025 Excellence Edition) sets
 * the palette, the logo, the faces and the brand elements; the office's own published posts set how
 * a poster is composed: one dominant display title, a navy or cream ground or a full-width title
 * band, the details grouped at the foot, and a visible brand element. Every colour, face and
 * proportion comes from the reference's `pageGrammar.poster`; shared code names no client.
 *
 * - `navy`: the cover's navy gradient over the whole canvas, a big white serif title with a gold bar,
 *   a Sun lead, the details at the foot, a pill for the call to action, and a visible sunburst.
 * - `cream`: a cream ground, a big Royal serif title, a Royal card for the details, a pill, a gold sunburst.
 * - `band`: the white page with a full-width gradient band holding the display title, the details on
 *   a KAAE Blue card, a pill, and the gradient rule at the foot.
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

interface PosterSizes { title: number; titleStep: number; lead: number; meta: number; body: number; footer: number; label: number }

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
  return {
    title: step(best.n), titleStep: best.n, lead: step(detail), meta: step(detail), body: best.body,
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
    for (let size = hi; size >= lo; size -= 2) {
      const sizes = posterSizes(g, W, size, detailMin);
      if (!sizes || sizes.title > hi + 1 || sizes.title < lo) continue;
      // The details in their column beside the brand element, else across the content width.
      for (const fullWidth of [false, true]) {
        const layout = attemptPoster(input, units, sizes, P, fullWidth);
        if (!layout) continue;
        // The poster fills its canvas: the largest title that fits with its negative space between the
        // studio's floor (a crowded poster fails the same metric) and the poster's ceiling.
        const ns = negativeSpaceOf(layout, input);
        if (ns <= P.negativeSpaceMax && ns >= floor) return layout;
        if (ns >= floor) fallback ??= layout;
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

function attemptPoster(input: ComposeGrammarInput & { variant: PosterVariant }, units: GrammarUnit[], sizes: PosterSizes, P: PosterGrammar, fullWidth: boolean): StudioLayoutV2 | undefined {
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

  // ----- the ground --------------------------------------------------------------------------
  const shapes: ShapeElement[] = [];
  const text: TextElement[] = [];
  const ornaments: OrnamentElement[] = [];
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
  const el = (b: GrammarUnit['blocks'][number], kind: Kind, size: number, color: Hex, w: number): TextElement => {
    const display = kind === 'title' || kind === 'metaFirst';
    const lhRange = b.arabic ? HOUSE_RULES.lineHeight.arabic : HOUSE_RULES.lineHeight.latin;
    const wanted = b.arabic ? (display ? 1.6 : 1.7) : kind === 'title' ? 1.2 : kind === 'lead' ? 1.35 : display ? 1.2 : 1.45;
    const family = b.arabic
      ? (display || kind === 'label' || kind === 'cta' ? arabicDisplay : arabicBody)
      : kind === 'title' ? g.title.fontFamily : kind === 'metaFirst' ? g.stat.fontFamily : kind === 'lead' ? g.lead.fontFamily : g.body.fontFamily;
    const tracking = b.arabic ? 0 : kind === 'title' ? (g.title.letterSpacing ?? 0) : kind === 'label' ? (g.header.label.letterSpacing ?? 0) : 0;
    const italic = !b.arabic && kind === 'lead' && variant !== 'navy' && Boolean(g.lead.italic);
    const bold = display || kind === 'label' || kind === 'cta';
    return {
      copyIndex: b.copyIndex, role: b.role, x: 0, y: 0, width: w, height: 10, fontSize: size,
      lineHeight: Math.min(lhRange.max, Math.max(lhRange.min, wanted)),
      ...(tracking ? { letterSpacing: Math.max(-HOUSE_RULES.letterSpacingMaxEm, Math.min(HOUSE_RULES.letterSpacingMaxEm, tracking)) } : {}),
      fontFamily: family, color, align: b.arabic ? 'right' : align,
      ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}), ...(b.arabic ? { rtl: true, letterSpacing: 0 } : {}),
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

  // ----- the head: everything up to the title and the lead after it ----------------------------
  const titleAt = flow.findIndex((u) => u.kind === 'title');
  const headEnd = flow[titleAt + 1]?.kind === 'lead' ? titleAt + 1 : titleAt;
  const head = flow.slice(0, headEnd + 1);
  const foot = flow.slice(headEnd + 1);
  const band = variant === 'band';
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
      const p = set(el(b, 'title', sizes.title, spec.title, contentW), b.text, contentX, contentW, y);
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
      const p = set(el(b, u.kind === 'lead' ? 'lead' : u.kind === 'label' ? 'label' : 'body', u.kind === 'lead' ? sizes.lead : sizes.body, colour, contentW), b.text, contentX, contentW, y);
      if (!p) return undefined;
      headItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
      y = p.el.y + p.el.height + r((before ? 0.02 : 0.03) * H);
    }
  }
  if (!titleBox) return undefined;
  const headBottom = Math.max(...headItems.map((i) => i.bottom));

  // ----- the foot: the details, grouped, with the call to action as a pill ---------------------
  const footY = band ? H - r(0.75 * m) - Math.max(3, r(g.footRule.heightShare * W)) : H;
  const limit = band ? Math.min(safe.y + safe.height, footY - r(0.03 * W)) : safe.y + safe.height;
  const hasBody = foot.some((u) => u.kind === 'body');
  const colShare = fullWidth ? 1 : wide ? 0.5 : hasBody ? 0.8 : 0.64;
  const colW = r(colShare * contentW);
  const colX = rtl ? contentX + contentW - colW : contentX;
  const pad = r(0.035 * W);
  const panel = variant !== 'navy';
  const panelFill = variant === 'cream' ? spec.panel! : g.cards.brand.fill;
  const panelTitle = variant === 'cream' ? spec.panelTitle! : g.cards.brand.title;
  const panelText = variant === 'cream' ? spec.panelText! : g.cards.brand.text;
  const footItems: Item[] = [];
  let fy = 0;
  const details = foot.filter((u) => u.kind === 'meta' || u.kind === 'body' || u.kind === 'lead');
  const rest = foot.filter((u) => !details.includes(u));
  if (details.length) {
    const inner = panel ? colW - 2 * pad : colW;
    const ix = panel ? colX + pad : colX;
    const lines: Array<{ t: TextElement; copy: string; meta: boolean }> = [];
    let firstMeta = true;
    for (const u of details) {
      for (const b of u.blocks) {
        const metaFirst = u.kind === 'meta' && firstMeta && !b.arabic;
        if (u.kind === 'meta') firstMeta = false;
        const colour = u.kind === 'meta' && (metaFirst || b.role === 'date') ? (panel ? panelTitle : spec.detail) : panel ? panelText : spec.body;
        const kind: Kind = u.kind === 'meta' ? (metaFirst ? 'metaFirst' : 'meta') : 'body';
        lines.push({ t: el(b, kind, u.kind === 'meta' ? sizes.meta : sizes.body, colour, inner), copy: b.text, meta: u.kind === 'meta' });
      }
    }
    const gap = r(0.35 * sizes.meta);
    let ly = fy + (panel ? pad : 0);
    const placed: TextElement[] = [];
    for (const [i, l] of lines.entries()) {
      if (i) ly += gap;
      const p = set(l.t, l.copy, ix, inner, ly);
      if (!p) return undefined;
      // A date or a place is not broken over two lines while the details could take the content width.
      if (l.meta && p.lines > 1 && !fullWidth) return undefined;
      placed.push(p.el);
      ly = p.el.y + p.el.height;
    }
    const h = ly - fy + (panel ? pad : 0);
    const cardShapes: ShapeElement[] = panel ? [{
      kind: 'roundRect', role: 'panel', primitive: 'card', surface: 'card', x: colX, y: fy, width: colW, height: h,
      radius: Math.max(4, r(g.cards.radiusShare * W)), color: panelFill,
      shadow: { color: g.cards.shadow.color, opacity: g.cards.shadow.opacity, blur: Math.min(80, r(g.cards.shadow.blurShare * W)), offsetY: Math.min(80, r(g.cards.shadow.offsetShare * W)) },
    }] : [];
    for (const t of placed) footItems.push({ el: t, shapes: [], top: t.y, bottom: t.y + t.height });
    footItems.push({ shapes: cardShapes, top: fy, bottom: fy + h });
    fy += h + r(0.025 * H);
  }
  for (const u of rest) {
    const b = u.blocks[0];
    if (u.kind === 'cta') {
      const t = el(b, 'cta', sizes.lead, spec.pillText, colW);
      const mm = measure(t, b.text);
      const padX = r(0.9 * sizes.lead);
      const padY = r(0.45 * sizes.lead);
      if (mm.lineWidth + 2 * padX > colW + 2) {
        const p = set(t, b.text, colX, colW, fy);
        if (!p) return undefined;
        footItems.push({ el: p.el, shapes: [], top: p.el.y, bottom: p.el.y + p.el.height });
        fy = p.el.y + p.el.height + r(0.02 * H);
        continue;
      }
      // The pill grows to the next grid line, so its free end lines up with the page.
      const natural = mm.lineWidth + 2 * padX + 2;
      const pw = Math.min(colW, rtl ? colX + colW - snapX(grid, colX + colW - natural, 0.08 * W, 'down') : snapX(grid, colX + natural, 0.08 * W, 'up') - colX);
      const px = rtl ? colX + colW - pw : colX;
      const pill: ShapeElement = { kind: 'roundRect', role: 'panel', surface: 'card', x: px, y: fy, width: pw, height: mm.height + 2 * padY,
        radius: r((mm.height + 2 * padY) / 2), color: spec.pill };
      const tx: TextElement = { ...t, ...intBox({ x: px + Math.round((pw - mm.lineWidth - 4) / 2), y: fy + padY, width: mm.lineWidth + 4, height: mm.height }), align: b.arabic ? 'right' : 'left' };
      footItems.push({ el: tx, shapes: [pill], top: fy, bottom: fy + pill.height });
      fy += pill.height + r(0.02 * H);
    } else {
      // A footer (a web address) or any other line, small, at the foot of the column.
      const colour = variant === 'navy' ? spec.body : g.body.color;
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

  // ----- the room left over: some above the head, the rest between head and foot ---------------
  // With no details the head is set a little above the middle of its room, as a cover's title stands.
  // A band poster with no details sets its head low, so the room is above the band, where the brand
  // element stands, not an empty foot under a short lead.
  const gapAbove = footH ? r(Math.min(room * 0.3, 0.1 * H)) : band ? r(room * 0.82) : r(room * 0.42);
  const footTop = footH ? limit - footH : 0;
  const shift = (i: Item, dy: number): Item => ({ ...i, top: i.top + dy, bottom: i.bottom + dy, ...(i.el ? { el: { ...i.el, y: i.el.y + dy } } : {}), shapes: i.shapes.map((sh) => ({ ...sh, y: sh.y + dy })) });
  const headPlaced = headItems.map((i) => shift(i, gapAbove));
  const footPlaced = footItems.map((i) => shift(i, footTop));
  let bandShape: ShapeElement | undefined;
  if (band) {
    const bandTop = top + gapAbove;
    bandShape = { kind: 'rect', role: 'panel', x: 0, y: bandTop, width: W, height: bandBottom + gapAbove - bandTop,
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

  // ----- the visible brand element: the sunburst in the largest free corner --------------------
  const sun = spec.sunburst;
  const blocked = (b: Box) => text.some((t) => hit(t, b)) || hit(b, clear) || (bandShape !== undefined && hit(bandShape, b));
  const cornerBox = (corner: OrnamentElement['corner'], size: number): Box => {
    const right = corner!.endsWith('right');
    const bottom = corner!.startsWith('bottom');
    const yBottom = band ? footY - r(0.01 * H) : H;
    return { x: right ? W - size : 0, y: bottom ? yBottom - size : 0, width: size, height: size };
  };
  const corners: Array<NonNullable<OrnamentElement['corner']>> = rtl ? ['bottom-left', 'top-right', 'bottom-right'] : ['bottom-right', 'top-right', 'bottom-left'];
  // The first corner, in the order of preference (the foot, away from the start of the reading),
  // that holds a sunburst of a third of the short side; else the largest that holds one at all.
  let best: { corner: NonNullable<OrnamentElement['corner']>; size: number } | undefined;
  const short = Math.min(W, H);
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
  if (best && sunburstRadius({ width: best.size, height: best.size }) > 0) {
    ornaments.push({ kind: 'sunburst', ...cornerBox(best.corner, best.size), color: sun.color, opacity: sun.opacity, corner: best.corner });
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
    ...(ornaments.length ? { ornaments } : {}),
    composition,
  };
  balanceGrammarLines(layout, input);
  if (bandShape) trimBand(bandShape, layout, titleBox.copyIndex, m, rtl);
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
