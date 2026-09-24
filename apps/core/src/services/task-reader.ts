/**
 * Reads a task for a route: this process's copy refreshed from Postgres, or Postgres's row when this
 * process has none. Moved unchanged from app.ts (architecture programme 1.3, SPLIT_PLAN.md F3), where
 * it was shared by eight route groups.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { withRlsContext, toApiTaskStatus } from '@hawa/db';
import { isValidUuid, TaskStoreUnavailableError } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';

export function createTaskReader({ db, taskRepo, tasks }: Pick<CoreContext, 'db' | 'taskRepo' | 'tasks'>) {
  // Handlers that still read the in-memory task map fall back to PostgreSQL after a restart and
  // hydrate the map, so a persisted task never answers 404 only because this process is new.
  //
  // `strict` is for a handler about to act on the task's status (deliver, publish, approve, route,
  // control, a revision): when the database is connected and cannot be read, it throws
  // TaskStoreUnavailableError (answered 503) instead of acting on the status this process last saw.
  // Those handlers used to read `tasks.get(id) || resolveTaskWithFallback(id)`, so a cached task was
  // never refreshed at all: a status changed by the worker, another process or an operator in
  // Postgres was ignored, and a task already delivered or sent back could be delivered again.
  async function resolveTaskWithFallback(taskId: string, opts: { strict?: boolean } = {}): Promise<any | undefined> {
    const cached = tasks.get(taskId);
    if (cached) {
      if (db && taskRepo && isValidUuid(taskId)) {
        try {
          const dbTask: any = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
            (trx) => taskRepo.findById(taskId, DEFAULT_TENANT_ID, trx));
          if (dbTask) {
            cached.status = toApiTaskStatus(dbTask.state || 'received');
            cached.state = dbTask.state;
            cached.version = Number(dbTask.version); // bigint: pg returns a string, and version checks compare with ===
            cached.latestRevisionId = dbTask.current_design_revision_id || cached.latestRevisionId;
          }
        } catch (err) {
          if (opts.strict) throw new TaskStoreUnavailableError(taskId, err);
          log.warn('[core:task_hydrate] PostgreSQL sync failed:', err);
        }
      }
      return cached;
    }
    if (!db || !taskRepo || !isValidUuid(taskId)) return undefined;
    try {
      const dbTask: any = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
        (trx) => taskRepo.findById(taskId, DEFAULT_TENANT_ID, trx));
      if (!dbTask) return undefined;
      const hydrated: any = {
        id: dbTask.id, tenantId: dbTask.tenant_id, clientId: dbTask.client_id, projectId: dbTask.project_id,
        status: toApiTaskStatus(dbTask.state || 'received'), state: dbTask.state, priority: dbTask.priority,
        title: dbTask.title, description: dbTask.description, version: Number(dbTask.version),
        latestRevisionId: dbTask.current_design_revision_id || undefined,
        createdAt: dbTask.created_at, updatedAt: dbTask.updated_at,
      };
      tasks.set(taskId, hydrated);
      return hydrated;
    } catch (err) {
      if (opts.strict) throw new TaskStoreUnavailableError(taskId, err);
      log.warn('[core:task_hydrate] PostgreSQL lookup failed:', err);
      return undefined;
    }
  }

  /** The task as Postgres has it now, for a handler about to act on its status. See resolveTaskWithFallback. */
  const readCurrentTask = (taskId: string) => resolveTaskWithFallback(taskId, { strict: true });

  return { resolveTaskWithFallback, readCurrentTask };
}
