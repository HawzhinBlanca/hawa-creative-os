/**
 * Intake's decide mode (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md sections 2.2 and
 * 3, ADR-034). When the worker's ChatInbox hands Core an update (POST /v1/internal/telegram/intake),
 * intake runs as it always has, inside a session kept here, and at the points where it would save a
 * request of the lifecycle or act on one it stops and answers a decision instead:
 *
 * - mode 'lifecycle' (the chat is on HAWA_LIFECYCLE_CHATS): a new request is not saved but answered
 *   as `new_request` with its classified draft; the "new request or a change?" question is answered
 *   as `clarify`, and ChatInbox keeps it (the session's `chat` state replaces Core's in-memory map);
 *   the album answers come from ChatInbox's state too;
 * - both modes: an answer, a requester's button or a change aimed at a task a request of the
 *   lifecycle owns (tasks.request_id set) is answered as `answer`, `requester` or `change`, so a chat
 *   taken off the flag still finishes its lifecycle requests on the lifecycle.
 *
 * Everything else (rules, commands, greetings, pictures and requests of Core's own) is handled as
 * before and answered `handled`. The session is an AsyncLocalStorage store, so the stages of intake
 * read it where they decide, without a parameter threaded through every one of them; an update that
 * reaches the webhook without a session (Core's own poller, a real webhook) has no decide mode.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, type ChatIntakeState, type IntakeDecision, type LifecycleMessage, type PendingClarification } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { isValidUuid } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID } from '../../core-context.js';

export type IntakeMode = 'legacy' | 'lifecycle';

export interface IntakeDecideSession {
  /** The mode ChatInbox read for the chat (its journaled `mode` step). */
  mode: IntakeMode;
  /** The chat's state as ChatInbox holds it; intake changes it in place (lifecycle mode only). */
  chat: ChatIntakeState;
  /** Set once intake decided: the rest of intake is skipped, and the route answers it. */
  decision?: IntakeDecision;
  /** Why a lifecycle chat's update was read on Core's own path (logged, and answered to the worker). */
  legacyBecause?: string;
}

const storage = new AsyncLocalStorage<IntakeDecideSession>();

/** Runs `fn` (the in-process call to the webhook) with the session every stage of intake reads. */
export function runWithDecideSession<T>(session: IntakeDecideSession, fn: () => Promise<T>): Promise<T> {
  return storage.run(session, fn);
}

export function decideSession(): IntakeDecideSession | undefined {
  return storage.getStore();
}

/** Whether new requests of this update are the lifecycle's to open (the chat is flagged). */
export function lifecycleMode(): boolean {
  return decideSession()?.mode === 'lifecycle';
}

/**
 * Intake stops here: the decision is kept for the route, and the webhook answers 200 so nothing after
 * it runs. Without a session there is no one to route a decision to; the caller must not ask.
 */
export function answerDecision(c: Context, decision: IntakeDecision): Response {
  const session = decideSession();
  if (!session) throw new Error('A decision was made outside the decide mode');
  session.decision = decision;
  return c.json({ ok: true, decided: decision.kind }, 200);
}

/**
 * The answer to an update that targets a lifecycle request when there is no ChatInbox to route to
 * (Core's own poller or a webhook): refused, and said in the log, rather than acted on behind the
 * lifecycle's back. 409 is final for Core's poller.
 */
export function lifecycleTargetWithoutInbox(c: Context, taskId: string, requestId: string): Response {
  return c.json({
    type: 'https://hawa.design/errors/409', title: 'Lifecycle Owned', status: 409, code: 'LIFECYCLE_OWNED', requestId,
    detail: `Task ${taskId} belongs to a request the lifecycle owns; its updates are read through the worker's ChatInbox (HAWA_TELEGRAM_POLLER=worker)`,
  }, 409);
}

// ---------------------------------------------------------------------------------------------
// The chat's state, in place of the in-memory map and set (lifecycle mode).

