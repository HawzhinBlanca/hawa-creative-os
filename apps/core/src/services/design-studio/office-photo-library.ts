import { createHash } from 'node:crypto';
import {
  imagePixelSize,
  loadOfficeLibraryPhoto,
  officePhotoClientDir,
  officePhotoExclusions,
  officePhotoLibraryRoot,
  readOfficePhotoLibrary,
  selectOfficeLibraryPhotos,
  type OfficePhotoEntry,
  type OfficePhotoExclusion,
  type OfficePhotoLibrary,
} from '@hawa/creative';
import { log } from '../../logging.js';
import type { ContentPhoto, CreativeBrief, StageContext } from './types.js';

/**
 * ADR-280: the office photo library hook. When the requester sent no picture at all, the client has
 * a library, and HAWA_OFFICE_PHOTO_LIBRARY is on (default off), the run is given one to three of the
 * office's own archive photos as content photos, so the existing photo recipes design with them.
 *
 * - The photos are the office's, never presented as the requester's: the brief's photosSent stays 0,
 *   and the run records them under stages.officePhotoLibrary with provenance `office_library`.
 * - They never replace or join a requester's photos, and a website (customer) request never gets them.
 * - The design may choose among them (photoSelection `choose`, minimum 1).
 * - The choice is made once per run and kept for its later stages; a revision keeps its parent's.
 * - Copy is never touched. Only photos a person marked usable, with people stated and consent
 *   recorded where people are shown, can be picked (office-photo-library.ts in @hawa/creative).
 */

export const OFFICE_PHOTO_LIBRARY_FLAG = 'HAWA_OFFICE_PHOTO_LIBRARY';

export function officePhotoLibraryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env[OFFICE_PHOTO_LIBRARY_FLAG]?.trim() ?? '');
}

export interface OfficeLibraryRunPhoto {
  photoIndex: number;
  id: string;
  sha256: string;
  storedSha256: string;
  score: number;
  reasons: string[];
  description?: string;
  date?: string;
}

/** What the run records (stages.officePhotoLibrary), for the Desk and for the run's later stages. */
export interface OfficeLibraryRunRecord {
  version: 1;
  provenance: 'office_library';
  status: 'attached' | 'no_match' | 'unavailable';
  clientId: string;
  /** The stage that made the choice. */
  stage: string;
  manifestSha256?: string;
  photos: OfficeLibraryRunPhoto[];
  photoSelection?: { mode: 'choose'; minimum: 1 };
  considered?: number;
  eligible?: number;
  excluded?: Partial<Record<OfficePhotoExclusion, number>>;
  briefTerms?: string[];
  briefEvents?: string[];
  inheritedFromParent?: boolean;
  reason?: string;
}

export interface OfficeLibraryHookInput {
  /** The run's status: nothing is attached while briefing, so the brief records only the requester's own pictures. */
  status: string;
  /** How many images the request itself carries (photos, references, logos). Any at all: the library is not used. */
  requesterImages: number;
  /** The run's request, for a revision's parent. */
  request: unknown;
  /**
   * Whether the request came from the website (a customer's own request). A website request that sent
   * no photo carries no webPhotoPolicy, so the context alone cannot tell; this asks the task's origin.
   * A failed answer counts as a website request: the archive is then not used.
   */
  websiteRequest?: () => Promise<boolean>;
  /** The office-library record of a revision's parent run, if any. */
  parentRecord?: (parentTaskId: string) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The reason a run records (and the Desk shows). The library's own refusals name no path; a filesystem
 * error does ("EACCES: permission denied, open '/srv/…/library.json'"), so it is logged and recorded by
 * its code only.
 */
function recordedReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/^OFFICE_PHOTO_[A-Z_]+:/.test(message)) return message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return `The photo library could not be read${code ? ` (${code})` : ''}.`;
}
const SELECTION = { mode: 'choose', minimum: 1 } as const;

function isRecord(value: unknown): value is OfficeLibraryRunRecord {
  const v = value as OfficeLibraryRunRecord | undefined;
  return Boolean(v && v.provenance === 'office_library' && v.version === 1 && Array.isArray(v.photos));
}

