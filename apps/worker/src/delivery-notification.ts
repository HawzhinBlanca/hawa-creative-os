import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';

/**
 * What the worker sends a requester when their approved design is delivered, and when their request
 * could not be started at all. Both go to the Telegram chat the request came from.
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
export function composeDeliveredMessage(payload: Record<string, unknown> & { title?: string | null; files?: unknown } | null | undefined, options: { filesSent: number }): string {
  const lines: string[] = ['<b>Your approved design has been delivered.</b>'];
  if (payload?.title) lines.push(`Request: <b>${escapeTelegramHtml(payload.title)}</b>`);

  const files: DeliveredFile[] = Array.isArray(payload?.files) ? payload.files : [];
  if (options.filesSent > 0) {
    lines.push(options.filesSent === 1 ? 'The approved file is attached above.' : `The ${options.filesSent} approved files are attached above.`);
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

/** The Telegram chat a `task.created` payload came from, or null. */
export function intakeChatOf(payload: Record<string, unknown> | null | undefined): string | null {
  const source = ((payload?.payload as Record<string, unknown> | undefined) || payload || {}) as { sourcePlatform?: unknown; sourceChannelId?: unknown };
  if (source.sourcePlatform && source.sourcePlatform !== 'telegram') return null;
  const channel = source.sourceChannelId;
  if (channel === undefined || channel === null) return null;
  const id = String(channel).trim();
  return id && id !== 'tg_default' && id !== 'hawa_desk' ? id : null;
}
