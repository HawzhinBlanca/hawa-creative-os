import { resolveModel } from '@hawa/domain';
import type { StudioLayoutV2 } from './layout-v2.js';
import { evaluateDesignMetrics, type DesignMetricsReport } from './design-metrics.js';
import { renderLayoutV2, measureWrappedLines, balancedBoxWidths, admittedFontFace, findAdmittedFontFace, type RenderLayoutOptions } from './render-layout-v2.js';
import { correctFontsThatCannotDrawTheCopy, centerSeparatorsInGaps, findAsymmetricSeparators } from './layout-generator-v3.js';
import { generateBoxGroundedCritique, type BoxCritiqueResult } from './box-critique-v3.js';
import { refineCandidate, type RefinementCandidateResult } from './refinement-engine-v3.js';
import {
  comparePairWithOrderSwap,
  createDegradedCanaryLayout,
  type CandidateJudgeInput,
  type PairwiseMatchResult,
} from './pairwise-judge-v3.js';
import type { OpenAiStudioClient } from './openai-studio-client.js';
import { normalizeStudioLayout, fitLogoToAspect } from './studio-normalize.js';
import { ExemplarRetrievalIndex, type ExemplarRetrievalMatch } from './exemplar-retrieval.js';
import { evaluateHardQa, type HardQaContext, type HardQaOutcome } from './hard-qa.js';
import { computeLayoutMetrics } from './layout-metrics.js';
import type { ClientReference } from './client-reference.js';
import { HOUSE_RULES, FORBIDDEN_ART_WORDS, minLogoWidth, logoClearZone, requiredContrast } from './house-rules.js';
import { calculateLuminanceContrastRatio, declaredBackgroundColour, hexToLuminance } from './composite-contrast.js';
import { normalizeHex } from './validate-layout-v2.js';
import { applyStyleSpec, colourDecisionsOnly, composeStyleSpec, layoutDefectCount, MOVEMENT_DECISIONS, ornamentForStyle, withoutDecision, type StyleSpec } from './style-spec.js';
import { photosMayOverlap } from './photo-cutout.js';

/**
 * The v3 pipeline's decisions, in one place, for both of its callers.
 *
 * Production's studio and the qualification runner used to implement these steps separately, and
 * they drifted: the studio ran its own v2 critique, revision and judge around the v3 generator,
 * so no qualification ever measured what a client would receive. Both now call these functions,
 * so the qualification measures the code that decides a client's design.
 *
 * Every function here renders and scores with the real copy. Without it the renderer draws
 * "Sample copy block N" in every block, and earlier qualification runs critiqued and judged
 * exactly that.
 */

export type CopyScriptV3 = 'latin' | 'arabic';

export interface PipelineV3Copy {
  /** The text each block carries, by copyIndex. */
  text: Record<number, string>;
  /** The script of each block, by copyIndex. Detected from the text when absent. */
  scripts?: Record<number, CopyScriptV3>;
}

export interface RankedCandidateV3 {
  /** Position in the generator's output; stable across ranking. */
  sourceIndex: number;
  layout: StudioLayoutV2;
  metrics: DesignMetricsReport;
  /** A render the caller already has — with art, for instance. Rendered from the copy when absent. */
  renderedPng?: Buffer;
  /** Production's hard QA on this layout, when the caller supplied its context. */
  hardQa?: HardQaOutcome;
}

export interface PipelineV3CallOptions {
  client?: OpenAiStudioClient;
  /** Overrides the active tier's model for this role. */
  model?: string;
  /** The client's style reference, shown to the critique and the judge. */
  reference?: ClientReference;
  /** Exact client logo for fallback and canary renders. */
  renderOptions?: RenderLayoutOptions;
  /** Candidate-specific assets, also used for its degraded canary. */
  renderOptionsForCandidate?: (candidate: RankedCandidateV3) => RenderLayoutOptions;
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

function scriptOf(copy: PipelineV3Copy, copyIndex: number): CopyScriptV3 {
  return copy.scripts?.[copyIndex] ?? (ARABIC_SCRIPT.test(copy.text[copyIndex] ?? '') ? 'arabic' : 'latin');
}

/**
 * Maps a family the model chose onto the admitted set, by the role, script and weight of its block.
 * Body and footer copy use the formal body faces; display copy keeps an admitted display face.
 *
 * The set used to be written out here: Cairo, Amiri or Noto Sans Arabic for a right-to-left display
 * block, Cinzel, Playfair Display or Verdana for a Latin one. It now comes from render-fonts.json
 * and is measured against the real font files, so adding or removing a family is a change to that
 * file. The Latin answers are the same ones. The Sorani answer for Cairo is not: it is refused
 * outright rather than kept and corrected later, because its file has no glyph for ڕ ڵ ۆ ێ ە.
 *
 * The weight only decides the fallback. A family the design asked for and that is admitted keeps
 * the block even when it has no file for that weight, so a style spec's serif stays a serif;
 * `sanitizeFontsV3` then drops the weight rather than the typeface.
 */
export function admittedFontFor(
  font: string,
  script: CopyScriptV3,
  role?: string,
  options: { bold?: boolean; registryPath?: string } = {}
): string {
  return admittedFontFace(font, {
    script,
    role: role === 'body' || role === 'footer' ? 'body' : 'display',
    bold: options.bold,
    registryPath: options.registryPath,
  });
}

/**
 * Puts every block in an admitted face for its own script, then swaps any face that cannot draw
 * the block's actual characters. Mutates and returns the layout.
 *
 * Decided per block rather than per brief, so a bilingual design keeps its English display face
 * on English blocks and its Sorani face on Sorani ones. Direction is decided here too, from the
 * copy: a Sorani block the model left unmarked would otherwise render left-to-right, and the
 * coverage check — which reads a block's script from its direction — would skip it entirely.
 *
 * This is still the single enforcement point, and it is where the block's weight is made honest.
 * A design may now choose among the admitted faces for its script, and a chosen face is kept even
 * when it has no file for the weight asked for: what goes instead is the weight. The renderer
 * already drew those blocks regular, because `fontFaceSupports` gates the axis it emits, while the
 * deck set a real bold in Canva — so the preview the judge scored and the design the client opened
 * were set in different weights. The weight is dropped last, after the coverage swap, because that
 * swap can change which family the block ends up in.
 */
export function sanitizeFontsV3(layout: StudioLayoutV2, copy: PipelineV3Copy): StudioLayoutV2 {
  const roleOf = (t: { role?: string }) => (t.role === 'body' || t.role === 'footer' ? 'body' : 'display');
  for (const t of layout.text) {
    const script = scriptOf(copy, t.copyIndex);
    t.rtl = script === 'arabic';
    t.fontFamily = admittedFontFor(t.fontFamily, script, t.role, { bold: t.bold }) as any;
  }
  correctFontsThatCannotDrawTheCopy(layout, copy.text);
  for (const t of layout.text) {
    if (!t.bold) continue;
    const face = findAdmittedFontFace(t.fontFamily, {
      script: scriptOf(copy, t.copyIndex),
      role: roleOf(t),
    });
    if (face && !face.hasBold) t.bold = false;
  }
  return layout;
}

/**
 * The format label exemplar retrieval matches on. The exemplars are labelled 1:1 and 4:5, and a
 * matching label earns a retrieval bonus; the qualification used to call every non-square canvas
 * 4:5, which gave landscape banners and A4 documents a bonus for a format they are not.
 */
export function formatKeyV3(width: number, height: number): string {
  const r = width / height;
  if (Math.abs(r - 1) < 0.02) return '1:1';
  if (Math.abs(r - 0.8) < 0.03) return '4:5';
  if (Math.abs(r - 9 / 16) < 0.03) return '9:16';
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(r - Math.SQRT1_2) < 0.03) return 'A4';
  return r < 1 ? 'portrait' : 'landscape';
}

let sharedRetrievalIndex: ExemplarRetrievalIndex | null = null;

/** P02: the top owner-confirmed exemplars for a brief, by local embedding. Free. */
export function retrieveExemplarsV3(
  query: { text: string; width: number; height: number },
  index?: ExemplarRetrievalIndex
): ExemplarRetrievalMatch[] {
  const retrieval = (index || (sharedRetrievalIndex ??= new ExemplarRetrievalIndex())).retrieveTopExemplars(
    { text: query.text, format: formatKeyV3(query.width, query.height), category: 'standards' },
    3
  );
  return retrieval.retrievedExemplars;
}

type Rect = { x: number; y: number; width: number; height: number };

const intersects = (a: Rect, b: Rect) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const overlapsXRect = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x;

/** Moves and, only if it cannot fit, shrinks a box so it lies inside `area`. */
function fitInside(box: Rect, area: Rect): void {
  box.width = Math.min(box.width, area.width);
  box.height = Math.min(box.height, area.height);
  box.x = Math.min(Math.max(box.x, area.x), area.x + area.width - box.width);
  box.y = Math.min(Math.max(box.y, area.y), area.y + area.height - box.height);
}

/**
 * The brand colour nearest to `colour`, by the "redmean" weighted distance — or `colour` itself if
 * it is already a brand colour. A slightly-off gold becomes the brand gold; light stays light and
 * dark stays dark, so contrast relationships survive the snap.
 */
