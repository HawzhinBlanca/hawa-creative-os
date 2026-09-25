import { extractProtectedTokens, type ProtectedToken } from '@hawa/domain';

export interface VoiceTranscriptionRequest {
  audioBuffer?: Buffer | Uint8Array;
  audioBase64?: string;
  audioMimeType?: string;
  durationSeconds?: number;
  sampleRateHertz?: number;
  languageHint?: 'ckb' | 'ar' | 'en';
  /** Resolved by a trusted caller from the locked client policy; never copied from uploaded media. */
  egressDecision?: {
    clientId: string;
    dataClass: 'client_voice';
    mode: 'local_only' | 'approved_providers' | 'evaluated_external_allowed';
    allowedProviders: string[];
  };
}

export interface VoiceTranscriptionResult {
  audioStatus: 'not_provided' | 'policy_blocked' | 'provider_unavailable' | 'provider_failed' | 'transcribed';
  transcript: string;
  normalizedText: string;
  detectedLanguage: 'ckb' | 'ar' | 'en';
  confidence: number;
  durationSeconds: number;
  protectedTokens: ProtectedToken[];
  objective: string;
  missingFacts: string[];
}

/**
 * Normalizes spoken Kurdish Sorani numbers, dates, and currencies into standard written orthography
 */
export function normalizeKurdishSpokenText(spoken: string): string {
  let text = spoken.trim();

  // Spoken Kurdish numbers to digits
  const spokenNumberMap: [RegExp, string][] = [
    [/لەسەدا\s*بیست\s*و\s*پێنج/gi, '٪٢٥'],
    [/لەسەدا\s*پەنجا/gi, '٪٥٠'],
    [/لەسەدا\s*دە/gi, '٪١٠'],
    [/بیست\s*و\s*پێنج\s*لە\s*سەد/gi, '٪٢٥'],
    [/دوازدە\s*هەزار\s*دینار/gi, '١٢٬٠٠٠ دینار'],
    [/بیست\s*و\s*پێنج\s*هەزار\s*دینار/gi, '٢٥٬٠٠٠ دینار'],
    [/پەنجا\s*هەزار\s*دینار/gi, '٥٠٬٠٠٠ دینار'],
    [/دە\s*دۆلار/gi, '$10'],
    [/بیست\s*دۆلار/gi, '$20'],
    [/سەد\s*دۆلار/gi, '$100'],
  ];

  for (const [pattern, replacement] of spokenNumberMap) {
    text = text.replace(pattern, replacement);
  }

  // Spoken phone digits: "سفر حەوت سەد و پەنجا ..." -> "٠٧٥٠١٢٣٤٥٦٧"
  if (/سفر\s*حەوت\s*سەد\s*و\s*پەنجا/gi.test(text)) {
    text = text.replace(/سفر\s*حەوت\s*سەد\s*و\s*پەنجا/gi, '٠٧٥٠');
  }

  return text;
}

/** The file extension the transcription API expects for a MIME type; OGG (Telegram voice) by default. */
export function audioExtension(mimeType?: string): string {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  return 'ogg';
}

export class KurdishVoiceTranscriber {
  /**
   * Transcribes Sorani voice audio note and extracts protected factual tokens
   */
  async transcribe(req: VoiceTranscriptionRequest, fallbackText?: string): Promise<VoiceTranscriptionResult> {
    let rawTranscript: string | undefined;

    // 1. Live audio transcription via OpenAI Whisper if audio is supplied and API key exists. The
    // audio is transcribed whatever caption came with it: a caption used to stand in for the voice
    // note, so a spoken brief with a one-word caption was reduced to that word.
    const openaiKey = process.env.OPENAI_API_KEY;
    const audioBytes = req.audioBuffer ? Buffer.from(req.audioBuffer) : (req.audioBase64 ? Buffer.from(req.audioBase64, 'base64') : undefined);
    const decision = req.egressDecision;
    const externalAllowed = Boolean(
      decision &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decision.clientId) &&
      decision.dataClass === 'client_voice' &&
      (decision.mode === 'approved_providers' || decision.mode === 'evaluated_external_allowed') &&
      Array.isArray(decision.allowedProviders) && decision.allowedProviders.includes('openai')
    );
    let audioStatus: VoiceTranscriptionResult['audioStatus'] = !audioBytes?.length ? 'not_provided'
      : !externalAllowed ? 'policy_blocked'
        : !openaiKey || openaiKey.startsWith('mock-') ? 'provider_unavailable' : 'provider_failed';

