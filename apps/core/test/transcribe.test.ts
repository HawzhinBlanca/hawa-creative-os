import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('POST /v1/assets/transcribe-brief (FR-013, FR-014)', () => {
  let app: any;

  beforeEach(() => {
    app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });
  });

  it('refuses uploaded audio before a client policy is resolved and makes no provider request', async () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = ['fixture', 'voice', 'key'].join('-');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    try {
      const res = await app.request('/v1/assets/transcribe-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: Buffer.from('private-audio').toString('base64'), text: 'caption' }),
      });
      expect(res.status).toBe(412);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });

  it('preserves supplied Sorani text as an unreviewed source without invented transcription facts', async () => {
    const res = await app.request('/v1/assets/transcribe-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'سڵاو، پۆستێکی هاوینەمان بۆ بکەن بە نرخی دوازدە هەزار دینار',
        durationSeconds: 8,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedLanguage).toBeNull();
    expect(body.confidence).toBeNull();
    expect(body.transcript).toBe('');
    expect(body.audioStatus).toBe('not_provided');
    expect(body.normalizedText).toBe('سڵاو، پۆستێکی هاوینەمان بۆ بکەن بە نرخی دوازدە هەزار دینار');
    expect(body.missingFacts).toEqual(['copy_review']);
  });

  it('does not invent a pricing requirement for a logo-only brief', async () => {
    const res = await app.request('/v1/assets/transcribe-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'تکایە تەنها لۆگۆکەمان بۆ دابنێن بەبێ هیچ تێکستێک',
        durationSeconds: 5,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missingFacts).toEqual(['copy_review']);
  });

  it('preserves whitespace and reports unknown measurements when inspecting text', async () => {
    const text = '  Print this_copy\n٢٠٢٦  ';
    const res = await app.request('/v1/assets/transcribe-brief', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ normalizedText: text, suppliedText: text, transcript: '',
      durationSeconds: null, durationSource: 'unknown', confidence: null, detectedLanguage: null,
      requiresCopyReview: true, providerOutcome: 'not_sent' });
  });

  it.each([null, [], { text: {} }, { text: ' ' }, { text: 'x'.repeat(100_001) }])(
    'refuses malformed or oversized supplied text', async payload => {
      const res = await app.request('/v1/assets/transcribe-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      expect(res.status).toBe(422);
    });
});
