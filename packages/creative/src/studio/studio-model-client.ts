import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertModelAllowed } from '@hawa/domain';
import { OpenAiStudioClient } from './openai-studio-client.js';
import {
  StudioModelError,
  StudioModelHttpError,
  StudioModelTimeoutError,
  StudioCircuitBreakerOpenError,
} from './studio-errors.js';

export {
  StudioModelError,
  StudioModelHttpError,
  StudioModelTimeoutError,
  StudioCircuitBreakerOpenError,
};

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface PricingConfig {
  pricedAt: string;
  currency: string;
  models: Record<string, ModelPricing>;
}

export interface StudioCallReceipt {
  id: string;
  provider: 'anthropic';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
  attempts: number;
  timestamp: string;
}

export interface StructuredCallParams<T> {
  prompt: string;
  systemPrompt?: string;
  system?: string;
  outputSchema?: Record<string, any>;
  schema?: Record<string, any>;
  schemaName?: string;
  images?: Array<Buffer | { mediaType: 'image/png' | 'image/jpeg'; data: string }>;
  model?: string;
  fallbackModel?: string;
  maxTokens?: number;
  temperature?: number;
  enableCacheControl?: boolean;
  timeoutMs?: number;
}

export interface StructuredCallResult<T> {
  data: T;
  rawText?: string;
  receipt: StudioCallReceipt;
}

/**
 * Deeply sanitizes JSON Schema for Anthropic structured outputs format.
 * Sets additionalProperties: false on all object definitions and strips unsupported keywords
 * (minimum, maximum, minLength, maxLength, pattern, format, minItems, maxItems, uniqueItems, multipleOf).
 */
export function sanitizeSchemaForAnthropic(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForAnthropic);
  }

  const disallowedKeywords = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'uniqueItems',
    'multipleOf',
    '$schema',
  ]);

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (disallowedKeywords.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeSchemaForAnthropic(val);
  }

  if (sanitized.type === 'object' || sanitized.properties) {
    sanitized.type = 'object';
    sanitized.additionalProperties = false;
  }

  return sanitized;
}
export * from './studio-errors.js';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default 5
  resetTimeoutMs?: number; // default 60000 (60s)
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 60000;
  }

  public getState(): CircuitBreakerState {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open';
      }
    }
    return this.state;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  public recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  public getStats() {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  public reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}

function loadPricingConfig(): PricingConfig {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const pricingPath = path.join(currentDir, 'pricing.json');
  if (fs.existsSync(pricingPath)) {
    return JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
  }
  // Fallback defaults if pricing.json is absent
  return {
    pricedAt: '2026-09-14T00:00:00Z',
    currency: 'USD',
    models: {
      'claude-fable-5-1': {
        inputPerMillion: 10.0,
        outputPerMillion: 50.0,
        cacheReadPerMillion: 0.25,
        cacheWritePerMillion: 12.50,
      },
      'claude-opus-5': {
        inputPerMillion: 5.0,
        outputPerMillion: 25.0,
        cacheReadPerMillion: 0.50,
        cacheWritePerMillion: 6.25,
      },
    },
  };
}

export interface StudioModelClientOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  pricingConfig?: PricingConfig;
  circuitBreaker?: CircuitBreaker;
  maxRetries?: number; // default 3
  retryDelaysMs?: number[]; // default [1000, 3000, 9000]
  defaultTimeoutMs?: number; // default 120000 (120s)
  primaryModel?: string; // default 'gpt-6-astra'
  fallbackModel?: string; // default 'gpt-6-astra'
}

export class StudioModelClient {
  private apiKey: string;
  private fetchFn: typeof fetch;
  private pricing: PricingConfig;
  public circuitBreaker: CircuitBreaker;
  private maxRetries: number;
  private retryDelaysMs: number[];
  private defaultTimeoutMs: number;
  public primaryModel: string;
  public fallbackModel: string;

  constructor(options?: StudioModelClientOptions) {
    this.apiKey = options?.apiKey || process.env.OPENAI_API_KEY || '';
    this.fetchFn = options?.fetchFn || fetch;
    this.pricing = options?.pricingConfig || loadPricingConfig();
    this.circuitBreaker = options?.circuitBreaker || new CircuitBreaker();
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelaysMs = options?.retryDelaysMs ?? [1000, 3000, 9000];
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 120000;
    this.primaryModel = options?.primaryModel || 'gpt-6-astra';
    this.fallbackModel = options?.fallbackModel || 'gpt-6-astra';
  }

