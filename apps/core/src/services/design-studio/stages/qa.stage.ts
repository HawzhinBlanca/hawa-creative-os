import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { evaluateHardQa, layoutPlacements, renderLayoutV2Async, renderLogoTemplate, photoRecipeOf, type ArtRegionPlan } from '@hawa/creative';
import { hardQaContextFor, copyForStageV3 } from './v3.stage.js';
import { candidateRenderOptions } from './asset-inputs.js';
import { log } from '../../../logging.js';

export async function runQAStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<HardQAResult> {
  // The gate itself lives in @hawa/creative so the qualification applies exactly this gate, with
  // the context ranking and refinement use — the copy included, so overflowing copy fails here too.
  //
  // ADR-157: the design is rendered here, as it ships, with its art, photos and logo. Its no-text
  // composite is what contrast is measured on, and the renderer's font fidelity says whether a face
  // was drawn by a stand-in. Until 2026-09-30 this gate read only the declared colours, and the
  // art stage leaves CONTRAST to it for v3, so text on art was never measured anywhere.
  // A render that fails (it needs the client's logo, for one) falls back to the candidate's stored
  // composite; with neither, the outcome carries CONTRAST_UNMEASURED rather than passing in silence.
  const render = await renderLayoutV2Async(winner.currentLayout, { ...candidateRenderOptions(ctx, winner), copyText: copyForStageV3(ctx).text })
    .catch((err: unknown) => {
      log.warn(`[qa.stage] the winner could not be rendered for measured contrast (${err instanceof Error ? err.message : String(err)}).`);
      return undefined;
    });
  const composite = render?.noTextPng ?? winner.compositePng ?? undefined;
  const logoRequired = Boolean(photoRecipeOf(winner.currentLayout));
  const logoTemplate = logoRequired ? await renderLogoTemplate(winner.currentLayout, candidateRenderOptions(ctx, winner)).catch((err: unknown) => {
    log.warn(`[qa.stage] Logo source could not be measured (${err instanceof Error ? err.message : String(err)}).`);
    return undefined;
  }) : undefined;
  const outcome = evaluateHardQa(
    winner.currentLayout,
    {
      ...hardQaContextFor(ctx),
      ...(composite ? { renderedComposite: composite } : {}),
      ...(render ? { fontFidelity: render.fontFidelity } : {}),
      logoVisibilityRequired: logoRequired,
      ...(logoTemplate ? { logoVisibilityTemplate: logoTemplate } : {}),
    },
    winner.metrics
  );
  if (!composite) {
    outcome.findings.push({
      code: 'CONTRAST_UNMEASURED',
      severity: 'warning',
      message: 'CONTRAST_UNMEASURED: the design could not be rendered for QA; contrast was judged on the declared colours only.',
    });
  }
  winner.currentLayout = outcome.layout;
  winner.metrics = outcome.metrics;
  return {
    passed: outcome.passed,
    defectCodes: outcome.defectCodes,
    metrics: outcome.metrics,
    textMeasurements: outcome.textMeasurements,
    messages: outcome.messages,
    placement: finalPlacement(ctx, winner),
    findings: outcome.findings,
    ...(outcome.measuredContrast ? { measuredContrast: outcome.measuredContrast } : {}),
    ...(outcome.omittedPhotos.length ? { omittedPhotos: outcome.omittedPhotos } : {}),
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
