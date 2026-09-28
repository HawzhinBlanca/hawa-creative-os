/** PostgreSQL reads used to bind a Telegram reply to one RequestLifecycle owner. */
import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import { parseBlobRef, type BlobRef } from '@hawa/contracts';
import type { ChatIntake } from './chat-intake.js';
import type { RequesterRevisionWithIntakeResult } from './lifecycle-projection.js';

export interface WaitingLifecycleRequest {
  request_id: string;
  rev: number | string;
  stage: 'manual' | 'awaiting_answer';
  current_task_id: string;
  client_id: string | null;
  question: { id: string; text: string; options: string[] } | null;
}

export interface RevisionIntakeReceipt {
  request_id: string;
  result: unknown;
}

export interface NewBriefDecision {
  requestId: string;
  chatId: string;
  payloadHash: string;
  draft: ChatIntake;
  /** Original image intake evidence stays in Core, outside the Restate draft contract. */
  sourceUpdate?: unknown;
}

export interface RevisionPhotoDecision {
  requestId: string;
  chatId: string;
  payloadHash: string;
  image: BlobRef;
}

/** A downloaded revision photo survives a crash before its child task is projected. */
export async function readRevisionPhotoDecision(trx: Kysely<Database>, tenantId: string,
  updateId: number): Promise<RevisionPhotoDecision | null> {
  const row = (await sql<{ payload: Record<string, unknown>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
      AND source_account_id = 'lifecycle_chat_revision_photo' AND source_event_id = ${String(updateId)}
      AND event_kind = 'lifecycle_revision_photo_decision'
    LIMIT 1`.execute(trx)).rows[0];
  if (!row) return null;
  const { requestId, chatId } = row.payload;
  const image = parseBlobRef(row.payload.image);
  if (typeof requestId !== 'string' || typeof chatId !== 'string' || !image ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) ||
      image.size > 20 * 1024 * 1024) throw new Error('Invalid stored revision-photo decision');
  return { requestId, chatId, payloadHash: row.payload_hash, image };
}

export async function recordRevisionPhotoDecision(trx: Kysely<Database>, tenantId: string,
  updateId: number, decision: RevisionPhotoDecision): Promise<RevisionPhotoDecision> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_chat_revision_photo', ${String(updateId)},
      'lifecycle_revision_photo_decision',
      ${JSON.stringify({ requestId: decision.requestId, chatId: decision.chatId,
        image: decision.image })}::jsonb, ${decision.payloadHash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readRevisionPhotoDecision(trx, tenantId, updateId);
  if (!stored) throw new Error('Revision-photo decision was not stored');
  return stored;
}

/** The Core decision is durable before ChatInbox sends RequestLifecycle.open. */
export async function readNewBriefDecision(trx: Kysely<Database>, tenantId: string,
  updateId: number): Promise<NewBriefDecision | null> {
  const row = (await sql<{ payload: Record<string, unknown>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
      AND source_account_id = 'lifecycle_chat_open' AND source_event_id = ${String(updateId)}
    LIMIT 1`.execute(trx)).rows[0];
  if (!row) return null;
  const { requestId, chatId, draft } = row.payload;
  if (typeof requestId !== 'string' || typeof chatId !== 'string' ||
      !draft || typeof draft !== 'object') throw new Error('Invalid stored new-brief decision');
  return { requestId, chatId, payloadHash: row.payload_hash, draft: draft as ChatIntake,
    ...(row.payload.sourceUpdate !== undefined ? { sourceUpdate: row.payload.sourceUpdate } : {}) };
}

export async function recordNewBriefDecision(trx: Kysely<Database>, tenantId: string,
  updateId: number, decision: NewBriefDecision): Promise<NewBriefDecision> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_chat_open', ${String(updateId)},
      'lifecycle_new_brief_decision',
      ${JSON.stringify({ requestId: decision.requestId, chatId: decision.chatId,
        draft: decision.draft,
        ...(decision.sourceUpdate !== undefined ? { sourceUpdate: decision.sourceUpdate } : {}) })}::jsonb, ${decision.payloadHash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readNewBriefDecision(trx, tenantId, updateId);
  if (!stored) throw new Error('New-brief decision was not stored');
  return stored;
}

export async function revisionIntakeReceipts(trx: Kysely<Database>, tenantId: string,
  chatId: string, updateId: number): Promise<RevisionIntakeReceipt[]> {
  const suffix = `:requesterRevisionIntake:u${updateId}`;
  return (await sql<RevisionIntakeReceipt>`SELECT r.request_id::text, p.result
    FROM hawa.lifecycle_projections p JOIN hawa.requests r
      ON r.tenant_id = p.tenant_id AND r.request_id = p.request_id
    WHERE p.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId}
      AND p.idempotency_key LIKE ${`%${suffix}`}
    LIMIT 2`.execute(trx)).rows;
}

/** Verify the exact Core-owned intake projection the worker is about to adopt. */
export async function verifiedRevisionIntake(trx: Kysely<Database>, input: {
  tenantId: string; requestId: string; updateId: number; expectedRev: number;
  priorTaskId: string; newTaskId: string; round: number; directive: string;
  questionId?: string;
}): Promise<RequesterRevisionWithIntakeResult | null> {
  const rev = input.expectedRev + 1;
  const key = `${input.requestId}:${rev}:requesterRevisionIntake:u${input.updateId}`;
  const row = (await sql<{ result: unknown; request_rev: number | string; stage: string;
    current_task_id: string; task_owner: string | null }>`SELECT p.result,
      r.rev AS request_rev, r.stage, r.current_task_id::text,
      t.request_id::text AS task_owner
    FROM hawa.lifecycle_projections p JOIN hawa.requests r
      ON r.tenant_id = p.tenant_id AND r.request_id = p.request_id
    JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
    WHERE p.tenant_id = ${input.tenantId}::uuid AND p.request_id = ${input.requestId}::uuid
      AND p.rev = ${rev} AND p.idempotency_key = ${key}
      AND r.owner = 'restate' LIMIT 1`.execute(trx)).rows[0];
  const result = row?.result as RequesterRevisionWithIntakeResult | undefined;
  if (!row || !result || Number(row.request_rev) !== rev || row.stage !== 'designing' ||
      row.current_task_id !== input.newTaskId || row.task_owner !== input.requestId ||
      result.requestId !== input.requestId || result.priorTaskId !== input.priorTaskId ||
      result.newTaskId !== input.newTaskId || result.round !== input.round || result.rev !== rev ||
      result.stage !== 'designing' || result.runId !== `dr-${input.newTaskId}` ||
      result.directive !== input.directive.trim() || result.questionId !== input.questionId) return null;
  return result;
}

export async function waitingLifecycleRequests(trx: Kysely<Database>, tenantId: string,
  chatId: string): Promise<WaitingLifecycleRequest[]> {
  return (await sql<WaitingLifecycleRequest>`SELECT r.request_id::text, r.rev, r.stage, r.current_task_id::text,
      t.client_id::text, p.result->'question' AS question
    FROM hawa.requests r JOIN hawa.tasks t
      ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
    LEFT JOIN hawa.lifecycle_projections p ON p.tenant_id = r.tenant_id
      AND p.request_id = r.request_id AND p.rev = r.rev
    WHERE r.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId}
      AND r.owner = 'restate' AND (r.stage = 'awaiting_answer' OR
        (r.stage = 'manual' AND r.rev >= 3))
    ORDER BY r.created_at, r.request_id`.execute(trx)).rows;
}

export interface LinkedLifecycleReply { requestId: string; rev: number }

export interface RoutingRefusal { code: 'AMBIGUOUS_REQUEST' | 'STALE_REQUEST_REPLY' |
  'DAILY_CAP_REACHED' | 'PARENT_BRIEF_MISSING' | 'QUESTION_MISSING' |
  'LIFECYCLE_MEDIA_NOT_ADMITTED' | 'LATE_REQUESTER_CHANGE'; chatId: string;
  payloadHash: string;
  /** Only for LATE_REQUESTER_CHANGE: the request the reply was bound to and the requester's words. */
  late?: LateRequesterChange }

/** The stages in which a requester's words can no longer change the design by themselves. */
export const LATE_CHANGE_STAGES = ['in_review', 'approved', 'delivering', 'delivered'] as const;
export type LateChangeStage = typeof LATE_CHANGE_STAGES[number];
const isLateStage = (value: unknown): value is LateChangeStage =>
  typeof value === 'string' && (LATE_CHANGE_STAGES as readonly string[]).includes(value);

/**
 * A reply that reached a request after its design went to the office (finding 13 of the Phase 4
 * review). The words are kept as they were sent; they are not applied to any design.
 */
export interface LateRequesterChange {
  requestId: string; taskId: string; requestRev: number; requestStage: LateChangeStage; text: string;
}

const ROUTING_CODES = new Set(['AMBIGUOUS_REQUEST', 'STALE_REQUEST_REPLY', 'DAILY_CAP_REACHED',
  'PARENT_BRIEF_MISSING', 'QUESTION_MISSING', 'LIFECYCLE_MEDIA_NOT_ADMITTED', 'LATE_REQUESTER_CHANGE']);
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLateChange(payload: Record<string, unknown>): LateRequesterChange | null {
  const { requestId, taskId, requestRev, requestStage, text } = payload;
  if (typeof requestId !== 'string' || !UUID_TEXT.test(requestId) || typeof taskId !== 'string' ||
      !UUID_TEXT.test(taskId) || !Number.isSafeInteger(requestRev) || !isLateStage(requestStage) ||
      typeof text !== 'string' || !text.trim()) return null;
  return { requestId, taskId, requestRev: requestRev as number, requestStage, text };
}

export async function readRoutingRefusal(trx: Kysely<Database>, tenantId: string,
  updateId: number): Promise<RoutingRefusal | null> {
  const row = (await sql<{ payload: Record<string, unknown>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
      AND source_account_id = 'lifecycle_chat_routing' AND source_event_id = ${String(updateId)}
    LIMIT 1`.execute(trx)).rows[0];
  const code = row?.payload?.code;
  const chatId = row?.payload?.chatId;
  if (!row || typeof code !== 'string' || !ROUTING_CODES.has(code) || typeof chatId !== 'string') return null;
  if (code === 'LATE_REQUESTER_CHANGE') {
    const late = parseLateChange(row.payload);
    if (!late) throw new Error('Invalid stored late requester change');
    return { code, chatId, payloadHash: row.payload_hash, late };
  }
  return { code: code as RoutingRefusal['code'], chatId, payloadHash: row.payload_hash };
}

/** Save an actionable refusal before answering Core; a lost answer replays the same choice. */
export async function recordRoutingRefusal(trx: Kysely<Database>, tenantId: string,
  updateId: number, refusal: RoutingRefusal): Promise<RoutingRefusal> {
  if ((refusal.code === 'LATE_REQUESTER_CHANGE') !== Boolean(refusal.late) ||
      (refusal.late && !parseLateChange({ ...refusal.late }))) {
    throw new Error('A late requester change carries its request and words, and only it does');
  }
  const kind = refusal.code === 'LIFECYCLE_MEDIA_NOT_ADMITTED' ? 'lifecycle_media_not_admitted'
    : refusal.code === 'LATE_REQUESTER_CHANGE' ? 'lifecycle_late_requester_change'
      : 'lifecycle_request_choice_required';
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_chat_routing', ${String(updateId)}, ${kind},
      ${JSON.stringify({ code: refusal.code, chatId: refusal.chatId, ...(refusal.late ?? {}) })}::jsonb,
      ${refusal.payloadHash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readRoutingRefusal(trx, tenantId, updateId);
  if (!stored) throw new Error('Lifecycle chat refusal receipt was not stored');
  return stored;
}

/** Match a Telegram reply to the sent revision notice or reminder in this exact chat. */
export async function linkedLifecycleReplies(trx: Kysely<Database>, tenantId: string,
  chatId: string, replyMessageId: string): Promise<LinkedLifecycleReply[]> {
  const rows = (await sql<{ request_id: string; source_event_id: string }>`SELECT r.request_id::text, e.source_event_id
    FROM hawa.inbox_events e JOIN hawa.requests r
      ON r.tenant_id = e.tenant_id
      AND e.source_event_id LIKE ('lc:' || r.request_id::text || ':%')
    WHERE e.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId}
      AND r.owner = 'restate' AND e.source_account_id = 'telegram_delivery'
      AND e.event_kind = 'telegram_message_sent'
      AND e.payload->>'messageId' = ${replyMessageId}
      AND (e.source_event_id LIKE '%:office-revision-notify:send'
        OR e.source_event_id LIKE '%:revision-reminder:send'
        OR e.source_event_id LIKE '%:design-outcome:send'
        OR e.source_event_id LIKE '%:question-reminder-1:send'
        OR e.source_event_id LIKE '%:question-reminder-5:send')`.execute(trx)).rows;
  const found = new Map<string, LinkedLifecycleReply>();
  for (const row of rows) {
    const match = /^lc:([0-9a-f-]{36}):(\d+):(office-revision-notify|revision-reminder|design-outcome|question-reminder-[15]):send$/i.exec(row.source_event_id);
    if (!match || match[1].toLowerCase() !== row.request_id.toLowerCase()) continue;
    const rev = Number(match[2]);
    if (!Number.isSafeInteger(rev) || rev < 3) continue;
    found.set(`${row.request_id}:${rev}`, { requestId: row.request_id, rev });
  }
  return [...found.values()];
}

/**
 * The requests a reply points at when it answers a lifecycle message this chat received (the first
 * draft at rev 2 included), and that request is past the point where the requester's words change the
 * design: in review, approved, delivering or delivered.
 */
export async function lateChangeTargets(trx: Kysely<Database>, tenantId: string,
  chatId: string, replyMessageId: string): Promise<Array<Omit<LateRequesterChange, 'text'>>> {
  const rows = (await sql<{ request_id: string; rev: number | string; stage: string; current_task_id: string }>`
    SELECT DISTINCT r.request_id::text, r.rev, r.stage, r.current_task_id::text
    FROM hawa.inbox_events e JOIN hawa.requests r
      ON r.tenant_id = e.tenant_id
      AND e.source_event_id LIKE ('lc:' || r.request_id::text || ':%')
    WHERE e.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId}
      AND r.owner = 'restate' AND e.source_account_id = 'telegram_delivery'
      AND e.event_kind IN ('telegram_message_sent', 'telegram_document_sent')
      AND e.payload->>'messageId' = ${replyMessageId}
      AND r.stage IN ('in_review', 'approved', 'delivering', 'delivered')`.execute(trx)).rows;
  return rows.filter((row) => isLateStage(row.stage)).map((row) => ({ requestId: row.request_id,
    taskId: row.current_task_id, requestRev: Number(row.rev), requestStage: row.stage as LateChangeStage }));
}

const STAGE_WORDS: Record<LateChangeStage, string> = {
  in_review: 'waiting for office review',
  approved: 'approved',
  delivering: 'being delivered',
  delivered: 'delivered',
};

/**
 * The office's alert for a late change. Plain text (no parse mode): the requester's words are quoted as
 * they were sent. Null when there is no office chat, or the office chat is the requester's own.
 */
export function lateChangeOfficeAlert(late: LateRequesterChange, requesterChatId: string,
  officeChatId: string | null | undefined): { chatId: string; text: string } | null {
  if (!officeChatId || officeChatId === requesterChatId) return null;
  const words = late.text.length > 1500 ? `${late.text.slice(0, 1500)}…` : late.text;
  const consequence = late.requestStage === 'delivering'
    ? 'A delivery had already started; it was not stopped.'
    : late.requestStage === 'delivered'
      ? 'The design had already been delivered.'
      : 'Deliver will ask someone in the Desk to read and acknowledge these words first.';
  return { chatId: officeChatId, text: [
    `The requester in chat ${requesterChatId} replied after the design was ${STAGE_WORDS[late.requestStage]}. Their words were not applied to any design.`,
    `Task ${late.taskId}, request ${late.requestId}.`,
    '',
    'Their words:',
    words,
    '',
    consequence,
  ].join('\n') };
}

export interface PendingLateChange { updateId: string; text: string; stage: LateChangeStage; receivedAt: string }

/** Late changes of one request that nobody has acknowledged yet, oldest first. */
export async function pendingLateChanges(trx: Kysely<Database>, tenantId: string,
  requestId: string): Promise<PendingLateChange[]> {
  const rows = (await sql<{ source_event_id: string; payload: Record<string, unknown>; received_at: Date | string }>`
    SELECT l.source_event_id, l.payload, l.received_at FROM hawa.inbox_events l
    WHERE l.tenant_id = ${tenantId}::uuid AND l.source_account_id = 'lifecycle_chat_routing'
      AND l.event_kind = 'lifecycle_late_requester_change' AND l.payload->>'requestId' = ${requestId}
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events a WHERE a.tenant_id = l.tenant_id
        AND a.source_account_id = 'lifecycle_late_change_ack' AND a.source_event_id = l.source_event_id)
    ORDER BY l.received_at, l.id`.execute(trx)).rows;
  return rows.map((row) => {
    const late = parseLateChange(row.payload);
    if (!late) throw new Error('Invalid stored late requester change');
    return { updateId: row.source_event_id, text: late.text, stage: late.requestStage,
      receivedAt: new Date(row.received_at).toISOString() };
  });
}

/** Late changes of one request an office member has already acknowledged. */
export async function acknowledgedLateChanges(trx: Kysely<Database>, tenantId: string,
  requestId: string): Promise<string[]> {
  return (await sql<{ source_event_id: string }>`SELECT source_event_id FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_late_change_ack'
      AND payload->>'requestId' = ${requestId}`.execute(trx)).rows.map((row) => row.source_event_id);
}

/** Records who read a late change before delivering; the first acknowledgement of each change stays. */
export async function acknowledgeLateChange(trx: Kysely<Database>, tenantId: string, input: {
  requestId: string; updateId: string; actorUserId: string; actorRole: string; actionId: string;
}): Promise<void> {
  const payload = JSON.stringify({ requestId: input.requestId, updateId: input.updateId,
    actorUserId: input.actorUserId, actorRole: input.actorRole, actionId: input.actionId });
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_late_change_ack', ${input.updateId},
      'lifecycle_late_change_acknowledged', ${payload}::jsonb,
      ${createHash('sha256').update(payload).digest('hex')}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
}

/** Why an update in a lifecycle chat belongs to a Core-owned (legacy) design (ADR-136). */
export type CoreOwnedReason = 'button' | 'reply-names-core-task' | 'reply-to-core-send' | 'reply-in-core-chat';

const UUID_IN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * An update in a chat the lifecycle serves that acts on a design Core still owns (ADR-052, ADR-059:
 * existing Core-owned tasks remain on legacy intake). The cutover of 2026-09-28 put chats with Core
 * requests in flight on the lifecycle; before this rule their requesters' button presses could become
 * a lifecycle revision directive, and a Telegram reply to their own draft was refused as a stale
 * lifecycle reply (ADR-136).
 *
 *  - A button press: lifecycle notices carry no buttons, so every callback query is a legacy one.
 *  - A reply that names a Core-pinned task of this chat, as legacy intake reads a reply (the task ID
 *    in the quoted message's text, caption or buttons).
 *  - A reply to a message the outbox sent for a Core-pinned task of this chat (a delivered file or its
 *    notice), found by the Telegram message ID of its send mark.
 *  - A reply to anything else in a chat with Core history and no lifecycle request at all: there is
 *    no lifecycle request it could be a stale reply to.
 * Null otherwise; a reply to a lifecycle message, and `/new`, keep the lifecycle's routing.
 */
export async function coreOwnedUpdate(trx: Kysely<Database>, tenantId: string, chatId: string,
  update: Record<string, unknown>): Promise<CoreOwnedReason | null> {
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
      WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ANY(${named}::uuid[])
        AND t.delivery_executor_pin = 'core' AND o.payload->>'sourceChannelId' = ${chatId} LIMIT 1`.execute(trx)).rows;
    if (hit.length) return 'reply-names-core-task';
  }
  if (replyId) {
    // Outbox send marks are keyed `<command id>:<step>`; lifecycle marks `lc:<request>:…` never name a Core task.
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
      WHERE t.delivery_executor_pin = 'core' AND o.payload->>'sourceChannelId' = ${chatId} LIMIT 1`.execute(trx)).rows;
    if (sent.length) return 'reply-to-core-send';
  }
  const [chat] = (await sql<{ core: boolean; lifecycle: boolean }>`SELECT
      EXISTS (SELECT 1 FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id
          AND o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${tenantId}::uuid AND o.payload->>'sourceChannelId' = ${chatId}
          AND t.delivery_executor_pin = 'core') AS core,
      EXISTS (SELECT 1 FROM hawa.requests r WHERE r.tenant_id = ${tenantId}::uuid
        AND r.chat_id = ${chatId} AND r.owner = 'restate') AS lifecycle`.execute(trx)).rows;
  return chat?.core && !chat.lifecycle ? 'reply-in-core-chat' : null;
}
