/**
 * What happens to a Telegram update that intake keeps failing to accept.
 *
 * The bridge advances its offset only when the handler returns, and Telegram discards everything
 * below the offset. The handler used to give up after three failures, a few seconds apart, by
 * returning quietly: the client's message was gone, and nobody was told. During a database outage
 * of more than about 15 seconds that was every message sent to the office.
 *
 * A failing update now has two ways out, and losing it is not one of them:
 *  - it is retried (the handler throws, the bridge backs off, 2, 4, 8, 16 then 30 s, and asks
 *    Telegram again, which keeps undelivered updates for 24 hours), or
 *  - after `maxAttempts` it is dead-lettered ("parked"): its id and kind, never its content, are
 *    written somewhere durable with the reason, the office is alerted, and the sender is told the
 *    office has it. Only then does the queue move on.
 *
 * Why five attempts: with the bridge's backoff they span about 30 seconds, which rides out a Core
 * restart or a deploy, while one message that can never be processed holds every other chat's
 * messages for no more than about half a minute. A database outage never dead-letters anything:
 * counting an attempt and parking both need the database, so without it the handler keeps throwing
 * and the queue waits, which is right, since nothing behind the update could be saved either.
 * Core counts attempts in Postgres (`recordFailure`, telegram-poll-state.ts), so a restart in the
 * middle carries the count on instead of starting it again.
 */
import crypto from 'node:crypto';
import { sql, withRlsContext, type Kysely, type Database } from '@hawa/db';

export interface PolledUpdate { update_id: number }

export interface PolledUpdateDispatchDeps<U extends PolledUpdate> {
  /** Hands the update to intake and returns the HTTP status. May throw on a transport failure. */
  deliver(update: U): Promise<number>;
  /**
   * Counts one more failed attempt at this update, durably, and returns the count. Must throw if it
   * could not count. Without it, attempts are counted in this process's memory.
   */
  recordFailure?(update: U, reason: string): Promise<number>;
  /** Dead-letters the update for an operator and alerts the office. Must throw if it could not be stored. */
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
  const countFailure = async (update: U, reason: string): Promise<number> => {
    if (deps.recordFailure) return deps.recordFailure(update, reason);
    const n = (attempts.get(update.update_id) || 0) + 1;
    attempts.set(update.update_id, n);
    return n;
  };

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

    let n: number;
    try {
      n = await countFailure(update, reason);
    } catch (countErr) {
      throw new Error(
        `[telegram:poll] update ${update.update_id} failed (${reason}) and the attempt could not be counted (${countErr instanceof Error ? countErr.message : String(countErr)}); will retry`
      );
    }
    if (n < maxAttempts) {
      throw new Error(`[telegram:poll] update ${update.update_id} attempt ${n}/${maxAttempts} failed (${reason}); will retry`);
    }

    try {
      await deps.park(update, `${reason} after ${n} attempts`);
    } catch (parkErr) {
      // The count stays at or above the ceiling, so the next pass tries to park again, not five more deliveries.
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

/** Which kind of update this is (`message`, `callback_query`, ...), without anything it says. */
export function telegramUpdateKind(update: PolledUpdate): string {
  return Object.keys(update).find((key) => key !== 'update_id') || 'unknown';
}

/** The chat an update came from and who sent it, for the office alert. Never the message itself. */
interface UpdateFrom { id?: number | string; first_name?: string; last_name?: string; username?: string }
interface UpdateBody { chat?: { id?: number | string }; from?: UpdateFrom }
interface UpdateParts {
  message?: UpdateBody;
  edited_message?: UpdateBody;
  channel_post?: UpdateBody;
  callback_query?: { from?: UpdateFrom; message?: UpdateBody };
}

function updateOrigin(update: PolledUpdate): { chatId?: string; sender?: string } {
  const u = update as PolledUpdate & UpdateParts;
  const body = u.message || u.edited_message || u.channel_post || u.callback_query?.message;
  const from = u.message?.from || u.edited_message?.from || u.callback_query?.from;
  const chatId = body?.chat?.id ?? from?.id;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ');
  const sender = `${name}${from?.username ? ` (@${from.username})` : ''}`.trim();
  return { chatId: chatId === undefined || chatId === null ? undefined : String(chatId), sender: sender || undefined };
}

/** The chat a dead-lettered update came from, if it names one. */
export function parkedUpdateChat(update: PolledUpdate): string | undefined {
  return updateOrigin(update).chatId;
}

/** The office alert for a dead-lettered update: who sent it and why it failed, not what it said. */
export function composeParkedUpdateAlert(update: PolledUpdate, reason: string): string {
  const { chatId, sender } = updateOrigin(update);
  return [
    '⚠️ A Telegram message to the office could not be processed and was set aside.',
    `Update ${update.update_id} (${telegramUpdateKind(update)})${chatId ? ` from chat ${chatId}` : ''}${sender ? `, sent by ${sender}` : ''}.`,
    `Reason: ${reason}.`,
    'The sender was told the office will follow up. The message itself was not stored: read it in the chat.',
  ].join('\n');
}

/** A stable uuid for the update's outbox command, whose aggregate id must be a uuid. */
function updateAggregateId(update: PolledUpdate): string {
  const h = crypto.createHash('sha256').update(`telegram-update:${update.update_id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ParkOptions {
  /** The office chat to alert; the alert is written to the outbox with the dead letter, once per update. */
  officeChatId?: string;
  /** Runs in the same transaction, after the dead letter: Core moves the stored offset past the update here. */
  alongside?: (trx: Kysely<Database>) => Promise<void>;
}

/**
 * Dead-letters an update in hawa.inbox_events, where an operator (and /health) can see it with the
 * reason. Only the update's id and kind are stored, never its text, photos or sender: the office
 * alert says who sent it and the message stays in the chat. The row, the office alert and whatever
 * `alongside` does commit together or not at all. Idempotent: parking the same update again adds
 * nothing. Throws if the row could not be written, which is what keeps the queue from moving past
 * an update that is stored nowhere.
 */
export async function parkTelegramUpdate(
  db: Kysely<Database>,
  identity: { tenantId: string; userId: string },
  update: PolledUpdate,
  reason: string,
  options: ParkOptions = {}
): Promise<void> {
  const sourceEventId = `parked-update-${update.update_id}`;
  const record = { update_id: update.update_id, kind: telegramUpdateKind(update) };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
  await withRlsContext(db, { tenantId: identity.tenantId, userId: identity.userId, role: 'operator' }, async (trx) => {
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, processing_error)
      SELECT ${identity.tenantId}::uuid, 'telegram', ${sourceEventId}, 'telegram_update_parked', ${JSON.stringify(record)}::jsonb,
        ${payloadHash}, true, ${reason.slice(0, 2000)}
      WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${identity.tenantId}::uuid
        AND source_account_id = 'telegram' AND source_event_id = ${sourceEventId})`.execute(trx);
    const office = options.officeChatId;
    // The sender's own chat already gets the notice; alerting it again would only repeat it.
    if (office && office !== parkedUpdateChat(update)) {
      const message = { text: composeParkedUpdateAlert(update, reason) };
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
        VALUES (${identity.tenantId}::uuid, 'telegram_update', ${updateAggregateId(update)}::uuid, 'notify.telegram',
          ${`notify.office:telegram-update-parked:${update.update_id}`}, ${JSON.stringify({ chatId: office, message })}::jsonb)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`.execute(trx);
    }
    if (options.alongside) await options.alongside(trx);
  });
}
