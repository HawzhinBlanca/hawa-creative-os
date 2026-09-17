import { createHash } from 'node:crypto';
import { StudioBudgetExhaustedError, type StageContext, type CandidateState } from '../types.js';
import type { StudioLayoutV2 } from '@hawa/creative';
import { validateLayoutV2, type LayoutValidationContext, renderLayoutV2, computeLayoutMetrics, evaluateCompositeContrast } from '@hawa/creative';
import { buildP0SystemPrompt, buildP5Prompt } from '../prompts.js';
import { LAYOUT_SCHEMA } from './layouts.stage.js';

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
  const logoMinPx = Math.max(100, Math.round(ctx.width * 0.08));

  const constraintsStr = `margin >= ${marginPx}px; body >= ${bodyMinPx}px; title >= 2.2 * body; logo width >= ${logoMinPx}px; palette = ${ctx.referencePack.palette.join(', ')}`;

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
    reference: {
      rules: {
        fontFamily: ctx.latinFont,
        palette: ctx.referencePack.palette,
        scriptFonts: {
          arabic: ctx.arabicFont,
        },
      },
      logoAspect: ctx.logoAspect || 1.0,
    },
    draftFont: ctx.latinFont || 'Verdana',
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

      const revisedLayout = response.data.layout;
      const minBodyPx = Math.ceil(0.016 * ctx.width);
      for (const t of revisedLayout.text) {
        if (t.role === 'body') t.fontSize = Math.max(t.fontSize, minBodyPx);
        else if (t.role === 'footer') t.fontSize = Math.max(t.fontSize, 12);
        else t.fontSize = Math.max(t.fontSize, 12);
      }
      const validation = validateLayoutV2(revisedLayout, validationContext);

      if (validation.ok) {
        const layoutToUse = validation.layout || revisedLayout;
        cand.layouts.push(layoutToUse);
        cand.currentLayout = layoutToUse;

        const artDataUri = cand.artPng
          ? `data:image/png;base64,${cand.artPng.toString('base64')}`
          : undefined;

        // Re-render
        const renderResult = renderLayoutV2(revisedLayout, {
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
            const contrastResult = evaluateCompositeContrast(renderResult.noTextPng, revisedLayout);
            contrastValues = contrastResult.p05PerBox;
          } catch {
            // Fallback to background calculation in computeLayoutMetrics
          }
        }

        cand.metrics = computeLayoutMetrics(revisedLayout, {
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
      if (err instanceof StudioBudgetExhaustedError) {
        throw err;
      }
      // If revision model call fails, keep current candidate layout intact and record diagnostic
      if (!cand.diagnostics) cand.diagnostics = [];
      cand.diagnostics.push(`Revision stage error: ${err?.message || 'UNKNOWN_ERROR'}`);
    }
  }

  return candidates;
}
