import type { Kysely } from 'kysely';
import type { Database, FeedbackEventsTable } from '../types.js';

export interface CreateFeedbackEventParams {
  tenantId: string;
  clientId: string;
  projectId?: string | null;
  taskId?: string | null;
  beforeRevisionId?: string | null;
  afterRevisionId?: string | null;
  category: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  scope?: 'one_time' | 'task_type' | 'project' | 'client' | 'office';
  explicitness: 'direct_instruction' | 'manual_edit' | 'approval_signal' | 'inferred_pattern';
  target?: Record<string, unknown>;
  originalValue?: unknown | null;
  correctedValue?: unknown | null;
  comment?: string | null;
  actorId?: string | null;
  confidence?: number | null;
}

export class FeedbackRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async recordFeedback(params: CreateFeedbackEventParams, trx?: Kysely<Database>) {
    const dbClient = trx || this.db;
    const [event] = await dbClient
      .insertInto('feedback_events')
      .values({
        tenant_id: params.tenantId,
        client_id: params.clientId,
        project_id: params.projectId || null,
        task_id: params.taskId || null,
        before_revision_id: params.beforeRevisionId || null,
        after_revision_id: params.afterRevisionId || null,
        category: params.category,
        severity: params.severity || 'medium',
        scope: params.scope || 'one_time',
        explicitness: params.explicitness,
        target: JSON.stringify(params.target || {}),
        original_value: params.originalValue !== undefined ? JSON.stringify(params.originalValue) : null,
        corrected_value: params.correctedValue !== undefined ? JSON.stringify(params.correctedValue) : null,
        comment: params.comment || null,
        actor_id: params.actorId || null,
        confidence: params.confidence !== undefined ? params.confidence : null,
      })
      .returningAll()
      .execute();
    return event;
  }

  async listFeedbackForClient(clientId: string, tenantId: string, trx?: Kysely<Database>) {
    const dbClient = trx || this.db;
    return await dbClient
      .selectFrom('feedback_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async listFeedbackForTask(taskId: string, tenantId: string, trx?: Kysely<Database>) {
    const dbClient = trx || this.db;
    return await dbClient
      .selectFrom('feedback_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .execute();
  }
}
