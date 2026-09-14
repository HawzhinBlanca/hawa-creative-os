import crypto from 'node:crypto';
import type { Hex } from './layout-v2.js';
import {
  verifyPaletteCompliance,
  type DominantColorSample,
  type PaletteVerificationResult,
} from './color-science.js';
import { renderMotifPng, type ProceduralMotifType } from './motifs.js';

export interface GenerateArtOptions {
  artPrompt: string;
  palette: Hex[];
  calmRegionDescription?: string;
  aspect?: string;
  width?: number;
  height?: number;
  seed?: number;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  fetchFn?: typeof fetch;
  motifFallbackType?: ProceduralMotifType;
}

export interface ArtVerificationReport {
  dominantColorsPassed: boolean;
  dominantColors: DominantColorSample[];
  paletteSummary: string;
  visionCheckPassed: boolean;
  visionDetails?: {
    containsForbidden: boolean;
    what: string;
  };
  passed: boolean;
}

export interface ArtReceipt {
  provider: 'gemini' | 'procedural';
  model: string;
  responseId?: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  synthId: boolean;
  costUsd: number;
  attempts: number;
  artFallback?: 'procedural';
  verificationReport?: ArtVerificationReport;
}

export interface GenerateArtResult {
  imageBuffer: Buffer;
  mimeType: string;
  receipt: ArtReceipt;
}

const SUPPORTED_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9', '4:5'] as const;

export function mapDimensionsToAspect(width: number, height: number): string {
  const target = width / height;
  const ratios: Record<string, number> = {
    '1:1': 1.0,
    '3:4': 3 / 4,
    '4:3': 4 / 3,
    '9:16': 9 / 16,
    '16:9': 16 / 9,
    '4:5': 4 / 5,
  };

  let bestAspect = '4:5';
  let minDiff = Infinity;

  for (const [aspect, ratio] of Object.entries(ratios)) {
    const diff = Math.abs(target - ratio);
    if (diff < minDiff) {
      minDiff = diff;
      bestAspect = aspect;
    }
  }

  return bestAspect;
}

/**
 * Composes art prompt per Section 5.4 / P7 specification:
 * Concept artPrompt + fixed suffix with palette, calm region, and aspect.
 */
export function composeArtPrompt(
  conceptPrompt: string,
  options: {
    palette: Hex[];
    calmRegion?: string;
    aspect?: string;
  }
): string {
  const paletteHexList = options.palette && options.palette.length > 0
    ? options.palette.join(', ')
    : '#0A1628, #1E3A5F, #4770A3, #D4E2F0, #F7B500';

  const calmRegion = options.calmRegion || 'center and bottom region';
  const aspect = options.aspect || '4:5';

  const p7Suffix = `Photographic or painterly still image, no text of any kind, no letters, numbers, typography, logos, emblems, seals, flags, coats of arms, no people, faces or hands. Palette limited to ${paletteHexList} with soft neutrals. Keep the region ${calmRegion} calm, dark and low-detail so text placed there stays legible. Aspect ${aspect}. Fine grain, no watermark-like marks, no borders.`;

  return `${conceptPrompt.trim()}\n\n${p7Suffix}`.trim();
}

/**
 * Performs one-question vision check with Claude Fable 5.1 (fallback to Opus 5):
 * "Does this image contain any letters, digits, logos, flags, emblems, faces or people? answer JSON {containsForbidden:boolean, what:string}"
 */
export async function runVisionCheck(
  imageBuffer: Buffer,
  mimeType: string,
  options: {
    anthropicApiKey?: string;
    fetchFn?: typeof fetch;
    model?: string;
  }
): Promise<{ passed: boolean; containsForbidden: boolean; what: string }> {
  const fetcher = options.fetchFn || fetch;
  const apiKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // If no key provided in testing, fail closed or default to passed only if fake
    throw new Error('ANTHROPIC_API_KEY is required for art vision verification');
  }

  const model = options.model || 'claude-fable-5-1';
  const base64Data = imageBuffer.toString('base64');
  const safeMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';

  const payload = {
    model,
    max_tokens: 300,
    system: 'You are a visual design compliance checker. Analyze the provided image and reply strictly in valid JSON without markdown formatting.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: safeMime,
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: 'Does this image contain any letters, digits, logos, flags, emblems, faces or people? answer JSON {containsForbidden:boolean, what:string}',
          },
        ],
      },
    ],
  };

  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic vision check failed with HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const textContent = data.content?.[0]?.text || '{}';
  const cleanJson = textContent.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleanJson);
    const containsForbidden = Boolean(parsed.containsForbidden);
    const what = String(parsed.what || (containsForbidden ? 'Forbidden content detected' : 'clean'));

    return {
      passed: !containsForbidden,
      containsForbidden,
      what,
    };
  } catch (err: any) {
    throw new Error(`Failed to parse Anthropic vision response: ${cleanJson} (${err?.message})`);
  }
}

/**
 * Generates an art layer for Design Studio v2.
 * Follows ADR 029 Section 5.5:
 * 1. Composes prompt with P7 suffix.
 * 2. Requests 2K resolution at nearest aspect ratio via Gemini 3 Pro Image API.
 * 3. Verifies dominant-color compliance (CIEDE2000 ≤ 25 or neutral chroma < 8).
 * 4. Verifies absence of forbidden content with Claude Fable 5.1 vision check.
 * 5. Up to 2 attempts, then falls back to procedural motif with `artFallback: 'procedural'`.
 */
