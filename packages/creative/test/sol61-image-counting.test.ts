import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OpenAiStudioClient } from '../src/studio/openai-studio-client.js';
import { reserveStudioText, type StudioNativeInputCount } from '../src/studio/spending-reservation.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const options = () => ({ model: 'gpt-6.1-sol', maxTokens: 1000,
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'What color?' },
    { type: 'image_url' as const, image_url: { url: image, detail: 'high' as const } }] }],
  jsonSchema: { name: 'test', schema: { type: 'object' } },
});
const answer = () => new Response(JSON.stringify({ id: 'synthetic-sol', model: 'gpt-6.1-sol',
  choices: [{ message: { content: '{"left":"red"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));

describe('ADR-149 exact Sol image counts precede paid admission', () => {
  beforeEach(() => { vi.stubEnv('HAWA_MODEL_TIER', 'dev'); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('counts exact inline images and detail, binds metadata, then sends unchanged admitted bytes', async () => {
    const params = options(); let admitted = ''; let countEvidence: StudioNativeInputCount | undefined;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/responses/input_tokens')) {
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-6.1-sol',
          input: [{ role: 'user', content: [{ type: 'input_image', image_url: image, detail: 'high' }] }] });
        params.messages[0]!.content[1]!.image_url!.url = 'data:image/png;base64,CHANGED';
        return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }));
      }
      expect(String(url)).toMatch(/\/chat\/completions$/);
      expect(init?.body).toBe(admitted);
      expect(String(init?.body)).toContain(image);
      expect(String(init?.body)).not.toContain('CHANGED');
      return answer();
    });
    const client = new OpenAiStudioClient({ apiKey: 'fixture', fetcher });
    const result = await client.createStructuredCompletion({ ...params, beforeDispatch: async (body, count) => {
      admitted = body; countEvidence = count;
      const quote = reserveStudioText(body, count);
      expect(quote.policy).toBe('studio-sol61-2026-09-30-v2-counted-images');
      expect(quote.nativeInputCount).toEqual(count);
      expect(quote.inputTokens).toBeGreaterThan(100);
      expect(quote.usd).toBeGreaterThan(0.01);
    } });
    expect(countEvidence?.requestSha256).toBe(createHash('sha256').update(admitted).digest('hex'));
    expect(result.receipt.costUsd).toBe(0.0006);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const invalid of [undefined, { ...countEvidence!, requestSha256: 'f'.repeat(64) },
      { ...countEvidence!, inputTokens: -1 }, { ...countEvidence!, inputTokens: NaN }]) {
      expect(() => reserveStudioText(admitted, invalid)).toThrow();
    }
  });
  it.each([{}, { object: 'other', input_tokens: 100 }, { object: 'response.input_tokens', input_tokens: -1 },
    { object: 'response.input_tokens', input_tokens: 1050001 }])('refuses malformed count %j before completion', async count => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(count)));
    const client = new OpenAiStudioClient({ apiKey: 'fixture', fetcher });
    const admission = vi.fn();
    await expect(client.createStructuredCompletion({ ...options(), beforeDispatch: admission })).rejects.toThrow('count is invalid');
    expect(admission).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry a failed count or dispatch a paid completion', async () => {
    const fetcher = vi.fn(async () => new Response('no', { status: 503 }));
    await expect(new OpenAiStudioClient({ apiKey: 'fixture', fetcher }).createStructuredCompletion(options())).rejects.toThrow('count was refused');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses completion when the budget gate rejects a successful count', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 })));
    await expect(new OpenAiStudioClient({ apiKey: 'fixture', fetcher }).createStructuredCompletion({ ...options(),
      beforeDispatch: async () => { throw new Error('budget refused'); },
    })).rejects.toThrow('budget refused');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
