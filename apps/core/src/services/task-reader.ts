/**
 * Reads a task for a route: Postgres's row, or without a database the no-database store
 * (services/no-database-store.ts). Moved from app.ts (architecture programme 1.3, SPLIT_PLAN.md F3),
 * where it was shared by eight route groups.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { withRlsContext, toApiTaskStatus, sql, type TaskRepository } from '@hawa/db';
import { isValidUuid, TaskStoreUnavailableError } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';

export type TaskReader = ReturnType<typeof createTaskReader>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** A row of hawa.tasks as the repository reads it. */
export type TaskRow = NonNullable<Awaited<ReturnType<TaskRepository['findById']>>>;

/** What Postgres records about a task besides its row, read with it (see resolveTaskWithFallback). */
export interface TaskRecord {
  /** The data of the task.created event. */
  created?: unknown;
  /** The newest approval of the task, and whether a later revision invalidated it. */
  approval?: { id: string; design_revision_id: string; decision_payload: unknown; created_at: Date | string; invalidated: boolean } | null;
  /** How many times a reviewer sent the task back for changes. */
  revisionRequests?: number;
}

/**
 * A task as routes use it, from its row and what Postgres records about it. The copy the client
 * sent is in its task.created event; without it a Core that had not created the task in its own
 * memory drew a KAAE design as "no copy" and refused (COPY_REQUIRED). An absent field stays absent:
 * no title stands in for a headline. The approval and the count of revision requests were kept on
 * the in-memory task, so after a restart delivery no longer knew which revision an approval named
 * and the two-round repair budget started again from zero.
 */
export function taskFromRows(row: TaskRow, record: TaskRecord = {}) {
  const data = asObject(record.created);
  const payload = data.payload && typeof data.payload === 'object' ? asObject(data.payload) : data;
  const body = asObject(payload.body);
  const pick = (field: string) => text(payload[field]) ?? text(body[field]);
  return {
    id: row.id, tenantId: row.tenant_id, clientId: row.client_id, projectId: row.project_id,
    status: toApiTaskStatus(row.state || 'received'), state: row.state, priority: row.priority,
    title: row.title, description: row.description, version: Number(row.version), // bigint: pg returns a string, and version checks compare with ===
    latestRevisionId: row.current_design_revision_id || undefined,
    headlineEn: pick('headlineEn'), headlineCkb: pick('headlineCkb'), copyEn: pick('copyEn'), copyCkb: pick('copyCkb'),
    payloadText: pick('payloadText') ?? pick('rawRequestText'),
    sourcePlatform: pick('sourcePlatform'), sourceEventId: pick('sourceEventId'), sourceChannelId: pick('sourceChannelId'),
    clientDnaVersion: payload.clientDnaVersion ?? body.clientDnaVersion,
    latestApproval: record.approval ? approvalView(row, record.approval) : undefined,
    repairCount: record.revisionRequests ?? 0,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** An approval in the shape the decision route answers with and delivery checks. */
function approvalView(row: TaskRow, approval: NonNullable<TaskRecord['approval']>) {
  const payload = asObject(approval.decision_payload);
  return {
    decisionId: approval.id,
    taskId: row.id,
    designRevisionId: approval.design_revision_id,
    decision: 'approved' as const,
    qcReportHash: text(payload.qcReportHash),
    exportHashes: Array.isArray(payload.exportHashes) ? payload.exportHashes : [],
    pinnedExports: Array.isArray(payload.pinnedExports) ? payload.pinnedExports : undefined,
    canvaBindingId: payload.canvaBindingId ?? null,
    canvaBindingVersion: payload.canvaBindingVersion ?? null,
    tenantId: row.tenant_id,
    clientId: text(payload.clientId) ?? row.client_id,
    decidedAt: approval.created_at instanceof Date ? approval.created_at.toISOString() : String(approval.created_at),
    invalidated: approval.invalidated,
  };
}

export function createTaskReader({ db, taskRepo, tasks }: Pick<CoreContext, 'db' | 'taskRepo' | 'tasks'>) {
  // With a database the task is read from Postgres on every call. This process used to keep a copy
  // of each task it had seen and refresh only its status, so its copy answered for everything else
  // (client, copy, preview) after another process had changed them.
  //
  // `strict` is for a handler about to act on the task's status (deliver, publish, approve, route,
  // control, a revision): when the database is connected and cannot be read, it throws
  // TaskStoreUnavailableError (answered 503) instead of acting on a status nobody read.
  async function resolveTaskWithFallback(taskId: string, opts: { strict?: boolean } = {}): Promise<any | undefined> {
    if (!db || !taskRepo) return tasks.get(taskId);
    if (!isValidUuid(taskId)) return undefined;
    try {
      const found = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
        const row = await taskRepo.findById(taskId, DEFAULT_TENANT_ID, trx);
        if (!row) return undefined;
        // hawa.approvals is append-only: a later revision records the approval's invalidation as an
        // approval.invalidated event (revision.repository.ts).
        const more = (await sql<{ created: unknown; approval: NonNullable<TaskRecord['approval']> | null; revision_requests: number }>`
          SELECT
            (SELECT e.data FROM hawa.task_events e
              WHERE e.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND e.task_id = ${taskId}::uuid AND e.event_type = 'task.created'
              ORDER BY e.aggregate_version LIMIT 1) AS created,
            (SELECT json_build_object('id', a.id, 'design_revision_id', a.design_revision_id, 'decision_payload', a.decision_payload,
                'created_at', a.created_at,
                'invalidated', EXISTS (SELECT 1 FROM hawa.task_events i
                  WHERE i.tenant_id = a.tenant_id AND i.task_id = a.task_id AND i.event_type = 'approval.invalidated'
                    AND i.data->>'invalidatedApprovalId' = a.id::text))
              FROM hawa.approvals a
              WHERE a.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND a.task_id = ${taskId}::uuid AND a.decision = 'approved'
              ORDER BY a.created_at DESC LIMIT 1) AS approval,
            (SELECT count(*)::int FROM hawa.approvals r
              WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.task_id = ${taskId}::uuid AND r.decision = 'revision_requested') AS revision_requests
        `.execute(trx)).rows[0];
        return { row, record: { created: more?.created, approval: more?.approval, revisionRequests: Number(more?.revision_requests ?? 0) } };
      });
      return found ? taskFromRows(found.row, found.record) : undefined;
    } catch (err) {
      if (opts.strict) throw new TaskStoreUnavailableError(taskId, err);
      log.warn('[core:task_read] PostgreSQL lookup failed:', err);
      return undefined;
    }
  }

  /** The task as Postgres has it now, for a handler about to act on its status. See resolveTaskWithFallback. */
  const readCurrentTask = (taskId: string) => resolveTaskWithFallback(taskId, { strict: true });

  return { resolveTaskWithFallback, readCurrentTask };
}
