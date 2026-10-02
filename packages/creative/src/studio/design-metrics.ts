import type { StudioLayoutV2, Box, TextElement, ShapeElement, OverlayElement, PhotoElement } from './layout-v2.js';
import { declaredTextContrast } from './composite-contrast.js';
import { requiredContrast } from './house-rules.js';
import { photoRecipeOf } from './layout-v2.js';
import { carrierOf, overlayOpacityAt } from './art-direction/surfaces.js';
import { NEGATIVE_SPACE_POLICY, negativeSpacePolicyIdentity, scoreNegativeSpace, type NegativeSpaceMeasure } from './negative-space-policy.js';

export interface MetricResult {
  score: number; // 0..1
  passed: boolean;
  metric: string;
  details?: Record<string, unknown>;
}

export interface DesignMetricsReport {
  compositeScore: number; // 0..1
  passed: boolean;
  qualityScore: number;
  complianceScore: number;
  exemplarSimilarityScore: number;
  metrics: {
    textLegibility: MetricResult;
    gridAppropriateness: MetricResult;
    alignment: MetricResult;
    balance: MetricResult;
    justification: MetricResult;
    regularity: MetricResult;
    typefacePairing: MetricResult;
    negativeSpace: MetricResult;
    semanticLayout: MetricResult;
    semanticTypography: MetricResult;
    occlusion: MetricResult;
    typeScale: MetricResult;
    degeneracy: MetricResult;
  };
  failingMetrics: string[];
  executionTimeMs: number;
}

export interface CandidateSetDegeneracyResult {
  isDegenerate: boolean;
  reason?: string;
  pairwiseDistances: number[];
  /** Indices into the supplied candidate array, before any duplicate is removed. */
  duplicatePairs?: Array<[number, number]>;
}

const ADMITTED_DISPLAY_FONTS = new Set([
  'Cinzel',
  'Montserrat',
  'Lora',
  'Cairo',
  'Amiri',
  'Playfair Display',
  'Plus Jakarta Sans',
  'Vazirmatn',
  'Inter',
  'Libre Baskerville',
  'Cormorant Garamond',
  'Prata',
  'Bodoni Moda',
  'Merriweather',
  'PT Serif',
  'Oswald',
  'Raleway',
  // ADR-238: the faces of KAAE's 2025 guideline and the admitted Sorani display sans.
  'Crimson Pro',
  'IBM Plex Sans Arabic',
]);

/**
 * The faces the body role may use: the registry's body faces (render-fonts.json). Inter joined
 * Verdana and Noto Sans Arabic on 2026-10-01 (ADR-238: KAAE's 2025 guideline sets body in Inter), so
 * an Inter body is no longer scored as a role violation.
 */
const ADMITTED_BODY_FONTS = new Set(['Verdana', 'Noto Sans Arabic', 'Inter']);

export const ADMITTED_TYPE_SCALE_RATIOS = [1.125, 1.200, 1.250, 1.333, 1.414, 1.500, 1.618];

/**
 * Medium-aware type scale configuration:
 * Adapts typographic hierarchy ratios to canvas dimensions and medium constraints:
 * - 9:16 vertical stories: punchy display ratios (1.250 - 1.618) for mobile readability
 * - A4 / print documents: compact, high-density ratios (1.125 - 1.333) for structured documents
 * - 16:9 landscape: balanced ratios (1.200 - 1.414)
 */
export function getMediumAwareTypeScaleRatios(width: number, height: number): number[] {
  const aspect = height / width;
  if (aspect >= 1.7) {
    return [1.250, 1.333, 1.414, 1.500, 1.618];
  }
  if (width >= 1200 && height >= 1600) {
    return [1.125, 1.200, 1.250, 1.333, 1.414, 1.500];
  }
  if (width / height >= 1.7) {
    return [1.200, 1.250, 1.333, 1.414];
  }
  return ADMITTED_TYPE_SCALE_RATIOS;
}

// 1. Text Legibility
export function computeTextLegibility(layout: StudioLayoutV2): MetricResult {
  if (!layout.text || layout.text.length === 0) {
    return { score: 0, passed: false, metric: 'textLegibility', details: { reason: 'NO_TEXT' } };
  }

  let totalPenalty = 0;
  const failingIssues: string[] = [];

  for (let i = 0; i < layout.text.length; i++) {
    const el = layout.text[i];

    // Minimum font size by role
    let minSize = 12;
    if (el.role === 'title') minSize = 22;
    else if (el.role === 'subtitle') minSize = 16;
    else if (el.role === 'body') minSize = 13;
    else if (el.role === 'cta') minSize = 14;
    else if (el.role === 'footer') minSize = 10;

    if (el.fontSize < minSize) {
      totalPenalty += 0.2;
      failingIssues.push(`Text ${i} (${el.role}) fontSize ${el.fontSize} < ${minSize}`);
    }

    // Line height check
    if (el.lineHeight < 1.1 || el.lineHeight > 1.9) {
      totalPenalty += 0.1;
      failingIssues.push(`Text ${i} lineHeight ${el.lineHeight} out of range [1.1, 1.9]`);
    }

    // Ranking and refinement use the same spatial surface and size policy as hard QA.
    const contrast = declaredTextContrast(layout, el);
    const required = requiredContrast(el.fontSize, Boolean(el.bold));
    if (contrast < required) {
      const deficit = (required - contrast) / required;
      totalPenalty += Math.min(0.8, deficit * 1.0);
      failingIssues.push(`Text ${i} (${el.role}) contrast ${contrast.toFixed(2)}:1 < ${required}:1`);
    }
  }

  const score = Math.max(0, Math.min(1, 1.0 - totalPenalty / layout.text.length));
  const passed = score >= 0.70 && !failingIssues.some(msg => msg.includes('contrast'));

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'textLegibility',
    details: { failingIssues, count: layout.text.length }
  };
}

/**
 * ADR-273: what gridAppropriateness counts as on the grid, versioned like the negative-space policy.
 * 2026-10-02.1: canvas-edge bleeds, flush-to-margin boxes and text aligned on its own axis count for
 * every layout (they counted only for photo recipes, ADR-170); the pass score is unchanged.
 */
export const GRID_APPROPRIATENESS_POLICY = Object.freeze({
  id: 'studio.grid-appropriateness',
  version: '2026-10-02.1',
  /** A shape within this many px of a canvas edge bleeds off it. */
  bleedPx: 2,
  passScore: 0.7,
});

