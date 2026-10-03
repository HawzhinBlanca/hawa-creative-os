import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertModelAllowed, modelSupportsReasoningEffort, resolveModel } from '@hawa/domain';
import { StudioReservationError, type StudioNativeInputCount } from './spending-reservation.js';
import { loadListPricing, priceTextUsage, resolveRatesForModel } from './list-price.js';
import {
  StudioModelError,
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
  /** Durable candidate count reuse, before any counting transport. Completion admission still rechecks replay. */
  retainedInputCount?: (requestSha256: string) => StudioNativeInputCount | undefined;
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' } }>;
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
    costBasis?: 'usage' | 'estimate';
    servedModel?: string | null;
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

// ADR-289 addendum: one list-price source for Studio receipts and every other text ledger.
export { resolveRatesForModel } from './list-price.js';

export class OpenAiModelHttpError extends StudioModelHttpError {
  readonly status: number;
  readonly body: string;
  readonly code: string;
  readonly isUncertain: boolean;

  constructor(status: number, body: string) {
    super(status, body);
    this.name = 'OpenAiModelHttpError';
    this.status = status;
    this.body = body;
    // A gateway/server error can arrive after the upstream model accepted the request.
    this.isUncertain = status >= 500;
    this.code = this.isUncertain ? 'UNCERTAIN_HTTP' : httpErrorCode(status, body);
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

/** A fetch rejection does not prove the provider never received the request. */
export class OpenAiModelUnknownAcceptanceError extends StudioModelError {
  readonly code = 'UNCERTAIN_ACCEPTANCE';
  readonly isUncertain = true;
  constructor(model: string, cause: unknown) {
    const detail = describeFetchCause(cause);
    super(`OpenAI ${model} request lost its connection${detail ? ` (${detail})` : ''}; acceptance and billing are unknown, so it was not retried`, 'UNCERTAIN_ACCEPTANCE');
    this.name = 'OpenAiModelUnknownAcceptanceError';
    this.cause = cause;
  }
}

/**
 * The model answered, and the call was billed, but the reply is not the JSON that was asked for.
 * Asking again costs as much and mostly fails the same way, so it is never retried; until
 * 2026-09-23 it was, up to six billed calls for one question. The message gives the reply's
 * length, never its text: a reply can quote the client's brief.
 */
export class OpenAiModelParseError extends StudioModelError {
  readonly model: string;
  readonly contentLength: number;
  readonly responseId?: string;
  readonly costUsd: number;
  readonly costBasis: 'usage' | 'estimate';
  constructor(model: string, contentLength: number, billed: { responseId?: string; costUsd?: number; costBasis?: 'usage' | 'estimate' } = {}) {
    super(
      `OpenAI ${model} replied with ${contentLength} characters that are not valid JSON; not retried, the call was billed`,
      'MODEL_OUTPUT_UNPARSEABLE'
    );
    this.name = 'OpenAiModelParseError';
    this.model = model;
    this.contentLength = contentLength;
    this.responseId = billed.responseId;
    this.costUsd = billed.costUsd ?? 0;
    this.costBasis = billed.costBasis ?? 'estimate';
  }
}

/**
 * The model stopped at the token cap (finish_reason 'length'), so its reply is cut off. Parsing a
 * partial reply either fails or, worse, yields an object missing its tail; the same cap cuts the
 * same answer again, so this is not retried either. The fix is a larger maxTokens.
 */
export class OpenAiModelTruncatedError extends StudioModelError {
  readonly model: string;
  readonly maxTokens: number;
  readonly responseId?: string;
  readonly costUsd: number;
  readonly costBasis: 'usage' | 'estimate';
  constructor(model: string, maxTokens: number, billed: { responseId?: string; costUsd?: number; costBasis?: 'usage' | 'estimate' } = {}) {
    super(
      `OpenAI ${model} stopped at its ${maxTokens}-token cap, so the reply is cut off; not retried, raise maxTokens`,
      'MODEL_OUTPUT_TRUNCATED'
    );
    this.name = 'OpenAiModelTruncatedError';
    this.model = model;
    this.maxTokens = maxTokens;
    this.responseId = billed.responseId;
    this.costUsd = billed.costUsd ?? 0;
    this.costBasis = billed.costBasis ?? 'estimate';
  }
}

/**
 * The model answered, and the call was billed, but with no answer: a safety refusal
 * (`message.refusal`, `content: null`) or no content at all. It used to become the string '{}' and
 * be returned as a successful, empty answer (2026-09-24). Like a reply that is not JSON, it is not
 * retried: the same question is refused the same way.
 */
export class OpenAiModelRefusalError extends StudioModelError {
  readonly model: string;
  readonly responseId?: string;
  readonly costUsd: number;
  readonly costBasis: 'usage' | 'estimate';
  constructor(model: string, refused: boolean, billed: { responseId?: string; costUsd?: number; costBasis?: 'usage' | 'estimate' } = {}) {
    super(
      refused
        ? `OpenAI ${model} refused to answer; not retried, the call was billed`
        : `OpenAI ${model} replied with no content; not retried, the call was billed`,
      'MODEL_REFUSED'
    );
    this.name = 'OpenAiModelRefusalError';
    this.model = model;
    this.responseId = billed.responseId;
    this.costUsd = billed.costUsd ?? 0;
    this.costBasis = billed.costBasis ?? 'estimate';
  }
}

/**
 * The response headers arrived and then the body could not be read (the socket dropped mid-body,
 * or the body was not JSON). OpenAI has most likely already done, and billed, the work, so asking
 * again would pay twice for one answer: it is reported as uncertain rather than retried.
 */
export class OpenAiModelResponseError extends StudioModelError {
  public isUncertain = true;
  readonly status: number;
  constructor(model: string, status: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const detail = describeFetchCause(cause);
    super(
      `OpenAI ${model} answered HTTP ${status} but the response could not be read (${reason}${detail ? `; ${detail}` : ''}); ` +
        `not retried, the call may have been billed`,
      'UNCERTAIN_RESPONSE'
    );
    this.name = 'OpenAiModelResponseError';
    this.status = status;
    this.cause = cause;
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

/**
 * Attempts per model call, HAWA_MODEL_MAX_ATTEMPTS or 3. Only an explicit 429 rate-limit
 * rejection is retried. A lost connection or HTTP 5xx has unknown provider acceptance.
 */
function modelMaxAttempts(): number {
  const configured = Number(process.env.HAWA_MODEL_MAX_ATTEMPTS || 3);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
}

/**
 * The JSON in a model's reply: the whole reply, or the outermost {...} when prose surrounds it.
 * undefined when there is none (JSON.parse never returns undefined, so it cannot be mistaken).
 */
function parseJsonReply(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Prose or a fence around the object; try the braces below.
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Not JSON either.
    }
  }
  return undefined;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** The reason Node's fetch hid behind "fetch failed", or an empty string. */
export function describeFetchCause(err: any): string {
  const cause = err?.cause;
  if (!cause) return '';
  const code = cause.code || cause.name || '';
  const message = typeof cause.message === 'string' ? cause.message : '';
  return [code, message && message !== code ? message : ''].filter(Boolean).join(': ').slice(0, 200);
}

function validTextUsage(usage: any): boolean {
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return count(usage.prompt_tokens ?? usage.input_tokens) && count(usage.completion_tokens ?? usage.output_tokens) &&
    count(usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) &&
    count(usage.cache_creation_input_tokens ?? 0) &&
    (usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) <= (usage.prompt_tokens ?? usage.input_tokens);
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
  private readonly retainedInputCount?: OpenAiStudioClientOptions['retainedInputCount'];
  private static readonly unpricedWarned = new Set<string>();

  constructor(options: OpenAiStudioClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = options.timeoutMs || 240000;
    this.breaker = options.circuitBreaker || new OpenAiCircuitBreaker();
    this.pricing = this.loadPricing();
    this.retainedInputCount = options.retainedInputCount;
    this.primaryModel = options.primaryModel || resolveModel('text');
    this.fallbackModel = options.fallbackModel || resolveModel('text');
  }

  get circuitBreaker() { return this.breaker; }

  /** Quote a separately admitted exact request (e.g. the Canva planner) without generating output. */
  async countImageInputTokens(body: string): Promise<StudioNativeInputCount | undefined> {
    const payload = JSON.parse(body) as { model: string; messages: OpenAiMessage[] };
    assertModelAllowed(payload.model);
    return this.countSolImages(body, payload.model, payload.messages);
  }

  /** ADR-149: native image count is bound to the unchanged completion body, before paid admission. */
  private async countSolImages(body: string, model: string, messages: OpenAiMessage[]): Promise<StudioNativeInputCount | undefined> {
    if (model !== 'gpt-6.1-sol') return undefined;
    const images = messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'image_url').map(part => {
        if (part.type !== 'image_url' || !part.image_url.url.startsWith('data:image/')) {
          throw new StudioReservationError('Sol counting requires immutable inline images.');
        }
        return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' };
      }) : []);
    if (!images.length) return undefined;
    const requestSha256 = createHash('sha256').update(body).digest('hex');
    const retained = this.retainedInputCount?.(requestSha256);
    if (retained) {
      if (retained.version !== 1 || retained.model !== model || retained.requestSha256 !== requestSha256 ||
          retained.object !== 'response.input_tokens' || !Number.isSafeInteger(retained.inputTokens) ||
          retained.inputTokens <= 0 || retained.inputTokens > 1050000) {
        throw new StudioReservationError('Retained Sol input count is invalid; no transport permitted.');
      }
      return { ...retained };
    }
    try {
      const response = await this.fetcher(`${this.baseUrl}/responses/input_tokens`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: [{ role: 'user', content: images }] }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 20000)),
      });
      if (!response.ok) throw new StudioReservationError('Sol image count was refused; no completion dispatched.');
      const count = await response.json() as { object?: unknown; input_tokens?: unknown };
      if (count.object !== 'response.input_tokens' || typeof count.input_tokens !== 'number' ||
          !Number.isSafeInteger(count.input_tokens) || count.input_tokens <= 0 || count.input_tokens > 1050000) {
        throw new StudioReservationError('Sol image count is invalid; no completion dispatched.');
      }
      return { version: 1, model: 'gpt-6.1-sol', requestSha256,
        inputTokens: count.input_tokens, object: 'response.input_tokens' };
    } catch (error) {
      if (error instanceof StudioReservationError) throw error;
      throw new StudioReservationError('Sol image count unavailable; no completion dispatched.');
    }
  }

  private loadPricing(): any {
    // ADR-289 addendum: the shared list-price table (list-price.ts), the same one every ledger uses.
    return loadListPricing();
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

    return priceTextUsage(model, rates, {
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    });
  }

  async createStructuredCompletion<T = any>(options: {
    model?: string;
    messages: OpenAiMessage[];
    jsonSchema: { name: string; schema: Record<string, any>; strict?: boolean };
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    beforeDispatch?: (body: string, nativeCount?: StudioNativeInputCount) => Promise<void>;
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
      max_completion_tokens: options.maxTokens ?? 4000,
      service_tier: 'default',
    };

    // Only reasoning models accept reasoning_effort; the others reject the whole request with a
    // 400. Callers ask for it without knowing which tier's model will answer — the dev tier's
    // critique and judge run on gpt-4.1-mini — so the client decides, once, for all of them.
    if (options.reasoningEffort && modelSupportsReasoningEffort(model)) {
      payload.reasoning_effort = options.reasoningEffort;
    } else if (/^(?:gpt-6-astra|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
      payload.reasoning_effort = 'low';
    }

    if (options.temperature !== undefined && !modelSupportsReasoningEffort(model)) {
      payload.temperature = options.temperature;
    }

    if (!Number.isSafeInteger(payload.max_completion_tokens) || payload.max_completion_tokens < 1) {
      throw new TypeError('maxTokens must be a positive safe integer.');
    }
    const body = JSON.stringify(payload);
    // Read from the frozen body, so caller mutation during counting cannot change the counted images.
    const nativeCount = await this.countSolImages(body, model, (JSON.parse(body) as { messages: OpenAiMessage[] }).messages);
    await options.beforeDispatch?.(body, nativeCount);
    const startTime = Date.now();
    const timeout = options.timeoutMs || this.timeoutMs;

    let attempt = 0;
    // Only a definite provider rejection can be retried. A fetch rejection after dispatch may mean
    // that the provider accepted and billed the work even though no response reached this process.
    const maxAttempts = modelMaxAttempts();

    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      let res: Response;
      try {
        res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (isAbortError(err)) {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        this.breaker.recordFailure();
        throw new OpenAiModelUnknownAcceptanceError(model, err);
      }

      try {
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          if (res.status === 429 && attempt < maxAttempts && !isQuotaExhausted(res.status, errBody)) {
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
        const usage = data.usage || {};
        const costUsd = validTextUsage(usage) ? this.calculateCost(data.model || model, usage) : 0;
        const responseId = typeof data.id === 'string' ? data.id : '';
        const costBasis = validTextUsage(usage) && !!resolveRatesForModel(this.pricing.models, data.model || model) ? 'usage' as const : 'estimate' as const;

        const finishReason = data.choices?.[0]?.finish_reason ?? data.stop_reason;
        if (finishReason === 'length' || finishReason === 'max_tokens') {
          throw new OpenAiModelTruncatedError(model, payload.max_completion_tokens, { responseId, costUsd, costBasis });
        }

        const toolUsePart = Array.isArray(data.content)
          ? data.content.find((b: any) => b.type === 'tool_use')?.input
          : null;
        const toolCallArg = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;

        // A refusal, or a message with neither content nor a tool call, is no answer (see OpenAiModelRefusalError).
        const message = data.choices?.[0]?.message;
        if (message && (message.refusal || (message.content == null && !toolCallArg))) {
          throw new OpenAiModelRefusalError(model, Boolean(message.refusal), { responseId, costUsd, costBasis });
        }

        const rawContent = message?.content ??
          (Array.isArray(data.content)
            ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            : (typeof data.content === 'string' ? data.content : '{}'));
        const cleanContent = rawContent.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1').trim();

        // The accepted answer may arrive as a tool payload while message.content is null. The
        // receipt hash must name the answer actually parsed, not the empty-content fallback.
        const answerText = toolUsePart && typeof toolUsePart === 'object'
          ? JSON.stringify(toolUsePart)
          : toolCallArg ? String(toolCallArg) : cleanContent;
        let parsed: any;
        if (toolUsePart && typeof toolUsePart === 'object') {
          parsed = toolUsePart;
        } else {
          // A reply that is not JSON used to become {} (no braces at all) or a retry (braces that
          // did not parse). Neither is an answer: it is reported, once.
          parsed = parseJsonReply(answerText);
          if (parsed === undefined) {
            throw new OpenAiModelParseError(model, answerText.length, { responseId, costUsd, costBasis });
          }
        }

        const sha256 = createHash('sha256').update(answerText).digest('hex');

        return {
          data: parsed,
          rawText: answerText,
          receipt: {
            id: responseId,
            responseId,
            xRequestId,
            model: data.model || model,
            inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
            outputTokens: usage.completion_tokens || usage.output_tokens || 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
            costUsd,
            costBasis,
            servedModel: typeof data.model === 'string' ? data.model : null,
            sha256,
            latencyMs,
            attempts: attempt,
          },
        };
      } catch (err: unknown) {
        if (isAbortError(err)) {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        // HTTP, parse and truncation errors are already what they should be.
        if (err instanceof StudioModelError) throw err;
        // Anything else broke after the headers arrived (a socket dropped mid-body, a body that is
        // not JSON): OpenAI has probably billed the call, so it is reported, not asked again.
        this.breaker.recordFailure();
        throw new OpenAiModelResponseError(model, res.status, err);
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
    /** Documents the model reads whole (a PDF of brand guidelines), base64 without the data: prefix. */
    files?: Array<{ filename: string; mediaType: string; data: string }>;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    beforeDispatch?: (body: string, nativeCount?: StudioNativeInputCount) => Promise<void>;
  }): Promise<{ data: T; rawText: string; receipt: any }> {
    const model = params.model || this.primaryModel;
    assertModelAllowed(model);
    const messages: OpenAiMessage[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    if ((params.images && params.images.length > 0) || (params.files && params.files.length > 0)) {
      const parts: any[] = [{ type: 'text', text: params.prompt }];
      for (const file of params.files || []) {
        parts.push({ type: 'file', file: { filename: file.filename, file_data: `data:${file.mediaType};base64,${file.data}` } });
      }
      for (const img of params.images || []) {
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
      beforeDispatch: params.beforeDispatch,
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

    // A dropped image request may have been accepted. Keep it uncertain rather than paying again.
    const maxAttempts = modelMaxAttempts();
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      let res: Response;
      try {
        res = await this.fetcher(`${this.baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (isAbortError(err)) {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        this.breaker.recordFailure();
        throw new OpenAiModelUnknownAcceptanceError(model, err);
      }

      try {
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          if (res.status === 429 && attempt < maxAttempts && !isQuotaExhausted(res.status, errBody)) {
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
          const urlRes = await this.fetcher(data.data[0].url, { signal: controller.signal });
          if (!urlRes.ok) throw new Error(`the generated image's URL answered HTTP ${urlRes.status}`);
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
      } catch (err: unknown) {
        if (isAbortError(err)) {
          this.breaker.recordFailure();
          throw new OpenAiModelTimeoutError(timeout);
        }
        if (err instanceof StudioModelError) throw err;
        // The generation was answered, so it was probably billed: a body that broke, an image
        // that could not be downloaded or an answer without one is reported, not generated again.
        this.breaker.recordFailure();
        throw new OpenAiModelResponseError(model, res.status, err);
      } finally {
        // Without this an aborted or thrown attempt leaves its abort timer pending.
        clearTimeout(timeoutId);
      }
    }

    throw new Error('Failed to complete OpenAI image generation after retries');
  }
}
