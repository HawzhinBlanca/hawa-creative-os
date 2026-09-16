import { assertModelAllowed } from '@hawa/domain';
import type { StudioLayoutV2 } from './layout-v2.js';
import {
  evaluateDesignMetrics,
  type DesignMetricsReport,
} from './design-metrics.js';
import { renderLayoutV2 } from './render-layout-v2.js';
import {
  OpenAiStudioClient,
  type OpenAiMessage,
} from './openai-studio-client.js';

export type JudgeDimension =
  | 'hierarchy'
  | 'composition'
  | 'typographic_craft'
  | 'brand_fit'
  | 'legibility';

export const JUDGE_DIMENSIONS: JudgeDimension[] = [
  'hierarchy',
  'composition',
  'typographic_craft',
  'brand_fit',
  'legibility',
];

export interface DimensionVote {
  winner: 'A' | 'B';
  rationale: string;
}

export interface DimensionEvaluationOutput {
  dimensions: Record<JudgeDimension, DimensionVote>;
  majorityWinner: 'A' | 'B';
  summary: string;
}

export interface CandidateJudgeInput {
  id: string | number;
  layout: StudioLayoutV2;
  deterministicMetrics?: DesignMetricsReport;
  renderedPng?: Buffer;
}

export interface OrderComparisonResult {
  order: 'AB' | 'BA';
  candidateAId: string | number;
  candidateBId: string | number;
  votes: Record<JudgeDimension, 'A' | 'B'>;
  rationales: Record<JudgeDimension, string>;
  winnerVotesA: number;
  winnerVotesB: number;
  majorityWinner: 'A' | 'B';
  winnerCandidateId: string | number;
  receipt: {
    model: string;
    responseId: string;
    xRequestId: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  };
}

export interface PairwiseMatchResult {
  candidate1Id: string | number;
  candidate2Id: string | number;
  orderAB: OrderComparisonResult;
  orderBA: OrderComparisonResult;
  isConsistent: boolean;
  disagreementRecorded: boolean;
  winnerId: string | number | 'TIE_DISCARDED';
  reason: string;
  totalCostUsd: number;
}

export interface TournamentResult {
  survivingCandidates: Array<{ id: string | number; score: number }>;
  skippedDueToSingleSurvivor: boolean;
  callsMade: number;
  totalCostUsd: number;
  matches: PairwiseMatchResult[];
  winnerId: string | number | null;
  canaryResult?: {
    canaryCandidateId: string | number;
    canaryLost: boolean;
    canaryPassed: boolean;
    match: PairwiseMatchResult;
  };
}

export interface JudgeOptions {
  client?: OpenAiStudioClient;
  openaiApiKey?: string;
  fetchFn?: typeof fetch;
  model?: string;
}

export const PAIRWISE_DIMENSION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'object',
      properties: {
        hierarchy: {
          type: 'object',
          properties: {
            winner: { type: 'string', enum: ['A', 'B'] },
            rationale: { type: 'string' },
          },
          required: ['winner', 'rationale'],
          additionalProperties: false,
        },
        composition: {
          type: 'object',
          properties: {
            winner: { type: 'string', enum: ['A', 'B'] },
            rationale: { type: 'string' },
          },
          required: ['winner', 'rationale'],
          additionalProperties: false,
        },
        typographic_craft: {
          type: 'object',
          properties: {
            winner: { type: 'string', enum: ['A', 'B'] },
            rationale: { type: 'string' },
          },
          required: ['winner', 'rationale'],
          additionalProperties: false,
        },
        brand_fit: {
          type: 'object',
          properties: {
            winner: { type: 'string', enum: ['A', 'B'] },
            rationale: { type: 'string' },
          },
          required: ['winner', 'rationale'],
          additionalProperties: false,
        },
        legibility: {
          type: 'object',
          properties: {
            winner: { type: 'string', enum: ['A', 'B'] },
            rationale: { type: 'string' },
          },
          required: ['winner', 'rationale'],
          additionalProperties: false,
        },
      },
      required: [
        'hierarchy',
        'composition',
        'typographic_craft',
        'brand_fit',
        'legibility',
      ],
      additionalProperties: false,
    },
    majorityWinner: {
      type: 'string',
      enum: ['A', 'B'],
      description: 'The majority winner across the five independent dimensions (at least 3 votes)',
    },
    summary: {
      type: 'string',
      description: '1-2 sentence overall comparative critique',
    },
  },
  required: ['dimensions', 'majorityWinner', 'summary'],
  additionalProperties: false,
};

