import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { reserveStudioText, reserveStudioImage } from '../src/studio/spending-reservation.js';
import { OpenAiStudioClient } from '../src/studio/openai-studio-client.js';

const textBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'gpt-6-astra',
  service_tier: 'default', messages: [{ role: 'user', content: 'Hello' }],
  response_format: { type: 'json_schema', json_schema: { name: 'test', schema: { type: 'object' } } },
  max_completion_tokens: 4000, ...extra });
const imageBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'gpt-image-2.5-sunburst',
  prompt: 'A text-free abstract image', n: 1, size: '1024x1024', quality: 'auto', ...extra });

describe('Studio request reservation policy', () => {
  it('counts multilingual bytes, schema, framing and declared output independently', () => {
    const a = reserveStudioText(textBody()), prompt = 'سڵاو بالعربية'.repeat(100);
    const b = reserveStudioText(textBody({ messages: [{ role: 'user', content: prompt }] }));
    expect(b.inputTokens - a.inputTokens).toBe(2 * (Buffer.byteLength(prompt) - 5));
    expect(reserveStudioText(textBody({ max_completion_tokens: 8000 })).usd - a.usd).toBeCloseTo(0.3, 6);
    const schema = reserveStudioText(textBody({ response_format: { description: 'x'.repeat(30000) } }));
    expect(schema.inputTokens).toBeGreaterThan(60000);
  });
  it.each([{ model: 'unpriced' }, { model: 'gpt-6-astra-ultra' }, { max_completion_tokens: 0 },
    { max_completion_tokens: 1.2 }, { service_tier: 'priority' }, { tools: [{}] },
    { messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file_test' } }] }] }])
    ('rejects requests without a qualified cost bound: %j', extra => {
      expect(() => reserveStudioText(textBody(extra))).toThrow();
    });
  it('covers remote vision at the detail maximum and never changes image fidelity', () => {
    const withDetail = (detail: string) => textBody({ messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.test/photo.png', detail } },
    ] }] });
    expect(reserveStudioText(withDetail('auto')).inputTokens).toBe(reserveStudioText(withDetail('original')).inputTokens);
    expect(reserveStudioText(withDetail('high')).usd).toBeLessThan(reserveStudioText(withDetail('original')).usd);
  });
  it('reserves maximum auto quality and size and refuses invalid dimensions', () => {
    expect(reserveStudioImage('openai', imageBody()).usd)
      .toBe(reserveStudioImage('openai', imageBody({ quality: 'max' })).usd);
    expect(reserveStudioImage('openai', imageBody({ size: 'auto' })).usd)
      .toBeGreaterThan(reserveStudioImage('openai', imageBody()).usd);
    expect(reserveStudioImage('openai', imageBody({ quality: 'low' })).usd)
      .toBeLessThan(reserveStudioImage('openai', imageBody()).usd);
    for (const size of ['1025x1024', '9999x9999', '256x256', '3840x3840']) {
      expect(() => reserveStudioImage('openai', imageBody({ size }))).toThrow();
    }
  });
  it('includes all possible Google output, including thinking, rather than a per-image price alone', () => {
    const q = reserveStudioImage('google', JSON.stringify({ model: 'gemini-3.1-flash-lite-image',
      input: [{ type: 'text', text: 'texture' }], response_format: { type: 'image', image_size: '1K' } }));
    expect(q.outputTokens).toBe(4096); expect(q.usd).toBeGreaterThan(4096 * 30 / 1e6);
    expect(q.usd).toBeGreaterThan(0.0336);
  });
});

describe('serialized dispatch and receipt evidence', () => {
  const answer = (usage?: unknown) => new Response(JSON.stringify({ id: 'reply', model: 'gpt-6-astra',
    choices: [{ message: { content: '{"ok":true}' } }], usage }), { status: 200 });
  const params = { model: 'gpt-6-astra', prompt: 'Hello', maxTokens: 200 };
  it('prices the full Astra request at long-context rates above 272K input tokens', () => {
    const client = new OpenAiStudioClient({ apiKey: 'test' });
    expect(client.calculateCost('gpt-6-astra', { prompt_tokens: 272000, completion_tokens: 1000 })).toBe(2.77);
    expect(client.calculateCost('gpt-6-astra', { prompt_tokens: 300000, completion_tokens: 1000 })).toBe(6.075);
  });
  it('sends exactly the admitted bytes even if the caller changes its input during admission', async () => {
    let body = '', quotedHash = '';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body); return answer({ prompt_tokens: 10, completion_tokens: 5 });
    });
    const client = new OpenAiStudioClient({ fetcher: fetcher as typeof fetch, apiKey: 'test' });
    const options = { ...params, beforeDispatch: async (serialized: string) => {
      quotedHash = reserveStudioText(serialized).requestSha256;
      options.prompt = 'Changed during database wait'; options.maxTokens = 99999;
    } };
    const result = await client.completeJson(options);
    expect(createHash('sha256').update(body).digest('hex')).toBe(quotedHash);
    expect(JSON.parse(body)).toMatchObject({ max_completion_tokens: 200, service_tier: 'default' });
    expect(body).not.toContain('Changed during'); expect(result.receipt.costBasis).toBe('usage');
  });
  it('does not dispatch when admission refuses', async () => {
    const fetcher = vi.fn(); const client = new OpenAiStudioClient({ fetcher, apiKey: 'test' });
    await expect(client.completeJson({ ...params, beforeDispatch: async () => { throw new Error('budget refused'); } }))
      .rejects.toThrow('budget refused');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reserves once when retrying an explicit rate-limit rejection', async () => {
    const beforeDispatch = vi.fn(async (body: string) => { reserveStudioText(body); });
    let requests = 0;
    const fetcher = vi.fn(async () => ++requests === 1
      ? new Response('rate limited', { status: 429 }) : answer({ prompt_tokens: 10, completion_tokens: 5 }));
    const client = new OpenAiStudioClient({ fetcher, apiKey: 'test' });
    const result = await client.completeJson({ ...params, beforeDispatch });
    expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.receipt.attempts).toBe(2);
  });
  it.each([undefined, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1 }])
    ('retains the reservation when successful output lacks complete valid usage: %j', async usage => {
      const client = new OpenAiStudioClient({ fetcher: vi.fn(async () => answer(usage)), apiKey: 'test' });
      const result = await client.completeJson(params);
      expect(result.receipt.costBasis).toBe('estimate'); expect(result.receipt.costUsd).toBe(0);
    });
  it('does not manufacture provider response/model identifiers', async () => {
    const client = new OpenAiStudioClient({ apiKey: 'test', fetcher: vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))) });
    const result = await client.completeJson(params);
    expect(result.receipt.responseId).toBe(''); expect(result.receipt.servedModel).toBeNull();
  });
});