// 2. Grid Appropriateness
export function computeGridAppropriateness(layout: StudioLayoutV2): MetricResult {
  const width = layout.width;
  const height = layout.height;
  const margin = layout.grid?.margin || 70;
  const columns = layout.grid?.columns || 12;
  const gutter = layout.grid?.gutter || 20;

  // 16:9 PowerPoint presentation slides fail grid appropriateness for wrong canvas genre
  // (institutional social announcements, invitations, and posters are 1:1, 4:5, 9:16)
  if (layout.genre === 'presentation_slide') {
    return {
      score: 0.30,
      passed: false,
      metric: 'gridAppropriateness',
      details: {
        reason: 'WRONG_CANVAS_GENRE: 16:9 presentation slide aspect ratio rejected for social/announcement canvas (admitted: 1:1, 4:5, 9:16)',
        aspectRatio: `${width}:${height}`
      }
    };
  }

  const usableWidth = width - 2 * margin;

  // Generate grid boundary lines for declared columns and standard institutional sub-divisions (2, 3, 4, 6, 12)
  const colLefts = new Set<number>([margin]);
  const colRights = new Set<number>([width - margin]);
  const centerLines = new Set<number>([Math.round(width / 2)]);

  const divisions = Array.from(new Set([columns, 2, 3, 4, 6, 12]));
  for (const div of divisions) {
    const colW = (usableWidth - (div - 1) * gutter) / div;
    for (let c = 0; c < div; c++) {
      const left = margin + c * (colW + gutter);
      const right = left + colW;
      colLefts.add(Math.round(left));
      colRights.add(Math.round(right));
      centerLines.add(Math.round(left + colW / 2));
    }
  }

  // ADR-170: a recipe's gold frame follows the canvas edge, not the grid (nor does the tab that backs
  // its logo, which is aligned by the logo), and its corner logo and
  // flush-left (or, in Sorani, flush-right) text column are set on the margin. Counted as off-grid,
  // they ranked the office's own report layout (hero_fade_report, example 3) last in every live
  // trial of 2026-09-30 and kept it from the judge; a centred plate won on grid alone.
  //
  // ADR-273 (GRID_APPROPRIATENESS_POLICY 2026-10-02.1), calibrated on the office's own posts: what
  // held for recipes holds for every layout. A frame round the canvas follows the canvas edge; a
  // shape bleeding off the canvas edge (the office's title tab, its card, its footer bar) is aligned
  // to that edge; a box set on the margin is flush; and a text block is on the grid when its own
  // alignment axis is (its start edge, its end edge or its centre), whatever its ragged width. The
  // composed posters (ADR-271) failed this metric 20 of 20, ragged left text and bleeding bands, and
  // the office's call for peer evaluators scored 0.30-0.36 as a composed poster.
  const recipe = Boolean(layout.artDirection);
  const policy = GRID_APPROPRIATENESS_POLICY;
  const followsCanvas = (s: ShapeElement) => s.role === 'frame' || (s.fill === 'none' && s.width >= width * 0.85 && s.height >= layout.height * 0.85);
  const allBoxes: Array<Box & { align?: TextElement['align'] }> = [
    ...layout.text,
    ...layout.shapes.filter(s => !followsCanvas(s) && !(recipe && s.surface === 'tab') && (s.role !== 'panel' || (s.width < width * 0.9 && s.height < layout.height * 0.9))),
    layout.logo
  ].filter(Boolean);

  if (allBoxes.length === 0) {
    return { score: 1.0, passed: true, metric: 'gridAppropriateness' };
  }

  let alignedElements = 0;
  const tolerance = Math.max(8, width * 0.008); // ~8px tolerance

  const leftArr = Array.from(colLefts);
  const rightArr = Array.from(colRights);
  const centerArr = Array.from(centerLines);
  const textSet = new Set<Box>(layout.text);

  for (const b of allBoxes) {
    const left = b.x;
    const right = b.x + b.width;
    const center = Math.round(b.x + b.width / 2);

    const leftOnCol = leftArr.some(cl => Math.abs(left - cl) <= tolerance);
    const rightOnCol = rightArr.some(cr => Math.abs(right - cr) <= tolerance);
    const isCentered = centerArr.some(cc => Math.abs(center - cc) <= tolerance);
    const withinMargins = left >= margin - tolerance && right <= width - margin + tolerance;

    // Conforms if:
    // (1) Left and right edges align to grid column lines, OR
    // (2) Centered on a column / canvas axis within margins, OR
    // (3) Left edge aligns to a column start and width spans within margin, OR
    // (4) set flush on the margin, OR (5) bleeding off the canvas edge, OR
    // (6) a text block whose alignment axis is on the grid.
    const flush = Math.abs(left - margin) <= tolerance || Math.abs(right - (width - margin)) <= tolerance;
    const bleeds = left <= policy.bleedPx || right >= width - policy.bleedPx;
    const axisOnGrid = textSet.has(b) && withinMargins && (
      b.align === 'left' ? leftOnCol : b.align === 'right' ? rightOnCol : isCentered);
    if ((leftOnCol && rightOnCol) || (isCentered && withinMargins) || (leftOnCol && isCentered) || flush || (!textSet.has(b) && bleeds) || axisOnGrid) {
      alignedElements++;
    }
  }

  const score = alignedElements / allBoxes.length;
  const passed = score >= policy.passScore;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'gridAppropriateness',
    details: { alignedElements, totalElements: allBoxes.length, policyId: policy.id, policyVersion: policy.version }
  };
}

// 3. Alignment (arXiv 2402.06945: A / (A + d), A = 10)
export function computeAlignment(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  if (textElements.length <= 1) {
    return { score: 1.0, passed: true, metric: 'alignment' };
  }

  // Width variance
  const widths = textElements.map(t => t.width);
  const meanWidth = widths.reduce((sum, w) => sum + w, 0) / widths.length;
  const widthVariance = widths.reduce((sum, w) => sum + Math.pow((w - meanWidth) / meanWidth, 2), 0) / widths.length;

  // Line uniformity deviation: deviation from common alignment axes
  const lefts = textElements.map(t => t.x);
  const centers = textElements.map(t => t.x + t.width / 2);
  const rights = textElements.map(t => t.x + t.width);

  function minClusterDistance(coords: number[]): number {
    if (coords.length <= 1) return 0;
    const sorted = [...coords].sort((a, b) => a - b);
    let minDiffSum = 0;
    for (let i = 1; i < sorted.length; i++) {
      minDiffSum += Math.min(Math.abs(sorted[i] - sorted[i - 1]), 100);
    }
    return minDiffSum / (sorted.length - 1);
  }

  const leftDev = minClusterDistance(lefts) / 20;
  const centerDev = minClusterDistance(centers) / 20;
  const rightDev = minClusterDistance(rights) / 20;
  const lineUniformityDev = Math.min(leftDev, centerDev, rightDev);

  const d = 0.80 * widthVariance * 10 + 0.20 * lineUniformityDev;
  const score = 10 / (10 + d);
  const passed = score >= 0.70;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'alignment',
    details: { widthVariance: parseFloat(widthVariance.toFixed(3)), lineUniformityDev: parseFloat(lineUniformityDev.toFixed(3)), d: parseFloat(d.toFixed(3)) }
  };
}