/**
 * Creates a deliberately degraded copy canary of a candidate layout.
 * Perturbations:
 * 1. Severe font shrinkage and squashed line-height on body text.
 * 2. Title shifted into margins with reduced contrast.
 * 3. Element overlapping.
 */
export function createDegradedCanaryLayout(layout: StudioLayoutV2): StudioLayoutV2 {
  const clone: StudioLayoutV2 = JSON.parse(JSON.stringify(layout));

  clone.text = clone.text.map((t) => {
    if (t.role === 'body') {
      return {
        ...t,
        fontSize: Math.max(8, Math.round(t.fontSize * 0.5)),
        lineHeight: 0.9,
      };
    }
    if (t.role === 'title') {
      return {
        ...t,
        x: 10,
        y: clone.logo ? clone.logo.y + Math.round(clone.logo.height * 0.3) : t.y,
        fontSize: Math.round(t.fontSize * 0.75),
      };
    }
    return t;
  });

  return clone;
}

/**
 * Evaluates one specific presentation order (Candidate A vs Candidate B)
 * across the 5 independent dimensions with deterministic metrics stated as facts first.
 */
export async function evaluatePairOrder(
  candA: CandidateJudgeInput,
  candB: CandidateJudgeInput,
  order: 'AB' | 'BA',
  options: JudgeOptions = {}
): Promise<OrderComparisonResult> {
  const model = options.model || 'gpt-6-astra';
  assertModelAllowed(model);

  const client =
    options.client ||
    new OpenAiStudioClient({
      apiKey: options.openaiApiKey || process.env.OPENAI_API_KEY,
      fetcher: options.fetchFn,
      primaryModel: model,
    });

  // 1. Ensure deterministic metrics
  const metricsA = candA.deterministicMetrics || evaluateDesignMetrics(candA.layout);
  const metricsB = candB.deterministicMetrics || evaluateDesignMetrics(candB.layout);

  // 2. Ensure renders
  const pngA = candA.renderedPng || renderLayoutV2(candA.layout).png;
  const pngB = candB.renderedPng || renderLayoutV2(candB.layout).png;

  // 3. Build Prompts
  const systemPrompt = `You are an impartial, senior design judge conducting a blind pairwise design comparison.
You are evaluating two poster candidates, Candidate A and Candidate B.
You must judge them INDEPENDENTLY across EXACTLY FIVE NAMED DIMENSIONS:
1. hierarchy: clear dominance of title over subtitle and body; logical reading order.
2. composition: balance, grid discipline, alignment, negative space, framing.
3. typographic_craft: font pairings, type scale consistency, tracking, line length and height.
4. brand_fit: institutional prestige, elegance, academic gravitas.
5. legibility: instant readability, comfortable reading rhythm, no crowding.

RULES:
- Deterministic layout metrics are provided as objective facts. You must take them into account.
- For EACH dimension, vote either 'A' or 'B' and provide a specific rationale. Ties are not permitted per dimension.
- The overall winner is determined strictly by majority vote across the five dimensions (at least 3 votes).`;

  const factsPrompt = `GROUND TRUTH DETERMINISTIC METRICS (arXiv:2402.06945 & LaySPA):

CANDIDATE A:
- Composite Score: ${metricsA.compositeScore.toFixed(3)} (Passed: ${metricsA.passed})
- Failing Metrics: [${metricsA.failingMetrics.join(', ')}]
- Key Metric Scores:
  * Alignment: ${metricsA.metrics.alignment.score.toFixed(3)}
  * Balance: ${metricsA.metrics.balance.score.toFixed(3)}
  * Regularity: ${metricsA.metrics.regularity.score.toFixed(3)}
  * Text Legibility: ${metricsA.metrics.textLegibility.score.toFixed(3)}
  * Type Scale: ${metricsA.metrics.typeScale.score.toFixed(3)}

CANDIDATE B:
- Composite Score: ${metricsB.compositeScore.toFixed(3)} (Passed: ${metricsB.passed})
- Failing Metrics: [${metricsB.failingMetrics.join(', ')}]
- Key Metric Scores:
  * Alignment: ${metricsB.metrics.alignment.score.toFixed(3)}
  * Balance: ${metricsB.metrics.balance.score.toFixed(3)}
  * Regularity: ${metricsB.metrics.regularity.score.toFixed(3)}
  * Text Legibility: ${metricsB.metrics.textLegibility.score.toFixed(3)}
  * Type Scale: ${metricsB.metrics.typeScale.score.toFixed(3)}

Attached are two images rendered at detail 'low':
- Image 1: Candidate A
- Image 2: Candidate B

TASK:
Examine Candidate A and Candidate B visually and evaluate them independently across all 5 dimensions.`;

  const b64A = `data:image/png;base64,${pngA.toString('base64')}`;
  const b64B = `data:image/png;base64,${pngB.toString('base64')}`;

  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: factsPrompt },
        { type: 'image_url', image_url: { url: b64A, detail: 'low' } },
        { type: 'image_url', image_url: { url: b64B, detail: 'low' } },
      ],
    },
  ];

  const res = await client.createStructuredCompletion<DimensionEvaluationOutput>({
    model,
    messages,
    jsonSchema: {
      name: 'PairwiseDimensionVerdict',
      schema: PAIRWISE_DIMENSION_JSON_SCHEMA,
      strict: true,
    },
    reasoningEffort: 'low',
    maxTokens: 2000,
  });

  const data = res.data;
  const votes: Record<JudgeDimension, 'A' | 'B'> = {} as any;
  const rationales: Record<JudgeDimension, string> = {} as any;

  let votesA = 0;
  let votesB = 0;

  for (const dim of JUDGE_DIMENSIONS) {
    const dimData = data.dimensions?.[dim];
    const w = dimData?.winner === 'A' ? 'A' : 'B';
    votes[dim] = w;
    rationales[dim] = dimData?.rationale || '';
    if (w === 'A') votesA++;
    else votesB++;
  }

  const majorityWinner = votesA >= 3 ? 'A' : 'B';
  const winnerCandidateId = majorityWinner === 'A' ? candA.id : candB.id;

  return {
    order,
    candidateAId: candA.id,
    candidateBId: candB.id,
    votes,
    rationales,
    winnerVotesA: votesA,
    winnerVotesB: votesB,
    majorityWinner,
    winnerCandidateId,
    receipt: {
      model: res.receipt.model,
      responseId: res.receipt.responseId,
      xRequestId: res.receipt.xRequestId ?? null,
      inputTokens: res.receipt.inputTokens,
      outputTokens: res.receipt.outputTokens,
      costUsd: res.receipt.costUsd,
      latencyMs: res.receipt.latencyMs,
    },
  };
}

