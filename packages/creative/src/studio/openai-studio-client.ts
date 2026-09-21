import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertModelAllowed, modelSupportsReasoningEffort, resolveModel } from '@hawa/domain';
import {
  StudioModelHttpError,
  StudioModelTimeoutError,
  StudioCircuitBreakerOpenError,
  httpErrorCode,
  isQuotaExhausted,
} from './studio-errors.js';

export interface OpenAiStudioClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuitBreaker?: any;
  primaryModel?: string;
  fallbackModel?: string;
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }>;
}

export interface OpenAiStructuredResponse<T = any> {
  data: T;
  rawText: string;
  receipt: {
    id?: string;
    responseId: string;
    xRequestId?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    sha256: string;
    latencyMs: number;
    attempts: number;
  };
}

export interface OpenAiImageResponse {
  imageBytes: Buffer;
  mimeType: string;
  receipt: {
    id?: string;
    responseId: string;
    xRequestId?: string | null;
    model: string;
    prompt: string;
    costUsd: number;
    sha256: string;
    latencyMs: number;
  };
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
    if (model.startsWith(known) && (!best || known.length > best.length)) best = known;
  }
  return best ? models[best] : undefined;
}

export class OpenAiModelHttpError extends StudioModelHttpError {
  readonly status: number;
  readonly body: string;
  readonly code: string;

  constructor(status: number, body: string) {
    super(status, body);
    this.name = 'OpenAiModelHttpError';
    this.status = status;
    this.body = body;
    this.code = httpErrorCode(status, body);
  }
}

export class OpenAiModelTimeoutError extends StudioModelTimeoutError {
  readonly code = 'UNCERTAIN_TIMEOUT';
  public isUncertain = true;
  constructor(ms: number) {
    super(`OpenAI model call timed out after ${ms}ms`);
    this.name = 'OpenAiModelTimeoutError';
  }
}

export class OpenAiCircuitBreakerOpenError extends StudioCircuitBreakerOpenError {
  readonly code = 'CIRCUIT_BREAKER_OPEN';
  constructor() {
    super('openai');
    this.name = 'OpenAiCircuitBreakerOpenError';
  }
}

export class OpenAiCircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(
    private readonly threshold = 5,
    private readonly resetTimeoutMs = 30000
  ) {}

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  isOpen(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        return false;
      }
      return true;
    }
    return false;
  }
}

