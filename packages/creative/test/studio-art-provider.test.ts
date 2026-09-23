import { describe, it, expect, vi } from 'vitest';
import { PNG } from 'pngjs';
import {
  hexToRgb,
  rgbToHex,
  rgbToLab,
  ciede2000,
  extractDominantColors,
  verifyPaletteCompliance,
} from '../src/studio/color-science.js';
import {
  composeArtPrompt,
  mapDimensionsToAspect,
  runVisionCheck,
  generateArtImage,
} from '../src/studio/gemini-image-provider.js';
import type { Hex } from '../src/studio/layout-v2.js';

function createSolidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function createStripedPng(
  width: number,
  height: number,
  colors: Array<[number, number, number]>
): Buffer {
  const png = new PNG({ width, height });
  const bandHeight = Math.ceil(height / colors.length);
  for (let y = 0; y < height; y++) {
    const colorIdx = Math.min(colors.length - 1, Math.floor(y / bandHeight));
    const [r, g, b] = colors[colorIdx];
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('Design Studio v2: Color Science & CIEDE2000 (color-science.ts)', () => {
  const BRAND_PALETTE: Hex[] = [
    '#0A1628', // Midnight Navy
    '#1E3A5F', // Royal Navy
    '#4770A3', // KAAE Primary Blue
    '#D4E2F0', // Sky Ice Blue
    '#F7B500', // Kurdistan Sun Gold
    '#FDF8F3', // Academic Cream
    '#FFFFFF', // Pure White
  ];

  it('converts hex to RGB and back with roundtrip fidelity', () => {
    for (const hex of BRAND_PALETTE) {
      const rgb = hexToRgb(hex);
      const back = rgbToHex(rgb[0], rgb[1], rgb[2]);
      expect(back.toUpperCase()).toBe(hex.toUpperCase());
    }
  });

  it('converts sRGB to CIE L*a*b* accurately under D65', () => {
    const whiteLab = rgbToLab([255, 255, 255]);
    expect(whiteLab.L).toBeCloseTo(100.0, 1);
    expect(whiteLab.chroma).toBeLessThan(0.01);

    const blackLab = rgbToLab([0, 0, 0]);
    expect(blackLab.L).toBeCloseTo(0.0, 1);
    expect(blackLab.chroma).toBeCloseTo(0.0, 1);

    const goldLab = rgbToLab(hexToRgb('#F7B500'));
    expect(goldLab.L).toBeGreaterThan(70);
    expect(goldLab.chroma).toBeGreaterThan(75); // Vivid chroma
  });

  it('computes CIEDE2000 color difference matching Sharma et al. (2005) published benchmark values', () => {
    // Identical colors -> 0
    const zeroDe = ciede2000({ L: 50, a: 2.5, b: 0, chroma: 2.5 }, { L: 50, a: 2.5, b: 0, chroma: 2.5 });
    expect(zeroDe).toBe(0);

    // Sharma 2005 dataset Pair 1:
    // Lab1 = [50.0000, 2.6772, -79.7751], Lab2 = [50.0000, 0.0000, -82.7485] -> dE = 2.0425
    const pair1_1 = { L: 50.0, a: 2.6772, b: -79.7751, chroma: Math.sqrt(2.6772 ** 2 + (-79.7751) ** 2) };
    const pair1_2 = { L: 50.0, a: 0.0, b: -82.7485, chroma: 82.7485 };
    const dePair1 = ciede2000(pair1_1, pair1_2);
    expect(dePair1).toBeCloseTo(2.0425, 3);

    // Sharma 2005 dataset Pair 2:
    // Lab1 = [50.0000, 3.1571, -77.5521], Lab2 = [50.0000, 0.0000, -82.7485] -> dE = 2.7998
    const pair2_1 = { L: 50.0, a: 3.1571, b: -77.5521, chroma: Math.sqrt(3.1571 ** 2 + (-77.5521) ** 2) };
    const dePair2 = ciede2000(pair2_1, pair1_2);
    expect(dePair2).toBeCloseTo(2.7998, 3);
  });

  it('extracts dominant colors and verifies palette compliance on solid brand image', () => {
    // Create a 64x64 solid image in KAAE Primary Blue (#4770A3 = [71, 112, 163])
    const bluePng = createSolidPng(64, 64, [71, 112, 163]);
    const report = verifyPaletteCompliance(bluePng, 'image/png', BRAND_PALETTE);

    expect(report.passed).toBe(true);
    expect(report.dominantColors.length).toBeGreaterThanOrEqual(1);
    const top = report.dominantColors[0];
    expect(top.nearestPaletteColor).toBe('#4770A3');
    expect(top.minDeltaE).toBeLessThan(2.0); // essentially identical
  });

  it('treats soft neutrals (chroma < 8) as compliant regardless of distance to brand hue', () => {
    // Gray [120, 120, 120] has chroma 0
    const grayPng = createSolidPng(64, 64, [120, 120, 120]);
    const report = verifyPaletteCompliance(grayPng, 'image/png', BRAND_PALETTE);

    expect(report.passed).toBe(true);
    expect(report.dominantColors[0].isNeutral).toBe(true);
    expect(report.dominantColors[0].chroma).toBeLessThan(8.0);
  });

  it('fails an image dominated by out-of-palette chromatic colors (e.g. bright magenta)', () => {
    // Magenta [255, 0, 255] is high chroma (~115) and far from navy/blue/gold/cream
    const magentaPng = createSolidPng(64, 64, [255, 0, 255]);
    const report = verifyPaletteCompliance(magentaPng, 'image/png', BRAND_PALETTE);

    expect(report.passed).toBe(false);
    expect(report.dominantColors[0].passed).toBe(false);
    expect(report.dominantColors[0].minDeltaE).toBeGreaterThan(25.0);
    expect(report.dominantColors[0].isNeutral).toBe(false);
  });
});

describe('Design Studio v2: Gemini Image Provider & Vision Verification (gemini-image-provider.ts)', () => {
  const PALETTE: Hex[] = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500'];

  it('composes art prompt adhering to Section 5.4 / P7 specification', () => {
    const concept = 'Dramatic Kurdish mountain ridges at dawn with layered mist';
    const composed = composeArtPrompt(concept, {
      palette: PALETTE,
      calmRegion: 'bottom third',
      aspect: '4:5',
    });

    expect(composed).toContain(concept);
    expect(composed).toContain('Photographic or painterly still image, no text of any kind');
    expect(composed).toContain('no people, faces or hands');
    expect(composed).toContain('Palette limited to #0A1628, #1E3A5F, #4770A3, #D4E2F0, #F7B500 with soft neutrals');
    expect(composed).toContain('Keep the region bottom third calm, dark and low-detail');
    expect(composed).toContain('Aspect 4:5');
  });

  it('maps pixel dimensions to nearest supported Gemini aspect ratio', () => {
    expect(mapDimensionsToAspect(1080, 1350)).toBe('4:5');
    expect(mapDimensionsToAspect(1080, 1080)).toBe('1:1');
    expect(mapDimensionsToAspect(1920, 1080)).toBe('16:9');
    expect(mapDimensionsToAspect(1080, 1920)).toBe('9:16');
  });

  it('runs gpt-6-astra vision check and detects forbidden content', async () => {
    const fakeFetcher: typeof fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ containsForbidden: true, what: 'Found English lettering in top right' }),
            },
          },
        ],
      }),
    } as any);

    const dummyPng = createSolidPng(32, 32, [10, 22, 40]);
    const result = await runVisionCheck(dummyPng, 'image/png', {
      openaiApiKey: 'mock-key',
      fetchFn: fakeFetcher,
    });

    expect(result.passed).toBe(false);
    expect(result.containsForbidden).toBe(true);
    expect(result.what).toContain('English lettering');
  });

  it('rejects disallowed models or legacy keys for vision check', async () => {
    const dummyPng = createSolidPng(32, 32, [10, 22, 40]);
    await expect(
      runVisionCheck(dummyPng, 'image/png', {
        anthropicApiKey: 'mock-key',
      })
    ).rejects.toThrow(/DisallowedProviderError|strict OpenAI-only policy/);
  });

  it('successfully generates art with OpenAI gpt-image-2.5-sunburst and passes both checks on attempt 1', async () => {
    const validPng = createSolidPng(64, 64, [30, 58, 95]); // Royal Navy #1E3A5F
    const validBase64 = validPng.toString('base64');

    const fakeFetcher: typeof fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('api.openai.com/v1/images/generations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            created: 123456789,
            data: [{ b64_json: validBase64 }],
          }),
        } as any;
      }
      if (urlStr.includes('api.openai.com/v1/chat/completions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ containsForbidden: false, what: 'clean landscape' }),
                },
              },
            ],
          }),
        } as any;
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const result = await generateArtImage({
      artPrompt: 'Minimalist navy gradient textured backdrop',
      palette: PALETTE,
      openaiApiKey: 'mock-key',
      fetchFn: fakeFetcher,
    });

    expect(result.receipt.provider).toBe('openai');
    expect(result.receipt.model).toBe('gpt-image-2.5-sunburst');
    // OpenAI images carry no SynthID watermark; with no usage reported, the cost is the operator's estimate.
    expect(result.receipt.synthId).toBe(false);
    expect(result.receipt.costUsd).toBe(0.04);
    expect(result.receipt.costSource).toBe('estimate');
    expect(result.receipt.attempts).toBe(1);
    expect(result.receipt.verificationReport?.passed).toBe(true);
    expect(result.receipt.verificationReport?.visionCheckPassed).toBe(true);
    expect(result.receipt.verificationReport?.dominantColorsPassed).toBe(true);
  });

  it('rejects Anthropic for art generation', async () => {
    await expect(
      generateArtImage({
        artPrompt: 'Minimalist backdrop',
        palette: PALETTE,
        anthropicApiKey: 'mock-key',
      })
    ).rejects.toThrow(/DisallowedProviderError|strict OpenAI-only policy/);
  });

  it('retries when attempt 1 fails vision check, succeeding on attempt 2', async () => {
    const validPng = createSolidPng(64, 64, [30, 58, 95]);
    const validBase64 = validPng.toString('base64');

    let chatCalls = 0;
    const fakeFetcher: typeof fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('api.openai.com/v1/images/generations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            created: 123456789,
            data: [{ b64_json: validBase64 }],
          }),
        } as any;
      }
      if (urlStr.includes('api.openai.com/v1/chat/completions')) {
        chatCalls++;
        if (chatCalls === 1) {
          // Attempt 1 fails vision
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ containsForbidden: true, what: 'lettering watermark' }),
                  },
                },
              ],
            }),
          } as any;
        }
        // Attempt 2 passes vision
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ containsForbidden: false, what: 'clean' }),
                },
              },
            ],
          }),
        } as any;
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const result = await generateArtImage({
      artPrompt: 'Minimalist navy gradient textured backdrop',
      palette: PALETTE,
      openaiApiKey: 'mock-key',
      fetchFn: fakeFetcher,
    });

    expect(result.receipt.provider).toBe('openai');
    expect(result.receipt.attempts).toBe(2);
    expect(result.receipt.verificationReport?.passed).toBe(true);
  });

  it('falls back to procedural motif when image provider attempts are exhausted', async () => {
    const fakeFetcher: typeof fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as any);

    const result = await generateArtImage({
      artPrompt: 'Minimalist backdrop',
      palette: PALETTE,
      width: 1080,
      height: 1350,
      openaiApiKey: 'mock-key',
      fetchFn: fakeFetcher,
      motifFallbackType: 'guilloche',
    });

    expect(result.receipt.provider).toBe('procedural');
    expect(result.receipt.artFallback).toBe('procedural');
    expect(result.receipt.synthId).toBe(false);
    expect(result.receipt.costUsd).toBe(0.0);
    expect(result.receipt.attempts).toBe(2);
    expect(result.imageBuffer.length).toBeGreaterThan(100);
  });
});

describe('Image requests are bounded (2026-09-23)', () => {
  it('sends every image generation request, Google and OpenAI, with a timeout signal', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fakeFetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response('unavailable', { status: 503 });
    }) as unknown as typeof fetch;

    for (const settings of [
      { provider: 'google' as const, model: 'gemini-3.1-flash-lite-image', size: '1K', quality: 'auto', aspectRatio: '1:1' },
      { provider: 'openai' as const, model: 'gpt-image-2.5-sunburst', size: '1024x1024', quality: 'auto', aspectRatio: '1:1' },
    ]) {
      const result = await generateArtImage({
        artPrompt: 'Minimalist backdrop',
        palette: ['#0A1628', '#1E3A5F'],
        geminiApiKey: 'mock-key',
        openaiApiKey: 'mock-key',
        fetchFn: fakeFetcher,
        settings,
      });
      expect(result.receipt.artFallback).toBe('procedural');
    }

    expect(signals).toHaveLength(4);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });
});
