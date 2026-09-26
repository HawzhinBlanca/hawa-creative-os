/** Core-owned Telegram photo admission. Restate receives only the content reference. */
import { sniffBlobMediaType, type BlobRef } from '@hawa/contracts';
import type { BlobStore } from '@hawa/db';

const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;

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
