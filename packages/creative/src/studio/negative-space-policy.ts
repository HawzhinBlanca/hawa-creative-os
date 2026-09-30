import { createHash } from 'node:crypto';

/**
 * The studio's negative-space policy, defined once (ADR-125).
 *
 * The v3 generator used to be told "0.35 to 0.58 of canvas area" and "never leave 40% of the
 * canvas empty", while the checker it is ranked, repaired and judged by passed measured-line
 * emptiness from 0.36 to 0.84. The generator therefore optimised against a different policy from
 * the one applied to it. Both the prompt statement and the score are now derived from this record,
 * and every score carries the version and digest of the definition that produced it.
 *
 * The numbers are the calibration the checker already used (see computeNegativeSpace for its
 * provenance and open questions). Moving them is a policy change: bump `version`, record the new
 * digest in the policy test, and qualify the accept/reject change it causes.
 */
export type NegativeSpaceMeasure = 'measured_lines' | 'declared_boxes';

interface Band { floor: number; rampEnd: number; plateauEnd: number; taperEnd: number }

export const NEGATIVE_SPACE_POLICY = Object.freeze({
  id: 'studio.negative-space',
  version: '2026-09-30.1',
  /** fraction = 1 - occupied area / canvas area, clamped to 0..1. */
  occupancy: Object.freeze({
    /** measured_lines: width x min(box height, measured line count x fontSize x lineHeight). */
    textMeasured: 'box_width_times_measured_line_height_capped_at_box',
    /** declared_boxes: width x box height, used only when no line measurement is supplied. */
    textDeclared: 'box_width_times_box_height',
    logo: 'full_box',
    panelOrFrameWeight: 0.6,
    otherShapeWeight: 0.4,
    /** A shape this share of the canvas in both directions that is a frame or background-coloured is not content. */
    canvasFrameShare: 0.85,
    /** Any shape this share of the canvas in both directions is not content. */
    canvasShapeShare: 0.95,
    /**
     * 2026-09-30.1 (ADR-157): the client's photographs are content. A framed photo occupies its
     * box; a person cut out of a photo about this share of it. Generated art is still not counted.
     */
    photoFramedWeight: 1,
    photoCutoutWeight: 0.6,
    art: 'not_counted',
  }),
  bands: Object.freeze({
    measured_lines: Object.freeze({ floor: 0.36, rampEnd: 0.44, plateauEnd: 0.78, taperEnd: 0.84 }),
    declared_boxes: Object.freeze({ floor: 0.25, rampEnd: 0.30, plateauEnd: 0.60, taperEnd: 0.65 }),
  }),
  scores: Object.freeze({ belowFloorMax: 0.5, rampStart: 0.75, plateau: 0.95, taperDrop: 0.25, beyondTaper: 0.68, beyondTaperSpan: 0.15 }),
  /**
   * The content spans the internal gap and the bottom void are measured from. Unlike occupancy,
   * a text block spans its whole declared box, not the lines it sets. Added in 2026-09-28.2; the
   * scoring was already this, and no number changed.
   */
  spans: Object.freeze({ text: 'declared_box_height', logo: 'box', shape: 'box_at_least_min_height_except_rules', photo: 'box', art: 'not_counted' }),
  /** Largest vertical gap between consecutive content spans, as a share of canvas height. */
  internalGap: Object.freeze({ penaltyAbove: 0.22, penalty: 0.35, per: 0.10, spanMinHeightPx: 20, rulesAreSpans: false }),
  /** Canvas height below the lowest content span. */
  bottomVoid: Object.freeze({ penaltyAbove: 0.25, penalty: 0.40, per: 0.15 }),
  passScore: 0.70,
});

export interface NegativeSpacePolicyIdentity { id: string; version: string; sha256: string }

/** The version and a digest of every number and rule above; recorded with each run and score. */
export function negativeSpacePolicyIdentity(): NegativeSpacePolicyIdentity {
  const sha256 = createHash('sha256').update(JSON.stringify(NEGATIVE_SPACE_POLICY)).digest('hex');
  return { id: NEGATIVE_SPACE_POLICY.id, version: NEGATIVE_SPACE_POLICY.version, sha256 };
}

