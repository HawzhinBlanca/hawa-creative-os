import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import type { StudioLayoutV2, Box, Hex } from './layout-v2.js';
import { evaluateDesignMetrics, computeOcclusion } from './design-metrics.js';
import { rgbToLuminance, evaluateCompositeContrast, type CompositeContrastResult } from './composite-contrast.js';
import { renderLayoutV2, type RenderLayoutV2Result } from './render-layout-v2.js';
import { renderMotifPng, type ProceduralMotifType } from './motifs.js';
import { assertModelAllowed } from '@hawa/domain';

export interface ArtGeneratorOptions {
  openaiApiKey?: string;
  fetchFn?: typeof fetch;
  quality?: 'medium' | 'high';
  timeoutMs?: number;
}

export interface RegionMeasurements {
  calmRegion: {
    meanLuminance: number;
    variance: number;
    stdDev: number;
  };
  outerCanvas: {
    meanLuminance: number;
    variance: number;
    stdDev: number;
  };
  isCalmRegionDarker: boolean;
  isCalmRegionLowerVariance: boolean;
}

export interface ConditionedArtResult {
  status: 'success' | 'degraded_procedural_motif';
  artBuffer: Buffer;
  artMimeType: string;
  compositePng: Buffer;
  noTextCompositePng: Buffer;
  receipt: {
    model: string;
    responseId: string;
    xRequestId: string | null;
    imageTokens: number;
    costUsd: number;
    latencyMs: number;
    sha256: string;
  };
  promptUsed: string;
  regionMeasurements: RegionMeasurements;
  compositeContrast: CompositeContrastResult;
  occlusionMetric: {
    passed: boolean;
    score: number;
  };
}

/**
 * Measures mean luminance, variance, and standard deviation over a rectangular box.
 */
export function measureBoxLuminanceAndVariance(
  png: PNG,
  box: Box
): { meanLuminance: number; variance: number; stdDev: number } {
  const startX = Math.max(0, Math.floor(box.x));
  const endX = Math.min(png.width - 1, Math.floor(box.x + box.width));
  const startY = Math.max(0, Math.floor(box.y));
  const endY = Math.min(png.height - 1, Math.floor(box.y + box.height));

  const lums: number[] = [];
  let sum = 0;

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const idx = (y * png.width + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const lum = rgbToLuminance(r, g, b);
      lums.push(lum);
      sum += lum;
    }
  }

  if (lums.length === 0) return { meanLuminance: 0, variance: 0, stdDev: 0 };

  const meanLuminance = sum / lums.length;
  let varianceSum = 0;
  for (const l of lums) {
    varianceSum += (l - meanLuminance) * (l - meanLuminance);
  }
  const variance = varianceSum / lums.length;
  const stdDev = Math.sqrt(variance);

  return {
    meanLuminance: parseFloat(meanLuminance.toFixed(5)),
    variance: parseFloat(variance.toFixed(6)),
    stdDev: parseFloat(stdDev.toFixed(5)),
  };
}

/**
 * Measures mean luminance, variance, and standard deviation of all pixels outside the calm box.
 */
export function measureOuterLuminanceAndVariance(
  png: PNG,
  calmBox: Box
): { meanLuminance: number; variance: number; stdDev: number } {
  const lums: number[] = [];
  let sum = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const inCalm =
        x >= calmBox.x &&
        x <= calmBox.x + calmBox.width &&
        y >= calmBox.y &&
        y <= calmBox.y + calmBox.height;

      if (!inCalm) {
        const idx = (y * png.width + x) * 4;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        const lum = rgbToLuminance(r, g, b);
        lums.push(lum);
        sum += lum;
      }
    }
  }

  if (lums.length === 0) return { meanLuminance: 0, variance: 0, stdDev: 0 };

  const meanLuminance = sum / lums.length;
  let varianceSum = 0;
  for (const l of lums) {
    varianceSum += (l - meanLuminance) * (l - meanLuminance);
  }
  const variance = varianceSum / lums.length;
  const stdDev = Math.sqrt(variance);

  return {
    meanLuminance: parseFloat(meanLuminance.toFixed(5)),
    variance: parseFloat(variance.toFixed(6)),
    stdDev: parseFloat(stdDev.toFixed(5)),
  };
}

/**
 * Derives an art generation prompt conditioned on the layout architecture.
 */
export function deriveConditionedArtPrompt(layout: StudioLayoutV2): string {
  if (!layout.art) {
    throw new Error('Cannot derive art prompt for layout without art layer configuration');
  }

  const calm = layout.art.calmRegion;
  const aspectDesc = layout.width === layout.height ? '1:1 square' : '4:5 vertical portrait';

  // Gather unique colors from background, panels, and rules
  const colorSet = new Set<string>([layout.background.color]);
  for (const s of layout.shapes) {
    if (s.color) colorSet.add(s.color);
  }
  const paletteStr = Array.from(colorSet).join(', ');

  const calmDesc = `Keep the central typography zone (normalized x: ${Number((calm.x / layout.width).toFixed(2))}, y: ${Number((calm.y / layout.height).toFixed(2))}, w: ${Number((calm.width / layout.width).toFixed(2))}, h: ${Number((calm.height / layout.height).toFixed(2))}) exceptionally calm, dark, and low-contrast with minimal texture, so overlaid text has flawless legibility.`;

  const concept = layout.art.prompt || 'Abstract institutional architectural lines and subtle luxury gradient textures';

  const p7Suffix = `Strict Negative Constraints: No text of any kind, no typography, no letters, no words, no numbers, no logos, no emblems, no seals, no flags, no coats of arms, no people, no faces, no hands, no watermarks, no borders.`;

  return `${concept}. Clean modern academic aesthetic in ${aspectDesc} format. Palette restricted to ${paletteStr} with deep dark navy tones and subtle accents. ${calmDesc} Confine any visual texture and subtle architectural geometry to the outer perimeter and corners. ${p7Suffix}`;
}

