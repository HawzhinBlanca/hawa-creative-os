import { createHash } from 'node:crypto';
import { OUTBOX_SEND_MARK_SOURCE, sql, type Database, type Kysely } from '@hawa/db';
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
  /** On a 429: how long Telegram asked the bot to wait, in seconds (telegram-bridge.ts). */
  retryAfterSeconds?: number;
}

/** The part of the Telegram bridge the outbox handlers use; a test supplies its own. */
export interface TelegramSender {
  dispatchOutboundMessage(chatId: string | number, message: { text: string; parse_mode?: string; reply_markup?: unknown }): Promise<TelegramSendResult>;
  /** The answer to a tapped button (TelegramSender, slice 2.3). */
  answerCallbackQuery?(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<boolean>;
  /** A picture with a caption: the draft the requester replies to (TelegramSender, slice 2.3). */
  dispatchOutboundPhoto?(chatId: string | number, photo: Buffer, caption?: string, replyMarkup?: unknown): Promise<TelegramSendResult>;
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
 * What the outbox has done with each Telegram send of one command, so a worker that takes over a
 * command another one stopped in the middle of never sends the same thing twice. Telegram offers no
 * idempotency key, so each send is written down before it is made and again once Telegram answers.
 *
 * Each step of a command (a delivered file by its artifact id, 'notice', 'message') is recorded in
 * hawa.inbox_events, which the app role can only append to, as `<command id>:<step>` from source
 * 'telegram_delivery', with the outcome at the end of the event kind:
 * - attempted: about to send, written only while the worker still holds the command's claim
 *   (OutboxRepository.fenceClaim). With no later outcome, the worker stopped mid-send: it may have arrived.
 * - sent: Telegram confirmed it. Never sent again, not even on an administrator's replay.
 * - uncertain: Telegram did not confirm it (the answer was lost). Not sent again automatically.
 * - failed: Telegram refused it, so it did not arrive, and a later attempt may send it.
 * - released: an administrator checked the chat and confirmed the replay (Core's requeue or redrive
 *   with confirmUncertainReplay, through OutboxRepository.releaseUncertainSends), so it may be sent
 *   again. Nothing else releases a send: a requeue alone restarts the command, not the send.
 * Rows written before 2026-09-24 have only `telegram_document_sent` and `telegram_document_uncertain`.
 */
export type SendMarkOutcome = 'attempted' | 'sent' | 'uncertain' | 'failed' | 'released';
export type SendStepKind = 'document' | 'notice' | 'message';
/** Where an earlier attempt left a step: sent, or possibly sent (uncertain). Absent means free to send. */
export type PriorSend = 'sent' | 'uncertain';

export const TELEGRAM_DELIVERY_SOURCE = OUTBOX_SEND_MARK_SOURCE;
const MARK_KIND = /^telegram_(document|notice|message)_(attempted|sent|uncertain|failed|released)$/;

/** Every step's latest mark for one command, with the kind of send it was. Read under the command's tenant. */
export async function readSendMarks(
  db: Kysely<Database>,
  tenantId: string,
  commandId: string
): Promise<Map<string, { kind: SendStepKind; outcome: SendMarkOutcome }>> {
  const rows = (await sql<{ source_event_id: string; event_kind: string }>`SELECT source_event_id, event_kind FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${TELEGRAM_DELIVERY_SOURCE}
      AND source_event_id LIKE ${`${commandId}:%`}
    ORDER BY received_at ASC, id ASC`.execute(db)).rows;
  const marks = new Map<string, { kind: SendStepKind; outcome: SendMarkOutcome }>();
  for (const row of rows) {
    const m = MARK_KIND.exec(row.event_kind);
    if (m) marks.set(row.source_event_id.slice(commandId.length + 1), { kind: m[1] as SendStepKind, outcome: m[2] as SendMarkOutcome });
  }
  return marks;
}

/**
 * The latest mark of one step, read by its exact key. TelegramSender (lifecycle/telegram-sender.ts)
 * fences each message under `lc:<message key>` with the one step 'send'. readSendMarks reads a
 * command's steps by prefix (LIKE), where `_` in a key would match any character; a message key is
 * matched exactly instead. Read under the message's tenant.
 */
export async function readSendMark(
  db: Kysely<Database>,
  tenantId: string,
  commandId: string,
  step: string
): Promise<{ kind: SendStepKind; outcome: SendMarkOutcome } | undefined> {
  const rows = (await sql<{ event_kind: string }>`SELECT event_kind FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${TELEGRAM_DELIVERY_SOURCE}
      AND source_event_id = ${`${commandId}:${step}`}
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(db)).rows;
  const m = rows[0] ? MARK_KIND.exec(rows[0].event_kind) : null;
  return m ? { kind: m[1] as SendStepKind, outcome: m[2] as SendMarkOutcome } : undefined;
}

/** What a step's latest mark means for a new attempt. */
export function priorSendOf(mark: SendMarkOutcome | undefined): PriorSend | undefined {
  if (mark === 'sent') return 'sent';
  if (mark === 'attempted' || mark === 'uncertain') return 'uncertain';
  return undefined;
}

/**
 * Appends one mark. `received_at` is the clock at the insert, not the transaction's start, so the
 * marks of one step, each written in its own transaction, keep the order they were made in.
 */
export async function writeSendMark(
  db: Kysely<Database>,
  tenantId: string,
  commandId: string,
  step: string,
  kind: SendStepKind,
  outcome: SendMarkOutcome
): Promise<void> {
  const key = `${commandId}:${step}`;
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
    VALUES (${tenantId}::uuid, ${TELEGRAM_DELIVERY_SOURCE}, ${key}, ${`telegram_${kind}_${outcome}`},
      ${JSON.stringify({ commandId, step, outcome })}::jsonb, ${`${key}:${outcome}`}, true, clock_timestamp())`.execute(db);
}

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

/**
 * The office's alert when Telegram did not confirm that a message from the outbox (a draft's link,
 * a question, a reminder) reached its chat. It is not resent, so it cannot arrive twice. Plain text,
 * no formatting.
 */
export function composeMessageUncertainAlert(taskId: string, chatId: string, error: string): string {
  return [
    'Hawa alert: Telegram did not confirm that a message from Hawa reached its chat.',
    `Task: ${taskId}`,
    `Chat: ${chatId}`,
    `Last error: ${error.slice(0, 500)}`,
    'Nothing was sent twice. Look in the chat, and send by hand whatever is not there.',
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
