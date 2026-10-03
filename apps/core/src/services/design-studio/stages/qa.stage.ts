import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { checkTextShaping, evaluateHardQa, layoutPlacements, renderLayoutV2Async, renderLogoTemplate, photoRecipeOf, textShapingBlocks,
  type ArtRegionPlan, type RenderLayoutV2Result, type ReviewFinding, type StudioLayoutV2, type TextShapingFidelity } from '@hawa/creative';
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
  const rendered = winner.currentLayout;
  const render = await renderLayoutV2Async(rendered, { ...candidateRenderOptions(ctx, winner), copyText: copyForStageV3(ctx).text })
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
  const textShaping = shapingOfRender(rendered, copyForStageV3(ctx).text, render);
  if (!('measured' in textShaping)) outcome.findings.push(...shapingFindings(textShaping));
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
    textShaping,
  };
}

/**
 * ADR-290: the render that ships, read against its own text-free render: is every Kurdish and Arabic
 * line drawn joined, ordered and wrapped as the face it was measured with sets it? Advisory: findings
 * for the office, never a reason the design failed. The layout checked is the one rendered.
 */
function shapingOfRender(layout: StudioLayoutV2, copyText: Record<number, string>, render: RenderLayoutV2Result | undefined):
  TextShapingFidelity | { measured: false; reason: string } {
  if (!render) return { measured: false, reason: 'The design could not be rendered for QA.' };
  try {
    const blocks = textShapingBlocks(layout, copyText);
    if (!blocks.length) return { measured: false, reason: 'The design has no Kurdish or Arabic text to check.' };
    return checkTextShaping(render.png, blocks, { background: render.noTextPng });
  } catch (err) {
    return { measured: false, reason: `Not measured: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const SHAPING_WORDS: Record<string, string> = {
  'wrapped-differently': 'is set on other lines than its measurement',
  'shaping-mismatch': 'is drawn with other letter forms than its face (unjoined letters or a substituted typeface)',
  'missing-glyphs': 'shows boxes where letters are missing',
  'wrong-direction': 'is drawn in the wrong direction',
};

function shapingFindings(shaping: TextShapingFidelity): ReviewFinding[] {
  return shaping.blocks.filter((b) => b.verdict !== 'ok').map((b) => {
    const copyIndex = Number(b.id.replace('text-copy-', ''));
    return { code: 'TEXT_SHAPING_MISMATCH', severity: 'warning', copyIndex,
      message: `TEXT_SHAPING_MISMATCH: copy block ${copyIndex + 1} ${SHAPING_WORDS[b.verdict]} in the render (${b.lines.filter((l) => l.verdict !== 'ok').length} of ${b.lines.length} line(s)).` };
  });
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
