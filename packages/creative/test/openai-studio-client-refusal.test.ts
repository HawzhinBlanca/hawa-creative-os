import { describe, it, expect, vi } from 'vitest';
import { OpenAiStudioClient } from '../src/studio/openai-studio-client.js';

/**
 * Bug hunt 2026-09-24. A model reply with no content (an OpenAI safety refusal carries
 * `message.content: null` and `message.refusal: "..."`, finish_reason 'stop') must not be returned as
 * a successful, empty answer. The client falls back to the string '{}' and returns `data: {}`.
 */
describe('HUNT: OpenAiStudioClient refusal / null content', () => {
  const schema = {
    name: 'Verdict',
    schema: { type: 'object', properties: { parity: { type: 'string' } }, required: ['parity'] },
    strict: false,
  };

  const refusal = {
    id: 'chatcmpl_refusal',
    model: 'gpt-4.1-mini',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: "I'm sorry, I can't help with that." } }],
    usage: { prompt_tokens: 2400, completion_tokens: 12 },
  };

  it('a refusal (content null) is an error, not an empty successful answer', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => refusal,
    });
    const client = new OpenAiStudioClient({ apiKey: 'test-key', fetcher: fetcher as any });

    const outcome = await client
      .createStructuredCompletion({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'compare' }], jsonSchema: schema })
      .then((r) => ({ resolved: true as const, data: r.data }), (e) => ({ resolved: false as const, error: String(e?.message || e) }));

    // Expected: rejected (refused / no answer). Actual: resolved with data {}.
    expect(outcome).toMatchObject({ resolved: false });
  });
});
