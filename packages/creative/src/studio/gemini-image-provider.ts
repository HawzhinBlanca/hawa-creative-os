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
import { renderMotifPng, requireClientPalette, type ProceduralMotifType } from './motifs.js';
import { OpenAiStudioClient, type OpenAiStructuredResponse } from './openai-studio-client.js';
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
  /** Core supplies these adapters to admit every paid request through its durable ledger. */
  requestImage?: (settings: ImageSettings, prompt: string) => Promise<ProviderImage | null>;
  visionClient?: Pick<OpenAiStudioClient, 'createStructuredCompletion'>;
}

/** Local accounting failure must not be converted into another paid attempt or a clean fallback. */
export class StudioArtAccountingError extends Error {
  readonly code = 'MODEL_CALL_ACCOUNTING_FAILED';
  constructor(cause: unknown) {
    super('The paid call could not be accounted for. Reconcile its saved evidence before continuing.', { cause });
    this.name = 'StudioArtAccountingError';
  }
}

export function isStudioArtHoldError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('isUncertain' in error && error.isUncertain === true) return true;
  return 'code' in error && typeof error.code === 'string' &&
    /^(MODEL_CALL_|MODEL_STAGE_REPLAY_UNSAFE$|TASK_GENERATION_BLOCKED$|STUDIO_BUDGET_|BUDGET_EXHAUSTED$)/.test(error.code);
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
  fallbackReason?: 'vision_check_unavailable';
  verificationReport?: ArtVerificationReport;
}

export interface GenerateArtResult {
  imageBuffer: Buffer;
  mimeType: string;
  receipt: ArtReceipt;
}

/** The image provider may have accepted a request even when its answer was lost. */
export class ImageAcceptanceUnknownError extends Error {
  readonly code = 'UNCERTAIN_ACCEPTANCE';
  readonly isUncertain = true;
  costUsd = 0;
  constructor(provider: string, cause?: unknown) {
    super(`${provider} image acceptance and billing are unknown; reconcile this attempt before another generation`);
    this.name = 'ImageAcceptanceUnknownError';
    this.cause = cause;
  }
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
  const paletteHexList = requireClientPalette(options.palette).join(', ');

  const calmRegion = options.calmRegion || 'center and bottom region';
  const aspect = options.aspect || '4:5';

