import type { PinnedExport } from '@hawa/domain';
import { deliverableFormat } from './pinned-deliverables.js';

/**
 * The `notify.published` outbox command: what the worker needs to tell the requester that the
 * approved design was delivered, and to send them the files.
 *
 * It is written once the approved files are verified in Drive. It used to be written only when the
 * Sheets row was confirmed as well, so a client without a ledger, or a row Google did not confirm,
 * left the requester unnotified for good, and the message carried only the client's root folder
 * link: never the file. The Sheets outcome now travels with it and is reported separately.
 */

/** One delivered file: the pinned export the worker sends, and where it sits in Drive. */
export interface DeliveredFileRef {
  artifactId: string;
  format: PinnedExport['format'];
  filename: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  driveFileId: string | null;
  webViewLink: string | null;
}

export interface DeliveredNotificationPayload {
  /** Set when the files go to the requester although the Drive archive could not be written. */
  archiveProblem?: string | null;
  taskId: string;
  clientId: string | null;
  title: string | null;
  /** The Telegram chat the request came from; null when the task has no chat requester. */
  chatId: string | null;
  publicationKey: string;
  driveFolderId: string;
  spreadsheetId: string;
  sheetsConfirmed: boolean;
  sheetRowNumber: number | null;
  sheetProblem: string | null;
  filesCount: number;
  files: DeliveredFileRef[];
  publishedAt: string;
}

/** One notification per publication: a retry that later confirms the Sheets row does not notify twice. */
export function deliveredNotificationKey(taskId: string, publicationKey: string): string {
  return `notify_pub_${taskId}_${publicationKey}`;
}

type IntakeSource = { sourcePlatform?: unknown; sourceChannelId?: unknown } | null | undefined;

const chatOf = (source: IntakeSource): string | null => {
  const channel = source?.sourceChannelId;
  if (source?.sourcePlatform !== 'telegram' || channel === undefined || channel === null) return null;
  const id = String(channel).trim();
  return id && id !== 'tg_default' ? id : null;
};

/** The requesting chat named by a task's `task.created` event data. */
export function requesterChatFromIntake(eventData: { payload?: IntakeSource; body?: IntakeSource } & Record<string, unknown> | null | undefined): string | null {
  return chatOf(eventData?.payload || eventData?.body || (eventData as IntakeSource) || {});
}

/**
 * The requesting chat: the in-memory task first (chat intake records its source there), then the
 * durable `task.created` event.
 */
export async function resolveRequesterChat(task: IntakeSource, readIntakeEvent?: () => Promise<Parameters<typeof requesterChatFromIntake>[0]>): Promise<string | null> {
  const fromTask = chatOf(task);
  if (fromTask) return fromTask;
  if (!readIntakeEvent) return null;
  try {
    return requesterChatFromIntake(await readIntakeEvent());
  } catch (err) {
    console.warn('[core:delivery-notification] Could not read the task intake to find the requester chat:', err);
    return null;
  }
}

interface ReceiptLike {
  state: string;
  driveFiles?: Array<{ artifactId?: string; fileId?: string; name?: string; mimeType?: string; observedSize?: number; expectedSha256?: string; verified?: boolean; webViewLink?: string }>;
  sheet?: { rowNumber?: number; synced?: boolean };
  detail?: { sheetProblem?: string | null } & Record<string, unknown>;
}

interface PackageFileLike {
  artifactId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
}

/**
 * The payload for a publication whose files Drive verified, or null when no file was verified (then
 * nothing was delivered and there is nothing to announce).
 */
export function buildDeliveredNotificationPayload(input: {
  taskId: string;
  clientId?: string | null;
  title?: string | null;
  chatId: string | null;
  publicationKey: string;
  driveFolderId: string;
  spreadsheetId?: string | null;
  receipt: ReceiptLike;
  pins?: PinnedExport[];
  files: PackageFileLike[];
  now?: Date;
}): DeliveredNotificationPayload | null {
  const verified = (input.receipt.driveFiles || []).filter((f) => f.verified);
  if (verified.length === 0) return null;
  const files: DeliveredFileRef[] = verified.flatMap((drive) => {
    const packaged = input.files.find((f) => f.artifactId === drive.artifactId);
    if (!packaged) return [];
    const pin = input.pins?.find((p) => p.artifactId === packaged.artifactId);
    const extension = packaged.filename.split('.').pop() || '';
    return [{
      artifactId: packaged.artifactId,
      format: deliverableFormat(pin?.format || extension),
      filename: packaged.filename,
      mimeType: packaged.mimeType,
      sha256: packaged.sha256,
      byteSize: packaged.byteSize,
      driveFileId: drive.fileId || null,
      webViewLink: drive.webViewLink || (drive.fileId ? `https://drive.google.com/file/d/${drive.fileId}/view` : null),
    }];
  });
  const sheetsConfirmed = input.receipt.state === 'complete';
  return {
    taskId: input.taskId,
    clientId: input.clientId ?? null,
    title: input.title ?? null,
    chatId: input.chatId,
    publicationKey: input.publicationKey,
    driveFolderId: input.driveFolderId,
    spreadsheetId: input.spreadsheetId || '',
    sheetsConfirmed,
    sheetRowNumber: sheetsConfirmed && input.receipt.sheet?.rowNumber !== undefined ? input.receipt.sheet.rowNumber : null,
    sheetProblem: sheetsConfirmed ? null : input.receipt.detail?.sheetProblem || 'The Sheets row was not confirmed',
    filesCount: verified.length,
    files,
    publishedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * The approved files for the requester when the Drive archive could not be written (no Google
 * credential, no destination, Drive down). The approval is the office's decision and the files are
 * the pinned exports already stored and hash-checked, so the person who asked for the design gets
 * it; the archive is reported, to them and in Desk, as not written yet. Production ran with a
 * placeholder Google credential on 2026-09-23, so no approved design would ever have reached anyone.
 */
export function buildChatOnlyNotificationPayload(input: {
  taskId: string;
  clientId?: string | null;
  title?: string | null;
  chatId: string | null;
  publicationKey: string;
  pins?: PinnedExport[];
  files: PackageFileLike[];
  archiveProblem: string;
  now?: Date;
}): DeliveredNotificationPayload | null {
  if (!input.files.length) return null;
  const files: DeliveredFileRef[] = input.files.map((packaged) => {
    const pin = input.pins?.find((p) => p.artifactId === packaged.artifactId);
    const extension = packaged.filename.split('.').pop() || '';
    return {
      artifactId: packaged.artifactId,
      format: deliverableFormat(pin?.format || extension),
      filename: packaged.filename,
      mimeType: packaged.mimeType,
      sha256: packaged.sha256,
      byteSize: packaged.byteSize,
      driveFileId: null,
      webViewLink: null,
    };
  });
  return {
    archiveProblem: input.archiveProblem,
    taskId: input.taskId,
    clientId: input.clientId ?? null,
    title: input.title ?? null,
    chatId: input.chatId,
    publicationKey: input.publicationKey,
    driveFolderId: '',
    spreadsheetId: '',
    sheetsConfirmed: false,
    sheetRowNumber: null,
    sheetProblem: null,
    filesCount: files.length,
    files,
    publishedAt: (input.now ?? new Date()).toISOString(),
  };
}
