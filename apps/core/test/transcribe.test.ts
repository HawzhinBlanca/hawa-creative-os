import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';

describe('POST /v1/assets/transcribe-brief (FR-013, FR-014)', () => {
  let app: any;

  beforeEach(() => {
    app = createApp();
  });

  it('transcribes Sorani Kurdish voice note and extracts protected pricing tokens without hallucination', async () => {
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
    expect(body.detectedLanguage).toBe('ckb');
    expect(body.normalizedText).toContain('١٢٬٠٠٠ دینار');
    expect(body.protectedTokens.length).toBeGreaterThanOrEqual(1);
    expect(body.objective).toBe('Summer Campaign');
    expect(body.missingFacts).toHaveLength(0);
  });

  it('detects missing facts when voice note contains no factual numbers or prices', async () => {
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
    expect(body.missingFacts).toContain('exact_price_or_discount');
  });
});
