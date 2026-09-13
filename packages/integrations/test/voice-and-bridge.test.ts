import { describe, it, expect } from 'vitest';
import { KurdishVoiceTranscriber, normalizeKurdishSpokenText } from '../src/voice-transcriber.js';
import { TelegramBridgeDaemon, type TelegramUpdate } from '../src/telegram-bridge.js';

describe('KurdishVoiceTranscriber (FR-013, FR-014)', () => {
  it('normalizes spoken Kurdish Sorani numbers, percentages, and currencies into exact protected tokens', () => {
    const spoken = 'پۆستێکمان بۆ بکە، داشکاندنی لەسەدا بیست و پێنج، نرخەکەشی دوازدە هەزار دینار';
    const normalized = normalizeKurdishSpokenText(spoken);

    expect(normalized).toContain('٪٢٥');
    expect(normalized).toContain('١٢٬٠٠٠ دینار');
  });

  it('transcribes Sorani voice note into structured brief and extracts protected tokens without hallucination', async () => {
    const transcriber = new KurdishVoiceTranscriber();
    const result = await transcriber.transcribe(
      { durationSeconds: 10, languageHint: 'ckb' },
      'داشکاندنی بیست و پێنج لە سەد بۆ ڕۆژی نەورۆز بە نرخی دە دۆلار'
    );

    expect(result.detectedLanguage).toBe('ckb');
    expect(result.objective).toBe('Nawroz Holiday Campaign');
    expect(result.normalizedText).toContain('٪٢٥');
    expect(result.normalizedText).toContain('$10');
    expect(result.protectedTokens.length).toBeGreaterThanOrEqual(1);
    expect(result.missingFacts).toHaveLength(0);
  });

  it('flags missing facts when no price or discount is mentioned in voice note (Invariant 5)', async () => {
    const transcriber = new KurdishVoiceTranscriber();
    const result = await transcriber.transcribe(
      { durationSeconds: 6, languageHint: 'ckb' },
      'سڵاو کاکە، وێنەیەکمان بۆ چاپ بکەن'
    );

    expect(result.missingFacts).toContain('exact_price_or_discount');
  });

  it('proves Gemini REST call passes API key via x-goog-api-key header and does not leak it in URL query parameter', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    const testKey = 'AIzaSySecretKey999888777';
    process.env.GEMINI_API_KEY = testKey;

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'داشکاندنی بەهارە' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const transcriber = new KurdishVoiceTranscriber();
      const res = await transcriber.transcribe({
        audioBuffer: Buffer.from('fake-audio-bytes'),
        audioMimeType: 'audio/ogg',
      });

      expect(res.transcript).toBe('داشکاندنی بەهارە');
      expect(capturedUrl).toBeDefined();
      // Security Proof: URL must NOT contain the plaintext API key in query parameters
      expect(capturedUrl).not.toContain(testKey);
      expect(capturedUrl).not.toContain('?key=');
      // Must pass key in x-goog-api-key header
      expect(capturedHeaders?.['x-goog-api-key']).toBe(testKey);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  });
});

describe('TelegramBridgeDaemon (FR-001 - FR-004)', () => {
  it('normalizes incoming telegram text and voice message updates into verified Hawa envelopes', async () => {
    const bridge = new TelegramBridgeDaemon({ botToken: 'mock_token' });
    bridge.start();

    const textUpdate: TelegramUpdate = {
      update_id: 1001,
      message: {
        message_id: 42,
        from: { id: 98765, is_bot: false, first_name: 'Hawzhin' },
        chat: { id: -1001234567, type: 'supergroup', title: 'Hawa Creative Office' },
        date: 1788550000,
        text: 'تکایە پۆستی نەورۆز بۆ ئاستەر ئامادە بکەن',
      },
    };

    const res = await bridge.processUpdate(textUpdate);
    expect(res.processed).toBe(true);
    expect(res.envelope.source.platform).toBe('telegram');
    expect(res.envelope.source.messageId).toBe('42');
    expect(res.envelope.source.channelId).toBe('-1001234567');
    expect(res.envelope.content.text).toBe('تکایە پۆستی نەورۆز بۆ ئاستەر ئامادە بکەن');

    // Voice message update
    const voiceUpdate: TelegramUpdate = {
      update_id: 1002,
      message: {
        message_id: 43,
        from: { id: 98765, is_bot: false, first_name: 'Hawzhin' },
        chat: { id: -1001234567, type: 'supergroup', title: 'Hawa Creative Office' },
        date: 1788550010,
        voice: {
          file_id: 'voice_audio_file_uuid_99',
          duration: 15,
          mime_type: 'audio/ogg',
          file_size: 45200,
        },
      },
    };

    const voiceRes = await bridge.processUpdate(voiceUpdate);
    expect(voiceRes.processed).toBe(true);
    expect(voiceRes.envelope.content.attachments).toHaveLength(1);
    expect(voiceRes.envelope.content.attachments[0].kind).toBe('audio');
    expect(voiceRes.envelope.content.attachments[0].id).toBe('voice_audio_file_uuid_99');

    const status = bridge.getStatus();
    expect(status.processedCount).toBe(2);
    expect(status.lastUpdateId).toBe(1002);

    bridge.stop();
    expect(bridge.getStatus().active).toBe(false);
  });
});
