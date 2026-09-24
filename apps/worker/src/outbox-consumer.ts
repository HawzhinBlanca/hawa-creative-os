import {
  OutboxRepository,
  withRlsContext,
  sql,
  type Database,
  type Kysely,
  type OutboxClaim,
  type OutboxClaimFailure,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_SECONDS,
} from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { OfficeTracer, chaosPoint } from '@hawa/observability';
import { TelegramBridge } from '@hawa/integrations';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
import { log, outboxLogContext, requestIdHeaders, runWithLogContext } from './logging.js';
import {
  composeDeliveredMessage,
  composeDeliveryFailedAlert,
  composeDeliveryUncertainAlert,
  composeIntakeFailedAlert,
  composeIntakeFailedMessage,
  composeMessageUncertainAlert,
  intakeChatOf,
  priorSendOf,
  readSendMarks,
  readStoredExportBytes,
  sha256Hex,
  writeSendMark,
  type DeliveredFile,
  type ExportBytesReader,
  type PriorSend,
  type SendMarkOutcome,
  type SendStepKind,
  type TelegramSender,
  type TelegramSendResult,
} from './delivery-notification.js';

export interface OutboxCommandRecord {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  command_type: string;
  idempotency_key: string;
  payload: any;
  state: 'pending' | 'leased' | 'delivered' | 'failed';
  attempts: number;
  last_error?: string | null;
  available_at?: Date | string | null;
  created_at?: Date | string;
  /** Set on a claimed command: identifies this consumer's claim (see OutboxClaim in @hawa/db). */
  claim_token?: string;
  /** Set on a claimed command: an earlier consumer's lease ran out while it held the command. */
  reclaimed?: boolean;
}

export type DeliveryErrorCategory = 'retryable' | 'permanent' | 'uncertain';

/**
 * Telegram's own refusal of a send (a chat that does not exist, a bot the requester blocked, a file
 * over the size limit) comes back as TELEGRAM_REJECTED_4xx or TELEGRAM_DOCUMENT_REJECTED_4xx. Retrying
 * cannot change that answer, but the permanent pattern did not know these codes, so a delivery to a
 * bad chat was retried to its last attempt with nobody told (2026-09-23). 429 is Telegram asking to
 * slow down, and stays retryable.
 */
const TELEGRAM_REFUSED = /TELEGRAM_(?:DOCUMENT_)?REJECTED_4(?!29)\d\d/;

export class OutboxDeliveryError extends Error {
  constructor(
    message: string,
    public readonly category: DeliveryErrorCategory = 'retryable',
    public readonly code?: string,
    public readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OutboxDeliveryError';
  }
}

/**
 * Thrown before a side effect when this consumer no longer holds the command's claim: another
 * consumer took the command over (its lease ran out while this one was still acting) or an operator
 * redrove it. The handler stops there; whoever holds the command now decides.
 */
export class OutboxClaimLostError extends Error {
  constructor(commandId: string) {
    super(`CLAIM_LOST: command ${commandId} is no longer this consumer's; nothing more was sent`);
    this.name = 'OutboxClaimLostError';
  }
}

/** Database access for a handler, which acts while no transaction is open. */
export interface OutboxHandlerScope {
  /**
   * Runs `fn` in its own short transaction under the command's tenant, committed before this returns.
   * Only database work belongs inside it: a network call there holds the transaction open, and the
   * pool kills a session left idle in a transaction for 30 s.
   */
  inTenant<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T>;
  /**
   * Like `inTenant`, but first checks that this consumer still holds the command's claim, and moves
   * its lease on; throws OutboxClaimLostError otherwise. Write the record of a side effect here, and
   * make the side effect only after it returns. Only given while a claim is held.
   */
  whileHeld?<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T>;
}

/**
 * Acts on one claimed command. `db` is the consumer's pool, never a transaction (queries on it run
 * without the tenant's row-level security context: use `scope.inTenant` for the tenant's rows). A
 * handler can run again after a consumer stopped mid-command, so it checks what an earlier run already
 * did before any side effect (the Telegram sends below, Restate's workflow key, Core's own key).
 */
export type OutboxCommandHandler = (
  cmd: OutboxCommandRecord,
  db: Kysely<Database>,
  scope: OutboxHandlerScope
) => Promise<void>;

/** A Telegram answer that may follow a send that arrived: the send is never repeated automatically. */
const UNCERTAIN_SEND = /DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID/;

