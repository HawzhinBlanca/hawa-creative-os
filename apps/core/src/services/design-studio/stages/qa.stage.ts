import type { StageContext, CandidateState, HardQAResult } from '../types.js';
import { evaluateHardQa } from '@hawa/creative';
import { hardQaContextFor } from './v3.stage.js';

export async function runQAStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<HardQAResult> {
  // The gate itself lives in @hawa/creative so the qualification applies exactly this gate, with
  // the context ranking and refinement use — the copy included, so overflowing copy fails here too.
  const outcome = evaluateHardQa(winner.currentLayout, hardQaContextFor(ctx), winner.metrics);
  winner.currentLayout = outcome.layout;
  winner.metrics = outcome.metrics;
  return {
    passed: outcome.passed,
    defectCodes: outcome.defectCodes,
    metrics: outcome.metrics,
    textMeasurements: outcome.textMeasurements,
    messages: outcome.messages,
  };
}
