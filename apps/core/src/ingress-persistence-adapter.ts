import {
  type Kysely,
  type Database,
  type IngressRepository,
  type TaskRepository,
  withRlsContext,
} from '@hawa/db';
import type { IngressPersistencePort } from '@hawa/integrations';
import { CHANNEL_INGRESS_USER_ID, PRIMARY_OPERATOR_USER_ID } from '@hawa/contracts';

export class PostgresIngressPersistenceAdapter implements IngressPersistencePort {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ingressRepo: IngressRepository,
    private readonly taskRepo: TaskRepository,
    private readonly resolveUserId?: (tenantId: string) => string
  ) {}

  /**
   * Rows written because a message arrived belong to the Channel Ingress service identity (ADR-027);
   * migration 012 grants it the operator role on every tenant. A resolver can still override per tenant.
   */
  private getUserId(tenantId: string): string {
    if (this.resolveUserId) return this.resolveUserId(tenantId);
    return CHANNEL_INGRESS_USER_ID;
  }

  async recordInboxEvent(params: {
    tenantId: string;
    integrationId?: string | null;
    sourceAccountId: string;
    sourceEventId: string;
    sourceSequence?: string | null;
    eventKind: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    verified: boolean;
    occurredAt?: Date | null;
  }): Promise<{ event: { id: string }; isDuplicate: boolean }> {
    return await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: this.getUserId(params.tenantId),
        role: 'operator',
      },
      async (trx) => {
        return await this.ingressRepo.recordInboxEvent(params, trx);
      }
    );
  }

  async recordMessageEvent(params: {
    tenantId: string;
    inboxEventId?: string | null;
    integrationId?: string | null;
    externalAccountId: string;
    externalChannelId: string;
    externalThreadId?: string | null;
    externalMessageId: string;
    externalRevisionId?: string;
    senderExternalId?: string | null;
    mappedUserId?: string | null;
    language?: string | null;
    direction?: 'ltr' | 'rtl' | 'auto' | null;
    textOriginal?: string;
    entities?: unknown[];
    occurredAt?: Date | null;
  }): Promise<{ message: { id: string }; isDuplicate: boolean }> {
    return await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: this.getUserId(params.tenantId),
        role: 'operator',
      },
      async (trx) => {
        return await this.ingressRepo.recordMessageEvent(params, trx);
      }
    );
  }

  async recordAttachment(params: {
    tenantId: string;
    messageEventId: string;
    sourceAttachmentId?: string | null;
    filename: string;
    mimeType: string;
    byteSize: number | bigint;
    sha256: string;
    storageKey: string;
    scanState?: 'pending' | 'clean' | 'quarantined' | 'rejected';
    metadata?: Record<string, unknown>;
  }): Promise<{ attachment: { id: string }; isDuplicate: boolean }> {
    return await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: this.getUserId(params.tenantId),
        role: 'operator',
      },
      async (trx) => {
        return await this.ingressRepo.recordAttachment(params, trx);
      }
    );
  }

  async findTaskByMessageExternal(params: {
    tenantId: string;
    integrationId?: string | null;
    externalAccountId: string;
    externalChannelId: string;
    externalMessageId: string;
  }): Promise<{ id: string; state: string; current_brief_id: string | null } | null> {
    return await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: this.getUserId(params.tenantId),
        role: 'operator',
      },
      async (trx) => {
        const task = await this.ingressRepo.findTaskByMessageExternal(
          params.tenantId,
          params,
          trx
        );
        if (!task) return null;
        return {
          id: task.id,
          state: task.state,
          current_brief_id: task.current_brief_id,
        };
      }
    );
  }

  async createTaskAggregate(params: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    title: string;
    description: string;
    clientId?: string | null;
    priority?: number;
    sourceMessageId: string;
    payload?: Record<string, unknown>;
    enqueueOutbox?: boolean;
  }): Promise<{ task: { id: string; state: string }; created: boolean }> {
    const effectiveUserId =
      params.userId && params.userId !== PRIMARY_OPERATOR_USER_ID && params.userId !== CHANNEL_INGRESS_USER_ID
        ? params.userId
        : this.getUserId(params.tenantId);

    return await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: effectiveUserId,
        role: 'operator',
      },
      async (trx) => {
        const result = await this.taskRepo.createTaskAggregate(
          {
            tenantId: params.tenantId,
            userId: effectiveUserId,
            idempotencyKey: params.idempotencyKey,
            title: params.title,
            description: params.description,
            clientId: params.clientId || null,
            priority: params.priority || 3,
            sourceMessageId: params.sourceMessageId,
            payload: params.payload || {},
            enqueueOutbox: params.enqueueOutbox ?? true,
          },
          trx
        );
        return {
          task: {
            id: result.task.id,
            state: result.task.state,
          },
          created: result.created,
        };
      }
    );
  }

  async recordRevisionRequest(params: {
    tenantId: string;
    taskId: string;
    sourceMessageId: string;
    newRevisionId: string;
    reason: string;
    actorExternalId?: string;
  }): Promise<void> {
    const userId = this.getUserId(params.tenantId);
    await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId,
        role: 'operator',
      },
      async (trx) => {
        const task = await this.taskRepo.findById(params.taskId, params.tenantId, trx);
        if (task) {
          await this.taskRepo.transitionState(
            {
              tenantId: params.tenantId,
              taskId: params.taskId,
              fromState: task.state,
              toState: 'revision_requested',
              actorType: 'adapter',
              actorId: params.actorExternalId || 'ingress',
              reason: params.reason,
            },
            trx
          );
        }
      }
    );
  }

  async updateTaskDraft(params: {
    tenantId: string;
    taskId: string;
    sourceMessageId: string;
    newRevisionId: string;
    description: string;
  }): Promise<void> {
    await withRlsContext(
      this.db,
      {
        tenantId: params.tenantId,
        userId: this.getUserId(params.tenantId),
        role: 'operator',
      },
      async (trx) => {
        await trx
          .updateTable('tasks')
          .set({
            description: params.description,
            source_message_id: params.sourceMessageId,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', params.tenantId)
          .where('id', '=', params.taskId)
          .execute();
      }
    );
  }
}
