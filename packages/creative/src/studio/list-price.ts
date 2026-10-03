/**
 * ADR-289 addendum: the one price source for what a text call COST. The provider's list price
 * (`pricing.json`) applied to the usage it reported: uncached input, cached input, cache writes when a
 * provider reports them, and output. Studio receipts (OpenAiStudioClient.calculateCost) and the
 * intake router, Canva planner and health probe ledgers (`studioTextUsage`) all price usage here.
 *
 * The conservative reservation rates of spending-reservation.ts bound only what is HELD before a call
 * settles; they never become a call's counted cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioUsdMicros } from '@hawa/domain';

export interface ListTextRates { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number }
export interface ListTextUsage { inputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number; outputTokens: number }

/** Used only when pricing.json cannot be found beside the module or the source. */
const FALLBACK_PRICING = {
  currency: 'USD',
  models: {
    'gpt-6.1-sol': { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5 },
    'gpt-6-astra': { inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 1.0, cacheWritePerMillion: 12.5 },
    'gpt-image-2.5-sunburst': { outputPerMillionImageTokens: 30.0, image1k: 0.04, image2k: 0.08, image4k: 0.16 },
    'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.1 },
    'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadPerMillion: 0.275 },
  },
};

let cached: any;
/** pricing.json, read once. tsc does not copy JSON, so the source path is checked too. */
export function loadListPricing(): any {
  if (cached) return cached;
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      path.join(currentDir, 'pricing.json'),
      path.resolve(currentDir, '../../src/studio/pricing.json'),
      path.resolve(process.cwd(), 'packages/creative/src/studio/pricing.json'),
    ]) {
      if (fs.existsSync(candidate)) return (cached = JSON.parse(fs.readFileSync(candidate, 'utf8')));
    }
  } catch {
    // Fallback defaults below.
  }
  return (cached = FALLBACK_PRICING);
}

/**
 * Rates for a model id, matching a dated snapshot to its base model.
 *
 * The API echoes the snapshot it served — "o4-mini-2025-04-16" for a request for "o4-mini" — and a
 * snapshot is the same model at the same price. Matching the longest priced prefix keeps the
 * ledger honest without needing a row per snapshot, while an unrelated model still finds nothing
 * and is reported rather than priced at someone else's rate.
 */
export function resolveRatesForModel(
  models: Record<string, any> | undefined,
  model: string
): any | undefined {
  if (!models || !model) return undefined;
  if (models[model]) return models[model];
  let best: string | undefined;
  for (const known of Object.keys(models)) {
    if (model.startsWith(known + '-') && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(known.length + 1)) && (!best || known.length > best.length)) best = known;
  }
  return best ? models[best] : undefined;
}

/** List-price text rates for a model (or its dated snapshot), or undefined when it has none. */
export function listTextRates(model: string, models: Record<string, any> | undefined = loadListPricing().models): ListTextRates | undefined {
  const rates = resolveRatesForModel(models, model);
  return rates && typeof rates.inputPerMillion === 'number' && typeof rates.outputPerMillion === 'number' ? rates : undefined;
}

/** The cost of reported usage at the given list rates, rounded UP to the micro-dollar (never understated). */
export function priceTextUsage(model: string, rates: ListTextRates, usage: ListTextUsage): number {
  const inTok = usage.inputTokens, outTok = usage.outputTokens;
  const cacheReadTokens = usage.cachedInputTokens ?? 0, cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const regularInputTokens = Math.max(0, inTok - cacheReadTokens);
  // Astra and Sol 6.1 price the entire request at long-context rates above 272K input tokens.
  const longContext = /^(?:gpt-6-astra|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(model) && inTok > 272000;
  const inputMultiplier = longContext ? 2 : 1, outputMultiplier = longContext ? 1.5 : 1;
  const inCost = (regularInputTokens / 1_000_000) * rates.inputPerMillion * inputMultiplier;
  const outCost = (outTok / 1_000_000) * rates.outputPerMillion * outputMultiplier;
  const cacheReadCost = rates.cacheReadPerMillion ? (cacheReadTokens / 1_000_000) * rates.cacheReadPerMillion * inputMultiplier : 0;
  const cacheWriteCost = rates.cacheWritePerMillion ? (cacheWriteTokens / 1_000_000) * rates.cacheWritePerMillion * inputMultiplier : 0;
  return studioUsdMicros(inCost + outCost + cacheReadCost + cacheWriteCost) / 1_000_000;
}

/** List price of reported usage, or null for a model pricing.json does not price. */
export function listPriceTextUsd(model: string, usage: ListTextUsage, models?: Record<string, any>): number | null {
  const rates = listTextRates(model, models);
  return rates ? priceTextUsage(model, rates, usage) : null;
}
