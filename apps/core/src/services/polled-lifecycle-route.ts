/**
 * Core's own Telegram poller and the requests RequestLifecycle owns (ADR-136).
 *
 * Only ChatInbox reaches RequestLifecycle. Rolling the poller back to Core (HAWA_TELEGRAM_POLLER=core)
 * used to send every update to legacy intake, including a requester's reply to a lifecycle request
 * that was waiting for it: legacy intake queued it as a new Core task in the Desk, and the request
 * kept waiting for a reply it would never get (R10.K1 on the chaos stack, 2026-09-28). ChatInbox keeps a chat in lifecycle mode once its first
 * request opens (apps/worker/src/lifecycle/chat-inbox.ts); Core's poller now keeps the same rule: an
 * update from a chat with a lifecycle-owned request goes to that chat's ChatInbox, under the key the
 * worker's poller uses (`tg-<update_id>`), so the same update read by both pollers during a deploy is
 * one invocation. ChatInbox hands it to Core's intake as before. Every other chat keeps legacy intake.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

/** Whether RequestLifecycle owns a request in this chat. Throws when the database cannot answer. */
export async function chatHasLifecycleRequest(db: Kysely<Database>, tenantId: string, chatId: string): Promise<boolean> {
  return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.requests
      WHERE tenant_id = ${tenantId}::uuid AND chat_id = ${chatId} AND owner = 'restate' LIMIT 1`.execute(trx)).rows.length > 0);
}

/**
 * Hands one polled update to its chat's ChatInbox through Restate's ingress, as the worker's poller
 * does, and answers with an HTTP status for the polled-update handler: 202 once Restate has it (the
 * offset may move), 503 when Restate is not configured or did not take it (the update is asked for
 * again, and after five failures dead-lettered, as for any intake failure).
 */
export async function handToChatInbox(update: { update_id: number }, chatId: string,
  options: { ingressUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): Promise<number> {
  const ingress = (options.ingressUrl ?? process.env.RESTATE_INGRESS_URL ?? '').replace(/\/+$/, '');
  if (!ingress) return 503;
  const res = await (options.fetch ?? fetch)(`${ingress}/ChatInbox/${encodeURIComponent(chatId)}/handleUpdate/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `tg-${update.update_id}` },
    body: JSON.stringify({ v: 1, update, polledAt: (options.now ?? Date.now)() }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? 202 : 503;
}
