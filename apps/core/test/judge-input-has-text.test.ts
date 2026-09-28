import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OpenAiStudioClient, type StudioLayoutV2 } from '@hawa/creative';
import type { StageContext, CandidateState } from '../src/services/design-studio/types.js';
import { runJudgeStageV3, assertJudgeSeesText } from '../src/services/design-studio/stages/v3.stage.js';

/**
 * P07 judged designs it could not read. The render stage keeps two images per candidate: the full
 * preview, and a no-text composite it renders only so contrast can be measured against the real
 * backdrop (render.stage.ts sets compositePng from renderResult.noTextPng). The v3 judge stage
 * handed the judge the no-text one, so every vote on hierarchy, typographic craft and legibility
 * was cast on an image with no words on it. These tests pin the bytes that leave the stage.
 */

const KAAE_PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500', '#FDF8F3', '#FFFFFF'];

const JUDGE_DIMENSIONS = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];

function createMockLayout(width = 1080, height = 1350): StudioLayoutV2 {
  const margin = Math.round(width * 0.08);
  return {
    version: 2,
    width,
    height,
    grid: { margin, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [
      {
        x: margin,
        y: 245,
        width: width - 2 * margin,
        height: 2,
        kind: 'rect',
        color: '#F7B500',
        role: 'rule',
      },
    ],
    text: [
      {
        x: margin,
        y: 260,
        width: width - 2 * margin,
        height: 35,
        copyIndex: 0,
        role: 'eyebrow',
        fontSize: 16,
        lineHeight: 1.3,
        fontFamily: 'Verdana',
        color: '#D4E2F0',
        align: 'center',
      },
      {
        x: margin,
        y: 310,
        width: width - 2 * margin,
        height: 120,
        copyIndex: 1,
        role: 'title',
        fontSize: 48,
        lineHeight: 1.2,
        fontFamily: 'Verdana',
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      },
      {
        x: margin,
        y: 470,
        width: width - 2 * margin,
        height: 50,
        copyIndex: 2,
        role: 'subtitle',
        fontSize: 24,
        lineHeight: 1.3,
        fontFamily: 'Verdana',
        color: '#D4E2F0',
        align: 'center',
      },
    ],
    logo: { x: Math.round(width / 2 - 50), y: margin, width: 100, height: 100 },
  } as StudioLayoutV2;
}

/**
 * The judge asks in both orders, then runs its canary in both orders, so four calls. Voting 'A',
 * 'B', 'A', 'B' is one candidate winning consistently in each pair, which is what the stage needs
 * to reach a verdict at all.
 */
function judgeReply(winner: 'A' | 'B') {
  const dimensions: Record<string, { winner: string; rationale: string }> = {};
  for (const dim of JUDGE_DIMENSIONS) {
    dimensions[dim] = { winner, rationale: `Candidate ${winner} is stronger on ${dim}` };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: `resp_judge_${winner}`,
      model: 'gpt-4.1-mini',
      usage: { prompt_tokens: 1200, completion_tokens: 200 },
      choices: [
        {
          message: {
            content: JSON.stringify({ dimensions, majorityWinner: winner, summary: 'Verdict' }),
          },
        },
      ],
    }),
  };
}

/** A fake client that answers every judge call and keeps every image it was shown. */
function createRecordingClient(): { client: OpenAiStudioClient; fetcher: any; imagesSeen: string[] } {
  const imagesSeen: string[] = [];
  let call = 0;
  const fetcher = vi.fn(async (_url: string, init: any) => {
    const payload = JSON.parse(init.body);
    for (const message of payload.messages || []) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type === 'image_url' && part.image_url?.url) imagesSeen.push(part.image_url.url);
      }
    }
    return judgeReply(call++ % 2 === 0 ? 'A' : 'B') as any;
  });
  return { client: new OpenAiStudioClient({ apiKey: 'mock-key', fetcher: fetcher as any }), fetcher, imagesSeen };
}

