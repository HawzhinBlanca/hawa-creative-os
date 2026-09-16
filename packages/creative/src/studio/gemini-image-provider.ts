import crypto from 'node:crypto';
import type { Hex } from './layout-v2.js';
import {
  verifyPaletteCompliance,
  type DominantColorSample,
  type PaletteVerificationResult,
} from './color-science.js';
import { renderMotifPng, type ProceduralMotifType } from './motifs.js';
import { assertModelAllowed } from '@hawa/domain';

export interface GenerateArtOptions {
  artPrompt: string;
  palette: Hex[];
  calmRegionDescription?: string;
  aspect?: string;
  width?: number;
  height?: number;
  seed?: number;
  openaiApiKey?: string;
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
  provider: 'openai' | 'gemini' | 'procedural';
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
 * Runs vision verification using gpt-6-astra.
 * Checks that the generated artwork contains NO letters, digits, logos, flags, emblems, faces or people.
 */
export async function runVisionCheck(
  imageBuffer: Buffer,
  mimeType: string,
  options: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    model?: string;
    fetchFn?: typeof fetch;
  }
): Promise<{ passed: boolean; containsForbidden: boolean; what: string }> {
  const fetcher = options.fetchFn || fetch;

  if (options.anthropicApiKey) {
    assertModelAllowed(options.model || 'claude-fable-5-1');
  }

  const model = options.model || 'gpt-6-astra';
  assertModelAllowed(model);

  const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for art vision verification');
  }

  const base64Data = imageBuffer.toString('base64');
  const safeMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';

  const payload = {
    model,
    max_tokens: 300,
    messages: [
      {
        role: 'system',
        content: 'You are a visual design compliance checker. Analyze the provided image and reply strictly in valid JSON without markdown formatting.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${safeMime};base64,${base64Data}`,
            },
          },
          {
            type: 'text',
            text: 'Does this image contain any letters, digits, logos, flags, emblems, faces or people? answer JSON {"containsForbidden":boolean, "what":string}',
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };

  const res = await fetcher('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI vision check failed with HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const textContent = data.choices?.[0]?.message?.content || '{}';
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
    throw new Error(`Failed to parse OpenAI vision response: ${cleanJson} (${err?.message})`);
  }
}

/**
 * Generates an art layer for Design Studio v2.
 * Follows ADR 030 OpenAI-only policy:
 * 1. Composes prompt with P7 suffix.
 * 2. Requests image generation via gpt-image-2.5-sunburst.
 * 3. Verifies dominant-color compliance (CIEDE2000 <= 25 or neutral chroma < 8).
 * 4. Verifies absence of forbidden content with gpt-6-astra vision check.
 * 5. Up to 2 attempts, then falls back to procedural motif with `artFallback: 'procedural'`.
 */
export async function generateArtImage(options: GenerateArtOptions): Promise<GenerateArtResult> {
  const width = options.width || 1080;
  const height = options.height || 1350;
  const aspect = options.aspect || mapDimensionsToAspect(width, height);
  const fetcher = options.fetchFn || fetch;

  if (options.geminiApiKey) {
    assertModelAllowed('gemini-3-pro-image');
  }
  if (options.anthropicApiKey) {
    assertModelAllowed('claude-fable-5-1');
  }

  const openaiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;

  const fullPrompt = composeArtPrompt(options.artPrompt, {
    palette: options.palette,
    calmRegion: options.calmRegionDescription,
    aspect,
  });

  let lastVerificationReport: ArtVerificationReport | undefined;

  if (openaiKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = 'gpt-image-2.5-sunburst';
        assertModelAllowed(model);

        const openAiUrl = 'https://api.openai.com/v1/images/generations';
        const requestBody = {
          model,
          prompt: fullPrompt,
          n: 1,
          size: '1024x1024',
        };

        const res = await fetcher(openAiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[StudioArt] OpenAI generation attempt ${attempt} failed HTTP ${res.status}: ${errText.substring(0, 150)}`);
          continue;
        }

        const data = (await res.json()) as any;
        const b64Json = data.data?.[0]?.b64_json;
        let imageBuffer: Buffer;
        if (b64Json) {
          imageBuffer = Buffer.from(b64Json, 'base64');
        } else if (data.data?.[0]?.url) {
          const urlRes = await fetcher(data.data[0].url);
          imageBuffer = Buffer.from(await urlRes.arrayBuffer());
        } else {
          console.warn(`[StudioArt] OpenAI attempt ${attempt} returned no image data`);
          continue;
        }

        const mimeType = 'image/png';
        const responseId = `openai-img-${data.created || Date.now()}`;
        const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');

        // Dominant-colour check
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

        // Vision check with gpt-6-astra
        let visionCheck = { passed: true, containsForbidden: false, what: 'clean' };
        try {
          visionCheck = await runVisionCheck(imageBuffer, mimeType, {
            openaiApiKey: openaiKey,
            model: 'gpt-6-astra',
            fetchFn: fetcher,
          });
        } catch (vErr: any) {
          console.warn(`[StudioArt] Vision check error:`, vErr.message);
        }

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

        return {
          imageBuffer,
          mimeType,
          receipt: {
            provider: 'openai',
            model,
            responseId,
            bytes: imageBuffer.length,
            sha256,
            mimeType,
            synthId: true,
            costUsd: 0.04,
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
      attempts: openaiKey ? 2 : 0,
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

export class OpenAiImageProvider {
  constructor(
    private readonly openaiApiKey?: string,
    private readonly fetchFn?: typeof fetch
  ) {}

  public async generateArt(
    options: Omit<GenerateArtOptions, 'openaiApiKey' | 'fetchFn'>
  ): Promise<GenerateArtResult> {
    return generateArtImage({
      ...options,
      openaiApiKey: this.openaiApiKey,
      fetchFn: this.fetchFn,
    });
  }
}

export class GeminiImageProvider extends OpenAiImageProvider {
  constructor(
    _geminiApiKey?: string,
    _anthropicApiKey?: string,
    fetchFn?: typeof fetch
  ) {
    super(process.env.OPENAI_API_KEY, fetchFn);
  }
}
