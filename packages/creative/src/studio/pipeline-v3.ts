import { resolveModel } from '@hawa/domain';
import type { StudioLayoutV2 } from './layout-v2.js';
import { evaluateDesignMetrics, type DesignMetricsReport } from './design-metrics.js';
import { renderLayoutV2, measureWrappedLines } from './render-layout-v2.js';
import { correctFontsThatCannotDrawTheCopy, centerSeparatorsInGaps } from './layout-generator-v3.js';
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
import { HOUSE_RULES, minLogoWidth, logoClearZone } from './house-rules.js';
import { normalizeHex } from './validate-layout-v2.js';

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
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

function scriptOf(copy: PipelineV3Copy, copyIndex: number): CopyScriptV3 {
  return copy.scripts?.[copyIndex] ?? (ARABIC_SCRIPT.test(copy.text[copyIndex] ?? '') ? 'arabic' : 'latin');
}

/**
 * Maps a family the model chose onto the admitted set, by the role and script of its block.
 * Body and footer copy use the formal body faces; display copy keeps an admitted display face.
 * Amiri, not Cairo, is the right-to-left default: Cairo cannot draw the Sorani letters ڕ ڵ ۆ ێ ە.
 */
export function admittedFontFor(font: string, script: CopyScriptV3, role?: string): string {
  if (role === 'body' || role === 'footer') {
    return script === 'arabic' ? 'Noto Sans Arabic' : 'Verdana';
  }
  if (script === 'arabic') {
    return font === 'Cairo' || font === 'Amiri' || font === 'Noto Sans Arabic' ? font : 'Amiri';
  }
  if (font === 'Cinzel' || font === 'Playfair Display' || font === 'Verdana') return font;
  if (font === 'Lora') return 'Playfair Display';
  return 'Cinzel';
}

/**
 * Puts every block in an admitted face for its own script, then swaps any face that cannot draw
 * the block's actual characters. Mutates and returns the layout.
 *
 * Decided per block rather than per brief, so a bilingual design keeps its English display face
 * on English blocks and its Sorani face on Sorani ones. Direction is decided here too, from the
 * copy: a Sorani block the model left unmarked would otherwise render left-to-right, and the
 * coverage check — which reads a block's script from its direction — would skip it entirely.
 */