// 4. Balance (arXiv 2402.06945: B = 1 - [((wx - cx)/w)^2 + ((wy - cy)/h)^2 / 2]^0.5)
export function computeBalance(layout: StudioLayoutV2): MetricResult {
  const w = layout.width;
  const h = layout.height;
  const cx = w / 2;
  const cy = h / 2;

  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const t of layout.text || []) {
    const area = t.width * t.height;
    const weight = area * (t.fontSize / 20) * (t.bold ? 1.3 : 1.0);
    weightedX += (t.x + t.width / 2) * weight;
    weightedY += (t.y + t.height / 2) * weight;
    totalWeight += weight;
  }

  for (const s of layout.shapes || []) {
    if (s.role === 'frame' || (s.width >= w * 0.95 && s.height >= h * 0.95)) continue;
    const area = s.width * s.height;
    const opacity = s.opacity !== undefined && s.opacity !== null ? s.opacity : 0.8;
    const weight = area * opacity * (s.role === 'panel' ? 0.3 : 0.8);
    weightedX += (s.x + s.width / 2) * weight;
    weightedY += (s.y + s.height / 2) * weight;
    totalWeight += weight;
  }

  // The client's photographs weigh like the imagery they are (ADR-157). They were left out, so a
  // design whose six photos filled the upper half measured as balanced as the same design without
  // them (audit 2026-09-30 #19). A cut-out person fills part of its box.
  for (const p of layout.photos || []) {
    const weight = p.width * p.height * (p.treatment === 'cutout' ? NEGATIVE_SPACE_POLICY.occupancy.photoCutoutWeight : NEGATIVE_SPACE_POLICY.occupancy.photoFramedWeight);
    weightedX += (p.x + p.width / 2) * weight;
    weightedY += (p.y + p.height / 2) * weight;
    totalWeight += weight;
  }

  if (layout.logo) {
    const logoArea = layout.logo.width * layout.logo.height;
    const weight = logoArea * 1.2;
    weightedX += (layout.logo.x + layout.logo.width / 2) * weight;
    weightedY += (layout.logo.y + layout.logo.height / 2) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    return { score: 1.0, passed: true, metric: 'balance' };
  }

  const wx = weightedX / totalWeight;
  const wy = weightedY / totalWeight;

  const dx = (wx - cx) / w;
  const dy = (wy - cy) / h;
  const offset = Math.sqrt((dx * dx + dy * dy) / 2);
  const score = Math.max(0, Math.min(1, 1 - offset));
  const passed = score >= 0.80;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'balance',
    details: { wx: Math.round(wx), wy: Math.round(wy), offset: parseFloat(offset.toFixed(4)) }
  };
}

// 5. Justification
export function computeJustification(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  if (textElements.length <= 1) {
    return { score: 1.0, passed: true, metric: 'justification' };
  }

  const counts: Record<string, number> = { left: 0, center: 0, right: 0 };
  for (const t of textElements) {
    counts[t.align] = (counts[t.align] || 0) + 1;
  }

  const dominant = Math.max(counts.left, counts.center, counts.right);
  const dominanceRatio = dominant / textElements.length;

  let score = dominanceRatio;
  // If dominant alignment is >= 75%, very clean
  if (dominanceRatio >= 0.75) {
    score = 0.95;
  } else if (dominanceRatio >= 0.50) {
    score = 0.75;
  } else {
    score = 0.40;
  }

  const passed = score >= 0.70;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'justification',
    details: { counts, dominanceRatio: parseFloat(dominanceRatio.toFixed(3)) }
  };
}

// 6. Regularity
export function computeRegularity(layout: StudioLayoutV2): MetricResult {
  const elements = [...(layout.text || [])].sort((a, b) => a.y - b.y);
  if (elements.length <= 2) {
    return { score: 1.0, passed: true, metric: 'regularity' };
  }

  // Check for mutual text collisions (2D overlapping text blocks)
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      const xOverlap = Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width);
      const yOverlap = Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height);
      if (xOverlap && yOverlap) {
        return {
          score: 0.2,
          passed: false,
          metric: 'regularity',
          details: {
            reason: 'MUTUAL_TEXT_OVERLAP: Text elements collide in 2D space',
            pair: [i, j],
          },
        };
      }
    }
  }

  const gaps: number[] = [];
  for (let i = 0; i < elements.length - 1; i++) {
    const a = elements[i];
    const b = elements[i + 1];
    const xOverlap = Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width);
    const gap = b.y - (a.y + a.height);
    if (xOverlap) {
      if (gap < 0) {
        return {
          score: 0.2,
          passed: false,
          metric: 'regularity',
          details: {
            reason: 'VERTICAL_OVERLAP: Vertically stacked text elements overlap',
            pair: [i, i + 1],
            gap,
          },
        };
      }
      gaps.push(gap);
    } else if (gap >= 0) {
      gaps.push(gap);
    }
  }

  if (gaps.length <= 1) {
    return { score: 1.0, passed: true, metric: 'regularity' };
  }

  const maxGap = Math.max(...gaps);
  // ADR-273: the dead area is a gap "without composition". A photo, a brand element or a panel
  // spanning the whole gap composes it: the office's forum post sets its date at the foot and
  // its paragraph at the top, with the speaker cut out beside them and its sunburst between. Such a
  // gap separates two groups of type; it is not a step of their rhythm, so it leaves the rhythm too.
  const composedGap = maxGap > layout.height * 0.25 && gapComposed(layout, deadGapBand(elements, maxGap));
  const rhythm = composedGap ? gaps.filter((g, i) => i !== gaps.indexOf(maxGap)) : gaps;
  const mean = rhythm.length ? rhythm.reduce((sum, g) => sum + g, 0) / rhythm.length : 0;
  const variance = rhythm.length ? rhythm.reduce((sum, g) => sum + Math.pow(g - mean, 2), 0) / rhythm.length : 0;
  const std = Math.sqrt(variance);

  if (maxGap > layout.height * 0.25 && !composedGap) {
    return {
      score: 0.35,
      passed: false,
      metric: 'regularity',
      details: {
        meanGap: Math.round(mean),
        std: Math.round(std),
        cv: parseFloat((std / (mean + 10)).toFixed(3)),
        maxGap,
        reason: 'EXCESSIVE_DEAD_AREA: Vertical gap exceeds 25% canvas height without composition'
      }
    };
  }

  const cv = std / (mean + 10);
  const score = Math.max(0, Math.min(1, 1 / (1 + cv)));
  const passed = score >= 0.55;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'regularity',
    details: { meanGap: Math.round(mean), std: Math.round(std), cv: parseFloat(cv.toFixed(3)), ...(composedGap ? { composedGap: maxGap } : {}) }
  };
}

