import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect } from 'vitest';
import {
  renderAnnotatedLayoutV2,
  getLayoutBoxAnnotations,
} from '../src/studio/render-layout-v2.js';
import {
  filterCritiqueComments,
  generateBoxGroundedCritique,
  type CritiqueComment,
} from '../src/studio/box-critique-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

describe('P05 — Annotated Render and Box-Grounded Critique', () => {
  const baseLayout: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[0],
  };

  it('generates Set-of-Mark annotations and overlays numbered bounding boxes', () => {
    const annotations = getLayoutBoxAnnotations(baseLayout);
    expect(annotations.length).toBeGreaterThanOrEqual(5);

    const logoAnn = annotations.find((a) => a.role === 'logo');
    expect(logoAnn).toBeDefined();
    expect(logoAnn?.boxId).toBe('B0');

    const titleAnn = annotations.find((a) => a.role === 'title');
    expect(titleAnn).toBeDefined();
    expect(titleAnn?.boxId).toMatch(/^B\d+$/);

    const rendered = renderAnnotatedLayoutV2(baseLayout, { logoDataUri: KAAE_TEST_LOGO });
    expect(rendered.svg).toContain('id="set-of-marks-debug-overlay"');
    expect(rendered.svg).toContain('B0: logo');
    expect(rendered.png.length).toBeGreaterThan(1000);
    expect(rendered.annotations.length).toBe(annotations.length);
  });

  it('filters and rejects comments referencing colour, contrast, or copy wording', () => {
    const validBoxIds = new Set(['B0', 'B1', 'B2', 'B3']);

    const rawComments = [
      {
        boxId: 'B1',
        category: 'alignment',
        issue: 'Title is offset 40px to the left of the central column grid',
        severity: 'high',
        suggestedFix: 'Shift x from 68px to 108px to center on the 6-column grid',
      },
      {
        boxId: 'B2',
        category: 'placement',
        issue: 'Subtitle color should be brighter gold for better contrast',
        severity: 'medium',
        suggestedFix: 'Change hex code to #FDF8F3',
      },
      {
        boxId: 'B3',
        category: 'hierarchy',
        issue: 'Body copy wording should be rewritten to be more concise',
        severity: 'low',
        suggestedFix: 'Rewrite text phrasing in English',
      },
      {
        boxId: 'B99',
        category: 'whitespace',
        issue: 'Non-existent box whitespace issue',
        severity: 'low',
        suggestedFix: 'Fix unknown box',
      },
    ];

    const { accepted, rejected } = filterCritiqueComments(rawComments, validBoxIds);

    expect(accepted.length).toBe(1);
    expect(accepted[0].boxId).toBe('B1');
    expect(accepted[0].category).toBe('alignment');

    expect(rejected.length).toBe(3);
    expect(rejected[0].reason).toContain('color');
    expect(rejected[1].reason).toMatch(/copy|wording/);
    expect(rejected[2].reason).toContain("Invalid boxId 'B99'");
  });

  it('dispatches critique with facts first, detail low, and identifies misaligned box', async () => {
    // Deliberately misalign B1 (title) by pushing it to x: 10
    const misalignedLayout: StudioLayoutV2 = {
      ...baseLayout,
      text: baseLayout.text.map((t) =>
        t.role === 'title' ? { ...t, x: 10 } : t
      ),
    };

    let sentPayload: any = null;
    const mockFetcher = (async (_url: string, init: any) => {
      sentPayload = JSON.parse(init.body);
      const mockResult = {
        id: 'chatcmpl-test-critique-123',
        model: 'gpt-6-astra',
        usage: {
          prompt_tokens: 420,
          completion_tokens: 180,
          total_tokens: 600,
        },
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallAssessment:
                  'The title element is severely misaligned with the canvas margin and grid.',
                comments: [
                  {
                    boxId: 'B1',
                    category: 'alignment',
                    issue:
                      'Box B1 (title) sits at x: 10px, violating the 80px canvas margin and grid alignment.',
                    severity: 'high',
                    suggestedFix:
                      'Shift Box B1 rightward to align with the column margin at x: 80px.',
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
        headers: new Headers({ 'x-request-id': 'req-test-critique-456' }),
      } as any;
    }) as any;

    const critiqueResult = await generateBoxGroundedCritique(misalignedLayout, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
    });

    expect(critiqueResult.status).toBe('success');
    expect(critiqueResult.comments.length).toBe(1);
    expect(critiqueResult.comments[0].boxId).toBe('B1');
    expect(critiqueResult.comments[0].category).toBe('alignment');
    expect(critiqueResult.receipt.costUsd).toBeLessThan(0.1);

    // Verify visual prompting format in sent payload
    expect(sentPayload).toBeDefined();
    const userMsg = sentPayload.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();

    const textPart = userMsg.content.find((p: any) => p.type === 'text');
    expect(textPart.text).toContain('GROUND TRUTH DETERMINISTIC METRICS');
    expect(textPart.text).toContain('ELEMENT BOX CATALOG');
    expect(textPart.text).toContain('[B1]');

    const imagePart = userMsg.content.find((p: any) => p.type === 'image_url');
    expect(imagePart.image_url.detail).toBe('low');
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});
