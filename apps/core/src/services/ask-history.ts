/**
 * What was asked of a design across its rounds of changes. Moved unchanged from app.ts (architecture
 * programme 1.3, SPLIT_PLAN.md G4): the Canva outcome route reads it, and so does the Telegram
 * handler, through a same-name binding left in app.ts until Telegram intake moves (G9).
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import type { AskRecord } from './requester-actions.js';

export type AskHistory = ReturnType<typeof createAskHistory>;

export function createAskHistory({ db }: Pick<CoreContext, 'db'>) {
  /**
   * What was asked of a design and of every design it was a change to, oldest first, from the runs'
   * records (edit.stage.ts AskOutcome), with how many rounds of changes it has had.
   */
  async function askHistory(taskId: string): Promise<{ asks: AskRecord[]; rounds: number }> {
    if (!db || !isValidUuid(taskId)) return { asks: [], rounds: 0 };
    const rows = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ asks: unknown; depth: number; reformat: boolean }>`WITH RECURSIVE chain(id, depth) AS (
          SELECT ${taskId}::uuid, 0
          UNION ALL
          SELECT (o.payload->'studioOptions'->>'parentTaskId')::uuid, chain.depth + 1
          FROM chain JOIN hawa.outbox_commands o ON o.aggregate_id = chain.id AND o.command_type = 'task.created'
          WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid
            AND o.payload->'studioOptions'->>'parentTaskId' ~ '^[0-9a-f-]{36}$' AND chain.depth < 12
        )
        SELECT r.stages->'directed'->'asks' AS asks, chain.depth,
          EXISTS (SELECT 1 FROM hawa.outbox_commands f WHERE f.aggregate_id = chain.id AND f.command_type = 'task.created'
            AND COALESCE(f.payload->'studioOptions'->>'reformat', '') <> '') AS reformat
        FROM chain
        LEFT JOIN hawa.design_studio_runs r ON r.task_id = chain.id AND r.tenant_id = ${DEFAULT_TENANT_ID}::uuid
        ORDER BY chain.depth DESC, r.created_at`.execute(trx)).rows);
    const asks: AskRecord[] = [];
    for (const row of rows) {
      for (const a of Array.isArray(row.asks) ? (row.asks as Array<Record<string, unknown>>) : []) {
        if (typeof a?.ask === 'string' && a.ask.trim()) asks.push({ ask: a.ask.trim(), status: String(a.status || ''), ...(typeof a.reason === 'string' && a.reason ? { reason: a.reason } : {}) });
      }
    }
    // A round is each change in the chain below the first design; another size of a design is not one.
    const deepest = rows.reduce((m, r) => Math.max(m, Number(r.depth) || 0), 0);
    const changes = new Set(rows.filter((r) => Number(r.depth) < deepest && !r.reformat).map((r) => Number(r.depth)));
    return { asks, rounds: changes.size };
  }

  return { askHistory };
}