/** The vertical band of the largest gap between consecutive text blocks (as computeRegularity measures it). */
function deadGapBand(sorted: TextElement[], gap: number): { y1: number; y2: number } | undefined {
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (b.y - (a.y + a.height) === gap) return { y1: a.y + a.height, y2: b.y };
  }
  return undefined;
}

/**
 * Whether a photo, a brand element or a panel spans the whole band. Whatever covers the canvas is
 * its ground, not composition, and generated art is not counted: it lies behind every gap alike.
 */
function gapComposed(layout: StudioLayoutV2, band: { y1: number; y2: number } | undefined): boolean {
  if (!band) return false;
  const spans = (b: Box) => b.y <= band.y1 && b.y + b.height >= band.y2;
  const ground = (b: Box) => b.width >= layout.width * 0.95 && b.height >= layout.height * 0.95;
  const composes = (b: Box) => spans(b) && !ground(b);
  return (layout.photos || []).some(composes) || (layout.ornaments || []).some(composes) ||
    (layout.shapes || []).some((s) => (s.role === 'panel' || s.role === 'accent') && s.fill !== 'none' && composes(s));
}

// 7. Typeface Pairing
export function computeTypefacePairing(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  if (textElements.length === 0) {
    return { score: 1.0, passed: true, metric: 'typefacePairing' };
  }

  const families = new Set(textElements.map(t => t.fontFamily));
  const familyCount = families.size;

  let score = 1.0;
  const failures: string[] = [];

  // Count penalty
  if (familyCount > 3) {
    score -= 0.5;
    failures.push(`Too many font families: ${familyCount} > 3`);
  } else if (familyCount === 3) {
    score -= 0.15;
  }

  // F12 Role-based Typography Enforcement
  for (const t of textElements) {
    if (t.role === 'body') {
      const isAdmittedBody = ADMITTED_BODY_FONTS.has(t.fontFamily);
      if (!isAdmittedBody) {
        score -= 0.4;
        failures.push(`F12 Violation: body role using non-body font "${t.fontFamily}"`);
      }
    } else {
      const isAdmitted = ADMITTED_DISPLAY_FONTS.has(t.fontFamily) || t.fontFamily === 'Verdana' || t.fontFamily === 'Noto Sans Arabic';
      if (!isAdmitted) {
        score -= 0.25;
        failures.push(`Unadmitted font family: "${t.fontFamily}"`);
      }
    }
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.70 && !failures.some(f => f.includes('F12 Violation'));

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'typefacePairing',
    details: { families: Array.from(families), familyCount, failures }
  };
}

/**
 * One element's paint for the negative-space union (policy 2026-10-02.1): `max` raises a point to
 * its weight, `set` covers what is under it, and `ink` is type, which stacks: two blocks of type
 * set over each other are both ink (the sum counted them twice, and so does this), while type on
 * a band, card or fade counts once.
 */
interface OccupancyPaint { box: Box; weight: number; mode: 'max' | 'set' | 'ink' }

/** Bands a photo's own fade is cut into; each band takes the fade's alpha at its middle, its exact mean. */
const PHOTO_FADE_BANDS = 16;

/** A photo's paint: its box at `weight`, the faded part in bands of falling alpha toward the fade's edge. */
function photoPaint(p: PhotoElement, weight: number): OccupancyPaint[] {
  if (!p.fade) return [{ box: p, weight, mode: 'max' }];
  const vertical = p.fade.edge === 'top' || p.fade.edge === 'bottom';
  const extent = vertical ? p.height : p.width;
  const fadeLength = Math.max(0, Math.min(1, p.fade.length)) * extent;
  const out: OccupancyPaint[] = [];
  // Offsets are measured from the faded edge inward: alpha rises from 0 at the edge to 1 at fadeLength.
  const band = (from: number, to: number, alpha: number) => {
    if (to <= from) return;
    let box: Box;
    if (p.fade!.edge === 'top') box = { x: p.x, y: p.y + from, width: p.width, height: to - from };
    else if (p.fade!.edge === 'bottom') box = { x: p.x, y: p.y + p.height - to, width: p.width, height: to - from };
    else if (p.fade!.edge === 'left') box = { x: p.x + from, y: p.y, width: to - from, height: p.height };
    else box = { x: p.x + p.width - to, y: p.y, width: to - from, height: p.height };
    out.push({ box, weight: weight * alpha, mode: 'max' });
  };
  for (let i = 0; i < PHOTO_FADE_BANDS; i++) {
    band((i / PHOTO_FADE_BANDS) * fadeLength, ((i + 1) / PHOTO_FADE_BANDS) * fadeLength, (i + 0.5) / PHOTO_FADE_BANDS);
  }
  band(fadeLength, extent, 1);
  return out;
}

/**
 * The parts of a fade or scrim at least `minOpacity` opaque, as boxes. Its opacity is piecewise
 * linear along its direction, so each run where it carries is found exactly. A radial overlay is the
 * soft scrim a logo gets (ADR-180), not ground for text, and is left out.
 */
function overlayCarryBoxes(o: OverlayElement, minOpacity: number): Box[] {
  if (o.direction === 'radial') return [];
  const stops = [...o.stops].sort((a, b) => a.at - b.at);
  if (!stops.length) return [];
  const points = [{ at: 0, opacity: overlayOpacityAt(o, 0) }, ...stops.filter((st) => st.at > 0 && st.at < 1), { at: 1, opacity: overlayOpacityAt(o, 1) }];
  const runs: Array<[number, number]> = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.at <= a.at) continue;
    const aIn = a.opacity >= minOpacity, bIn = b.opacity >= minOpacity;
    if (!aIn && !bIn) continue;
    const cross = a.at + ((minOpacity - a.opacity) / (b.opacity - a.opacity)) * (b.at - a.at);
    const run: [number, number] = aIn && bIn ? [a.at, b.at] : aIn ? [a.at, cross] : [cross, b.at];
    const last = runs[runs.length - 1];
    if (last && Math.abs(last[1] - run[0]) < 1e-9) last[1] = run[1];
    else runs.push(run);
  }
  return runs.map(([from, to]) => {
    switch (o.direction) {
      case 'to-bottom': return { x: o.x, y: o.y + from * o.height, width: o.width, height: (to - from) * o.height };
      case 'to-top': return { x: o.x, y: o.y + (1 - to) * o.height, width: o.width, height: (to - from) * o.height };
      case 'to-right': return { x: o.x + from * o.width, y: o.y, width: (to - from) * o.width, height: o.height };
      default: return { x: o.x + (1 - to) * o.width, y: o.y, width: (to - from) * o.width, height: o.height };
    }
  });
}

