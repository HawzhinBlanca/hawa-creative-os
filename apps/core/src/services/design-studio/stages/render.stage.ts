import { createHash } from 'node:crypto';
import type { StageContext, CandidateState } from '../types.js';
import { renderLayoutV2Async, computeLayoutMetrics, evaluateCompositeContrast } from '@hawa/creative';

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

    const renderResult = await renderLayoutV2Async(cand.currentLayout, {
      copyText: copyMap,
      artImagePath: artDataUri,
      logoDataUri,
      photoDataUris: ctx.photos?.map((p) => p.dataUrl),
    });

    cand.previewPng = renderResult.png;
    cand.previewSha256 = createHash('sha256').update(renderResult.png).digest('hex');
    cand.compositePng = renderResult.noTextPng;

    let contrastValues: Record<number, number> | undefined;
    if (renderResult.noTextPng) {
      try {
        const contrastResult = evaluateCompositeContrast(renderResult.noTextPng, cand.currentLayout);
        contrastValues = contrastResult.p05PerBox;
      } catch (err: any) {
        // Falling back from measured contrast to the declared background colour can let text that is
        // genuinely illegible over its actual backdrop pass the legibility gate, so say when it happens.
        console.warn(
          `[render.stage] Composite contrast could not be measured (${err?.message || err}); ` +
            `falling back to the declared background colour for legibility scoring.`
        );
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
