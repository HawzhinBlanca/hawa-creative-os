import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';

/**
 * What the worker sends a requester when their approved design is delivered, when their request
 * could not be started at all, and when its outcome could not reach Core. All go to the Telegram chat
 * the request came from.
 */

export interface TelegramSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** The part of the Telegram bridge the outbox handlers use; a test supplies its own. */
export interface TelegramSender {
  dispatchOutboundMessage(chatId: string | number, message: { text: string; parse_mode?: string }): Promise<TelegramSendResult>;
  dispatchOutboundDocument(
    chatId: string | number,
    fileBytes: Uint8Array,
    filename: string,
    options?: { mimeType?: string; caption?: string; parseMode?: 'HTML' | 'Markdown'; timeoutMs?: number }
  ): Promise<TelegramSendResult>;
}

/** A delivered file as Core names it in the `notify.published` payload. */
export interface DeliveredFile {
  artifactId: string;
  format?: string;
  filename: string;
  mimeType?: string;
  sha256: string;
  byteSize?: number;
  driveFileId?: string | null;
  webViewLink?: string | null;
}

export type ExportBytesReader = (
  db: Kysely<Database>,
  tenantId: string,
  taskId: string,
  artifactId: string
) => Promise<Uint8Array | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored bytes of one Canva export, read under the command's tenant. */
export const readStoredExportBytes: ExportBytesReader = async (db, tenantId, taskId, artifactId) => {
  if (![tenantId, taskId, artifactId].every((id) => UUID.test(String(id)))) return null;
  const row = (await sql<{ content: Buffer }>`SELECT content FROM hawa.canva_export_bytes
    WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid AND id = ${artifactId}::uuid`.execute(db)).rows[0];
  return row?.content ? new Uint8Array(row.content) : null;
};

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The Drive archive problem as a client reads it. Core passes its failure code through when it has no
 * words for it, so a client was shown "INVALID_DESTINATION" or "DRIVE_LOOKUP_FAILED" (2026-09-23). A
 * known code is said in plain English, any other code (upper case with underscores, alone or leading
 * a detail) is described generically, and a reason already in words is kept as it is.
 */
const ARCHIVE_PROBLEMS: Record<string, string> = {
  INVALID_DESTINATION: "the client's Drive folder is not set up",
  CREDENTIALS_MISSING: 'the office Google account is not connected',
};
const ARCHIVE_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=$|[\s:(])/;
function describeArchiveProblem(problem: unknown): string {
  const text = String(problem).trim();
  const code = ARCHIVE_CODE.exec(text)?.[1];
  if (!code) return text;
  return ARCHIVE_PROBLEMS[code] || 'Google Drive did not accept the upload';
}

/**
 * The delivery message, in Telegram HTML. Every value that came from a person (the title, file
 * names, the Sheets problem) is escaped: the old message used Markdown asterisks and was sent with
 * no parse mode, so the requester saw the asterisks, and an unescaped title could break parsing.
 */