/**
 * The occupied area of a paint list over a canvas: the plane is cut at every box edge, and each
 * resulting cell takes the weight the paints leave on it in order (`max` raises it, `set` replaces
 * it), or the type stacked on it when that is more. Exact for boxes; a fade enters as its bands.
 */
function unionOccupiedArea(paint: OccupancyPaint[], width: number, height: number): number {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const xs = new Set<number>([0, width]);
  const ys = new Set<number>([0, height]);
  for (const { box } of paint) {
    xs.add(clip(box.x, width)); xs.add(clip(box.x + box.width, width));
    ys.add(clip(box.y, height)); ys.add(clip(box.y + box.height, height));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const nx = X.length - 1, ny = Y.length - 1;
  if (nx <= 0 || ny <= 0) return 0;
  const cells = new Float64Array(nx * ny);
  const ink = new Float64Array(nx * ny);
  const index = (edges: number[], v: number) => {
    let lo = 0, hi = edges.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (edges[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const { box, weight, mode } of paint) {
    const x0 = index(X, clip(box.x, width)), x1 = index(X, clip(box.x + box.width, width));
    const y0 = index(Y, clip(box.y, height)), y1 = index(Y, clip(box.y + box.height, height));
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const k = j * nx + i;
        if (mode === 'ink') ink[k] += weight;
        else cells[k] = mode === 'set' ? weight : Math.max(cells[k], weight);
      }
    }
  }
  let area = 0;
  for (let j = 0; j < ny; j++) {
    const h = Y[j + 1] - Y[j];
    for (let i = 0; i < nx; i++) area += Math.max(cells[j * nx + i], ink[j * nx + i]) * (X[i + 1] - X[i]) * h;
  }
  return area;
}

/**
 * The framed photo that leads a layout (policy 2026-10-02.1): one framed photo over
 * `photoLed.framedPhotoShare` of the canvas. A cut-out, a texture and a cell of a photo grid do not
 * lead; a layout led this way is measured as an art-directed recipe is.
 */
export function photoLedPhoto(layout: Pick<StudioLayoutV2, 'width' | 'height' | 'photos'>): PhotoElement | undefined {
  const share = NEGATIVE_SPACE_POLICY.photoLed.framedPhotoShare;
  return (layout.photos || []).find((p) => p.treatment !== 'cutout' && p.role !== 'texture' &&
    Math.max(0, Math.min(layout.width, p.x + p.width) - Math.max(0, p.x)) * Math.max(0, Math.min(layout.height, p.y + p.height) - Math.max(0, p.y)) >=
      share * layout.width * layout.height);
}

// 8. Negative-Space Fraction (Calibrated against 6 institutional exemplars: 0.34 - 0.57)
/**
 * @param wrappedLines how many lines each copy block wraps to, by copyIndex. When supplied, a text
 * block counts the area its type inks rather than the area of its bounding box.
 *
 * Counting the box is wrong in principle — a box is invisible metadata whose height the generator
 * picks, and shrinking one around its centre changes no pixel of the render while moving this
 * score by 0.68. But the 0.30-0.60 optimal band below was calibrated with the box measure, so
 * supplying wrappedLines against the current band produces false failures: it fails 15 of the 18
 * T5 layouts. It should not be switched on in the scoring path until the band is re-derived.
 *
 * And the band itself is suspect in the other direction. The owner's six confirmed exemplars
 * measure 0.11-0.15 block coverage when their glyphs are dilated into blocks — 85-89% empty,
 * sparser than anything this pipeline generates. Generous whitespace is the house style, so
 * "excessive emptiness" as defined here may not describe a defect at all. Re-derive the band from
 * the exemplars, by the same measure, before trusting either side of this.
 */
export function computeNegativeSpace(
  layout: StudioLayoutV2,
  wrappedLines?: Record<number, number>
): MetricResult {
  if (photoRecipeOf(layout) || photoLedPhoto(layout)) return computeRecipeQuietRegion(layout, wrappedLines);
  const totalArea = layout.width * layout.height;
  const occupancy = NEGATIVE_SPACE_POLICY.occupancy;

  interface Span { y1: number; y2: number; }
  const substantiveSpans: Span[] = [];
  let maxSubstantiveY = 0;
  const addSpan = (y1: number, y2: number) => {
    substantiveSpans.push({ y1, y2 });
    maxSubstantiveY = Math.max(maxSubstantiveY, y2);
  };

  // Occupancy is a union (policy 2026-10-02.1, ADR-273): each element paints its weight over its
  // area in the order the renderer draws it, and a point counts once, at the weight left on it. The
  // sum it replaced counted a band and the title on it twice, and a photo under the navy fade a
  // report title sits on as fully occupied, so the office's own posts measured 0.00-0.48 empty.
  const paint: OccupancyPaint[] = [];
  const sameColour = (a?: string, b?: string) => {
    const norm = (h?: string) => {
      const c = (h || '').trim().toLowerCase();
      return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
    };
    return !!a && !!b && norm(a) === norm(b);
  };
  // A border around the canvas is not content. The rule used to key on the role alone, and the
  // studio's normaliser renames frames to panels — so a background-filled border enclosing 86%
  // of the canvas counted as 60% occupied and flipped a 76%-empty design to "29% empty". A
  // background-filled shape that large is a border whatever it is called. Smaller outlined
  // cards still count: the P01 calibration deliberately treats content frames as occupied.
  const isCanvasFrame = (s: ShapeElement) =>
    ((s.role === 'frame' || sameColour(s.color, layout.background?.color)) &&
      s.width >= layout.width * occupancy.canvasFrameShare &&
      s.height >= layout.height * occupancy.canvasFrameShare) ||
    (s.width >= layout.width * occupancy.canvasShapeShare && s.height >= layout.height * occupancy.canvasShapeShare);
  const shapeWeight = (s: ShapeElement) => (s.role === 'panel' || s.role === 'frame' ? occupancy.panelOrFrameWeight : occupancy.otherShapeWeight);
  const shapes = (layout.shapes || []).filter((s) => !isCanvasFrame(s));
  for (const s of shapes) {
    if (s.layer !== 'overlay') paint.push({ box: s, weight: shapeWeight(s), mode: 'max' });
    if (s.height >= NEGATIVE_SPACE_POLICY.internalGap.spanMinHeightPx && s.role !== 'rule') addSpan(s.y, s.y + s.height);
  }
  // Photographs are content (policy 2026-09-30.1, ADR-157): counted in the occupied area and as
  // spans. Without them the gap between a logo and a photo grid measured as the gap between the
  // logo and whatever text sat under the grid, a phantom band, while the real one went unseen.
  for (const p of layout.photos || []) {
    const weight = (p.treatment === 'cutout' ? occupancy.photoCutoutWeight : occupancy.photoFramedWeight) * (p.opacity ?? 1);
    paint.push(...photoPaint(p, weight));
    addSpan(p.y, p.y + p.height);
  }
  // Under a fade or scrim opaque enough to carry text, a photo is the ground the text sits on.
  for (const o of layout.overlays || []) {
    for (const box of overlayCarryBoxes(o, occupancy.groundUnderOverlayMinOpacity)) paint.push({ box, weight: 0, mode: 'set' });
  }
  for (const s of shapes) {
    if (s.layer === 'overlay') paint.push({ box: s, weight: shapeWeight(s), mode: s.fill === 'none' ? 'max' : 'set' });
  }
  if (layout.logo) {
    paint.push({ box: layout.logo, weight: 1, mode: 'max' });
    addSpan(layout.logo.y, layout.logo.y + layout.logo.height);
  }
  for (const t of layout.text || []) {
    const lines = wrappedLines?.[t.copyIndex];
    const inkedHeight =
      lines && lines > 0 ? Math.min(t.height, lines * t.fontSize * t.lineHeight) : t.height;
    paint.push({ box: { x: t.x, y: t.y + (t.height - inkedHeight) / 2, width: t.width, height: inkedHeight }, weight: 1, mode: 'ink' });
    addSpan(t.y, t.y + t.height);
  }
  // The declared-box fallback (no line measurement) keeps the box sum its band was calibrated on:
  // the union moves 22 of the 200 stored designs across that band, and the office calibration is
  // measured with lines (ADR-273).
  const occupiedArea = wrappedLines
    ? unionOccupiedArea(paint, layout.width, layout.height)
    : (layout.text || []).reduce((sum, t) => sum + t.width * t.height, 0) +
      shapes.reduce((sum, s) => sum + s.width * s.height * shapeWeight(s), 0) +
      (layout.logo ? layout.logo.width * layout.logo.height : 0) +
      (layout.photos || []).reduce((sum, p) => sum + p.width * p.height *
        (p.treatment === 'cutout' ? occupancy.photoCutoutWeight : occupancy.photoFramedWeight), 0);

  const fraction = Math.max(0, Math.min(1, 1 - occupiedArea / totalArea));

  // The band belongs to the measure, so it moves with it. Counting boxes and counting type give
  // different emptiness for the same design — measured across 20 production layouts, the box
  // measure spans 0.412-0.637 and the type measure 0.553-0.827 — so one band cannot serve both.
  //
  // The type band is placed so this corpus sits where it sat under the box band: comfortably
  // inside the plateau, median just below its upper edge, the emptiest design just past it into
  // the taper. That preserves every accept/reject decision the metric already makes on real work
  // while removing the reason it preferred one composition, which is the whole point of switching.
  // Both bands, the gap and bottom-void penalties and the pass score live in the versioned policy
  // the layout generator is told (ADR-125).
  const measure: NegativeSpaceMeasure = wrappedLines ? 'measured_lines' : 'declared_boxes';

  // Detect largest internal dead gap between consecutive substantive content blocks
  substantiveSpans.sort((a, b) => a.y1 - b.y1);
  let maxInternalGap = 0;
  let currentFurthest = substantiveSpans[0]?.y2 || 0;

  for (let i = 1; i < substantiveSpans.length; i++) {
    const span = substantiveSpans[i];
    if (span.y1 > currentFurthest) {
      const gap = span.y1 - currentFurthest;
      maxInternalGap = Math.max(maxInternalGap, gap);
    }
    currentFurthest = Math.max(currentFurthest, span.y2);
  }

  const internalGapFraction = maxInternalGap / layout.height;
  // Substantive institutional content should reach far enough down the canvas (bottom void).
  const bottomVoid = (layout.height - maxSubstantiveY) / layout.height;
  const score = scoreNegativeSpace({ fraction, internalGapFraction, bottomVoid, measure });
  const passed = score >= NEGATIVE_SPACE_POLICY.passScore;
  const policy = negativeSpacePolicyIdentity();

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'negativeSpace',
    details: {
      fraction: parseFloat(fraction.toFixed(3)),
      internalGapFraction: parseFloat(internalGapFraction.toFixed(3)),
      bottomVoid: parseFloat(bottomVoid.toFixed(3)),
      occupiedArea: Math.round(occupiedArea),
      totalArea,
      measure,
      policyId: policy.id,
      policyVersion: policy.version,
      policySha256: policy.sha256,
    },
  };
}

