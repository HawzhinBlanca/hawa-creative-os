import { randomUUID } from 'node:crypto';
import type { StageContext, CreativeBrief, CandidateState, PairwiseVerdict } from '../types.js';
import { buildP0SystemPrompt, buildP6Prompt } from '../prompts.js';

export const PAIRWISE_SCHEMA = {
  type: 'object',
  properties: {
    winner: {
      type: 'string',
      enum: ['A', 'B', 'tie', 'both_unacceptable'],
    },
    confidence: { type: 'number' },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 3,
    },
    hardFails: {
      type: 'object',
      properties: {
        A: { type: 'array', items: { type: 'string' } },
        B: { type: 'array', items: { type: 'string' } },
      },
      required: ['A', 'B'],
      additionalProperties: false,
    },
  },
  required: ['winner', 'confidence', 'reasons', 'hardFails'],
  additionalProperties: false,
};

export interface TournamentResult {
  winnerCandidate: CandidateState;
  rankedCandidates: CandidateState[];
  pairwiseJudgments: Array<{
    candidateAId: string;
    candidateBId: string;
    orderSwapped: boolean;
    verdict: PairwiseVerdict;
  }>;
}

export async function runTournamentStage(
  ctx: StageContext,
  brief: CreativeBrief,
  candidates: CandidateState[]
): Promise<TournamentResult> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  // Pick top 3 candidates sorted by initial score
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const pool = sorted.slice(0, Math.min(3, sorted.length));

  if (pool.length === 1) {
    pool[0].rank = 1;
    pool[0].status = 'winner';
    return {
      winnerCandidate: pool[0],
      rankedCandidates: pool,
      pairwiseJudgments: [],
    };
  }

  const scoresMap = new Map<string, number>();
  for (const c of pool) {
    scoresMap.set(c.id, 0);
  }

  const pairwiseJudgments: TournamentResult['pairwiseJudgments'] = [];

  // Round-robin tournament among top-3 with order swaps
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const cand1 = pool[i];
      const cand2 = pool[j];

      if (!cand1.previewPng || !cand2.previewPng) continue;

      // Call 1: cand1 as A, cand2 as B
      const promptAB = buildP6Prompt({
        metricsA: JSON.stringify(cand1.metrics || {}),
        metricsB: JSON.stringify(cand2.metrics || {}),
        creativeBriefJson: JSON.stringify(brief),
      });

      const resAB = await ctx.client.completeJson<PairwiseVerdict>({
        system: systemPrompt,
        prompt: promptAB,
        schema: PAIRWISE_SCHEMA,
        schemaName: 'PairwiseVerdict',
        images: [cand1.previewPng, cand2.previewPng],
      });

      const verdictAB = resAB.data;
      pairwiseJudgments.push({
        candidateAId: cand1.id,
        candidateBId: cand2.id,
        orderSwapped: false,
        verdict: verdictAB,
      });

      // Call 2: cand2 as A, cand1 as B (Swapped)
      const promptBA = buildP6Prompt({
        metricsA: JSON.stringify(cand2.metrics || {}),
        metricsB: JSON.stringify(cand1.metrics || {}),
        creativeBriefJson: JSON.stringify(brief),
      });

      const resBA = await ctx.client.completeJson<PairwiseVerdict>({
        system: systemPrompt,
        prompt: promptBA,
        schema: PAIRWISE_SCHEMA,
        schemaName: 'PairwiseVerdict',
        images: [cand2.previewPng, cand1.previewPng],
      });

      const verdictBA = resBA.data;
      pairwiseJudgments.push({
        candidateAId: cand2.id,
        candidateBId: cand1.id,
        orderSwapped: true,
        verdict: verdictBA,
      });

      // Record to ledger if available
      if (ctx.ledger) {
        await ctx.ledger.insertJudgment({
          id: randomUUID(),
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          kind: 'pairwise',
          candidateA: cand1.id,
          candidateB: cand2.id,
          orderSwapped: false,
          verdict: verdictAB as unknown as Record<string, unknown>,
        });
        await ctx.ledger.insertJudgment({
          id: randomUUID(),
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          kind: 'pairwise',
          candidateA: cand2.id,
          candidateB: cand1.id,
          orderSwapped: true,
          verdict: verdictBA as unknown as Record<string, unknown>,
        });
      }

      // Resolve swap consistency
      // In Call 1: 'A' means cand1, 'B' means cand2
      // In Call 2: 'A' means cand2, 'B' means cand1
      let winnerForPair: 'cand1' | 'cand2' | 'tie' = 'tie';

      if (verdictAB.winner === 'A' && verdictBA.winner === 'B') {
        winnerForPair = 'cand1';
      } else if (verdictAB.winner === 'B' && verdictBA.winner === 'A') {
        winnerForPair = 'cand2';
      } else {
        // Disagreement or tie
        winnerForPair = 'tie';
      }

      if (winnerForPair === 'cand1') {
        scoresMap.set(cand1.id, (scoresMap.get(cand1.id) || 0) + 2);
      } else if (winnerForPair === 'cand2') {
        scoresMap.set(cand2.id, (scoresMap.get(cand2.id) || 0) + 2);
      } else {
        scoresMap.set(cand1.id, (scoresMap.get(cand1.id) || 0) + 1);
        scoresMap.set(cand2.id, (scoresMap.get(cand2.id) || 0) + 1);
      }
    }
  }

  // Sort pool by tournament points, breaking ties with critique weightedScore
  pool.sort((a, b) => {
    const ptsA = scoresMap.get(a.id) || 0;
    const ptsB = scoresMap.get(b.id) || 0;
    if (ptsA !== ptsB) return ptsB - ptsA;
    return (b.score || 0) - (a.score || 0);
  });

  for (let rank = 0; rank < pool.length; rank++) {
    pool[rank].rank = rank + 1;
    if (rank === 0) {
      pool[rank].status = 'winner';
    } else if (rank === 1) {
      pool[rank].status = 'runner_up';
    } else {
      pool[rank].status = 'eliminated';
    }
  }

  return {
    winnerCandidate: pool[0],
    rankedCandidates: pool,
    pairwiseJudgments,
  };
}