function createMockContext(client: OpenAiStudioClient): StageContext {
  return {
    runId: randomUUID(),
    tenantId: randomUUID(),
    taskId: randomUUID(),
    clientId: randomUUID(),
    actorId: 'test_operator',
    width: 1080,
    height: 1350,
    tier: 'premium',
    instructions: 'Design an elegant gala invitation',
    copyBlocks: [
      { text: 'KAAE ANNUAL GALA', script: 'latin' },
      { text: 'Celebrating 10 Years of Innovation', script: 'latin' },
      { text: 'Thursday, 25 October 2026', script: 'latin' },
    ],
    referencePack: {
      palette: KAAE_PALETTE,
      referenceFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' },
    },
    promotedRules: 'Keep title clear and centered.',
    latinFont: 'Verdana',
    arabicFont: 'Noto Sans Arabic',
    logoAspect: 1.0,
    logo: KAAE_TEST_CLIENT_LOGO,
    client,
  } as unknown as StageContext;
}

function createCandidate(
  ordinal: number,
  renders: { previewPng?: Buffer; compositePng?: Buffer }
): CandidateState {
  const layout = createMockLayout();
  return {
    id: `candidate-${ordinal}`,
    ordinal,
    concept: {} as any,
    layouts: [layout],
    currentLayout: layout,
    critiques: [],
    status: 'active',
    ...renders,
  };
}

// Sentinel bytes rather than real PNGs: nothing between the stage and the request body decodes the
// image, so the base64 in the payload is an exact fingerprint of the buffer that was handed over.
const previewBytes = (ordinal: number) => Buffer.from(`FULL-RENDER-WITH-COPY-candidate-${ordinal}`);
const noTextBytes = (ordinal: number) => Buffer.from(`NO-TEXT-CONTRAST-COMPOSITE-candidate-${ordinal}`);

describe('P07 judges the render that carries the copy', () => {
  it('shows the judge the preview render, never the no-text composite', async () => {
    const { client, imagesSeen } = createRecordingClient();
    const ctx = createMockContext(client);
    const candidates = [0, 1].map((ordinal) =>
      createCandidate(ordinal, { previewPng: previewBytes(ordinal), compositePng: noTextBytes(ordinal) })
    );

    await runJudgeStageV3(ctx, candidates);

    const sent = imagesSeen.join('\n');
    for (const ordinal of [0, 1]) {
      expect(sent).toContain(previewBytes(ordinal).toString('base64'));
      expect(sent).not.toContain(noTextBytes(ordinal).toString('base64'));
    }
  }, 30000);

  // A candidate that holds only its no-text composite hands the judge nothing, so the pipeline
  // re-renders it from its layout with the copy. Passing the composite instead would have cost the
  // run its judge to the guard, which is why the guard is a safety net and not the mechanism.
  it('never hands over the no-text composite, and judges from the layout instead', async () => {
    const { client, fetcher } = createRecordingClient();
    const ctx = createMockContext(client);
    const candidates = [0, 1].map((ordinal) => createCandidate(ordinal, { compositePng: noTextBytes(ordinal) }));

    const outcome = await runJudgeStageV3(ctx, candidates);

    expect(outcome.winner).toBeDefined();
    expect(fetcher).toHaveBeenCalled();
    const sent = fetcher.mock.calls.map(([, init]: any[]) => String(init?.body || '')).join('');
    for (const ordinal of [0, 1]) expect(sent).not.toContain(noTextBytes(ordinal).toString('base64'));
  }, 30000);

  it('refuses to judge if a no-text composite is ever handed over directly', () => {
    const candidate = createCandidate(0, { compositePng: noTextBytes(0) });
    expect(() => assertJudgeSeesText([{ renderedPng: candidate.compositePng ?? undefined, candidate }])).toThrow(/no-text composite/i);
  });

  it('still judges a candidate that carries no render at all, from its layout', async () => {
    const { client, fetcher } = createRecordingClient();
    const ctx = createMockContext(client);
    const candidates = [0, 1].map((ordinal) => createCandidate(ordinal, {}));

    const outcome = await runJudgeStageV3(ctx, candidates);

    expect(outcome.winner).toBeDefined();
    expect(fetcher).toHaveBeenCalled();
  }, 30000);
});
