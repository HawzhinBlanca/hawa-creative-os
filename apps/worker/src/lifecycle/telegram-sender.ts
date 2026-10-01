/**
 * TelegramSender: one Restate Virtual Object per Telegram chat, which sends that chat's messages one
 * at a time (architecture programme Phase 2, slice 2.2; PHASE2_DESIGN.md section 2.6, ADR-034).
 *
 * Telegram has no idempotency key, so a critical message is fenced by send marks in Postgres, the
 * same records the outbox writes (delivery-notification.ts), under `lc:<message key>`:
 * 1. a message already `sent` is not sent again, and answers with the stored result;
 * 2. one `attempted` or `uncertain` (a send that may have arrived) is not sent again either: it
 *    answers `uncertain`, and the office is alerted, once;
 * 3. otherwise `attempted` is written, then the message is sent, then its outcome is written.
 * The answer is classified into what Restate should do:
 * - sent: `sent`;
 * - 429: `failed`, and a RetryableError asking Restate to try again after Telegram's retry_after;
 * - a definite pre-connection failure: `failed`, and an error Restate retries;
 * - a 5xx: `uncertain`, since the provider may have accepted the message before failing;
 * - Telegram's answer lost or not a valid receipt: `uncertain`, not retried;
 * - any other 4xx (bot blocked, chat not found, file too large): `failed`, answered `refused`;
 * - an answer this table does not know, or an approved file that cannot be read yet: `failed` (or no
 *   mark), asked again a bounded number of times (ADR-155), then answered `refused` and the office
 *   alerted. It used to be asked again for about three hours, and the chat's later messages (its
 *   queue is this object) waited behind it the whole time.
 * A 'failed' mark that cannot be written is never left as 'attempted' for good: the refusal is
 * journaled, a step of its own writes the mark (retried until Postgres takes it), and only then is the
 * message tried again or answered `refused` (finding 22 of the Phase 4 review).
 *
 * The whole attempt is one `ctx.run`, so its answer is journaled: a worker killed after the send and
 * before the journal entry finds `attempted` on its retry and answers `uncertain`, which is the one
 * case the office must check by hand. Courtesy messages skip the marks and accept Telegram's own
 * at-least-once window.
 *
 * The file bytes are read here, by reference (exportRef, or imageRef for the picture of an office draft
 * alert) and checked against their hash, so no file ever travels through Restate's journal. A draft
 * alert whose picture cannot be read or is refused is sent as its words instead (ADR-155 addendum).
 */
import * as restate from '@restatedev/restate-sdk';
import type { OutboundMessage, SendResult } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID, canaryChatIdFromEnv, canaryChatProblem } from '@hawa/contracts';
import { blobStoreFromEnv, withRlsContext, type BlobStore, type Database, type Kysely } from '@hawa/db';
import { TelegramBridge } from '@hawa/integrations';
import { chaosPoint } from '@hawa/observability';
import {
  composeDeliveryUncertainAlert,
  composeMessageUncertainAlert,
  canarySinkMessageId,
  draftImageReader,
  isCanaryTask,
  readSendMark,
  readStoredExportBytes,
  sha256Hex,
  writeSendMark,
  type DraftImageReader,
  type ExportBytesReader,
  type SendMarkOutcome,
  type SendStepKind,
  type TelegramSender as TelegramBridgeLike,
  type TelegramSendResult,
  validTelegramMessageId,
  writeCanarySinkMark,
} from '../delivery-notification.js';
import { log, withInvocationLogContext } from '../logging.js';
import { officeAlertKey, officeChatIdsFromEnv } from './office-chats.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

/** What a TelegramSender needs from the world; tests pass their own. */
export interface TelegramSenderDeps {
  db: Kysely<Database> | undefined;
  /** The bot token; null when none is configured (every send then waits for one). */
  botToken(): string | null;
  bridge(botToken: string): TelegramBridgeLike;
  readExportBytes: ExportBytesReader;
  /** The picture of an office draft alert (ADR-155 addendum); without it such an alert is sent as text. */
  readDraftImage?: DraftImageReader;
  /**
   * Every office member, who hear about a message that may not have arrived or could not be sent
   * (ADR-155; it was the first member only). Read inside a journaled step.
   */
  officeChatIds(): string[];
  /** The waits between attempts at the mark written after Telegram answered (tests shorten them). */
  markRetryDelaysMs?: number[];
  /**
   * ADR-240: the nightly canary's chat, only ever an id no Telegram chat can have
   * (canaryChatIdFromEnv); null or absent records nothing instead of sending.
   */
  canaryChatId?(): string | null;
  /** ADR-240: whether a task is one of the canary chat's requests; isCanaryTask when absent. */
  isCanaryTask?(db: Kysely<Database>, tenantId: string, taskId: string, canaryChatId: string): Promise<boolean>;
}