export function composeDeliveredMessage(
  payload: Record<string, unknown> & { title?: string | null; files?: unknown } | null | undefined,
  options: { filesSent: number; filesUncertain?: number }
): string {
  // A file whose upload Telegram did not confirm may or may not be above. The notice said "has been
  // delivered" all the same (2026-09-24); it now says what is known, and the office is alerted.
  const uncertain = options.filesUncertain ?? 0;
  const lines: string[] = [
    uncertain > 0 ? '<b>Your approved design was sent, but Telegram did not confirm that it arrived.</b>' : '<b>Your approved design has been delivered.</b>',
  ];
  if (payload?.title) lines.push(`Request: <b>${escapeTelegramHtml(payload.title)}</b>`);

  const files: DeliveredFile[] = Array.isArray(payload?.files) ? payload.files : [];
  if (options.filesSent > 0) {
    lines.push(options.filesSent === 1 ? 'The approved file is attached above.' : `The ${options.filesSent} approved files are attached above.`);
  }
  if (uncertain > 0) {
    lines.push(
      uncertain === 1
        ? 'The office will check that the approved file reached you, and send it again if it did not.'
        : `The office will check that the ${uncertain} approved files reached you, and send again any that did not.`
    );
  }
  const linked = files.filter((f) => f.webViewLink);
  if (linked.length > 0) {
    lines.push(['In Google Drive:', ...linked.map((f) => `• <a href="${escapeTelegramHtml(f.webViewLink)}">${escapeTelegramHtml(f.filename)}</a>`)].join('\n'));
  } else if (payload?.driveFolderId) {
    // Commands written before the files were named carry only the folder.
    lines.push(`In Google Drive: <a href="${escapeTelegramHtml(`https://drive.google.com/drive/folders/${payload.driveFolderId}`)}">delivery folder</a>`);
  }

  if (payload?.archiveProblem) {
    // The files reached the requester; the office's Drive archive is reported, not hidden.
    lines.push(`Office archive: not saved to Google Drive yet (${escapeTelegramHtml(describeArchiveProblem(payload.archiveProblem))}).`);
    return lines.join('\n\n');
  }
  // Older commands were written only after the Sheets row was confirmed, and carry no flag.
  const sheetsConfirmed = payload?.sheetsConfirmed ?? true;
  if (sheetsConfirmed && payload?.spreadsheetId && payload?.sheetRowNumber) {
    const url = `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}#gid=0&range=A${payload.sheetRowNumber}`;
    lines.push(`Production log: <a href="${escapeTelegramHtml(url)}">row ${escapeTelegramHtml(payload.sheetRowNumber)}</a> recorded.`);
  } else if (!sheetsConfirmed) {
    lines.push(`Production log: not updated yet (${escapeTelegramHtml(payload?.sheetProblem || 'the row was not confirmed')}).`);
  }
  return lines.join('\n\n');
}

/** The requester's notice when a request could not be started. Plain text, no formatting. */
export function composeIntakeFailedMessage(taskId: string): string {
  return [
    'Sorry, we could not process your design request.',
    'The office has been alerted and will follow up with you.',
    `Reference: ${String(taskId).slice(0, 8)}`,
  ].join('\n');
}

/** The office's alert for the same failure. Plain text, no formatting. */
export function composeIntakeFailedAlert(taskId: string, chatId: string, attempts: number, error: string): string {
  return [
    'Hawa alert: a design request could not be started and was dead-lettered.',
    `Task: ${taskId}`,
    `Requesting chat: ${chatId}`,
    `Attempts: ${attempts}`,
    `Last error: ${error.slice(0, 500)}`,
    'The requester has been told. Redrive it from the Desk once the cause is fixed.',
  ].join('\n');
}

/** The office's alert when an approved design could not be delivered. Plain text, no formatting. */
export function composeDeliveryFailedAlert(taskId: string, chatId: string | null, attempts: number, error: string): string {
  return [
    'Hawa alert: an approved design could not be delivered to the requester.',
    `Task: ${taskId}`,
    `Requesting chat: ${chatId || 'unknown'}`,
    `Attempts: ${attempts}`,
    `Last error: ${error.slice(0, 500)}`,
    'The requester has not been told. Files sent before the failure stay sent; check the chat and follow up with them directly.',
  ].join('\n');
}

/**
 * The requester's notice when their workflow finished but Core, which records the outcome and
 * composes the usual message, did not answer (outcome-without-core.ts). It says only what the worker
 * knows. Plain text, no formatting.
 */
export function composeOutcomeUnrecordedMessage(input: { taskId: string; title?: string | null; draftMade: boolean; officeAlerted: boolean }): string {
  return [
    input.draftMade
      ? 'Your design was made in Canva, but Hawa could not record it, because one of its services was not answering.'
      : "Your design request could not be finished automatically, because one of Hawa's services was not answering.",
    ...(input.title ? [`Request: ${input.title}`] : []),
    input.officeAlerted ? 'The office has been alerted and will follow up with you here.' : 'The office will follow up with you here.',
    `Reference: ${String(input.taskId).slice(0, 8)}`,
  ].join('\n');
}

/** The office's alert for the same outcome. Plain text, no formatting. */
export function composeOutcomeUnrecordedAlert(input: {
  taskId: string;
  status: string;
  code?: string;
  designId?: string;
  requesterChat: string | null;
  requesterTold: boolean;
}): string {
  return [
    'Hawa alert: a design workflow finished while Core was not answering, so its outcome is not recorded on the task yet.',
    `Task: ${input.taskId}`,
    `Outcome: ${input.status}${input.code ? ` (${input.code})` : ''}`,
    ...(input.designId ? [`Canva design: ${input.designId}`] : []),
    `Requesting chat: ${input.requesterChat || 'unknown'}`,
    input.requesterTold
      ? 'The requester has been told that the office will follow up.'
      : 'The requester has not been told.',
    'The outcome is sent to Core again until Core takes it. Check the task in the Desk once Core is back.',
  ].join('\n');
}

/**
 * The office's alert when Telegram did not confirm that an approved file or the delivery notice
 * reached the requester. It is not resent, so it cannot arrive twice; a person has to look. Plain
 * text, no formatting.
 */
export function composeDeliveryUncertainAlert(taskId: string, chatId: string | null, error: string): string {
  return [
    'Hawa alert: Telegram did not confirm that an approved design, or its delivery notice, reached the requester.',
    `Task: ${taskId}`,
    `Requesting chat: ${chatId || 'unknown'}`,
    `Last error (it names what was not confirmed): ${error.slice(0, 500)}`,
    'Nothing was sent twice. Look in the requester\'s chat, and send by hand whatever is not there.',
  ].join('\n');
}

/** The Telegram chat a `task.created` payload came from, or null. */
export function intakeChatOf(payload: Record<string, unknown> | null | undefined): string | null {
  const source = ((payload?.payload as Record<string, unknown> | undefined) || payload || {}) as { sourcePlatform?: unknown; sourceChannelId?: unknown };
  if (source.sourcePlatform && source.sourcePlatform !== 'telegram') return null;
  const channel = source.sourceChannelId;
  if (channel === undefined || channel === null) return null;
  const id = String(channel).trim();
  return id && id !== 'tg_default' && id !== 'hawa_desk' ? id : null;
}
