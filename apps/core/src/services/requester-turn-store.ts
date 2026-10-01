/**
 * PostgreSQL reads and writes behind requester-turn.ts (ADR-144): the chat's requests as a message
 * sees them, what a reply points at, and the intent decision, recorded once per Telegram update so
 * that a replay (Restate retrying the intake call, Telegram repeating the update) never reads the
 * words again: it gets the first decision back.
 */
import { sql, type Database, type Kysely } from '@hawa/db';
import type { ChatRequestView, IntentReading, PendingAsk, TurnPlan } from './requester-turn.js';

const INTENT_ACCOUNT = 'lifecycle_chat_intent';

/**
 * A request of the chat that a message can still concern. Delivered ones count for `deliveredDays`;
 * the intake route reads seven days, because redo words still mean a design delivered that long ago
 * and `planTurn` keeps the three days for everything else (ADR-200 addendum).
 */
export async function activeChatRequests(trx: Kysely<Database>, tenantId: string,
  chatId: string, deliveredDays = 3): Promise<ChatRequestView[]> {
  const days = Number.isInteger(deliveredDays) && deliveredDays >= 0 && deliveredDays <= 30 ? deliveredDays : 3;
  const rows = (await sql<{ request_id: string; rev: string | number; stage: string; current_task_id: string;
    client_id: string | null; title: string | null; created_at: Date | string; updated_at: Date | string;
    question: ChatRequestView['question']; requester_id: string | null; requester_hold:boolean; sent_to_chat: boolean }>`
    SELECT r.request_id::text, r.rev, r.stage, r.current_task_id::text, t.client_id::text,
      coalesce(root.title, t.title) AS title, r.created_at, r.updated_at,
      p.result->'question' AS question,
      coalesce(src.payload->'message'->'from'->>'id', opener.sender_id) AS requester_id,
      (t.state='paused' AND hold.data->>'requesterHoldRequestId'=r.request_id::text
        AND hold.data->>'requesterHoldRequestRev'=r.rev::text) AS requester_hold,
      -- ADR-231: the current task's final notice reached the requester (Delivery keys it lc:dl-<task>-<approval>:notice).
      (r.stage = 'delivering' AND EXISTS (SELECT 1 FROM hawa.inbox_events d WHERE d.tenant_id = r.tenant_id
        AND d.source_account_id = 'telegram_delivery' AND d.event_kind = 'telegram_message_sent'
        AND d.source_event_id LIKE ('lc:dl-' || r.current_task_id::text || '-%:notice:send'))) AS sent_to_chat
    FROM hawa.requests r
    JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
    LEFT JOIN LATERAL (SELECT e.data FROM hawa.task_events e
      WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id AND e.event_type='task.state_changed'
      ORDER BY e.aggregate_version DESC LIMIT 1) hold ON t.state='paused'
    LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
    LEFT JOIN hawa.lifecycle_projections p ON p.tenant_id = r.tenant_id
      AND p.request_id = r.request_id AND p.rev = r.rev
    LEFT JOIN hawa.inbox_events src ON src.tenant_id = r.tenant_id AND src.source_account_id = 'telegram'
      AND src.source_event_id = r.chat_id || ':lc-' || r.request_id::text || '-r0'
    -- ADR-182: a brief sent as plain words keeps no Telegram update on its task, so its requester is
    -- read from the decision that opened it: the sender its intent was recorded for. Without it every
    -- member of a group could change or cancel anyone's request.
    LEFT JOIN LATERAL (SELECT coalesce(o.payload->'briefAnchor'->>'senderId', o.payload->'sourceUpdate'->'message'->'from'->>'id', i.payload->>'senderId') AS sender_id
      FROM hawa.inbox_events o
      LEFT JOIN hawa.inbox_events i ON i.tenant_id = o.tenant_id AND i.source_account_id = 'lifecycle_chat_intent'
        AND i.source_event_id = o.source_event_id
      WHERE o.tenant_id = r.tenant_id AND o.source_account_id = 'lifecycle_chat_open'
        AND o.payload->>'chatId' = r.chat_id AND (o.payload->>'requestId' = r.request_id::text OR
          EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(o.payload->'siblings','[]'::jsonb)) s WHERE s->>'requestId'=r.request_id::text))
      LIMIT 1) opener ON true
    WHERE r.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId} AND r.owner = 'restate'
      AND (r.stage IN ('designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering')
        OR (r.stage = 'delivered' AND r.updated_at > now() - make_interval(days => ${days}::int)))
    ORDER BY r.created_at DESC, r.request_id DESC
    LIMIT 20`.execute(trx)).rows.reverse();
  // The newest twenty, oldest first: a longer window must not push the latest design out.
  const iso = (v: Date | string) => new Date(v).toISOString();
  return rows.map((row) => ({
    requestId: row.request_id, stage: row.stage as ChatRequestView['stage'], rev: Number(row.rev),
    currentTaskId: row.current_task_id, clientId: row.client_id, title: row.title || 'your design',
    createdAt: iso(row.created_at), activeAt: iso(row.updated_at),
    question: row.question && typeof row.question === 'object' && typeof row.question.text === 'string' ? row.question : null,
    requesterId: row.requester_id,
    ...(row.requester_hold ? {requesterHold:true} : {}),
    ...(row.sent_to_chat ? { sentToChat: true } : {}),
  }));
}

