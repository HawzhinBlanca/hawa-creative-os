import {
  OutboxRepository,
  TaskRepository,
  withRlsContext,
  sql,
  type Database,
  type Kysely,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_SECONDS,
} from '@hawa/db';
import { OfficeTracer } from '@hawa/observability';
import { TelegramBridge } from '@hawa/integrations';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
import {
  composeDeliveredMessage,
  composeIntakeFailedAlert,
  composeIntakeFailedMessage,
  intakeChatOf,
  readStoredExportBytes,
  sha256Hex,
  type DeliveredFile,
  type ExportBytesReader,
  type TelegramSender,
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
}

export type DeliveryErrorCategory = 'retryable' | 'permanent' | 'uncertain';

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

export type OutboxCommandHandler = (
  cmd: OutboxCommandRecord,
  db: Kysely<Database>
) => Promise<void>;

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
}

export interface BatchProcessingSummary {
  leased: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
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
        console.error(
          `[OutboxConsumer] Request ${cmd.aggregate_id} was dead-lettered and its requester could not be told (${!chatId ? 'no Telegram chat in the command' : 'TELEGRAM_BOT_TOKEN is not set'}).`
        );
        return;
      }
      const sender = this.telegramSender(botToken);
      const told = await sender.dispatchOutboundMessage(chatId, { text: composeIntakeFailedMessage(cmd.aggregate_id) });
      if (!told.success) {
        console.error(`[OutboxConsumer] Could not tell chat ${chatId} that request ${cmd.aggregate_id} failed: ${told.error}`);
      }
      const office = this.officeAlertChatId();
      if (office && office !== chatId) {
        const alerted = await sender.dispatchOutboundMessage(office, {
          text: composeIntakeFailedAlert(cmd.aggregate_id, chatId, attempts, error),
        });
        if (!alerted.success) console.error(`[OutboxConsumer] Office alert for request ${cmd.aggregate_id} failed: ${alerted.error}`);
      }
    } catch (notifyErr) {
      console.error(`[OutboxConsumer] Could not notify about dead-lettered request ${cmd.aggregate_id}:`, notifyErr);
    }
  }

  private registerDefaultHandlers() {
    if (!this.handlers.has('task.created')) {
      this.handlers.set('task.created', async (cmd, db) => {
        // Confirmed submission to durable workflow engine (Restate or embedded runner)
        const receipt = await this.dispatcher.dispatch(cmd, db);
        if (!receipt || !receipt.workflowId) {
          throw new Error(
            `[OutboxConsumer] Confirmed submission failed for task ${cmd.aggregate_id}`
          );
        }
      });
    }

    if (!this.handlers.has('task.dispatch')) {
      this.handlers.set('task.dispatch', async (cmd, db) => {
        // Confirmed submission to durable workflow engine
        const receipt = await this.dispatcher.dispatch(cmd, db);
        if (!receipt || !receipt.workflowId) {
          throw new Error(
            `[OutboxConsumer] Confirmed submission failed for task ${cmd.aggregate_id}`
          );
        }
      });
    }

    if (!this.handlers.has('publish.drive')) {
      this.handlers.set('publish.drive', async (cmd, db) => {
        // Effect transport: Drive publication
        throw new Error('Drive publication transport is not registered; no delivery occurred');
      });
    }

    if (!this.handlers.has('notify.telegram')) {
      this.handlers.set('notify.telegram', async (cmd, db) => {
        // Effect transport: Outbound Telegram notification
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
          throw new Error('Telegram notification transport is not configured (missing TELEGRAM_BOT_TOKEN)');
        }
        const telegramBridge = new TelegramBridge({ botToken });
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        const chatId = payload?.chatId;
        const message = payload?.message;
        if (!chatId || !message) {
          throw new Error(`Invalid payload for notify.telegram on task ${cmd.aggregate_id}`);
        }
        const res = await telegramBridge.dispatchOutboundMessage(chatId, typeof message === 'string' ? { text: message } : message);
        if (!res.success) {
          throw new Error(res.error || 'TELEGRAM_SEND_FAILED');
        }
      });
    }

    if (!this.handlers.has('notify.whatsapp')) {
      this.handlers.set('notify.whatsapp', async (cmd, db) => {
        // Effect transport: Outbound WhatsApp interactive message
        throw new Error('WhatsApp notification transport is not registered; no message was sent');
      });
    }

    if (!this.handlers.has('notify.published')) {
      this.handlers.set('notify.published', async (cmd, dbTrx) => {
        // Effect transport: the requester receives the approved files and the delivery notice.
        const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
        const taskId = payload?.taskId || cmd.aggregate_id;

        let sourceChannelId = payload?.chatId || payload?.sourceChannelId;
        let taskTitle = payload?.title;

        // Commands written before Core named the chat carry only the task: find it from the intake.
        // A malformed id would abort the transaction the command is marked in, so it is never queried.
        if ((!sourceChannelId || !taskTitle) && dbTrx && /^[0-9a-f-]{36}$/i.test(String(taskId))) {
          try {
            const row: any = await sql`
              SELECT t.title, e.data
              FROM hawa.tasks t
              LEFT JOIN hawa.task_events e ON e.task_id = t.id AND e.event_type = 'task.created'
              WHERE t.id = ${taskId}::uuid
              LIMIT 1
            `.execute(dbTrx);
            if (row.rows[0]) {
              taskTitle = taskTitle || row.rows[0].title;
              const eventData = row.rows[0].data?.payload || row.rows[0].data?.body || row.rows[0].data || {};
              if (!sourceChannelId && eventData.sourcePlatform === 'telegram' && eventData.sourceChannelId) {
                sourceChannelId = String(eventData.sourceChannelId);
              }
            }
          } catch (e) {
            console.warn('[outbox:notify.published] Could not lookup task intake:', e);
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
        // missing or changed file never leaves the requester with half a delivery.
        const files: DeliveredFile[] = Array.isArray(payload?.files) ? payload.files : [];
        const readBytes = this.options.readExportBytes || readStoredExportBytes;
        const loaded: Array<{ file: DeliveredFile; bytes: Uint8Array }> = [];
        for (const file of files) {
          const bytes = await readBytes(dbTrx, cmd.tenant_id, taskId, file.artifactId);
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
          loaded.push({ file, bytes });
        }

        // The files first, as documents: the exact approved bytes (a photo would be recompressed).
        // A send that may have reached Telegram is never repeated; it is recorded as uncertain.
        const sender = this.telegramSender(botToken);
        const uncertain: string[] = [];
        for (const { file, bytes } of loaded) {
          const sent = await sender.dispatchOutboundDocument(sourceChannelId, bytes, file.filename, {
            mimeType: file.mimeType || (file.format === 'pdf' ? 'application/pdf' : file.format === 'png' ? 'image/png' : undefined),
            caption: file.filename,
          });
          if (!sent.success) {
            if (/DELIVERY_UNCERTAIN/.test(sent.error || '')) { uncertain.push(file.filename); continue; }
            throw new Error(sent.error || 'TELEGRAM_DOCUMENT_FAILED');
          }
        }

        const text = composeDeliveredMessage({ ...payload, title: taskTitle }, { filesSent: loaded.length - uncertain.length });
        const res = await sender.dispatchOutboundMessage(sourceChannelId, { text, parse_mode: 'HTML' });
        if (!res.success) {
          if (!/DELIVERY_UNCERTAIN/.test(res.error || '')) throw new Error(res.error || 'TELEGRAM_SEND_FAILED');
          uncertain.push('delivery notice');
        }
        if (uncertain.length > 0) {
          throw new OutboxDeliveryError(
            `TELEGRAM_DELIVERY_UNCERTAIN: Telegram may or may not have received ${uncertain.join(', ')}; not resent`,
            'uncertain',
            'TELEGRAM_DELIVERY_UNCERTAIN'
          );
        }
      });
    }
  }

  async processBatch(batchSize?: number): Promise<BatchProcessingSummary> {
    const limit = batchSize || this.options.batchSize || 20;
    const leaseSeconds = this.options.leaseSeconds || 60;
    const maxAttempts = this.options.maxAttempts || OUTBOX_MAX_ATTEMPTS;
    const backoffBase = this.options.backoffBaseSeconds || OUTBOX_BACKOFF_BASE_SECONDS;
    const configuredTenantIds = this.options.tenantIds && this.options.tenantIds.length > 0
      ? this.options.tenantIds
      : [this.options.tenantId || '00000000-0000-4000-a000-000000000001'];
    const userId = this.options.userId || '00000000-0000-4000-b000-000000000002';

    const aggregateSummary: BatchProcessingSummary = {
      leased: 0,
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
      errors: [],
    };

    for (const tenantId of configuredTenantIds) {
      // 1. Atomically lease pending/expired commands with FOR UPDATE SKIP LOCKED
      const leasedCommands = (await withRlsContext(
        this.db,
        { tenantId, userId, role: 'administrator' },
        async (trx) => {
          return (await this.outboxRepo.leasePending(
            limit,
            leaseSeconds,
            trx
          )) as OutboxCommandRecord[];
        }
      )) || [];

      aggregateSummary.leased += leasedCommands.length;
      if (leasedCommands.length === 0) {
        continue;
      }

      // 2. Process each command idempotently in its own isolated transaction
      for (const cmd of leasedCommands) {
        try {
          const handler = this.handlers.get(cmd.command_type) || this.handlers.get('*');
          if (!handler) {
            // Unknown commands fail visibly; no no-op handler can claim useful completion
            throw new Error(
              `[OutboxConsumer] Unknown command_type '${cmd.command_type}'. Unknown commands fail visibly; no no-op handler can claim useful completion.`
            );
          }

          await withRlsContext(
            this.db,
            { tenantId: cmd.tenant_id, userId, role: 'administrator' },
            async (cmdTrx) => {
              await handler(cmd, cmdTrx);
              // 3. Mark successfully delivered only upon confirmed execution
              await this.outboxRepo.markDelivered(cmd.id, cmdTrx);
            }
          );
          aggregateSummary.succeeded++;
        } catch (err: any) {
          const errorMessage = err?.message || String(err);
          aggregateSummary.errors.push({
            id: cmd.id,
            commandType: cmd.command_type,
            error: errorMessage,
          });

          const isPermanent =
            (err instanceof OutboxDeliveryError && err.category === 'permanent') ||
            /CHAT_NOT_FOUND|BOT_BLOCKED|USER_DEACTIVATED|INVALID_RECIPIENT|PERMANENT_REJECTION|CLIENT_REQUIRED|INVALID_DESTINATION/i.test(errorMessage);
          const isUncertain =
            (err instanceof OutboxDeliveryError && err.category === 'uncertain') ||
            /DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID|TIMEOUT_AFTER_SEND|KILL_AFTER_SEND|SOCKET_HANGUP_AFTER_WRITE/i.test(errorMessage);

          // 4. Retry with exponential backoff or dead-letter in a fresh clean transaction
          try {
            const updated = await withRlsContext(
              this.db,
              { tenantId: cmd.tenant_id, userId, role: 'administrator' },
              async (retryTrx) => {
                if (isPermanent) {
                  return await this.outboxRepo.markPermanentFailure(cmd.id, errorMessage, retryTrx);
                }
                if (isUncertain) {
                  return await this.outboxRepo.markUncertain(cmd.id, errorMessage, retryTrx);
                }
                return await this.outboxRepo.retryOrDeadLetter(
                  cmd.id,
                  errorMessage,
                  maxAttempts,
                  backoffBase,
                  retryTrx
                );
              }
            );
            if (updated.state === 'failed') {
              aggregateSummary.deadLettered++;
              console.error(
                `[OutboxConsumer] Command ${cmd.id} (${cmd.command_type}) ${isUncertain ? 'UNCERTAIN' : isPermanent ? 'PERMANENT FAILURE' : 'DEAD-LETTERED'} after ${updated.attempts} attempts: ${errorMessage}`
              );
              // An uncertain dispatch may have started the workflow, so only a definite failure is announced.
              if (cmd.command_type === 'task.created' && !isUncertain) {
                await this.tellRequesterIntakeFailed(cmd, Number(updated.attempts) || 0, errorMessage);
              }
            } else {
              aggregateSummary.retried++;
              console.warn(
                `[OutboxConsumer] Command ${cmd.id} (${cmd.command_type}) scheduled for retry (attempt ${updated.attempts}): ${errorMessage}`
              );
            }
          } catch (retryErr) {
            console.error(
              `[OutboxConsumer] Failed to update retry status for command ${cmd.id}:`,
              retryErr
            );
          }
        }
      }
    }

    return aggregateSummary;
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
          console.log(
            `[OutboxConsumer] Batch completed: ${res.succeeded}/${res.leased} succeeded, ${res.retried} retried, ${res.deadLettered} dead-lettered`
          );
        }
      } catch (err) {
        console.error('[OutboxConsumer] Error during poll cycle:', err);
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
    console.log('[OutboxConsumer] Stopped');
  }
}
