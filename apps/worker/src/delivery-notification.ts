import { createHash } from 'node:crypto';
import type { DraftImageRef } from '@hawa/contracts';
import { OUTBOX_SEND_MARK_SOURCE, sql, type BlobStore, type Database, type Kysely } from '@hawa/db';
import { LIFECYCLE_MESSAGES, OUTCOME_MESSAGES, bold, escapeTelegramHtml, requesterLang, requesterTitleName, say, type RequesterLang } from '@hawa/integrations';

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
  dispatchOutboundMessage(chatId: string | number, message: { text: string; parse_mode?: string }): Promise<TelegramSendResult>;
  dispatchOutboundDocument(
    chatId: string | number,
    fileBytes: Uint8Array,
    filename: string,
    options?: { mimeType?: string; caption?: string; parseMode?: 'HTML' | 'Markdown'; timeoutMs?: number }
  ): Promise<TelegramSendResult>;
  /** A picture with a plain caption (the office's draft alert, ADR-155 addendum); Telegram recompresses it. */
  dispatchOutboundPhoto?(chatId: string | number, photo: Buffer, caption?: string): Promise<TelegramSendResult>;
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

/** The bytes of a draft picture for the office's alert, read under its tenant; null when they cannot be. */
export type DraftImageReader = (db: Kysely<Database>, ref: DraftImageRef) => Promise<Uint8Array | null>;

/**
 * A draft picture by its reference: a Canva export from its row, a Studio preview from the file store
 * when it has the file (read verified), else from the candidate's row. The caller checks the hash.
 */