/** The score for a measured fraction, gap and bottom void. computeNegativeSpace applies exactly this. */
export function scoreNegativeSpace(input: {
  fraction: number; internalGapFraction: number; bottomVoid: number; measure: NegativeSpaceMeasure;
}): number {
  const p = NEGATIVE_SPACE_POLICY;
  const band: Band = p.bands[input.measure];
  const s = p.scores;
  const { fraction } = input;
  let score: number;
  if (fraction < band.floor) score = Math.max(0, (fraction / band.floor) * s.belowFloorMax);
  else if (fraction < band.rampEnd) score = s.rampStart + ((fraction - band.floor) / (band.rampEnd - band.floor)) * (s.plateau - s.rampStart);
  else if (fraction <= band.plateauEnd) score = s.plateau;
  else if (fraction <= band.taperEnd) score = s.plateau - ((fraction - band.plateauEnd) / (band.taperEnd - band.plateauEnd)) * s.taperDrop;
  // Past the taper: excessive emptiness fails.
  else score = Math.max(0, s.beyondTaper - ((fraction - band.taperEnd) / s.beyondTaperSpan) * s.beyondTaper);

  if (input.internalGapFraction > p.internalGap.penaltyAbove) {
    score = Math.max(0, score - ((input.internalGapFraction - p.internalGap.penaltyAbove) / p.internalGap.per) * p.internalGap.penalty);
  }
  if (input.bottomVoid > p.bottomVoid.penaltyAbove) {
    score = Math.max(0, score - ((input.bottomVoid - p.bottomVoid.penaltyAbove) / p.bottomVoid.per) * p.bottomVoid.penalty);
  }
  return Math.max(0, Math.min(1, score));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Fractions that pass with no gap or bottom-void penalty, derived from the scoring function. */
export function negativeSpacePassingInterval(measure: NegativeSpaceMeasure): { min: number; max: number } {
  const p = NEGATIVE_SPACE_POLICY;
  const band: Band = p.bands[measure];
  const s = p.scores;
  if (s.belowFloorMax >= p.passScore || s.rampStart < p.passScore || s.beyondTaper >= p.passScore) {
    throw new Error('NEGATIVE_SPACE_POLICY_SHAPE_CHANGED: derive the passing interval again');
  }
  const taperShare = (s.plateau - p.passScore) / s.taperDrop;
  return { min: band.floor, max: round2(band.plateauEnd + Math.min(1, taperShare) * (band.taperEnd - band.plateauEnd)) };
}

/** From the preferred plateau, the single gap or bottom void past which the score fails alone. */
export function negativeSpaceSingleFactorLimits() {
  const p = NEGATIVE_SPACE_POLICY;
  const headroom = p.scores.plateau - p.passScore;
  const floor2 = (n: number) => Math.floor(n * 100) / 100;
  return {
    internalGap: { penaltyAbove: p.internalGap.penaltyAbove, failsAbove: floor2(p.internalGap.penaltyAbove + (headroom / p.internalGap.penalty) * p.internalGap.per) },
    bottomVoid: { penaltyAbove: p.bottomVoid.penaltyAbove, failsAbove: floor2(p.bottomVoid.penaltyAbove + (headroom / p.bottomVoid.penalty) * p.bottomVoid.per) },
  };
}

/**
 * The statement the layout generator receives. It is the checker's definition, including what the
 * measure does not see, so a layout is asked for exactly what it will be scored on.
 */
export function negativeSpacePromptGuidance(measure: NegativeSpaceMeasure = 'measured_lines'): string {
  const p = NEGATIVE_SPACE_POLICY;
  const pass = negativeSpacePassingInterval(measure);
  const band = p.bands[measure];
  const limits = negativeSpaceSingleFactorLimits();
  const f = (n: number) => n.toFixed(2);
  return [
    `- Negative space (policy ${p.id} ${p.version}; the same definition the checker scores):`,
    `  * Negative space = 1 - occupied area / canvas area. Occupied: each text box's width x the height its copy actually sets ` +
      `(measured line count x fontSize x lineHeight, capped at the box height); the logo box; panels and frames at ${p.occupancy.panelOrFrameWeight} ` +
      `and other shapes at ${p.occupancy.otherShapeWeight} of their area. A border or background-coloured frame covering ${p.occupancy.canvasFrameShare * 100}% ` +
      `of the canvas is not content. Each client photograph counts: a framed photo its whole box, a cut-out person ${p.occupancy.photoCutoutWeight} of its box. Artwork is not counted.`,
    `  * Passing range ${f(pass.min)}-${f(pass.max)}; preferred ${f(band.rampEnd)}-${f(band.plateauEnd)}. Fuller than ${f(pass.min)} or emptier than ${f(pass.max)} fails.`,
    `  * Gaps are measured between content spans: each text box counts at its full declared height (not the lines it sets), ` +
      `the logo box, each photograph's box, and shapes at least ${p.internalGap.spanMinHeightPx}px tall other than rules; artwork is not a span.`,
    `  * The largest vertical gap between consecutive spans is penalised above ${f(limits.internalGap.penaltyAbove)} of canvas height ` +
      `and fails alone above ${f(limits.internalGap.failsAbove)}.`,
    `  * Space below the lowest span is penalised above ${f(limits.bottomVoid.penaltyAbove)} of canvas height and fails alone above ${f(limits.bottomVoid.failsAbove)}.`,
    `  * Group related elements (title + subtitle, body paragraphs, footer) with intentional proximity.`,
  ].join('\n');
}