/**
 * Runs an order-swapped pairwise match:
 * Evaluates in order AB, then in order BA.
 * Discards pair if two orderings disagree, recording the disagreement.
 */
export async function comparePairWithOrderSwap(
  cand1: CandidateJudgeInput,
  cand2: CandidateJudgeInput,
  options: JudgeOptions = {}
): Promise<PairwiseMatchResult> {
  // Order 1: cand1 as A, cand2 as B
  const orderAB = await evaluatePairOrder(cand1, cand2, 'AB', options);

  // Order 2: cand2 as A, cand1 as B (Swapped)
  const orderBA = await evaluatePairOrder(cand2, cand1, 'BA', options);

  const winnerAB = orderAB.winnerCandidateId;
  const winnerBA = orderBA.winnerCandidateId;

  const isConsistent = winnerAB === winnerBA;
  const disagreementRecorded = !isConsistent;

  let winnerId: string | number | 'TIE_DISCARDED';
  let reason: string;

  if (isConsistent) {
    winnerId = winnerAB;
    reason = `Order-consistent majority verdict: candidate ${winnerId} won in both presentation orders (${orderAB.winnerVotesA}-${orderAB.winnerVotesB} in AB, ${orderBA.winnerVotesA}-${orderBA.winnerVotesB} in BA).`;
  } else {
    winnerId = 'TIE_DISCARDED';
    reason = `Order-swap flip detected: candidate ${winnerAB} won in order AB, but candidate ${winnerBA} won in order BA. Disagreement recorded; pair discarded per arXiv:2604.22891.`;
  }

  const totalCostUsd = Number((orderAB.receipt.costUsd + orderBA.receipt.costUsd).toFixed(6));

  return {
    candidate1Id: cand1.id,
    candidate2Id: cand2.id,
    orderAB,
    orderBA,
    isConsistent,
    disagreementRecorded,
    winnerId,
    reason,
    totalCostUsd,
  };
}

