import { describe, it, expect } from 'vitest';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import {
  OpenAiStudioClient,
  ExemplarRetrievalIndex,
  createDegradedCanaryLayout,
  generateBoxGroundedCritique,
  comparePairWithOrderSwap,
  evaluatePairOrder,
  type CandidateJudgeInput,
  type StudioLayoutV2,
} from '../src/index.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

describe('T5 Full Pipeline Qualification Path', () => {
  const baseLayout: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[0],
  };

  it('runs complete multi-stage pipeline: retrieval, critique, order-swapped judge, and canary defeat', async () => {
    // 1. Retrieval
    const retrievalIndex = new ExemplarRetrievalIndex();
    const retrieval = retrievalIndex.retrieveTopExemplars(
      { text: 'KAAE Accreditation Standards', format: '1:1', category: 'standards' },
      3
    );
    expect(retrieval.retrievedExemplars.length).toBe(3);

    // 2. Setup mock fetcher that simulates responses for critique, judge AB, judge BA, and canary
    let callCount = 0;

    const mockFetcher = (async (url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      const isJudge = body.messages.some((m: any) =>
        typeof m.content === 'string' && m.content.includes('blind pairwise design comparison')
      );
      // The critique is recognised by the report it asks for, not its prompt's wording, which names
      // no client and changed when KAAE's persona left shared code (ADR-127, studio-v2 f6d6ed1b).
      const isCritique = body.response_format?.json_schema?.name === 'DesignCritiqueReport';

      if (isCritique) {
        const mockResult = {
          id: `chatcmpl-critique-${callCount}`,
          model: 'gpt-6-astra',
          usage: { prompt_tokens: 1200, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 600 } },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overallAssessment: 'Strong institutional hierarchy and spatial composure.',
                  comments: [
                    {
                      boxId: 'B1',
                      category: 'hierarchy',
                      issue: 'Subtitle is proportional and well-spaced.',
                      severity: 'low',
                      suggestedFix: 'Retain current grid alignment.',
                    },
                  ],
                }),
              },
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          json: async () => mockResult,
          headers: new Headers({ 'x-request-id': `req-critique-${callCount}` }),
        } as any;
      }

      if (isJudge) {
        // Call 2 is AB (winner is A: cand1), Call 3 is BA (winner is B: cand1), Call 4 is Canary (winner is A: cand1)
        const winnerLetter = callCount === 3 ? 'B' : 'A';

        const mockResult = {
          id: `chatcmpl-judge-${callCount}`,
          model: 'gpt-6-astra',
          usage: { prompt_tokens: 1600, completion_tokens: 220, prompt_tokens_details: { cached_tokens: 800 } },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  dimensions: {
                    hierarchy: { winner: winnerLetter, rationale: 'Clear visual dominance' },
                    composition: { winner: winnerLetter, rationale: 'Stable margin balance' },
                    typographic_craft: { winner: winnerLetter, rationale: 'Appropriate scale' },
                    brand_fit: { winner: winnerLetter, rationale: 'Institutional elegance' },
                    legibility: { winner: winnerLetter, rationale: 'High contrast' },
                  },
                  majorityWinner: winnerLetter,
                  summary: 'Candidate demonstrates superior typographic craft and balance.',
                }),
              },
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          json: async () => mockResult,
          headers: new Headers({ 'x-request-id': `req-judge-${callCount}` }),
        } as any;
      }

      throw new Error(`Unexpected request in test mock: ${init.body}`);
    }) as any;

    const client = new OpenAiStudioClient({
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    // 3. Vision Critique Stage (P05)
    const critique = await generateBoxGroundedCritique(baseLayout, {
      client,
      model: 'gpt-6-astra',
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
    });
    expect(critique.status).toBe('success');
    expect(critique.comments.length).toBe(1);
    expect(critique.receipt.responseId).toBe('chatcmpl-critique-1');
    expect(critique.receipt.cachedTokens).toBe(600);
    expect(critique.receipt.costUsd).toBeGreaterThan(0);

    // 4. Pairwise Judge Stage with Order Swap (P07)
    const secondLayout: StudioLayoutV2 = {
      ...baseLayout,
      grid: { ...baseLayout.grid, margin: 80 },
    };
    const cand1: CandidateJudgeInput = { id: 'cand_lead', layout: baseLayout };
    const cand2: CandidateJudgeInput = { id: 'cand_second', layout: secondLayout };

    const match = await comparePairWithOrderSwap(cand1, cand2, {
      client,
      model: 'gpt-6-astra',
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
    });
    expect(match.isConsistent).toBe(true);
    expect(match.winnerId).toBe('cand_lead');
    expect(match.orderAB.receipt.responseId).toBe('chatcmpl-judge-2');
    expect(match.orderBA.receipt.responseId).toBe('chatcmpl-judge-3');
    expect(match.orderAB.receipt.cachedTokens).toBe(800);

    // 5. Degraded Canary Stage (P07)
    const canaryLayout = createDegradedCanaryLayout(baseLayout);
    const canaryCand: CandidateJudgeInput = { id: 'cand_canary', layout: canaryLayout };

    const canaryMatch = await evaluatePairOrder(cand1, canaryCand, 'AB', {
      client,
      model: 'gpt-6-astra',
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
    });
    expect(canaryMatch.majorityWinner).toBe('A');
    expect(canaryMatch.winnerCandidateId).toBe('cand_lead');
    expect(canaryMatch.receipt.responseId).toBe('chatcmpl-judge-4');

    // 6. Verify Multi-Row Ledger accounting
    const ledgerRows = [
      {
        call_id: critique.receipt.responseId,
        x_request_id: critique.receipt.xRequestId || '',
        stage: 'P05_CRITIQUE',
        brief_id: 'test_brief',
        model: critique.receipt.model,
        input_tokens: critique.receipt.inputTokens,
        cached_tokens: critique.receipt.cachedTokens ?? 0,
        output_tokens: critique.receipt.outputTokens,
      },
      {
        call_id: match.orderAB.receipt.responseId,
        x_request_id: match.orderAB.receipt.xRequestId || '',
        stage: 'P07_JUDGE_AB',
        brief_id: 'test_brief',
        model: match.orderAB.receipt.model,
        input_tokens: match.orderAB.receipt.inputTokens,
        cached_tokens: match.orderAB.receipt.cachedTokens ?? 0,
        output_tokens: match.orderAB.receipt.outputTokens,
      },
      {
        call_id: match.orderBA.receipt.responseId,
        x_request_id: match.orderBA.receipt.xRequestId || '',
        stage: 'P07_JUDGE_BA',
        brief_id: 'test_brief',
        model: match.orderBA.receipt.model,
        input_tokens: match.orderBA.receipt.inputTokens,
        cached_tokens: match.orderBA.receipt.cachedTokens ?? 0,
        output_tokens: match.orderBA.receipt.outputTokens,
      },
      {
        call_id: canaryMatch.receipt.responseId,
        x_request_id: canaryMatch.receipt.xRequestId || '',
        stage: 'P07_CANARY',
        brief_id: 'test_brief',
        model: canaryMatch.receipt.model,
        input_tokens: canaryMatch.receipt.inputTokens,
        cached_tokens: canaryMatch.receipt.cachedTokens ?? 0,
        output_tokens: canaryMatch.receipt.outputTokens,
      },
    ];

    expect(ledgerRows.length).toBe(4);
    expect(ledgerRows.map((r) => r.stage)).toEqual([
      'P05_CRITIQUE',
      'P07_JUDGE_AB',
      'P07_JUDGE_BA',
      'P07_CANARY',
    ]);
  }, 60000);
});
