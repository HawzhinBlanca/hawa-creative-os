import { describe, it, expect, vi } from 'vitest';
import { KurdishVoiceTranscriber, normalizeKurdishSpokenText } from '../src/voice-transcriber.js';

describe('KurdishVoiceTranscriber (FR-013, FR-014)', () => {
  it('does not send unresolved or local-only client audio to an external transcription provider', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = ['fixture', 'voice', 'key'].join('-');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected external request in local-only voice test'); });
    try {
      const transcriber = new KurdishVoiceTranscriber();
      for (const egressDecision of [undefined, {
        clientId: '00000000-0000-4000-a000-000000000001',
        dataClass: 'client_voice' as const,
        mode: 'local_only' as const,
        allowedProviders: ['local'],
      }]) {
        const result = await transcriber.transcribe({
          audioBuffer: Buffer.from('private-audio'),
          egressDecision,
        }, 'Caption supplied by sender');
        expect(result.audioStatus).toBe('policy_blocked');
        expect(result.transcript).toBe('');
        expect(result.suppliedText).toBe('Caption supplied by sender');
        expect(result.normalizedText).toBe('');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('normalizes spoken Kurdish Sorani numbers, percentages, and currencies into exact protected tokens', () => {
    const spoken = 'پۆستێکمان بۆ بکە، داشکاندنی لەسەدا بیست و پێنج، نرخەکەشی دوازدە هەزار دینار';
    const normalized = normalizeKurdishSpokenText(spoken);

    expect(normalized).toContain('٪٢٥');
    expect(normalized).toContain('١٢٬٠٠٠ دینار');
  });

  it('preserves supplied Sorani text without rewriting prices or claiming transcription', async () => {
    const transcriber = new KurdishVoiceTranscriber();
    const result = await transcriber.transcribe(
      { durationSeconds: 10, languageHint: 'ckb' },
      'داشکاندنی بیست و پێنج لە سەد بۆ ڕۆژی نەورۆز بە نرخی دە دۆلار'
    );

    expect(result.detectedLanguage).toBeNull();
    expect(result.transcript).toBe('');
    expect(result.audioStatus).toBe('not_provided');
    expect(result.normalizedText).toBe('داشکاندنی بیست و پێنج لە سەد بۆ ڕۆژی نەورۆز بە نرخی دە دۆلار');
    expect(result.missingFacts).toEqual(['copy_review']);
  });

  it('requires copy review without inventing a requirement for a price or discount', async () => {
    const transcriber = new KurdishVoiceTranscriber();
    const result = await transcriber.transcribe(
      { durationSeconds: 6, languageHint: 'ckb' },
      'سڵاو کاکە، وێنەیەکمان بۆ چاپ بکەن'
    );

    expect(result.missingFacts).toEqual(['copy_review']);
  });

  it('proves OpenAI Whisper REST call passes API key via Authorization header and does not leak it in URL query parameter', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const testKey = 'safe-whisper-key-42';
    process.env.OPENAI_API_KEY = testKey;

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({
        text: 'داشکاندنی بەهارە',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const transcriber = new KurdishVoiceTranscriber();
      const res = await transcriber.transcribe({
        audioBuffer: Buffer.from('fake-audio-bytes'),
        audioMimeType: 'audio/ogg',
        egressDecision: { clientId: '00000000-0000-4000-a000-000000000001', dataClass: 'client_voice', mode: 'approved_providers', allowedProviders: ['openai'] },
      });

      expect(res.transcript).toBe('داشکاندنی بەهارە');
      expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
      // Security Proof: URL must NOT contain the plaintext API key in query parameters
      expect(capturedUrl).not.toContain(testKey);
      expect(capturedUrl).not.toContain('?key=');
      // Must pass key in Authorization header
      expect(capturedHeaders?.['Authorization']).toBe(`Bearer ${testKey}`);
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  });
});

describe('audio file names', () => {
  it('carry the extension of the format, which the transcription API reads', async () => {
    const { audioExtension } = await import('../src/voice-transcriber.js');
    expect(audioExtension('audio/ogg')).toBe('ogg');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/x-m4a')).toBe('m4a');
    expect(audioExtension('audio/wav')).toBe('wav');
    expect(audioExtension(undefined)).toBe('ogg');
  });
});

describe('a voice note with a caption', () => {
  it('keeps the provider transcript and supplied caption separate', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = ['voice', 'fixture', 'key'].join('-');
    let form: FormData | undefined;
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: 'بانگهێشتنامەیەک بۆ کۆنفرانسی ساگاکۆن' }), { status: 200 });
    }) as any;
    try {
      const res = await new KurdishVoiceTranscriber().transcribe(
        { audioBuffer: Buffer.from('fake-audio-bytes'), audioMimeType: 'audio/ogg', languageHint: 'ckb',
          egressDecision: { clientId: '00000000-0000-4000-a000-000000000001', dataClass: 'client_voice', mode: 'approved_providers', allowedProviders: ['openai'] } },
        'KAAE'
      );
      expect(form).toBeDefined();
      expect(form!.get('language')).toBeNull();
      expect(String(form!.get('prompt'))).toMatch(/سۆرانی/);
      expect(res.normalizedText).toBe('بانگهێشتنامەیەک بۆ کۆنفرانسی ساگاکۆن');
      expect(res.suppliedText).toBe('KAAE');
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  });
});
