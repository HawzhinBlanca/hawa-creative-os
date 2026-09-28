import { parseBlobRef, type BlobRef } from './blobs.js';

export interface LifecycleAlbumRef {
  updateId: number;
  sha256: string;
  images: BlobRef[];
}

export function parseLifecycleAlbumRef(value: unknown): LifecycleAlbumRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.updateId) || Number(v.updateId) <= 0 ||
      typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256) ||
      !Array.isArray(v.images) || v.images.length < 2 || v.images.length > 10) return null;
  const images = v.images.map(parseBlobRef);
  if (images.some((image) => !image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) ||
      image.size > 20 * 1024 * 1024) ||
      images.reduce((sum, image) => sum + (image?.size ?? 0), 0) > 100 * 1024 * 1024) return null;
  return { updateId: Number(v.updateId), sha256: v.sha256, images: images as BlobRef[] };
}
