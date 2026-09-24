/**
 * What a Telegram update, and the chat it came from, already did, read from Postgres: whether this
 * update saved something before, where a task's design is, which design a reply is about, and
 * whether a change or a request of the chat is still being made. Moved unchanged from app.ts
 * (architecture programme 1.3, SPLIT_PLAN.md G9); they need nothing but the database.
 */
import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { isValidUuid } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { LIVE_RUN } from '../live-run.js';

export type TelegramUpdateState = ReturnType<typeof createTelegramUpdateState>;

export function createTelegramUpdateState({ db }: Pick<CoreContext, 'db'>) {
  /**
   * Whether this Telegram update already saved something: a request or revision (persistChatIntake
   * keys it `<chat>:<update>` and `<chat>:<update>_<suffix>`), an answered question, a rule, a PDF
   * being read. Read before any paid call.
   */
  async function telegramUpdateHandled(chat: string, updateId: string): Promise<{ taskId?: string } | false> {
    if (!db) return false;
    const key = `${chat}:${updateId}`;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; task_id: string | null }>`SELECT e.id,
          (SELECT o.aggregate_id FROM hawa.outbox_commands o WHERE o.tenant_id = e.tenant_id AND o.command_type = 'task.created'
            AND o.idempotency_key = ${`chat:telegram:${key}`} LIMIT 1) AS task_id
        FROM hawa.inbox_events e
        WHERE e.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND e.source_account_id = 'telegram'
          AND (e.source_event_id = ${key} OR e.source_event_id LIKE ${`${key}\\_%`})
        LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.task_id || undefined } : false;
  }

  /** Records a side effect that leaves no task behind (a rule saved, a rule removed, a PDF read). */
  async function markTelegramUpdateHandled(chat: string, updateId: string, kind: string, payload: unknown): Promise<void> {
    if (!db || !chat || chat === 'tg_default' || !updateId) return;
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : { value: payload };
    try {
      await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
        await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
          SELECT ${DEFAULT_TENANT_ID}::uuid, 'telegram', ${`${chat}:${updateId}`}, ${kind}, ${JSON.stringify(record)}::jsonb,
            ${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}, true
          WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid
            AND source_account_id = 'telegram' AND source_event_id = ${`${chat}:${updateId}`})`.execute(trx);
      });
    } catch (err) {
      log.warn(`[TelegramIngress] Could not record update ${updateId} as handled (${kind}):`, err);
    }
  }

  /** Where a task's design is: being made, finished (a draft exists), failed, or never started. */
  async function taskDesignState(taskId: string): Promise<'running' | 'finished' | 'failed' | 'none'> {
    if (!db || !isValidUuid(taskId)) return 'none';
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ live: boolean; finished: boolean; runs: number }>`SELECT
          bool_or(${LIVE_RUN}) AS live,
          bool_or(r.status IN ('transferred', 'degraded')) AS finished,
          count(*)::int AS runs
        FROM hawa.design_studio_runs r WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.task_id = ${taskId}::uuid`.execute(trx)).rows[0]);
    if (!row || !row.runs) return 'none';
    if (row.live) return 'running';
    return row.finished ? 'finished' : 'failed';
  }

  /**
   * What a typed reply to `taskId`'s draft is about: the chat the design was made for, and its newest
   * version (a change of a change, followed to the last). Buttons already refuse an old draft and a
   * design from another chat; a typed reply did neither, so a reply to an older draft was made again
   * from it, losing the change in between, and a draft forwarded to another chat could be revised
   * from there (review of 2026-09-24). Versions follow the buttons' rule: not reformats, and not ones
   * cancelled, rejected, failed or paused on a question. Only finished versions (a design made, or its
   * draft sent) are followed: a reply that reaches a version still being made stays on the one before,
   * so that "your previous change is still being made" still answers it. Following into an unfinished
   * version started a second paid change on top of one with no design yet.
   */
  async function replyDesign(taskId: string): Promise<{ chat: string | null; newest: string }> {
    return withRlsContext(db!, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const own = await sql<{ chat: string | null }>`SELECT o.payload->>'sourceChannelId' AS chat FROM hawa.outbox_commands o
        WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND o.aggregate_id = ${taskId}::uuid AND o.command_type = 'task.created' LIMIT 1`.execute(trx);
      let newest = taskId;
      for (let hop = 0; hop < 50; hop++) {
        const next = (await sql<{ id: string; finished: boolean }>`SELECT ct.id::text AS id,
              (EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.tenant_id = ct.tenant_id AND r.task_id = ct.id AND r.status IN ('transferred', 'degraded'))
               OR EXISTS (SELECT 1 FROM hawa.outbox_commands n WHERE n.tenant_id = ct.tenant_id AND n.aggregate_id = ct.id
                            AND n.command_type = 'notify.telegram' AND n.payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW')) AS finished
            FROM hawa.tasks ct
            JOIN hawa.outbox_commands co ON co.aggregate_id = ct.id AND co.command_type = 'task.created'
            WHERE ct.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND co.payload->'studioOptions'->>'parentTaskId' = ${newest}
              AND ct.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
              AND COALESCE(co.payload->'studioOptions'->>'reformat', '') = ''
            ORDER BY ct.created_at DESC LIMIT 1`.execute(trx)).rows[0];
        if (!next || next.id === newest || !next.finished) break;
        newest = next.id;
      }
      return { chat: own.rows[0]?.chat ?? null, newest };
    });
  }

  /** A revision of this design that is still being made, if any. */
  async function revisionInFlight(parentTaskId: string): Promise<{ taskId: string; title: string } | null> {
    if (!db || !isValidUuid(parentTaskId)) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; title: string | null }>`SELECT t.id, t.title FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid
          AND o.payload->'studioOptions'->>'parentTaskId' = ${parentTaskId}
          AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''
          AND t.created_at > now() - interval '2 hours'
          AND (NOT EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id)
               AND t.created_at > now() - interval '5 minutes'
               -- A change with no run yet is on its way only if one will start: one the daily cap
               -- declined never runs, and the next change was dropped as "still being made".
               AND o.payload->>'autoGenerate' = 'true'
            OR EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id AND ${LIVE_RUN}))
        ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.id, title: row.title || 'your change' } : null;
  }

  /** The request this chat made in the last half hour whose design is being made, if any. */
  async function studioRunInProgressForChat(chat: string): Promise<{ taskId: string; title: string } | null> {
    if (!db || !chat || chat === 'tg_default') return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; title: string | null }>`SELECT t.id, t.title FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid
          AND o.payload->>'sourceChannelId' = ${chat}
          AND t.created_at > now() - interval '30 minutes'
          AND t.client_id IS NOT NULL
          AND COALESCE(o.payload->>'isInstructionOnly', 'false') != 'true'
          AND EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id AND ${LIVE_RUN})
        ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.id, title: row.title || 'your request' } : null;
  }

  return { telegramUpdateHandled, markTelegramUpdateHandled, taskDesignState, replyDesign, revisionInFlight, studioRunInProgressForChat };
}
