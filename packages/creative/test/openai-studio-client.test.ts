import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiStudioClient,
  OpenAiModelHttpError,
  OpenAiModelTimeoutError,
} from '../src/studio/openai-studio-client.js';
import { DisallowedProviderError } from '@hawa/domain';

describe('OpenAiStudioClient (ADR-030, G01, G02)', () => {
  const TEST_SCHEMA = {
    name: 'test_plan',
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        rating: { type: 'number' },
      },
      required: ['headline', 'rating'],
      additionalProperties: false,
    },
    strict: true,
  };

  it('rejects disallowed Claude and Gemini models before making network requests', async () => {
    const fetcher = vi.fn();
    const client = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: fetcher as any });

    await expect(
      client.createStructuredCompletion({
        model: 'claude-fable-5-1',
        messages: [{ role: 'user', content: 'test' }],
        jsonSchema: TEST_SCHEMA,
      })
    ).rejects.toThrow(DisallowedProviderError);

    await expect(
      client.createStructuredCompletion({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'test' }],
        jsonSchema: TEST_SCHEMA,
      })
    ).rejects.toThrow(DisallowedProviderError);

    await expect(
      client.generateImage({
        model: 'gemini-3-pro-image',
        prompt: 'test',
      })
    ).rejects.toThrow(DisallowedProviderError);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('successfully executes gpt-6-astra structured completion with schema enforcement', async () => {
    const mockResponsePayload = {
      id: 'chatcmpl_astra_test_123',
      model: 'gpt-6-astra',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              headline: 'KAAE Academic Standards 2026',
              rating: 9.5,
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 250,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    };

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponsePayload,
    });

    const client = new OpenAiStudioClient({
      apiKey: 'test-key',
      fetcher: fetcher as any,
    });

    const res = await client.createStructuredCompletion({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'Design a post' }],
      jsonSchema: TEST_SCHEMA,
    });

    expect(res.data.headline).toBe('KAAE Academic Standards 2026');
    expect(res.data.rating).toBe(9.5);
    expect(res.receipt.responseId).toBe('chatcmpl_astra_test_123');
    expect(res.receipt.model).toBe('gpt-6-astra');
    expect(res.receipt.inputTokens).toBe(1200);
    expect(res.receipt.outputTokens).toBe(250);
    expect(res.receipt.reasoningTokens).toBe(100);
    expect(res.receipt.costUsd).toBeGreaterThan(0);
    expect(res.receipt.sha256).toBeDefined();

    // Verify outbound request shape
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"model":"gpt-6-astra"'),
      })
    );
  });

  it('successfully generates image with gpt-image-2.5-sunburst and records receipt', async () => {
    const fakeImageBase64 = Buffer.from('fake-png-data').toString('base64');
    const mockResponsePayload = {
      created: 1789464000,
      data: [{ b64_json: fakeImageBase64 }],
    };

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponsePayload,
    });

    const client = new OpenAiStudioClient({
      apiKey: 'test-key',
      fetcher: fetcher as any,
    });

    const res = await client.generateImage({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'Minimal navy background texture',
      size: '1024x1024',
    });

    expect(res.imageBytes.toString()).toBe('fake-png-data');
    expect(res.mimeType).toBe('image/png');
    expect(res.receipt.model).toBe('gpt-image-2.5-sunburst');
    expect(res.receipt.responseId).toContain('img_');
    expect(res.receipt.costUsd).toBe(0.04);
    expect(res.receipt.sha256).toBeDefined();
  });

  it('handles 429 rate limit with retries', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: 'chatcmpl_retry_ok',
          choices: [{ message: { content: '{"headline":"OK","rating":10}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      };
    });

    const client = new OpenAiStudioClient({
      apiKey: 'test-key',
      fetcher: fetcher as any,
    });

    const res = await client.createStructuredCompletion({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'test' }],
      jsonSchema: TEST_SCHEMA,
    });

    expect(callCount).toBe(2);
    expect(res.data.headline).toBe('OK');
  });

  it('never retries an account out of credits, and names it rather than calling it a rate limit', async () => {
    // The 2026-09-18 qualification retried "You have no credits remaining" for about a minute a
    // call, then reported it as RATE_LIMIT_EXCEEDED.
    const outOfCredits = () =>
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: {
              message: 'You have no credits remaining. Add credits to continue using the API.',
              type: 'insufficient_quota',
              code: 'insufficient_quota',
            },
          }),
      });

    const textFetcher = outOfCredits();
    const text = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: textFetcher as any });
    await expect(
      text.createStructuredCompletion({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'test' }], jsonSchema: TEST_SCHEMA })
    ).rejects.toMatchObject({ status: 429, code: 'INSUFFICIENT_QUOTA' });
    expect(textFetcher).toHaveBeenCalledTimes(1);

    const imageFetcher = outOfCredits();
    const image = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: imageFetcher as any });
    await expect(
      image.generateImage({ model: 'gpt-image-2.5-sunburst', prompt: 'Minimal navy background texture', size: '1024x1024' })
    ).rejects.toMatchObject({ status: 429, code: 'INSUFFICIENT_QUOTA' });
    expect(imageFetcher).toHaveBeenCalledTimes(1);
  });

  it('still retries a rate limit, and names it one when it persists', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }),
    });
    const client = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: fetcher as any });
    await expect(
      client.createStructuredCompletion({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'test' }], jsonSchema: TEST_SCHEMA })
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });
});
