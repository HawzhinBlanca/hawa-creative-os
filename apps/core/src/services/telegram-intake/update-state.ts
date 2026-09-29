/**
 * Whether a Telegram update already saved something, read from Postgres. What is left of the old
 * intake's update state (ADR-135 stage 2 deleted the readers that used the rest): the lifecycle
 * intake and its source intake ask it before doing anything with an update.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';

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

  return { telegramUpdateHandled };
}