export function sanitizeFontsV3(layout: StudioLayoutV2, copy: PipelineV3Copy): StudioLayoutV2 {
  for (const t of layout.text) {
    const script = scriptOf(copy, t.copyIndex);
    t.rtl = script === 'arabic';
    t.fontFamily = admittedFontFor(t.fontFamily, script, t.role) as any;
  }
  correctFontsThatCannotDrawTheCopy(layout, copy.text);
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

  // A logo whose clear space still reaches the text below it is lifted towards the top margin —
  // never above it, never into anything above it. The cheap tier put a 154px banner logo at
  // y=203 with 88px free above it, and its clear space overlapped the eyebrow by 13px.
  if (layout.logo) {
    const l = layout.logo;
    const blockers: Rect[] = [...layout.text, ...(layout.shapes || []).filter((s) => s.role === 'rule')];
    const clearAt = (y: number) => !blockers.some((b) => intersects(b, logoClearZone({ ...l, y })));
    if (!clearAt(l.y)) {
      for (let y = l.y - 1; y >= m; y--) {
        if (clearAt(y)) {
          layout.logo = { ...l, y };
          break;
        }
      }
    }
  }

  // Vertical space is inserted where the layout needs it — a box whose copy no longer fits at the
  // house leading, a block that collides with the one above it or with the logo's clear space —
  // by moving everything below that line down. Order and horizontal structure are kept, and
  // nothing is moved if the content would leave the safe area; such layouts are left for QA to
  // reject and refinement to repair.
  const safeBottom = safe.y + safe.height;
  const fullBleed = (s: Rect) => s.width >= 0.98 * W && s.height >= 0.98 * H;
  const insertSpace = (atY: number, delta: number, keep: Set<object>): boolean => {
    if (delta <= 0) return true;
    const moving = [
      ...layout.text.filter((o) => o.y >= atY && !keep.has(o)),
      ...(layout.shapes || []).filter((s) => !fullBleed(s) && s.y >= atY && !keep.has(s)),
    ];
    // A panel that spans the insertion line stretches with it, so the text it holds stays inside.
    const stretching = (layout.shapes || []).filter(
      (s) => !fullBleed(s) && s.role === 'panel' && s.y < atY && s.y + s.height > atY && !keep.has(s)
    );
    const lowest = Math.max(0, ...moving.map((o) => o.y + o.height));
    if (moving.length && lowest + delta > safeBottom) return false;
    if (stretching.some((s) => s.y + s.height + delta > H)) return false;
    for (const o of moving) o.y += delta;
    for (const s of stretching) s.height += delta;
    return true;
  };
  const overlapsX = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x;

  const lines = measureWrappedLines(layout, copy.text);
  const ordered = [...layout.text].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of ordered) {
    // Clear the logo's zone and every block above that shares a column with this one.
    const zone = layout.logo ? logoClearZone(layout.logo) : null;
    const above: Rect[] = [
      ...(zone && layout.logo && t.y >= layout.logo.y && overlapsX(zone, t) ? [zone] : []),
      ...layout.text.filter((o) => o !== t && o.y < t.y && overlapsX(o, t)),
    ];
    const clash = Math.max(0, ...above.map((o) => Math.ceil(o.y + o.height - t.y)));
    if (clash > 0) insertSpace(t.y, clash, new Set());

    // Grow the box to hold its copy at the house leading.
    const needed = Math.ceil((lines[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight);
    if (needed > t.height) {
      const bottom = t.y + t.height;
      if (insertSpace(bottom, needed - t.height, new Set([t]))) t.height = needed;
    }
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
  canvas: { width: number; height: number; logoAspect?: number; palette?: string[] }
): StudioLayoutV2 {
  const aspect = canvas.logoAspect || 1.0;
  const fitted = fitLogoToAspect(layout, aspect, { width: canvas.width, margin: layout.grid?.margin ?? 0 });
  const normalized = normalizeStudioLayout(fitted, canvas.width, canvas.height, aspect);
  return conformToHouseRules(sanitizeFontsV3(normalized, copy), copy, canvas.palette);
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
      ...(qa ? { hardQa: evaluateHardQa(c.layout, qa) } : {}),
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
    client: options.client,
    model: options.model || resolveModel('critique'),
    deterministicMetrics: candidate.metrics,
    renderOptions: { copyText: copy.text },
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
  canvas?: { width: number; height: number; logoAspect?: number; palette?: string[] };
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
    client: options.client,
    model: options.model || resolveModel('layout'),
    maxRounds: 2,
    minDelta: 0.01,
    copyText: copy.text,
    force: failsQa,
    // What production's QA would say once the layout is prepared the way it will be stored.
    ...(options.qa
      ? {
          issuesFor: (l: StudioLayoutV2) => {
            const clone = JSON.parse(JSON.stringify(l)) as StudioLayoutV2;
            const prepared = options.canvas ? prepareGeneratedLayoutV3(clone, copy, options.canvas) : sanitizeFontsV3(clone, copy);
            return evaluateHardQa(prepared, options.qa!).messages;
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
  const hardQa = options.qa ? evaluateHardQa(refined, options.qa) : undefined;

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
    client: options.client,
    model: options.model || resolveModel('judge'),
    renderOptions: { copyText: copy.text },
  };
  const asJudgeInput = (c: RankedCandidateV3, id: string): CandidateJudgeInput => ({
    id,
    layout: c.layout,
    deterministicMetrics: c.metrics,
    renderedPng: c.renderedPng || renderLayoutV2(c.layout, { copyText: copy.text }).png,
  });

  const [first, second] = ranked;
  const firstId = `candidate_${first.sourceIndex}`;
  const secondId = `candidate_${second.sourceIndex}`;
  const match = await comparePairWithOrderSwap(asJudgeInput(first, firstId), asJudgeInput(second, secondId), judgeOptions);

  const judgePick = match.winnerId === firstId ? first : match.winnerId === secondId ? second : null;
  const tentative = judgePick ?? first;

  // Both sides of the canary are rendered the same way, from the layout alone. Handing the judge
  // the chosen design's own render — which may carry art — against a plain render of the degraded
  // copy would let the art, not the judge's eye for the defect, win the canary.
  const canaryLayout = createDegradedCanaryLayout(tentative.layout);
  const canaryMatch = await comparePairWithOrderSwap(
    {
      id: 'chosen',
      layout: tentative.layout,
      deterministicMetrics: tentative.metrics,
      renderedPng: renderLayoutV2(tentative.layout, { copyText: copy.text }).png,
    },
    {
      id: 'degraded_canary',
      layout: canaryLayout,
      deterministicMetrics: measureDesignV3(canaryLayout, copy),
      renderedPng: renderLayoutV2(canaryLayout, { copyText: copy.text }).png,
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
