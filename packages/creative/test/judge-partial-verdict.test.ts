import { describe, expect, it, vi } from 'vitest';
import { evaluatePairOrder, JUDGE_DIMENSIONS } from '../src/studio/pairwise-judge-v3.js';
import { clientReferencePart } from '../src/studio/client-reference.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const layout = (title: string): StudioLayoutV2 =>
  ({
    width: 1080,
    height: 1350,
    background: { color: '#0A1628' },
    grid: { columns: 12, rowHeight: 8 },
    text: [
      {
        id: 'title',
        role: 'title',
        copyIndex: 0,
        x: 90,
        y: 200,
        width: 900,
        height: 160,
        fontSize: 72,
        lineHeight: 1.2,
        fontFamily: 'Cinzel',
        color: '#FFFFFF',
        align: 'left',
        bold: true,
        script: 'latin',
        content: title,
      },
    ],
    shapes: [],
  }) as any;

/** A client that answers with exactly the payload a test hands it. */
const clientReturning = (data: any) =>
  ({
    createStructuredCompletion: vi.fn().mockResolvedValue({
      data,
      receipt: {
        model: 'test-judge',
        responseId: 'r1',
        xRequestId: null,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0001,
        latencyMs: 5,
      },
    }),
  }) as any;

const fullVerdict = (winner: 'A' | 'B') => ({
  dimensions: Object.fromEntries(
    JUDGE_DIMENSIONS.map((d) => [d, { winner, rationale: `${d} favours ${winner}` }])
  ),
  majorityWinner: winner,
  summary: 'ok',
});

/**
 * A dimension the reply does not contain is not a vote for B.
 *
 * `winner === 'A' ? 'A' : 'B'` treats undefined as B, so every missing dimension counted against
 * the candidate in position A — and a reply with no dimensions at all, which is exactly what
 * createStructuredCompletion returns for a truncated or unparseable response (an empty object),
 * became a confident unanimous 5-0. Nothing downstream could tell that verdict from a real one.
 */
describe('the judge refuses a verdict it was not given', () => {
  it('throws on an empty reply instead of returning a unanimous 5-0 for position B', async () => {
    const client = clientReturning({});
    await expect(
      evaluatePairOrder({ id: 'A', layout: layout('Alpha') }, { id: 'B', layout: layout('Beta') }, 'AB', {
        client,
        model: 'test-judge',
      })
    ).rejects.toThrow(/refused a pairwise verdict/i);
  });

  it('names every dimension it did not get an answer for', async () => {
    const partial = fullVerdict('A');
    delete (partial.dimensions as any).legibility;
    delete (partial.dimensions as any).brand_fit;
    await expect(
      evaluatePairOrder({ id: 'A', layout: layout('Alpha') }, { id: 'B', layout: layout('Beta') }, 'AB', {
        client: clientReturning(partial),
        model: 'test-judge',
      })
    ).rejects.toThrow(/brand_fit|legibility/);
  });

  it('rejects a winner value that is neither A nor B rather than reading it as B', async () => {
    const bad = fullVerdict('A');
    (bad.dimensions as any).composition = { winner: 'tie', rationale: 'too close' };
    await expect(
      evaluatePairOrder({ id: 'A', layout: layout('Alpha') }, { id: 'B', layout: layout('Beta') }, 'AB', {
        client: clientReturning(bad),
        model: 'test-judge',
      })
    ).rejects.toThrow(/composition/);
  });

  it('still returns a complete verdict unchanged', async () => {
    const res = await evaluatePairOrder(
      { id: 'A', layout: layout('Alpha') },
      { id: 'B', layout: layout('Beta') },
      'AB',
      { client: clientReturning(fullVerdict('A')), model: 'test-judge' }
    );
    expect(res.winnerVotesA).toBe(5);
    expect(res.winnerVotesB).toBe(0);
    expect(res.majorityWinner).toBe('A');
    expect(res.winnerCandidateId).toBe('A');
  });
});

describe('the client reference is attached at the detail the stage needs', () => {
  const reference = { dataUrl: 'data:image/png;base64,AAAA', notes: 'navy, centred' };

  it('defaults to high, for the stage that invents the composition', () => {
    expect(clientReferencePart(reference).image_url.detail).toBe('high');
  });

  it('can be attached low, and the judge does so', async () => {
    // The judge compares two candidate renders that are themselves attached at 'low', and says so
    // in its own prompt. The reference beside them was the only high-detail image in the studio.
    expect(clientReferencePart(reference, { detail: 'low' }).image_url.detail).toBe('low');

    const client = clientReturning(fullVerdict('A'));
    await evaluatePairOrder(
      { id: 'A', layout: layout('Alpha') },
      { id: 'B', layout: layout('Beta') },
      'AB',
      { client, model: 'test-judge', reference }
    );
    const parts = client.createStructuredCompletion.mock.calls[0][0].messages[1].content;
    const images = parts.filter((p: any) => p.type === 'image_url');
    expect(images).toHaveLength(3);
    expect(images.map((p: any) => p.image_url.detail)).toEqual(['low', 'low', 'low']);
  });
});
