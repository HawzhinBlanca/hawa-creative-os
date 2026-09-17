import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { validateLayoutV2, type LayoutValidationContext } from '@hawa/creative';

export async function runQAStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<HardQAResult> {
  const defectCodes: string[] = [];

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

  // Safe clamp of text element font sizes to guarantee minimum readability requirements
  const minBodyPx = Math.ceil(0.016 * ctx.width);
  for (const t of winner.currentLayout.text) {
    if (t.role === 'body') t.fontSize = Math.max(t.fontSize, minBodyPx);
    else if (t.role === 'footer') t.fontSize = Math.max(t.fontSize, 12);
    else t.fontSize = Math.max(t.fontSize, 12);
  }

  const validation = validateLayoutV2(winner.currentLayout, validationContext);

  if (!validation.ok) {
    defectCodes.push(validation.code);
  } else if (validation.layout) {
    winner.currentLayout = validation.layout;
  }

  // Hard QA check: Metrics validation
  if (winner.metrics) {
    if (winner.metrics.overlapCount > 0) {
      defectCodes.push('OVERLAP');
    }
  }

  return {
    passed: defectCodes.length === 0,
    defectCodes,
    metrics: winner.metrics!,
  };
}
