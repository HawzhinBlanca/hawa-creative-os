import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KurdishVoiceTranscriber } from '../src/voice-transcriber.js';

const request = {
  audioBuffer: Buffer.from('synthetic audio transport fixture'),
  audioMimeType: 'audio/ogg',
  languageHint: 'ckb' as const,
  egressDecision: { clientId: '00000000-0000-4000-a000-000000000001', dataClass: 'client_voice' as const,
    mode: 'approved_providers' as const, allowedProviders: ['openai'] },
};
describe('voice evidence and bounded transport', () => {
  beforeEach(() => vi.stubEnv('OPENAI_API_KEY', randomUUID()));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('preserves provider text exactly, keeps captions separate, and never invents measurements', async () => {
    const text = '  نرخ: دوازدە هەزار دینار\nphone_01  ';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text })));
    const result = await new KurdishVoiceTranscriber().transcribe(request, '  Client caption  ');
    expect(result).toMatchObject({ transcript: text, normalizedText: text, suppliedText: '  Client caption  ',
      confidence: null, detectedLanguage: null, durationSeconds: null, durationSource: 'unknown',
      providerOutcome: 'received', requiresCopyReview: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('never uses a caption as evidence that failed audio was read', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private provider failure'));
    const result = await new KurdishVoiceTranscriber().transcribe(request, 'A partial caption');
    expect(result).toMatchObject({ transcript: '', normalizedText: '', suppliedText: 'A partial caption',
      audioStatus: 'provider_failed', providerOutcome: 'uncertain', confidence: null });
    expect(result.missingFacts).toContain('transcript');
  });

  it('keeps local supplied text exact without presenting it as a transcription', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
    const text = '  Price: دە دۆلار\n  ';
    const result = await new KurdishVoiceTranscriber().transcribe({}, text);
    expect(result).toMatchObject({ audioStatus: 'not_provided', transcript: '', normalizedText: text,
      suppliedText: text, confidence: null, detectedLanguage: null, durationSeconds: null, providerOutcome: 'not_sent' });
    expect(result.missingFacts).not.toContain('exact_price_or_discount');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, NaN, Infinity, 0])('does not invent a duration from %s', async durationSeconds => {
    const result = await new KurdishVoiceTranscriber().transcribe({ durationSeconds });
    expect(result.durationSeconds).toBeNull();
    expect(result.durationSource).toBe('unknown');
  });

  it('labels a valid caller duration as reported metadata', async () => {
    const result = await new KurdishVoiceTranscriber().transcribe({ durationSeconds: 12.25 });
    expect(result).toMatchObject({ durationSeconds: 12.25, durationSource: 'caller' });
  });

  it.each([400, 401, 403, 413, 429, 500])('does not read or log a provider error body for HTTP %s', async status => {
    const sensitive = `private transcript ${randomUUID()}`;
    let reads = 0;
    const response = new Response(new ReadableStream({ pull() { reads++; }, cancel() { return new Promise(() => {}); } }), { status });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await new KurdishVoiceTranscriber({ timeoutMs: 25 }).transcribe(request, sensitive);
    expect(result).toMatchObject({ audioStatus: 'provider_failed', transcript: '',
      providerOutcome: status >= 500 ? 'uncertain' : 'rejected' });
    expect(reads).toBeLessThanOrEqual(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
  });

  it.each(['{bad json', JSON.stringify({ text: ' ' }), JSON.stringify({ text: 42 }),
    JSON.stringify({ text: 'x'.repeat(100_001) })])('holds an unusable success response without retry', async body => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const result = await new KurdishVoiceTranscriber().transcribe(request);
    expect(result).toMatchObject({ audioStatus: 'provider_failed', transcript: '', providerOutcome: 'uncertain' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds actual response bytes when content length lies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(1024 * 1024 + 1), {
      headers: { 'content-length': '2' },
    }));
    const result = await new KurdishVoiceTranscriber().transcribe(request);
    expect(result).toMatchObject({ audioStatus: 'provider_failed', transcript: '', providerOutcome: 'uncertain' });
  });

  it('bounds a stalled body even when cancellation never resolves', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); },
    })));
    const pending = new KurdishVoiceTranscriber({ timeoutMs: 25 }).transcribe(request);
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ audioStatus: 'provider_failed', providerOutcome: 'uncertain' });
  });

  it('rejects oversized and malformed audio locally', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
    for (const audio of [{ audioBuffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
      { audioBuffer: undefined, audioBase64: 'not!base64' },
      { audioBuffer: undefined, audioBase64: 'a'.repeat(28 * 1024 * 1024) }]) {
      const result = await new KurdishVoiceTranscriber().transcribe({ ...request, ...audio });
      expect(result).toMatchObject({ audioStatus: 'invalid_audio', providerOutcome: 'not_sent', transcript: '' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose thrown provider errors in logs', async () => {
    const secret = randomUUID();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`Authorization: ${secret}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new KurdishVoiceTranscriber().transcribe(request);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});