/**
 * Generates an art layer conditioned on the layout architecture with gpt-image-2.5-sunburst.
 */
export async function generateConditionedArtLayer(
  layout: StudioLayoutV2,
  options: ArtGeneratorOptions = {}
): Promise<ConditionedArtResult> {
  if (!layout.art) {
    throw new Error('Layout does not request an art layer (layout.art is undefined)');
  }

  // 1. Hard Gate: Only generate art after P01 passes
  const p01Report = evaluateDesignMetrics(layout);
  if (!p01Report.passed) {
    throw new Error(
      `P01 deterministic design metrics failed on layout. Gated from calling image model. Failing metrics: ${p01Report.failingMetrics.join(', ')}`
    );
  }

  const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for gpt-image-2.5-sunburst image generation');
  }

  const fetcher = options.fetchFn || fetch;
  const prompt = deriveConditionedArtPrompt(layout);
  const size = layout.width === layout.height ? '1024x1024' : '1024x1536';
  const quality = options.quality || 'medium';

  const startTime = Date.now();
  let artBuffer: Buffer | null = null;
  let responseId = '';
  let xRequestId: string | null = null;
  let imageTokens = 0;
  let isDegraded = false;

  try {
    const model = 'gpt-image-2.5-sunburst';
    assertModelAllowed(model);

    const res = await fetcher('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        quality,
        size,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI image API failed HTTP ${res.status}: ${errText}`);
    }

    xRequestId = res.headers?.get?.('x-request-id') || null;
    const data = (await res.json()) as any;
    responseId = xRequestId || `img_${data.created || Date.now()}`;
    imageTokens = data.usage?.output_tokens_details?.image_tokens || 439;

    const b64Json = data.data?.[0]?.b64_json;
    if (b64Json) {
      artBuffer = Buffer.from(b64Json, 'base64');
    } else if (data.data?.[0]?.url) {
      const imgRes = await fetcher(data.data[0].url);
      artBuffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No image payload returned by OpenAI image generation');
    }
  } catch (err) {
    console.warn('[ArtGeneratorV3] Generation failed, degrading gracefully to procedural motif:', err);
    isDegraded = true;
    const motifType: ProceduralMotifType = layout.art.motif || 'guilloche';
    artBuffer = renderMotifPng(motifType, {
      width: layout.width,
      height: layout.height,
      palette: ['#0A1628', '#C5A059', '#1E3A5F'],
      opacity: layout.art.opacity,
    });
    responseId = `procedural_fallback_${Date.now()}`;
    imageTokens = 0;
  }

  const latencyMs = Date.now() - startTime;
  const sha256 = crypto.createHash('sha256').update(artBuffer!).digest('hex');
  const costUsd = Number(((imageTokens / 1_000_000) * 30.0).toFixed(5));

  // 2. Measure Luminance and Variance over Calm Region vs Outer Canvas
  const artPng = PNG.sync.read(artBuffer!);
  // Map calm region coordinates to art image coordinates
  const scaleX = artPng.width / layout.width;
  const scaleY = artPng.height / layout.height;
  const artCalmBox: Box = {
    x: layout.art.calmRegion.x * scaleX,
    y: layout.art.calmRegion.y * scaleY,
    width: layout.art.calmRegion.width * scaleX,
    height: layout.art.calmRegion.height * scaleY,
  };

  const calmMeasurements = measureBoxLuminanceAndVariance(artPng, artCalmBox);
  const outerMeasurements = measureOuterLuminanceAndVariance(artPng, artCalmBox);

  const regionMeasurements: RegionMeasurements = {
    calmRegion: calmMeasurements,
    outerCanvas: outerMeasurements,
    isCalmRegionDarker: calmMeasurements.meanLuminance <= outerMeasurements.meanLuminance,
    isCalmRegionLowerVariance: calmMeasurements.variance <= outerMeasurements.variance,
  };

  // 3. Composite behind text with scrim
  // Temporary write art buffer for renderer
  const tempArtPath = path.resolve(process.cwd(), `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/temp_art_${Date.now()}.png`);
  fs.mkdirSync(path.dirname(tempArtPath), { recursive: true });
  fs.writeFileSync(tempArtPath, artBuffer!);

  // Render composite
  const renderResult: RenderLayoutV2Result = renderLayoutV2(layout, {
    artImagePath: tempArtPath,
  });

  // Clean up temp file
  try {
    fs.unlinkSync(tempArtPath);
  } catch {}

  // 4. Re-run composite contrast check on rendered composite
  const compositeContrast = evaluateCompositeContrast(renderResult.noTextPng, layout);

  // 5. Evaluate P01 Occlusion Metric
  const occlusion = computeOcclusion(layout);

  return {
    status: isDegraded ? 'degraded_procedural_motif' : 'success',
    artBuffer: artBuffer!,
    artMimeType: 'image/png',
    compositePng: renderResult.png,
    noTextCompositePng: renderResult.noTextPng,
    receipt: {
      model: isDegraded ? 'procedural-motif' : 'gpt-image-2.5-sunburst',
      responseId,
      xRequestId,
      imageTokens,
      costUsd,
      latencyMs,
      sha256,
    },
    promptUsed: prompt,
    regionMeasurements,
    compositeContrast,
    occlusionMetric: {
      passed: occlusion.passed,
      score: occlusion.score,
    },
  };
}
