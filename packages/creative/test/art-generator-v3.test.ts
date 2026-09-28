import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
    expect(prompt).toContain('calm with low visual detail');
    expect(prompt).toContain('No text of any kind');
    expect(prompt).toContain('no people, no faces');
  });

  it('uses each client layout’s own art direction and colors in prompt and procedural fallback', async () => {
    const forColor = (background: string): StudioLayoutV2 => ({
      ...layoutWithArt,
      background: { color: background },
      shapes: [],
      text: layoutWithArt.text.map((block) => ({ ...block, color: '#FFFFFF', accentColor: undefined })),
      art: { ...layoutWithArt.art!, prompt: 'Soft organic botanical shapes', motif: 'thin-rules', scrim: { color: background, opacityStart: 0.7, opacityEnd: 0.9, direction: 'vertical' } },
    });
    const green = forColor('#123828');
    const purple = forColor('#30204A');
    const prompt = deriveConditionedArtPrompt(green);
    expect(prompt).toContain('Soft organic botanical shapes');
    expect(prompt).toContain('#123828');
    expect(prompt).not.toMatch(/academic|institutional|deep dark navy|#0A1628|#C5A059/i);

    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' })) as unknown as typeof fetch;
    const clientLogo = new PNG({ width: 8, height: 8 });
    clientLogo.data.fill(255);
    const logoDataUri = `data:image/png;base64,${PNG.sync.write(clientLogo).toString('base64')}`;
    const options = { openaiApiKey: 'test-key', fetchFn, renderOptions: { logoDataUri } };
    const greenResult = await generateConditionedArtLayer(green, options);
    const purpleResult = await generateConditionedArtLayer(purple, options);
    expect(greenResult.status).toBe('degraded_procedural_motif');
    expect(purpleResult.status).toBe('degraded_procedural_motif');
    expect(greenResult.artBuffer).not.toEqual(purpleResult.artBuffer);
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

  it('writes the art it hands the renderer only to a private temp directory, never into the checkout', async () => {
    // Ported from studio-v2 1a160953: the temp file went into output/proofs under the working
    // directory, which CI's "the suite left the tree clean" step refuses.
    const written: string[] = [];
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string') written.push(path.resolve(file));
      return (real as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      const result = await generateConditionedArtLayer(layoutWithArt, {
        openaiApiKey: 'test-key',
        fetchFn: (async () => ({ ok: false, status: 500, text: async () => 'Provider Internal Error' })) as unknown as typeof fetch,
        renderOptions: { logoDataUri: KAAE_TEST_LOGO },
      });
      expect(result.status).toBe('degraded_procedural_motif');
    } finally {
      spy.mockRestore();
    }
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) {
      expect(file.startsWith(path.resolve(process.cwd()) + path.sep), file).toBe(false);
      expect(fs.existsSync(file), `${file} was left behind`).toBe(false);
    }
  });
});
