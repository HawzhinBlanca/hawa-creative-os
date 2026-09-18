import { resolveModel } from '@hawa/domain';
import type { StudioLayoutV2 } from './layout-v2.js';
import { evaluateDesignMetrics, type DesignMetricsReport } from './design-metrics.js';
import { renderLayoutV2, measureWrappedLines } from './render-layout-v2.js';
import { correctFontsThatCannotDrawTheCopy } from './layout-generator-v3.js';
import { generateBoxGroundedCritique, type BoxCritiqueResult } from './box-critique-v3.js';
import { refineCandidate, type RefinementCandidateResult } from './refinement-engine-v3.js';
import {
  comparePairWithOrderSwap,
  createDegradedCanaryLayout,
  type CandidateJudgeInput,
  type PairwiseMatchResult,
} from './pairwise-judge-v3.js';
import type { OpenAiStudioClient } from './openai-studio-client.js';

/**
 * The v3 pipeline's decisions, in one place, for both of its callers.
 *
 * Production's studio and the qualification runner used to implement these steps separately, and
 * they drifted: the studio ran its own v2 critique, revision and judge around the v3 generator,
 * so no qualification ever measured what a client would receive. Both now call these functions,
 * so the qualification measures the code that decides a client's design.
 *
 * Every function here renders and scores with the real copy. Without it the renderer draws
 * "Sample copy block N" in every block, and earlier qualification runs critiqued and judged
 * exactly that.
 */

export type CopyScriptV3 = 'latin' | 'arabic';

export interface PipelineV3Copy {
  /** The text each block carries, by copyIndex. */
  text: Record<number, string>;
  /** The script of each block, by copyIndex. Detected from the text when absent. */
  scripts?: Record<number, CopyScriptV3>;
}

export interface RankedCandidateV3 {
  /** Position in the generator's output; stable across ranking. */
  sourceIndex: number;
  layout: StudioLayoutV2;
  metrics: DesignMetricsReport;
  /** A render the caller already has — with art, for instance. Rendered from the copy when absent. */
  renderedPng?: Buffer;
}

export interface PipelineV3CallOptions {
  client?: OpenAiStudioClient;
  /** Overrides the active tier's model for this role. */
  model?: string;
}

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

function scriptOf(copy: PipelineV3Copy, copyIndex: number): CopyScriptV3 {
  return copy.scripts?.[copyIndex] ?? (ARABIC_SCRIPT.test(copy.text[copyIndex] ?? '') ? 'arabic' : 'latin');
}

/**
 * Maps a family the model chose onto the admitted set, by the role and script of its block.
 * Body and footer copy use the formal body faces; display copy keeps an admitted display face.
 * Amiri, not Cairo, is the right-to-left default: Cairo cannot draw the Sorani letters ڕ ڵ ۆ ێ ە.
 */
export function admittedFontFor(font: string, script: CopyScriptV3, role?: string): string {
  if (role === 'body' || role === 'footer') {
    return script === 'arabic' ? 'Noto Sans Arabic' : 'Verdana';
  }
  if (script === 'arabic') {
    return font === 'Cairo' || font === 'Amiri' || font === 'Noto Sans Arabic' ? font : 'Amiri';
  }
  if (font === 'Cinzel' || font === 'Playfair Display' || font === 'Verdana') return font;
  if (font === 'Lora') return 'Playfair Display';
  return 'Cinzel';
}

/**
 * Puts every block in an admitted face for its own script, then swaps any face that cannot draw
 * the block's actual characters. Mutates and returns the layout.
 *
 * Decided per block rather than per brief, so a bilingual design keeps its English display face
 * on English blocks and its Sorani face on Sorani ones. Direction is decided here too, from the
 * copy: a Sorani block the model left unmarked would otherwise render left-to-right, and the
 * coverage check — which reads a block's script from its direction — would skip it entirely.
 */
export function sanitizeFontsV3(layout: StudioLayoutV2, copy: PipelineV3Copy): StudioLayoutV2 {
  for (const t of layout.text) {
    const script = scriptOf(copy, t.copyIndex);
    t.rtl = script === 'arabic';
    t.fontFamily = admittedFontFor(t.fontFamily, script, t.role) as any;
  }
  correctFontsThatCannotDrawTheCopy(layout, copy.text);
  return layout;
}