/**
 * ADR-170: the negative-space check of an art-directed recipe. A full-bleed hero fills the canvas by
 * design, so counting it as occupied area failed every design that uses a photo the way the office
 * does. What a recipe needs instead is a quiet region for the title: the title inside the region the
 * solver reserved (the fade, plate, card or sky), carried by a surface wherever it lies over a photo,
 * and the copy not crowding the canvas (inked type under 35% of it).
 *
 * ADR-273 (policy 2026-10-02.1): a layout led by one framed photo (`photoLedPhoto`) is measured the
 * same way when it carries no recipe record, as a composed poster with an office photo does. With no
 * reserved region, the title's quiet ground is anywhere off the photos, or a carrier over them.
 */
export function computeRecipeQuietRegion(layout: StudioLayoutV2, wrappedLines?: Record<number, number>): MetricResult {
  const zone = layout.artDirection?.titleZone;
  const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const inside = (o: Box, i: Box) => i.x >= o.x - 2 && i.y >= o.y - 2 && i.x + i.width <= o.x + o.width + 2 && i.y + i.height <= o.y + o.height + 2;
  const title = (layout.text || []).find((t) => t.role === 'title');
  const onQuietGround = (t: Box) => !(layout.photos || []).some((p) => hit(p, t)) || Boolean(carrierOf(layout, t));
  const inZone = title ? (zone ? inside(zone, title) : onQuietGround(title)) : false;
  const bare = (layout.text || []).filter((t) => (layout.photos || []).some((p) => hit(p, t)) && !carrierOf(layout, t));
  let inked = 0;
  for (const t of layout.text || []) {
    const lines = wrappedLines?.[t.copyIndex];
    inked += t.width * (lines && lines > 0 ? Math.min(t.height, lines * t.fontSize * t.lineHeight) : t.height);
  }
  const coverage = inked / (layout.width * layout.height);
  const limit = NEGATIVE_SPACE_POLICY.photoLed.inkCoverageMax;
  const crowding = coverage <= limit ? 1 : Math.max(0, 1 - (coverage - limit) * 3);
  const score = (inZone ? 0.45 : 0) + (bare.length ? 0 : 0.35) + 0.2 * crowding;
  const recipe = photoRecipeOf(layout);
  const policy = negativeSpacePolicyIdentity();
  return {
    score: parseFloat(score.toFixed(3)),
    passed: inZone && !bare.length && crowding >= 0.7,
    metric: 'negativeSpace',
    details: {
      measure: recipe ? 'recipe_quiet_region' : 'photo_led_quiet_region',
      recipe: recipe ?? null,
      titleInQuietRegion: inZone,
      bareTextOnPhoto: bare.map((t) => t.copyIndex),
      inkCoverage: parseFloat(coverage.toFixed(3)),
      policyId: policy.id,
      policyVersion: policy.version,
      policySha256: policy.sha256,
    },
  };
}

