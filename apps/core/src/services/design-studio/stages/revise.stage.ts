import { createHash } from 'node:crypto';
import { StudioBudgetExhaustedError, isModelCallHoldError, type StageContext, type CandidateState } from '../types.js';
import type { StudioLayoutV2 } from '@hawa/creative';
import { validateLayoutV2, type LayoutValidationContext, renderLayoutV2Async, computeLayoutMetrics, evaluateCompositeContrast } from '@hawa/creative';
import { buildP0SystemPrompt, buildP5Prompt } from '../prompts.js';
import { LAYOUT_SCHEMA, normalizeCandidateLayout } from './layouts.stage.js';
import { log } from '../../../logging.js';

export const REVISION_SCHEMA = {
  type: 'object',
  properties: {
    layout: LAYOUT_SCHEMA.properties.layout,
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['element', 'before', 'after', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['layout', 'changes'],
  additionalProperties: false,
};

export async function runReviseStage(
  ctx: StageContext,
  candidates: CandidateState[],
  round = 1
): Promise<CandidateState[]> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const shortEdge = Math.min(ctx.width, ctx.height);
  const marginPx = Math.round(shortEdge * 0.06);
  const bodyMinPx = Math.max(12, Math.round(ctx.width * 0.016));
  const logoConstraints = ctx.referencePack.logoConstraints as { minimumWidthPx?: number; clearSpacePx?: number } | undefined;
  const logoMinPx = Math.max(100, Math.round(ctx.width * 0.08), logoConstraints?.minimumWidthPx ?? 0);

  const fontRule = ctx.referencePack.admittedDisplayFonts
    ? `; Latin font ${ctx.latinFont} or [${ctx.referencePack.admittedDisplayFonts.latin.join(', ')}]; Sorani font ${ctx.arabicFont} or [${ctx.referencePack.admittedDisplayFonts.arabic.join(', ')}]; no other fonts`
    : '';
  const constraintsStr = `margin >= ${marginPx}px; body >= ${bodyMinPx}px; title >= 2.2 * body; logo width >= ${logoMinPx}px; logo clear space >= max(0.5 * logo height, ${logoConstraints?.clearSpacePx ?? 0}px); palette = ${ctx.referencePack.palette.join(', ')}${fontRule}`;

  const copyMap: Record<number, string> = {};
  for (let i = 0; i < ctx.copyBlocks.length; i++) {
    copyMap[i] = ctx.copyBlocks[i].text;
  }

  const logoDataUri = ctx.logo
    ? `data:${ctx.logo.mimeType};base64,${ctx.logo.bytes.toString('base64')}`
    : undefined;

  const validationContext: LayoutValidationContext = {
    expectedWidth: ctx.width,
    expectedHeight: ctx.height,
    copyCount: ctx.copyBlocks.length,
    copyScripts: ctx.copyBlocks.map((b) => (b.script === 'arabic' ? 'arabic' : 'latin')),
    photoCount: ctx.photos?.length ?? 0,
    reference: {
      rules: {
        fontFamily: ctx.latinFont,
        palette: ctx.referencePack.palette,
        scriptFonts: {
          arabic: ctx.arabicFont,
        },
        admittedDisplayFonts: ctx.referencePack.admittedDisplayFonts,
      },
      logoAspect: ctx.logoAspect || 1.0,
      logoMinimumWidthPx: logoConstraints?.minimumWidthPx,
      logoClearSpacePx: logoConstraints?.clearSpacePx,
    },
    draftFont: ctx.latinFont || 'Inter',
  };

  for (const cand of candidates) {
    const latestCritique = cand.critiques[cand.critiques.length - 1];
    if (!latestCritique) continue;

    // Early stop: score >= 8.5 with 0 hard fails skips further revision
    if (latestCritique.weightedScore >= 8.5 && latestCritique.hardFails.length === 0) {
      continue;
    }

    const userPrompt = buildP5Prompt({
      layoutJson: JSON.stringify(cand.currentLayout),
      critiqueJson: JSON.stringify(latestCritique),
      metricsJson: JSON.stringify(cand.metrics || {}),
      constraints: constraintsStr,
    });

    try {
      const response = await ctx.client.completeJson<{
        layout: StudioLayoutV2;
        changes: Array<{ element: string; before: string; after: string; why: string }>;
      }>({
        system: systemPrompt,
        prompt: userPrompt,
        schema: REVISION_SCHEMA,
        schemaName: 'LayoutRevision',
      });

      const rawRevised = response.data.layout;
      const revisedLayout = normalizeCandidateLayout(rawRevised, ctx.width, ctx.height, ctx.logoAspect || 1.0);
      const validation = validateLayoutV2(revisedLayout, validationContext);

      if (validation.ok) {
        const layoutToUse = validation.layout || revisedLayout;
        cand.layouts.push(layoutToUse);
        cand.currentLayout = layoutToUse;

        const artDataUri = cand.artPng
          ? `data:image/png;base64,${cand.artPng.toString('base64')}`
          : undefined;

        // Re-render
        const renderResult = await renderLayoutV2Async(layoutToUse, {
          photoFiles: ctx.photos?.map((p) => ({ bytes: p.bytes, mediaType: p.mimeType })),
          photoCutouts: ctx.photoCutouts,
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
            const contrastResult = evaluateCompositeContrast(renderResult.noTextPng, layoutToUse);
            contrastValues = contrastResult.p05PerBox;
          } catch (err: any) {
            // Falling back from measured contrast to the declared background colour can let text that is
            // genuinely illegible over its actual backdrop pass the legibility gate, so say when it happens.
            log.warn(
              `[revise.stage] Composite contrast could not be measured (${err?.message || err}); ` +
                `falling back to the declared background colour for legibility scoring.`
            );
          }
        }

        cand.metrics = computeLayoutMetrics(layoutToUse, {
          copyText: copyMap,
          measuredLines: renderResult.wrappedLines,
          contrastValues,
        });
      } else {
        cand.validation = validation;
        if (!cand.diagnostics) cand.diagnostics = [];
        cand.diagnostics.push(`Revised layout failed validation: ${validation.message || validation.code}`);
      }
    } catch (err: any) {
      if (err instanceof StudioBudgetExhaustedError || isModelCallHoldError(err)) {
        throw err;
      }
      // If revision model call fails, keep current candidate layout intact and record diagnostic
      if (!cand.diagnostics) cand.diagnostics = [];
      cand.diagnostics.push(`Revision stage error: ${err?.message || 'UNKNOWN_ERROR'}`);
    }
  }

  return candidates;
}