/** The pipeline's deterministic measure: from the lines the real copy wraps to, not box area. */
export function measureDesignV3(layout: StudioLayoutV2, copy: PipelineV3Copy): DesignMetricsReport {
  return evaluateDesignMetrics(layout, { wrappedLines: measureWrappedLines(layout, copy.text) });
}

/** Passing candidates first, then by composite score. Stable for equal scores. */
export function rankCandidatesV3(
  candidates: Array<{ sourceIndex: number; layout: StudioLayoutV2; renderedPng?: Buffer }>,
  copy: PipelineV3Copy
): RankedCandidateV3[] {
  return candidates
    .map((c) => ({ ...c, metrics: measureDesignV3(c.layout, copy) }))
    .sort((a, b) => {
      if (a.metrics.passed !== b.metrics.passed) return a.metrics.passed ? -1 : 1;
      return b.metrics.compositeScore - a.metrics.compositeScore;
    });
}

/** P05: one box-grounded critique of a candidate, rendered with its copy. */
export async function critiqueCandidateV3(
  candidate: RankedCandidateV3,
  copy: PipelineV3Copy,
  options: PipelineV3CallOptions = {}
): Promise<BoxCritiqueResult> {
  return generateBoxGroundedCritique(candidate.layout, {
    client: options.client,
    model: options.model || resolveModel('critique'),
    deterministicMetrics: candidate.metrics,
    renderOptions: { copyText: copy.text },
  });
}

export interface RefinementOutcomeV3 {
  /** The layout to carry forward: the refinement when adopted, the original otherwise. */
  layout: StudioLayoutV2;
  metrics: DesignMetricsReport;
  adopted: boolean;
  reason:
    | 'gate_passed'
    | 'adopted_now_passes'
    | 'adopted_higher_score'
    | 'rejected_unusable'
    | 'rejected_no_improvement';
  result: RefinementCandidateResult;
}

function isUsableLayout(layout: StudioLayoutV2 | undefined | null): layout is StudioLayoutV2 {
  return (
    !!layout &&
    Array.isArray(layout.text) &&
    layout.text.length > 0 &&
    Array.isArray(layout.shapes) &&
    Number.isFinite(layout.width) &&
    Number.isFinite(layout.height)
  );
}

/**
 * P06: gated refinement of one candidate. The engine refines only a candidate that fails a
 * metric or scores below the calibrated band, and spends nothing otherwise.
 *
 * A refinement is adopted only after its fonts are re-sanitised and it is measured again, and
 * only if it is better: it passes where the original failed, or it scores higher without
 * starting to fail. Errors propagate, so a caller can tell a budget stop from a model outage.
 */
export async function refineCandidateV3(
  candidate: RankedCandidateV3,
  copy: PipelineV3Copy,
  options: PipelineV3CallOptions = {}
): Promise<RefinementOutcomeV3> {
  const result = await refineCandidate(candidate.sourceIndex, candidate.layout, {
    client: options.client,
    model: options.model || resolveModel('layout'),
    maxRounds: 2,
    minDelta: 0.01,
    copyText: copy.text,
  });

  const keep = (reason: RefinementOutcomeV3['reason']): RefinementOutcomeV3 => ({
    layout: candidate.layout,
    metrics: candidate.metrics,
    adopted: false,
    reason,
    result,
  });

  if (result.gateDecision === 'skip') return keep('gate_passed');
  if (!isUsableLayout(result.finalLayout)) return keep('rejected_unusable');

  const refined = sanitizeFontsV3(JSON.parse(JSON.stringify(result.finalLayout)) as StudioLayoutV2, copy);
  const metrics = measureDesignV3(refined, copy);

  if (metrics.passed && !candidate.metrics.passed) {
    return { layout: refined, metrics, adopted: true, reason: 'adopted_now_passes', result };
  }
  if (metrics.passed === candidate.metrics.passed && metrics.compositeScore > candidate.metrics.compositeScore) {
    return { layout: refined, metrics, adopted: true, reason: 'adopted_higher_score', result };
  }
  return keep('rejected_no_improvement');
}

