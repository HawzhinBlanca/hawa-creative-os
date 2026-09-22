import type { StudioLayoutV2, Box, TextElement, ShapeElement } from './layout-v2.js';
import { hexToLuminance, calculateLuminanceContrastRatio } from './composite-contrast.js';

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
]);

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
  const bgColor = layout.background?.color || '#FFFFFF';
  const bgLum = hexToLuminance(bgColor);

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

    // Contrast check
    // Determine effective background (underlying shape panel or canvas background)
    let effectiveBg = bgColor;
    for (let sIdx = (layout.shapes || []).length - 1; sIdx >= 0; sIdx--) {
      const s = layout.shapes[sIdx];
      if (s.role === 'panel' || s.kind === 'rect' || s.kind === 'roundRect') {
        const containsX = el.x >= s.x - 20 && (el.x + el.width) <= (s.x + s.width + 20);
        const containsY = el.y >= s.y - 20 && (el.y + el.height) <= (s.y + s.height + 20);
        if (containsX && containsY && s.color && s.color.startsWith('#')) {
          effectiveBg = s.color;
          break;
        }
      }
    }

    const effectiveBgLum = hexToLuminance(effectiveBg);
    const textLum = hexToLuminance(el.color);
    const contrast = calculateLuminanceContrastRatio(textLum, effectiveBgLum);
    const requiredContrast = el.fontSize >= 20 || (el.fontSize >= 16 && el.bold) ? 3.0 : 4.5;
    if (contrast < requiredContrast) {
      const deficit = (requiredContrast - contrast) / requiredContrast;
      totalPenalty += Math.min(0.8, deficit * 1.0);
      failingIssues.push(`Text ${i} (${el.role}) contrast ${contrast.toFixed(2)}:1 < ${requiredContrast}:1`);
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

  const allBoxes: Box[] = [
    ...layout.text,
    ...layout.shapes.filter(s => s.role !== 'panel' || (s.width < width * 0.9 && s.height < layout.height * 0.9)),
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

  for (const b of allBoxes) {
    const left = b.x;
    const right = b.x + b.width;
    const center = Math.round(b.x + b.width / 2);

    const leftOnCol = leftArr.some(cl => Math.abs(left - cl) <= tolerance);
    const rightOnCol = rightArr.some(cr => Math.abs(right - cr) <= tolerance);
    const isCentered = centerArr.some(cc => Math.abs(center - cc) <= tolerance);

    // Conforms if:
    // (1) Left and right edges align to grid column lines, OR
    // (2) Centered on a column / canvas axis within margins, OR
    // (3) Left edge aligns to a column start and width spans within margin
    if ((leftOnCol && rightOnCol) || (isCentered && left >= margin - tolerance && right <= width - margin + tolerance) || (leftOnCol && isCentered)) {
      alignedElements++;
    }
  }

  const score = alignedElements / allBoxes.length;
  const passed = score >= 0.70;

  return {
    score: parseFloat(score.toFixed(3)),
    passed,
    metric: 'gridAppropriateness',
    details: { alignedElements, totalElements: allBoxes.length }
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

  const mean = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  const variance = gaps.reduce((sum, g) => sum + Math.pow(g - mean, 2), 0) / gaps.length;
  const std = Math.sqrt(variance);

  const maxGap = Math.max(...gaps);
  if (maxGap > layout.height * 0.25) {
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
    details: { meanGap: Math.round(mean), std: Math.round(std), cv: parseFloat(cv.toFixed(3)) }
  };
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
      const isAdmittedBody = t.fontFamily === 'Verdana' || t.fontFamily === 'Noto Sans Arabic';
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
  const totalArea = layout.width * layout.height;
  let occupiedArea = 0;

  interface Span { y1: number; y2: number; }
  const substantiveSpans: Span[] = [];

  let maxSubstantiveY = 0;
  for (const t of layout.text || []) {
    const lines = wrappedLines?.[t.copyIndex];
    const inkedHeight =
      lines && lines > 0 ? Math.min(t.height, lines * t.fontSize * t.lineHeight) : t.height;
    occupiedArea += t.width * inkedHeight;
    substantiveSpans.push({ y1: t.y, y2: t.y + t.height });
    maxSubstantiveY = Math.max(maxSubstantiveY, t.y + t.height);
  }

  const sameColour = (a?: string, b?: string) => {
    const norm = (h?: string) => {
      const c = (h || '').trim().toLowerCase();
      return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
    };
    return !!a && !!b && norm(a) === norm(b);
  };
  for (const s of layout.shapes || []) {
    // A border around the canvas is not content. The rule used to key on the role alone, and the
    // studio's normaliser renames frames to panels — so a background-filled border enclosing 86%
    // of the canvas counted as 60% occupied and flipped a 76%-empty design to "29% empty". A
    // background-filled shape that large is a border whatever it is called. Smaller outlined
    // cards still count: the P01 calibration deliberately treats content frames as occupied.
    const isCanvasFrame =
      ((s.role === 'frame' || sameColour(s.color, layout.background?.color)) &&
        s.width >= layout.width * 0.85 &&
        s.height >= layout.height * 0.85) ||
      (s.width >= layout.width * 0.95 && s.height >= layout.height * 0.95);
    if (isCanvasFrame) continue;
    occupiedArea += s.width * s.height * (s.role === 'panel' || s.role === 'frame' ? 0.6 : 0.4);
    if (s.height >= 20 && s.role !== 'rule') {
      substantiveSpans.push({ y1: s.y, y2: s.y + s.height });
      maxSubstantiveY = Math.max(maxSubstantiveY, s.y + s.height);
    }
  }

  if (layout.logo) {
    occupiedArea += layout.logo.width * layout.logo.height;
    substantiveSpans.push({ y1: layout.logo.y, y2: layout.logo.y + layout.logo.height });
    maxSubstantiveY = Math.max(maxSubstantiveY, layout.logo.y + layout.logo.height);
  }

  const fraction = Math.max(0, Math.min(1, 1 - occupiedArea / totalArea));

  // The band belongs to the measure, so it moves with it. Counting boxes and counting type give
  // different emptiness for the same design — measured across 20 production layouts, the box
  // measure spans 0.412-0.637 and the type measure 0.553-0.827 — so one band cannot serve both.
  //
  // The type band is placed so this corpus sits where it sat under the box band: comfortably
  // inside the plateau, median just below its upper edge, the emptiest design just past it into
  // the taper. That preserves every accept/reject decision the metric already makes on real work
  // while removing the reason it preferred one composition, which is the whole point of switching.
  const band = wrappedLines
    ? { floor: 0.36, rampEnd: 0.44, plateauEnd: 0.78, taperEnd: 0.84 }
    : { floor: 0.25, rampEnd: 0.30, plateauEnd: 0.60, taperEnd: 0.65 };

  let score = 1.0;
  if (fraction < band.floor) {
    score = Math.max(0, (fraction / band.floor) * 0.5);
  } else if (fraction < band.rampEnd) {
    score = 0.75 + ((fraction - band.floor) / (band.rampEnd - band.floor)) * 0.2;
  } else if (fraction <= band.plateauEnd) {
    score = 0.95;
  } else if (fraction <= band.taperEnd) {
    score = 0.95 - ((fraction - band.plateauEnd) / (band.taperEnd - band.plateauEnd)) * 0.25;
  } else {
    // Past the taper: excessive emptiness fails the gate (< 0.70).
    score = Math.max(0, 0.68 - ((fraction - band.taperEnd) / 0.15) * 0.68);
  }

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
  if (internalGapFraction > 0.22) {
    // Dead void > 22% canvas height penalizes
    const gapPenalty = ((internalGapFraction - 0.22) / 0.10) * 0.35;
    score = Math.max(0, score - gapPenalty);
  }

  // Bottom void penalty: substantive institutional content must span >= 75% of canvas height (bottomVoid <= 0.25)
  const bottomVoid = (layout.height - maxSubstantiveY) / layout.height;
  if (bottomVoid > 0.25) {
    const penalty = ((bottomVoid - 0.25) / 0.15) * 0.40;
    score = Math.max(0, score - penalty);
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.70;

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
      details: { issues: ['Lacks primary title/headline hierarchy — photograph with caption bar cannot establish institutional composition'] }
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

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      let distSum = 0;
      let count = 0;

      const maxLen = Math.max(a.text.length, b.text.length);
      for (let k = 0; k < maxLen; k++) {
        const at = a.text[k];
        const bt = b.text[k];
        if (at && bt) {
          const dx = at.x - bt.x;
          const dy = at.y - bt.y;
          const dw = at.width - bt.width;
          const dh = at.height - bt.height;
          distSum += Math.sqrt(dx * dx + dy * dy + dw * dw + dh * dh);
          count++;
        } else {
          distSum += 200; // Large difference for mismatched element counts
          count++;
        }
      }

      const avgDist = count > 0 ? distSum / count : 0;
      pairwiseDistances.push(parseFloat(avgDist.toFixed(2)));
    }
  }

  // If any pair distance is extremely small (< 15px average geometric difference), they are near-identical
  const minDistance = Math.min(...pairwiseDistances);
  const isDegenerate = minDistance < 15;

  return {
    isDegenerate,
    reason: isDegenerate ? `Pairwise geometric distance (${minDistance.toFixed(1)}px) indicates near-identical candidates` : undefined,
    pairwiseDistances
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
