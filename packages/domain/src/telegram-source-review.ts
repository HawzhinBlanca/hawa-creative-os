/** Pure parsing for a requester-reviewed file. Extracted text is never final design copy. */
export interface TelegramSourceEnvelope {
  updateId: number; chatId: string; senderId: string; topicId: string;
  messageId: number; replyMessageId: number | null; chatType: string;
  caption: string; fileId: string; kind: 'pdf' | 'voice';
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function sourceMessageScope(update: unknown) {
  const u = record(update), msg = record(u?.message), from = record(msg?.from), chat = record(msg?.chat);
  if (!positive(u?.update_id) || !positive(msg?.message_id) || !positive(from?.id) || from?.is_bot === true ||
      !Number.isSafeInteger(chat?.id) || Number(chat?.id) === 0 ||
      (msg?.message_thread_id !== undefined && !positive(msg.message_thread_id))) return null;
  const reply = record(msg?.reply_to_message);
  return { updateId: u!.update_id as number, messageId: msg!.message_id as number,
    senderId: String(from!.id), chatId: String(chat!.id), chatType: String(chat!.type),
    topicId: msg?.message_thread_id === undefined ? '' : String(msg.message_thread_id),
    replyMessageId: positive(reply?.message_id) ? reply!.message_id as number : null };
}

export function telegramPdfSource(update: unknown): TelegramSourceEnvelope | null {
  const scope = sourceMessageScope(update), u = record(update), msg = record(u?.message), file = record(msg?.document);
  if (!scope || !file || !msg || ['photo','voice','audio','video','animation','live_photo','video_note','media_group_id','text']
    .some(key => msg[key] !== undefined) || (msg.caption !== undefined && typeof msg.caption !== 'string')) return null;
  const mime = typeof file.mime_type === 'string' ? file.mime_type.toLowerCase().trim() : '';
  // A filename cannot change an existing image upload into a PDF-copy workflow.
  // Ambiguous document types keep the byte-verified image/unsupported-file path.
  if (mime !== 'application/pdf') return null;
  if (typeof file.file_id !== 'string' || !file.file_id.trim() || file.file_id.length > 512 ||
      (file.file_size !== undefined && (!positive(file.file_size) || file.file_size > 20 * 1024 * 1024))) return null;
  return { ...scope, fileId: file.file_id, kind: 'pdf', caption: typeof msg.caption === 'string' ? msg.caption : '' };
}

/**
 * Recording types a requester's phone sends (ADR-145): a voice note is Ogg Opus; a recording sent as
 * audio or as a file is often M4A, MP3, WAV, AAC or WebM. Core reads the container from the bytes and
 * turns the others into Ogg Opus; the declared type only rules out what is certainly not a recording.
 */
export const ADMITTED_AUDIO_TYPES = ['audio/ogg', 'audio/opus', 'application/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mpeg3',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/aacp', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/vnd.wave', 'audio/webm', 'audio/3gpp', 'video/ogg'];

export function telegramVoiceSource(update: unknown): TelegramSourceEnvelope | null {
  const scope = sourceMessageScope(update), msg = record(record(update)?.message);
  if (!scope || !msg) return null;
  // A recording sent "as a file" arrives as a document with an audio type.
  const doc = record(msg.document);
  const docMime = typeof doc?.mime_type === 'string' ? doc.mime_type.toLowerCase().split(';')[0].trim() : '';
  const audioDocument = Boolean(doc) && docMime.startsWith('audio/');
  if (Number(Boolean(msg.voice)) + Number(Boolean(msg.audio)) + Number(audioDocument) !== 1 ||
      ['photo', ...(audioDocument ? [] : ['document']), 'video','animation','live_photo','video_note','media_group_id','text']
        .some(key => msg[key] !== undefined) ||
      (msg.caption !== undefined && typeof msg.caption !== 'string')) return null;
  const file = record(msg.voice ?? msg.audio ?? msg.document);
  if (!file || typeof file.file_id !== 'string' || !file.file_id.trim() || file.file_id.length > 512 ||
      (file.file_size !== undefined && (!positive(file.file_size) || file.file_size > 20 * 1024 * 1024))) return null;
  const mime = typeof file.mime_type === 'string' ? file.mime_type.toLowerCase().split(';')[0].trim() : '';
  if (mime && !ADMITTED_AUDIO_TYPES.includes(mime)) return null;
  return { ...scope, fileId: file.file_id, kind: 'voice', caption: typeof msg.caption === 'string' ? msg.caption : '' };
}

export const telegramSource = (update: unknown) => telegramPdfSource(update) ?? telegramVoiceSource(update);

/** Only the command line is removed. Whitespace, script, punctuation and all remaining text survive. */
export function sourceCopyConfirmation(update: unknown): { scope: NonNullable<ReturnType<typeof sourceMessageScope>>; copy: string } | null {
  const scope = sourceMessageScope(update), msg = record(record(update)?.message);
  if (!scope || !msg || typeof msg.text !== 'string' ||
      ['document','photo','voice','audio','video','media_group_id','animation'].some(key => msg[key] !== undefined)) return null;
  const command = /^\/use_source(?:@\w+)?(?:\r?\n|$)/.exec(msg.text);
  if (!command) return null;
  return { scope, copy: msg.text.slice(command[0].length) };
}

export function sourceClientSelection(caption: string): { client: string | null; invalidClient: boolean; instructions: string; explicitNew: boolean } {
  const lines = caption.split(/\r?\n/), matches = lines.filter(line => /^\s*client\s*:/i.test(line));
  const client = matches.length === 1 ? matches[0].replace(/^\s*client\s*:\s*/i, '').trim() : null;
  return { client: client && client.length <= 200 ? client : null,
    invalidClient: matches.length > 1 || (matches.length === 1 && (!client || client.length > 200)),
    instructions: lines.filter(line => !/^\s*client\s*:/i.test(line)).join('\n').replace(/^\/new(?:@\w+)?(?:\s|$)/i, '').trim(),
    explicitNew: /^\/new(?:@\w+)?(?:\s|$)/i.test(caption) };
}

/**
 * A size said naturally in a caption (ADR-145): "A4", "A5", "Instagram story", "square post",
 * "portrait post", "landscape", "1080x1350" anywhere in the words. A size larger than the lifecycle's
 * 640–2400 px canvas is scaled down to fit, keeping its shape. Undefined when no size is said.
 */
export function naturalDesignSize(caption: string): { width: number; height: number } | undefined {
  const text = caption.toLowerCase();
  const fit = (w: number, h: number) => {
    const scale = Math.min(1, 2400 / Math.max(w, h));
    const width = Math.round(w * scale), height = Math.round(h * scale);
    return width >= 640 && height >= 640 ? { width, height } : undefined;
  };
  const explicit = /(?<![\d.])(\d{3,5})\s*[x×*]\s*(\d{3,5})(?![\d.])/.exec(text);
  if (explicit) return fit(Number(explicit[1]), Number(explicit[2]));
  if (/\ba4\b/.test(text)) return fit(2480, 3508);
  if (/\ba5\b/.test(text)) return fit(1748, 2480);
  if (/\ba3\b/.test(text)) return fit(3508, 4961);
  if (/\b(?:instagram\s+|insta\s+|ig\s+)?(?:story|stories|reel|status)\b|ستۆری/u.test(text)) return { width: 1080, height: 1920 };
  if (/\bsquare\b|چوارگۆشە/u.test(text)) return { width: 1080, height: 1080 };
  if (/\bportrait\b|\binstagram\s+post\b|\bpost\b/.test(text)) return { width: 1080, height: 1350 };
  if (/\blandscape\b|\bbanner\b/.test(text)) return { width: 1920, height: 1080 };
  return undefined;
}

/** Explicit source format uses the lifecycle's supported 640–2400 px canvas bounds. */
export function sourceDesignSize(caption: string): { width: number; height: number } | null | undefined {
  const lines = caption.split(/\r?\n/).filter(line => /^\s*size\s*:/i.test(line));
  if (!lines.length) return undefined;
  const match = lines.length === 1 && /^\s*size\s*:\s*(\d+)\s*[x×]\s*(\d+)\s*(?:px)?\s*$/i.exec(lines[0]);
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width >= 640 && width <= 2400 && height >= 640 && height <= 2400 ? { width, height } : null;
}
