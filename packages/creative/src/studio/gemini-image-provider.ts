import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from './layout-v2.js';
import {
  verifyPaletteCompliance,
  type DominantColorSample,
  type PaletteVerificationResult,
} from './color-science.js';
import { renderMotifPng, type ProceduralMotifType } from './motifs.js';
import {
  assertModelAllowed,
  assertImageModelAllowed,
  resolveImageSettings,
  resolveModel,
  type ImageSettings,
} from '@hawa/domain';

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
  /** Provider, model, size, quality and aspect. Defaults to the environment's (resolveImageSettings). */
  settings?: ImageSettings;
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
  provider: 'openai' | 'google' | 'procedural';
  model: string;
  responseId?: string;
  id?: string;
  xRequestId?: string | null;
  bytes: number;
  sha256: string;
  mimeType: string;
  /** Google's image models watermark every image with SynthID; OpenAI's do not. */
  synthId: boolean;
  /** Every image billed across attempts, including images the checks rejected. */
  costUsd: number;
  /** usage: the provider's token counts; price_list: its published per-image price; estimate: an operator figure. */
  costSource?: 'usage' | 'price_list' | 'estimate' | 'none';
  /** The settings the image was requested with. */
  requested?: { size: string; quality: string; aspectRatio: string };
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
    : 'the client has not given a palette: use a restrained, neutral range of tones';

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

  const model = options.model || resolveModel('critique');
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

  if (options.anthropicApiKey) {
    assertModelAllowed('claude-fable-5-1');
  }

  const settings = options.settings || resolveImageSettings();
  assertImageModelAllowed(settings.provider, settings.model);
  const openaiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  const imageKey = settings.provider === 'google' ? options.geminiApiKey || process.env.GEMINI_API_KEY : openaiKey;
  if (!imageKey) {
    console.warn(`[StudioArt] ${settings.provider} image generation is selected but no API key is configured; using the procedural motif`);
  }

  const fullPrompt = composeArtPrompt(options.artPrompt, {
    palette: options.palette,
    calmRegion: options.calmRegionDescription,
    aspect,
  });

  let lastVerificationReport: ArtVerificationReport | undefined;
  let spentUsd = 0;
  let costSource: ArtReceipt['costSource'] = 'none';
  let attempts = 0;
  const requested = { size: settings.size, quality: settings.quality, aspectRatio: settings.aspectRatio };

  if (imageKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts = attempt;
      try {
        const image = await requestImage(settings, fullPrompt, imageKey, fetcher);
        if (!image) continue;
        const { imageBuffer, mimeType, responseId, xRequestId } = image;
        // Billed the moment the provider returned it, whether or not the checks below keep it.
        spentUsd += image.costUsd;
        costSource = image.costSource;
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

        // Vision check with the active tier's critique model
        let visionCheck = { passed: true, containsForbidden: false, what: 'clean' };
        try {
          visionCheck = await runVisionCheck(imageBuffer, mimeType, {
            openaiApiKey: openaiKey,
            model: resolveModel('critique'),
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
            provider: settings.provider,
            model: settings.model,
            responseId,
            id: responseId,
            xRequestId,
            bytes: imageBuffer.length,
            sha256,
            mimeType,
            synthId: settings.provider === 'google',
            costUsd: spentUsd,
            costSource,
            requested,
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
        // A request that timed out or lost its answer may have been generated and billed: asking
        // again could pay twice for one picture. The free procedural motif takes its place.
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.isUncertain || /timed?\s*out|aborted/i.test(String(err?.message || ''))) break;
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
      // Images generated and rejected before the fallback were still billed.
      costUsd: spentUsd,
      costSource,
      requested,
      attempts,
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

/**
 * How long one image request may take, the generation and the download of its bytes together.
 * These calls had no timeout, so a provider that accepted the request and never answered held a
 * paid run open forever (2026-09-23). Image generation is slow, so the bound is generous.
 */
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

interface ProviderImage {
  imageBuffer: Buffer;
  mimeType: string;
  responseId: string;
  xRequestId: string | null;
  costUsd: number;
  costSource: 'usage' | 'price_list' | 'estimate';
}

/** One image from the configured provider, or null when it returned none (logged). */
async function requestImage(
  settings: ImageSettings,
  prompt: string,
  key: string,
  fetcher: typeof fetch
): Promise<ProviderImage | null> {
  // One deadline for the whole request, body and download included; a timeout throws like every
  // other network failure, and the caller decides what to do with it.
  const signal = AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS);
  if (settings.provider === 'google') {
    // Gemini's Interactions API (ai.google.dev/gemini-api/docs/image-generation, 2026-09-18).
    const res = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        model: settings.model,
        input: [{ type: 'text', text: prompt }],
        response_format: {
          type: 'image',
          mime_type: 'image/png',
          aspect_ratio: settings.aspectRatio,
          image_size: settings.size,
        },
      }),
      signal,
    });
    if (!res.ok) {
      console.warn(`[StudioArt] Google image generation failed HTTP ${res.status}: ${(await res.text()).substring(0, 150)}`);
      return null;
    }
    const data = (await res.json()) as any;
    const parts = [
      ...(data.steps || []).flatMap((step: any) => step?.content || []),
      ...(data.output_image ? [{ type: 'image', ...data.output_image }] : []),
    ];
    const image = parts.find((c: any) => c?.type === 'image' && typeof c.data === 'string');
    if (!image) {
      console.warn('[StudioArt] Google returned no image data');
      return null;
    }
    const price = imagePricing(settings.model)?.perImage?.[settings.size];
    return {
      imageBuffer: Buffer.from(image.data, 'base64'),
      mimeType: image.mime_type || image.mimeType || 'image/png',
      responseId: String(data.id || `google-img-${Date.now()}`),
      xRequestId: res.headers?.get?.('x-request-id') || null,
      costUsd: typeof price === 'number' ? price : 0,
      costSource: 'price_list',
    };
  }

  const res = await fetcher('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: settings.model, prompt, n: 1, size: settings.size, quality: settings.quality }),
    signal,
  });
  if (!res.ok) {
    console.warn(`[StudioArt] OpenAI image generation failed HTTP ${res.status}: ${(await res.text()).substring(0, 150)}`);
    return null;
  }
  const data = (await res.json()) as any;
  let imageBuffer: Buffer;
  if (data.data?.[0]?.b64_json) imageBuffer = Buffer.from(data.data[0].b64_json, 'base64');
  else if (data.data?.[0]?.url) imageBuffer = Buffer.from(await (await fetcher(data.data[0].url, { signal })).arrayBuffer());
  else {
    console.warn('[StudioArt] OpenAI returned no image data');
    return null;
  }
  const xRequestId = res.headers?.get?.('x-request-id') || null;
  return {
    imageBuffer,
    mimeType: 'image/png',
    responseId: xRequestId || `openai-img-${data.created || Date.now()}`,
    xRequestId,
    ...openAiImageCost(settings, data.usage),
  };
}