  const p7Suffix = `Create only the text-free visual art described above: no text of any kind, no letters, numbers, typography, logos, emblems, seals, flags, coats of arms, no people, faces or hands. Palette limited to ${paletteHexList}. Keep the region ${calmRegion} calm and low-detail so text placed there stays legible. Aspect ${aspect}. No watermark-like marks or borders.`;

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
    client?: Pick<OpenAiStudioClient, 'createStructuredCompletion'>;
  }
): Promise<{ passed: boolean; containsForbidden: boolean; what: string;
  receipt: OpenAiStructuredResponse<unknown>['receipt'] }> {
  const fetcher = options.fetchFn || fetch;

  if (options.anthropicApiKey) {
    assertModelAllowed(options.model || 'claude-fable-5-1');
  }

  const model = options.model || resolveModel('critique');
  assertModelAllowed(model);

  const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey && !options.client) {
    throw new Error('OPENAI_API_KEY is required for art vision verification');
  }

  const base64Data = imageBuffer.toString('base64');
  const safeMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';

  const client = options.client ?? new OpenAiStudioClient({ apiKey, fetcher, timeoutMs: 30_000 });
  const result = await client.createStructuredCompletion<unknown>({
    model,
    maxTokens: 300,
    timeoutMs: 30_000,
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
    jsonSchema: {
      name: 'ArtCompliance',
      schema: { type: 'object', additionalProperties: false, required: ['containsForbidden', 'what'],
        properties: { containsForbidden: { type: 'boolean' }, what: { type: 'string' } } },
    },
  });
  const verdict = result.data;
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) ||
      !('containsForbidden' in verdict) || typeof verdict.containsForbidden !== 'boolean' ||
      !('what' in verdict) || typeof verdict.what !== 'string' || !verdict.what.trim()) {
    throw Object.assign(new Error('The art verifier returned an invalid verdict.'),
      { code: 'ART_VERDICT_INVALID', costUsd: result.receipt.costUsd });
  }
  return { passed: !verdict.containsForbidden, containsForbidden: verdict.containsForbidden,
    what: verdict.what, receipt: result.receipt };
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
  let fallbackReason: ArtReceipt['fallbackReason'];
  const requested = { size: settings.size, quality: settings.quality, aspectRatio: settings.aspectRatio };

  if (imageKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts = attempt;
      try {
        const image = await (options.requestImage
          ? options.requestImage(settings, fullPrompt)
          : requestStudioArtImage(settings, fullPrompt, imageKey, fetcher));
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
        let visionCheck: Awaited<ReturnType<typeof runVisionCheck>>;
        try {
          visionCheck = await runVisionCheck(imageBuffer, mimeType, {
            openaiApiKey: openaiKey,
            model: resolveModel('critique'),
            fetchFn: fetcher,
            client: options.visionClient,
          });
          spentUsd += visionCheck.receipt.costUsd;
        } catch (vErr: any) {
          if (isStudioArtHoldError(vErr)) throw vErr;
          spentUsd += Number(vErr?.costUsd) > 0 ? Number(vErr.costUsd) : 0;
          console.warn(`[StudioArt] Vision check unavailable:`, vErr?.code || 'VERIFIER_FAILED');
          // The image was already billed, but its pixels cannot be admitted without a verdict.
          // A second image call would pay again while the verifier is still unavailable.
          fallbackReason = 'vision_check_unavailable';
          break;
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
            responseId: responseId ?? undefined,
            id: responseId ?? undefined,
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
        console.warn(`[StudioArt] Generation attempt ${attempt} stopped:`, err?.code || 'ART_FAILED');
        // A generated image can be billed even when no answer reached us. Preserve the known cost
        // of earlier rejected images and leave the current attempt unresolved in Core's ledger.
        if (err?.isUncertain) {
          err.costUsd = spentUsd + (Number(err.costUsd) > 0 ? Number(err.costUsd) : 0);
          throw err;
        }
        if (isStudioArtHoldError(err)) throw err;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed?\s*out|aborted/i.test(String(err?.message || ''))) {
          const uncertain = new ImageAcceptanceUnknownError(settings.provider, err);
          uncertain.costUsd = spentUsd;
          throw uncertain;
        }
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
      ...(fallbackReason ? { fallbackReason } : {}),
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

export interface ProviderImage {
  imageBuffer: Buffer;
  mimeType: string;
  responseId: string | null;
  xRequestId: string | null;
  servedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: 'usage' | 'price_list' | 'estimate';
}

/** One image from the configured provider, or null when it returned none (logged). */
export async function requestStudioArtImage(
  settings: ImageSettings,
  prompt: string,
  key: string,
  fetcher: typeof fetch,
  beforeDispatch?: (body: string) => Promise<void>
): Promise<ProviderImage | null> {
  // One deadline for the whole request, body and download included; a timeout throws like every
  // other network failure, and the caller decides what to do with it.
  const signal = AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS);
  const providerFetch = async (url: string, init: RequestInit): Promise<Response> => {
    await beforeDispatch?.(String(init.body));
    try { return await fetcher(url, init); }
    catch (error) { throw new ImageAcceptanceUnknownError(settings.provider, error); }
  };
  const readImageResponse = async (res: Response): Promise<any> => {
    try { return await res.json(); }
    catch (error) { throw new ImageAcceptanceUnknownError(settings.provider, error); }
  };
  if (settings.provider === 'google') {
    // Gemini's Interactions API (ai.google.dev/gemini-api/docs/image-generation, 2026-09-18).
    const res = await providerFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
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
      if (res.status >= 500) throw new ImageAcceptanceUnknownError(settings.provider);
      console.warn(`[StudioArt] Google image generation failed HTTP ${res.status}`);
      return null;
    }
    const data = await readImageResponse(res);
    const parts = [
      ...(data.steps || []).flatMap((step: any) => step?.content || []),
      ...(data.output_image ? [{ type: 'image', ...data.output_image }] : []),
    ];
    const image = parts.find((c: any) => c?.type === 'image' && typeof c.data === 'string');
    if (!image) {
      throw new ImageAcceptanceUnknownError(settings.provider);
    }
    const price = imagePricing(settings.model)?.perImage?.[settings.size];
    return {
      imageBuffer: Buffer.from(image.data, 'base64'),
      mimeType: image.mime_type || image.mimeType || 'image/png',
      responseId: typeof data.id === 'string' ? data.id : null,
      xRequestId: res.headers?.get?.('x-request-id') || null,
      servedModel: typeof data.model === 'string' ? data.model : null,
      inputTokens: data.usage?.total_input_tokens ?? 0,
      outputTokens: data.usage?.total_output_tokens ?? 0,
      costUsd: typeof price === 'number' ? price : 0,
      costSource: 'price_list',
    };
  }

  const res = await providerFetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: settings.model, prompt, n: 1, size: settings.size, quality: settings.quality }),
    signal,
  });
  if (!res.ok) {
    if (res.status >= 500) throw new ImageAcceptanceUnknownError(settings.provider);
    console.warn(`[StudioArt] OpenAI image generation failed HTTP ${res.status}`);
    return null;
  }
  const data = await readImageResponse(res);
  let imageBuffer: Buffer;
  if (data.data?.[0]?.b64_json) imageBuffer = Buffer.from(data.data[0].b64_json, 'base64');
  else if (data.data?.[0]?.url) {
    try { imageBuffer = Buffer.from(await (await fetcher(data.data[0].url, { signal })).arrayBuffer()); }
    catch (error) { throw new ImageAcceptanceUnknownError(settings.provider, error); }
  }
  else {
    throw new ImageAcceptanceUnknownError(settings.provider);
  }
  const xRequestId = res.headers?.get?.('x-request-id') || null;
  return {
    imageBuffer,
    mimeType: 'image/png',
    responseId: typeof data.id === 'string' ? data.id : null,
    xRequestId,
    servedModel: typeof data.model === 'string' ? data.model : null,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    ...openAiImageCost(settings, data.usage),
  };
}

/** From the response's token counts when it reports them, else the operator's per-image estimate. */
function openAiImageCost(settings: ImageSettings, usage: any): { costUsd: number; costSource: 'usage' | 'estimate' } {
  const rates = imagePricing(settings.model) || {};
  const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const details = usage?.input_tokens_details || {};
  if (usage && tokenCount(usage.output_tokens) && tokenCount(usage.input_tokens) &&
      tokenCount(details.text_tokens ?? usage.input_tokens) && tokenCount(details.image_tokens ?? 0) &&
      (details.text_tokens ?? usage.input_tokens) + (details.image_tokens ?? 0) === usage.input_tokens) {
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