export interface OutboxConsumerOptions {
  tenantId?: string;
  tenantIds?: string[];
  userId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  pollIntervalMs?: number;
  dispatcher?: TaskWorkflowDispatcher;
  handlers?: Record<string, OutboxCommandHandler>;
  /** Telegram bot token for outbound notices. Undefined reads TELEGRAM_BOT_TOKEN; null means none. */
  telegramBotToken?: string | null;
  /** Builds the Telegram sender for a token. Defaults to the Telegram bridge. */
  telegramSender?: (botToken: string) => TelegramSender;
  /** Reads a delivered export's stored bytes. Defaults to hawa.canva_export_bytes. */
  readExportBytes?: ExportBytesReader;
  /** The office chat alerted about dead-lettered requests. Undefined reads the first TELEGRAM_ALLOWED_USERS entry. */
  officeAlertChatId?: string | null;
  /** Transport to Core for `task.outcome`. Defaults to fetch. */
  coreFetcher?: typeof fetch;
}

export interface BatchProcessingSummary {
  leased: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  /** Commands whose claim another consumer (or an operator's redrive) took before the result was recorded. */
  lostClaims: number;
  errors: Array<{ id: string; commandType: string; error: string }>;
}

export class OutboxConsumer {
  private readonly outboxRepo: OutboxRepository;
  private readonly tracer = new OfficeTracer();
  private readonly handlers = new Map<string, OutboxCommandHandler>();
  private readonly dispatcher: TaskWorkflowDispatcher;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: OutboxConsumerOptions = {}
  ) {
    this.outboxRepo = new OutboxRepository(db);
    this.dispatcher = options.dispatcher || new TaskWorkflowDispatcher({ db });

    // Register custom handlers if provided
    if (options.handlers) {
      for (const [type, handler] of Object.entries(options.handlers)) {
        this.registerHandler(type, handler);
      }
    }

    // Register standard default handlers
    this.registerDefaultHandlers();
  }

  registerHandler(commandType: string, handler: OutboxCommandHandler) {
    this.handlers.set(commandType, handler);
  }

  private telegramBotToken(): string | null {
    if (this.options.telegramBotToken !== undefined) return this.options.telegramBotToken || null;
    return process.env.TELEGRAM_BOT_TOKEN || null;
  }

  private telegramSender(botToken: string): TelegramSender {
    if (this.options.telegramSender) return this.options.telegramSender(botToken);
    return new TelegramBridge({ botToken }) as unknown as TelegramSender;
  }

  private officeAlertChatId(): string | null {
    if (this.options.officeAlertChatId !== undefined) return this.options.officeAlertChatId || null;
    return (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).find(Boolean) || null;
  }

  /**
   * A request that could not be started is dead-lettered after its last attempt. The requester used
   * to hear nothing at all; now the chat it came from is told in plain English, and the office chat is
   * alerted. Neither message can change the command's outcome.
   */
  private async tellRequesterIntakeFailed(cmd: OutboxCommandRecord, attempts: number, error: string) {
    try {
      const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
      const chatId = intakeChatOf(payload);
      const botToken = this.telegramBotToken();
      if (!chatId || !botToken) {
        log.error(
          `[OutboxConsumer] Request ${cmd.aggregate_id} was dead-lettered and its requester could not be told (${!chatId ? 'no Telegram chat in the command' : 'TELEGRAM_BOT_TOKEN is not set'}).`
        );
        return;
      }
      const sender = this.telegramSender(botToken);
      const told = await sender.dispatchOutboundMessage(chatId, { text: composeIntakeFailedMessage(cmd.aggregate_id) });
      if (!told.success) {
        log.error(`[OutboxConsumer] Could not tell chat ${chatId} that request ${cmd.aggregate_id} failed: ${told.error}`);
      }
      const office = this.officeAlertChatId();
      if (office && office !== chatId) {
        const alerted = await sender.dispatchOutboundMessage(office, {
          text: composeIntakeFailedAlert(cmd.aggregate_id, chatId, attempts, error),
        });
        if (!alerted.success) log.error(`[OutboxConsumer] Office alert for request ${cmd.aggregate_id} failed: ${alerted.error}`);
      }
    } catch (notifyErr) {
      log.error(`[OutboxConsumer] Could not notify about dead-lettered request ${cmd.aggregate_id}:`, notifyErr);
    }
  }

  /**
   * A delivery of an approved design that ended `failed` (refused for good, or out of attempts) used
   * to leave one log line naming the command: neither the requester nor the office heard (2026-09-23).
   * The office chat is alerted. The requester is not messaged again: the chat that failed may be
   * theirs. With no bot token or office chat, or an office chat that is the requester's own, the
   * failure is logged with the task and the reason instead.
   *
   * A send Telegram did not confirm (`uncertain`) is alerted too. It was skipped, although nobody
   * knows whether the requester has the file and it is never resent (2026-09-24).
   */
  private async alertOfficeDeliveryFailed(cmd: OutboxCommandRecord, attempts: number, error: string, uncertain = false) {
    let taskId = cmd.aggregate_id;
    try {
      const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
      taskId = String(payload?.taskId || cmd.aggregate_id);
      const chat = payload?.chatId || payload?.sourceChannelId;
      const requesterChat = chat ? String(chat) : null;
      const botToken = this.telegramBotToken();
      const office = this.officeAlertChatId();
      if (!botToken || !office || office === requesterChat) {
        const why = !botToken ? 'TELEGRAM_BOT_TOKEN is not set' : !office ? 'no office chat is configured' : "the office chat is the requester's own";
        log.error(`[OutboxConsumer] Delivery of task ${taskId} failed after ${attempts} attempts (${error}); the office was not alerted: ${why}.`);
        return;
      }
      const alerted = await this.telegramSender(botToken).dispatchOutboundMessage(office, {
        text: uncertain ? composeDeliveryUncertainAlert(taskId, requesterChat, error) : composeDeliveryFailedAlert(taskId, requesterChat, attempts, error),
      });
      if (!alerted.success) {
        log.error(`[OutboxConsumer] Delivery of task ${taskId} failed (${error}), and so did the office alert: ${alerted.error}`);
      }
    } catch (alertErr) {
      log.error(`[OutboxConsumer] Delivery of task ${taskId} failed (${error}); the office could not be alerted:`, alertErr);
    }
  }

  /**
   * A message from the outbox (`notify.telegram`) that Telegram did not confirm, or that a worker
   * stopped in the middle of sending, is not sent again; the office is alerted so a person can look.
   * Not for a message to the office chat itself, which would only alert the office about the office.
   */
  private async alertOfficeMessageUncertain(cmd: OutboxCommandRecord, error: string) {
    let taskId = cmd.aggregate_id;
    let chat = '';
    try {
      const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
      taskId = String(payload?.taskId || cmd.aggregate_id);
      chat = payload?.chatId ? String(payload.chatId) : '';
      const botToken = this.telegramBotToken();
      const office = this.officeAlertChatId();
      if (!botToken || !office || office === chat) {
        const why = !botToken ? 'TELEGRAM_BOT_TOKEN is not set' : !office ? 'no office chat is configured' : 'the message was to the office chat';
        log.error(`[OutboxConsumer] A message for task ${taskId} may not have reached chat ${chat || 'unknown'} (${error}); the office was not alerted: ${why}.`);
        return;
      }
      const alerted = await this.telegramSender(botToken).dispatchOutboundMessage(office, { text: composeMessageUncertainAlert(taskId, chat || 'unknown', error) });
      if (!alerted.success) log.error(`[OutboxConsumer] A message for task ${taskId} may not have arrived (${error}), and the office alert failed: ${alerted.error}`);
    } catch (alertErr) {
      log.error(`[OutboxConsumer] A message for task ${taskId} may not have arrived (${error}); the office could not be alerted:`, alertErr);
    }
  }

  /** Who hears about a command that ended without being delivered. None of it changes the outcome. */
  private async reportEnded(cmd: OutboxCommandRecord, attempts: number, error: string, uncertain: boolean) {
    // An uncertain dispatch may have started the workflow, so only a definite failure is announced.
    if (cmd.command_type === 'task.created' && !uncertain) {
      await this.tellRequesterIntakeFailed(cmd, attempts, error);
    }
    if (cmd.command_type === 'notify.published') {
      await this.alertOfficeDeliveryFailed(cmd, attempts, error, uncertain);
    }
    if (cmd.command_type === 'notify.telegram' && uncertain) {
      await this.alertOfficeMessageUncertain(cmd, error);
    }
  }

  /**
   * The worker acts in the database as System Automation (ADR-027), an operator of every tenant, not
   * as a person: it used the Art Director's id, so its rows were attributed to her and it could act
   * only where she held a membership (PHASE2_DESIGN.md 1.2, finding 2).
   */
  private scopeFor(tenantId: string): OutboxHandlerScope {
    const userId = this.options.userId || SYSTEM_AUTOMATION_USER_ID;
    return { inTenant: (fn) => withRlsContext(this.db, { tenantId, userId, role: 'operator' }, fn) };
  }

  /**
   * What earlier attempts of this command did with each Telegram send: 'sent', or 'uncertain' (it
   * may have arrived). An uncertain send stays so until an administrator who checked the chat
   * confirms the replay, which writes it 'released' (OutboxRepository.releaseUncertainSends). It was
   * released whenever the command restarted with no attempts, but a plain requeue of every dead letter
   * does that too, and a file that may have arrived was sent again. A confirmed send is never resent.
   */
  private async priorSends(cmd: OutboxCommandRecord, scope: OutboxHandlerScope): Promise<Map<string, PriorSend>> {
    const marks = await scope.inTenant((trx) => readSendMarks(trx, cmd.tenant_id, cmd.id));
    const prior = new Map<string, PriorSend>();
    for (const [step, { outcome }] of marks) {
      const before = priorSendOf(outcome);
      if (before) prior.set(step, before);
    }
    return prior;
  }

  /**
   * One Telegram send that is never made twice. Telegram has no idempotency key, so the attempt is
   * written down (and committed) before the send and its answer after it. A step an earlier attempt
   * sent is skipped; one it may have sent (Telegram did not confirm it, or the worker stopped between
   * the two records) is not sent again and comes back 'uncertain', for the office to check. A send
   * Telegram refused is recorded as failed and throws, so a later attempt may make it.
   *
   * The 'attempted' record is written only while this consumer still holds the claim (whileHeld): a
   * consumer whose lease another one took over sends nothing more, since the new holder may send it.
   */
  private async sendOnce(
    cmd: OutboxCommandRecord,
    scope: OutboxHandlerScope,
    prior: Map<string, PriorSend>,
    step: string,
    kind: SendStepKind,
    send: () => Promise<TelegramSendResult>
  ): Promise<'sent' | 'skipped' | 'uncertain'> {
    const before = prior.get(step);
    if (before === 'sent') return 'skipped';
    if (before === 'uncertain') return 'uncertain';
    const mark = (outcome: SendMarkOutcome) => scope.inTenant((trx) => writeSendMark(trx, cmd.tenant_id, cmd.id, step, kind, outcome));
    const unrecorded = (outcome: SendMarkOutcome) => (err: unknown) =>
      log.warn(
        `[OutboxConsumer] Could not record the ${kind} ${step} of command ${cmd.id} as ${outcome}; a later attempt will treat it as uncertain and not send it again:`,
        err instanceof Error ? err.message : err
      );
    // If this record fails, nothing has been sent: the command is retried, or, when the claim was
    // lost, left to its new holder.
    if (!scope.whileHeld) throw new Error(`[OutboxConsumer] Command ${cmd.id} has no claim to send under`);
    await scope.whileHeld((trx) => writeSendMark(trx, cmd.tenant_id, cmd.id, step, kind, 'attempted'));
    let res: TelegramSendResult;
    try {
      res = await send();
    } catch (err) {
      // The bridge answers with a result; a throw is unexpected, and whether anything left is unknown.
      res = { success: false, error: `TELEGRAM_DELIVERY_UNCERTAIN: ${err instanceof Error ? err.message : String(err)}` };
    }
    // The chaos suite kills the worker here: sent, and only 'attempted' on record.
    await chaosPoint('worker.sender.after-telegram', { commandId: cmd.id, commandType: cmd.command_type, step, kind });
    if (res.success) {
      await mark('sent').catch(unrecorded('sent'));
      return 'sent';
    }
    const error = res.error || (kind === 'document' ? 'TELEGRAM_DOCUMENT_FAILED' : 'TELEGRAM_SEND_FAILED');
    if (UNCERTAIN_SEND.test(error)) {
      await mark('uncertain').catch(unrecorded('uncertain'));
      return 'uncertain';
    }
    await mark('failed').catch(unrecorded('failed'));
    throw new Error(error);
  }

  private registerDefaultHandlers() {
    // A Restate workflow runs once per key (workflow-dispatcher.ts), so a dispatch repeated after a
    // consumer stopped mid-command answers 409 and starts nothing twice.
    if (!this.handlers.has('task.created')) {
      this.handlers.set('task.created', async (cmd) => {
        // Confirmed submission to durable workflow engine (Restate or embedded runner)
        const receipt = await this.dispatcher.dispatch(cmd);
        if (!receipt || !receipt.workflowId) {
          throw new Error(
            `[OutboxConsumer] Confirmed submission failed for task ${cmd.aggregate_id}`
          );
        }
      });
    }

    if (!this.handlers.has('task.dispatch')) {
      this.handlers.set('task.dispatch', async (cmd) => {
        // Confirmed submission to durable workflow engine
        const receipt = await this.dispatcher.dispatch(cmd);
        if (!receipt || !receipt.workflowId) {
          throw new Error(
            `[OutboxConsumer] Confirmed submission failed for task ${cmd.aggregate_id}`
          );
        }
      });
    }

    if (!this.handlers.has('publish.drive')) {
      this.handlers.set('publish.drive', async () => {
        // Effect transport: Drive publication
        throw new Error('Drive publication transport is not registered; no delivery occurred');
      });
    }

    if (!this.handlers.has('notify.telegram')) {
      this.handlers.set('notify.telegram', async (cmd, _db, scope) => {
        // Effect transport: Outbound Telegram notification
        const botToken = this.telegramBotToken();
        if (!botToken) {
          throw new Error('Telegram notification transport is not configured (missing TELEGRAM_BOT_TOKEN)');
        }
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        const chatId = payload?.chatId;
        const message = payload?.message;
        if (!chatId || !message) {
          throw new Error(`Invalid payload for notify.telegram on task ${cmd.aggregate_id}`);
        }
        const sender = this.telegramSender(botToken);
        const prior = await this.priorSends(cmd, scope);
        const sent = await this.sendOnce(cmd, scope, prior, 'message', 'message', () =>
          sender.dispatchOutboundMessage(chatId, typeof message === 'string' ? { text: message } : message)
        );
        if (sent === 'uncertain') {
          throw new OutboxDeliveryError(
            'TELEGRAM_DELIVERY_UNCERTAIN: Telegram may or may not have received the message; not resent',
            'uncertain',
            'TELEGRAM_DELIVERY_UNCERTAIN'
          );
        }
      });
    }

    if (!this.handlers.has('task.outcome')) {
      this.handlers.set('task.outcome', async (cmd) => {
        // A workflow's outcome Core did not take while it was down (outcome-without-core.ts), sent
        // again until it is: Core records it on the task as the workflow's own report would have. The
        // requester's message was written under Core's key, so Core does not send a second one, and
        // an outcome sent twice (a consumer stopped before recording the first) is recorded once.
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        const taskId = String(payload?.taskId || cmd.aggregate_id);
        const token = process.env.HAWA_BEARER_TOKEN;
        if (!token) throw new Error('CORE_NOT_CONFIGURED: HAWA_BEARER_TOKEN is not set, so the outcome was not sent to Core');
        const base = process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001';
        const res = await (this.options.coreFetcher || fetch)(`${base}/v1/tasks/${encodeURIComponent(taskId)}/notifications/canva-status`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...requestIdHeaders() },
          body: JSON.stringify(payload?.report || {}),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new OutboxDeliveryError(`CORE_REFUSED_OUTCOME: Core answered HTTP ${res.status} for task ${taskId}`, 'permanent', 'CORE_REFUSED_OUTCOME');
        }
        throw new Error(`CORE_UNAVAILABLE: Core answered HTTP ${res.status} for task ${taskId}`);
      });
    }

    if (!this.handlers.has('notify.whatsapp')) {
      this.handlers.set('notify.whatsapp', async () => {
        // Effect transport: Outbound WhatsApp interactive message
        throw new Error('WhatsApp notification transport is not registered; no message was sent');
      });
    }

    if (!this.handlers.has('notify.published')) {
      this.handlers.set('notify.published', async (cmd, _db, scope) => {
        // Effect transport: the requester receives the approved files and the delivery notice.
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        const taskId = payload?.taskId || cmd.aggregate_id;

        let sourceChannelId = payload?.chatId || payload?.sourceChannelId;
        let taskTitle = payload?.title;

        // Commands written before Core named the chat carry only the task: find it from the intake.
        // A malformed id is never queried; it could only fail.
        if ((!sourceChannelId || !taskTitle) && /^[0-9a-f-]{36}$/i.test(String(taskId))) {
          try {
            const row: any = await scope.inTenant((trx) => sql`
              SELECT t.title, e.data
              FROM hawa.tasks t
              LEFT JOIN hawa.task_events e ON e.task_id = t.id AND e.event_type = 'task.created'
              WHERE t.id = ${taskId}::uuid
              LIMIT 1
            `.execute(trx));
            if (row.rows[0]) {
              taskTitle = taskTitle || row.rows[0].title;
              const eventData = row.rows[0].data?.payload || row.rows[0].data?.body || row.rows[0].data || {};
              if (!sourceChannelId && eventData.sourcePlatform === 'telegram' && eventData.sourceChannelId) {
                sourceChannelId = String(eventData.sourceChannelId);
              }
            }
          } catch (e) {
            log.warn('[outbox:notify.published] Could not lookup task intake:', e);
          }
        }

        // Nothing was sent, so the command must not be marked delivered: it used to be, whenever the
        // bot token or the requesting chat was missing, and the requester was never told.
        const botToken = this.telegramBotToken();
        if (!botToken) {
          throw new Error(`TELEGRAM_NOT_CONFIGURED: TELEGRAM_BOT_TOKEN is not set, so the delivery notice for task ${taskId} was not sent`);
        }
        if (!sourceChannelId) {
          throw new OutboxDeliveryError(
            `NO_REQUESTER_CHAT: task ${taskId} has no Telegram chat to send the delivery to`,
            'permanent',
            'NO_REQUESTER_CHAT'
          );
        }

        // Every file is read and checked against its approved hash before anything is sent, so a
        // missing or changed file never leaves the requester with half a delivery. The reads are one
        // short transaction, finished before the first upload starts.
        const files: DeliveredFile[] = Array.isArray(payload?.files) ? payload.files : [];
        const readBytes = this.options.readExportBytes || readStoredExportBytes;
        const loaded = await scope.inTenant(async (trx) => {
          const out: Array<{ file: DeliveredFile; bytes: Uint8Array }> = [];
          for (const file of files) {
            const bytes = await readBytes(trx, cmd.tenant_id, taskId, file.artifactId);
            if (!bytes) {
              throw new Error(`DELIVERED_FILE_UNREADABLE: the approved export ${file.artifactId} of task ${taskId} could not be read`);
            }
            if (sha256Hex(bytes) !== file.sha256) {
              throw new OutboxDeliveryError(
                `DELIVERED_FILE_CHANGED: the stored export ${file.artifactId} no longer matches its approved hash`,
                'permanent',
                'DELIVERED_FILE_CHANGED'
              );
            }
            out.push({ file, bytes });
          }
          return out;
        });

        // The files first, as documents: the exact approved bytes (a photo would be recompressed).
        // A file or notice an earlier attempt sent is not sent again, and one that may have reached
        // Telegram is never repeated; it is reported as uncertain (sendOnce).
        const sender = this.telegramSender(botToken);
        const prior = await this.priorSends(cmd, scope);
        const uncertain: string[] = [];
        const endUncertain = (then?: unknown) => new OutboxDeliveryError(
          `TELEGRAM_DELIVERY_UNCERTAIN: Telegram may or may not have received ${uncertain.join(', ')}; not resent` +
            (then === undefined ? '' : `. After that: ${then instanceof Error ? then.message : String(then)}`),
          'uncertain',
          'TELEGRAM_DELIVERY_UNCERTAIN'
        );
        try {
          for (const { file, bytes } of loaded) {
            const sent = await this.sendOnce(cmd, scope, prior, file.artifactId, 'document', () =>
              sender.dispatchOutboundDocument(sourceChannelId, bytes, file.filename, {
                mimeType: file.mimeType || (file.format === 'pdf' ? 'application/pdf' : file.format === 'png' ? 'image/png' : undefined),
                caption: file.filename,
              })
            );
            if (sent === 'uncertain') uncertain.push(file.filename);
          }

          const text = composeDeliveredMessage({ ...payload, title: taskTitle }, { filesSent: loaded.length - uncertain.length, filesUncertain: uncertain.length });
          const notice = await this.sendOnce(cmd, scope, prior, 'notice', 'notice', () =>
            sender.dispatchOutboundMessage(sourceChannelId, { text, parse_mode: 'HTML' })
          );
          if (notice === 'uncertain') uncertain.push('delivery notice');
        } catch (err) {
          // A file that may have arrived must end the command as uncertain, whatever failed after it:
          // a later refusal used to end it 'failed' naming only that refusal, so the office was told
          // "failed" and a requeue of every dead letter took it back.
          if (uncertain.length === 0 || err instanceof OutboxClaimLostError) throw err;
          throw endUncertain(err);
        }
        if (uncertain.length > 0) throw endUncertain();
      });
    }
  }

  /**
   * Keeps this consumer's claim alive while its handler acts: a Telegram upload can outlast the
   * lease, and another consumer (the other worker colour during a deploy) would take the command over
   * and act on it a second time. Renewed every third of the lease; each renewal is fenced on the
   * current claim, so a claim already lost is never taken back.
   *
   * A renewal can fail and the lease run out while the handler is still acting, so the renewals are
   * not what keeps two consumers apart: `whileHeld`, which every side effect goes through, checks the
   * claim (and moves the lease on) in the transaction that records the effect. Renewals and those
   * checks each change the claim token, so they run one after the other: a renewal carrying the token
   * a check had just replaced would find the claim gone.
   */
  private holdClaim(claim: OutboxClaim, leaseSeconds: number, scope: OutboxHandlerScope) {
    let token = claim.claim_token;
    let lost = false;
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    };
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      inTurn(async () => {
        const next = await scope.inTenant((trx) => this.outboxRepo.renewClaim(claim.id, token, leaseSeconds, trx));
        if (next) token = next;
        else lost = true;
      })
        .catch((err: unknown) => log.warn(`[OutboxConsumer] Could not renew the claim of command ${claim.id}:`, err instanceof Error ? err.message : err))
        .finally(() => {
          renewing = false;
        });
    }, Math.max(200, (leaseSeconds * 1000) / 3));
    timer.unref?.();
    const whileHeld = <T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> =>
      inTurn(async () => {
        if (lost) throw new OutboxClaimLostError(claim.id);
        const { next, out } = await scope.inTenant(async (trx) => {
          const renewed = await this.outboxRepo.fenceClaim(claim.id, token, leaseSeconds, trx);
          if (!renewed) throw new OutboxClaimLostError(claim.id);
          return { next: renewed, out: await fn(trx) };
        }).catch((err: unknown) => {
          if (err instanceof OutboxClaimLostError) lost = true;
          throw err;
        });
        // Only once committed: a rolled-back check left the lease, and so the token, as it was.
        token = next;
        return out;
      });
    return {
      scope: { ...scope, whileHeld } as OutboxHandlerScope,
      /** Stops renewing and returns the claim token to record the result with. */
      release: async () => {
        clearInterval(timer);
        await queue;
        return { token, lost };
      },
    };
  }

  /**
   * Claim, act, record, one command at a time, each apart from the others:
   * 1. a short transaction claims one due command (FOR UPDATE SKIP LOCKED) and commits;
   * 2. its handler acts with no transaction open, while its lease is renewed;
   * 3. a second short transaction records the result, only if the claim is still this consumer's.
   * A command used to be handled inside one transaction held open across its network calls, which
   * the pool's idle-in-transaction timeout (30 s) could kill after the send and before the record,
   * and the send was then made again.
   */
  async processBatch(batchSize?: number): Promise<BatchProcessingSummary> {
    const limit = batchSize || this.options.batchSize || 20;
    const leaseSeconds = this.options.leaseSeconds || 60;
    const maxAttempts = this.options.maxAttempts || OUTBOX_MAX_ATTEMPTS;
    const backoffBase = this.options.backoffBaseSeconds || OUTBOX_BACKOFF_BASE_SECONDS;
    const configuredTenantIds = this.options.tenantIds && this.options.tenantIds.length > 0
      ? this.options.tenantIds
      : [this.options.tenantId || '00000000-0000-4000-a000-000000000001'];

    const aggregateSummary: BatchProcessingSummary = {
      leased: 0,
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
      lostClaims: 0,
      errors: [],
    };

    for (const tenantId of configuredTenantIds) {
      const scope = this.scopeFor(tenantId);
      // One at a time: commands claimed together would sit leased while the first one's upload
      // runs, and their leases could run out before this consumer reached them. A command this batch
      // already handled is not claimed again in it, even if its retry is due.
      const seen: string[] = [];
      while (seen.length < limit) {
        const [claim] = await scope.inTenant((trx) =>
          this.outboxRepo.claimDue(1, leaseSeconds, maxAttempts, trx, { exceptIds: seen })
        );
        if (!claim) break;
        seen.push(claim.id);
        aggregateSummary.leased++;
        // Each command is handled, and logs, under the request that wrote it (logging.ts).
        await runWithLogContext(outboxLogContext(claim), () =>
          this.processClaim(claim, scope, { leaseSeconds, maxAttempts, backoffBase }, aggregateSummary)
        );
      }
    }

    return aggregateSummary;
  }

  private async processClaim(
    claim: OutboxClaim,
    scope: OutboxHandlerScope,
    settings: { leaseSeconds: number; maxAttempts: number; backoffBase: number },
    summary: BatchProcessingSummary
  ): Promise<void> {
    const cmd: OutboxCommandRecord = { ...claim, state: 'leased' };

    if (claim.state === 'failed') {
      // Its leases ran out too often: every consumer that took it stopped mid-command. The claim
      // dead-lettered it as uncertain; it is reported like any other dead letter.
      const error = 'LEASE_EXPIRED: every worker that took this command stopped before recording a result';
      summary.deadLettered++;
      summary.errors.push({ id: claim.id, commandType: claim.command_type, error });
      log.error(`[OutboxConsumer] Command ${claim.id} (${claim.command_type}) UNCERTAIN after ${claim.attempts} attempts: ${error}`);
      await this.reportEnded(cmd, claim.attempts, error, true);
      return;
    }

    const hold = this.holdClaim(claim, settings.leaseSeconds, scope);
    const heldScope = hold.scope;
    let failure: unknown = undefined;
    let failed = false;
    try {
      const handler = this.handlers.get(cmd.command_type) || this.handlers.get('*');
      if (!handler) {
        // Unknown commands fail visibly; no no-op handler can claim useful completion
        throw new Error(
          `[OutboxConsumer] Unknown command_type '${cmd.command_type}'. Unknown commands fail visibly; no no-op handler can claim useful completion.`
        );
      }
      // The chaos suite kills the worker here: claimed, nothing done yet.
      await chaosPoint('worker.outbox.after-claim', { commandId: cmd.id, commandType: cmd.command_type, aggregateId: cmd.aggregate_id });
      await handler(cmd, this.db, heldScope);
    } catch (err) {
      failed = true;
      failure = err;
    }
    const { token } = await hold.release();
    // The chaos suite kills the worker here: the handler has acted, and its result is not recorded.
    await chaosPoint('worker.outbox.before-record', { commandId: cmd.id, commandType: cmd.command_type, aggregateId: cmd.aggregate_id, failed });

    if (!failed) {
      try {
        const recorded = await scope.inTenant((trx) => this.outboxRepo.completeClaim(claim.id, token, trx));
        if (recorded) {
          summary.succeeded++;
        } else {
          summary.lostClaims++;
          log.warn(`[OutboxConsumer] Command ${claim.id} (${claim.command_type}) was done, but its claim had passed to another consumer or an operator before that was recorded; the new holder decides.`);
        }
      } catch (recordErr) {
        // Left leased: its lease runs out and it is claimed again, and the handler's own checks keep
        // what it already did from being done twice.
        const detail = recordErr instanceof Error ? recordErr.message : String(recordErr);
        summary.errors.push({ id: claim.id, commandType: claim.command_type, error: `RESULT_NOT_RECORDED: ${detail}` });
        log.error(`[OutboxConsumer] Command ${claim.id} (${claim.command_type}) was done but could not be recorded as delivered:`, recordErr);
      }
      return;
    }

    const errorMessage = failure instanceof Error ? failure.message : String(failure);
    summary.errors.push({ id: claim.id, commandType: claim.command_type, error: errorMessage });

    // A handler that names its error's category is taken at its word; otherwise the message decides.
    // An uncertain delivery can name a later refusal ("... After that: TELEGRAM_DOCUMENT_REJECTED_413"),
    // and must stay uncertain.
    const declared = failure instanceof OutboxDeliveryError && failure.category !== 'retryable' ? failure.category : undefined;
    const isPermanent = declared ? declared === 'permanent' :
      /CHAT_NOT_FOUND|BOT_BLOCKED|USER_DEACTIVATED|INVALID_RECIPIENT|PERMANENT_REJECTION|CLIENT_REQUIRED|INVALID_DESTINATION/i.test(errorMessage) ||
      TELEGRAM_REFUSED.test(errorMessage);
    const isUncertain = declared ? declared === 'uncertain' :
      /DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID|TIMEOUT_AFTER_SEND|KILL_AFTER_SEND|SOCKET_HANGUP_AFTER_WRITE/i.test(errorMessage);
    const outcome: OutboxClaimFailure = isPermanent ? 'permanent' : isUncertain ? 'uncertain' : 'retry';

    // Retry with exponential backoff or dead-letter, in a fresh short transaction fenced on the claim.
    try {
      const updated = await scope.inTenant((trx) =>
        this.outboxRepo.failClaim(claim.id, token, errorMessage, outcome, {
          attempts: claim.attempts,
          maxAttempts: settings.maxAttempts,
          backoffBaseSeconds: settings.backoffBase,
        }, trx)
      );
      if (!updated) {
        summary.lostClaims++;
        log.warn(`[OutboxConsumer] Command ${claim.id} (${claim.command_type}) failed (${errorMessage}), but its claim had passed to another consumer or an operator before that was recorded; the new holder decides.`);
        return;
      }
      if (updated.state === 'failed') {
        summary.deadLettered++;
        log.error(
          `[OutboxConsumer] Command ${claim.id} (${claim.command_type}) ${isUncertain ? 'UNCERTAIN' : isPermanent ? 'PERMANENT FAILURE' : 'DEAD-LETTERED'} after ${updated.attempts} attempts: ${errorMessage}`
        );
        await this.reportEnded(cmd, Number(updated.attempts) || 0, errorMessage, isUncertain);
      } else {
        summary.retried++;
        log.warn(
          `[OutboxConsumer] Command ${claim.id} (${claim.command_type}) scheduled for retry (attempt ${updated.attempts}): ${errorMessage}`
        );
      }
    } catch (retryErr) {
      log.error(
        `[OutboxConsumer] Failed to update retry status for command ${claim.id}:`,
        retryErr
      );
    }
  }

  start(pollIntervalMs?: number): { stop: () => void } {
    if (this.isRunning) {
      return { stop: () => this.stop() };
    }

    this.isRunning = true;
    const interval = pollIntervalMs || this.options.pollIntervalMs || 1000;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        const res = await this.processBatch();
        if (res.leased > 0) {
          log.info(
            `[OutboxConsumer] Batch completed: ${res.succeeded}/${res.leased} succeeded, ${res.retried} retried, ${res.deadLettered} dead-lettered`
          );
        }
      } catch (err) {
        log.error('[OutboxConsumer] Error during poll cycle:', err);
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(poll, interval);
        }
      }
    };

    this.timer = setTimeout(poll, 0);
    return { stop: () => this.stop() };
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('[OutboxConsumer] Stopped');
  }
}
