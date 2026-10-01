/**
 * Messages to the office chat. Moved unchanged from app.ts (architecture programme 1.3, SPLIT_PLAN.md
 * G4): the Canva outcome route sends them, and so does the Telegram handler, through a same-name
 * binding left in app.ts until Telegram intake moves (G9).
 */
import { SYSTEM_AUTOMATION_USER_ID, isReservedCanaryChatId } from '@hawa/contracts';
import { withRlsContext } from '@hawa/db';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';

export type OfficeAlerts = ReturnType<typeof createOfficeAlerts>;

export function createOfficeAlerts({ db, outboxRepo }: Pick<CoreContext, 'db' | 'outboxRepo'>) {
  /**
   * A message to the office chat (the first TELEGRAM_ALLOWED_USERS entry), written to the outbox like
   * every other message and sent once per key. Not sent when the office chat is the requester's own:
   * they read the requester's message already.
   */
  async function enqueueOfficeAlert(taskId: string, key: string, message: { text: string; parse_mode: 'HTML' }, requesterChat?: string): Promise<boolean> {
    const office = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean);
    // ADR-240: nothing about the nightly canary's requests reaches the office.
    const canary = isReservedCanaryChatId(requesterChat);
    if (!db || !outboxRepo || !office || office === requesterChat || canary) {
      log.warn(`[office-alert] ${key}: not sent (${!db || !outboxRepo ? 'no database' : !office ? 'no office chat configured'
        : canary ? 'the request is the nightly canary\'s' : "the office chat is the requester's own"})`);
      return false;
    }
    const outbox = outboxRepo;
    try {
      await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        outbox.enqueue({
          tenantId: DEFAULT_TENANT_ID,
          aggregateType: 'task',
          aggregateId: taskId,
          commandType: 'notify.telegram',
          idempotencyKey: `notify.office:${key}`,
          payload: { chatId: office, taskId, message },
        }, trx));
      return true;
    } catch (err) {
      // The key is unique: a second alert for the same thing ends here, which is the point.
      log.warn(`[office-alert] ${key}: not written (${(err as Error)?.message || err})`);
      return false;
    }
  }

  return { enqueueOfficeAlert };
}
