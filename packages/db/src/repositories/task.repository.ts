import type { Kysely } from 'kysely';
import type { Database, TasksTable, TaskEventsTable } from '../types.js';

export interface CreateTaskParams {
  tenantId: string;
  clientId?: string;
  projectId?: string;
  sourcePlatform: string;
  sourceEventId: string;
  sourceChannelId: string;
  idempotencyKey: string;
  priority?: string;
  brief?: Record<string, unknown>;
}

export class TaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string) {
    return await this.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  async create(params: CreateTaskParams) {
    const existing = await this.findByIdempotencyKey(params.tenantId, params.idempotencyKey);
    if (existing) {
      return { task: existing, created: false };
    }

    const task = await this.db
      .insertInto('tasks')
      .values({
        tenant_id: params.tenantId,
        client_id: params.clientId || null,
        project_id: params.projectId || null,
        status: 'RECEIVED',
        priority: params.priority || 'routine',
        source_platform: params.sourcePlatform,
        source_event_id: params.sourceEventId,
        source_channel_id: params.sourceChannelId,
        idempotency_key: params.idempotencyKey,
        client_scope_locked: Boolean(params.clientId),
        brief: params.brief || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('task_events')
      .values({
        task_id: task.id,
        from_status: 'NONE',
        to_status: 'RECEIVED',
        actor_id: 'system',
        actor_type: 'system',
        reason: 'Initial task intake',
        payload: null,
      })
      .execute();

    return { task, created: true };
  }

  async lockClientScope(taskId: string, clientId: string, projectId?: string) {
    return await this.db
      .updateTable('tasks')
      .set({
        client_id: clientId,
        project_id: projectId || null,
        client_scope_locked: true,
      })
      .where('id', '=', taskId)
      .returningAll()
      .executeTakeFirstOrThrow();
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
    const updated = await this.db
      .updateTable('tasks')
      .set({ status: toStatus })
      .where('id', '=', taskId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('task_events')
      .values({
        task_id: taskId,
        from_status: fromStatus,
        to_status: toStatus,
        actor_id: actorId,
        actor_type: actorType,
        reason,
        payload: payload || null,
      })
      .execute();

    return updated;
  }

  async getEvents(taskId: string) {
    return await this.db
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .execute();
  }
}