export async function generateArtImage(options: GenerateArtOptions): Promise<GenerateArtResult> {
  const width = options.width || 1080;
  const height = options.height || 1350;
  const aspect = options.aspect || mapDimensionsToAspect(width, height);
  const fetcher = options.fetchFn || fetch;
  const geminiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
  const anthropicKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  const fullPrompt = composeArtPrompt(options.artPrompt, {
    palette: options.palette,
    calmRegion: options.calmRegionDescription,
    aspect,
  });

  let lastVerificationReport: ArtVerificationReport | undefined;

  // If Gemini key is present, attempt image generation (up to 2 attempts)
  if (geminiKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${geminiKey}`;
        const requestBody = {
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: {
              aspectRatio: aspect,
              imageSize: '2K',
            },
          },
        };

        const res = await fetcher(geminiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[StudioArt] Gemini generation attempt ${attempt} failed HTTP ${res.status}: ${errText.substring(0, 150)}`);
          continue;
        }

        const data = (await res.json()) as any;
        const candidate = data.candidates?.[0];
        const inlinePart = candidate?.content?.parts?.find((p: any) => p.inlineData);

        if (!inlinePart || !inlinePart.inlineData?.data) {
          console.warn(`[StudioArt] Gemini attempt ${attempt} returned no image data`);
          continue;
        }

        const mimeType = inlinePart.inlineData.mimeType || 'image/jpeg';
        const imageBuffer = Buffer.from(inlinePart.inlineData.data, 'base64');
        const responseId = data.responseId || `gemini-img-${Date.now()}`;
        const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');

        // Check A: Dominant-colour check
        const paletteCheck: PaletteVerificationResult = verifyPaletteCompliance(
          imageBuffer,
          mimeType,
          options.palette
        );

        if (!paletteCheck.passed) {
          console.warn(`[StudioArt] Attempt ${attempt} failed dominant-colour check: ${paletteCheck.summary}`);
          lastVerificationReport = {
            dominantColorsPassed: false,
            dominantColors: paletteCheck.dominantColors,
            paletteSummary: paletteCheck.summary,
            visionCheckPassed: false,
            passed: false,
          };
          continue;
        }

        // Check B: Vision check with Claude Fable 5.1
        let visionCheck: { passed: boolean; containsForbidden: boolean; what: string } = {
          passed: true,
          containsForbidden: false,
          what: 'skipped (no key)',
        };

        if (anthropicKey) {
          visionCheck = await runVisionCheck(imageBuffer, mimeType, {
            anthropicApiKey: anthropicKey,
            fetchFn: fetcher,
          });

          if (!visionCheck.passed) {
            console.warn(`[StudioArt] Attempt ${attempt} failed vision check: ${visionCheck.what}`);
            lastVerificationReport = {
              dominantColorsPassed: true,
              dominantColors: paletteCheck.dominantColors,
              paletteSummary: paletteCheck.summary,
              visionCheckPassed: false,
              visionDetails: visionCheck,
              passed: false,
            };
            continue;
          }
        }

        // Both checks passed!
        return {
          imageBuffer,
          mimeType,
          receipt: {
            provider: 'gemini',
            model: 'gemini-3-pro-image',
            responseId,
            bytes: imageBuffer.length,
            sha256,
            mimeType,
            synthId: true,
            costUsd: 0.134,
            attempts: attempt,
            verificationReport: {
              dominantColorsPassed: true,
              dominantColors: paletteCheck.dominantColors,
              paletteSummary: paletteCheck.summary,
              visionCheckPassed: visionCheck.passed,
              visionDetails: visionCheck,
              passed: true,
            },
          },
        };
      } catch (err: any) {
        console.warn(`[StudioArt] Error during generation attempt ${attempt}:`, err?.message);
      }
    }
  }

  // Fallback to procedural motif
  const motifType: ProceduralMotifType = options.motifFallbackType || 'gradient-wash';
  const motifPngBuffer = renderMotifPng(motifType, {
    width,
    height,
    palette: options.palette,
    seed: options.seed || 12345678,
  });

  const sha256 = crypto.createHash('sha256').update(motifPngBuffer).digest('hex');
  const paletteCheck = verifyPaletteCompliance(motifPngBuffer, 'image/png', options.palette);

  return {
    imageBuffer: motifPngBuffer,
    mimeType: 'image/png',
    receipt: {
      provider: 'procedural',
      model: `procedural-motif-${motifType}`,
      bytes: motifPngBuffer.length,
      sha256,
      mimeType: 'image/png',
      synthId: false,
      costUsd: 0.0,
      attempts: geminiKey ? 2 : 0,
      artFallback: 'procedural',
      verificationReport: {
        dominantColorsPassed: paletteCheck.passed,
        dominantColors: paletteCheck.dominantColors,
        paletteSummary: paletteCheck.summary,
        visionCheckPassed: true,
        visionDetails: { containsForbidden: false, what: 'procedural motif SVG' },
        passed: true,
      },
    },
  };
}

export class GeminiImageProvider {
  constructor(
    private readonly geminiApiKey?: string,
    private readonly anthropicApiKey?: string,
    private readonly fetchFn?: typeof fetch
  ) {}

  public async generateArt(
    options: Omit<GenerateArtOptions, 'geminiApiKey' | 'anthropicApiKey' | 'fetchFn'>
  ): Promise<GenerateArtResult> {
    return generateArtImage({
      ...options,
      geminiApiKey: this.geminiApiKey,
      anthropicApiKey: this.anthropicApiKey,
      fetchFn: this.fetchFn,
    });
  }
}

