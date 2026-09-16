import { describe, it, expect } from 'vitest';
import {
  createDegradedCanaryLayout,
  comparePairWithOrderSwap,
  runTournamentWithCanary,
  type CandidateJudgeInput,
} from '../src/studio/pairwise-judge-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

describe('P07 — Pairwise Dimension-Wise Judge & Order Swapping', () => {
  const layoutA: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[0],
  };

  const layoutB: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[1],
    text: SIX_CONFIRMED_EXEMPLARS[1].text.map((t) =>
      t.fontFamily === 'Lora' ? { ...t, fontFamily: 'Playfair Display' } : t
    ),
  };

  it('skips judge calls entirely when only one candidate survives P01 (0 calls)', async () => {
    const passingCandidate: CandidateJudgeInput = {
      id: 'cand-pass',
      layout: layoutA,
    };
    const failingCandidate: CandidateJudgeInput = {
      id: 'cand-fail',
      layout: {
        ...layoutA,
        text: layoutA.text.map((t) =>
          t.role === 'title' ? { ...t, color: '#0C2340' } : t // Low contrast failure
        ),
      },
    };

    let fetchCalls = 0;
    const mockFetcher = (async () => {
      fetchCalls++;
      throw new Error('Should not make judge call when only 1 candidate survives');
    }) as any;

    const result = await runTournamentWithCanary([passingCandidate, failingCandidate], {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
    });

    expect(result.skippedDueToSingleSurvivor).toBe(true);
    expect(result.callsMade).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.winnerId).toBe('cand-pass');
    expect(fetchCalls).toBe(0);
  });

  it('records order-swap disagreement as a tie and discards the pair if orderings disagree', async () => {
    const cand1: CandidateJudgeInput = { id: 'C1', layout: layoutA };
    const cand2: CandidateJudgeInput = { id: 'C2', layout: layoutB };

    // Mock fetcher that exhibits position bias (always votes for candidate A regardless of content)
    let call = 0;
    const mockFetcher = (async (_url: string, _init: any) => {
      call++;
      // Always votes for 'A'
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `eval-${call}`,
          model: 'gpt-6-astra',
          usage: { prompt_tokens: 500, completion_tokens: 150 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  dimensions: {
                    hierarchy: { winner: 'A', rationale: 'First candidate had better hierarchy' },
                    composition: { winner: 'A', rationale: 'First candidate had better composition' },
                    typographic_craft: { winner: 'A', rationale: 'First candidate had better craft' },
                    brand_fit: { winner: 'B', rationale: 'Second had better brand' },
                    legibility: { winner: 'A', rationale: 'First had better legibility' },
                  },
                  majorityWinner: 'A',
                  summary: 'Candidate A is superior across 4 of 5 dimensions.',
                }),
              },
            },
          ],
        }),
        headers: new Headers({ 'x-request-id': `req-${call}` }),
      } as any;
    }) as any;

    // In order AB: C1 is A, C2 is B -> C1 wins
    // In order BA: C2 is A, C1 is B -> C2 wins (flip!)
    const match = await comparePairWithOrderSwap(cand1, cand2, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
    });

    expect(match.isConsistent).toBe(false);
    expect(match.disagreementRecorded).toBe(true);
    expect(match.winnerId).toBe('TIE_DISCARDED');
    expect(match.reason).toContain('Order-swap flip detected');
  });

  it('degraded copy canary loses against the good candidate in all 5 dimensions', async () => {
    const canaryLayout = createDegradedCanaryLayout(layoutA);

    // Verify canary layout was degraded
    const bodyText = canaryLayout.text.find((t) => t.role === 'body');
    const origBody = layoutA.text.find((t) => t.role === 'body');
    expect(bodyText?.fontSize).toBeLessThan(origBody!.fontSize);

    const goodCand: CandidateJudgeInput = { id: 'good', layout: layoutA };
    const canaryCand: CandidateJudgeInput = { id: 'canary', layout: canaryLayout };

    // Mock fetcher where good candidate wins all 5 dimensions in both orderings
    let call = 0;
    const mockFetcher = (async (_url: string, init: any) => {
      call++;
      const payload = JSON.parse(init.body);
      const textMsg = payload.messages[1].content[0].text;
      const isGoodFirst = textMsg.includes('CANDIDATE A:\n- Composite Score: 0.9'); // good candidate is A

      const goodWinnerLetter = isGoodFirst ? 'A' : 'B';
      const badWinnerLetter = isGoodFirst ? 'B' : 'A';

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `canary-eval-${call}`,
          model: 'gpt-6-astra',
          usage: { prompt_tokens: 500, completion_tokens: 150 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  dimensions: {
                    hierarchy: { winner: goodWinnerLetter, rationale: 'Clear hierarchy' },
                    composition: { winner: goodWinnerLetter, rationale: 'Standard grid' },
                    typographic_craft: { winner: goodWinnerLetter, rationale: 'Proper sizing' },
                    brand_fit: { winner: goodWinnerLetter, rationale: 'Institutional dignity' },
                    legibility: { winner: goodWinnerLetter, rationale: 'High legibility' },
                  },
                  majorityWinner: goodWinnerLetter,
                  summary: 'The well-structured candidate outperforms the degraded version.',
                }),
              },
            },
          ],
        }),
        headers: new Headers({ 'x-request-id': `req-canary-${call}` }),
      } as any;
    }) as any;

    const match = await comparePairWithOrderSwap(goodCand, canaryCand, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
    });

    expect(match.isConsistent).toBe(true);
    expect(match.winnerId).toBe('good');
    expect(match.orderAB.majorityWinner).toBe('A');
    expect(match.orderBA.majorityWinner).toBe('B'); // since cand2 (canary) was A and cand1 (good) was B
  });
});