export function draftImageReader(readExport: ExportBytesReader, blobStore: () => BlobStore | null): DraftImageReader {
  return async (db, ref) => {
    if (ref.source === 'canva_export') return readExport(db, ref.tenantId, ref.taskId, ref.id);
    if (ref.source !== 'studio_preview' || ![ref.tenantId, ref.taskId, ref.id].every((id) => UUID.test(String(id)))) return null;
    const row = (await sql<{ preview_png: Buffer | null; preview_sha256: string | null }>`SELECT c.preview_png, c.preview_sha256
      FROM hawa.design_studio_candidates c JOIN hawa.design_studio_runs r ON r.id = c.run_id AND r.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${ref.tenantId}::uuid AND c.id = ${ref.id}::uuid AND r.task_id = ${ref.taskId}::uuid`.execute(db)).rows[0];
    if (!row) return null;
    const store = blobStore();
    if (store && row.preview_sha256) {
      try { return new Uint8Array(await store.read(row.preview_sha256, { verify: true })); } catch { /* the row's bytes, if any */ }
    }
    return row.preview_png?.length ? new Uint8Array(row.preview_png) : null;
  };
}

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
export const validTelegramMessageId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

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
): Promise<{ kind: SendStepKind; outcome: SendMarkOutcome; messageId?: string } | undefined> {
  const rows = (await sql<{ event_kind: string; payload: Record<string, unknown> }>`SELECT event_kind, payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${TELEGRAM_DELIVERY_SOURCE}
      AND source_event_id = ${`${commandId}:${step}`}
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(db)).rows;
  const m = rows[0] ? MARK_KIND.exec(rows[0].event_kind) : null;
  return m ? { kind: m[1] as SendStepKind, outcome: m[2] as SendMarkOutcome,
    ...(m[2] === 'sent' && validTelegramMessageId(rows[0].payload?.messageId)
      ? { messageId: rows[0].payload.messageId } : {}) } : undefined;
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
  outcome: SendMarkOutcome,
  messageId?: string,
  /**
   * The chat the message went to (ADR-040 addendum): a Telegram message id is unique only within its
   * chat, and an office member's reply to a draft's picture is matched to the request by chat and id.
   */
  chatId?: string,
  /**
   * ADR-253: a draft's photo alert that went as its plain words (the picture could not be read, or
   * Telegram refused it). Core's Telegram approval needs the picture the member was sent; this says
   * there was none.
   */
  pictureNotSent?: boolean,
): Promise<void> {
  if (messageId !== undefined && (outcome !== 'sent' || !validTelegramMessageId(messageId))) {
    throw new Error('A Telegram message ID must be positive and belong to a sent mark');
  }
  const key = `${commandId}:${step}`;
  const chat = chatId !== undefined && /^-?[1-9][0-9]{0,19}$/.test(chatId) ? { chatId } : {};
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
    VALUES (${tenantId}::uuid, ${TELEGRAM_DELIVERY_SOURCE}, ${key}, ${`telegram_${kind}_${outcome}`},
      ${JSON.stringify({ commandId, step, outcome, ...(messageId ? { messageId } : {}), ...chat, ...(pictureNotSent ? { pictureNotSent: true } : {}) })}::jsonb,
      ${`${key}:${outcome}`}, true, clock_timestamp())`.execute(db);
}

/**
 * ADR-240: the record of a message the nightly canary's sink kept instead of sending: one for the
 * canary chat, or an office alert about a canary request. Appended under the message's own key with
 * the outcome `canary_sink`, which no reader of send marks takes for a sent message (MARK_KIND has no
 * such outcome), so it is never evidence that a requester received anything. The words are kept with
 * it (at most 4,000 characters each) for the audit; the canary itself reads Restate's journal.
 */
export async function writeCanarySinkMark(
  db: Kysely<Database>,
  tenantId: string,
  commandId: string,
  step: string,
  kind: SendStepKind,
  record: { messageId: string; chatId: string; reason: 'canary_chat' | 'canary_request'; kind: string;
    text?: string; caption?: string; filename?: string; canaryFor?: string },
): Promise<void> {
  if (!validTelegramMessageId(record.messageId)) throw new Error('A canary sink record needs a positive message ID');
  const key = `${commandId}:${step}`;
  const words = Object.fromEntries((['text', 'caption', 'filename'] as const)
    .filter((field) => typeof record[field] === 'string').map((field) => [field, Array.from(record[field]!).slice(0, 4000).join('')]));
  const payload = { commandId, step, outcome: 'canary_sink', messageId: record.messageId, chatId: record.chatId, reason: record.reason,
    kind: record.kind, ...words, ...(record.canaryFor ? { canaryFor: record.canaryFor } : {}) };
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
    VALUES (${tenantId}::uuid, ${TELEGRAM_DELIVERY_SOURCE}, ${key}, ${`telegram_${kind}_canary_sink`},
      ${JSON.stringify(payload)}::jsonb, ${`${key}:canary_sink`}, true, clock_timestamp())`.execute(db);
}

/** ADR-240: a recorded message's stand-in Telegram id: from its key, far above any real chat's message ids. */
export function canarySinkMessageId(key: string): string {
  return String(2 ** 50 + parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16));
}

/** ADR-240: whether a task is one of the canary chat's requests (its intake names that chat). */
export async function isCanaryTask(db: Kysely<Database>, tenantId: string, taskId: string, canaryChatId: string): Promise<boolean> {
  if (!UUID.test(tenantId) || !UUID.test(taskId)) return false;
  const row = (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.outbox_commands
    WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'task.created'
      AND payload->>'sourceChannelId' = ${canaryChatId} LIMIT 1`.execute(db)).rows[0];
  return Boolean(row);
}

/**
 * A design's name as a requester reads it: the office's "Client: " prefix dropped, at most 60 characters.
 * ADR-231: no direction mark at its edges (the caption read "\u200FKAAE K-12 Pilot Study…, final"), and
 * a neutral name ("New design request from Sewa") is no name.
 */
export function requesterDesignTitle(value: unknown): string {
  return requesterTitleName(value);
}

