import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { evaluateHardQa } from '@hawa/creative';

export async function runQAStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<HardQAResult> {
  // The gate itself lives in @hawa/creative so the qualification applies exactly this gate.
  const outcome = evaluateHardQa(
    winner.currentLayout,
    {
      width: ctx.width,
      height: ctx.height,
      copyScripts: ctx.copyBlocks.map((b) => (b.script === 'arabic' ? 'arabic' : 'latin')),
      latinFont: ctx.latinFont,
      arabicFont: ctx.arabicFont,
      palette: ctx.referencePack.palette,
      logoAspect: ctx.logoAspect || 1.0,
    },
    winner.metrics
  );
  winner.currentLayout = outcome.layout;
  winner.metrics = outcome.metrics;
  return {
    passed: outcome.passed,
    defectCodes: outcome.defectCodes,
    metrics: outcome.metrics,
  };
}
