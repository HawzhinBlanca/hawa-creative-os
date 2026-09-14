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
      logoAspect: ctx.logoAspect || 2.45,
    },
    draftFont: 'EB Garamond',
  };

  const validation = validateLayoutV2(winner.currentLayout, validationContext);

  if (!validation.ok) {
    defectCodes.push(validation.code);
  }

  // Hard QA check: Metrics validation
  if (winner.metrics) {
    if (winner.metrics.overlapCount > 0) {
      defectCodes.push('OVERLAP');
    }
    if (winner.metrics.alignmentScore < 0.70) {
      defectCodes.push('POOR_GRID_ALIGNMENT');
    }
  }

  return {
    passed: defectCodes.length === 0,
    defectCodes,
    metrics: winner.metrics!,
  };
}
