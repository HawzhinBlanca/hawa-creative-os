/**
 * What happens to a Telegram update that intake keeps failing to accept: it is dead-lettered
 * ("parked"). Its id and kind, never its content, are written somewhere durable with the reason, the
 * office is alerted, and the sender is told the office has it.
 *
 * The worker's ChatInbox decides when (after INTAKE_ATTEMPTS answers that were not final, counted in
 * Restate's journal) and calls Core's POST /v1/internal/telegram/park, which uses parkTelegramUpdate.
 * Core's own poller, which counted attempts here (createPolledUpdateHandler), was removed with the
 * rest of that poller by stage 2 of ADR-135: the worker is the only poller.
 */
import crypto from 'node:crypto';
import { sql, withRlsContext, type Kysely, type Database } from '@hawa/db';
import { isReservedCanaryChatId } from '@hawa/contracts';
import { INBOX_MESSAGES } from '@hawa/integrations';

export interface PolledUpdate { update_id: number }

/** What the sender of a parked update hears, in English (the park route answers in their language: ADR-145). */
export const PARKED_UPDATE_NOTICE = INBOX_MESSAGES.couldNotRead.en;

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
  /**
   * Every office member to alert (ADR-155 section 6), after `officeChatId`: the first keeps the alert's
   * key, the others add their chat, so an alert written before is never written again.
   */
  officeChatIds?: readonly string[];
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
    // The sender's own chat already gets the notice; alerting it again would only repeat it. The nightly
    // canary's chat (ADR-240) alerts nobody: the canary reports its own failures to the operator.
    const offices = isReservedCanaryChatId(parkedUpdateChat(update)) ? []
      : [...new Set([...(options.officeChatId ? [options.officeChatId] : []), ...(options.officeChatIds ?? [])])]
        .filter((office) => office && office !== parkedUpdateChat(update));
    for (const [index, office] of offices.entries()) {
      const message = { text: composeParkedUpdateAlert(update, reason) };
      const key = `notify.office:telegram-update-parked:${update.update_id}${index === 0 ? '' : `:${office}`}`;
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
        VALUES (${identity.tenantId}::uuid, 'telegram_update', ${updateAggregateId(update)}::uuid, 'notify.telegram',
          ${key}, ${JSON.stringify({ chatId: office, message })}::jsonb)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`.execute(trx);
    }
    if (options.alongside) await options.alongside(trx);
  });
}
