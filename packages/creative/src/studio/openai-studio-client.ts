import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertModelAllowed } from '@hawa/domain';
import {
  StudioModelHttpError,
  StudioModelTimeoutError,
  StudioCircuitBreakerOpenError,
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

export class OpenAiModelHttpError extends StudioModelHttpError {
  readonly status: number;
  readonly body: string;
  readonly code: string;

  constructor(status: number, body: string) {
    super(status, body);
    this.name = 'OpenAiModelHttpError';
    this.status = status;
    this.body = body;
    this.code = status === 429 ? 'RATE_LIMIT_EXCEEDED' : `HTTP_${status}`;
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

export class OpenAiStudioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  public readonly primaryModel: string;
  public readonly fallbackModel: string;
  private readonly timeoutMs: number;
  private readonly breaker: any;
  private readonly pricing: any;

  constructor(options: OpenAiStudioClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = options.timeoutMs || 90000;
    this.breaker = options.circuitBreaker || new OpenAiCircuitBreaker();
    this.pricing = this.loadPricing();
    this.primaryModel = options.primaryModel || 'gpt-6-astra';
    this.fallbackModel = options.fallbackModel || 'gpt-6-astra';
  }

  get circuitBreaker() { return this.breaker; }

  private loadPricing(): any {
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const pricingPath = path.join(currentDir, 'pricing.json');
      if (fs.existsSync(pricingPath)) {
        return JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
      }
    } catch {
      // Fallback defaults
    }
    return {
      currency: 'USD',
      models: {
        'gpt-6-astra': { inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 1.0, cacheWritePerMillion: 12.5 },
        'gpt-image-2.5-sunburst': { outputPerMillionImageTokens: 30.0, image1k: 0.04, image2k: 0.08, image4k: 0.16 },
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
    const rates = this.pricing.models?.[model] || this.pricing.models?.['gpt-6-astra'];
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
  }): Promise<OpenAiStructuredResponse<T>> {
    const model = options.model || 'gpt-6-astra';
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

    if (options.temperature !== undefined && model !== 'gpt-6-astra') {
      payload.temperature = options.temperature;
    }

    const startTime = Date.now();
    const timeout = options.timeoutMs || this.timeoutMs;

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
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
          if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
            const delay = process.env.NODE_ENV === 'test' ? 10 * attempt : Math.pow(2, attempt) * 1000;
            await new Promise((r) => setTimeout(r, delay));
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
    const model = params.model || 'gpt-6-astra';
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

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

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
      throw err;
    }
  }
}