// 9. Semantic Significance of Layout
export function computeSemanticLayout(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  const title = textElements.find(t => t.role === 'title');
  const body = textElements.find(t => t.role === 'body');
  const footer = textElements.find(t => t.role === 'footer');

  if (textElements.length <= 1 || !title) {
    return {
      score: 0.20,
      passed: false,
      metric: 'semanticLayout',
      details: { issues: ['Lacks a primary title: a layout with no title role, or a single text element, has no hierarchy'] }
    };
  }

  let score = 1.0;
  const issues: string[] = [];

  if (title && body) {
    if (title.y > body.y + 50) {
      score -= 0.4;
      issues.push(`Title Y (${title.y}) is placed below Body Y (${body.y})`);
    }
  }

  if (footer && body) {
    if (footer.y < body.y) {
      score -= 0.3;
      issues.push(`Footer Y (${footer.y}) is placed above Body Y (${body.y})`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.75;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'semanticLayout',
    details: { issues }
  };
}

// 10. Semantic Significance of Typography
export function computeSemanticTypography(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  const title = textElements.find(t => t.role === 'title');
  const body = textElements.find(t => t.role === 'body');
  const footer = textElements.find(t => t.role === 'footer');

  if (textElements.length <= 1 || !title) {
    return {
      score: 0.20,
      passed: false,
      metric: 'semanticTypography',
      details: { issues: ['Insufficient typographic hierarchy — single element cannot establish institutional typography scale'] }
    };
  }

  let score = 1.0;
  const issues: string[] = [];

  if (title && body) {
    const ratio = title.fontSize / body.fontSize;
    if (ratio < 1.3) {
      score -= 0.35;
      issues.push(`Title to body font size ratio ${ratio.toFixed(2)} is too flat (< 1.3)`);
    } else if (ratio < 1.5) {
      score -= 0.15;
    }
  }

  if (body && footer) {
    if (footer.fontSize > body.fontSize) {
      score -= 0.25;
      issues.push(`Footer font size (${footer.fontSize}) > Body font size (${body.fontSize})`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.75;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'semanticTypography',
    details: { issues }
  };
}

// 11. Occlusion (CGL-GAN lineage)
export function computeOcclusion(layout: StudioLayoutV2): MetricResult {
  if (!layout.art) {
    return { score: 1.0, passed: true, metric: 'occlusion', details: { hasArt: false } };
  }

  const calm = layout.art.calmRegion;
  if (!calm) {
    return { score: 1.0, passed: true, metric: 'occlusion', details: { hasCalmRegion: false } };
  }

  const artBox = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
  let penaltyArea = 0;
  let totalTextArea = 0;

  for (const t of layout.text || []) {
    const area = t.width * t.height;
    totalTextArea += area;

    // Check if element is inside art box
    const inArt = !(t.x + t.width <= artBox.x || artBox.x + artBox.width <= t.x ||
                    t.y + t.height <= artBox.y || artBox.y + artBox.height <= t.y);

    if (inArt) {
      // Check if element extends outside calm region
      const inCalm = t.x >= calm.x && t.x + t.width <= calm.x + calm.width &&
                     t.y >= calm.y && t.y + t.height <= calm.y + calm.height;
      if (!inCalm) {
        penaltyArea += area;
      }
    }
  }

  const score = totalTextArea > 0 ? Math.max(0, 1.0 - penaltyArea / totalTextArea) : 1.0;
  const passed = score >= 0.85;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'occlusion',
    details: { penaltyArea, totalTextArea, calmRegion: calm }
  };
}

// 12. Type-Scale Conformance
export function computeTypeScaleConformance(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  if (textElements.length <= 1) {
    return { score: 1.0, passed: true, metric: 'typeScale', details: { count: textElements.length } };
  }

  const declaredBase = layout.typeScale?.base;
  const declaredRatio = layout.typeScale?.ratio;

  // If declared, check against declared scale
  if (declaredBase && declaredRatio) {
    let conforming = 0;
    for (const t of textElements) {
      // Check if fontSize fits base * ratio^n for n in -2..8
      let fits = false;
      for (let n = -2; n <= 8; n++) {
        const target = declaredBase * Math.pow(declaredRatio, n);
        if (Math.abs(t.fontSize - target) <= 1.5) {
          fits = true;
          break;
        }
      }
      if (fits) conforming++;
    }
    const score = conforming / textElements.length;
    return {
      score: parseFloat(score.toFixed(3)),
      passed: score >= 0.75,
      metric: 'typeScale',
      details: { declaredBase, declaredRatio, conforming, total: textElements.length }
    };
  }

  // If not declared, find best matching standard ratio
  const bodyEl = textElements.find(t => t.role === 'body') || textElements[0];
  const baseCandidate = bodyEl.fontSize;

  let bestConforming = 0;
  let bestRatio = 1.25;

  const candidateRatios = getMediumAwareTypeScaleRatios(layout.width, layout.height);
  for (const ratio of candidateRatios) {
    let count = 0;
    for (const t of textElements) {
      let fits = false;
      for (let n = -2; n <= 8; n++) {
        const target = baseCandidate * Math.pow(ratio, n);
        if (Math.abs(t.fontSize - target) <= 1.5) {
          fits = true;
          break;
        }
      }
      if (fits) count++;
    }
    if (count > bestConforming) {
      bestConforming = count;
      bestRatio = ratio;
    }
  }

  const score = bestConforming / textElements.length;
  const passed = score >= 0.70;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'typeScale',
    details: { fittedBase: baseCandidate, fittedRatio: bestRatio, conforming: bestConforming, total: textElements.length }
  };
}

// 13. Degeneracy
export function computeDegeneracy(layout: StudioLayoutV2): MetricResult {
  const textElements = layout.text || [];
  if (textElements.length === 0) {
    return { score: 0.0, passed: false, metric: 'degeneracy', details: { reason: 'EMPTY_LAYOUT' } };
  }

  // All font sizes identical
  const fontSizes = textElements.map(t => t.fontSize);
  const allIdenticalSize = fontSizes.every(s => s === fontSizes[0]) && fontSizes.length > 2;

  // All elements stacked at exact identical coordinates
  const coords = textElements.map(t => `${t.x},${t.y}`);
  const allStacked = new Set(coords).size === 1 && textElements.length > 2;

  if (allIdenticalSize || allStacked) {
    return {
      score: 0.0,
      passed: false,
      metric: 'degeneracy',
      details: { allIdenticalSize, allStacked, reason: 'SCHEMA_DEFAULT_COLLAPSE' }
    };
  }

  return {
    score: 1.0,
    passed: true,
    metric: 'degeneracy',
    details: { passed: true }
  };
}

// Multi-Candidate Set Degeneracy Check
export function checkCandidateSetDegeneracy(candidates: StudioLayoutV2[]): CandidateSetDegeneracyResult {
  if (!candidates || candidates.length < 2) {
    return { isDegenerate: false, pairwiseDistances: [] };
  }

  const pairwiseDistances: number[] = [];
  const duplicatePairs: Array<[number, number]> = [];

  // Compare visible structure by semantic copy slot, not the order in which a model listed nodes.
  // Colours, archetype names and image prompts cannot establish independent composition. Scale
  // coordinates to a common 1000px canvas so the threshold does not depend on export size.
  const elements = (layout: StudioLayoutV2) => {
    const box = (kind: string, key: string, item: { x: number; y: number; width: number; height: number }) => ({
      kind, key,
      coords: [item.x / layout.width, item.y / layout.height, item.width / layout.width, item.height / layout.height],
    });
    return [
      ...layout.text.map((t) => box('text', `${t.copyIndex}:${t.role}`, t)),
      box('logo', 'official', layout.logo),
      ...(layout.photos || []).map((p) => box('photo', `${p.photoIndex}:${p.treatment || 'framed'}`, p)),
      ...(layout.art ? [box('art', `${layout.art.source}:${layout.art.motif || ''}`, layout.art.box)] : []),
      ...(layout.shapes || [])
        .filter((s) => s.role !== 'rule' && s.width * s.height >= layout.width * layout.height * 0.001)
        .map((s) => box('shape', `${s.role}:${s.kind}`, s)),
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)
      || a.coords[0] - b.coords[0] || a.coords[1] - b.coords[1]);
  };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = elements(candidates[i]);
      const b = elements(candidates[j]);
      const count = Math.max(a.length, b.length);
      let squared = 0;
      for (let k = 0; k < count; k++) {
        if (!a[k] || !b[k] || a[k].kind !== b[k].kind || a[k].key !== b[k].key) {
          squared += 200 * 200;
          continue;
        }
        squared += a[k].coords.reduce((sum, value, axis) => sum + ((value - b[k].coords[axis]) * 1000) ** 2, 0);
      }
      const distance = count ? Math.sqrt(squared / count) : 0;
      pairwiseDistances.push(parseFloat(distance.toFixed(2)));
      if (distance < 15) duplicatePairs.push([i, j]);
    }
  }

  // This is a conservative structural screen, not a perceptual image-similarity measurement.
  const minDistance = Math.min(...pairwiseDistances);
  const isDegenerate = duplicatePairs.length > 0;

  return {
    isDegenerate,
    reason: isDegenerate ? `Pairwise structural distance (${minDistance.toFixed(1)} on a 1000px canvas) indicates near-identical candidates` : undefined,
    pairwiseDistances,
    duplicatePairs,
  };
}

