import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import type { StudioLayoutV2, Box, Hex } from './layout-v2.js';
import { evaluateDesignMetrics, computeOcclusion } from './design-metrics.js';
import { rgbToLuminance, evaluateCompositeContrast, type CompositeContrastResult } from './composite-contrast.js';
import { assertClientLogoForLayout, measureWrappedLines, renderLayoutV2, type RenderLayoutOptions, type RenderLayoutV2Result } from './render-layout-v2.js';
import { renderMotifPng, type ProceduralMotifType } from './motifs.js';
import { assertModelAllowed } from '@hawa/domain';

export interface ArtGeneratorOptions {
  openaiApiKey?: string;
  fetchFn?: typeof fetch;
  quality?: 'medium' | 'high';
  timeoutMs?: number;
  /** Exact client logo and copy for the composite; the renderer has no packaged-logo default. */
  renderOptions?: RenderLayoutOptions;
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
 * The frame to ask the image model for, and the words that describe it in the prompt.
 *
 * gpt-image-2.5-sunburst returns one of three frames, so the art can never match an arbitrary box
 * exactly; the renderer covers the box and crops the overflow evenly (preserveAspectRatio slice),
 * and so does the deck. Picking the frame nearest the box keeps that crop small. The earlier rule
 * sent every non-square box 1024x1536 and called it "4:5 vertical portrait" in the prompt: a 16:9
 * banner was composed as a portrait and then lost most of its height to the crop, and no request
 * was ever 4:5.
 */
export function artFrameForBox(box: Box): { size: string; aspectDesc: string } {
  if (box.width === box.height) return { size: '1024x1024', aspectDesc: '1:1 square' };
  if (box.width > box.height) return { size: '1536x1024', aspectDesc: '3:2 horizontal landscape' };
  return { size: '1024x1536', aspectDesc: '2:3 vertical portrait' };
}

/**
 * A canvas box expressed in the art image's own pixels, under the cover-and-crop transform both the
 * renderer (preserveAspectRatio="xMidYMid slice") and the deck apply: the image is scaled by
 * whichever ratio makes it cover the art box, centred, and the overflow cropped evenly.
 */
export function canvasBoxToArtPixels(box: Box, artBox: Box, art: { width: number; height: number }): Box {
  const scale = Math.max(artBox.width / art.width, artBox.height / art.height);
  const originX = artBox.x + (artBox.width - art.width * scale) / 2;
  const originY = artBox.y + (artBox.height - art.height * scale) / 2;
  return {
    x: (box.x - originX) / scale,
    y: (box.y - originY) / scale,
    width: box.width / scale,
    height: box.height / scale,
  };
}

/** Colors already admitted into this layout; no hidden house-brand palette. */
export function artPaletteForLayout(layout: StudioLayoutV2): Hex[] {
  const colors = [
    layout.background.color,
    layout.art?.scrim?.color,
    ...layout.shapes.flatMap((shape) => [shape.color, shape.strokeColor]),
    ...layout.text.flatMap((block) => [block.color, block.accentColor]),
  ];
  const palette = [...new Set(colors.filter((color): color is Hex => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))].slice(0, 8);
  if (!palette.length) throw new Error('ART_PALETTE_REQUIRED: layout contains no valid client colors');
  return palette;
}

/** Derives art instructions from this layout without imposing one client's visual style. */
export function deriveConditionedArtPrompt(layout: StudioLayoutV2): string {
  if (!layout.art) {
    throw new Error('Cannot derive art prompt for layout without art layer configuration');
  }

  const calm = layout.art.calmRegion;
  // The art fills its own box, not the canvas, so the frame is described from the box.
  const { aspectDesc } = artFrameForBox(layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height });

  const paletteStr = artPaletteForLayout(layout).join(', ');

  const calmDesc = `Keep the reserved typography zone (normalized x: ${Number((calm.x / layout.width).toFixed(2))}, y: ${Number((calm.y / layout.height).toFixed(2))}, w: ${Number((calm.width / layout.width).toFixed(2))}, h: ${Number((calm.height / layout.height).toFixed(2))}) calm with low visual detail, so overlaid text remains legible.`;

  const concept = layout.art.prompt || 'Abstract visual texture supporting the composition';

  const p7Suffix = `Strict Negative Constraints: No text of any kind, no typography, no letters, no words, no numbers, no logos, no emblems, no seals, no flags, no coats of arms, no people, no faces, no hands, no watermarks, no borders.`;

  return `${concept}. Compose text-free background art in ${aspectDesc} format. Use only these layout colors: ${paletteStr}. ${calmDesc} Place the most active detail outside that reserved zone. ${p7Suffix}`;
}