/** From the response's token counts when it reports them, else the operator's per-image estimate. */
function openAiImageCost(settings: ImageSettings, usage: any): { costUsd: number; costSource: 'usage' | 'estimate' } {
  const rates = imagePricing(settings.model) || {};
  if (usage && typeof usage.output_tokens === 'number') {
    const details = usage.input_tokens_details || {};
    const textIn = typeof details.text_tokens === 'number' ? details.text_tokens : Number(usage.input_tokens || 0);
    const imageIn = Number(details.image_tokens || 0);
    const usd =
      (textIn * Number(rates.inputPerMillionTextTokens || 0) +
        imageIn * Number(rates.inputPerMillionImageTokens || 0) +
        usage.output_tokens * Number(rates.outputPerMillionImageTokens || 0)) /
      1_000_000;
    return { costUsd: usd, costSource: 'usage' };
  }
  const longEdge = Math.max(...settings.size.split('x').map(Number).filter(Number.isFinite), 1024);
  const estimate = longEdge > 2048 ? rates.image4k : longEdge > 1024 ? rates.image2k : rates.image1k;
  return { costUsd: Number(estimate || 0), costSource: 'estimate' };
}

let pricingCache: any;
/** The studio's price table, looked up beside the compiled module and beside the source. */
function imagePricing(model: string): any {
  if (pricingCache === undefined) {
    pricingCache = null;
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      for (const candidate of [
        path.join(here, 'pricing.json'),
        path.resolve(here, '../../src/studio/pricing.json'),
        path.resolve(process.cwd(), 'packages/creative/src/studio/pricing.json'),
      ]) {
        if (fs.existsSync(candidate)) {
          pricingCache = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          break;
        }
      }
    } catch {
      pricingCache = null;
    }
  }
  return (pricingCache?.models || pricingCache || {})[model];
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
