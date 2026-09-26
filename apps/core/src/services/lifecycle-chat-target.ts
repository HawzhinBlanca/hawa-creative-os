/** PostgreSQL reads used to bind a Telegram reply to one RequestLifecycle owner. */
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
  'LIFECYCLE_MEDIA_NOT_ADMITTED'; chatId: string;
  payloadHash: string }

export async function readRoutingRefusal(trx: Kysely<Database>, tenantId: string,
  updateId: number): Promise<RoutingRefusal | null> {
  const row = (await sql<{ payload: Record<string, unknown>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
      AND source_account_id = 'lifecycle_chat_routing' AND source_event_id = ${String(updateId)}
    LIMIT 1`.execute(trx)).rows[0];
  const code = row?.payload?.code;
  const chatId = row?.payload?.chatId;
  if (!row || (code !== 'AMBIGUOUS_REQUEST' && code !== 'STALE_REQUEST_REPLY' &&
      code !== 'DAILY_CAP_REACHED' && code !== 'PARENT_BRIEF_MISSING' &&
      code !== 'QUESTION_MISSING' && code !== 'LIFECYCLE_MEDIA_NOT_ADMITTED') ||
      typeof chatId !== 'string') return null;
  return { code, chatId, payloadHash: row.payload_hash };
}

/** Save an actionable refusal before answering Core; a lost answer replays the same choice. */
export async function recordRoutingRefusal(trx: Kysely<Database>, tenantId: string,
  updateId: number, refusal: RoutingRefusal): Promise<RoutingRefusal> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
      event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_chat_routing', ${String(updateId)},
      ${refusal.code === 'LIFECYCLE_MEDIA_NOT_ADMITTED' ? 'lifecycle_media_not_admitted' : 'lifecycle_request_choice_required'},
      ${JSON.stringify({ code: refusal.code, chatId: refusal.chatId })}::jsonb,
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