  /**
   * Computes cost in USD from token usage and pricing.json rules.
   */
  public calculateCost(
    model: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  ): number {
    const modelPrice = this.pricing.models[model] || this.pricing.models[this.primaryModel] || {
      inputPerMillion: 10.0,
      outputPerMillion: 50.0,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 12.50,
    };

    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
    const regularInputTokens = Math.max(0, usage.input_tokens - cacheReadTokens);
    const outputTokens = usage.output_tokens || 0;

    const inputCost = (regularInputTokens * modelPrice.inputPerMillion) / 1_000_000;
    const outputCost = (outputTokens * modelPrice.outputPerMillion) / 1_000_000;
    const cacheReadCost = (cacheReadTokens * modelPrice.cacheReadPerMillion) / 1_000_000;
    const cacheWriteCost = (cacheWriteTokens * modelPrice.cacheWritePerMillion) / 1_000_000;

    const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    return Number(total.toFixed(6));
  }

  /**
   * Invokes Anthropic API to generate structured JSON output matching outputSchema.
   */
  public async callStructured<T>(params: StructuredCallParams<T>): Promise<StructuredCallResult<T>> {
    const selectedModel = params.model || this.primaryModel;
    assertModelAllowed(selectedModel);

    const breakerState = this.circuitBreaker.getState();
    if (breakerState === 'open') {
      throw new StudioCircuitBreakerOpenError('openai');
    }

    if (selectedModel === 'gpt-6-astra' || selectedModel.startsWith('gpt-')) {
      const openAiClient = new OpenAiStudioClient({
        apiKey: process.env.OPENAI_API_KEY || this.apiKey,
        fetcher: this.fetchFn,
        timeoutMs: params.timeoutMs || this.defaultTimeoutMs,
        circuitBreaker: this.circuitBreaker,
      });

      const res = await openAiClient.completeJson<T>({
        system: params.systemPrompt || params.system,
        prompt: params.prompt,
        schema: params.outputSchema || params.schema,
        schemaName: params.schemaName || 'structured_output',
        model: selectedModel,
        images: params.images,
        timeoutMs: params.timeoutMs || this.defaultTimeoutMs,
        temperature: params.temperature,
      });

      this.circuitBreaker.recordSuccess();

      return {
        data: res.data,
        rawText: res.rawText,
        receipt: {
          id: res.receipt.responseId,
          provider: 'openai' as any,
          model: res.receipt.model,
          inputTokens: res.receipt.inputTokens,
          outputTokens: res.receipt.outputTokens,
          cacheCreationTokens: res.receipt.cacheCreationTokens || 0,
          cacheReadTokens: res.receipt.cacheReadTokens || 0,
          costUsd: res.receipt.costUsd,
          durationMs: res.receipt.latencyMs,
          attempts: res.receipt.attempts || 1,
          timestamp: new Date().toISOString(),
        },
      };
    }


    const fallbackModel = params.fallbackModel || this.fallbackModel;
    const timeoutMs = params.timeoutMs || this.defaultTimeoutMs;
    const schemaName = params.schemaName || 'structured_output';
    const systemPrompt = params.systemPrompt || params.system;
    const outputSchema = params.outputSchema || params.schema;

    if (!outputSchema) {
      throw new Error('outputSchema or schema parameter is required');
    }

    let currentModel = selectedModel;
    let attempt = 0;
    let lastError: any = null;

    const startTime = Date.now();

    while (attempt <= this.maxRetries) {
      attempt++;

      try {
        const result = await this.executeRawRequest<T>({
          model: currentModel,
          prompt: params.prompt,
          systemPrompt,
          outputSchema,
          schemaName,
          images: params.images,
          maxTokens: params.maxTokens || 8192,
          temperature: params.temperature,
          enableCacheControl: params.enableCacheControl ?? true,
          timeoutMs,
          attempt,
        });

        this.circuitBreaker.recordSuccess();
        return result;
      } catch (err: any) {
        lastError = err;

        // Never retry on 4xx client errors (except 408/429)
        if (err instanceof StudioModelHttpError) {
          const status = err.status;
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            this.circuitBreaker.recordFailure();
            throw err;
          }

          // If 404 or 503 on primary model, switch to fallback model
          if ((status === 404 || status === 503) && currentModel !== fallbackModel) {
            console.warn(`[StudioModelClient] Model ${currentModel} returned HTTP ${status}. Degrading to ${fallbackModel}.`);
            currentModel = fallbackModel;
          }
        }

        if (err instanceof StudioModelTimeoutError) {
          // Unfinished call after timeout is journaled uncertain and never retried automatically
          this.circuitBreaker.recordFailure();
          throw err;
        }

        this.circuitBreaker.recordFailure();

        // If attempts exhausted, fail out
        if (attempt > this.maxRetries) {
          break;
        }

        // Calculate backoff delay with jitter
        const delayIdx = Math.min(attempt - 1, this.retryDelaysMs.length - 1);
        const baseDelay = this.retryDelaysMs[delayIdx];
        const jitter = Math.floor(Math.random() * 250);
        const delayMs = baseDelay + jitter;

        console.warn(`[StudioModelClient] Attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new StudioModelError('Failed all model call attempts', 'MAX_RETRIES_EXCEEDED');
  }

  public async completeJson<T>(params: StructuredCallParams<T>): Promise<StructuredCallResult<T>> {
    return this.callStructured<T>(params);
  }

  private async executeRawRequest<T>(options: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    outputSchema: Record<string, any>;
    schemaName: string;
    images?: Array<Buffer | { mediaType: 'image/png' | 'image/jpeg'; data: string }>;
    maxTokens: number;
    temperature?: number;
    enableCacheControl: boolean;
    timeoutMs: number;
    attempt: number;
  }): Promise<StructuredCallResult<T>> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const schemaInstruction = `You are an expert design intelligence engine for Design Studio v2. You MUST produce strictly valid JSON complying with the provided JSON Schema.
OUTPUT INSTRUCTIONS:
- Reply with a single raw JSON object matching the JSON Schema.
- Do NOT wrap your output in markdown formatting, code blocks, or backticks (\`\`\`json).
- Do NOT output any preamble, conversational commentary, or trailing text.

JSON Schema:
${JSON.stringify(options.outputSchema, null, 2)}`;

      const fullSystemText = options.systemPrompt
        ? `${options.systemPrompt.trim()}\n\n${schemaInstruction}`
        : schemaInstruction;

      const systemBlocks: any[] = [
        {
          type: 'text',
          text: fullSystemText,
        },
      ];

      if (options.enableCacheControl) {
        systemBlocks[0].cache_control = { type: 'ephemeral' };
      }

      let userContent: any = options.prompt;
      if (options.images && options.images.length > 0) {
        const contentBlocks: any[] = [];
        for (const img of options.images) {
          if (Buffer.isBuffer(img)) {
            let mediaType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png';
            if (img.length > 2 && img[0] === 0xff && img[1] === 0xd8) {
              mediaType = 'image/jpeg';
            } else if (img.length > 12 && img.toString('ascii', 8, 12) === 'WEBP') {
              mediaType = 'image/webp';
            }
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: img.toString('base64'),
              },
            });
          } else {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.data,
              },
            });
          }
        }
        contentBlocks.push({
          type: 'text',
          text: options.prompt,
        });
        userContent = contentBlocks;
      }

      const sanitizedSchema = sanitizeSchemaForAnthropic(options.outputSchema);

      const requestBody: any = {
        model: options.model,
        max_tokens: options.maxTokens,
        system: systemBlocks,
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: sanitizedSchema,
          },
        },
      };

      if (!options.model.includes('fable') && !options.model.includes('opus') && options.temperature !== undefined) {
        requestBody.temperature = options.temperature;
      }

      const headers: Record<string, string> = {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };

      const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new StudioModelHttpError(res.status, errText);
      }

      const json = (await res.json()) as any;
      const durationMs = Date.now() - startTime;

      // Extract tool use structured output
      let data: T | null = null;
      let rawText = '';

      if (Array.isArray(json.content)) {
        for (const part of json.content) {
          if (part.type === 'tool_use' && part.name === options.schemaName) {
            data = part.input as T;
          } else if (part.type === 'text') {
            rawText += part.text;
          }
        }
      }

      // If tool_use wasn't parsed directly, try parsing raw text
      if (!data && rawText) {
        const clean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
          data = JSON.parse(clean);
        } catch {
          const firstBrace = clean.indexOf('{');
          const lastBrace = clean.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
              data = JSON.parse(clean.slice(firstBrace, lastBrace + 1));
            } catch {
              // ignore
            }
          }
        }
      }

      if (!data) {
        console.warn(
          `[StudioModelClient] Structured output missing for ${options.schemaName}: stop_reason=${json.stop_reason}, rawLength=${rawText.length}, contentTypes=${json.content?.map((c: any) => c.type).join(',')}. Head: ${rawText.substring(0, 150)} ... Tail: ${rawText.substring(Math.max(0, rawText.length - 150))}`
        );
        throw new StudioModelError(
          `Anthropic did not return structured tool output for schema ${options.schemaName} (stop_reason: ${json.stop_reason})`,
          'STRUCTURED_OUTPUT_MISSING'
        );
      }

      const usage = json.usage || {};
      const receipt: StudioCallReceipt = {
        id: json.id || `msg_local_${Date.now()}`,
        provider: 'anthropic',
        model: json.model || options.model,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        costUsd: this.calculateCost(json.model || options.model, usage),
        durationMs,
        attempts: options.attempt,
        timestamp: new Date().toISOString(),
      };

      return {
        data,
        rawText,
        receipt,
      };
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new StudioModelTimeoutError(`Model call timed out after ${options.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
