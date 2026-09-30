/** Core-owned Telegram photo admission. Restate receives only the content reference. */
import { sniffBlobMediaType, type BlobRef } from '@hawa/contracts';
import type { BlobStore } from '@hawa/db';
import { heifAsJpeg, isHeif, MediaConversionError } from './media-conversion.js';
import { log } from '../logging.js';

const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;

const PHOTO_REPLY_DIRECTIVE = 'The requester attached an image with no written instructions. '
  + 'Use it as reference for the existing brief; do not infer or change factual copy from image text.';

/** Select an original still-image file. Metadata only rejects; downloaded bytes authorize admission. */
export function lifecycleStillImageFile(message: unknown, allowAlbum = false): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const msg = message as Record<string, unknown>;
  if ((!allowAlbum && msg.media_group_id !== undefined) ||
      ['voice', 'audio', 'video', 'video_note', 'animation', 'live_photo', 'text'].some((key) => msg[key] !== undefined) ||
      (msg.caption !== undefined && typeof msg.caption !== 'string')) return null;
  const hasPhoto = msg.photo !== undefined;
  const hasDocument = msg.document !== undefined;
  if (hasPhoto === hasDocument) return null;
  const value = hasPhoto && Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : msg.document;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (typeof file.file_id !== 'string' || !file.file_id.trim() || file.file_id.length > 512) return null;
  if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) ||
      Number(file.file_size) < 1 || Number(file.file_size) > MAX_TELEGRAM_PHOTO_BYTES)) return null;
  if (hasDocument && file.mime_type !== undefined &&
      (typeof file.mime_type !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream',
        // Some senders label JPEG files 'image/jpg' (ADR-156 P3); the bytes are sniffed after download.
        'image/jpg',
        // An iPhone photo sent "as a file" (ADR-145): converted to JPEG once its bytes say it is HEIF.
        'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']
        .includes(file.mime_type.trim().toLowerCase()))) return null;
  // A document thumbnail is a different, usually smaller file and is never selected here.
  return file.file_id;
}

/**
 * A still photo with no words and no reply, outside an album (ADR-145): kept until its sender's words
 * arrive, or joined to the request those words just opened. Null for anything else.
 */
export function heldPhotoCandidate(update: unknown): { fileId: string; messageId: string; senderId: string; topic: string } | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const msg = (update as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object' || msg.reply_to_message || msg.media_group_id !== undefined) return null;
  if (typeof msg.caption === 'string' && msg.caption.trim()) return null;
  const fileId = lifecycleStillImageFile(msg);
  const from = msg.from as { id?: unknown; is_bot?: unknown } | undefined;
  if (!fileId || !Number.isSafeInteger(from?.id) || from?.is_bot === true || !Number.isSafeInteger(msg.message_id)) return null;
  return { fileId, messageId: String(msg.message_id), senderId: String(from!.id),
    topic: msg.message_thread_id === undefined ? '' : String(msg.message_thread_id) };
}

/**
 * A still photo (or a picture sent as a file) outside an album and not a reply, with or without words:
 * a possible member of a photo burst (ADR-160 addendum). Telegram delivers several photos picked together
 * with "group" off, and some clients always, as separate messages with no media_group_id, about a second
 * apart; such a burst is one set of photos, as an album is. Null for anything else.
 */
export function burstPhotoCandidate(update: unknown): { captioned: boolean } | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const msg = (update as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object' || msg.reply_to_message || msg.media_group_id !== undefined) return null;
  const from = msg.from as { id?: unknown; is_bot?: unknown } | undefined;
  if (!lifecycleStillImageFile(msg) || !Number.isSafeInteger(from?.id) || Number(from?.id) <= 0 || from?.is_bot === true ||
      !Number.isSafeInteger(msg.message_id) || Number(msg.message_id) <= 0) return null;
  return { captioned: typeof msg.caption === 'string' && msg.caption.trim() !== '' };
}

/** A captionless image needs a reply identity; Core verifies its recorded request/revision. */
export function lifecyclePhotoInput(update: unknown): {
  fileId: string; directive: string; captionless: boolean; replyMessageId: string | null;
} | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const message = (update as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const msg = message as Record<string, unknown>;
  const fileId = lifecycleStillImageFile(msg);
  if (!fileId) return null;
  const reply = msg.reply_to_message;
  const id = reply && typeof reply === 'object' ? (reply as Record<string, unknown>).message_id : null;
  const replyMessageId = Number.isSafeInteger(id) && Number(id) > 0 ? String(id) : null;
  const caption = typeof msg.caption === 'string' ? msg.caption.trim() : '';
  if (!caption && !replyMessageId) return null;
  return { fileId, directive: caption || PHOTO_REPLY_DIRECTIVE,
    captionless: !caption, replyMessageId };
}

export type LifecyclePhotoResult =
  | { kind: 'stored'; ref: BlobRef }
  | { kind: 'unsupported' }
  | { kind: 'download_unavailable' }
  | { kind: 'store_unavailable' };

export async function retainLifecyclePhoto(
  store: BlobStore | null,
  download: (fileId: string) => Promise<Buffer | null | undefined>,
  fileId: string,
): Promise<LifecyclePhotoResult> {
  if (!store) return { kind: 'store_unavailable' };
  let bytes: Buffer | null | undefined;
  try {
    bytes = await download(fileId);
  } catch {
    return { kind: 'download_unavailable' };
  }
  if (!bytes?.length) return { kind: 'download_unavailable' };
  if (bytes.length > MAX_TELEGRAM_PHOTO_BYTES) return { kind: 'unsupported' };
  if (isHeif(bytes)) {
    // The bytes, not the declared type, say HEIF: the design path takes the JPEG it becomes (ADR-145).
    try {
      bytes = await heifAsJpeg(bytes);
    } catch (error) {
      if (error instanceof MediaConversionError && error.code === 'CONVERTER_UNAVAILABLE') {
        log.error('[core:photo] a HEIC photo arrived but heif-convert is not installed; it was refused as unreadable');
      }
      return { kind: 'unsupported' };
    }
  }
  const mediaType = sniffBlobMediaType(bytes);
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp') {
    return { kind: 'unsupported' };
  }
  try {
    return { kind: 'stored', ref: await store.put(bytes, mediaType) };
  } catch {
    return { kind: 'store_unavailable' };
  }
}