export function telegramSenderDepsFromEnv(db: Kysely<Database> | undefined): TelegramSenderDeps {
  const canaryProblem = canaryChatProblem(process.env);
  if (canaryProblem) log.error(`[TelegramSender] ${canaryProblem}.`);
  // The file store both colours mount (ADR-035), for a Studio preview kept only there.
  let store: BlobStore | null | undefined;
  const blobStore = () => {
    if (store === undefined) {
      try { store = db && process.env.HAWA_BLOB_DIR ? blobStoreFromEnv(db) : null; } catch { store = null; }
    }
    return store;
  };
  return {
    db,
    botToken: () => process.env.TELEGRAM_BOT_TOKEN || null,
    bridge: (botToken) => new TelegramBridge({ botToken }) as unknown as TelegramBridgeLike,
    readExportBytes: readStoredExportBytes,
    readDraftImage: draftImageReader(readStoredExportBytes, blobStore),
    officeChatIds: () => officeChatIdsFromEnv(),
    canaryChatId: () => canaryChatIdFromEnv(process.env),
  };
}

/** The part of a Restate object context the handler uses; tests pass a plain object. */
export interface SenderContext {
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  /**
   * Restate's durable sleep, used only to wait out a refusal whose failed mark had to be written in a
   * step of its own. Without it (plain test contexts) the next attempt starts at once.
   */
  sleep?(ms: number): Promise<void>;
  /** A one-way send to another chat's TelegramSender, deduplicated by the message's key. */
  sendTo(message: OutboundMessage): void;
  /** A one-way, keyed notice that the critical message has a confirmed Telegram mark. */
  notifySent?(message: OutboundMessage, messageId: string): Promise<void> | void;
}

/** The step every message is fenced under: `lc:<key>:send`. */
export const SEND_STEP = 'send';
export const markIdOf = (key: string) => `lc:${key}`;

const UNCERTAIN = /DELIVERY_UNCERTAIN|RECEIPT_INVALID/;
const SERVER_ERROR = /_5\d\d$/;
const RATE_LIMITED = /_429$/;
const REFUSED = /_4\d\d$|^INVALID_(DOCUMENT|PHOTO)_BUFFER$/;

const tenantOf = (m: OutboundMessage) => m.tenantId || m.exportRef?.tenantId || process.env.HAWA_TENANT_ID || DEFAULT_TENANT_ID;
const stepKind = (m: OutboundMessage): SendStepKind => (m.kind === 'document' ? 'document' : 'message');

/**
 * What one attempt journals: a result, or a message Telegram definitely did not take whose 'failed'
 * mark could not be written. `retryAfterMs` is the wait before the next attempt, or null when the
 * refusal is final (a 4xx: answered `refused` once the mark is written). `stuck` (ADR-155): not sent,
 * nothing left 'attempted', and asking again may not help (a refusal this sender does not know, an
 * approved file that cannot be read); asked again a bounded number of times, then answered `refused`.
 */
export type AttemptAnswer = SendResult
  | { outcome: 'not_sent'; error: string; retryAfterMs: number | null }
  | { outcome: 'stuck'; error: string; retryAfterMs: number };

/** Telegram's limit for a photo; a larger draft picture goes as a file (up to 50 MB), which shows it too. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * An office draft alert as the plain message it also carries (ADR-155 addendum): what is sent when its
 * picture cannot be read, has changed, or is refused, so the office is never left without the alert.
 */
export function photoAsText(m: OutboundMessage): OutboundMessage {
  const { imageRef: _image, caption, ...rest } = m;
  return { ...rest, kind: 'text', text: m.text || caption || '' };
}

/** The wait before another attempt after a pre-connection failure or an unknown refusal. */
const NOT_SENT_RETRY_MS = 5000;
/**
 * How often a stuck message is tried (ADR-155), its waits doubling from 5 s to at most 5 minutes:
 * about ten minutes in all, and then the chat's later messages go ahead of it.
 */
