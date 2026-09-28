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
  audioStatus: 'not_provided' | 'invalid_audio' | 'policy_blocked' | 'provider_unavailable' | 'provider_failed' | 'transcribed';
  /** Uncertain transport must be reconciled by the durable caller before another paid call. */
  providerOutcome: 'not_sent' | 'rejected' | 'received' | 'uncertain';
  providerRequestId: string | null;
  transcript: string;
  /** Compatibility field: exact source text, never automatically normalized factual copy. */
  normalizedText: string;
  suppliedText: string;
  detectedLanguage: 'ckb' | 'ar' | 'en' | null;
  confidence: number | null;
  durationSeconds: number | null;
  durationSource: 'caller' | 'unknown';
  requiresCopyReview: true;
  protectedTokens: ProtectedToken[];
  objective: string;
  missingFacts: string[];
}

/**
 * Optional suggestion only. Never use this transformation as approved or transcribed factual copy.
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

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 100_000;

/** Bounds actual bytes and the body-read deadline; cancellation may itself be broken. */
async function readVoiceResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('VOICE_RESPONSE_LIMIT');
  }
  if (!response.body) throw new Error('VOICE_RESPONSE_EMPTY');
  const reader = response.body.getReader();
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('VOICE_RESPONSE_TIMEOUT'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('VOICE_RESPONSE_LIMIT');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
  }
}

export class KurdishVoiceTranscriber {
  private readonly timeoutMs: number;
  constructor(options: { timeoutMs?: number } = {}) {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000) throw new Error('Invalid voice timeout');
    this.timeoutMs = timeout;
  }
  /**
   * Produces unreviewed source evidence. This adapter never retries a paid request.
   */
  async transcribe(req: VoiceTranscriptionRequest, suppliedText?: string): Promise<VoiceTranscriptionResult> {
    let rawTranscript = '';
    let providerOutcome: VoiceTranscriptionResult['providerOutcome'] = 'not_sent';
    let providerRequestId: string | null = null;
    const hasAudio = Boolean(req.audioBuffer?.byteLength || req.audioBase64?.length);
    const invalidAudio = Boolean(
      (req.audioBuffer && req.audioBuffer.byteLength > MAX_AUDIO_BYTES) ||
      (!req.audioBuffer && req.audioBase64 && (req.audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
        req.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.audioBase64)))
    );
    const openaiKey = process.env.OPENAI_API_KEY;
    const decoded = invalidAudio ? undefined : req.audioBuffer ? Buffer.from(req.audioBuffer)
      : req.audioBase64 ? Buffer.from(req.audioBase64, 'base64') : undefined;
    const audioBytes = decoded && decoded.byteLength <= MAX_AUDIO_BYTES ? decoded : undefined;
    const decision = req.egressDecision;
    const externalAllowed = Boolean(
      decision &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decision.clientId) &&
      decision.dataClass === 'client_voice' &&
      (decision.mode === 'approved_providers' || decision.mode === 'evaluated_external_allowed') &&
      Array.isArray(decision.allowedProviders) && decision.allowedProviders.includes('openai')
    );
    let audioStatus: VoiceTranscriptionResult['audioStatus'] = invalidAudio || (hasAudio && !audioBytes?.length) ? 'invalid_audio'
      : !hasAudio ? 'not_provided'
      : !externalAllowed ? 'policy_blocked'
        : !openaiKey || openaiKey.startsWith('mock-') ? 'provider_unavailable' : 'provider_failed';

    if (audioBytes?.length && externalAllowed && openaiKey && !openaiKey.startsWith('mock-')) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
        providerOutcome = 'uncertain';
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
          },
          signal: controller.signal,
          redirect: 'error',
          body: formData,
        });
        const requestId = response.headers.get('x-request-id');
        if (requestId && /^req_[A-Za-z0-9_-]{1,180}$/.test(requestId)) providerRequestId = requestId;

        if (response.ok) {
          const json = await readVoiceResponse(response, controller.signal);
          const text = json && typeof json === 'object' && 'text' in json ? json.text : undefined;
          if (typeof text === 'string' && text.trim() && text.length <= MAX_TRANSCRIPT_CHARS) {
            rawTranscript = text;
            audioStatus = 'transcribed';
            providerOutcome = 'received';
          }
        } else {
          // Errors can contain private transcript fragments or credentials. Never read/log them.
          void response.body?.cancel().catch(() => undefined);
          if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) providerOutcome = 'rejected';
        }
      } catch {
        // Outcome remains uncertain after dispatch, including lost/invalid/oversized replies.
      } finally { clearTimeout(timer); }
    }

    const caption = typeof suppliedText === 'string' ? suppliedText : '';
    const text = hasAudio ? rawTranscript : caption;
    const duration = typeof req.durationSeconds === 'number' && Number.isFinite(req.durationSeconds) && req.durationSeconds > 0
      ? req.durationSeconds : null;
    return {
      audioStatus, providerOutcome, providerRequestId,
      transcript: rawTranscript,
      normalizedText: text,
      suppliedText: caption,
      detectedLanguage: null,
      confidence: null,
      durationSeconds: duration,
      durationSource: duration === null ? 'unknown' : 'caller',
      requiresCopyReview: true,
      protectedTokens: extractProtectedTokens(text),
      objective: hasAudio ? 'Unreviewed voice source' : 'Supplied text',
      missingFacts: [...(text.trim() ? [] : ['transcript']), 'copy_review'],
    };
  }
}
