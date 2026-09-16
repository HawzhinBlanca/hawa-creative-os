import { createHash } from 'node:crypto';
import type { StageContext, CandidateState } from '../types.js';
import { renderLayoutV2, computeLayoutMetrics, evaluateCompositeContrast } from '@hawa/creative';

export async function runRenderStage(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<CandidateState[]> {
  const copyMap: Record<number, string> = {};
  for (let i = 0; i < ctx.copyBlocks.length; i++) {
    copyMap[i] = ctx.copyBlocks[i].text;
  }

  const logoDataUri = ctx.logo
    ? `data:${ctx.logo.mimeType};base64,${ctx.logo.bytes.toString('base64')}`
    : undefined;

  for (const cand of candidates) {
    const artDataUri = cand.artPng
      ? `data:image/png;base64,${cand.artPng.toString('base64')}`
      : undefined;

    const renderResult = renderLayoutV2(cand.currentLayout, {
      copyText: copyMap,
      artImagePath: artDataUri,
      logoDataUri,
    });

    cand.previewPng = renderResult.png;
    cand.previewSha256 = createHash('sha256').update(renderResult.png).digest('hex');
    cand.compositePng = renderResult.noTextPng;

    let contrastValues: Record<number, number> | undefined;
    if (renderResult.noTextPng) {
      try {
        const contrastResult = evaluateCompositeContrast(renderResult.noTextPng, cand.currentLayout);
        contrastValues = contrastResult.p05PerBox;
      } catch {
        // Fallback to direct background calculation in computeLayoutMetrics
      }
    }

    // Compute deterministic layout metrics with real measured contrast
    cand.metrics = computeLayoutMetrics(cand.currentLayout, {
      copyText: copyMap,
      measuredLines: renderResult.wrappedLines,
      contrastValues,
    });
  }

  return candidates;
}