// Composite Evaluation with LaySPA Weighting (0.80 Quality, 0.10 Compliance, 0.10 Exemplar Similarity)
export interface EvaluateDesignMetricsOptions {
  /** Lines each copy block wraps to, by copyIndex — see computeNegativeSpace. */
  wrappedLines?: Record<number, number>;
}

export function evaluateDesignMetrics(
  layout: StudioLayoutV2,
  options: EvaluateDesignMetricsOptions = {}
): DesignMetricsReport {
  const startTime = performance.now();

  const legibility = computeTextLegibility(layout);
  const grid = computeGridAppropriateness(layout);
  const alignment = computeAlignment(layout);
  const balance = computeBalance(layout);
  const justification = computeJustification(layout);
  const regularity = computeRegularity(layout);
  const typefacePairing = computeTypefacePairing(layout);
  const negativeSpace = computeNegativeSpace(layout, options.wrappedLines);
  const semanticLayout = computeSemanticLayout(layout);
  const semanticTypography = computeSemanticTypography(layout);
  const occlusion = computeOcclusion(layout);
  const typeScale = computeTypeScaleConformance(layout);
  const degeneracy = computeDegeneracy(layout);

  const metrics = {
    textLegibility: legibility,
    gridAppropriateness: grid,
    alignment,
    balance,
    justification,
    regularity,
    typefacePairing,
    negativeSpace,
    semanticLayout,
    semanticTypography,
    occlusion,
    typeScale,
    degeneracy
  };

  // LaySPA Quality Score (0.80 weight total)
  const qualityScore =
    0.12 * legibility.score +
    0.12 * grid.score +
    0.12 * alignment.score +
    0.12 * balance.score +
    0.08 * justification.score +
    0.08 * regularity.score +
    0.08 * typefacePairing.score +
    0.08 * negativeSpace.score +
    0.08 * semanticLayout.score +
    0.08 * semanticTypography.score +
    0.02 * occlusion.score +
    0.02 * typeScale.score;

  // Format Compliance (0.10 weight total)
  let complianceScore = 1.0;
  if (!typefacePairing.passed) complianceScore -= 0.3;
  if (!degeneracy.passed) complianceScore -= 0.5;
  if (layout.text.some(t => t.x < 0 || t.y < 0 || t.x + t.width > layout.width || t.y + t.height > layout.height)) {
    complianceScore -= 0.4;
  }
  complianceScore = Math.max(0, Math.min(1, complianceScore));

  // Exemplar Similarity (0.10 weight total)
  // Evaluates whether balance, negative space and layout structure sit within calibrated exemplar bands
  let exemplarSimilarityScore = 1.0;
  if (balance.score < 0.80) exemplarSimilarityScore -= 0.3;
  if (negativeSpace.score < 0.70) exemplarSimilarityScore -= 0.3;
  if (grid.score < 0.70) exemplarSimilarityScore -= 0.4;
  exemplarSimilarityScore = Math.max(0, Math.min(1, exemplarSimilarityScore));

  const compositeScore = parseFloat(
    (0.80 * qualityScore + 0.10 * complianceScore + 0.10 * exemplarSimilarityScore).toFixed(3)
  );

  const failingMetrics = Object.entries(metrics)
    .filter(([, res]) => !res.passed)
    .map(([name]) => name);

  const passed = compositeScore >= 0.75 && failingMetrics.length === 0;
  const executionTimeMs = parseFloat((performance.now() - startTime).toFixed(2));

  return {
    compositeScore,
    passed,
    qualityScore: parseFloat(qualityScore.toFixed(3)),
    complianceScore: parseFloat(complianceScore.toFixed(3)),
    exemplarSimilarityScore: parseFloat(exemplarSimilarityScore.toFixed(3)),
    metrics,
    failingMetrics,
    executionTimeMs
  };
}
