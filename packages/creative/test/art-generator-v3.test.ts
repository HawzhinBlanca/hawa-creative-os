import { describe, it, expect, vi } from 'vitest';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { PNG } from 'pngjs';
import {
  deriveConditionedArtPrompt,
  measureBoxLuminanceAndVariance,
  measureOuterLuminanceAndVariance,
  generateConditionedArtLayer,
} from '../src/studio/art-generator-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

describe('P04 — Art Layer Conditioned on Layout (gpt-image-2.5-sunburst & Calm Region)', () => {
  const layoutWithArt: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[0],
    art: {
      source: 'generated',
      prompt: 'Abstract architectural institutional line geometry',
      box: { x: 0, y: 0, width: 1080, height: 1080 },
      opacity: 0.3,
      scrim: {
        color: '#0A1628',
        opacityStart: 0.7,
        opacityEnd: 0.9,
        direction: 'vertical',
      },
      calmRegion: { x: 80, y: 150, width: 920, height: 850 },
    },
  };

  it('derives conditioned art prompt containing calm region, palette, and P7 suffix', () => {
    const prompt = deriveConditionedArtPrompt(layoutWithArt);
    expect(prompt).toContain('1:1 square');
    expect(prompt).toContain('#0C2340');
    expect(prompt).toContain('calmRegion' in layoutWithArt.art! ? 'calm, dark' : '');
    expect(prompt).toContain('No text of any kind');
    expect(prompt).toContain('no people, no faces');
  });

  it('measures luminance and variance accurately over synthetic calm and bright outer regions', () => {
    // Create a 100x100 synthetic test image: center 60x60 is dark navy, outer perimeter has bright gold accents
    const testPng = new PNG({ width: 100, height: 100 });
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const idx = (y * 100 + x) * 4;
        const inCenter = x >= 20 && x < 80 && y >= 20 && y < 80;
        if (inCenter) {
          // Dark Navy (#0A1628)
          testPng.data[idx] = 10;
          testPng.data[idx + 1] = 22;
          testPng.data[idx + 2] = 40;
          testPng.data[idx + 3] = 255;
        } else {
          // Outer perimeter with variance and bright accents (#C5A059)
          const isBright = (x + y) % 5 === 0;
          testPng.data[idx] = isBright ? 197 : 30;
          testPng.data[idx + 1] = isBright ? 160 : 54;
          testPng.data[idx + 2] = isBright ? 89 : 93;
          testPng.data[idx + 3] = 255;
        }
      }
    }

    const calmBox = { x: 20, y: 20, width: 60, height: 60 };
    const calmMeas = measureBoxLuminanceAndVariance(testPng, calmBox);
    const outerMeas = measureOuterLuminanceAndVariance(testPng, calmBox);

    expect(calmMeas.meanLuminance).toBeLessThan(outerMeas.meanLuminance);
    expect(calmMeas.variance).toBeLessThan(outerMeas.variance);
  });

  it('gates art generation on P01 deterministic metrics: blocks if P01 fails', async () => {
    const failingLayout: StudioLayoutV2 = {
      ...layoutWithArt,
      text: [
        // Low contrast failure: dark blue on dark navy
        { copyIndex: 0, role: 'title', x: 80, y: 200, width: 920, height: 120, fontSize: 42, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#1E3A5F', align: 'center', bold: true },
      ],
    };

    await expect(generateConditionedArtLayer(failingLayout)).rejects.toThrow(
      /P01 deterministic design metrics failed/
    );
  });

  it('refuses missing client logo before an image-provider call', async () => {
    const fetchFn = vi.fn();
    await expect(generateConditionedArtLayer(layoutWithArt, {
      openaiApiKey: 'test-key',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).rejects.toThrow(/CLIENT_LOGO_REQUIRED/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('degrades to procedural motif when image provider returns error', async () => {
    // Mock fetcher that fails HTTP 500
    const mockFailingFetch = (async () => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Provider Internal Error',
      } as any;
    }) as any;

    const result = await generateConditionedArtLayer(layoutWithArt, {
      openaiApiKey: 'test-key',
      fetchFn: mockFailingFetch,
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
    });

    expect(result.status).toBe('degraded_procedural_motif');
    expect(result.receipt.model).toBe('procedural-motif');
    expect(result.receipt.imageTokens).toBe(0);
    expect(result.compositeContrast.passed).toBe(true);
    expect(result.occlusionMetric.passed).toBe(true);
  });
});