function computeRetryDelayMs(attempt: number): number {
  if (process.env.HAWA_RETRY_DELAY_MS) {
    const custom = Number(process.env.HAWA_RETRY_DELAY_MS);
    if (!Number.isNaN(custom)) return custom * attempt;
  }
  const base = Math.pow(2, attempt) * 1000;
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export class OpenAiStudioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  public readonly primaryModel: string;
  public readonly fallbackModel: string;
  private readonly timeoutMs: number;
  private readonly breaker: any;
  private readonly pricing: any;
  private static readonly unpricedWarned = new Set<string>();

  constructor(options: OpenAiStudioClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = options.timeoutMs || 240000;
    this.breaker = options.circuitBreaker || new OpenAiCircuitBreaker();
    this.pricing = this.loadPricing();
    this.primaryModel = options.primaryModel || resolveModel('text');
    this.fallbackModel = options.fallbackModel || resolveModel('text');
  }

  get circuitBreaker() { return this.breaker; }

  private loadPricing(): any {
    // Looks beside the compiled module and beside the source. tsc does not copy JSON, so for a
    // long time only the built path was checked, it never existed, and every price silently came
    // from the fallback table below — which made the table-driven pricing an illusion.
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      for (const candidate of [
        path.join(currentDir, 'pricing.json'),
        path.resolve(currentDir, '../../src/studio/pricing.json'),
        path.resolve(process.cwd(), 'packages/creative/src/studio/pricing.json'),
      ]) {
        if (fs.existsSync(candidate)) {
          return JSON.parse(fs.readFileSync(candidate, 'utf8'));
        }
      }
    } catch {
      // Fallback defaults
    }
    return {
      currency: 'USD',
      models: {
        'gpt-6-astra': { inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 1.0, cacheWritePerMillion: 12.5 },
        'gpt-image-2.5-sunburst': { outputPerMillionImageTokens: 30.0, image1k: 0.04, image2k: 0.08, image4k: 0.16 },
        'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.1 },
        'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadPerMillion: 0.275 },
      },
    };
  }

  calculateCost(model: string, usage: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  }): number {
    let rates = this.pricing.models?.[model] || resolveRatesForModel(this.pricing.models, model);
    if (!rates?.inputPerMillion) {
      // Never price an unknown model at another model's rates in silence: the production rates are
      // up to eighty times the cheap tier's, so a quiet fallback overstates a whole ledger.
      if (!OpenAiStudioClient.unpricedWarned.has(model)) {
        OpenAiStudioClient.unpricedWarned.add(model);
        console.warn(
          `[openai-studio-client] No price for model '${model}' in pricing.json. Falling back to ` +
            `gpt-6-astra rates, which will overstate the cost of any cheaper model. Add it to ` +
            `packages/creative/src/studio/pricing.json.`
        );
      }
      rates = this.pricing.models?.['gpt-6-astra'];
    }
    if (!rates || !rates.inputPerMillion) return 0.01;

    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    const regularInputTokens = Math.max(0, inTok - cacheReadTokens);

    const inCost = (regularInputTokens / 1_000_000) * rates.inputPerMillion;
    const outCost = (outTok / 1_000_000) * rates.outputPerMillion;
    const cacheReadCost = rates.cacheReadPerMillion ? (cacheReadTokens / 1_000_000) * rates.cacheReadPerMillion : 0;
    const cacheWriteCost = rates.cacheWritePerMillion ? (cacheWriteTokens / 1_000_000) * rates.cacheWritePerMillion : 0;

    return Number((inCost + outCost + cacheReadCost + cacheWriteCost).toFixed(6));
  }

  async createStructuredCompletion<T = any>(options: {
    model?: string;
    messages: OpenAiMessage[];
    jsonSchema: { name: string; schema: Record<string, any>; strict?: boolean };
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
  }): Promise<OpenAiStructuredResponse<T>> {
    const model = options.model || resolveModel('text');
    assertModelAllowed(model);

    const isBreakerOpen = typeof this.breaker.isOpen === 'function'
      ? this.breaker.isOpen()
      : typeof this.breaker.getState === 'function'
      ? this.breaker.getState() === 'open'
      : false;
    if (isBreakerOpen) {
      throw new OpenAiCircuitBreakerOpenError();
    }

    const payload: any = {
      model,
      messages: options.messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.jsonSchema.name,
          schema: options.jsonSchema.schema,
          strict: options.jsonSchema.strict ?? true,
        },
      },
      max_completion_tokens: options.maxTokens || 4000,
    };

    // Only reasoning models accept reasoning_effort; the others reject the whole request with a
    // 400. Callers ask for it without knowing which tier's model will answer — the dev tier's
    // critique and judge run on gpt-4.1-mini — so the client decides, once, for all of them.
    if (options.reasoningEffort && modelSupportsReasoningEffort(model)) {
      payload.reasoning_effort = options.reasoningEffort;
    } else if (model === 'gpt-6-astra') {
      payload.reasoning_effort = 'low';
    }

    if (options.temperature !== undefined && model !== 'gpt-6-astra') {
      payload.temperature = options.temperature;
    }

    const startTime = Date.now();
    const timeout = options.timeoutMs || this.timeoutMs;

    let attempt = 0;
    // T9: VPN/tunnel egress intermittently drops long-lived TLS mid-request (UND_ERR_SOCKET).
    // Three attempts with 2s/4s backoff proved insufficient; six with exponential backoff survives it.
    const maxAttempts = Number(process.env.HAWA_MODEL_MAX_ATTEMPTS || 6);

    while (attempt < maxAttempts) {
      attempt++;
      let timeoutId: any;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeout);

        const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts && !isQuotaExhausted(res.status, errBody)) {
              await sleep(computeRetryDelayMs(attempt));
              continue;
            }
            if (typeof this.breaker.recordFailure === 'function') {
              this.breaker.recordFailure();
            }
            throw new OpenAiModelHttpError(res.status, errBody);
          }

          const xRequestId = res.headers?.get?.('x-request-id') || null;
          const data: any = await res.json();
          if (typeof this.breaker.recordSuccess === 'function') {
            this.breaker.recordSuccess();
          }

          const latencyMs = Date.now() - startTime;
        const toolUsePart = Array.isArray(data.content)
          ? data.content.find((b: any) => b.type === 'tool_use')?.input
          : null;
        const toolCallArg = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;

        const rawContent = data.choices?.[0]?.message?.content ??
          (Array.isArray(data.content)
            ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            : (typeof data.content === 'string' ? data.content : '{}'));
        const cleanContent = rawContent.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1').trim();

        let parsed: any;
        if (toolUsePart && typeof toolUsePart === 'object') {
          parsed = toolUsePart;
        } else if (toolCallArg) {
          try {
            parsed = JSON.parse(toolCallArg);
          } catch {
            parsed = {};
          }
        } else {
          try {
            parsed = JSON.parse(cleanContent);
          } catch {
            const firstBrace = cleanContent.indexOf('{');
            const lastBrace = cleanContent.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
              parsed = JSON.parse(cleanContent.slice(firstBrace, lastBrace + 1));
            } else {
              parsed = {};
            }
          }
        }

        const usage = data.usage || {};
        const costUsd = this.calculateCost(model, usage);
        const sha256 = createHash('sha256').update(cleanContent).digest('hex');

        return {
          data: parsed,
          rawText: cleanContent,
          receipt: {
            id: data.id || xRequestId || `openai_${Date.now()}`,
            responseId: data.id || xRequestId || `openai_${Date.now()}`,
            xRequestId,
            model: data.model || model,
            inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
            outputTokens: usage.completion_tokens || usage.output_tokens || 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
            costUsd,
            sha256,
            latencyMs,
            attempts: attempt,
          },
        };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        if (err instanceof OpenAiModelHttpError) {
          throw err;
        }
        if (attempt >= maxAttempts) {
          this.breaker.recordFailure();
          throw err;
        }
        await sleep(computeRetryDelayMs(attempt));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error('Failed to complete OpenAI structured completion after retries');
  }

  async completeJson<T = any>(params: {
    system?: string;
    prompt: string;
    schema?: Record<string, any>;
    schemaName?: string;
    model?: string;
    images?: Array<Buffer | { mediaType?: string; data: string }>;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ data: T; rawText: string; receipt: any }> {
    const model = params.model || this.primaryModel;
    assertModelAllowed(model);
    const messages: OpenAiMessage[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    if (params.images && params.images.length > 0) {
      const parts: any[] = [{ type: 'text', text: params.prompt }];
      for (const img of params.images) {
        if (Buffer.isBuffer(img)) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${img.toString('base64')}` },
          });
        } else if (img && typeof img === 'object' && 'data' in img) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType || 'image/png'};base64,${img.data}` },
          });
        }
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: params.prompt });
    }

    return this.createStructuredCompletion<T>({
      model,
      messages,
      jsonSchema: {
        name: params.schemaName || 'Output',
        schema: params.schema || { type: 'object' },
        strict: false,
      },
      timeoutMs: params.timeoutMs,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });
  }

  async generateImage(options: {
    model?: string;
    prompt: string;
    size?: string;
    timeoutMs?: number;
  }): Promise<OpenAiImageResponse> {
    const model = options.model || 'gpt-image-2.5-sunburst';
    assertModelAllowed(model);

    if (this.breaker.isOpen()) {
      throw new OpenAiCircuitBreakerOpenError();
    }

    const payload = {
      model,
      prompt: options.prompt,
      n: 1,
      size: options.size || '1024x1024',
    };

    const startTime = Date.now();
    const timeout = options.timeoutMs || this.timeoutMs;

    // T9: the image lane made a single attempt with no retry, so one dropped connection lost
    // the call outright. Same transient-network and 429/5xx handling as the text path.
    const maxAttempts = Number(process.env.HAWA_MODEL_MAX_ATTEMPTS || 6);
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      let timeoutId: any;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeout);

        const res = await this.fetcher(`${this.baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts && !isQuotaExhausted(res.status, errBody)) {
            await sleep(computeRetryDelayMs(attempt));
            continue;
          }
          this.breaker.recordFailure();
          throw new OpenAiModelHttpError(res.status, errBody);
        }

        const xRequestId = res.headers?.get?.('x-request-id') || null;
        const data: any = await res.json();
        this.breaker.recordSuccess();

        const latencyMs = Date.now() - startTime;
        const b64Json = data.data?.[0]?.b64_json;
        let imgBuffer: Buffer;
        if (b64Json) {
          imgBuffer = Buffer.from(b64Json, 'base64');
        } else if (data.data?.[0]?.url) {
          const urlRes = await this.fetcher(data.data[0].url);
          const arrayBuf = await urlRes.arrayBuffer();
          imgBuffer = Buffer.from(arrayBuf);
        } else {
          throw new Error('No image payload returned by OpenAI image generation');
        }

        const sha256 = createHash('sha256').update(imgBuffer).digest('hex');
        const costUsd = 0.04; // Standard rate for 1024x1024
        const responseId = xRequestId || `img_${data.created || Date.now()}`;

        return {
          imageBytes: imgBuffer,
          mimeType: 'image/png',
          receipt: {
            id: responseId,
            responseId,
            xRequestId,
            model,
            prompt: options.prompt,
            costUsd,
            sha256,
            latencyMs,
          },
        };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        if (err instanceof OpenAiModelHttpError) {
          throw err;
        }
        if (attempt >= maxAttempts) {
          this.breaker.recordFailure();
          throw err;
        }
        await sleep(computeRetryDelayMs(attempt));
      } finally {
        // Without this an aborted or thrown attempt leaves its abort timer pending.
        clearTimeout(timeoutId);
      }
    }

    throw new Error('Failed to complete OpenAI image generation after retries');
  }
}