export function nearestPaletteColour(colour: string, palette: string[]): string {
  if (!colour || palette.length === 0) return colour;
  const wanted = normalizeHex(colour);
  if (palette.some((p) => normalizeHex(p) === wanted)) return colour;
  const rgb = (hex: string) => {
    const h = normalizeHex(hex).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = rgb(wanted);
  if ([r1, g1, b1].some((c) => Number.isNaN(c))) return palette[0];
  let best = palette[0];
  let bestDistance = Infinity;
  for (const p of palette) {
    const [r2, g2, b2] = rgb(p);
    const rMean = (r1 + r2) / 2;
    const d = (2 + rMean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rMean) / 256) * (b1 - b2) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  return best;
}

const BANNED_ART_WORD = new RegExp(`\\b(?:${FORBIDDEN_ART_WORDS.join('|')})\\b`, 'i');
/** Words that open a phrase placing or excluding something: "behind hero text", "no text". */
const ART_PHRASE_OPENER = /\b(?:behind|under|beneath|below|above|over|around|near|beside|framing|for|with|without|no|avoiding|excluding|free of)\b/gi;

/**
 * An art prompt the validator accepts, or null if nothing of it survives. Each comma-separated
 * clause naming a banned word loses the phrase that names it — from the nearest "behind", "no",
 * "without" and the like before the word — and is dropped if that leaves nothing clean. The
 * production model placed its art "behind hero text" in 2 of 20 T5 designs, and QA rejected both.
 */
export function sanitizeArtPrompt(prompt: string): string | null {
  const clauses: string[] = [];
  for (const raw of prompt.split(/[,;]/)) {
    let clause = raw.trim();
    const banned = clause.match(BANNED_ART_WORD);
    if (banned && banned.index !== undefined) {
      const openers = [...clause.slice(0, banned.index).matchAll(ART_PHRASE_OPENER)];
      const cut = openers.length ? openers[openers.length - 1].index! : 0;
      clause = clause.slice(0, cut).trim();
    }
    if (clause && !BANNED_ART_WORD.test(clause)) clauses.push(clause);
  }
  return clauses.length ? clauses.join(', ') : null;
}

/**
 * Conforms a layout to the house rules production's QA checks, wherever the fix is unambiguous:
 * leading and tracking to their allowed ranges, every text box inside the safe area and every
 * shape inside the canvas, a box grown when its copy no longer fits at the new leading (never into
 * another element), and the logo shrunk — never below its minimum — until its clear space holds no
 * text or rule. What cannot be fixed without redesigning is left for QA to reject and refinement
 * to repair. Mutates and returns the layout.
 *
 * Measured before this existed: every Sorani design the production model made had Latin leading
 * (all ten), 12 of 20 designs had text inside the logo's clear space, and 6 had a text box
 * outside the safe area — often by a single pixel of rounding.
 */
export function conformToHouseRules(
  layout: StudioLayoutV2,
  copy: PipelineV3Copy,
  palette?: string[]
): StudioLayoutV2 {
  // Brand colours only: every colour QA checks is snapped to the nearest one in the palette.
  if (palette && palette.length) {
    layout.background.color = nearestPaletteColour(layout.background.color, palette);
    if (layout.art?.scrim) layout.art.scrim.color = nearestPaletteColour(layout.art.scrim.color, palette);
    for (const s of layout.shapes || []) {
      s.color = nearestPaletteColour(s.color, palette);
      if (s.strokeColor) s.strokeColor = nearestPaletteColour(s.strokeColor, palette);
    }
    for (const tx of layout.text) tx.color = nearestPaletteColour(tx.color, palette);
  }

  // Generated art names no lettering, marks or people; art that cannot be described without them
  // is dropped — it is ornament, and a banned word means no design is delivered at all.
  if (layout.art?.source === 'generated' && layout.art.prompt && BANNED_ART_WORD.test(layout.art.prompt)) {
    const prompt = sanitizeArtPrompt(layout.art.prompt);
    if (prompt) layout.art.prompt = prompt;
    else layout.art = undefined;
  }

  const W = layout.width;
  const H = layout.height;
  const m = layout.grid.margin;

  for (const t of layout.text) {
    const script = scriptOf(copy, t.copyIndex);
    const range = HOUSE_RULES.lineHeight[script];
    t.lineHeight = Math.min(Math.max(t.lineHeight || range.min, range.min), range.max);
    if (script === 'arabic' || t.role === 'body') {
      t.letterSpacing = 0;
    } else if (typeof t.letterSpacing === 'number') {
      t.letterSpacing = Math.min(Math.max(t.letterSpacing, -HOUSE_RULES.letterSpacingMaxEm), HOUSE_RULES.letterSpacingMaxEm);
    }
  }

  // The title is at least 2.2x the body size. Models miss it by fractions of a pixel (48px against
  // a required 48.4px), so the title is raised to the rule; the box is resized for it below.
  const bodySize = Math.max(0, ...layout.text.filter((t) => t.role === 'body').map((t) => t.fontSize));
  if (bodySize > 0) {
    const minTitle = Math.ceil(HOUSE_RULES.titleToBodyMin * bodySize);
    for (const t of layout.text) if (t.role === 'title' && t.fontSize < minTitle) t.fontSize = minTitle;
  }

  // The rest of the ladder QA enforces (title > subtitle >= date/venue >= body >= footer), settled
  // the same way from the body up: the cheap tier set the date at 16px under 20px body copy (task
  // 1f392e16, 2026-09-18), a defect QA reported only once the overlap hiding it was fixed.
  const sizeOf = (...roles: string[]) =>
    Math.max(0, ...layout.text.filter((t) => roles.includes(t.role)).map((t) => t.fontSize));
  if (bodySize > 0) {
    for (const t of layout.text) {
      if ((t.role === 'date' || t.role === 'venue') && t.fontSize < bodySize) t.fontSize = bodySize;
      if (t.role === 'footer' && t.fontSize > bodySize) t.fontSize = bodySize;
    }
  }
  const dateVenueSize = sizeOf('date', 'venue');
  for (const t of layout.text) if (t.role === 'subtitle' && t.fontSize < dateVenueSize) t.fontSize = dateVenueSize;
  const subtitleSize = sizeOf('subtitle');
  for (const t of layout.text) {
    if (t.role === 'title' && subtitleSize > 0 && t.fontSize <= subtitleSize) t.fontSize = Math.ceil(subtitleSize * 1.25);
  }

  const safe: Rect = { x: m, y: m, width: W - 2 * m, height: H - 2 * m };
  for (const t of layout.text) fitInside(t, safe);
  for (const s of layout.shapes || []) fitInside(s, { x: 0, y: 0, width: W, height: H });

  // The logo is at least its minimum width: 8% of the canvas, never under 100px. The studio's
  // normaliser enforced only the 100px, so on a 1920px banner a 146px logo passed preparation and
  // failed QA. Grown in place, keeping its top edge and the side it is attached to.
  if (layout.logo && layout.logo.width > 0 && layout.logo.height > 0 && layout.logo.width < minLogoWidth(W)) {
    const l = layout.logo;
    const aspect = l.width / l.height;
    const w = minLogoWidth(W);
    const anchor = Math.abs(l.x - m) <= 2 ? 'left' : Math.abs(l.x + l.width - (W - m)) <= 2 ? 'right' : 'centre';
    const x = anchor === 'left' ? l.x : anchor === 'right' ? l.x + l.width - w : l.x + l.width / 2 - w / 2;
    layout.logo = { x: Math.round(x), y: l.y, width: w, height: Math.round(w / aspect) };
    fitInside(layout.logo, safe);
  }

  // The logo's clear space: shrink the emblem, keeping the edge it is attached to.
  const logo = layout.logo;
  if (logo && logo.width > 0 && logo.height > 0) {
    const blockers: Rect[] = [...layout.text, ...(layout.shapes || []).filter((s) => s.role === 'rule')];
    const crowded = (l: Rect) => blockers.some((b) => intersects(b, logoClearZone(l)));
    if (crowded(logo)) {
      const aspect = logo.width / logo.height;
      const anchor =
        Math.abs(logo.x - m) <= 2 ? 'left' : Math.abs(logo.x + logo.width - (W - m)) <= 2 ? 'right' : 'centre';
      const centreX = logo.x + logo.width / 2;
      for (let w = Math.floor(logo.width) - 1; w >= minLogoWidth(W); w -= 1) {
        const x = anchor === 'left' ? logo.x : anchor === 'right' ? logo.x + logo.width - w : centreX - w / 2;
        const candidate = { x: Math.round(x), y: logo.y, width: w, height: Math.round(w / aspect) };
        if (!crowded(candidate)) {
          layout.logo = candidate;
          break;
        }
      }
    }
  }

  const settle = (minSqueeze: number) => {
    // A logo whose clear space still meets text moves within the gap it sits in: up when text
    // below crowds it, down when text above does — never past a block that shares its column, and
    // never out of the safe area. (The cheap tier put a 154px banner logo at y=203 with 88px free
    // above it, its clear space 13px into the eyebrow; a first version searched the whole canvas
    // and could carry a bottom logo over every block to the top.)
    if (layout.logo) {
      const m = layout.grid.margin;
      const l = layout.logo;
      const blockers: Rect[] = [...layout.text, ...(layout.shapes || []).filter((s) => s.role === 'rule')];
      const clearAt = (y: number) => !blockers.some((b) => intersects(b, logoClearZone({ ...l, y })));
      if (!clearAt(l.y)) {
        const sameColumn = blockers.filter((b) => overlapsXRect(b, l));
        // A logo set in a card or band stays in it: lifted 45px to clear its zone, a logo in the
        // corner of a header card ended up straddling the card's edge (dev tier, brief_16).
        const home = (layout.shapes || []).find(
          (s) =>
            s.role === 'panel' && !(s.width >= 0.98 * W && s.height >= 0.98 * H) &&
            l.x >= s.x && l.x + l.width <= s.x + s.width && l.y >= s.y && l.y + l.height <= s.y + s.height
        );
        const ceiling = Math.max(m, home ? home.y : m, ...sameColumn.filter((b) => b.y + b.height <= l.y).map((b) => b.y + b.height));
        const floor = Math.min(
          H - m - l.height,
          home ? home.y + home.height - l.height : H,
          ...sameColumn.filter((b) => b.y >= l.y + l.height).map((b) => b.y - l.height)
        );
        const crowdedBelow = blockers.some((b) => b.y >= l.y && intersects(b, logoClearZone(l)));
        let moved = false;
        if (crowdedBelow) {
          for (let y = l.y - 1; y >= ceiling && !moved; y--) if (clearAt(y)) { layout.logo = { ...l, y }; moved = true; }
        } else {
          for (let y = l.y + 1; y <= floor && !moved; y++) if (clearAt(y)) { layout.logo = { ...l, y }; moved = true; }
        }
      }
    }

    // Vertical space is inserted where the layout needs it — a box whose copy no longer fits at the
    // house leading, a block that collides with the one above it or with the logo's clear space —
    // by moving everything below that line down. Order and horizontal structure are kept, and
    // nothing is moved if the content would leave the safe area; such layouts are left for QA to
    // reject and refinement to repair.
    const safeBottom = H - layout.grid.margin;
    const fullBleed = (s: Rect) => s.width >= 0.98 * W && s.height >= 0.98 * H;
    const isShape = (o: object) => (layout.shapes || []).includes(o as any);
    const isPanel = (o: object) => isShape(o) && (o as { role?: string }).role === 'panel';
    // The design's usual spacing between stacked blocks: moved blocks keep at least this much, and a
    // larger gap absorbs the push instead of passing it on. Shifting everything below the line by
    // the full amount failed whenever the footer sat on the bottom margin — even with a 321px gap
    // above it (the Kurdish banner that failed QA in every run).
    const rhythm = (() => {
      const stack = [...layout.text].sort((a, b) => a.y - b.y);
      const gaps: number[] = [];
      for (let i = 1; i < stack.length; i++) {
        const gap = stack[i].y - (stack[i - 1].y + stack[i - 1].height);
        if (gap >= 0) gaps.push(gap);
      }
      gaps.sort((a, b) => a - b);
      return Math.max(12, gaps.length ? gaps[Math.floor(gaps.length / 2)] : 24);
    })();
    /**
     * Inserts `delta` of vertical space at the line `atY` for `cause`: a block clashing with what is
     * above it, which moves down by `delta` with the blocks that start inside the band
     * [atY, atY + delta) — order kept, so a pre-existing overlap stays visible to the pass that
     * resolves it; or, with `growing`, a box heightened by `delta` at its bottom edge `atY`. Below
     * that, a block moves only as far as a moved block above it, in its column, now forces it.
     * `fixed` blocks never move. Returns false, changing nothing, if anything moved would leave the
     * safe area or run into something it did not already overlap.
     */
    const insertSpace = (
      atY: number,
      delta: number,
      cause: Rect,
      opts: { growing?: boolean; fixed?: Rect[] } = {}
    ): boolean => {
      if (delta <= 0) return true;
      const growing = opts.growing ? cause : undefined;
      const fixed = new Set<object>(opts.fixed || []);
      const logo = layout.logo && !fixed.has(layout.logo) ? layout.logo : undefined;
      const cs = logo ? Math.ceil(HOUSE_RULES.logo.clearSpaceShareOfHeight * logo.height) : 0;
      // The logo claims its clear space: moved text and rules never close up into it.
      const span = (r: Rect): Rect => (r === logo ? { ...r, x: r.x - cs, width: r.width + 2 * cs } : r);
      const keepsClear = (r: Rect) => layout.text.includes(r as any) || (isShape(r) && (r as { role?: string }).role === 'rule');
      const minGap = (a: Rect, b: Rect) => ((a === logo && keepsClear(b)) || (b === logo && keepsClear(a)) ? cs : 0);
      const panels = (layout.shapes || []).filter((s) => !fullBleed(s) && s.role === 'panel');
      const blocks: Rect[] = [
        ...layout.text.filter((o) => o !== growing),
        ...(layout.shapes || []).filter((s) => !fullBleed(s)),
        // Client photographs move with the composition like any other block, so text pushed down
        // by a grown title never slides onto a portrait.
        ...(layout.photos || []),
        ...(logo ? [logo] : []),
      ]
        .filter((o) => o.y >= atY && !fixed.has(o))
        // A panel goes before the blocks level with its top, so they can move with it.
        .sort((a, b) => a.y - b.y || Number(isPanel(b)) - Number(isPanel(a)));
      // A panel holds a block mostly inside it, as a footer band holds its footer — or a card holds
      // a title overhanging its edge by 17px, which moved off the card without it (dev tier, brief_16).
      const holds = (p: Rect, b: Rect) => {
        if (p === b || !isPanel(p) || !overlapsXRect(b, p)) return false;
        return Math.min(b.y + b.height, p.y + p.height) - Math.max(b.y, p.y) >= 0.5 * b.height;
      };

      // Push-down cascade: a block a panel holds moves with the panel; any other block moves only as
      // far as a moved block above it, in its column, now forces it. A moved block keeps its gap to
      // the one above, capped at the rhythm; `squeeze` closes those gaps further, never below 12px
      // unless the design's own gap was tighter, and never into the logo's clear space. With
      // `acrossColumns`, the band moves in every column, so a block beside the cause stays level
      // with it: a two-column banner's body stayed at the top while its title moved 154px down under
      // the logo, and read as coming before the title (dev tier, brief_17).
      const plan = (squeeze: number, acrossColumns: boolean) => {
        const newY = new Map<Rect, number>();
        const placed: Rect[] = growing ? [growing] : [];
        const moved = (a: Rect) => a === growing || newY.get(a) !== a.y;
        const newBottom = (a: Rect) => (a === growing ? a.y + a.height + delta : newY.get(a)! + a.height);
        for (const b of blocks) {
          // Not a logo in another column: it is set on its own margin or corner, not on the text.
          const inBand =
            !growing && b.y < atY + delta && (overlapsXRect(span(b), cause) || (acrossColumns && b !== logo));
          let y = inBand ? b.y + delta : b.y;
          for (const a of placed) {
            if (!moved(a)) continue;
            if (holds(a, b)) {
              y = Math.max(y, b.y + (newY.get(a)! - a.y));
              continue;
            }
            if (!overlapsXRect(span(a), span(b)) || a.y + a.height > b.y) continue;
            const kept = Math.min(b.y - (a.y + a.height), rhythm);
            y = Math.max(y, Math.ceil(newBottom(a) + Math.max(minGap(a, b), Math.min(kept, 12), kept * squeeze)));
          }
          newY.set(b, y);
          placed.push(b);
        }

        // Nothing moved leaves the safe area (text and logo) or the canvas (shapes).
        for (const b of blocks) {
          const y = newY.get(b)!;
          if (y !== b.y && y + b.height > (isShape(b) ? H : safeBottom)) return null;
        }
        // Nor runs into text, or into the logo's clear space, that it did not already overlap.
        const after = (o: Rect): Rect =>
          o === growing ? { ...o, height: o.height + delta } : newY.has(o) ? { ...o, y: newY.get(o)! } : o;
        const texts: Rect[] = layout.text;
        for (let i = 0; i < texts.length; i++)
          for (let j = i + 1; j < texts.length; j++)
            if (intersects(after(texts[i]), after(texts[j])) && !intersects(texts[i], texts[j])) return null;
        if (layout.logo) {
          const zoneBefore = logoClearZone(layout.logo);
          const zoneAfter = logoClearZone(after(layout.logo));
          for (const o of [...texts, ...(layout.shapes || []).filter((s) => s.role === 'rule')])
            if (intersects(after(o), zoneAfter) && !intersects(o, zoneBefore)) return null;
        }
        // A panel stretches to keep holding what it held, with its bottom padding: one spanning
        // the line, one whose contents were pushed further than it, one holding the growing box.
        const stretch = new Map<Rect, number>();
        for (const s of panels) {
          const held = [...blocks, ...(growing ? [growing] : [])].filter((b) => holds(s, b));
          if (!held.length) continue;
          const top = newY.get(s) ?? s.y;
          const pad = Math.max(0, s.y + s.height - Math.max(...held.map((b) => b.y + b.height)));
          const needed = Math.max(...held.map(newBottom)) + pad - top;
          if (needed > s.height) {
            if (top + needed > H) return null;
            stretch.set(s, needed);
          }
        }
        return { newY, stretch };
      };

      // The design's own spacing first. When the content below cannot absorb the push at that
      // spacing — a logo at its minimum size on the top margin of a 1080px banner, a footer panel on
      // the bottom one — the moved blocks close up rather than the design failing QA outright.
      // Level with the cause in every column first, then in its own column only.
      const tries = [1, 0.75, 0.5, 0.25]
        .filter((squeeze) => squeeze >= minSqueeze)
        .flatMap((squeeze) => (growing ? [false] : [true, false]).map((across) => [squeeze, across] as const));
      for (const [squeeze, across] of tries) {
        const p = plan(squeeze, across);
        if (!p) continue;
        for (const b of blocks) {
          const y = p.newY.get(b)!;
          if (b === layout.logo) layout.logo = { ...layout.logo!, y };
          else b.y = y;
        }
        for (const [s, h] of p.stretch) s.height = h;
        return true;
      }
      return false;
    };
    // Mirrors the layout top to bottom, so the same cascade can push blocks up: a block on the
    // bottom margin cannot be pushed down, but what is above it can usually rise.
    const flip = () => {
      for (const o of [...layout.text, ...(layout.shapes || []), ...(layout.photos || [])]) o.y = H - o.y - o.height;
      if (layout.logo) layout.logo = { ...layout.logo, y: H - layout.logo.y - layout.logo.height };
    };
    const overlapsX = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x;

    const lines = measureWrappedLines(layout, copy.text);
    const ordered = [...layout.text].sort((a, b) => a.y - b.y || a.x - b.x);
    const rank = new Map<object, number>(ordered.map((t, i) => [t, i]));
    // Two blocks at the same height in one column: the first in reading order is the upper one.
    const isAbove = (o: Rect, t: Rect) => o.y < t.y || (o.y === t.y && rank.get(o)! < rank.get(t)!);
    for (const t of ordered) {
      // Clear the logo's zone and every block above that shares a column with this one.
      const zone = layout.logo ? logoClearZone(layout.logo) : null;
      // Only a block starting at or below the logo's top is moved. One starting above it and reaching
      // into its clear space is left for refinement: with the logo between it and the next block, any
      // move that keeps the logo there opens a gap the rhythm metric rejects (run 2, brief_08: raising
      // its eyebrow passed QA with a 216px gap, and failed regularity).
      const zoneClash =
        zone && layout.logo && t.y >= layout.logo.y && overlapsX(zone, t) ? Math.max(0, Math.ceil(zone.y + zone.height - t.y)) : 0;
      const clashers = layout.text.filter((o) => o !== t && isAbove(o, t) && overlapsX(o, t) && o.y + o.height > t.y);
      const textClash = Math.max(0, ...clashers.map((o) => Math.ceil(o.y + o.height - t.y)));
      if (zoneClash > 0 || textClash > 0) {
        // What it clashed with stays where it is — the logo too, when it is its zone that clashed.
        const fixed: Rect[] = [...clashers, ...(zoneClash > 0 && layout.logo ? [layout.logo] : [])];
        const resolved = insertSpace(t.y, Math.max(zoneClash, textClash), t, { fixed });
        if (!resolved && zoneClash === 0) {
          // No room below — text clamped onto the bottom margin (dev tier, brief_20): the block
          // above rises instead, and what is above it with it.
          const o = clashers.reduce((a, b) => (a.y + a.height >= b.y + b.height ? a : b));
          flip();
          insertSpace(o.y, textClash, o, { fixed: [t] });
          flip();
        }
      }

      // Grow the box to hold its copy at the house leading: downward, else upward from the bottom
      // margin, else as far as the safe area allows — never past it (cheap run 4, brief_04).
      const wanted = Math.ceil((lines[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight);
      if (wanted > t.height) {
        const grow = wanted - t.height;
        let grown = t.y + wanted <= safeBottom && insertSpace(t.y + t.height, grow, t, { growing: true });
        if (grown) t.height = wanted;
        else if (t.y + t.height - wanted >= layout.grid.margin) {
          flip();
          if (insertSpace(t.y + t.height, grow, t, { growing: true })) {
            t.height = wanted;
            grown = true;
          }
          flip();
        }
        if (!grown) {
          const needed = Math.min(wanted, safeBottom - t.y);
          if (needed > t.height && insertSpace(t.y + t.height, needed - t.height, t, { growing: true })) t.height = needed;
        }
      }
    }
  };

  // Settling may not fit at the design's own margin and spacing: a 1080px-tall banner with a 115px
  // margin cannot hold a 154px logo, its clear space and the copy. The arrangements tried, in
  // order: the design's margin with the moved blocks' gaps closed up to half; the house-minimum
  // margin (6% of the short edge), with a logo on the old margin moved onto the new one; then gaps
  // closed up to a quarter at either margin. The first that clears the logo and every collision is
  // kept — otherwise the first, which is what QA then judges.
  const rulesAndText = () => [...layout.text, ...(layout.shapes || []).filter((s) => s.role === 'rule')];
  const logoCrowded = () => !!layout.logo && rulesAndText().some((b) => intersects(b, logoClearZone(layout.logo!)));
  const textCollides = () => layout.text.some((a, i) => layout.text.some((b, j) => j > i && intersects(a, b)));
  const m0 = layout.grid.margin;
  const minMargin = Math.floor(HOUSE_RULES.safeMarginShare * Math.min(W, H));
  const attempts: Array<[number, number]> =
    m0 > minMargin
      ? [[m0, 0.5], [minMargin, 0.5], [m0, 0.25], [minMargin, 0.25]]
      : [[m0, 0.5], [m0, 0.25]];
  // Tries each arrangement from `start`; returns null once one clears, else the first attempt.
  const arrange = (start: string): string | null => {
    let first: string | null = null;
    for (const [margin, minSqueeze] of attempts) {
      Object.assign(layout, JSON.parse(start));
      if (margin !== m0 && layout.logo) {
        const l = layout.logo;
        if (Math.abs(l.y - m0) <= 2) layout.logo = { ...l, y: margin };
        else if (Math.abs(l.y + l.height - (H - m0)) <= 2) layout.logo = { ...l, y: H - margin - l.height };
      }
      layout.grid.margin = margin;
      settle(minSqueeze);
      if (!logoCrowded() && !textCollides()) return null;
      first ??= JSON.stringify(layout);
    }
    return first;
  };
  const unsettled = JSON.stringify(layout);
  const first = arrange(unsettled);
  if (first !== null) {
    // Last resort, only when no arrangement fits: a box taller than its copy gives back its empty
    // space. Models size boxes in coarse steps; the cheap-tier winner of task 1f392e16 (2026-09-18)
    // held 317px of empty box and still ran 54px past the bottom margin, its last two blocks
    // overlapping, and no design was delivered. Each box shrinks around its centre, where the
    // renderer sets its lines, so no line moves until settling uses the room. A layout that
    // already fits is never trimmed, so its measures stand.
    Object.assign(layout, JSON.parse(unsettled));
    const needed = measureWrappedLines(layout, copy.text);
    for (const t of layout.text) {
      const wanted = Math.ceil((needed[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight);
      if (t.height > wanted) {
        t.y = Math.round(t.y + (t.height - wanted) / 2);
        t.height = wanted;
      }
    }
    if (arrange(JSON.stringify(layout)) !== null) Object.assign(layout, JSON.parse(first));
  }

  // Text over art must sit where the art is calm: widen the calm region to cover every text box
  // that touches the art. A box straddling the art's edge is covered whole, so the region may
  // reach past the art box — harmless, since the art stage only uses it to say where to be quiet.
  if (layout.art?.calmRegion) {
    const c = layout.art.calmRegion;
    const box = layout.art.box || { x: 0, y: 0, width: W, height: H };
    const over = layout.text.filter((t) => intersects(t, box));
    if (over.length) {
      const x0 = Math.max(0, Math.min(c.x, ...over.map((t) => t.x)));
      const y0 = Math.max(0, Math.min(c.y, ...over.map((t) => t.y)));
      const x1 = Math.min(W, Math.max(c.x + c.width, ...over.map((t) => t.x + t.width)));
      const y1 = Math.min(H, Math.max(c.y + c.height, ...over.map((t) => t.y + t.height)));
      layout.art.calmRegion = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }

  // Boxes may have moved or grown: put each divider back in the middle of its gap.
  centerSeparatorsInGaps(layout.shapes || [], layout.text);

  // A rule inside the logo's clear space moves just outside it — above if there is room, else
  // below — and is dropped as a last resort: it is ornament, and the clear space is a brand rule
  // whose breach means no design is delivered at all. (Separator centring does not see the logo,
  // so it could put a rule back into the zone: cheap run 5, brief_10.)
  if (layout.logo && layout.shapes?.length) {
    const zone = logoClearZone(layout.logo);
    const m2 = layout.grid.margin;
    const hitsText = (r: Rect) => layout.text.some((tx) => intersects(tx, r));
    // A moved rule must also sit evenly in its gap: an off-centre divider is itself a QA defect.
    const lopsided = (s: object) =>
      findAsymmetricSeparators(layout.shapes, layout.text).some((g) => layout.shapes[g.shapeIndex] === s);
    for (const s of [...layout.shapes]) {
      if (s.role !== 'rule' || !intersects(s, zone)) continue;
      const originalY = s.y;
      let placed = false;
      for (const y of [Math.floor(zone.y - s.height - 2), Math.ceil(zone.y + zone.height + 2)]) {
        if (y < m2 || y + s.height > H - m2) continue;
        s.y = y;
        if (!hitsText(s) && !lopsided(s)) {
          placed = true;
          break;
        }
      }
      if (!placed) {
        s.y = originalY;
        layout.shapes = layout.shapes.filter((x) => x !== s);
      }
    }
  }

  // Every block reads against the surface behind it, in a brand colour: the colour the design
  // already uses most for text that reads there, else the one with the most contrast. Models set
  // navy text on navy panels — 9 of the 20 T5 designs, 2 or 3 in every 20 on the cheap tier — and
  // QA never checked. Last, because settling can move a block onto or off a panel.
  if (palette && palette.length) {
    for (const t of layout.text) {
      const surface = declaredBackgroundColour(layout, t);
      const on = (colour: string) => calculateLuminanceContrastRatio(hexToLuminance(colour), hexToLuminance(surface));
      const required = requiredContrast(t.fontSize, Boolean(t.bold));
      if (on(t.color) >= required) continue;
      const readable = palette.filter((p) => on(p) >= required);
      const uses = (p: string) => layout.text.filter((o) => o !== t && normalizeHex(o.color) === normalizeHex(p)).length;
      t.color = [...(readable.length ? readable : palette)].sort((a, b) => uses(b) - uses(a) || on(b) - on(a))[0];
    }
  }
  return layout;
}

/**
 * Everything applied to a freshly generated layout before it is scored: the real logo fitted
 * inside its reserved box, the studio's normalisation (margin, minimum sizes, collision
 * clean-up), admitted fonts and direction per block, then the house rules QA checks. Production and the qualification both call this, so they score the same
 * layout. Mutates and returns the layout.
 */
export function prepareGeneratedLayoutV3(
  layout: StudioLayoutV2,
  copy: PipelineV3Copy,
  canvas: {
    width: number;
    height: number;
    logoAspect?: number;
    palette?: string[];
    /** The brand colour the client asked for as the background. Applied before contrast repair. */
    background?: string;
    /** Brand ornament added when the generator left it out: a texture and gold dividers. */
    ornament?: OrnamentSettings;
    /** False enforces a brief's no-imagery decision even after style/ornament preparation. */
    allowArt?: boolean;
    /** What the client's reference and instructions decide; enforced over the generator's choices. */
    style?: StyleSpec;
  }
): StudioLayoutV2 {
  // A background the client named is theirs, not the generator's choice: on the cheap tier two of
  // three candidates for "dark blue navy as a background" came back cream and white, and one won
  // (task 3c3a422b, 2026-09-18). Set first, so preparation recolours any text it leaves unreadable.
  if (canvas.background) layout.background = { ...(layout.background || {}), color: canvas.background };
  const aspect = canvas.logoAspect || 1.0;
  const fitted = fitLogoToAspect(layout, aspect, { width: canvas.width, margin: layout.grid?.margin ?? 0 });
  const normalized = normalizeStudioLayout(fitted, canvas.width, canvas.height, aspect);
  const fonted = sanitizeFontsV3(normalized, copy);
  const conformed = canvas.style
    ? conformToStyleSpec(fonted, copy, canvas.style, canvas.palette)
    : conformToHouseRules(fonted, copy, canvas.palette);
  const balance = canvas.ornament?.balance ?? true;
  const spread = canvas.style?.composition === 'spread';
  const finish = (l: StudioLayoutV2) => {
    const finished = settlePhotos(balanceLineBreaks(compose(l), copy));
    if (canvas.allowArt === false) delete finished.art;
    return finished;
  };
  const compose = (l: StudioLayoutV2) => {
    if (!spread) return balance ? balanceVertically(l, copy) : l;
    // The reference's composition, kept unless it adds a real defect. The measure here is the hard
    // one (overlaps, reading order, copy that no longer fits, the safe area, the logo's clear
    // space), not the metric set: spreading a design deliberately changes balance and rhythm, which
    // is what the client asked for, and judging it by those reverted the arrangement every time.
    const before = JSON.parse(JSON.stringify(l)) as StudioLayoutV2;
    const composed = composeStyleSpec(l, canvas.style!, logoClearZone);
    centerSeparatorsInGaps(composed.shapes || [], composed.text);
    return layoutDefectCount(composed, copy) > layoutDefectCount(before, copy) ? before : composed;
  };
  canvas = { ...canvas, ornament: ornamentForStyle(canvas.ornament, canvas.style) };
  if (!canvas.ornament) return finish(conformed);
  // Ornament may never make a design worse by the pipeline's own measures. The texture changes no
  // measure; dividers and the box fitting they need can (over the 160 stored designs, one fell below
  // the alignment gate and one gained an off-centre divider). Those keep the texture alone.
  const plain = JSON.parse(JSON.stringify(conformed)) as StudioLayoutV2;
  const ornamented = addBrandOrnament(conformed, copy, canvas.ornament, canvas.palette || []);
  if (!ornamentAddsDefect(plain, ornamented, copy)) return finish(ornamented);
  return finish(addBrandOrnament(plain, copy, { ...canvas.ornament, dividers: false }, canvas.palette || []));
}

/**
 * Re-seats the client's photographs when the passes above left text or the logo on one.
 *
 * The layout model places photos and copy together, and then typography grows the title and the
 * reference's spread composition moves the blocks, with no knowledge of the photos. On 2026-09-22
 * all three candidates for a two-portrait request placed both photos, and all three came out of
 * preparation with a text block on a portrait, which hard QA refused. Moving the copy back would
 * undo the choices those passes enforce; the photos are what can move.
 *
 * Deterministic: the page's text and logo (with its clear space) are obstacles; the free horizontal
 * bands between them are measured inside the margins; the photos go side by side in the free band
 * nearest where the model put them that fits them at their minimum size (22% of the canvas's short
 * side, 12% for an inset), keeping each photo's aspect and order, as large as the band allows, aligned
 * the way the copy is aligned. A layout with no conflict, or no band that fits, is returned as it is:
 * hard QA then refuses it rather than a photo being shrunk into a thumbnail.
 */
export function settlePhotos(layout: StudioLayoutV2): StudioLayoutV2 {
  const photos = layout.photos || [];
  if (!photos.length) return layout;
  const W = layout.width;
  const H = layout.height;
  const m = Math.max(0, layout.grid?.margin ?? 0);
  const gap = Math.max(16, Math.round(Math.min(W, H) * 0.02));
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const texts: Rect[] = [...(layout.text || [])];
  const logoZone = layout.logo && layout.logo.width > 0 ? logoClearZone(layout.logo) : undefined;
  const obstacles = [...texts, ...(logoZone ? [logoZone] : [])];
  // Cut-out people standing a little into each other are a group, not a conflict; see photosMayOverlap.
  const conflict =
    photos.some((p) => obstacles.some((o) => hit(p, o)) || p.x < 0 || p.y < 0 || p.x + p.width > W || p.y + p.height > H) ||
    photos.some((p, i) => photos.some((q, j) => j > i && hit(p, q) && !photosMayOverlap(p, q)));
  if (!conflict) return layout;

  // Free bands between the text blocks, inside the margins. Text runs the width of a column, so
  // it is treated as a full-width obstacle; the logo is checked in two dimensions below, so a row
  // of photos can sit beside it.
  const covered = texts
    .map((o) => [Math.max(m, o.y - gap), Math.min(H - m, o.y + o.height + gap)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const bands: Array<{ top: number; bottom: number }> = [];
  let cursor = m;
  for (const [a, b] of covered) {
    if (a > cursor) bands.push({ top: cursor, bottom: a });
    cursor = Math.max(cursor, b);
  }
  if (H - m > cursor) bands.push({ top: cursor, bottom: H - m });

  const minSide = photos.map((p) => Math.round(Math.min(W, H) * (p.role === 'inset' ? 0.12 : 0.22)));
  // Photos are cover-cropped, so a box may be squarer than the photo: a tall portrait keeps a
  // portrait box down to 3:4, never a sliver.
  const aspects = photos.map((p) => Math.max(0.75, Math.min(1.5, p.width / Math.max(1, p.height))));
  const aligns = (layout.text || []).map((t) => t.align);
  const left = aligns.filter((a) => a === 'left').length;
  const right = aligns.filter((a) => a === 'right').length;
  const centred = aligns.length - left - right;
  const preferred: 'left' | 'right' | 'center' = left > right && left > centred ? 'left' : right > left && right > centred ? 'right' : 'center';
  const centre = photos.reduce((a, p) => a + p.y + p.height / 2, 0) / photos.length;
  const ordered = [...bands].sort(
    (a, b) => Math.abs((a.top + a.bottom) / 2 - centre) - Math.abs((b.top + b.bottom) / 2 - centre)
  );

  for (const band of ordered) {
    const maxH = Math.floor(Math.min(band.bottom - band.top, H * 0.42));
    for (let h = maxH; h >= Math.max(...minSide); h -= 4) {
      const widths = aspects.map((a, i) => Math.max(minSide[i], Math.round(h * a)));
      if (widths.some((w, i) => Math.min(w, h) < minSide[i])) continue;
      const rowWidth = widths.reduce((a, b) => a + b, 0) + gap * (photos.length - 1);
      if (rowWidth > W - 2 * m) continue;
      const y = Math.round(band.top + (band.bottom - band.top - h) / 2);
      const starts = { left: m, right: W - m - rowWidth, center: Math.round((W - rowWidth) / 2) };
      const order = [preferred, ...(['left', 'center', 'right'] as const).filter((o) => o !== preferred)];
      for (const o of order) {
        let x = starts[o];
        const boxes = widths.map((w) => {
          const b = { x, y, width: w, height: h };
          x += w + gap;
          return b;
        });
        if (logoZone && boxes.some((b) => hit(b, logoZone))) continue;
        photos.forEach((p, i) => {
          const radius = p.radius ? Math.round((p.radius / Math.max(1, Math.min(p.width, p.height))) * Math.min(boxes[i].width, h)) : undefined;
          Object.assign(p, boxes[i]);
          if (radius) p.radius = radius;
          else delete p.radius;
        });
        return layout;
      }
    }
  }
  return layout;
}

/**
 * Narrows a text box whose copy ends on a single stranded word, so the break moves up and the lines
 * balance. The box is what Canva receives, so the change reaches the editable design; see
 * `balancedBoxWidths`. The block keeps its anchor: a left-aligned block its left edge, a
 * right-aligned one its right edge, a centred one its centre. Line counts, heights and type sizes
 * do not change.
 *
 * Like every optional pass here, a change is kept only if it costs nothing by the pipeline's own
 * measures: no new layout defect and no metric that passed before failing after. Each block is
 * decided on its own, so one that cannot be narrowed does not hold back the rest.
 */
export function balanceLineBreaks(layout: StudioLayoutV2, copy: PipelineV3Copy): StudioLayoutV2 {
  const widths = balancedBoxWidths(layout, copy.text);
  const indices = Object.keys(widths).map(Number);
  if (!indices.length) return layout;
  const failing = (l: StudioLayoutV2) =>
    Object.values(measureDesignV3(l, copy).metrics).filter((m) => !m.passed).length;
  let current = layout;
  for (const copyIndex of indices) {
    const next = JSON.parse(JSON.stringify(current)) as StudioLayoutV2;
    const t = next.text.find((b) => b.copyIndex === copyIndex);
    if (!t) continue;
    const delta = t.width - widths[copyIndex];
    if (delta <= 0) continue;
    if (t.align === 'center') t.x += delta / 2;
    else if (t.align === 'right') t.x += delta;
    t.width = widths[copyIndex];
    if (layoutDefectCount(next, copy) > layoutDefectCount(current, copy)) continue;
    if (failing(next) > failing(current)) continue;
    current = next;
  }
  return current;
}

/**
 * Re-spaces a one-column design whose content leaves a dead band: the whole stack keeps its order,
 * its blocks and type sizes, and its rhythm (every gap grows by the same factor, at most 1.6x), and
 * sits at the optical centre of the space the logo leaves free. Task 8fb76534 (2026-09-19) put three
 * short lines in the top 55% of a 1080x1350 canvas, 415px of nothing above a corner logo.
 *
 * Type is deliberately not enlarged: the owner's exemplars are 85-89% empty, so whitespace is the
 * house style (see `measureWrappedLines`). The defect is where the whitespace falls. Only a layout
 * the negative-space measure already fails is touched, and a change is kept only if it raises that
 * measure without adding an overlap, a failing metric, a logo clear-space breach or text outside
 * the safe area. Anything else is returned unchanged.
 */
export function balanceVertically(layout: StudioLayoutV2, copy: PipelineV3Copy): StudioLayoutV2 {
  const W = layout.width;
  const H = layout.height;
  const m = layout.grid?.margin ?? 0;
  const texts = layout.text || [];
  if (!texts.length) return layout;
  // A design built around the client's photographs is composed around them where they stand.
  if (layout.photos?.length) return layout;
  // One column: no two blocks share a height band.
  const byY = [...texts].sort((a, b) => a.y - b.y);
  for (let i = 1; i < byY.length; i++) if (byY[i].y < byY[i - 1].y + byY[i - 1].height) return layout;
  // Artwork set in a region of its own is composed with the text where it stands.
  const art = layout.art;
  if (art?.box && !(art.box.width >= 0.98 * W && art.box.height >= 0.98 * H)) return layout;

  const before = measureDesignV3(layout, copy);
  if (before.metrics.negativeSpace.passed) return layout;

  const fullBleed = (s: Rect) => s.width >= 0.98 * W && s.height >= 0.98 * H;
  const shapes = (layout.shapes || []).filter((s) => !fullBleed(s));
  // A shape on the canvas edge (a header or footer band) anchors the composition: leave it be.
  if (shapes.some((s) => s.y <= 1 || s.y + s.height >= H - 1)) return layout;
  const top0 = Math.min(...texts.map((t) => t.y), ...shapes.map((s) => s.y));
  const bottom0 = Math.max(...texts.map((t) => t.y + t.height), ...shapes.map((s) => s.y + s.height));
  const logo = layout.logo && layout.logo.width > 0 ? layout.logo : undefined;
  const logoInStack = !!logo && logo.y >= top0 && logo.y + logo.height <= bottom0;

  // The space free for the stack: the safe area, less the logo's clear space when the logo sits
  // above or below the stack in the same column.
  let free0 = m;
  let free1 = H - m;
  if (logo && !logoInStack) {
    const zone = logoClearZone(logo);
    const shareColumn = texts.some((t) => overlapsXRect(t, zone));
    if (logo.y >= bottom0) free1 = shareColumn ? Math.min(free1, Math.floor(zone.y)) : free1;
    else if (logo.y + logo.height <= top0) free0 = shareColumn ? Math.max(free0, Math.ceil(zone.y + zone.height)) : free0;
    else return layout;
  }

  // Solid intervals move rigidly; the gaps between them scale. A panel is mapped edge by edge, so
  // it keeps holding what it held.
  const panels = shapes.filter((s) => s.role === 'panel');
  const solids: Rect[] = [...texts, ...shapes.filter((s) => s.role !== 'panel'), ...(logoInStack ? [logo!] : [])];
  const spans = solids.map((r) => [r.y, r.y + r.height]).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const solidHeight = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  const inner = merged.slice(1).reduce((sum, [a], i) => sum + (a - merged[i][1]), 0);
  const lead = merged[0][0] - top0;
  const tail = bottom0 - merged[merged.length - 1][1];

  const snapshot = JSON.stringify(layout);
  const zoneBefore = logo ? logoClearZone(logo) : undefined;
  const breachedBefore = new Set(
    zoneBefore ? [...texts, ...shapes.filter((s) => s.role === 'rule')].map((r, i) => (intersects(r, zoneBefore) ? i : -1)) : []
  );
  const overlapsBefore = computeLayoutMetrics(layout).overlapCount;
  const failingBefore = new Set(before.failingMetrics);

  for (const g of [1.6, 1.45, 1.3, 1.15, 1]) {
    const height = solidHeight + g * (inner + lead + tail);
    if (height > free1 - free0) continue;
    const start = Math.round(free0 + 0.45 * (free1 - free0 - height));
    // New start of each solid interval.
    const starts: number[] = [];
    let cursor = start + g * lead;
    merged.forEach(([a, b], i) => {
      if (i > 0) cursor += g * (a - merged[i - 1][1]);
      starts.push(cursor);
      cursor += b - a;
    });
    const map = (y: number): number => {
      for (let i = 0; i < merged.length; i++) {
        const [a, b] = merged[i];
        if (y < a) return i === 0 ? starts[0] - g * (a - y) : starts[i - 1] + (merged[i - 1][1] - merged[i - 1][0]) + g * (y - merged[i - 1][1]);
        if (y <= b) return starts[i] + (y - a);
      }
      const [a, b] = merged[merged.length - 1];
      return starts[merged.length - 1] + (b - a) + g * (y - b);
    };

    Object.assign(layout, JSON.parse(snapshot));
    const cur = layout;
    const curShapes = (cur.shapes || []).filter((s) => !fullBleed(s));
    for (const t of cur.text) t.y = Math.round(map(t.y));
    for (const s of curShapes) {
      if (s.role === 'panel') {
        const y = Math.round(map(s.y));
        s.height = Math.round(map(s.y + s.height)) - y;
        s.y = y;
      } else s.y = Math.round(map(s.y));
    }
    if (logoInStack && cur.logo) cur.logo = { ...cur.logo, y: Math.round(map(cur.logo.y)) };
    if (cur.art?.calmRegion) {
      const c = cur.art.calmRegion;
      const y = Math.max(0, Math.round(map(c.y)));
      cur.art.calmRegion = { ...c, y, height: Math.min(H, Math.round(map(c.y + c.height))) - y };
    }

    const safe = cur.text.every((t) => t.y >= m && t.y + t.height <= H - m);
    const zone = cur.logo ? logoClearZone(cur.logo) : undefined;
    const breach =
      !!zone &&
      [...cur.text, ...(cur.shapes || []).filter((s) => s.role === 'rule')].some((r, i) => intersects(r, zone) && !breachedBefore.has(i));
    if (!safe || breach || computeLayoutMetrics(cur).overlapCount > overlapsBefore) continue;
    const after = measureDesignV3(cur, copy);
    if (after.failingMetrics.some((f) => !failingBefore.has(f))) continue;
    if (after.metrics.negativeSpace.score <= before.metrics.negativeSpace.score) continue;
    if (after.compositeScore < before.compositeScore) continue;
    return cur;
  }
  Object.assign(layout, JSON.parse(snapshot));
  return layout;
}

/**
 * House rules, with the client's style spec enforced as far as it can be without making the design
 * worse than it would be with no spec at all. See `styleSpecLadder`.
 */
function conformToStyleSpec(
  layout: StudioLayoutV2,
  copy: PipelineV3Copy,
  spec: StyleSpec,
  palette?: string[]
): StudioLayoutV2 {
  const source = JSON.stringify(layout);
  const prepare = (step: StyleSpec) =>
    conformToHouseRules(applyStyleSpec(JSON.parse(source) as StudioLayoutV2, copy, step, palette || []), copy, palette);
  // The fallback keeps the spec's colour decisions: they recolour text and move nothing, so the
  // defect floor is the same with them as without, and the title colour the client's reference asks
  // for survives even on a design that can hold none of the arrangement. See `colourDecisionsOnly`.
  const plain = prepare(colourDecisionsOnly(spec));
  const floor = layoutDefectCount(plain, copy);

  let spec_ = spec;
  let best = prepare(spec_);
  let defects = layoutDefectCount(best, copy);
  const dropped: string[] = [];
  const remaining = new Set<(typeof MOVEMENT_DECISIONS)[number]>(
    MOVEMENT_DECISIONS.filter((key) => spec[key] !== 'as_generated')
  );
  // Give up one decision at a time, and only the one that is actually in the way. Dropping them in
  // a fixed order took the title's display size off a design whose single defect came from the
  // logo's corner, which is the visible half of what the client asked for.
  while (defects > floor && remaining.size) {
    let choice: { key: (typeof MOVEMENT_DECISIONS)[number]; layout: StudioLayoutV2; defects: number } | undefined;
    for (const key of remaining) {
      const candidate = prepare(withoutDecision(spec_, key));
      const count = layoutDefectCount(candidate, copy);
      if (!choice || count < choice.defects) choice = { key, layout: candidate, defects: count };
    }
    if (!choice || choice.defects >= defects) break;
    spec_ = withoutDecision(spec_, choice.key);
    best = choice.layout;
    defects = choice.defects;
    dropped.push(choice.key);
    remaining.delete(choice.key);
  }
  if (dropped.length) {
    console.warn(
      `[studio] style spec relaxed for this layout (${dropped.join(', ')} left to the generator): ` +
        `enforcing them left ${defects} defect(s) against ${floor} without the spec.`
    );
  }
  // A design that still cannot hold the spec is delivered as the generator drew it, since a client's
  // look is not worth a broken design.
  return defects <= floor ? best : plain;
}

function ornamentAddsDefect(plain: StudioLayoutV2, ornamented: StudioLayoutV2, copy: PipelineV3Copy): boolean {
  const before = computeLayoutMetrics(plain);
  const after = computeLayoutMetrics(ornamented);
  if (after.overlapCount > before.overlapCount) return true;
  if (after.alignmentScore < 0.7 && before.alignmentScore >= 0.7) return true;
  const skewed = (l: StudioLayoutV2) => findAsymmetricSeparators(l.shapes || [], l.text || []).length;
  if (skewed(ornamented) > skewed(plain)) return true;
  const failing = new Set(measureDesignV3(plain, copy).failingMetrics);
  return measureDesignV3(ornamented, copy).failingMetrics.some((m) => !failing.has(m));
}

const MOTIFS = ['sun-rays', 'guilloche', 'thin-rules', 'gradient-wash', 'diagonal-lines'] as const;

export interface OrnamentSettings {
  /** Gold rules under the title and above the date block, where the gap allows one. */
  dividers: boolean;
  /** A procedural brand texture behind a design that has no artwork, or none. */
  texture: (typeof MOTIFS)[number] | 'none';
  /** The texture layer's opacity, applied once: in the render and in the Canva deck alike. */
  textureOpacity: number;
  /** Re-spaces a one-column stack that leaves a dead band, see `balanceVertically`. */
  balance: boolean;
}

/**
 * The owner asked for richer designs (2026-09-19): gold dividers and texture on every design.
 * HAWA_DESIGN_DIVIDERS (on | off), HAWA_DESIGN_TEXTURE (sun-rays | guilloche | thin-rules |
 * gradient-wash | none), HAWA_DESIGN_TEXTURE_OPACITY (0.05-0.6). Sun rays echo the rays of the KAAE
 * emblem; guilloche's loops ran through body copy in the preview, and thin-rules' frame crossed a
 * title wider than the margin. HAWA_DESIGN_BALANCE (on | off) re-spaces a short stack that leaves
 * part of the canvas dead. Throws on a value it does not know.
 */
export function resolveOrnamentSettings(env: Record<string, string | undefined> = process.env): OrnamentSettings {
  const read = (name: string) => (env[name] || '').trim().toLowerCase();
  const dividers = read('HAWA_DESIGN_DIVIDERS') || 'on';
  if (dividers !== 'on' && dividers !== 'off') throw new Error(`HAWA_DESIGN_DIVIDERS must be on or off, not '${dividers}'`);
  const texture = (read('HAWA_DESIGN_TEXTURE') || 'sun-rays') as OrnamentSettings['texture'];
  if (texture !== 'none' && !MOTIFS.includes(texture as any)) {
    throw new Error(`HAWA_DESIGN_TEXTURE must be one of ${MOTIFS.join(', ')} or none, not '${texture}'`);
  }
  const opacity = read('HAWA_DESIGN_TEXTURE_OPACITY') ? Number(read('HAWA_DESIGN_TEXTURE_OPACITY')) : 0.25;
  if (!(opacity >= 0.05 && opacity <= 0.6)) throw new Error(`HAWA_DESIGN_TEXTURE_OPACITY must be between 0.05 and 0.6`);
  const balance = read('HAWA_DESIGN_BALANCE') || 'on';
  if (balance !== 'on' && balance !== 'off') throw new Error(`HAWA_DESIGN_BALANCE must be on or off, not '${balance}'`);
  return { dividers: dividers === 'on', texture, textureOpacity: opacity, balance: balance === 'on' };
}

/**
 * Adds the brand ornament a layout lacks. Texture: a procedural motif over the whole canvas, only
 * when the layout has no artwork of its own. Dividers: only when it has no rule. Boxes are first
 * fitted to their copy (centred, where the renderer sets the lines, with a quarter-line of headroom
 * so Canva cannot clip), because generated boxes are several lines taller than their text and a
 * rule in the visible gap would otherwise sit inside a box and fail QA. A divider goes only where
 * the gap holds it clear of text and of the logo's clear space.
 */
export function addBrandOrnament(
  layout: StudioLayoutV2,
  copy: PipelineV3Copy,
  ornament: OrnamentSettings,
  palette: string[]
): StudioLayoutV2 {
  const W = layout.width;
  const H = layout.height;
  // The owner's texture replaces a procedural motif the generator picked (task efb409fa chose a
  // gradient wash that barely showed); artwork it asked to have generated stays.
  if (ornament.texture !== 'none' && (!layout.art || layout.art.source === 'procedural') && layout.text.length) {
    const x0 = Math.min(...layout.text.map((t) => t.x));
    const y0 = Math.min(...layout.text.map((t) => t.y));
    const x1 = Math.max(...layout.text.map((t) => t.x + t.width));
    const y1 = Math.max(...layout.text.map((t) => t.y + t.height));
    layout.art = {
      source: 'procedural',
      motif: ornament.texture,
      opacity: ornament.textureOpacity,
      box: { x: 0, y: 0, width: W, height: H },
      calmRegion: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    } as StudioLayoutV2['art'];
  }
  if (!ornament.dividers) return layout;

  const lines = measureWrappedLines(layout, copy.text);
  for (const t of layout.text) {
    const wanted = Math.ceil((lines[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight) + Math.ceil(0.25 * t.fontSize);
    if (t.height > wanted) {
      t.y = Math.round(t.y + (t.height - wanted) / 2);
      t.height = wanted;
    }
  }
  const gold = palette.length ? nearestPaletteColour('#F7B500', palette) : '#F7B500';
  const sameColumn = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x;
  const below = (b: Rect) =>
    layout.text.filter((t) => t !== b && t.y >= b.y + b.height - 1 && sameColumn(t, b)).sort((p, q) => p.y - q.y)[0];
  const above = (b: Rect) =>
    layout.text.filter((t) => t !== b && t.y + t.height <= b.y + 1 && sameColumn(t, b)).sort((p, q) => q.y - p.y)[0];
  const place = (upper: StudioLayoutV2['text'][number] | undefined, lower: StudioLayoutV2['text'][number] | undefined, width: number) => {
    if (!upper || !lower) return;
    const top = upper.y + upper.height;
    const gap = lower.y - top;
    if (gap < 26) return;
    const align = lower.align === upper.align ? lower.align : 'center';
    const x =
      align === 'left' ? upper.x : align === 'right' ? upper.x + upper.width - width : Math.round(upper.x + upper.width / 2 - width / 2);
    // Each place is judged alone: a rule the generator drew above the title leaves the gap below
    // it bare (task efb409fa), but one already in this gap is enough.
    const gapBox = { x: Math.min(upper.x, lower.x), y: top, width: Math.max(upper.x + upper.width, lower.x + lower.width) - Math.min(upper.x, lower.x), height: gap };
    if ((layout.shapes || []).some((sh) => intersects(sh, gapBox))) return;
    const rule = { kind: 'rect', role: 'rule', x, y: Math.round(top + (gap - 2) / 2), width, height: 2, color: gold } as StudioLayoutV2['shapes'][number];
    if (layout.logo && intersects(rule, logoClearZone(layout.logo))) return;
    if (layout.text.some((t) => intersects(t, rule))) return;
    layout.shapes = [...(layout.shapes || []), rule];
  };
  const title = layout.text.find((t) => t.role === 'title');
  if (title) place(title, below(title), Math.round(Math.min(160, 0.15 * W)));
  const date = layout.text.filter((t) => t.role === 'date' || t.role === 'venue').sort((p, q) => p.y - q.y)[0];
  if (date && date !== (title && below(title))) place(above(date), date, Math.round(Math.min(120, 0.11 * W)));
  // Centred in their gaps as QA measures them, which may pair a rule with other blocks than above.
  centerSeparatorsInGaps(layout.shapes || [], layout.text);
  return layout;
}

/** Production's hard QA, told the copy so it can check that every block's copy fits its box. */
function withCopy(qa: HardQaContext, copy: PipelineV3Copy): HardQaContext {
  return qa.copyText ? qa : { ...qa, copyText: copy.text };
}

/** The pipeline's deterministic measure: from the lines the real copy wraps to, not box area. */
export function measureDesignV3(layout: StudioLayoutV2, copy: PipelineV3Copy): DesignMetricsReport {
  return evaluateDesignMetrics(layout, { wrappedLines: measureWrappedLines(layout, copy.text) });
}

/**
 * Orders two candidates: one that passes production's hard QA beats one that does not, then one
 * that passes the design metrics, then the higher composite. Negative when `a` ranks first.
 */
function compareCandidatesV3(
  a: { metrics: DesignMetricsReport; hardQa?: HardQaOutcome },
  b: { metrics: DesignMetricsReport; hardQa?: HardQaOutcome }
): number {
  const qaA = a.hardQa ? a.hardQa.passed : true;
  const qaB = b.hardQa ? b.hardQa.passed : true;
  if (qaA !== qaB) return qaA ? -1 : 1;
  if (a.metrics.passed !== b.metrics.passed) return a.metrics.passed ? -1 : 1;
  return b.metrics.compositeScore - a.metrics.compositeScore;
}

/**
 * Ranks candidates for the judge. With a QA context, production's hard QA is a filter, not an
 * afterthought: a candidate that QA would reject cannot outrank one it would accept. Without it,
 * the ranking would crown a design production then refuses, and the run would fail while a
 * passing candidate sat unused.
 */
export function rankCandidatesV3(
  candidates: Array<{ sourceIndex: number; layout: StudioLayoutV2; renderedPng?: Buffer }>,
  copy: PipelineV3Copy,
  qa?: HardQaContext
): RankedCandidateV3[] {
  return candidates
    .map((c) => ({
      ...c,
      metrics: measureDesignV3(c.layout, copy),
      ...(qa ? { hardQa: evaluateHardQa(c.layout, withCopy(qa, copy)) } : {}),
    }))
    .sort(compareCandidatesV3);
}

/** P05: one box-grounded critique of a candidate, rendered with its copy. */
export async function critiqueCandidateV3(
  candidate: RankedCandidateV3,
  copy: PipelineV3Copy,
  options: PipelineV3CallOptions = {}
): Promise<BoxCritiqueResult> {
  return generateBoxGroundedCritique(candidate.layout, {
    reference: options.reference,
    client: options.client,
    model: options.model || resolveModel('critique'),
    deterministicMetrics: candidate.metrics,
    renderOptions: { ...options.renderOptions, copyText: copy.text },
  });
}

export interface RefinementOutcomeV3 {
  /** The layout to carry forward: the refinement when adopted, the original otherwise. */
  layout: StudioLayoutV2;
  metrics: DesignMetricsReport;
  /** Production's hard QA on the carried-forward layout, when a QA context was given. */
  hardQa?: HardQaOutcome;
  adopted: boolean;
  reason:
    | 'gate_passed'
    | 'adopted_now_passes_qa'
    | 'adopted_now_passes'
    | 'adopted_higher_score'
    | 'rejected_unusable'
    | 'rejected_no_improvement';
  result: RefinementCandidateResult;
}

function isUsableLayout(layout: StudioLayoutV2 | undefined | null): layout is StudioLayoutV2 {
  return (
    !!layout &&
    Array.isArray(layout.text) &&
    layout.text.length > 0 &&
    Array.isArray(layout.shapes) &&
    Number.isFinite(layout.width) &&
    Number.isFinite(layout.height)
  );
}

/**
 * P06: gated refinement of one candidate. The engine refines only a candidate that fails a
 * metric or scores below the calibrated band, and spends nothing otherwise.
 *
 * A refinement is adopted only after its fonts are re-sanitised and it is measured again, and
 * only if it is better: it passes where the original failed, or it scores higher without
 * starting to fail. Errors propagate, so a caller can tell a budget stop from a model outage.
 */
export interface RefineV3Options extends PipelineV3CallOptions {
  /**
   * The canvas the layout will be delivered on. When given, a repair gets the same preparation as
   * a freshly generated layout — logo at its real aspect, margins, collision clean-up — before it
   * is measured, so adoption is decided on the layout that will actually be stored.
   */
  canvas?: { width: number; height: number; logoAspect?: number; palette?: string[]; background?: string; ornament?: OrnamentSettings; style?: StyleSpec; allowArt?: boolean };
  /** Production's hard-QA context. A candidate QA rejects is refined even if its metrics pass. */
  qa?: HardQaContext;
}

export async function refineCandidateV3(
  candidate: RankedCandidateV3,
  copy: PipelineV3Copy,
  options: RefineV3Options = {}
): Promise<RefinementOutcomeV3> {
  const failsQa = candidate.hardQa ? !candidate.hardQa.passed : false;
  const result = await refineCandidate(candidate.sourceIndex, candidate.layout, {
    reference: options.reference,
    client: options.client,
    model: options.model || resolveModel('layout'),
    maxRounds: 2,
    minDelta: 0.01,
    copyText: copy.text,
    renderOptions: options.renderOptions,
    force: failsQa,
    // What production's QA would say once the layout is prepared the way it will be stored.
    ...(options.qa
      ? {
          issuesFor: (l: StudioLayoutV2) => {
            const clone = JSON.parse(JSON.stringify(l)) as StudioLayoutV2;
            const prepared = options.canvas ? prepareGeneratedLayoutV3(clone, copy, options.canvas) : sanitizeFontsV3(clone, copy);
            return evaluateHardQa(prepared, withCopy(options.qa!, copy)).messages;
          },
        }
      : {}),
  });

  const keep = (reason: RefinementOutcomeV3['reason']): RefinementOutcomeV3 => ({
    layout: candidate.layout,
    metrics: candidate.metrics,
    ...(candidate.hardQa ? { hardQa: candidate.hardQa } : {}),
    adopted: false,
    reason,
    result,
  });

  if (result.gateDecision === 'skip') return keep('gate_passed');
  if (!isUsableLayout(result.finalLayout)) return keep('rejected_unusable');

  const repaired = JSON.parse(JSON.stringify(result.finalLayout)) as StudioLayoutV2;
  const refined = options.canvas
    ? prepareGeneratedLayoutV3(repaired, copy, options.canvas)
    : sanitizeFontsV3(repaired, copy);
  const metrics = measureDesignV3(refined, copy);
  const hardQa = options.qa ? evaluateHardQa(refined, withCopy(options.qa, copy)) : undefined;

  // Adopt only a repair that strictly outranks the original, by the order the ranking uses.
  // (Pass the same `qa` here as to rankCandidatesV3: a missing verdict counts as a pass.)
  if (compareCandidatesV3({ metrics, hardQa }, candidate) >= 0) {
    return keep('rejected_no_improvement');
  }
  const reason: RefinementOutcomeV3['reason'] =
    hardQa?.passed && candidate.hardQa && !candidate.hardQa.passed
      ? 'adopted_now_passes_qa'
      : metrics.passed && !candidate.metrics.passed
        ? 'adopted_now_passes'
        : 'adopted_higher_score';
  return { layout: refined, metrics, ...(hardQa ? { hardQa } : {}), adopted: true, reason, result };
}

export interface WinnerSelectionV3 {
  winner: RankedCandidateV3;
  runnerUp: RankedCandidateV3 | null;
  /**
   * single_candidate — nothing to compare.
   * judge — the judge picked the same candidate from both positions and passed its canary.
   * composite_after_tie — the judge's two orderings disagreed, so the higher composite stands.
   * composite_judge_unreliable — the judge picked, then failed to beat a degraded copy of its own
   *   pick; a judge that cannot see that is not trusted, and the higher composite stands.
   */
  decidedBy: 'single_candidate' | 'judge' | 'composite_after_tie' | 'composite_judge_unreliable';
  match: PairwiseMatchResult | null;
  /** The canary run on `subject` — the judge's pick, or the higher composite after a tie. */
  canary: { passed: boolean; match: PairwiseMatchResult; subject: RankedCandidateV3 } | null;
  /** Whether the judge beat the degraded canary in both orders. Null when no judge ran. */
  judgeReliable: boolean | null;
}

/**
 * P07: the judge compares the top two candidates in both orders, dimension by dimension, and a
 * degraded copy of the chosen design checks that the judge can see an obvious defect. The pick
 * stands only if the judge chose it from both positions and then beat the canary from both.
 */
export async function selectWinnerV3(
  ranked: RankedCandidateV3[],
  copy: PipelineV3Copy,
  options: PipelineV3CallOptions = {}
): Promise<WinnerSelectionV3> {
  if (ranked.length === 0) throw new Error('selectWinnerV3 needs at least one candidate');
  if (ranked.length === 1) {
    return {
      winner: ranked[0],
      runnerUp: null,
      decidedBy: 'single_candidate',
      match: null,
      canary: null,
      judgeReliable: null,
    };
  }

  const judgeOptions = {
    reference: options.reference,
    client: options.client,
    model: options.model || resolveModel('judge'),
    renderOptions: { ...options.renderOptions, copyText: copy.text },
  };
  const renderOptionsFor = (candidate: RankedCandidateV3): RenderLayoutOptions => ({
    ...options.renderOptions, ...options.renderOptionsForCandidate?.(candidate), copyText: copy.text,
  });
  const asJudgeInput = (c: RankedCandidateV3, id: string): CandidateJudgeInput => ({
    id,
    layout: c.layout,
    deterministicMetrics: c.metrics,
    renderedPng: c.renderedPng || renderLayoutV2(c.layout, renderOptionsFor(c)).png,
  });

  const [first, second] = ranked;
  const firstId = `candidate_${first.sourceIndex}`;
  const secondId = `candidate_${second.sourceIndex}`;
  const match = await comparePairWithOrderSwap(asJudgeInput(first, firstId), asJudgeInput(second, secondId), judgeOptions);

  const judgePick = match.winnerId === firstId ? first : match.winnerId === secondId ? second : null;
  const tentative = judgePick ?? first;

  // Both sides use the tentative winner's identical asset bundle; only the layout is degraded.
  const canaryRenderOptions = renderOptionsFor(tentative);
  const canaryLayout = createDegradedCanaryLayout(tentative.layout);
  const canaryMatch = await comparePairWithOrderSwap(
    {
      id: 'chosen',
      layout: tentative.layout,
      deterministicMetrics: tentative.metrics,
      renderedPng: renderLayoutV2(tentative.layout, canaryRenderOptions).png,
    },
    {
      id: 'degraded_canary',
      layout: canaryLayout,
      deterministicMetrics: measureDesignV3(canaryLayout, copy),
      renderedPng: renderLayoutV2(canaryLayout, canaryRenderOptions).png,
    },
    judgeOptions
  );
  const canaryPassed = canaryMatch.winnerId === 'chosen';
  const canary = { passed: canaryPassed, match: canaryMatch, subject: tentative };

  if (!judgePick) {
    return { winner: first, runnerUp: second, decidedBy: 'composite_after_tie', match, canary, judgeReliable: canaryPassed };
  }
  if (!canaryPassed) {
    return { winner: first, runnerUp: second, decidedBy: 'composite_judge_unreliable', match, canary, judgeReliable: false };
  }
  return {
    winner: judgePick,
    runnerUp: judgePick === first ? second : first,
    decidedBy: 'judge',
    match,
    canary,
    judgeReliable: true,
  };
}
