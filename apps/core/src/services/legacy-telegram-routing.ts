/**
 * Which Telegram updates still belong to a request the old intake started (ADR-135, ADR-136).
 *
 * Every chat is owned by RequestLifecycle. An update goes to the legacy intake, in its finish-only
 * scope (services/legacy-telegram-scope.ts), only when it is about a legacy request. A legacy task is
 * a Telegram task RequestLifecycle does not own (`tasks.request_id` is null), whatever its pin.
 *
 * Two reads, one for each place intake asks (routes/lifecycle-internal.routes.ts):
 *
 * - `legacyOwnedUpdate`, before any lifecycle routing: a button press, or a reply about a legacy
 *   design (ADR-136's rule, kept because its tests and the chaos scenario R10.H1 cover the replies
 *   ADR-135's first reading missed: to a delivered file and to a prompt that names no task).
 * - `newestRecentRequestIsOpenLegacy`, for an unlinked message once no lifecycle request waits:
 *   legacy intake reads such a message as a possible change to the chat's newest open design of the
 *   last 48 hours (ADR-135's rule, replacing ADR-136's "any Core task of the last 48 hours", which
 *   sent the brief to legacy intake to start a new Core task).
 *
 * Both are deleted with the legacy intake's finishing readers (stage 2c of the retirement,
 * plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT.md).
 */
import { sql, type Database, type Kysely } from '@hawa/db';

const TERMINAL = ['complete', 'rejected', 'cancelled'];
const UUID_IN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Why an update belongs to a legacy design. */
export type LegacyOwnedReason = 'button' | 'reply-names-legacy-task' | 'reply-to-legacy-send' | 'reply-in-legacy-chat';

/**
 * An update that acts on a design the old intake started (ADR-052, ADR-059: existing Core-owned tasks
 * remain on legacy intake; ADR-136):
 *
 *  - A button press: lifecycle notices carry no buttons, so every callback query is a legacy one.
 *  - A reply that names a legacy task of this chat, as legacy intake reads a reply (the task ID in the
 *    quoted message's text, caption or buttons).
 *  - A reply to a message the outbox sent for a legacy task of this chat (a delivered file or its
 *    notice), found by the Telegram message ID of its send mark.
 *  - A reply to anything else in a chat with legacy history and no lifecycle request at all: there is
 *    no lifecycle request it could be a stale reply to (a change prompt, a clarification question).
 * Null otherwise; a reply to a lifecycle message, and `/new`, keep the lifecycle's routing.
 */
export async function legacyOwnedUpdate(trx: Kysely<Database>, tenantId: string, chatId: string,
  update: Record<string, unknown>): Promise<LegacyOwnedReason | null> {
  if (update.callback_query && typeof update.callback_query === 'object') return 'button';
  const message = update.message as Record<string, unknown> | undefined;
  const replied = message?.reply_to_message as Record<string, unknown> | undefined;
  if (!message || !replied || typeof replied !== 'object') return null;
  const words = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
  if (/^\/new(?:@\w+)?(?:\s|$)/i.test(words.trim())) return null;
  const replyId = Number.isSafeInteger(replied.message_id) && Number(replied.message_id) > 0 ? String(replied.message_id) : null;
  const quoted = `${typeof replied.text === 'string' ? replied.text : ''} ${typeof replied.caption === 'string' ? replied.caption : ''} ${
    replied.reply_markup ? JSON.stringify(replied.reply_markup) : ''}`;
  const named = [...new Set([...quoted.matchAll(UUID_IN)].map((m) => m[1].toLowerCase()))].slice(0, 5);
  if (named.length) {
    const hit = (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.tasks t
      JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id AND o.command_type = 'task.created'
      WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ANY(${named}::uuid[]) AND t.request_id IS NULL
        AND o.payload->>'sourceChannelId' = ${chatId} LIMIT 1`.execute(trx)).rows;
    if (hit.length) return 'reply-names-legacy-task';
  }
  if (replyId) {
    // Outbox send marks are keyed `<command id>:<step>`; lifecycle marks `lc:<request>:…` never name a legacy task.
    const sent = (await sql<{ one: number }>`WITH marks AS (
        SELECT CASE WHEN split_part(e.source_event_id, ':', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN split_part(e.source_event_id, ':', 1)::uuid END AS command_id
        FROM hawa.inbox_events e
        WHERE e.tenant_id = ${tenantId}::uuid AND e.source_account_id = 'telegram_delivery'
          AND e.event_kind IN ('telegram_message_sent', 'telegram_document_sent')
          AND e.payload->>'messageId' = ${replyId})
      SELECT 1 AS one FROM marks m
      JOIN hawa.outbox_commands c ON c.tenant_id = ${tenantId}::uuid AND c.id = m.command_id
      JOIN hawa.tasks t ON t.tenant_id = c.tenant_id AND t.id = c.aggregate_id
      JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id AND o.command_type = 'task.created'
      WHERE t.request_id IS NULL AND o.payload->>'sourceChannelId' = ${chatId} LIMIT 1`.execute(trx)).rows;
    if (sent.length) return 'reply-to-legacy-send';
  }
  const [chat] = (await sql<{ legacy: boolean; lifecycle: boolean }>`SELECT
      EXISTS (SELECT 1 FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id
          AND o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${tenantId}::uuid AND o.payload->>'sourceChannelId' = ${chatId}
          AND t.request_id IS NULL) AS legacy,
      EXISTS (SELECT 1 FROM hawa.requests r WHERE r.tenant_id = ${tenantId}::uuid
        AND r.chat_id = ${chatId} AND r.owner = 'restate') AS lifecycle`.execute(trx)).rows;
  return chat?.legacy && !chat.lifecycle ? 'reply-in-legacy-chat' : null;
}

/**
 * Whether legacy intake would read an unlinked message in this chat against an open legacy design:
 * the chat's newest request of the last 48 hours (with a client, not instruction-only) has no request
 * owner and is not finished (the same window and filters as readReply's "recent task" in
 * telegram-intake/replies.ts).
 */
export async function newestRecentRequestIsOpenLegacy(trx: Kysely<Database>, tenantId: string,
  chatId: string): Promise<boolean> {
  const newest = (await sql<{ request_id: string | null; state: string }>`SELECT t.request_id::text AS request_id,
      t.state::text AS state
    FROM hawa.tasks t
    JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
      AND o.command_type = 'task.created'
    WHERE t.tenant_id = ${tenantId}::uuid AND o.payload->>'sourceChannelId' = ${chatId}
      AND t.created_at > now() - interval '48 hours'
      AND t.client_id IS NOT NULL
      AND COALESCE(o.payload->>'isInstructionOnly', 'false') != 'true'
    ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0];
  return Boolean(newest) && newest.request_id === null && !TERMINAL.includes(newest.state);
}
