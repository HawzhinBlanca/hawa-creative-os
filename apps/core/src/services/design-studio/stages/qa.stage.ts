import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import {
  validateLayoutV2,
  computeLayoutMetrics,
  findAsymmetricSeparators,
  type LayoutValidationContext,
} from '@hawa/creative';

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

  // Explicit check for unreadable font sizes: fail QA, do NOT mutatively rewrite font sizes
  const minBodyPx = Math.ceil(0.016 * ctx.width);
  for (const t of winner.currentLayout.text) {
    if (t.fontSize < 12 || (t.role === 'body' && t.fontSize < minBodyPx)) {
      if (!defectCodes.includes('MIN_SIZE')) defectCodes.push('MIN_SIZE');
      if (!defectCodes.includes('UNREADABLE_FONT_SIZE')) defectCodes.push('UNREADABLE_FONT_SIZE');
    }
  }

  const validation = validateLayoutV2(winner.currentLayout, validationContext);

  if (!validation.ok) {
    if (!defectCodes.includes(validation.code)) {
      defectCodes.push(validation.code);
    }
  } else if (validation.layout) {
    // Preserve layout normalization (e.g. script font) only if validated OK
    winner.currentLayout = validation.layout;
  }

  // Hard QA check: Metrics validation
  // Compute metrics if not present to ensure metrics report describes what ships
  const metrics = winner.metrics || computeLayoutMetrics(winner.currentLayout);
  winner.metrics = metrics;

  if (metrics.overlapCount > 0) {
    defectCodes.push('OVERLAP');
  }

  // Restore POOR_GRID_ALIGNMENT defect gate
  // Calibrated against six confirmed KAAE exemplars (range 0.792 - 1.000, mean 0.949)
  // An alignment score < 0.70 represents severe raggedness / off-grid drift that violates institutional dignity
  if (metrics.alignmentScore < 0.70) {
    defectCodes.push('POOR_GRID_ALIGNMENT');
  }

  // A divider that sits far closer to one of the two blocks it separates. The v3 generator centres
  // these unconditionally, so this fires only for a layout that reached QA without that
  // normalisation. It is a hard gate rather than a weighted metric because no deterministic metric
  // responds to separator position at all: recentring all 31 separators across the eighteen T5
  // layouts changed every one of the thirteen metric scores by exactly 0.0000.
  const asymmetricSeparators = findAsymmetricSeparators(
    winner.currentLayout.shapes || [],
    winner.currentLayout.text || []
  );
  if (asymmetricSeparators.length > 0) {
    defectCodes.push('ASYMMETRIC_SEPARATOR');
  }

  return {
    passed: defectCodes.length === 0,
    defectCodes,
    metrics,
  };
}
