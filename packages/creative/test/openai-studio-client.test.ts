import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenAiStudioClient,
  OpenAiModelHttpError,
  OpenAiModelTimeoutError,
  OpenAiModelParseError,
  OpenAiModelTruncatedError,
  OpenAiModelResponseError,
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

/**
 * Only a request that got no answer is asked again. Until 2026-09-23 a reply that was not JSON, or
 * a body that broke after the headers, was retried like a dropped socket: up to six billed calls
 * for one question.
 */
describe('OpenAiStudioClient retries only what was never answered', () => {
  const SCHEMA = { name: 'plan', schema: { type: 'object' }, strict: false };
  const ask = (fetcher: ReturnType<typeof vi.fn>) =>
    new OpenAiStudioClient({ apiKey: 'test-key', fetcher: fetcher as unknown as typeof fetch }).createStructuredCompletion({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'test' }],
      jsonSchema: SCHEMA,
      maxTokens: 1234,
    });
  const answer = (choice: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'chatcmpl_x', choices: [choice], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws a reply that is not JSON once, without asking again, and without echoing it', async () => {
    const reply = 'I cannot produce that layout {because: the brief is unclear}';
    const fetcher = vi.fn().mockResolvedValue(answer({ message: { content: reply }, finish_reason: 'stop' }));
    const err = await ask(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiModelParseError);
    expect(err).toMatchObject({ code: 'MODEL_OUTPUT_UNPARSEABLE', contentLength: reply.length, responseId: 'chatcmpl_x' });
    expect((err as Error).message).not.toContain('brief is unclear');
    expect((err as OpenAiModelParseError).costUsd).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws a reply with no JSON at all instead of returning an empty object', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer({ message: { content: 'Sorry, I cannot help with that.' }, finish_reason: 'stop' }));
    await expect(ask(fetcher)).rejects.toBeInstanceOf(OpenAiModelParseError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still reads JSON wrapped in prose or a fence', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer({ message: { content: 'Here it is:\n```json\n{"headline":"OK"}\n```' }, finish_reason: 'stop' }));
    const res = await ask(fetcher);
    expect(res.data).toEqual({ headline: 'OK' });
  });

  it('throws a reply cut off at the token cap instead of parsing it', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer({ message: { content: '{"headline":"Cut o' }, finish_reason: 'length' }));
    const err = await ask(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiModelTruncatedError);
    expect(err).toMatchObject({ code: 'MODEL_OUTPUT_TRUNCATED', maxTokens: 1234 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry a body that breaks after the headers arrived', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } });
      },
    });
    const err = await ask(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiModelResponseError);
    expect(err).toMatchObject({ code: 'UNCERTAIN_RESPONSE', status: 200, isUncertain: true });
    expect((err as Error).message).toContain('UND_ERR_SOCKET');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a request that got no answer, three times by default', async () => {
    vi.stubEnv('HAWA_MODEL_MAX_ATTEMPTS', '');
    vi.stubEnv('HAWA_RETRY_DELAY_MS', '1');
    const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
    const fetcher = vi.fn().mockRejectedValue(dropped);
    await expect(ask(fetcher)).rejects.toThrow(/fetch failed \(ECONNRESET: socket hang up\) after 3 attempts/);
    expect(fetcher).toHaveBeenCalledTimes(3);

    const recovers = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(answer({ message: { content: '{"headline":"OK"}' }, finish_reason: 'stop' }));
    const res = await ask(recovers);
    expect(res.data).toEqual({ headline: 'OK' });
    expect(res.receipt.attempts).toBe(2);
  });

  it('keeps an override of the attempt count', async () => {
    vi.stubEnv('HAWA_MODEL_MAX_ATTEMPTS', '1');
    const fetcher = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(ask(fetcher)).rejects.toThrow('fetch failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still turns an abort into a timeout, without retrying', async () => {
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(ask(fetcher)).rejects.toBeInstanceOf(OpenAiModelTimeoutError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not generate an image again when the answer could not be read', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    const client = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: fetcher as unknown as typeof fetch });
    await expect(client.generateImage({ model: 'gpt-image-2.5-sunburst', prompt: 'navy texture' })).rejects.toBeInstanceOf(OpenAiModelResponseError);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const noImage = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ created: 1, data: [] }) });
    const empty = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: noImage as unknown as typeof fetch });
    await expect(empty.generateImage({ model: 'gpt-image-2.5-sunburst', prompt: 'navy texture' })).rejects.toThrow(/No image payload/);
    expect(noImage).toHaveBeenCalledTimes(1);
  });
});
