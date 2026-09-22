/**
 * What happens to a Telegram update that intake keeps failing to accept.
 *
 * The bridge advances its offset only when the handler returns, and Telegram discards everything
 * below the offset. The handler used to give up after three failures, a few seconds apart, by
 * returning quietly: the client's message was gone, and nobody was told. During a database outage
 * of more than about 15 seconds that was every message sent to the office.
 *
 * A failing update now has two ways out, and losing it is not one of them:
 *  - it is retried (the handler throws, the bridge backs off to 30 s and asks Telegram again, which
 *    keeps undelivered updates for 24 hours), or
 *  - after `maxAttempts` it is parked: written somewhere durable with the reason, and the sender
 *    is told the office has it but could not process it. Only then does the queue move on.
 *
 * If parking fails too, the fault is the system and not this update, so the handler keeps throwing
 * and the queue waits. Nothing behind it could be processed anyway.
 */
import crypto from 'node:crypto';
import { withRlsContext, type Kysely, type Database } from '@hawa/db';

export interface PolledUpdate { update_id: number }

export interface PolledUpdateDispatchDeps<U extends PolledUpdate> {
  /** Hands the update to intake and returns the HTTP status. May throw on a transport failure. */
  deliver(update: U): Promise<number>;
  /** Stores the update durably for an operator. Must throw if it could not be stored. */
  park(update: U, reason: string): Promise<void>;
  /** Tells the sender. Best effort: a failure here never blocks the queue. */
  notifySender(update: U, text: string): Promise<void>;
  maxAttempts?: number;
  log?: Pick<Console, 'error' | 'warn'>;
}

export const POLLED_UPDATE_MAX_ATTEMPTS = 5;
export const PARKED_UPDATE_NOTICE =
  'We received your message but could not process it automatically. The office has been alerted and will follow up with you.';

/** 5xx, 429 and 408 may succeed later. Any other 4xx is intake's deliberate answer. */
const retryable = (status: number) => status >= 500 || status === 429 || status === 408;

export function createPolledUpdateHandler<U extends PolledUpdate>(deps: PolledUpdateDispatchDeps<U>) {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? POLLED_UPDATE_MAX_ATTEMPTS);
  const log = deps.log ?? console;
  const attempts = new Map<number, number>();

  return async function handle(update: U): Promise<void> {
    let reason: string;
    try {
      const status = await deps.deliver(update);
      if (!retryable(status)) {
        if (status >= 400) log.warn(`[telegram:poll] update ${update.update_id} rejected by intake with HTTP ${status}`);
        attempts.delete(update.update_id);
        return;
      }
      reason = `intake answered HTTP ${status}`;
    } catch (err) {
      reason = `intake unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }

    const n = (attempts.get(update.update_id) || 0) + 1;
    attempts.set(update.update_id, n);
    if (n < maxAttempts) {
      throw new Error(`[telegram:poll] update ${update.update_id} attempt ${n}/${maxAttempts} failed (${reason}); will retry`);
    }

    try {
      await deps.park(update, `${reason} after ${n} attempts`);
    } catch (parkErr) {
      // Keep the count at the ceiling so the next pass tries to park again, not five more deliveries.
      attempts.set(update.update_id, maxAttempts - 1);
      throw new Error(
        `[telegram:poll] update ${update.update_id} could not be delivered (${reason}) or parked (${parkErr instanceof Error ? parkErr.message : String(parkErr)}); intake is blocked until one succeeds`
      );
    }
    attempts.delete(update.update_id);
    log.error(`[telegram:poll] update ${update.update_id} parked for an operator after ${n} attempts: ${reason}`);
    await deps.notifySender(update, PARKED_UPDATE_NOTICE).catch((err: unknown) => {
      log.warn(`[telegram:poll] could not tell the sender that update ${update.update_id} was parked: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

/**
 * Parks an update in hawa.inbox_events, where an operator can see it with the reason. Idempotent:
 * parking the same update again leaves the first row. Throws if the row could not be written, which
 * is what keeps the queue from moving past an update that is stored nowhere.
 */
export async function parkTelegramUpdate(
  db: Kysely<Database>,
  identity: { tenantId: string; userId: string },
  update: PolledUpdate,
  reason: string
): Promise<void> {
  const sourceEventId = `parked-update-${update.update_id}`;
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex');
  await withRlsContext(db, { tenantId: identity.tenantId, userId: identity.userId, role: 'operator' }, async (trx) => {
    const existing = await trx.selectFrom('inbox_events').select('id')
      .where('tenant_id', '=', identity.tenantId).where('source_account_id', '=', 'telegram')
      .where('source_event_id', '=', sourceEventId).executeTakeFirst();
    if (existing) return;
    await trx.insertInto('inbox_events').values({
      tenant_id: identity.tenantId, source_account_id: 'telegram', source_event_id: sourceEventId,
      event_kind: 'telegram_update_parked', payload: JSON.parse(JSON.stringify(update)) as Record<string, unknown>, payload_hash: payloadHash, verified: true,
      processing_error: reason.slice(0, 2000),
    }).execute();
  });
}
