/**
 * Which Telegram updates still belong to a request the old intake started (ADR-135).
 *
 * Every chat is owned by RequestLifecycle. An update goes to the legacy intake, in its finish-only
 * scope (services/legacy-telegram-scope.ts), only when it is about a legacy request:
 *
 * - a reply to a message that names a legacy task of the same chat (legacy drafts, notices and
 *   buttons carry the task ID; telegram-intake/replies.ts reads the reply the same way);
 * - an unlinked message in a chat whose newest request of the last 48 hours is an open legacy one,
 *   which legacy intake reads as a possible change to that design (the same window and filters as
 *   readReply's "recent task" in telegram-intake/replies.ts).
 *
 * Both reads are deleted with the legacy intake in stage 2 of the retirement.
 */
import { sql, type Database, type Kysely } from '@hawa/db';

const UUID_IN_TEXT = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const TERMINAL = ['complete', 'rejected', 'cancelled'];

/** The task ID a replied-to message names, read as legacy intake reads it (replies.ts readReply). */
export function taskIdNamedByReply(replied: unknown): string | null {
  if (!replied || typeof replied !== 'object') return null;
  const r = replied as Record<string, unknown>;
  const text = String(r.caption || r.text || '') + ' ' + (r.reply_markup ? JSON.stringify(r.reply_markup) : '');
  return UUID_IN_TEXT.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** Whether the named task is a legacy Telegram task of this chat (no request owner). */
export async function isLegacyTaskOfChat(trx: Kysely<Database>, tenantId: string, chatId: string,
  taskId: string): Promise<boolean> {
  return (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.tasks t
    JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
      AND o.command_type = 'task.created'
    WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${taskId}::uuid AND t.request_id IS NULL
      AND o.payload->>'sourcePlatform' = 'telegram' AND o.payload->>'sourceChannelId' = ${chatId}
    LIMIT 1`.execute(trx)).rows.length > 0;
}

/**
 * Whether legacy intake would read an unlinked message in this chat against an open legacy design:
 * the chat's newest request of the last 48 hours (with a client, not instruction-only) has no request
 * owner and is not finished.
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