/**
 * Requests this chat's intake decided to open in the last ten minutes that RequestLifecycle has not
 * projected yet (ChatInbox sends the open without waiting for it). A follow-up read before the
 * projection lands would miss the request it is about.
 */
export async function openingChatRequests(trx: Kysely<Database>, tenantId: string, chatId: string): Promise<string[]> {
  return (await sql<{ request_id: string }>`SELECT child.request_id FROM hawa.inbox_events e
    CROSS JOIN LATERAL (SELECT e.payload->>'requestId' AS request_id UNION ALL
      SELECT s->>'requestId' FROM jsonb_array_elements(coalesce(e.payload->'siblings','[]'::jsonb)) s) child
    WHERE e.tenant_id = ${tenantId}::uuid AND e.source_account_id = 'lifecycle_chat_open'
      AND e.payload->>'chatId' = ${chatId} AND e.received_at > now() - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM hawa.requests r WHERE r.tenant_id = e.tenant_id
        AND r.request_id::text = child.request_id)`.execute(trx)).rows.map((row) => row.request_id);
}

/**
 * What a Telegram reply points at in this chat: any message the bot sent about a request (a draft, a
 * notice, the "Request received" acknowledgement), an answer the bot gave to a routed message, the
 * requester's own brief, or an earlier routed message of theirs. `askUpdateId` is set when the reply
 * answers a question this bot asked.
 */
export async function replyBindings(trx: Kysely<Database>, tenantId: string, chatId: string,
  replyMessageId: string): Promise<{ requestIds: string[]; askUpdateId: number | null }> {
  const found = new Set<string>();
  let askUpdateId: number | null = null;
  const sent = (await sql<{ request_id: string }>`SELECT DISTINCT r.request_id::text
    FROM hawa.inbox_events e JOIN hawa.requests r ON r.tenant_id = e.tenant_id
      AND e.source_event_id LIKE ('lc:' || r.request_id::text || ':%')
    WHERE e.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId} AND r.owner = 'restate'
      AND e.source_account_id = 'telegram_delivery'
      AND e.event_kind IN ('telegram_message_sent', 'telegram_document_sent')
      AND e.payload->>'messageId' = ${replyMessageId}`.execute(trx)).rows;
  for (const row of sent) found.add(row.request_id);
  // ADR-182: the Delivery workflow's messages (the delivered files and their notice) are keyed by the
  // task and the approval (`lc:dl-<task>-<approval>:…`), not by the request: a reply to one ("it didn't
  // arrive", "change the date on this") is about that task's request.
  const delivered = (await sql<{ request_id: string }>`SELECT DISTINCT r.request_id::text
    FROM hawa.inbox_events e
    JOIN hawa.tasks t ON t.tenant_id = e.tenant_id AND t.id::text = substring(e.source_event_id from 7 for 36)
    JOIN hawa.requests r ON r.tenant_id = t.tenant_id AND r.request_id = t.request_id
    WHERE e.tenant_id = ${tenantId}::uuid AND e.source_account_id = 'telegram_delivery'
      AND e.event_kind IN ('telegram_message_sent', 'telegram_document_sent') AND e.source_event_id LIKE 'lc:dl-%'
      AND e.payload->>'messageId' = ${replyMessageId} AND r.chat_id = ${chatId} AND r.owner = 'restate'`.execute(trx)).rows;
  for (const row of delivered) found.add(row.request_id);
  // The bot's answer to a routed message: ChatInbox keys it by that message's update.
  const answers = (await sql<{ source_event_id: string }>`SELECT e.source_event_id FROM hawa.inbox_events e
    WHERE e.tenant_id = ${tenantId}::uuid AND e.source_account_id = 'telegram_delivery'
      AND e.event_kind = 'telegram_message_sent' AND e.source_event_id LIKE 'lc:chatinbox:%'
      AND e.payload->>'messageId' = ${replyMessageId}`.execute(trx)).rows;
  const answered = answers.map((row) => /:(\d{1,18}):send$/.exec(row.source_event_id)?.[1])
    .filter((v): v is string => Boolean(v));
  // The requester's own brief.
  const own = (await sql<{ request_id: string }>`SELECT r.request_id::text FROM hawa.requests r
    JOIN hawa.inbox_events src ON src.tenant_id = r.tenant_id AND src.source_account_id = 'telegram'
      AND src.source_event_id = r.chat_id || ':lc-' || r.request_id::text || '-r0'
    WHERE r.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId} AND r.owner = 'restate'
      AND src.payload->'message'->>'message_id' = ${replyMessageId}`.execute(trx)).rows;
  for (const row of own) found.add(row.request_id);
  // The decisions behind those answers, and the requester's own earlier routed messages.
  const intents = (await sql<{ source_event_id: string; payload: Record<string, any> }>`SELECT source_event_id, payload
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${INTENT_ACCOUNT}
      AND payload->>'chatId' = ${chatId}
      AND (source_event_id = ANY(${answered}::text[]) OR payload->>'messageId' = ${replyMessageId})`.execute(trx)).rows;
  for (const row of intents) {
    const plan = row.payload?.plan as { kind?: string; requestId?: unknown } | undefined;
    if (typeof plan?.requestId === 'string') found.add(plan.requestId);
    if (plan?.kind === 'ask' && answered.includes(row.source_event_id)) askUpdateId = Number(row.source_event_id);
  }
  return { requestIds: [...found], askUpdateId };
}

