import {
  OutboxRepository,
  TaskRepository,
  withRlsContext,
  type Database,
  type Kysely,
} from '@hawa/db';
import { OfficeTracer } from '@hawa/observability';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';

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
        throw new Error('Telegram notification transport is not registered; no message was sent');
      });
    }

    if (!this.handlers.has('notify.whatsapp')) {
      this.handlers.set('notify.whatsapp', async (cmd, db) => {
        // Effect transport: Outbound WhatsApp interactive message
        throw new Error('WhatsApp notification transport is not registered; no message was sent');
      });
    }
  }

  async processBatch(batchSize?: number): Promise<BatchProcessingSummary> {
    const limit = batchSize || this.options.batchSize || 20;
    const leaseSeconds = this.options.leaseSeconds || 60;
    const maxAttempts = this.options.maxAttempts || 5;
    const backoffBase = this.options.backoffBaseSeconds || 5;
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

          // 4. Retry with exponential backoff or dead-letter in a fresh clean transaction
          try {
            const updated = await withRlsContext(
              this.db,
              { tenantId: cmd.tenant_id, userId, role: 'administrator' },
              async (retryTrx) => {
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
                `[OutboxConsumer] Command ${cmd.id} (${cmd.command_type}) DEAD-LETTERED after ${updated.attempts} attempts: ${errorMessage}`
              );
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
