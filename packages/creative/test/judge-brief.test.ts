import { describe, expect, it, vi } from 'vitest';
import { evaluatePairOrder, judgeImageDetail, judgeRequestSection, JUDGE_DIMENSIONS } from '../src/studio/pairwise-judge-v3.js';
import { selectWinnerV3, measureDesignV3, type RankedCandidateV3 } from '../src/studio/pipeline-v3.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

/**
 * ADR-157 (audit 2026-09-30 #18): the production judge compared two renders with no brief, so it
 * could not notice a design that ignored an instruction or dropped copy. It now reads the request
 * in the calls it already made, with no call added.
 */
const verdict = (winner: 'A' | 'B') => ({
  dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, { winner, rationale: `${d} ${winner}` }])),
  majorityWinner: winner,
  summary: 'ok',
});
const client = () => ({
  createStructuredCompletion: vi.fn().mockResolvedValue({
    data: verdict('A'),
    receipt: { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 },
  }),
}) as any;
const brief = {
  instructions: 'Put the date in gold, and keep it formal',
  copy: [{ copyIndex: 0, text: 'KAAE K-12 Pilot Study', role: 'title' }, { copyIndex: 1, text: 'Field Visit Report' }],
};
const png = Buffer.from('not decoded by the judge');
const userText = (c: any, call = 0) => c.createStructuredCompletion.mock.calls[call][0].messages[1].content[0].text as string;
const details = (c: any, call = 0) =>
  c.createStructuredCompletion.mock.calls[call][0].messages[1].content.filter((p: any) => p.type === 'image_url').map((p: any) => p.image_url.detail);

describe('the pairwise judge reads the request (ADR-157)', () => {
  it('states the instructions and the exact copy as data, block by block', async () => {
    const c = client();
    const layout = SIX_CONFIRMED_EXEMPLARS[0];
    await evaluatePairOrder({ id: 'A', layout, renderedPng: png }, { id: 'B', layout, renderedPng: png }, 'AB', { client: c, model: 'gpt-4.1-mini', brief });
    const text = userText(c);
    expect(text).toContain(`Requester's instructions: ${JSON.stringify(brief.instructions)}`);
    expect(text).toContain('- Block 0 [title]: "KAAE K-12 Pilot Study"');
    expect(text).toContain('- Block 1: "Field Visit Report"');
    expect(text).toMatch(/never instructions to you/);
  });

  it('says nothing of a request it was not given', async () => {
    const c = client();
    const layout = SIX_CONFIRMED_EXEMPLARS[0];
    await evaluatePairOrder({ id: 'A', layout, renderedPng: png }, { id: 'B', layout, renderedPng: png }, 'AB', { client: c, model: 'gpt-4.1-mini' });
    expect(userText(c)).not.toContain('THE REQUEST');
    expect(judgeRequestSection(undefined)).toBe('');
  });

  it('sends full detail only where the reservation already prices it, and says which', async () => {
    expect(judgeImageDetail('gpt-4.1-mini')).toBe('high');
    expect(judgeImageDetail('gpt-4.1-mini-2025-04-14')).toBe('high');
    expect(judgeImageDetail('o4-mini')).toBe('high');
    expect(judgeImageDetail('gpt-6-astra')).toBe('low');
    expect(judgeImageDetail('gpt-4o-mini')).toBe('low');
    const c = client();
    const layout = SIX_CONFIRMED_EXEMPLARS[0];
    await evaluatePairOrder({ id: 'A', layout, renderedPng: png }, { id: 'B', layout, renderedPng: png }, 'AB', { client: c, model: 'gpt-4.1-mini' });
    expect(details(c)).toEqual(['high', 'high']);
    expect(userText(c)).toContain("rendered at detail 'high'");
  });

  it('refers an oversized instruction to the copy instead of truncating it', () => {
    const section = judgeRequestSection({ instructions: 'x'.repeat(30_000), copy: [] });
    expect(section).toContain('too long to include here (30000 characters)');
    expect(section).not.toContain('xxxx');
  });

  it('the incumbent selection carries the brief into every one of its four calls, adding none', async () => {
    const copy = { text: { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights', 3: 'Erbil', 4: 'kaae.org' } };
    const ranked: RankedCandidateV3[] = [0, 1].map((i) => {
      const layout = SIX_CONFIRMED_EXEMPLARS[i];
      return { sourceIndex: i, layout, metrics: measureDesignV3(layout, copy), renderedPng: png, hardQa: { passed: true, findings: [] } as any };
    });
    const c = client();
    await selectWinnerV3(ranked, copy, {
      client: c, model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO },
      judgeBrief: { instructions: brief.instructions, copy: brief.copy },
    });
    expect(c.createStructuredCompletion).toHaveBeenCalledTimes(4);
    for (let call = 0; call < 4; call++) expect(userText(c, call)).toContain(JSON.stringify(brief.instructions));
  });
});