/** The intent decision for one update: its reading, its plan, and (for a plan that only answers) the answer. */
export interface IntentReceipt {
  updateId: number;
  chatId: string;
  senderId: string;
  /** ADR-200: the sender's first name, as Telegram gave it (the office names drafts by it). */
  senderName?: string;
  messageId: string | null;
  payloadHash: string;
  reading: IntentReading;
  plan: TurnPlan;
  /** For a plan answered without a side effect of its own: the exact intake answer, replayed as it is. */
  answer?: { status: number; extra: Record<string, unknown> };
}

function parseIntentReceipt(source: string, payload: Record<string, any>, hash: string): IntentReceipt | null {
  if (!payload || typeof payload.chatId !== 'string' || typeof payload.senderId !== 'string' ||
      !payload.plan || typeof payload.plan.kind !== 'string' || !payload.reading ||
      typeof payload.reading.intent !== 'string') return null;
  return { updateId: Number(source), chatId: payload.chatId, senderId: payload.senderId,
    messageId: typeof payload.messageId === 'string' ? payload.messageId : null, payloadHash: hash,
    reading: payload.reading as IntentReading, plan: payload.plan as TurnPlan,
    ...(payload.answer && typeof payload.answer.status === 'number' ? { answer: payload.answer } : {}) };
}

export async function readIntentReceipt(trx: Kysely<Database>, tenantId: string,
  updateId: number): Promise<IntentReceipt | null> {
  const row = (await sql<{ payload: Record<string, any>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${INTENT_ACCOUNT}
      AND source_event_id = ${String(updateId)} LIMIT 1`.execute(trx)).rows[0];
  if (!row) return null;
  const receipt = parseIntentReceipt(String(updateId), row.payload, row.payload_hash);
  if (!receipt) throw new Error('Invalid stored intent decision');
  return receipt;
}

/** Records the decision once; the first record wins, and a replay reads it back. */
export async function recordIntentReceipt(trx: Kysely<Database>, tenantId: string,
  receipt: IntentReceipt): Promise<IntentReceipt> {
  const payload = { chatId: receipt.chatId, senderId: receipt.senderId, ...(receipt.senderName ? { senderName: receipt.senderName } : {}),
    messageId: receipt.messageId,
    reading: receipt.reading, plan: receipt.plan, ...(receipt.answer ? { answer: receipt.answer } : {}) };
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, ${INTENT_ACCOUNT}, ${String(receipt.updateId)}, 'lifecycle_chat_intent',
      ${JSON.stringify(payload)}::jsonb, ${receipt.payloadHash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readIntentReceipt(trx, tenantId, receipt.updateId);
  if (!stored) throw new Error('Intent decision was not stored');
  return stored;
}

const toAsk = (updateId: number, plan: TurnPlan): PendingAsk | null =>
  plan.kind === 'ask' && Array.isArray(plan.options) && typeof plan.words === 'string'
    ? { updateId, intent: plan.intent, words: plan.words, options: plan.options, allowNew: plan.allowNew === true }
    : null;

/**
 * The question this bot asked the sender and that is still open: their latest routed message of the
 * last day was answered with a question (a later message of theirs closes it). A reply to the bot's
 * question names it directly (`repliedAsk`), even if it is not the latest.
 */
export async function pendingAskFor(trx: Kysely<Database>, tenantId: string, chatId: string,
  senderId: string, updateId: number, repliedAsk: number | null): Promise<PendingAsk | null> {
  if (repliedAsk) {
    const asked = await readIntentReceipt(trx, tenantId, repliedAsk);
    if (asked && asked.chatId === chatId && asked.senderId === senderId) return toAsk(repliedAsk, asked.plan);
    return null;
  }
  const row = (await sql<{ source_event_id: string; payload: Record<string, any> }>`SELECT source_event_id, payload
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${INTENT_ACCOUNT}
      AND payload->>'chatId' = ${chatId} AND payload->>'senderId' = ${senderId}
      AND source_event_id <> ${String(updateId)} AND received_at > now() - interval '1 day'
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0];
  if (!row?.payload?.plan) return null;
  return toAsk(Number(row.source_event_id), row.payload.plan as TurnPlan);
}
