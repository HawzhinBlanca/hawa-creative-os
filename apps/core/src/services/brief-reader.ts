/**
 * A task's brief as Postgres holds it (hawa.design_briefs, written by POST /tasks/:taskId/briefs).
 * Routes read it here since the cleanup step of the app.ts split (architecture programme 1.3): they
 * read the brief this process had kept in memory, so another Core, or this one after a restart,
 * designed and checked the task against a brief made up from its title.
 */
import type { DesignBrief } from '@hawa/domain';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';

/** The newest brief saved for the task, or undefined when none was. Throws when Postgres cannot answer. */
export async function readTaskBrief(
  db: Kysely<Database>,
  scope: { tenantId: string; userId?: string; role?: string },
  taskId: string
): Promise<DesignBrief | undefined> {
  if (!isValidUuid(taskId)) return undefined;
  const row = await withRlsContext(db, scope, async (trx) =>
    (await sql<{ brief: unknown }>`SELECT brief FROM hawa.design_briefs
      WHERE tenant_id = ${scope.tenantId}::uuid AND task_id = ${taskId}::uuid
      ORDER BY version DESC, created_at DESC LIMIT 1`.execute(trx)).rows[0]);
  const brief = typeof row?.brief === 'string' ? JSON.parse(row.brief) : row?.brief;
  return brief && typeof brief === 'object' ? (brief as DesignBrief) : undefined;
}
