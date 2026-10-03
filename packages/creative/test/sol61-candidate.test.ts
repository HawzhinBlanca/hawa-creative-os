import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { OpenAiStudioClient } from '../src/studio/openai-studio-client.js';
import { reserveStudioText, studioTextUsage, studioTextModelMatches } from '../src/studio/spending-reservation.js';
import { calculateCallCost } from '../src/studio/cost-architecture-v3.js';

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
  model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'سڵاو Hello' }],
  response_format: { type: 'json_schema', json_schema: { name: 'test', schema: { type: 'object' } } },
  max_completion_tokens: 4000, service_tier: 'default', reasoning_effort: 'low', ...extra,
});

describe('ADR-148 Sol 6.1 candidate transport and budget', () => {
  beforeEach(() => { vi.stubEnv('HAWA_MODEL_TIER', 'dev'); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('preserves explicit low reasoning, omits unsupported temperature and sends admitted bytes', async () => {
    let quoted = '';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(quoted);
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'low', service_tier: 'default' });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
      return new Response(JSON.stringify({ id: 'synthetic', model: 'gpt-6.1-sol',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
    });
    const client = new OpenAiStudioClient({ apiKey: 'fixture', fetcher });
    const result = await client.createStructuredCompletion({ model: 'gpt-6.1-sol', temperature: 0.3,
      messages: [{ role: 'user', content: 'Hello' }], jsonSchema: { name: 'test', schema: { type: 'object' } },
      maxTokens: 4000, beforeDispatch: async b => { reserveStudioText(b); quoted = b; } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.receipt.costUsd).toBe(0.0007);
    expect(result.receipt.servedModel).toBe('gpt-6.1-sol');
  });

  it('prices standard, cache and whole-request long context at Sol rates, including snapshots', () => {
    const client = new OpenAiStudioClient({ apiKey: 'fixture' });
    expect(client.calculateCost('gpt-6.1-sol', { prompt_tokens: 272000, completion_tokens: 1000 })).toBe(0.554);
    expect(client.calculateCost('gpt-6.1-sol-2026-09-30', { prompt_tokens: 300000, completion_tokens: 1000 })).toBe(1.215);
    expect(client.calculateCost('gpt-6.1-sol', { prompt_tokens: 1000, completion_tokens: 100,
      cache_read_input_tokens: 500, cache_creation_input_tokens: 100 })).toBe(0.0023);
    expect(calculateCallCost('gpt-6.1-sol', { inputTokens: 300000, outputTokens: 1000 }).netCostUsd).toBe(1.215);
  });

  it('reserves conservatively using Sol prices without changing old replay policy identity', () => {
    const small = reserveStudioText(body());
    expect(small.policy).toBe('studio-sol61-2026-09-30-v1');
    expect(small.usd).toBeGreaterThan(small.inputTokens * 2 / 1e6 + 0.04);
    const large = reserveStudioText(body({ messages: [{ role: 'user', content: 'x'.repeat(273000) }] }));
    expect(large.usd).toBeCloseTo((large.inputTokens * 9 + large.outputTokens * 15) / 1e6, 5);
    expect(reserveStudioText(body({ model: 'gpt-6-astra' })).policy).toBe('studio-2026-09-29-v3');
    const usage = studioTextUsage('gpt-6.1-sol', 'gpt-6.1-sol', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    // ADR-289 addendum: usage is priced at list price ($2 in, $10 out per 1M), never the reservation rate.
    expect(usage?.estimatedCostUsd).toBe(0.0007);
    expect(usage?.estimatedCostUsd).toBe(new OpenAiStudioClient({ apiKey: 'fixture', fetcher: vi.fn() })
      .calculateCost('gpt-6.1-sol', { prompt_tokens: 100, completion_tokens: 50 }));
    expect(studioTextModelMatches('gpt-6.1-sol', 'gpt-6-astra')).toBe(false);
    expect(studioTextModelMatches('gpt-6.1-sol', 'gpt-6.1-sol-2026-09-30')).toBe(true);
  });

  it('refuses unqualified image accounting and model limits before paid dispatch', async () => {
    expect(() => reserveStudioText(body({ max_completion_tokens: 128001 }))).toThrow();
    expect(() => reserveStudioText(body({ messages: [{ role: 'user', content: 'x'.repeat(1050000) }] }))).toThrow();
    const fetcher = vi.fn();
    const client = new OpenAiStudioClient({ apiKey: 'fixture', fetcher });
    await expect(client.createStructuredCompletion({ model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/test.png' } }] }],
      jsonSchema: { name: 'test', schema: { type: 'object' } }, beforeDispatch: async b => { reserveStudioText(b); },
    })).rejects.toThrow('immutable inline images');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
