import { describe, it, expect, vi } from 'vitest';
import {
  StudioModelClient,
  StudioModelHttpError,
  StudioModelTimeoutError,
  StudioCircuitBreakerOpenError,
  CircuitBreaker,
} from '../src/studio/studio-model-client.js';

describe('Design Studio v2: Studio Model Client (studio-model-client.ts)', () => {
  const TEST_SCHEMA = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      score: { type: 'number' },
    },
    required: ['title', 'score'],
  };

  it('matches committed snapshot of official pricing table', () => {
    const client = new StudioModelClient({ apiKey: 'mock-key' });
    const pricing = (client as any).pricing;

    expect(pricing.currency).toBe('USD');
    expect(pricing.pricedAt).toBe('2026-09-14T00:00:00Z');
    expect(pricing.models['claude-fable-5-1']).toEqual({
      inputPerMillion: 10.0,
      outputPerMillion: 50.0,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 12.50,
      status: 'disabled',
    });
    expect(pricing.models['claude-opus-5']).toEqual({
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
      cacheReadPerMillion: 0.50,
      cacheWritePerMillion: 6.25,
      status: 'disabled',
    });
    expect(pricing.models['gpt-6-astra']).toEqual({
      inputPerMillion: 2.50,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 2.50,
    });
    expect(pricing.models['gpt-image-2.5-sunburst']).toEqual({
      image1k: 0.04,
      image2k: 0.08,
      image4k: 0.16,
    });
  });

  it('computes exact USD cost from pricing.json including cache creation and read tokens', () => {
    const client = new StudioModelClient({ apiKey: 'mock-key' });

    // Official 2026-09-14 pricing for claude-fable-5-1:
    // input: 10.0/M, output: 50.0/M, cacheRead: 0.25/M, cacheWrite: 12.50/M
    const cost = client.calculateCost('claude-fable-5-1', {
      input_tokens: 15_000, // 10k uncached + 5k cache read
      output_tokens: 1_000,
      cache_read_input_tokens: 5_000,
      cache_creation_input_tokens: 2_000,
    });

    // 10,000 * 10.0 / 1M = 0.1000
    // 1,000 * 50.0 / 1M = 0.0500
    // 5,000 * 0.25 / 1M = 0.00125
    // 2,000 * 12.50 / 1M = 0.0250
    // Total = 0.17625
    expect(cost).toBeCloseTo(0.17625, 5);
  });

  it('handles 429 rate limit with retry, succeeding on attempt 2', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'msg_test_429',
          model: 'claude-fable-5-1',
          content: [
            {
              type: 'tool_use',
              name: 'structured_output',
              input: { title: 'Retried Title', score: 9.5 },
            },
          ],
          usage: { input_tokens: 500, output_tokens: 100 },
        }),
      } as any;
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      retryDelaysMs: [10, 20, 30], // fast test backoff
    });

    const result = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Generate concept title',
      outputSchema: TEST_SCHEMA,
    });

    expect(callCount).toBe(2);
    expect(result.data.title).toBe('Retried Title');
    expect(result.data.score).toBe(9.5);
    expect(result.receipt.attempts).toBe(2);
    expect(result.receipt.id).toBe('msg_test_429');
  });

  it('fails immediately on 400 Bad Request without retrying', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: false,
        status: 400,
        text: async () => 'Invalid parameter in schema',
      } as any;
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      retryDelaysMs: [10, 20, 30],
    });

    await expect(
      client.callStructured({
        prompt: 'Invalid call',
        outputSchema: TEST_SCHEMA,
      })
    ).rejects.toThrowError(StudioModelHttpError);

    // Assert that exactly 1 call was made (zero retries on 400)
    expect(callCount).toBe(1);
  });

  it('throws uncertain error on timeout and records isUncertain flag', async () => {
    const fakeFetch: typeof fetch = vi.fn(async (_url: any, options: any) => {
      // Simulate timeout abort
      return new Promise((_, reject) => {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      defaultTimeoutMs: 50, // 50ms timeout
    });

    let caughtError: any = null;
    try {
      await client.callStructured({
        prompt: 'Slow call',
        outputSchema: TEST_SCHEMA,
        timeoutMs: 30,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(StudioModelTimeoutError);
    expect(caughtError.isUncertain).toBe(true);
    expect(caughtError.code).toBe('UNCERTAIN_TIMEOUT');
  });

  it('trips circuit breaker after 5 consecutive failures, fast-failing until reset timeout', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any;
    });

    const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 50 });
    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      circuitBreaker: breaker,
      maxRetries: 0, // 1 failure per call to test breaker thresholds
    });

    // Cause 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      await expect(
        client.callStructured({ prompt: `Fail ${i}`, outputSchema: TEST_SCHEMA })
      ).rejects.toThrow();
    }

    expect(breaker.getState()).toBe('open');

    // 6th call should immediately fail via circuit breaker without calling fetch
    const preCallCount = callCount;
    await expect(
      client.callStructured({ prompt: 'Fast fail', outputSchema: TEST_SCHEMA })
    ).rejects.toThrowError(StudioCircuitBreakerOpenError);
    expect(callCount).toBe(preCallCount); // fetch was NOT called

    // Wait for resetTimeoutMs (50ms) to enter half-open
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(breaker.getState()).toBe('half-open');

    // Make probe succeed
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_probe_ok',
        content: [{ type: 'tool_use', name: 'structured_output', input: { title: 'Recovered', score: 10 } }],
      }),
    } as any);

    const probeResult = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Probe call',
      outputSchema: TEST_SCHEMA,
    });

    expect(probeResult.data.title).toBe('Recovered');
    expect(breaker.getState()).toBe('closed');
  });

  it('records prompt cache tokens from response usage', async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_cached_123',
        model: 'gpt-6-astra',
        choices: [
          {
            message: {
              content: JSON.stringify({ title: 'Cached Concept', score: 8.8 }),
            },
          },
        ],
        usage: {
          prompt_tokens: 2500,
          completion_tokens: 350,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 1050,
        },
      }),
    } as any);

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
    });

    const result = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Generate concept with caching',
      systemPrompt: 'Large system prompt for caching...',
      enableCacheControl: true,
      outputSchema: TEST_SCHEMA,
    });

    expect(result.receipt.cacheCreationTokens).toBe(1200);
    expect(result.receipt.cacheReadTokens).toBe(1050);
    expect(result.receipt.inputTokens).toBe(2500);
    expect(result.receipt.outputTokens).toBe(350);
    expect(result.receipt.costUsd).toBeGreaterThan(0);
  });

  it('sends response_format format json_schema and omits anthropic-beta header', async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const fakeFetch: typeof fetch = vi.fn(async (_url: any, options: any) => {
      capturedBody = JSON.parse(options.body);
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl_schema_enforced',
          model: 'gpt-6-astra',
          choices: [
            {
              message: {
                content: JSON.stringify({ title: 'Schema Enforced Concept', score: 9.8 }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 50 },
        }),
      } as any;
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
    });

    const result = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Generate concept',
      outputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 5 },
          score: { type: 'number', minimum: 0, maximum: 10 },
        },
        required: ['title', 'score'],
      },
    });

    expect(result.data.title).toBe('Schema Enforced Concept');
    expect(result.data.score).toBe(9.8);
    expect(capturedBody.response_format).toBeDefined();
    expect(capturedBody.response_format.type).toBe('json_schema');
    expect(capturedHeaders['anthropic-beta']).toBeUndefined();
    expect(capturedHeaders['x-api-key']).toBeUndefined();
  });

  it('rejects disallowed models (claude, gemini) with DisallowedProviderError before network call', async () => {
    const fakeFetch = vi.fn();
    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
    });

    await expect(
      client.callStructured({
        model: 'claude-fable-5-1',
        prompt: 'Execute design review',
        outputSchema: TEST_SCHEMA,
      })
    ).rejects.toThrow(/DisallowedProviderError|strict OpenAI-only policy/);

    await expect(
      client.callStructured({
        model: 'gemini-3-pro-image',
        prompt: 'Generate art',
        outputSchema: TEST_SCHEMA,
      })
    ).rejects.toThrow(/DisallowedProviderError|strict OpenAI-only policy/);

    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('retries when gpt-6-astra returns 503 service unavailable, succeeding on attempt 2', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'OpenAI 503 service unavailable',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl_retry_ok',
          model: 'gpt-6-astra',
          choices: [
            {
              message: {
                content: JSON.stringify({ title: 'Recovered Title', score: 8.5 }),
              },
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 100 },
        }),
      } as any;
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      retryDelaysMs: [10, 20],
    });

    const result = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Execute design review',
      outputSchema: TEST_SCHEMA,
    });

    expect(callCount).toBe(2);
    expect(result.data.title).toBe('Recovered Title');
    expect(result.receipt.model).toBe('gpt-6-astra');
  });
});
