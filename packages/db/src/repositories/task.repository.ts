import crypto from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database, TasksTable, TaskEventsTable, TaskState } from '../types.js';

export class IdempotencyConflictError extends Error {
  constructor(message: string = 'Idempotency conflict: key already used with different payload') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

export interface CreateTaskAggregateParams {
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  title: string;
  description?: string;
  clientId?: string | null;
  projectId?: string | null;
  taskType?: string | null;
  language?: string | null;
  direction?: 'ltr' | 'rtl' | 'auto' | null;
  priority?: number; // 1-5 (default 3)
  sensitivity?: 'normal' | 'sensitive' | 'restricted';
  sourceMessageId?: string | null;
  actorType?: 'user' | 'model' | 'workflow' | 'adapter' | 'system';
  actorId?: string | null;
  correlationId?: string;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  enqueueOutbox?: boolean;
}

export function toDbTaskState(status: string): TaskState {
  const s = (status || '').toUpperCase();
  switch (s) {
    case 'RECEIVED': return 'received';
    case 'ROUTING': return 'routing';
    case 'ROUTING_REVIEW': return 'routing_review';
    case 'BRIEFING': return 'brief_draft';
    case 'BRIEF_REVIEW': return 'brief_review';
    case 'PLANNING': return 'design_planning';
    case 'ASSET_GENERATION': return 'asset_production';
    case 'COMPOSING': return 'studio_composition';
    case 'QA': return 'qa';
    case 'REPAIRING': return 'auto_repair';
    case 'AWAITING_APPROVAL': return 'human_review';
    case 'APPROVED': return 'approved';
    case 'REVISION_REQUESTED': return 'revision_requested';
    case 'REJECTED': return 'rejected';
    case 'PUBLISHING': return 'publishing';
    case 'COMPLETE': return 'complete';
    case 'OPERATOR_REQUIRED': return 'failed_operator';
    case 'CANCELLED': return 'cancelled';
    default:
      if (['received', 'routing', 'brief_draft', 'brief_review', 'design_planning', 'asset_production', 'studio_composition', 'qa', 'auto_repair', 'human_review', 'revision_requested', 'approved', 'publishing', 'complete', 'rejected', 'failed_operator', 'cancelled'].includes(status.toLowerCase())) {
        return status.toLowerCase() as TaskState;
      }
      return 'received';
  }
}

export function toApiTaskStatus(state: TaskState | string): string {
  const s = (state || '').toLowerCase();
  switch (s) {
    case 'received': return 'RECEIVED';
    case 'routing': return 'ROUTING';
    case 'routing_review': return 'ROUTING_REVIEW';
    case 'brief_draft': return 'BRIEFING';
    case 'brief_review': return 'BRIEF_REVIEW';
    case 'context_ready': return 'BRIEFING';
    case 'design_planning': return 'PLANNING';
    case 'asset_production': return 'ASSET_GENERATION';
    case 'studio_composition': return 'COMPOSING';
    case 'qa': return 'QA';
    case 'auto_repair': return 'REPAIRING';
    case 'human_review': return 'AWAITING_APPROVAL';
    case 'approved': return 'APPROVED';
    case 'revision_requested': return 'REVISION_REQUESTED';
    case 'rejected': return 'REJECTED';
    case 'publishing': return 'PUBLISHING';
    case 'complete': return 'COMPLETE';
    case 'failed_operator': return 'OPERATOR_REQUIRED';
    case 'failed_retryable': return 'OPERATOR_REQUIRED';
    case 'cancelled': return 'CANCELLED';
    default: return s.toUpperCase();
  }
}

export interface TransitionStateParams {
  taskId: string;
  tenantId: string;
  expectedVersion?: number;
  fromState?: TaskState;
  toState: TaskState;
  actorType: 'user' | 'model' | 'workflow' | 'adapter' | 'system';
  actorId?: string | null;
  reason: string;
  correlationId?: string;
  causationId?: string | null;
  traceId?: string | null;
  data?: Record<string, unknown>;
  command?: {
    type: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  };
}

export interface CreateTaskParams {
  tenantId: string;
  clientId?: string | null;
  projectId?: string | null;
  sourcePlatform?: string;
  sourceEventId?: string;
  sourceChannelId?: string;
  idempotencyKey: string;
  priority?: string | number;
  title?: string;
  description?: string;
  brief?: Record<string, unknown>;
  userId?: string;
}

export class TaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  private computePayloadHash(payload: Record<string, unknown>): string {
    const sortObject = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortObject);
      const sortedKeys = Object.keys(obj).sort();
      const result: Record<string, any> = {};
      for (const k of sortedKeys) {
        if (obj[k] !== undefined) {
          result[k] = sortObject(obj[k]);
        }
      }
      return result;
    };
    const canonical = JSON.stringify(sortObject(payload));
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  async findById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db).selectFrom('tasks').selectAll().where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async findWithEvents(id: string, tenantId?: string, trx?: Kysely<Database>) {
    const task = await this.findById(id, tenantId, trx);
    if (!task) return null;

    let eventsQuery = (trx || this.db)
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', id);

    if (tenantId) {
      eventsQuery = eventsQuery.where('tenant_id', '=', tenantId);
    }

    const events = await eventsQuery.orderBy('aggregate_version', 'asc').execute();
    return { task, events };
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, trx?: Kysely<Database>) {
    const cmd = await (trx || this.db)
      .selectFrom('outbox_commands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .where('aggregate_type', '=', 'task')
      .executeTakeFirst();

    if (!cmd) return null;

    const task = await (trx || this.db)
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', cmd.aggregate_id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    return task || null;
  }

  async createTaskAggregate(
    params: CreateTaskAggregateParams,
    trx?: Kysely<Database>
  ): Promise<{ task: any; created: boolean }> {
    const runner = async (dbClient: Kysely<Database>) => {
      // 1. Check idempotency in outbox_commands
      const existingCmd = await dbClient
        .selectFrom('outbox_commands')
        .selectAll()
        .where('tenant_id', '=', params.tenantId)
        .where('idempotency_key', '=', params.idempotencyKey)
        .executeTakeFirst();

      const incomingPayload = params.payload || {
        title: params.title,
        clientId: params.clientId || null,
        description: params.description || '',
        priority: params.priority || 3,
      };
      const incomingHash = this.computePayloadHash(incomingPayload);

      if (existingCmd) {
        const storedPayload = typeof existingCmd.payload === 'string' ? JSON.parse(existingCmd.payload) : existingCmd.payload;
        const storedHash =
          (storedPayload as any)?.requestHash ||
          this.computePayloadHash(storedPayload as Record<string, unknown>);

        if (storedHash !== incomingHash) {
          throw new IdempotencyConflictError(
            `Idempotency conflict: key '${params.idempotencyKey}' already used with differing payload`
          );
        }

        const existingTask = await dbClient
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', existingCmd.aggregate_id)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (existingTask) {
          return { task: existingTask, created: false };
        }
      }

      // 2. Insert into tasks
      const priorityNum = typeof params.priority === 'number' ? params.priority : 3;
      const task = await dbClient
        .insertInto('tasks')
        .values({
          tenant_id: params.tenantId,
          client_id: params.clientId || null,
          project_id: params.projectId || null,
          source_message_id: params.sourceMessageId || null,
          title: params.title,
          description: params.description || '',
          state: 'received',
          task_type: params.taskType || null,
          language: params.language || null,
          direction: params.direction || null,
          priority: priorityNum,
          sensitivity: params.sensitivity || 'normal',
          requested_by: params.userId || null,
          assigned_to: null,
          due_at: null,
          version: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 3. Insert into task_events (aggregate_version = 1)
      const correlationId = params.correlationId || crypto.randomUUID();
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: task.id,
          event_type: 'task.created',
          schema_version: 1,
          aggregate_version: 1,
          actor_type: params.actorType || 'user',
          actor_id: params.actorId || params.userId,
          correlation_id: correlationId,
          causation_id: null,
          trace_id: params.traceId || null,
          data: {
            title: task.title,
            clientId: task.client_id,
            state: task.state,
            priority: task.priority,
            metadata: params.metadata || {},
            payload: params.payload || {},
            ...(params.payload || {}),
          },
        })
        .execute();

      // 4. Insert into outbox_commands if requested
      if (params.enqueueOutbox !== false) {
        await dbClient
          .insertInto('outbox_commands')
          .values({
            tenant_id: params.tenantId,
            aggregate_type: 'task',
            aggregate_id: task.id,
            command_type: 'task.created',
            idempotency_key: params.idempotencyKey,
            payload: {
              ...(params.payload || {}),
              taskId: task.id,
              tenantId: params.tenantId,
              title: task.title,
              clientId: task.client_id,
              priority: task.priority,
              requestHash: incomingHash,
            },
            state: 'pending',
          })
          .execute();
      }

      return { task, created: true };
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async transitionState(
    params: TransitionStateParams,
    trx?: Kysely<Database>
  ): Promise<any> {
    const runner = async (dbClient: Kysely<Database>) => {
      let expectedVersion = params.expectedVersion;
      if (expectedVersion === undefined) {
        const current = await dbClient
          .selectFrom('tasks')
          .select(['version', 'state'])
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (!current) {
          throw new TaskNotFoundError(`Task ${params.taskId} not found in tenant ${params.tenantId}`);
        }
        expectedVersion = Number(current.version);
      }

      const nextVersion = expectedVersion + 1;
      const isCompletion = params.toState === 'complete' || params.toState === 'cancelled';

      const updateData: any = {
        state: params.toState,
        version: nextVersion,
        updated_at: new Date(),
      };
      if (isCompletion) {
        updateData.completed_at = new Date();
      }

      let updateQuery = dbClient
        .updateTable('tasks')
        .set(updateData)
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .where('version', '=', expectedVersion);

      if (params.fromState) {
        updateQuery = updateQuery.where('state', '=', params.fromState);
      }

      const updated = await updateQuery.returningAll().executeTakeFirst();

      if (!updated) {
        // Find current state to produce descriptive conflict error
        const current = await dbClient
          .selectFrom('tasks')
          .select(['version', 'state'])
          .where('id', '=', params.taskId)
          .where('tenant_id', '=', params.tenantId)
          .executeTakeFirst();

        if (!current) {
          throw new TaskNotFoundError(`Task ${params.taskId} not found in tenant ${params.tenantId}`);
        }
        throw new ConcurrencyConflictError(
          `Conflict on task ${params.taskId}: expected version ${expectedVersion} (state: ${params.fromState || '*'}), but current version is ${current.version} (state: ${current.state})`
        );
      }

      // Record immutable audit event
      const correlationId = params.correlationId || crypto.randomUUID();
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'task.state_changed',
          schema_version: 1,
          aggregate_version: nextVersion,
          actor_type: params.actorType,
          actor_id: params.actorId || null,
          correlation_id: correlationId,
          causation_id: params.causationId || null,
          trace_id: params.traceId || null,
          data: {
            fromState: params.fromState,
            toState: params.toState,
            reason: params.reason,
            ...(params.data || {}),
          },
        })
        .execute();

      // Enqueue optional outbox command
      if (params.command) {
        await dbClient
          .insertInto('outbox_commands')
          .values({
            tenant_id: params.tenantId,
            aggregate_type: 'task',
            aggregate_id: params.taskId,
            command_type: params.command.type,
            idempotency_key: params.command.idempotencyKey,
            payload: params.command.payload,
            state: 'pending',
          })
          .execute();
      }

      return updated;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async getEvents(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', taskId);

    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }

    return await query.orderBy('aggregate_version', 'asc').execute();
  }

  // --- Backward-compatibility methods for unit tests and legacy callers ---

  async create(params: CreateTaskParams) {
    const priority =
      typeof params.priority === 'number'
        ? params.priority
        : params.priority === 'urgent'
        ? 5
        : params.priority === 'rush'
        ? 4
        : 3;

    const result = await this.createTaskAggregate({
      tenantId: params.tenantId,
      userId: params.userId || '00000000-0000-4000-b000-000000000001',
      idempotencyKey: params.idempotencyKey,
      title: params.title || 'Untitled Task',
      description: params.description || '',
      clientId: params.clientId || null,
      projectId: params.projectId || null,
      priority,
      actorType: 'system',
      actorId: 'system',
      payload: {
        brief: params.brief,
        sourcePlatform: params.sourcePlatform,
        sourceEventId: params.sourceEventId,
        sourceChannelId: params.sourceChannelId,
      },
      enqueueOutbox: false,
    });

    const taskWithStatus = {
      ...result.task,
      status: (result.task.state || 'received').toUpperCase(),
      client_scope_locked: Boolean(result.task.client_id),
    };

    return { task: taskWithStatus, created: result.created };
  }

  async lockClientScope(taskId: string, clientId: string, projectId?: string) {
    const task = await this.findById(taskId);
    if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);

    const updated = await this.db
      .updateTable('tasks')
      .set({
        client_id: clientId,
        project_id: projectId || null,
      })
      .where('id', '=', taskId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      ...updated,
      client_scope_locked: true,
      status: (updated.state || 'received').toUpperCase(),
    };
  }

  async updateStatus(
    taskId: string,
    fromStatus: string,
    toStatus: string,
    actorId: string,
    actorType: string,
    reason: string,
    payload?: Record<string, unknown>
  ) {
    const task = await this.findById(taskId);
    if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);

    const validActorTypes = ['user', 'model', 'workflow', 'adapter', 'system'] as const;
    const resolvedActorType = validActorTypes.includes(actorType as any)
      ? (actorType as any)
      : 'system';

    const normalizedToState = toStatus.toLowerCase() as TaskState;

    const updated = await this.transitionState({
      taskId,
      tenantId: task.tenant_id,
      expectedVersion: Number(task.version),
      toState: normalizedToState,
      actorType: resolvedActorType,
      actorId,
      reason,
      data: payload,
    });

    return {
      ...updated,
      status: toStatus,
    };
  }
}
