import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { evaluateHardQa, layoutPlacements, type ArtRegionPlan } from '@hawa/creative';
import { hardQaContextFor } from './v3.stage.js';

export async function runQAStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<HardQAResult> {
  // The gate itself lives in @hawa/creative so the qualification applies exactly this gate, with
  // the context ranking and refinement use — the copy included, so overflowing copy fails here too.
  const outcome = evaluateHardQa(winner.currentLayout, hardQaContextFor(ctx), winner.metrics);
  winner.currentLayout = outcome.layout;
  winner.metrics = outcome.metrics;
  return {
    passed: outcome.passed,
    defectCodes: outcome.defectCodes,
    metrics: outcome.metrics,
    textMeasurements: outcome.textMeasurements,
    messages: outcome.messages,
    placement: finalPlacement(ctx, winner),
  };
}

/**
 * ADR-123: where the final layout puts the art's calm region in the art actually retained, checked
 * against the region that art was made for, and the crop each photo gets. This is evidence for the
 * reviewer, not a gate: legibility over the actual pixels is already the contrast gate's decision.
 */
function finalPlacement(ctx: StageContext, winner: CandidateState): NonNullable<HardQAResult['placement']> {
  const region = (winner.artProvenance as { region?: { plan?: ArtRegionPlan } } | null | undefined)?.region;
  return layoutPlacements(winner.currentLayout, {
    ...(winner.artPng ? { art: winner.artPng } : {}),
    ...(region?.plan ? { artPlan: region.plan } : {}),
    photos: (ctx.photos ?? []).map((p) => p.bytes),
    cutouts: ctx.photoCutouts,
    measureDetail: true,
  });
}