function contentPhoto(entry: OfficePhotoEntry, bytes: Buffer): ContentPhoto {
  const size = imagePixelSize(bytes);
  const what = entry.tags.description ? `: ${entry.tags.description}` : '';
  return {
    dataUrl: `data:${entry.mimeType};base64,${bytes.toString('base64')}`,
    bytes,
    mimeType: entry.mimeType,
    ...(size ? { width: size.width, height: size.height } : {}),
    notes: `Office archive photo from the client's photo library, not sent by the requester${what}.`,
    review: { ...(entry.tags.shot ? { shot: entry.tags.shot } : {}), quietArea: entry.features.quietArea },
  };
}

/** The recorded photos, loaded again and verified against the current manifest and their hashes. */
async function loadRecorded(clientDir: string, library: OfficePhotoLibrary, photos: OfficeLibraryRunPhoto[]): Promise<ContentPhoto[]> {
  const out: ContentPhoto[] = [];
  for (const p of photos) {
    const entry = library.photos.find((e) => e.id === p.id && e.storedSha256 === p.storedSha256);
    if (!entry) throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${p.id} is no longer in the library as it was chosen`);
    // The rules are applied again on every load, not only when the photo was chosen: a photo the office
    // has since taken back (consent withdrawn, marked not usable) leaves the run and its revisions.
    const withdrawn = [...new Set([...officePhotoExclusions(entry), ...entry.excludedReasons])];
    if (withdrawn.length || entry.status !== 'usable') {
      throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${p.id} may no longer be used (${withdrawn.join(', ') || 'excluded_by_office'})`);
    }
    const { bytes } = await loadOfficeLibraryPhoto(clientDir, entry);
    out.push(contentPhoto(entry, bytes));
  }
  return out;
}

/**
 * The hook (design-studio-service.ts, where a run gathers its photos). Mutates ctx.photos,
 * ctx.photoSelection and stages.officePhotoLibrary only when every condition holds; otherwise it
 * returns having touched nothing.
 */
