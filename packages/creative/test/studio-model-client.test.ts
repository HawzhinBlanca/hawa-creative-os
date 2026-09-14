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

  it('computes exact USD cost from pricing.json including cache creation and read tokens', () => {
    const client = new StudioModelClient({ apiKey: 'mock-key' });

    // For claude-fable-5-1:
    // input: 3.0/M, output: 15.0/M, cacheRead: 0.30/M, cacheWrite: 3.75/M
    const cost = client.calculateCost('claude-fable-5-1', {
      input_tokens: 15_000, // 10k uncached + 5k cache read
      output_tokens: 1_000,
      cache_read_input_tokens: 5_000,
      cache_creation_input_tokens: 2_000,
    });

    // 10,000 * 3.0 / 1M = 0.030
    // 1,000 * 15.0 / 1M = 0.015
    // 5,000 * 0.30 / 1M = 0.0015
    // 2,000 * 3.75 / 1M = 0.0075
    // Total = 0.054
    expect(cost).toBeCloseTo(0.054, 5);
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
        model: 'claude-fable-5-1',
        content: [
          {
            type: 'tool_use',
            name: 'structured_output',
            input: { title: 'Cached Concept', score: 8.8 },
          },
        ],
        usage: {
          input_tokens: 2500,
          output_tokens: 350,
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

  it('degrades to fallback model if primary model returns 503 service unavailable', async () => {
    let attemptedModel = '';
    const fakeFetch: typeof fetch = vi.fn(async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      attemptedModel = body.model;
      if (body.model === 'claude-fable-5-1') {
        return {
          ok: false,
          status: 503,
          text: async () => 'Fable 5.1 capacity exhausted',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'msg_fallback_ok',
          model: 'claude-opus-5',
          content: [
            {
              type: 'tool_use',
              name: 'structured_output',
              input: { title: 'Opus 5 Fallback Title', score: 7.5 },
            },
          ],
          usage: { input_tokens: 800, output_tokens: 150 },
        }),
      } as any;
    });

    const client = new StudioModelClient({
      apiKey: 'mock-key',
      fetchFn: fakeFetch,
      primaryModel: 'claude-fable-5-1',
      fallbackModel: 'claude-opus-5',
      retryDelaysMs: [10, 20],
    });

    const result = await client.callStructured<{ title: string; score: number }>({
      prompt: 'Execute design review',
      outputSchema: TEST_SCHEMA,
    });

    expect(result.data.title).toBe('Opus 5 Fallback Title');
    expect(result.receipt.model).toBe('claude-opus-5');
    expect(attemptedModel).toBe('claude-opus-5');
  });
});