/** The clarification ChatInbox keeps for the chat, if it is still worth reading (one hour). */
export function sessionClarification(now = Date.now()): PendingClarification | undefined {
  const pending = decideSession()?.chat.pendingClarification;
  return pending && now - pending.askedAt < 3_600_000 ? pending : undefined;
}

export function clearSessionClarification(): void {
  const session = decideSession();
  if (session) delete session.chat.pendingClarification;
}

/** Whether this album was answered before in the chat; marks it answered. */
export function firstOfAlbumInSession(albumId: string, now = Date.now()): boolean {
  const session = decideSession();
  if (!session) return true;
  const acked = { ...(session.chat.albumsAcked ?? {}) };
  if (acked[albumId] !== undefined) return false;
  acked[albumId] = now;
  session.chat.albumsAcked = acked;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Who owns a task

export interface TaskOwner {
  requestId: string;
  state: string;
  chatId: string | null;
}

/** The request a task belongs to, when the lifecycle owns it (tasks.request_id), else null. */
export async function lifecycleOwnerOf(db: Kysely<Database> | undefined, taskId: unknown): Promise<TaskOwner | null> {
  if (!db || !isValidUuid(taskId)) return null;
  const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ request_id: string | null; state: string; chat_id: string | null }>`SELECT t.request_id::text, t.state::text AS state, r.chat_id
      FROM hawa.tasks t LEFT JOIN hawa.requests r ON r.request_id = t.request_id
      WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${taskId as string}::uuid`.execute(trx)).rows[0]);
  return row?.request_id ? { requestId: row.request_id, state: row.state, chatId: row.chat_id } : null;
}

// ---------------------------------------------------------------------------------------------
// The decision's record: intake's paid calls (transcription, classification) are not made twice.

/** inbox_events source id of an update's decision: `<chat>:<update>:decision`. */
export const decisionRecordId = (chat: string, updateId: string | number) => `${chat}:${updateId}:decision`;

/**
 * The decision already made for this update, when Core decided it before and the worker asks again
 * (its answer was lost, or the worker was killed). Read before intake runs again.
 */
export async function readDecisionRecord(db: Kysely<Database>, chat: string, updateId: string | number): Promise<{ decision: IntakeDecision; chat?: ChatIntakeState } | null> {
  const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ payload: unknown }>`SELECT payload FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid
      AND source_account_id = 'telegram' AND source_event_id = ${decisionRecordId(chat, updateId)} ORDER BY received_at LIMIT 1`.execute(trx)).rows[0]);
  if (!row) return null;
  const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as { decision?: IntakeDecision; chat?: ChatIntakeState };
  return payload?.decision ? { decision: payload.decision, ...(payload.chat ? { chat: payload.chat } : {}) } : null;
}

/**
 * Writes the decision before it is answered: a Core killed after this and before the worker has the
 * answer answers the retry from here. The row is also "the requester wrote in the chat" for the
 * reminders (source id `<chat>:…`), as a saved request's row always was.
 */
export async function writeDecisionRecord(db: Kysely<Database>, chat: string, updateId: string | number, decision: IntakeDecision, state?: ChatIntakeState): Promise<void> {
  const payload = { decision, ...(state ? { chat: state } : {}) };
  const text = JSON.stringify(payload);
  await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      SELECT ${DEFAULT_TENANT_ID}::uuid, 'telegram', ${decisionRecordId(chat, updateId)}, ${`telegram_intake_decision_${decision.kind}`}, ${text}::jsonb,
        ${crypto.createHash('sha256').update(text).digest('hex')}, true
      WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid
        AND source_account_id = 'telegram' AND source_event_id = ${decisionRecordId(chat, updateId)})`.execute(trx);
  });
}

// ---------------------------------------------------------------------------------------------
// Messages intake answers with instead of sending (lifecycle mode)

/** A courtesy text to the chat, keyed by the update so a replayed decision sends it once. */
export function courtesyText(chat: string, key: string, text: string, parseMode?: 'HTML'): LifecycleMessage {
  return { v: 1, key, chatId: chat, kind: 'text', text, class: 'courtesy', tenantId: DEFAULT_TENANT_ID, ...(parseMode ? { parseMode } : {}) };
}
