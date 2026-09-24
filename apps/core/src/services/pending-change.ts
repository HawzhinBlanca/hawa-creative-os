/**
 * A change the client asked for on a design, which approval and delivery wait for. Moved from app.ts
 * (architecture programme 1.3, SPLIT_PLAN.md F6): the decisions route and delivery both use it.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { LIVE_RUN } from './live-run.js';

/**
 * The newest change the client asked for on this design that is not cancelled, rejected or
 * failed (another size is not a change), or undefined; approval and delivery wait for it.
 */
export async function pendingChangeOf(db: Kysely<Database>, tenantId: string, taskId: string, after?: Date): Promise<{ id: string; state: string; live: boolean } | undefined> {
  return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ id: string; state: string; live: boolean }>`SELECT t.id, t.state,
        EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id AND ${LIVE_RUN}) AS live
      FROM hawa.tasks t
      JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
      WHERE t.tenant_id = ${tenantId}::uuid
        AND o.payload->'studioOptions'->>'parentTaskId' = ${taskId}
        AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''
        AND t.state NOT IN ('cancelled', 'rejected', 'failed_operator')
        ${after ? sql`AND t.created_at > ${after.toISOString()}::timestamptz` : sql``}
      ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
}

/** Why approval or delivery waits for `newer`, in words for the office. */
export function pendingChangeWords(newer: { id: string; state: string; live: boolean }): string {
  if (newer.live) return `A change to this design is still being made (task ${newer.id}). Approve its draft when it arrives.`;
  if (['human_review', 'approved', 'publishing', 'complete'].includes(newer.state)) {
    return `This design was changed at the client's request. Approve the newer version instead (task ${newer.id}).`;
  }
  if (newer.state === 'paused') {
    return `The client was asked a question about the change they want (task ${newer.id}) and has not answered yet. Approve the changed design once it is made.`;
  }
  return `The client asked for a change (task ${newer.id}) that has not been made yet. Make it, or cancel that task, before approving this version.`;
}