export async function attachOfficeLibraryPhotos(ctx: StageContext, stages: Record<string, unknown>, input: OfficeLibraryHookInput): Promise<void> {
  const env = input.env ?? process.env;
  if (!officePhotoLibraryEnabled(env)) return;
  if (ctx.webPhotoPolicy) return;
  if (input.status === 'briefing') return;
  if (input.requesterImages > 0 || ctx.photos?.length || ctx.attachedImage || ctx.reference) return;
  if (input.websiteRequest && await input.websiteRequest().catch(() => true)) return;

  let clientDir: string;
  try { clientDir = officePhotoClientDir(officePhotoLibraryRoot(env, input.cwd), ctx.clientId); } catch { return; }
  const recorded = isRecord(stages.officePhotoLibrary) ? stages.officePhotoLibrary : undefined;
  const request = (typeof input.request === 'string' ? JSON.parse(input.request) : input.request) as { directed?: { parentTaskId?: unknown } } | undefined;
  const parentTaskId = typeof request?.directed?.parentTaskId === 'string' ? request.directed.parentTaskId : undefined;

  // The photos an earlier stage of this run, or the design being revised, was given.
  let carried: OfficeLibraryRunRecord | undefined;
  if (recorded) {
    if (recorded.status !== 'attached') return;
    carried = recorded;
  } else if (parentTaskId) {
    const parent = await input.parentRecord?.(parentTaskId).catch(() => undefined);
    if (!isRecord(parent) || parent.status !== 'attached' || parent.clientId !== ctx.clientId) return;
    carried = { ...parent, stage: input.status, inheritedFromParent: true };
  }

  let read: Awaited<ReturnType<typeof readOfficePhotoLibrary>>;
  try {
    read = await readOfficePhotoLibrary(clientDir);
  } catch (err) {
    log.warn(`[office-photo-library] run ${ctx.runId}: library unreadable (${err instanceof Error ? err.message : String(err)})`);
    const reason = recordedReason(err);
    stages.officePhotoLibrary = { ...(carried ?? {}), version: 1, provenance: 'office_library', status: 'unavailable', clientId: ctx.clientId, stage: carried?.stage ?? input.status, photos: carried?.photos ?? [], reason } satisfies OfficeLibraryRunRecord;
    return;
  }
  if (!read) {
    if (carried) stages.officePhotoLibrary = { ...carried, status: 'unavailable', reason: 'The client has no photo library any more.' };
    return;
  }
  if (read.library.clientId !== ctx.clientId) {
    stages.officePhotoLibrary = { version: 1, provenance: 'office_library', status: 'unavailable', clientId: ctx.clientId, stage: input.status, photos: [], reason: 'The library folder belongs to another client.' } satisfies OfficeLibraryRunRecord;
    return;
  }

  if (carried) {
    try {
      ctx.photos = await loadRecorded(clientDir, read.library, carried.photos);
      ctx.photoSelection = { ...SELECTION };
      stages.officePhotoLibrary = carried;
    } catch (err) {
      ctx.photos = undefined;
      stages.officePhotoLibrary = { ...carried, status: 'unavailable', reason: recordedReason(err) };
    }
    return;
  }

  const brief = (stages.brief ?? {}) as Partial<CreativeBrief>;
  const selection = selectOfficeLibraryPhotos(read.library, {
    copy: ctx.copyBlocks.map((b) => b.text),
    eventWords: [...(brief.subjectTags ?? []), ...(brief.occasion ? [brief.occasion] : []), ctx.instructions].filter((w): w is string => typeof w === 'string' && w.length > 0),
    language: ctx.copyBlocks.some((b) => b.script === 'arabic') ? 'ckb' : 'en',
    ...(Array.isArray(brief.toneWords) ? { tone: brief.toneWords.join(' ') } : {}),
    width: ctx.width,
    height: ctx.height,
  });
  const base: OfficeLibraryRunRecord = {
    version: 1, provenance: 'office_library', status: 'no_match', clientId: ctx.clientId, stage: input.status, manifestSha256: read.sha256,
    photos: [], considered: selection.considered, eligible: selection.eligible, excluded: selection.excluded,
    briefTerms: selection.briefTerms.slice(0, 40), briefEvents: selection.briefEvents,
  };
  if (!selection.picks.length) {
    stages.officePhotoLibrary = { ...base, reason: selection.eligible ? 'No usable library photo matches this request.' : 'The library has no usable photo yet.' };
    return;
  }
  const photos: OfficeLibraryRunPhoto[] = selection.picks.map((pick, photoIndex) => {
    const entry = read!.library.photos.find((e) => e.id === pick.id)!;
    return { photoIndex, id: pick.id, sha256: pick.sha256, storedSha256: pick.storedSha256, score: pick.score.total, reasons: pick.reasons,
      ...(entry.tags.description ? { description: entry.tags.description } : {}), ...(entry.tags.date ? { date: entry.tags.date } : {}) };
  });
  try {
    ctx.photos = await loadRecorded(clientDir, read.library, photos);
    ctx.photoSelection = { ...SELECTION };
    stages.officePhotoLibrary = { ...base, status: 'attached', photos, photoSelection: { ...SELECTION } };
  } catch (err) {
    ctx.photos = undefined;
    stages.officePhotoLibrary = { ...base, status: 'unavailable', photos, reason: recordedReason(err) };
  }
}

/**
 * After the run's visual inputs are restored from their pin: the pinned photos are the library's
 * (their hashes match the record), so the design keeps its freedom to choose among them. Does
 * nothing for any run without an attached library record, whatever the flag says.
 */
export function restoreOfficeLibrarySelection(ctx: StageContext, stages: Record<string, unknown>): void {
  const record = stages.officePhotoLibrary;
  if (!isRecord(record) || record.status !== 'attached' || ctx.webPhotoPolicy) return;
  const photos = ctx.photos ?? [];
  if (photos.length !== record.photos.length || photos.some((p, i) => sha(p.bytes) !== record.photos[i].storedSha256)) return;
  ctx.photoSelection = { ...SELECTION };
}