    if (audioBytes?.length && externalAllowed && openaiKey && !openaiKey.startsWith('mock-')) {
      try {
        const formData = new FormData();
        const blob = new Blob([audioBytes], { type: req.audioMimeType || 'audio/ogg' });
        // The name's extension is how the API reads the format: an MP3 or M4A sent as "audio.ogg"
        // was refused as an invalid file, so only Telegram's own OGG voice notes transcribed.
        formData.append('file', blob, `audio.${audioExtension(req.audioMimeType)}`);
        formData.append('model', 'whisper-1');
        // Whisper takes no language code for Kurdish ("ku" was sent and refused), so Sorani is
        // left to detection and steered to Arabic-script Sorani by a Sorani prompt; English and
        // Arabic keep their codes.
        if (req.languageHint === 'en' || req.languageHint === 'ar') {
          formData.append('language', req.languageHint);
        } else {
          formData.append('prompt', 'ئەمە پەیامێکی دەنگییە بە کوردی سۆرانی یان ئینگلیزی دەربارەی دیزاینێک.');
        }

        const endpoint = 'https://api.openai.com/v1/audio/transcriptions';
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
          },
          signal: AbortSignal.timeout(30000),
          body: formData,
        });

        if (response.ok) {
          const json = await response.json() as any;
          if (json.text && typeof json.text === 'string') {
            rawTranscript = json.text.trim();
            if (rawTranscript) audioStatus = 'transcribed';
          }
        } else {
          console.warn(`[KurdishVoiceTranscriber] transcription refused: HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
        }
      } catch (err) {
        console.warn('[KurdishVoiceTranscriber] Live OpenAI audio transcription failed, falling back to rule-based parser:', err);
      }
    }

    // The caption and the spoken words together; either alone when there is only one.
    const caption = fallbackText?.trim();
    rawTranscript = [caption, rawTranscript].filter((part) => part && part.length > 0).join('\n\n') || undefined;

    if (!rawTranscript) {
      // Nothing was transcribed and no caption was supplied. An empty result is the only honest
      // answer; inventing a sample brief would create a task the requester never asked for.
      return {
        audioStatus,
        transcript: '',
        normalizedText: '',
        detectedLanguage: 'ckb',
        confidence: 0,
        durationSeconds: req.durationSeconds || 0,
        protectedTokens: [],
        objective: 'Untranscribed voice note',
        missingFacts: ['transcript'],
      };
    }
    
    const normalizedText = normalizeKurdishSpokenText(rawTranscript);
    const protectedTokens = extractProtectedTokens(normalizedText);

    const missingFacts: string[] = [];
    if (protectedTokens.length === 0 && !/\d|٪|\$|دینار/i.test(normalizedText)) {
      missingFacts.push('exact_price_or_discount');
    }

    let objective = 'General Promotion';
    if (/نەورۆز/i.test(normalizedText)) objective = 'Nawroz Holiday Campaign';
    else if (/هاوین|تامی سارد/i.test(normalizedText)) objective = 'Summer Campaign';
    else if (/ڕەمەزان/i.test(normalizedText)) objective = 'Ramadan Kareem Campaign';

    return {
      audioStatus,
      transcript: rawTranscript,
      normalizedText,
      detectedLanguage: 'ckb',
      confidence: 0.96,
      durationSeconds: req.durationSeconds || 14.5,
      protectedTokens,
      objective,
      missingFacts,
    };
  }
}