/**
 * Full Tournament with Canary Check & Single-Survivor Bypass:
 * 1. Checks P01 deterministic pass rate. If only 1 candidate survives, skips judge entirely (0 calls).
 * 2. Runs pairwise dimension-wise comparisons with order-swapping.
 * 3. Runs degraded-copy canary evaluation: canary must lose in every live run.
 */
export async function runTournamentWithCanary(
  candidates: CandidateJudgeInput[],
  options: JudgeOptions = {}
): Promise<TournamentResult> {
  // 1. Evaluate deterministic metrics on all candidates
  const evaluated = candidates.map((c) => ({
    ...c,
    deterministicMetrics: c.deterministicMetrics || evaluateDesignMetrics(c.layout),
  }));

  const survivors = evaluated.filter((c) => c.deterministicMetrics.passed);

  // 2. Single survivor check (rule: skip judge entirely when only one candidate survives P01)
  if (survivors.length <= 1) {
    const singleWinner = survivors.length === 1 ? survivors[0].id : null;
    return {
      survivingCandidates: survivors.map((s) => ({
        id: s.id,
        score: s.deterministicMetrics.compositeScore,
      })),
      skippedDueToSingleSurvivor: survivors.length === 1,
      callsMade: 0,
      totalCostUsd: 0,
      matches: [],
      winnerId: singleWinner,
    };
  }

  // 3. Tournament among survivors
  const matches: PairwiseMatchResult[] = [];
  let totalCostUsd = 0;
  let callsMade = 0;

  // Round robin over survivors
  const wins: Record<string | number, number> = {};
  for (const s of survivors) {
    wins[s.id] = 0;
  }

  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const match = await comparePairWithOrderSwap(survivors[i], survivors[j], options);
      matches.push(match);
      callsMade += 2;
      totalCostUsd += match.totalCostUsd;

      if (match.winnerId !== 'TIE_DISCARDED') {
        wins[match.winnerId] = (wins[match.winnerId] || 0) + 1;
      }
    }
  }

  // Determine leader
  let bestId = survivors[0].id;
  let maxWins = -1;
  for (const [id, count] of Object.entries(wins)) {
    if (count > maxWins) {
      maxWins = count;
      bestId = id;
    }
  }

  const leaderCandidate = survivors.find((s) => String(s.id) === String(bestId)) || survivors[0];

  // 4. Degraded-Copy Canary Check
  const canaryLayout = createDegradedCanaryLayout(leaderCandidate.layout);
  const canaryCandidate: CandidateJudgeInput = {
    id: `${leaderCandidate.id}_canary_degraded`,
    layout: canaryLayout,
    deterministicMetrics: evaluateDesignMetrics(canaryLayout),
  };

  const canaryMatch = await comparePairWithOrderSwap(leaderCandidate, canaryCandidate, options);
  callsMade += 2;
  totalCostUsd += canaryMatch.totalCostUsd;

  const canaryLost = canaryMatch.winnerId === leaderCandidate.id;
  const canaryPassed = canaryLost; // Canary passes if the good candidate beats the degraded clone

  return {
    survivingCandidates: survivors.map((s) => ({
      id: s.id,
      score: s.deterministicMetrics.compositeScore,
    })),
    skippedDueToSingleSurvivor: false,
    callsMade,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    matches,
    winnerId: leaderCandidate.id,
    canaryResult: {
      canaryCandidateId: canaryCandidate.id,
      canaryLost,
      canaryPassed,
      match: canaryMatch,
    },
  };
}
