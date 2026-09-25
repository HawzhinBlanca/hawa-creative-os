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
 * - any other 4xx (bot blocked, chat not found, file too large): `failed`, answered `refused`.
 *
 * The whole attempt is one `ctx.run`, so its answer is journaled: a worker killed after the send and
 * before the journal entry finds `attempted` on its retry and answers `uncertain`, which is the one
 * case the office must check by hand. Courtesy messages skip the marks and accept Telegram's own
 * at-least-once window.
 *
 * The file bytes are read here, by reference (exportRef) and checked against their hash, so no file
 * ever travels through Restate's journal.
 */
import * as restate from '@restatedev/restate-sdk';
import type { OutboundMessage, SendResult } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { withRlsContext, type Database, type Kysely } from '@hawa/db';
import { TelegramBridge } from '@hawa/integrations';
import { chaosPoint } from '@hawa/observability';
import {
  composeDeliveryUncertainAlert,
  composeMessageUncertainAlert,
  readSendMark,
  readStoredExportBytes,
  sha256Hex,
  writeSendMark,
  type ExportBytesReader,
  type SendMarkOutcome,
  type SendStepKind,
  type TelegramSender as TelegramBridgeLike,
  type TelegramSendResult,
  validTelegramMessageId,
} from '../delivery-notification.js';
import { log, withInvocationLogContext } from '../logging.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

/** What a TelegramSender needs from the world; tests pass their own. */
export interface TelegramSenderDeps {
  db: Kysely<Database> | undefined;
  /** The bot token; null when none is configured (every send then waits for one). */
  botToken(): string | null;
  bridge(botToken: string): TelegramBridgeLike;
  readExportBytes: ExportBytesReader;
  /** The office chat that hears about a message that may not have arrived. */
  officeChatId(): string | null;
  /** The waits between attempts at the mark written after Telegram answered (tests shorten them). */
  markRetryDelaysMs?: number[];
}

export function telegramSenderDepsFromEnv(db: Kysely<Database> | undefined): TelegramSenderDeps {
  return {
    db,
    botToken: () => process.env.TELEGRAM_BOT_TOKEN || null,
    bridge: (botToken) => new TelegramBridge({ botToken }) as unknown as TelegramBridgeLike,
    readExportBytes: readStoredExportBytes,
    officeChatId: () => (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).find(Boolean) || null,
  };
}

/** The part of a Restate object context the handler uses; tests pass a plain object. */
export interface SenderContext {
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** A one-way send to another chat's TelegramSender, deduplicated by the message's key. */
  sendTo(message: OutboundMessage): void;
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
 * One attempt at one message: the body of the handler's `ctx.run('send')`. It answers, or throws an
 * error Restate retries (a RetryableError carrying Telegram's retry_after on a 429).
 */
export async function sendAttempt(deps: TelegramSenderDeps, m: OutboundMessage): Promise<SendResult> {
  const critical = m.class === 'critical';
  const tenantId = tenantOf(m);
  const markId = markIdOf(m.key);
  const inTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> => {
    if (!deps.db) throw new Error('DATABASE_NOT_CONFIGURED: a critical Telegram message is fenced by send marks in Postgres');
    return withRlsContext(deps.db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
  };
  const mark = (outcome: SendMarkOutcome, messageId?: string) =>
    inTenant((trx) => writeSendMark(trx, tenantId, markId, SEND_STEP, stepKind(m), outcome, messageId));

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
    // Not readable yet (a database that is catching up): asked again.
    if (!bytes) throw new Error(`DELIVERED_FILE_UNREADABLE: the approved export ${ref.artifactId} of task ${ref.taskId} could not be read`);
    if (sha256Hex(bytes) !== ref.sha256) {
      return { outcome: 'refused', error: `DELIVERED_FILE_CHANGED: the stored export ${ref.artifactId} no longer matches its approved hash` };
    }
  }

  // Written (and committed) before the send: if this process dies after it, a retry finds it.
  if (critical) await mark('attempted');
  const bridge = deps.bridge(botToken);
  let res: TelegramSendResult;
  try {
    res = m.kind === 'document'
      ? await bridge.dispatchOutboundDocument(m.chatId, bytes!, m.filename || 'file', {
          mimeType: m.mimeType,
          caption: m.caption,
          ...(m.parseMode ? { parseMode: m.parseMode } : {}),
        })
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
          log.warn(`[TelegramSender] Could not record ${m.key} as ${outcome}; it stays 'attempted' on record:`, err instanceof Error ? err.message : err);
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
  if (RATE_LIMITED.test(error) || res.retryAfterSeconds !== undefined) {
    await record('failed');
    const seconds = res.retryAfterSeconds ?? 5;
    throw new restate.RetryableError(`TELEGRAM_RATE_LIMITED: Telegram asked to wait ${seconds} s (${error})`, { retryAfter: Math.max(1, seconds) * 1000 });
  }
  if (/NETWORK_ERROR|NOT_CONFIGURED/.test(error)) {
    await record('failed');
    throw new Error(`${error}: Telegram did not take ${m.key}; asked again`);
  }
  await record('failed');
  if (REFUSED.test(error)) return { outcome: 'refused', error };
  // An answer this table does not know: it did not arrive (Telegram said no), so asking again is safe.
  throw new Error(`${error}: Telegram refused ${m.key} for a reason this sender does not know; asked again`);
}

/** The office's alert for a critical message that may not have arrived. */
export function uncertainAlertFor(m: OutboundMessage, error: string, officeChatId: string): OutboundMessage {
  const taskId = m.taskId || 'unknown';
  const what = m.kind === 'document' ? `the approved file ${m.filename || ''}`.trim() : /:notice$/.test(m.key) ? 'the delivery notice' : 'a message';
  const text = m.kind === 'document' || /:notice$/.test(m.key)
    ? composeDeliveryUncertainAlert(taskId, m.chatId, `${what}: ${error}`)
    : composeMessageUncertainAlert(taskId, m.chatId, error);
  return {
    v: 1,
    key: `${m.key}:uncertain-alert`,
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
  const result = await ctx.run('send', () => sendAttempt(deps, m));
  if (m.class === 'critical' && result.outcome === 'uncertain') {
    const office = deps.officeChatId();
    if (office && office !== String(m.chatId)) {
      // Keyed by the message: the alert is sent once however often this message is asked for.
      ctx.sendTo(uncertainAlertFor(m, result.error, office));
    } else {
      log.error(`[TelegramSender] ${m.key} may not have reached chat ${m.chatId} (${result.error}); the office was not alerted: ${office ? 'the message was to the office chat' : 'no office chat is configured'}.`);
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
            sendTo: (message) => {
              ctx.objectSendClient(TelegramSenderApi, message.chatId).send(message, restate.rpc.sendOpts({ idempotencyKey: message.key }));
            },
          }, deps, m)),
    },
    options: {
      // Core sends office alerts through ingress in slice 2.5; the Delivery workflow calls it inside Restate.
      ingressPrivate: false,
      idempotencyRetention: { days: 7 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60000, maxAttempts: 200, onMaxAttempts: 'pause' },
    },
  });
}