/** The language a delivery speaks to the requester in: given, or the design's name's own script. */
const deliveryLang = (title: unknown, lang?: RequesterLang): RequesterLang => lang ?? requesterLang(String(title ?? ''), 'en');

/**
 * The caption on a delivered file (#32, ADR-145): "<design>, final" in the requester's language, plain
 * text. Without a name, the file's own name.
 */
export function composeDeliveredCaption(title: unknown, filename: string, lang?: RequesterLang): string {
  const name = requesterDesignTitle(title);
  return name ? say(OUTCOME_MESSAGES.deliveredCaption, deliveryLang(title, lang), { title: name }) : filename;
}

/**
 * The delivery message, in Telegram HTML. Every value that came from a person (the title, file
 * names) is escaped: the old message used Markdown asterisks and was sent with no parse mode, so the
 * requester saw the asterisks, and an unescaped title could break parsing.
 *
 * ADR-145 (#31): it is the requester's, so it says "here is your final design" in their language and
 * nothing of the office's. The Drive archive's state and the production log row are the office's
 * facts: Core records them on the publication (archiveProblem, sheetsConfirmed, sheetRowNumber) and
 * the Desk shows them; they are no longer printed here.
 */
export function composeDeliveredMessage(
  payload: Record<string, unknown> & { title?: string | null; files?: unknown } | null | undefined,
  options: { filesSent: number; filesUncertain?: number; lang?: RequesterLang }
): string {
  const lang = deliveryLang(payload?.title, options.lang);
  const name = requesterDesignTitle(payload?.title);
  const title = name ? bold(name) : say(LIFECYCLE_MESSAGES.yourDesign, lang);
  // A file whose upload Telegram did not confirm may or may not be above. The notice said "has been
  // delivered" all the same (2026-09-24); it now says what is known, and the office is alerted.
  const uncertain = options.filesUncertain ?? 0;
  const lines: string[] = [say(uncertain > 0 ? OUTCOME_MESSAGES.deliveredUnconfirmed : OUTCOME_MESSAGES.delivered, lang, { title })];

  const files: DeliveredFile[] = Array.isArray(payload?.files) ? payload.files : [];
  const linked = files.filter((f) => f.webViewLink);
  if (linked.length > 0) {
    lines.push([say(OUTCOME_MESSAGES.deliveredInDrive, lang),
      ...linked.map((f) => `• <a href="${escapeTelegramHtml(f.webViewLink)}">${escapeTelegramHtml(f.filename)}</a>`)].join('\n'));
  } else if (payload?.driveFolderId && !payload?.archiveProblem) {
    // Commands written before the files were named carry only the folder.
    lines.push(`${say(OUTCOME_MESSAGES.deliveredInDrive, lang)} <a href="${escapeTelegramHtml(`https://drive.google.com/drive/folders/${payload.driveFolderId}`)}">${escapeTelegramHtml(say(OUTCOME_MESSAGES.deliveryFolder, lang))}</a>`);
  }
  return lines.join('\n\n');
}

/**
 * The requester's notice when a request could not be started. Plain text, no formatting, and no
 * reference number (ADR-145): the office's alert names the task.
 */
export function composeIntakeFailedMessage(_taskId: string, lang: RequesterLang = 'en'): string {
  return say(OUTCOME_MESSAGES.couldNotStart, lang);
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
 * knows, in plain words and the requester's language (ADR-145: no service names, no reference number;
 * the office's alert names the task). Plain text, no formatting.
 */
export function composeOutcomeUnrecordedMessage(input: { taskId: string; title?: string | null; draftMade: boolean; officeAlerted: boolean;
  lang?: RequesterLang }): string {
  const lang = deliveryLang(input.title, input.lang);
  const title = requesterDesignTitle(input.title) || say(LIFECYCLE_MESSAGES.yourDesign, lang);
  return say(input.draftMade ? OUTCOME_MESSAGES.draftMadeNotSaved : OUTCOME_MESSAGES.couldNotFinish, lang, { title });
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
