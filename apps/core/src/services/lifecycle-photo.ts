/** Core-owned Telegram photo admission. Restate receives only the content reference. */
import { sniffBlobMediaType, type BlobRef } from '@hawa/contracts';
import type { BlobStore } from '@hawa/db';

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
      (typeof file.mime_type !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']
        .includes(file.mime_type.trim().toLowerCase()))) return null;
  // A document thumbnail is a different, usually smaller file and is never selected here.
  return file.file_id;
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