export interface WinnerSelectionV3 {
  winner: RankedCandidateV3;
  runnerUp: RankedCandidateV3 | null;
  /**
   * single_candidate — nothing to compare.
   * judge — the judge picked the same candidate from both positions and passed its canary.
   * composite_after_tie — the judge's two orderings disagreed, so the higher composite stands.
   * composite_judge_unreliable — the judge picked, then failed to beat a degraded copy of its own
   *   pick; a judge that cannot see that is not trusted, and the higher composite stands.
   */
  decidedBy: 'single_candidate' | 'judge' | 'composite_after_tie' | 'composite_judge_unreliable';
  match: PairwiseMatchResult | null;
  canary: { passed: boolean; match: PairwiseMatchResult } | null;
  /** Whether the judge beat the degraded canary in both orders. Null when no judge ran. */
  judgeReliable: boolean | null;
}

/**
 * P07: the judge compares the top two candidates in both orders, dimension by dimension, and a
 * degraded copy of the chosen design checks that the judge can see an obvious defect. The pick
 * stands only if the judge chose it from both positions and then beat the canary from both.
 */
export async function selectWinnerV3(
  ranked: RankedCandidateV3[],
  copy: PipelineV3Copy,
  options: PipelineV3CallOptions = {}
): Promise<WinnerSelectionV3> {
  if (ranked.length === 0) throw new Error('selectWinnerV3 needs at least one candidate');
  if (ranked.length === 1) {
    return {
      winner: ranked[0],
      runnerUp: null,
      decidedBy: 'single_candidate',
      match: null,
      canary: null,
      judgeReliable: null,
    };
  }

  const judgeOptions = {
    client: options.client,
    model: options.model || resolveModel('judge'),
    renderOptions: { copyText: copy.text },
  };
  const asJudgeInput = (c: RankedCandidateV3, id: string): CandidateJudgeInput => ({
    id,
    layout: c.layout,
    deterministicMetrics: c.metrics,
    renderedPng: c.renderedPng || renderLayoutV2(c.layout, { copyText: copy.text }).png,
  });

  const [first, second] = ranked;
  const firstId = `candidate_${first.sourceIndex}`;
  const secondId = `candidate_${second.sourceIndex}`;
  const match = await comparePairWithOrderSwap(asJudgeInput(first, firstId), asJudgeInput(second, secondId), judgeOptions);

  const judgePick = match.winnerId === firstId ? first : match.winnerId === secondId ? second : null;
  const tentative = judgePick ?? first;

  // Both sides of the canary are rendered the same way, from the layout alone. Handing the judge
  // the chosen design's own render — which may carry art — against a plain render of the degraded
  // copy would let the art, not the judge's eye for the defect, win the canary.
  const canaryLayout = createDegradedCanaryLayout(tentative.layout);
  const canaryMatch = await comparePairWithOrderSwap(
    {
      id: 'chosen',
      layout: tentative.layout,
      deterministicMetrics: tentative.metrics,
      renderedPng: renderLayoutV2(tentative.layout, { copyText: copy.text }).png,
    },
    {
      id: 'degraded_canary',
      layout: canaryLayout,
      deterministicMetrics: measureDesignV3(canaryLayout, copy),
      renderedPng: renderLayoutV2(canaryLayout, { copyText: copy.text }).png,
    },
    judgeOptions
  );
  const canaryPassed = canaryMatch.winnerId === 'chosen';
  const canary = { passed: canaryPassed, match: canaryMatch };

  if (!judgePick) {
    return { winner: first, runnerUp: second, decidedBy: 'composite_after_tie', match, canary, judgeReliable: canaryPassed };
  }
  if (!canaryPassed) {
    return { winner: first, runnerUp: second, decidedBy: 'composite_judge_unreliable', match, canary, judgeReliable: false };
  }
  return {
    winner: judgePick,
    runnerUp: judgePick === first ? second : first,
    decidedBy: 'judge',
    match,
    canary,
    judgeReliable: true,
  };
}