export const STUCK_ATTEMPTS = 8;
const STUCK_MAX_WAIT_MS = 5 * 60_000;

/**
 * ADR-240: whether a message goes to the canary's sink instead of Telegram: one for the canary chat,
 * or one about a task of the canary chat's requests (an office alert, whoever it is for). Nothing is
 * ever sunk without a configured canary chat, and that chat can only be an id no person's chat can have
 * (packages/contracts/src/canary.ts), so no message to a real chat about a real request is held back.
 */
export async function canarySinkFor(deps: TelegramSenderDeps, m: OutboundMessage): Promise<'canary_chat' | 'canary_request' | null> {
  const canary = deps.canaryChatId?.() ?? null;
  if (!canary) return null;
  if (String(m.chatId) === canary) return 'canary_chat';
  const tenantId = tenantOf(m);
  if (!m.taskId || !UUID.test(m.taskId) || !deps.db) return null;
  const check = deps.isCanaryTask ?? isCanaryTask;
  // Read before anything is sent; a database that cannot answer fails the attempt, and Restate asks again.
  const canaryTask = await withRlsContext(deps.db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
    (trx) => check(trx, tenantId, m.taskId!, canary));
  return canaryTask ? 'canary_request' : null;
}

/**
 * ADR-240: records the message instead of sending it. Telegram is never called, and the answer
 * `canary_sink` is journaled by the handler's step, where the canary reads it with the message itself.
 */
