/**
 * The round-zero brief RequestLifecycle may open (its `createRequest` operation), as Core reads it from
 * a worker, and as Core's own Desk intake builds it (ADR-287): only the contract's fields, each checked.
 * Moved out of lifecycle-internal.routes.ts so the Desk intake and the worker's projection normalise a
 * brief the same way, which is what makes the worker's replay of a Desk open hash-identical.
 */
import { parseBlobRef, parseLifecycleAlbumRef, parseLifecycleSourceRef } from '@hawa/contracts';
import { parseStudioImagery, parseStudioTier } from '@hawa/domain';
import { WEB_CHANNEL } from '../customer/customer-web-lifecycle.js';
import type { ChatIntake } from './chat-intake.js';
import { DESK_CHANNEL } from './office-desk-channel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function openDraft(value: unknown, requestId: string): ChatIntake | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (!['telegram','hawzhin_web','hawa_desk'].includes(String(d.platform)) || d.sourceEventId !== `lc-${requestId}-r0` ||
      typeof d.sourceChannelId !== 'string' || !(d.platform==='hawzhin_web' ? WEB_CHANNEL.test(d.sourceChannelId)
        : d.platform==='hawa_desk' ? DESK_CHANNEL.test(d.sourceChannelId) : /^-?\d{1,20}$/.test(d.sourceChannelId)) ||
      typeof d.rawText !== 'string' || !d.rawText.trim() || d.rawText.length > 100_000 ||
      typeof d.title !== 'string' || !d.title.trim() || d.title.length > 500 ||
      typeof d.designInstructions !== 'string' || d.designInstructions.length > 100_000 ||
      !Array.isArray(d.exactCopy) || d.exactCopy.length > 500 || JSON.stringify(d.exactCopy).length > 100_000 ||
      !(d.clientId === null || (typeof d.clientId === 'string' && UUID.test(d.clientId))) ||
      (d.autoGenerate !== undefined && typeof d.autoGenerate !== 'boolean') ||
      (d.isInstructionOnly !== undefined && typeof d.isInstructionOnly !== 'boolean')) return null;
  const variant = d.variant;
  if (variant !== undefined && (!variant || typeof variant !== 'object' ||
      !Number.isInteger((variant as any).width) || !Number.isInteger((variant as any).height) ||
      (variant as any).width < 640 || (variant as any).width > 2400 ||
      (variant as any).height < 640 || (variant as any).height > 2400)) return null;
  if (d.designStudio !== undefined && typeof d.designStudio !== 'boolean') return null;
  // ADR-232: copy taken from a request sentence, and its receipt (server-authored at intake).
  const copyFields = (['headlineEn', 'headlineCkb', 'copyEn', 'copyCkb'] as const).filter((key) => d[key] !== undefined);
  if (copyFields.some((key) => typeof d[key] !== 'string' || (d[key] as string).length > 100_000)) return null;
  const receipt = d.copyExtraction;
  if (receipt !== undefined && (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      (receipt as { v?: unknown }).v !== 1 || JSON.stringify(receipt).length > 20_000)) return null;
  const options = d.studioOptions;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
      JSON.stringify(options).length > 2000 ||
      (Object.keys(options).some((key) => !['tier', 'imagery', 'previews', 'holdForSelection'].includes(key))) ||
      parseStudioTier((options as { tier?: unknown }).tier) === null ||
      parseStudioImagery((options as { imagery?: unknown }).imagery) === null ||
      ((options as any).previews !== undefined && (!Number.isInteger((options as any).previews) || (options as any).previews < 1 || (options as any).previews > 4)) ||
      ((options as any).holdForSelection !== undefined && typeof (options as any).holdForSelection !== 'boolean'))) return null;
  const image = d.lifecycleImage;
  const source = d.lifecycleSource === undefined ? undefined : parseLifecycleSourceRef(d.lifecycleSource);
  if (d.lifecycleSource !== undefined && (!source || image || d.lifecycleAlbum)) return null;
  const album = d.lifecycleAlbum === undefined ? undefined : parseLifecycleAlbumRef(d.lifecycleAlbum);
  if ((d.lifecycleAlbum !== undefined && !album) || (image && album)) return null;
  const imageRef = image === undefined ? undefined : parseBlobRef(image);
  if (image !== undefined && (!imageRef || !Number.isSafeInteger((image as any).updateId) ||
      (image as any).updateId <= 0 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(imageRef.mediaType) ||
      imageRef.size > 20 * 1024 * 1024)) return null;
  // ADR279/292: the moved shared parser preserves the owner's web manifest.
  // ADR285's empty manifest marks a website request with no supplied photos;
  // projection still compares every ref with the owner's retained receipts.
  let webPhotos: ChatIntake['customerWebPhotos'];
  if (d.customerWebPhotos !== undefined) {
    const manifest=d.customerWebPhotos;
    if(d.platform!=='hawzhin_web' || image || album || source || !manifest || typeof manifest!=='object' || Array.isArray(manifest)) return null;
    const m=manifest as Record<string,unknown>;
    if(Object.keys(m).some(k=>!['v','images'].includes(k)) || m.v!==1 || !Array.isArray(m.images) || m.images.length>20) return null;
    const images=m.images.map(parseBlobRef);
    if(m.images.some(ref=>!ref || typeof ref!=='object' || Array.isArray(ref) || Object.keys(ref).some(k=>!['sha256','mediaType','size'].includes(k))) ||
      images.some(ref=>!ref || !['image/png','image/jpeg','image/webp'].includes(ref.mediaType) || ref.size>10*1024*1024) ||
      new Set(images.map(ref=>ref?.sha256)).size!==images.length) return null;
    webPhotos={v:1,images:images as NonNullable<ChatIntake['customerWebPhotos']>['images']};
  }
  // Select the contract explicitly. A worker payload cannot choose the database principal, tenant,
  // outbox owner or a second source through spare JSON fields.
  return {
    platform: d.platform as ChatIntake['platform'], sourceEventId: d.sourceEventId as string, sourceChannelId: d.sourceChannelId as string,
    rawText: d.rawText as string, title: d.title as string,
    designInstructions: d.designInstructions as string, exactCopy: d.exactCopy as unknown[],
    clientId: d.clientId as string | null,
    ...(d.autoGenerate !== undefined ? { autoGenerate: d.autoGenerate as boolean } : {}),
    ...(d.isInstructionOnly !== undefined ? { isInstructionOnly: d.isInstructionOnly as boolean } : {}),
    ...(variant ? { variant: variant as { width: number; height: number } } : {}),
    ...(d.designStudio !== undefined ? { designStudio: d.designStudio as boolean } : {}),
    ...Object.fromEntries(copyFields.map((key) => [key, d[key] as string])),
    ...(receipt !== undefined ? { copyExtraction: receipt as ChatIntake['copyExtraction'] } : {}),
    ...(options ? { studioOptions: options as ChatIntake['studioOptions'] } : {}),
    ...(imageRef ? { lifecycleImage: { ...imageRef, updateId: (image as { updateId: number }).updateId } } : {}),
    ...(album ? { lifecycleAlbum: album } : {}),
    ...(source ? { lifecycleSource: source } : {}),
    ...(webPhotos ? {customerWebPhotos:webPhotos} : {}),
  };
}