/**
 * The P01 report that gates art. With the copy it scores the lines the copy sets, the measure the
 * layout generator is told (ADR-125); without copy only the declared-box fallback band applies.
 */
export function artGateMetricsV3(layout: StudioLayoutV2, renderOptions?: RenderLayoutOptions) {
  const copyText = renderOptions?.copyText;
  return evaluateDesignMetrics(layout, copyText ? { wrappedLines: measureWrappedLines(layout, copyText, renderOptions) } : {});
}

/**
 * Generates an art layer conditioned on the layout architecture with gpt-image-2.5-sunburst.
 *
 * ADR-289: a paid image call that writes no ledger row. Only scripts/generate-p04-proof.ts uses it;
 * Studio art goes through gemini-image-provider.ts with Core's ledgered requestImage. The egress lint
 * refuses a production caller.
 */
export async function generateConditionedArtLayer(
  layout: StudioLayoutV2,
  options: ArtGeneratorOptions = {}
): Promise<ConditionedArtResult> {
  if (!layout.art) {
    throw new Error('Layout does not request an art layer (layout.art is undefined)');
  }

  // 1. Hard Gate: Only generate art after P01 passes
  const p01Report = artGateMetricsV3(layout, options.renderOptions);
  if (!p01Report.passed) {
    throw new Error(
      `P01 deterministic design metrics failed on layout. Gated from calling image model. Failing metrics: ${p01Report.failingMetrics.join(', ')}`
    );
  }

  assertClientLogoForLayout(layout, options.renderOptions);

  const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for gpt-image-2.5-sunburst image generation');
  }

  const fetcher = options.fetchFn || fetch;
  const prompt = deriveConditionedArtPrompt(layout);
  const { size } = artFrameForBox(layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height });
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
    const box = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
    artBuffer = renderMotifPng(motifType, {
      // The motif fills the art box, so it is drawn at the box's own size: rendering it at the
      // canvas size made the renderer's cover crop throw away part of every motif whose box was
      // not the whole canvas.
      width: Math.round(box.width),
      height: Math.round(box.height),
      palette: artPaletteForLayout(layout),
      // Drawn at full strength, the same rule the production art stage follows: the layer's
      // opacity is applied once, by the render and by the deck. Baking it in here as well made the
      // degraded motif twice as faint as the layout asked for, in the preview and in Canva alike.
      opacity: 1,
    });
    responseId = `procedural_fallback_${Date.now()}`;
    imageTokens = 0;
  }

  const latencyMs = Date.now() - startTime;
  const sha256 = crypto.createHash('sha256').update(artBuffer!).digest('hex');
  const costUsd = Number(((imageTokens / 1_000_000) * 30.0).toFixed(5));

  // 2. Measure Luminance and Variance over Calm Region vs Outer Canvas
  const artPng = PNG.sync.read(artBuffer!);
  const artBox = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
  const calmRegion = layout.art.calmRegion || artBox;
  // Read the art where it actually ends up under the text, which is not where a plain
  // canvas-to-image scale puts it: a 1024x1024 image in a 1080x1350 box is scaled to cover and
  // then cropped, so the stretched mapping sampled a region the design never shows.
  const artCalmBox = canvasBoxToArtPixels(calmRegion, artBox, artPng);

  const calmMeasurements = measureBoxLuminanceAndVariance(artPng, artCalmBox);
  const outerMeasurements = measureOuterLuminanceAndVariance(artPng, artCalmBox);

  const regionMeasurements: RegionMeasurements = {
    calmRegion: calmMeasurements,
    outerCanvas: outerMeasurements,
    isCalmRegionDarker: calmMeasurements.meanLuminance <= outerMeasurements.meanLuminance,
    isCalmRegionLowerVariance: calmMeasurements.variance <= outerMeasurements.variance,
  };

  // 3. Composite behind text with scrim
  // The renderer reads the art from a file. It goes in a private temp directory, never the working
  // directory (it used to land in output/proofs). A missing client logo fails closed; the directory
  // is removed on that path too.
  const tempArtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-art-'));
  const tempArtPath = path.join(tempArtDir, 'art.png');
  let renderResult: RenderLayoutV2Result;
  try {
    fs.writeFileSync(tempArtPath, artBuffer!);
    renderResult = renderLayoutV2(layout, {
      ...options.renderOptions,
      artImagePath: tempArtPath,
    });
  } finally {
    fs.rmSync(tempArtDir, { recursive: true, force: true });
  }

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