async function sinkAttempt(deps: TelegramSenderDeps, m: OutboundMessage, reason: 'canary_chat' | 'canary_request'): Promise<AttemptAnswer> {
  const messageId = canarySinkMessageId(m.key);
  const tenantId = tenantOf(m);
  if (deps.db) {
    await withRlsContext(deps.db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      writeCanarySinkMark(trx, tenantId, markIdOf(m.key), SEND_STEP, stepKind(m), { messageId, chatId: String(m.chatId), reason,
        kind: m.kind, ...(m.text !== undefined ? { text: m.text } : {}), ...(m.caption !== undefined ? { caption: m.caption } : {}),
        ...(m.filename !== undefined ? { filename: m.filename } : {}), ...(m.canaryFor ? { canaryFor: m.canaryFor } : {}) }));
  }
  log.info(`[TelegramSender] ${m.key} recorded for the canary (${reason}), not sent.`);
  return { outcome: 'canary_sink', messageId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One attempt at one message: the body of the handler's `ctx.run('send')`. It answers, or throws an
 * error Restate retries (a RetryableError carrying Telegram's retry_after on a 429).
 */
export async function sendAttempt(deps: TelegramSenderDeps, message: OutboundMessage): Promise<AttemptAnswer> {
  // ADR-240: the canary's messages are recorded, never sent, before any mark or Telegram call.
  const sink = await canarySinkFor(deps, message);
  if (sink) return sinkAttempt(deps, message, sink);
  let m = message;
  const critical = m.class === 'critical';
  const tenantId = tenantOf(m);
  const markId = markIdOf(m.key);
  const inTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> => {
    if (!deps.db) throw new Error('DATABASE_NOT_CONFIGURED: a critical Telegram message is fenced by send marks in Postgres');
    return withRlsContext(deps.db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
  };
  const mark = (outcome: SendMarkOutcome, messageId?: string) =>
    inTenant((trx) => writeSendMark(trx, tenantId, markId, SEND_STEP, stepKind(m), outcome, messageId, String(m.chatId)));

  if (critical) {
    const prior = await inTenant((trx) => readSendMark(trx, tenantId, markId, SEND_STEP));
    if (prior?.outcome === 'sent') return { outcome: 'sent', ...(prior.messageId ? { messageId: prior.messageId } : {}) };
    // It may have arrived: never sent twice, whatever else happens. Only an administrator's release
    // (after looking in the chat) frees it.
    if (prior?.outcome === 'attempted' || prior?.outcome === 'uncertain') return { outcome: 'uncertain', error: `PREVIOUS_ATTEMPT_UNCONFIRMED: an earlier attempt at ${m.key} may have reached the chat` };
  }

  const botToken = deps.botToken();
  if (!botToken) throw new Error('TELEGRAM_NOT_CONFIGURED: TELEGRAM_BOT_TOKEN is not set; the message waits for it');

  // The bytes first, checked against their approved hash: a missing or changed file is never sent.
  let bytes: Uint8Array | null = null;
  if (m.kind === 'document') {
    const ref = m.exportRef;
    if (!ref) return { outcome: 'refused', error: 'DOCUMENT_WITHOUT_EXPORT: a document names the stored export it sends' };
    if (!deps.db) throw new Error('DATABASE_NOT_CONFIGURED: the approved file is read from Postgres');
    bytes = await withRlsContext(deps.db, { tenantId: ref.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      deps.readExportBytes(trx, ref.tenantId, ref.taskId, ref.artifactId));
    // Not readable yet (a database that is catching up): asked again, a bounded number of times (ADR-155).
    if (!bytes) {
      return { outcome: 'stuck', error: `DELIVERED_FILE_UNREADABLE: the approved export ${ref.artifactId} of task ${ref.taskId} could not be read`,
        retryAfterMs: NOT_SENT_RETRY_MS };
    }
    if (sha256Hex(bytes) !== ref.sha256) {
      return { outcome: 'refused', error: `DELIVERED_FILE_CHANGED: the stored export ${ref.artifactId} no longer matches its approved hash` };
    }
  } else if (m.kind === 'photo') {
    // ADR-155 addendum: the draft's picture, read by reference and checked against its hash like an
    // approved file. One that cannot be read, or has changed, sends the alert's words instead.
    const ref = m.imageRef;
    const read = ref && deps.db && deps.readDraftImage && (await withRlsContext(deps.db,
      { tenantId: ref.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => deps.readDraftImage!(trx, ref)));
    if (read && sha256Hex(read) === ref!.sha256) bytes = read;
    else {
      log.warn(`[TelegramSender] The draft picture for ${m.key} ${read ? 'no longer matches its hash' : 'could not be read'}; its alert is sent as text.`);
      m = photoAsText(m);
    }
  }

  // Written (and committed) before the send: if this process dies after it, a retry finds it.
  if (critical) await mark('attempted');
  const bridge = deps.bridge(botToken);
  if (m.kind === 'photo' && !bridge.dispatchOutboundPhoto) m = photoAsText(m);
  let res: TelegramSendResult;
  try {
    res = m.kind === 'document'
      ? await bridge.dispatchOutboundDocument(m.chatId, bytes!, m.filename || 'file', {
          mimeType: m.mimeType,
          caption: m.caption,
          ...(m.parseMode ? { parseMode: m.parseMode } : {}),
        })
      : m.kind === 'photo'
        ? bytes!.length > PHOTO_MAX_BYTES
          ? await bridge.dispatchOutboundDocument(m.chatId, bytes!, 'draft.png', { mimeType: 'image/png', caption: m.caption || m.text })
          : await bridge.dispatchOutboundPhoto!(m.chatId, Buffer.from(bytes!), m.caption || m.text)
        : await bridge.dispatchOutboundMessage(m.chatId, { text: m.text || '', ...(m.parseMode ? { parse_mode: m.parseMode } : {}) });
  } catch (err) {
    // The bridge answers with a result; a throw is unexpected, and whether anything left is unknown.
    res = { success: false, error: `TELEGRAM_DELIVERY_UNCERTAIN: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The chaos suite kills the worker here: sent, and only 'attempted' on record.
  await chaosPoint('worker.sender.after-telegram', { key: m.key, kind: m.kind, chat: m.chatId, commandType: 'lifecycle' });

  // A mark that cannot be written after the answer is not a reason to send again: the answer itself is
  // journaled by Restate once this returns. It is asked for a little while (a Postgres restart takes
  // seconds), because a message left at 'attempted' answers uncertain to anyone who asks for it later
  // (a Delivery run that retries the archive), which would alert the office about a file that arrived.
  const record = async (outcome: SendMarkOutcome, messageId?: string): Promise<boolean> => {
    if (!critical) return true;
    const delays = deps.markRetryDelaysMs ?? [500, 1000, 2000, 4000, 8000];
    for (let attempt = 0; ; attempt++) {
      try {
        await mark(outcome, messageId);
        return true;
      } catch (err) {
        if (attempt >= delays.length) {
          log.warn(`[TelegramSender] Could not record ${m.key} as ${outcome}; ${outcome === 'failed'
            ? 'the refusal is journaled and a step of its own writes the mark before any retry'
            : "it stays 'attempted' on record"}:`, err instanceof Error ? err.message : err);
          return false;
        }
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  };
  if (res.success && validTelegramMessageId(res.messageId)) {
    if (!await record('sent', res.messageId)) {
      return { outcome: 'uncertain', error: 'SEND_MARK_UNCONFIRMED' };
    }
    return { outcome: 'sent', messageId: res.messageId };
  }
  const error = res.success ? 'TELEGRAM_RECEIPT_INVALID' : res.error || 'TELEGRAM_SEND_FAILED';
  if (UNCERTAIN.test(error) || SERVER_ERROR.test(error)) {
    await record('uncertain');
    return { outcome: 'uncertain', error };
  }
  // From here on Telegram definitely did not take the message. Asking again is safe only once the
  // mark says 'failed': a retry that finds 'attempted' answers uncertain and never sends. When the mark
  // cannot be written, the refusal is journaled instead (not_sent), and the handler writes the mark in
  // a step of its own, retried until Postgres takes it, before anything else is decided (finding 22).
  const rateLimited = RATE_LIMITED.test(error) || res.retryAfterSeconds !== undefined;
  const retryAfterMs = rateLimited ? Math.max(1, res.retryAfterSeconds ?? 5) * 1000 : null;
  const failedRecorded = await record('failed');
  if (rateLimited) {
    if (!failedRecorded) return { outcome: 'not_sent', error, retryAfterMs: retryAfterMs! };
    throw new restate.RetryableError(`TELEGRAM_RATE_LIMITED: Telegram asked to wait ${retryAfterMs! / 1000} s (${error})`, { retryAfter: retryAfterMs! });
  }
  if (/NETWORK_ERROR|NOT_CONFIGURED/.test(error)) {
    if (!failedRecorded) return { outcome: 'not_sent', error, retryAfterMs: NOT_SENT_RETRY_MS };
    throw new Error(`${error}: Telegram did not take ${m.key}; asked again`);
  }
  // A draft picture Telegram would not take (too large, odd dimensions, an answer this table does not
  // know): the alert's words go instead, under the same key, now that its mark says 'failed'. Without
  // that mark the photo is asked again once the mark is written, and then falls back here.
  if (m.kind === 'photo') {
    if (failedRecorded) {
      log.warn(`[TelegramSender] Telegram refused the draft picture of ${m.key} (${error}); its alert is sent as text.`);
      return sendAttempt(deps, photoAsText(m));
    }
    return { outcome: 'not_sent', error, retryAfterMs: NOT_SENT_RETRY_MS };
  }
  if (REFUSED.test(error)) {
    return failedRecorded ? { outcome: 'refused', error } : { outcome: 'not_sent', error, retryAfterMs: null };
  }
  // An answer this table does not know: it did not arrive (Telegram said no), so asking again is safe,
  // a bounded number of times (ADR-155).
  if (!failedRecorded) return { outcome: 'not_sent', error, retryAfterMs: NOT_SENT_RETRY_MS };
  return { outcome: 'stuck', error: `${error}: Telegram refused ${m.key} for a reason this sender does not know`, retryAfterMs: NOT_SENT_RETRY_MS };
}

/**
 * The step that corrects the mark of a definite refusal whose 'failed' mark the attempt could not
 * write. It throws (and Restate retries it) until Postgres takes the write. It changes only a mark this
 * attempt left 'attempted'; any other latest mark is left as it is and decides the next attempt.
 */
export async function recordDefiniteRefusal(deps: TelegramSenderDeps, m: OutboundMessage): Promise<{ mark: SendMarkOutcome | 'none' }> {
  if (!deps.db) throw new Error('DATABASE_NOT_CONFIGURED: a critical Telegram message is fenced by send marks in Postgres');
  const tenantId = tenantOf(m);
  const markId = markIdOf(m.key);
  try {
    return await withRlsContext(deps.db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const prior = await readSendMark(trx, tenantId, markId, SEND_STEP);
      if (prior?.outcome !== 'attempted') return { mark: prior?.outcome ?? 'none' };
      await writeSendMark(trx, tenantId, markId, SEND_STEP, stepKind(m), 'failed');
      return { mark: 'failed' as const };
    });
  } catch (err) {
    throw new Error(`SEND_MARK_UNRECORDED: Telegram did not take ${m.key}, and its failed mark could not be written yet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** An office alert itself: one that goes wrong is logged, never alerted again (no chain of alerts). */
const OFFICE_ALERT_KEY = /^notify\.office:|:(office|failed|uncertain|stuck)-alert(:|$)/;

/** The office's alert for a critical message that could not be sent after its bounded attempts (ADR-155). */
export function stuckAlertFor(m: OutboundMessage, error: string, officeChatId: string, index = 0): OutboundMessage {
  const what = m.kind === 'document' ? `the approved file ${m.filename || ''}`.trim() : /:notice$/.test(m.key) ? 'the delivery notice' : 'a message';
  return {
    v: 1,
    key: officeAlertKey(`${m.key}:stuck-alert`, index, officeChatId),
    chatId: officeChatId,
    kind: 'text',
    text: `Hawa could not send ${what} to chat ${m.chatId} (task ${m.taskId || 'unknown'}) after ${STUCK_ATTEMPTS} attempts, ` +
      `and stopped trying so that chat's later messages are not held up: ${Array.from(error).slice(0, 300).join('')}\n` +
      'Please check the chat and send it by hand.',
    class: 'critical',
    tenantId: tenantOf(m),
    ...(m.taskId ? { taskId: m.taskId } : {}),
  };
}

/** The office's alert for a critical message that may not have arrived. */
export function uncertainAlertFor(m: OutboundMessage, error: string, officeChatId: string, index = 0): OutboundMessage {
  const taskId = m.taskId || 'unknown';
  const what = m.kind === 'document' ? `the approved file ${m.filename || ''}`.trim() : /:notice$/.test(m.key) ? 'the delivery notice' : 'a message';
  const text = m.kind === 'document' || /:notice$/.test(m.key)
    ? composeDeliveryUncertainAlert(taskId, m.chatId, `${what}: ${error}`)
    : composeMessageUncertainAlert(taskId, m.chatId, error);
  return {
    v: 1,
    key: officeAlertKey(`${m.key}:uncertain-alert`, index, officeChatId),
    chatId: officeChatId,
    kind: 'text',
    text,
    class: 'critical',
    tenantId: tenantOf(m),
    ...(m.taskId ? { taskId: m.taskId } : {}),
  };
}

/** The handler: one attempt journaled as a step, then the office alert when it may not have arrived. */
export async function handleSend(ctx: SenderContext, deps: TelegramSenderDeps, m: OutboundMessage): Promise<SendResult> {
  if (!m || typeof m.key !== 'string' || !m.key || !m.chatId) {
    throw new restate.TerminalError('INVALID_MESSAGE: a message names its key and chat', { errorCode: 400 });
  }
  const onSent = m.onSent;
  if (onSent && (onSent.kind !== 'question' || m.class !== 'critical' || m.kind !== 'text' ||
      m.taskId !== onSent.taskId || !Number.isInteger(onSent.requestRev) || onSent.requestRev < 2 ||
      ![onSent.requestId, onSent.taskId, onSent.questionId].every((id) =>
        typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      m.key !== `${onSent.requestId}:${onSent.requestRev}:design-outcome`)) {
    throw new restate.TerminalError('INVALID_MESSAGE: question send callback identity does not match the notice', { errorCode: 400 });
  }
  if (onSent && !ctx.notifySent) throw new Error('QUESTION_CALLBACK_UNAVAILABLE: the sender cannot confirm this question');
  let result: SendResult;
  let stuck = 0;
  let gaveUp = false;
  for (let round = 0; ; round++) {
    const step = round === 0 ? 'send' : `send-${round}`;
    const answer = await ctx.run(step, () => sendAttempt(deps, m));
    if (answer.outcome === 'stuck') {
      // ADR-155: bounded, so a message that cannot be sent never holds the chat's queue for hours.
      if (++stuck >= STUCK_ATTEMPTS) {
        result = { outcome: 'refused', error: `${answer.error} (not sent after ${stuck} attempts)` };
        gaveUp = true;
        break;
      }
      await ctx.sleep?.(Math.min(answer.retryAfterMs * 2 ** (stuck - 1), STUCK_MAX_WAIT_MS));
      continue;
    }
    if (answer.outcome !== 'not_sent') {
      result = answer;
      break;
    }
    // Telegram said no and the attempt could not write 'failed'. The refusal is in the journal now, so
    // a crash from here on replays it; the mark is corrected before another attempt reads it.
    await ctx.run(`${step}-failed-mark`, () => recordDefiniteRefusal(deps, m));
    if (answer.retryAfterMs === null) {
      result = { outcome: 'refused', error: answer.error };
      break;
    }
    await ctx.sleep?.(answer.retryAfterMs);
  }
  // ADR-240: a question recorded for the canary was never sent, so it is not confirmed (Core would
  // refuse a confirmation without a sent mark); the canary withdraws its requests itself.
  if (onSent && result.outcome === 'canary_sink') log.info(`[TelegramSender] ${m.key} was recorded for the canary; its question is not confirmed.`);
  if (onSent && result.outcome === 'sent') {
    if (!result.messageId) throw new Error('QUESTION_SEND_RECEIPT_MISSING: a confirmed question needs a Telegram message ID');
    await ctx.notifySent!(m, result.messageId);
  }
  if (m.class === 'critical' && (result.outcome === 'uncertain' || gaveUp)) {
    // Every office member but the chat the message was for (ADR-155), read in a journaled step so a
    // replay alerts the same people; keyed by the message, so each hears of it once however often it
    // is asked for. An office alert that went wrong is logged, never alerted in turn.
    const error = 'error' in result ? result.error : '';
    const members = OFFICE_ALERT_KEY.test(m.key) ? [] : await ctx.run('office-chats', async () => deps.officeChatIds());
    const office = members.filter((chatId) => chatId !== String(m.chatId));
    for (const [index, chatId] of office.entries()) {
      ctx.sendTo(gaveUp ? stuckAlertFor(m, error, chatId, index) : uncertainAlertFor(m, error, chatId, index));
    }
    if (!office.length) {
      log.error(`[TelegramSender] ${m.key} ${gaveUp ? 'could not be sent to' : 'may not have reached'} chat ${m.chatId} (${error}); the office was not alerted: ${
        OFFICE_ALERT_KEY.test(m.key) ? 'it was an office alert itself' : members.length ? 'the message was to the only office chat' : 'no office chat is configured'}.`);
    }
  }
  if (result.outcome === 'refused') log.warn(`[TelegramSender] Telegram refused ${m.key} for chat ${m.chatId}: ${result.error}`);
  return result;
}

export type TelegramSenderHandlers = {
  send: (ctx: restate.ObjectContext, m: OutboundMessage) => Promise<SendResult>;
};
/** How other services name it (objectClient / objectSendClient). */
export const TelegramSenderApi: restate.VirtualObjectDefinition<'TelegramSender', TelegramSenderHandlers> = { name: 'TelegramSender' };

export function createTelegramSender(deps: TelegramSenderDeps) {
  return restate.object({
    name: 'TelegramSender',
    handlers: {
      send: async (ctx: restate.ObjectContext, m: OutboundMessage): Promise<SendResult> =>
        withInvocationLogContext(ctx, { taskId: m?.taskId, tenantId: m?.tenantId }, () =>
          handleSend({
            run: (name, action) => ctx.run(name, action),
            sleep: (ms) => ctx.sleep(ms),
            sendTo: (message) => {
              ctx.objectSendClient(TelegramSenderApi, message.chatId).send(message, restate.rpc.sendOpts({ idempotencyKey: message.key }));
            },
            notifySent: async (message, messageId) => {
              const { RequestLifecycleApi } = await import('./request-lifecycle.js');
              const sent = message.onSent!;
              ctx.objectSendClient(RequestLifecycleApi, sent.requestId).questionSent({
                v: 1, requestId: sent.requestId, expectedRev: sent.requestRev,
                taskId: sent.taskId, questionId: sent.questionId,
                messageKey: message.key, messageId,
              }, restate.rpc.sendOpts({ idempotencyKey: `lifecycle:question-sent:${message.key}` }));
            },
          }, deps, m)),
    },
    options: {
      // Core sends office alerts through ingress in slice 2.5; the Delivery workflow calls it inside Restate.
      ingressPrivate: true,
      idempotencyRetention: { days: 7 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60000, maxAttempts: 200, onMaxAttempts: 'pause' },
    },
  });
}
