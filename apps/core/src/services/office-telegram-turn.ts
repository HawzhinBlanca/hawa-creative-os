/**
 * ADR-040 addendum (owner decision, 2026-09-30): an office member approves, sends back or rejects a
 * draft in their private Telegram chat, in plain words.
 *
 * Asked "Should office members also be able to approve from Telegram by replying to the draft image in
 * plain words?", the owner answered "Yes, office can approve in Telegram". Until then approval stayed in
 * Hawa Desk (ADR-022, ADR-065) and the draft's photo alert (ADR-155 addendum) only said where to go.
 *
 * Who: a member of the office list (TELEGRAM_ALLOWED_USERS), writing in their own private chat with the
 * bot (the chat is the sender), in a message of their own: never a group, never a forward, never an
 * edit. A requester who is not on the list never reaches this. The owner is on the list and may decide
 * on their own requests too (the owner is the office; owner-as-office exception in the ADR).
 *
 * Which draft: the one whose photo alert (or text alert) the member replies to, matched by the chat and
 * Telegram message id TelegramSender records for each office alert, per member and revision. Without a
 * reply, the one draft waiting in the office queue; with several, the bot asks which, in plain words,
 * and takes a number or a name. A reply to anything else, or words that do not read as a decision with
 * no reply, are not the office's: intake reads them as it always has (the owner's own briefs).
 *
 * What: approval ("approved", "ok send it", "looks good, send"), a change (anything that describes one,
 * including "ok but make the title bigger"), a rejection ("reject", "no, cancel this"); anything else
 * about a replied-to draft is asked about briefly. The words are read by the requester rules
 * (requester-turn.ts) plus a few office phrases; no model is called.
 *
 * How: exactly the Desk's Core actions (office-decisions.ts), under the office team's principal with the
 * member's chat id recorded (authMethod `telegram_office`): approval pins the captured files the Desk
 * would (the PNG and the QA-checked PPTX of the latest passing check, from one Canva capture), then its
 * delivery starts. The photo the member was sent is the human visual check: approval requires that the
 * pinned PNG is that very picture, sent to that member, and records it. Action keys come from the
 * Telegram update, so a replay repeats nothing; a Desk decision that came first is answered truthfully.
 */
import { createHash } from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import type { RejectionCategory, StructuredRevisionRequest } from '@hawa/domain';
import { OFFICE_MESSAGES, bold, escapeTelegramHtml, requesterLang, say, type Phrase, type RequesterLang } from '@hawa/integrations';
import { ADMIN_USER_ID } from '../core-context.js';
import { log } from '../logging.js';
import { namedOfficeReviewMode } from './google-oidc.js';
import { acknowledgedLateChanges, pendingLateChanges } from './lifecycle-chat-target.js';
import { officeChatIds } from './office-chats.js';
import { decideRequestOwned, startRequestOwnedDelivery, type OfficeActionAnswer } from './office-decisions.js';
import type { DeliverableStore } from './pinned-deliverables.js';
import { cleanDraftTitle } from './draft-title.js';
import { asksForNewDesign, corePhrase, parseChoice, readIntentByRules, readsAsChange } from './requester-turn.js';

const TURN_ACCOUNT = 'office_telegram_turn';
const INTENT_ACCOUNT = 'lifecycle_chat_intent';
const SYSTEM = (tenantId: string) => ({ tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const });
/** The office team's principal (the trusted-office Desk's, ADR-146); the member's chat id is recorded beside it. */
const OFFICE_ACTOR = { userId: ADMIN_USER_ID, role: 'administrator' };
const ALERT_MARK = /^lc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,9}):office-alert(?::(-?[0-9]{1,20}))?:send$/;

export type OfficeIntent = 'approve' | 'change' | 'reject' | 'unclear';

/** The office's own ways of saying yes, beside the requester rules' approval phrases. */
const OFFICE_APPROVE = /^(?:(?:ok(?:ay)?|yes|yep|yeah|good|great|perfect|fine|nice|excellent|lgtm|looks?\s+(?:good|great|fine|perfect)|all\s+good|approved?|go(?:\s+ahead)?|👍|✅|باشە|زۆر\s+باشە|جوانە|پەسەندە|پەسەند|ڕێکە)[\s,،!.:-]*)*(?:(?:please\s+)?(?:send(?:\s+(?:it|them))?(?:\s+(?:now|over|out|to\s+(?:them|him|her|the\s+client)))?|ship\s+it|approved?|go(?:\s+ahead)?|بینێرە|بنێرە|بینێرن|پەسەند\s+کرا|پەسەندە|پەسەند)[\s,،!.]*)+$/iu;
/** Rejection in the office's words: "reject", "rejected", "no, cancel this", Sorani "reject it", "rejected". */
const OFFICE_REJECT = /^(?:no[\s,،!.]+)?(?:reject(?:ed|\s+(?:it|this|that))?|decline(?:d)?|not\s+approved)\b|(?:ڕەتی\s+بکەرەوە|ڕەتکرایەوە|ڕەتدەکرێتەوە|ڕەت\s+کرایەوە|ڕەتی\s+دەکەمەوە)/iu;
/** "no, cancel this", "cancel it": a rejection of the whole design (category `task`). */
const OFFICE_CANCEL = /^(?:no[\s,،!.]+)?(?:cancel|scrap|drop|forget)(?:\s+(?:it|this|that|the\s+design))?[\s!.]*$/iu;
/**
 * Approval words that refuse it: "the design is not approved", "don't send it", "isn't ready"; Sorani
 * "not approved", "I don't approve it", "don't send it". The owner's words of 2026-10-01 ("the design is
 * not approved, the images cut with no content awareness, should have more images…") read as approval,
 * because "approved" is an approval phrase and nothing after it read as a change.
 */
const OFFICE_NOT_APPROVED = /\b(?:not|isn'?t|is\s+not|aren'?t|wasn'?t|never)\s+(?:yet\s+)?(?:approved?|ready|good|ok(?:ay)?|fine|acceptable)\b|\b(?:don'?t|do\s+not|doesn'?t|never)\s+(?:send|approve|ship|publish|print)\b|(?:پەسەند\s*نییە|پەسەند\s*نەکراوە|پەسەندی\s*ناکەم|مەینێرە|مەنێرە|نەینێرە|نەنێرە)/giu;
/** Words around a refusal that say nothing more about the draft. */
const REFUSAL_FILLER = /\b(?:the|this|that|it|its|design|draft|poster|picture|one|is|yet|sorry|please|so|and|but)\b|(?:دیزاینەکە|ئەمە|ئەوە|هێشتا)/giu;

/**
 * What an office member's words mean for a draft. A change mixed with approval ("ok but make the title
 * bigger") is a change: nothing is approved until the words say nothing else.
 */
export function readOfficeIntent(text: string): { intent: OfficeIntent; rejectionCategory?: RejectionCategory } {
  const t = String(text ?? '').trim();
  if (!t || t.startsWith('/')) return { intent: 'unclear' };
  const core = corePhrase(t);
  if (OFFICE_CANCEL.test(core) || OFFICE_CANCEL.test(t)) return { intent: 'reject', rejectionCategory: 'task' };
  if (OFFICE_REJECT.test(core) || OFFICE_REJECT.test(t)) return { intent: 'reject', rejectionCategory: 'concept' };
  // A refusal is never approval. With anything said about the draft it is what to change; "not approved"
  // alone rejects, as above; "not good", "don't send it" alone are asked about.
  if (t.match(OFFICE_NOT_APPROVED)) {
    const rest = t.replace(OFFICE_NOT_APPROVED, ' ').replace(REFUSAL_FILLER, ' ').split(/[\s,،.!:;…-]+/u).filter(Boolean);
    if (rest.length >= 2) return { intent: 'change' };
    return /approv|پەسەند/iu.test(t) ? { intent: 'reject', rejectionCategory: 'concept' } : { intent: 'unclear' };
  }
  // A new brief ("make a poster for Nawroz") is never a change to a draft: intake opens it as before.
  if (asksForNewDesign(t)) return { intent: 'unclear' };
  const reading = readIntentByRules(t);
  if (reading.intent === 'new_brief') return { intent: 'unclear' };
  if (reading.intent === 'change' || readsAsChange(t)) return { intent: 'change' };
  if (reading.intent === 'approval') return { intent: 'approve' };
  if (reading.intent === 'cancel') return { intent: 'reject', rejectionCategory: 'task' };
  if (OFFICE_APPROVE.test(core) || OFFICE_APPROVE.test(t.replace(/\s+/g, ' '))) return { intent: 'approve' };
  return { intent: 'unclear' };
}

/** What the member decided about which draft, or the question the bot asked; recorded once per update. */
export type OfficePlan =
  | { kind: 'decide'; intent: 'approve' | 'change' | 'reject'; requestId: string;
      /** The revision of the alert replied to (null: the draft waiting now). */
      alertRev: number | null; words: string; rejectionCategory?: RejectionCategory;
      /** Late requester words the member was shown and answered (their update ids). */
      acknowledge?: string[];
      /** Words with no reply, applied to the draft last sent to this member: when it was sent (ISO). */
      lastSent?: string }
  | { kind: 'ask-which'; intent: 'approve' | 'change' | 'reject'; words: string; rejectionCategory?: RejectionCategory;
      options: QueuedDraft[] }
  | { kind: 'ask-what'; requestId: string; alertRev: number | null }
  | { kind: 'ask-late'; requestId: string; alertRev: number | null; updateIds: string[] };

interface TurnReceipt {
  updateId: number; chatId: string; messageId: string | null; lang: RequesterLang; plan: OfficePlan;
  /** The draft the decision was first sent for, so a replay names the same task and revision. */
  target?: { taskId: string; revisionId: string };
  /** The approval body as first built (pins, visual check), so a replay sends the same decision. */
  approval?: Record<string, unknown>;
  /** A question the answer asked (the next message may answer it). */
  ask?: OfficePlan;
  answer?: { status: number; extra: Record<string, unknown> };
}

/** The parts of a Telegram message this turn reads. */
interface TelegramMessageLike {
  text?: unknown; message_id?: unknown; from?: { id?: unknown; is_bot?: unknown }; chat?: { id?: unknown; type?: unknown };
  reply_to_message?: { message_id?: unknown }; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown;
  forward_date?: unknown; forward_sender_name?: unknown; is_automatic_forward?: unknown;
}

interface OfficeMessage { updateId: number; chatId: string; messageId: string | null; text: string; replyTo: string | null }

/** The update as an office member's own words in their private chat, or null (intake reads it as before). */
export function officeMessageOf(update: Record<string, unknown>, office: readonly string[] = officeChatIds()): OfficeMessage | null {
  const message = update.message && typeof update.message === 'object' ? update.message as TelegramMessageLike : null;
  if (!message || typeof message.text !== 'string' || !message.text.trim()) return null;
  const text = message.text.trim();
  const from = message.from?.id;
  const chat = message.chat?.id;
  // Group chats never decide; a forward carries someone else's words; a bot is not a member.
  if (message.chat?.type !== 'private' || typeof from !== 'number' || !Number.isSafeInteger(from) || from !== chat ||
      message.from?.is_bot === true) return null;
  if (message.forward_origin !== undefined || message.forward_from !== undefined || message.forward_from_chat !== undefined ||
      message.forward_date !== undefined || message.forward_sender_name !== undefined || message.is_automatic_forward === true) return null;
  if (!office.includes(String(from))) return null;
  const reply = message.reply_to_message?.message_id;
  return { updateId: Number(update.update_id), chatId: String(chat), text,
    messageId: Number.isSafeInteger(message.message_id) ? String(message.message_id) : null,
    replyTo: typeof reply === 'number' && Number.isSafeInteger(reply) && reply > 0 ? String(reply) : null };
}

/** A UUID that names one action of one update (version 5 layout), stable across every replay. */
export function officeActionId(chatId: string, updateId: number, action: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`telegram-office:${chatId}:${updateId}:${action}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL: the office alert a reply names, the office queue, and the turn's receipt
// ---------------------------------------------------------------------------------------------

/**
 * The request and revision of the office alert (photo or text) this chat's message `replyTo` is, from
 * TelegramSender's sent marks (`lc:<request>:<rev>:office-alert[:<chat>]:send`). A mark written before
 * marks named their chat is matched by its key: its own chat, or the first office member for the key
 * without one.
 */
export async function officeAlertFor(trx: Kysely<Database>, tenantId: string, chatId: string,
  replyTo: string): Promise<{ requestId: string; rev: number; messageId: string } | null> {
  const rows = (await sql<{ source_event_id: string; payload: Record<string, unknown> }>`SELECT source_event_id, payload
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery'
      AND event_kind = 'telegram_message_sent' AND payload->>'messageId' = ${replyTo}
      AND source_event_id LIKE 'lc:%:office-alert%'
    ORDER BY received_at DESC, id DESC LIMIT 20`.execute(trx)).rows;
  const first = officeChatIds()[0];
  for (const row of rows) {
    const m = ALERT_MARK.exec(row.source_event_id);
    if (!m) continue;
    const chat = typeof row.payload?.chatId === 'string' ? row.payload.chatId : m[3] ?? first;
    if (chat === chatId) return { requestId: m[1], rev: Number(m[2]), messageId: replyTo };
  }
  return null;
}

/** Whether this member was sent the office alert of a request's revision (their sent mark). */
async function alertSentTo(trx: Kysely<Database>, tenantId: string, chatId: string, requestId: string,
  rev: number): Promise<string | null> {
  const rows = (await sql<{ source_event_id: string; payload: Record<string, unknown> }>`SELECT source_event_id, payload
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery'
      AND event_kind = 'telegram_message_sent'
      AND source_event_id IN (${`lc:${requestId}:${rev}:office-alert:send`}, ${`lc:${requestId}:${rev}:office-alert:${chatId}:send`})`
    .execute(trx)).rows;
  const first = officeChatIds()[0];
  for (const row of rows) {
    const m = ALERT_MARK.exec(row.source_event_id);
    const chat = typeof row.payload?.chatId === 'string' ? row.payload.chatId : m?.[3] ?? first;
    if (m && chat === chatId && typeof row.payload?.messageId === 'string') return row.payload.messageId;
  }
  return null;
}

/** A draft in the office queue as the "which draft?" list shows it. */
export interface QueuedDraft {
  requestId: string; title: string;
  /** When its office alert reached this member (ISO), else when it entered review. */
  sentAt?: string;
  /** Whether this member was sent its office alert (photo or text) for the waiting revision. */
  alerted?: boolean;
  /** The photos sent with the request. */
  photos?: number;
  /** Who asked for it: their first name, and whether it is this member. */
  requester?: string | null; own?: boolean;
}

/** At most this many drafts are listed, newest first. */
const QUEUE_LIST = 5;

/**
 * The drafts waiting in the office queue (request-owned, in review, the task awaiting its decision),
 * newest first by when this member was sent each one's alert, with the facts that tell them apart.
 */
async function officeQueue(trx: Kysely<Database>, tenantId: string, chatId: string): Promise<QueuedDraft[]> {
  const first = officeChatIds()[0] ?? '';
  return (await sql<{ request_id: string; title: string | null; copy: unknown; photos: string | number; chat_id: string;
    first_name: string | null; alerted_at: Date | string | null; updated_at: Date | string }>`SELECT r.request_id::text,
      coalesce(root.title, t.title) AS title, r.chat_id, r.updated_at,
      src.payload->'message'->'from'->>'first_name' AS first_name,
      (SELECT coalesce(e.data->'payload'->'exactCopy', e.data->'exactCopy') FROM hawa.task_events e
        WHERE e.tenant_id = r.tenant_id AND e.task_id = r.root_task_id AND e.event_type = 'task.created'
        ORDER BY e.aggregate_version LIMIT 1) AS copy,
      (SELECT count(DISTINCT f.sha256) FROM hawa.task_files f
        JOIN hawa.tasks ft ON ft.tenant_id = f.tenant_id AND ft.id = f.task_id
        WHERE f.tenant_id = r.tenant_id AND f.role = 'reference_image'
          AND (ft.request_id = r.request_id OR ft.id IN (r.root_task_id, r.current_task_id))) AS photos,
      (SELECT max(m.received_at) FROM hawa.inbox_events m
        WHERE m.tenant_id = r.tenant_id AND m.source_account_id = 'telegram_delivery' AND m.event_kind = 'telegram_message_sent'
          AND (m.source_event_id = 'lc:' || r.request_id::text || ':' || r.rev::text || ':office-alert:' || ${chatId} || ':send'
            OR (m.source_event_id = 'lc:' || r.request_id::text || ':' || r.rev::text || ':office-alert:send'
              AND coalesce(m.payload->>'chatId', ${first}) = ${chatId}))) AS alerted_at
    FROM hawa.requests r
    JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
    LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
    LEFT JOIN hawa.inbox_events src ON src.tenant_id = r.tenant_id AND src.source_account_id = 'telegram'
      AND src.source_event_id = r.chat_id || ':lc-' || r.request_id::text || '-r0'
    WHERE r.tenant_id = ${tenantId}::uuid AND r.owner = 'restate' AND r.stage = 'in_review' AND t.state = 'human_review'`.execute(trx)).rows
    .map((row) => ({ requestId: row.request_id, title: displayTitle(row.title, row.copy),
      sentAt: new Date(row.alerted_at ?? row.updated_at).toISOString(), alerted: row.alerted_at !== null,
      photos: Number(row.photos) || 0, requester: row.first_name?.trim() ? row.first_name.trim().slice(0, 60) : null,
      own: row.chat_id === chatId }))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.requestId.localeCompare(b.requestId))
    .slice(0, QUEUE_LIST);
}

/** How recently this member must have been sent a draft for words with no reply to mean it. */
const RECENT_ALERT_MS = 2 * 60 * 60_000;
/** Drafts sent closer together than this are not told apart by which came last. */
const ALERTS_APART_MS = 5 * 60_000;

/**
 * The draft that words with no reply are about, when there is no doubt: the newest draft this member
 * was sent, within two hours, and no other waiting draft sent within five minutes of it. Null: ask.
 */
export function lastSentDraft(queue: readonly QueuedDraft[], now: number): QueuedDraft | null {
  const [newest, next] = queue;
  if (!newest?.alerted || !newest.sentAt) return null;
  const at = Date.parse(newest.sentAt);
  if (!(now - at <= RECENT_ALERT_MS)) return null;
  if (next?.sentAt && at - Date.parse(next.sentAt) < ALERTS_APART_MS) return null;
  return newest;
}

/** Whether this chat has requests of its own on the way that are not waiting for the office's decision. */
async function ownOpenRequests(trx: Kysely<Database>, tenantId: string, chatId: string): Promise<boolean> {
  return (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.requests WHERE tenant_id = ${tenantId}::uuid
    AND chat_id = ${chatId} AND owner = 'restate'
    AND stage IN ('designing', 'awaiting_answer', 'manual', 'approved', 'delivering') LIMIT 1`.execute(trx)).rows.length > 0;
}

/** A draft's name for the office, cleaned as it is read (draft-title.ts): old titles show as new ones. */
const displayTitle = (value: string | null | undefined, copy?: unknown) => {
  const t = cleanDraftTitle(value, copy) || 'Untitled design';
  return Array.from(t).length > 80 ? `${Array.from(t).slice(0, 79).join('')}…` : t;
};

/** A stored turn as JSON: every field is checked before it is used. */
interface StoredTurn {
  chatId?: unknown; messageId?: unknown; lang?: unknown; plan?: { kind?: unknown };
  target?: { taskId?: unknown; revisionId?: unknown }; approval?: Record<string, unknown>; ask?: unknown;
  answer?: { status?: unknown; extra?: Record<string, unknown> };
}

function parseReceipt(updateId: number, payload: StoredTurn | undefined): TurnReceipt | null {
  if (!payload || typeof payload.chatId !== 'string' || !payload.plan || typeof payload.plan.kind !== 'string') return null;
  const target = payload.target;
  const answer = payload.answer;
  return { updateId, chatId: payload.chatId, messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
    lang: payload.lang === 'ckb' ? 'ckb' : 'en', plan: payload.plan as OfficePlan,
    ...(target && typeof target.taskId === 'string' && typeof target.revisionId === 'string'
      ? { target: { taskId: target.taskId, revisionId: target.revisionId } } : {}),
    ...(payload.approval ? { approval: payload.approval } : {}), ...(payload.ask ? { ask: payload.ask as OfficePlan } : {}),
    ...(answer && typeof answer.status === 'number' && answer.extra ? { answer: { status: answer.status, extra: answer.extra } } : {}) };
}

async function readTurn(trx: Kysely<Database>, tenantId: string, updateId: number): Promise<TurnReceipt | null> {
  const row = (await sql<{ payload: StoredTurn }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${TURN_ACCOUNT} AND source_event_id = ${String(updateId)}
    LIMIT 1`.execute(trx)).rows[0];
  return row ? parseReceipt(updateId, row.payload) : null;
}

/** Records the plan once; the first record wins, and a replay reads it back. */
async function recordTurn(trx: Kysely<Database>, tenantId: string, receipt: TurnReceipt, hash: string): Promise<TurnReceipt> {
  const payload = { chatId: receipt.chatId, messageId: receipt.messageId, lang: receipt.lang, plan: receipt.plan };
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, ${TURN_ACCOUNT}, ${String(receipt.updateId)}, 'office_telegram_turn',
      ${JSON.stringify(payload)}::jsonb, ${hash}, true) ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readTurn(trx, tenantId, receipt.updateId);
  if (!stored) throw new Error('The office turn was not stored');
  return stored;
}

/** Adds fields to the turn's receipt (the approval body once, then the answer once). */
async function extendTurn(trx: Kysely<Database>, tenantId: string, updateId: number, fields: Record<string, unknown>): Promise<void> {
  await sql`UPDATE hawa.inbox_events SET payload = ${JSON.stringify(fields)}::jsonb || payload
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${TURN_ACCOUNT} AND source_event_id = ${String(updateId)}`.execute(trx);
}

/**
 * The question the bot asked this member that is still open: their latest message of the last day
 * (office turn or requester intake) was answered with one. A reply to the bot's question names it.
 */
async function openAsk(trx: Kysely<Database>, tenantId: string, chatId: string, updateId: number,
  replyTo: string | null): Promise<TurnReceipt | null> {
  if (replyTo) {
    const answered = (await sql<{ source_event_id: string }>`SELECT source_event_id FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery' AND event_kind = 'telegram_message_sent'
        AND source_event_id LIKE 'lc:chatinbox:chat-answer:%' AND payload->>'messageId' = ${replyTo}
      ORDER BY received_at DESC LIMIT 5`.execute(trx)).rows
      .map((row) => /^lc:chatinbox:chat-answer:(\d{1,18}):send$/.exec(row.source_event_id)?.[1]).filter(Boolean) as string[];
    for (const id of answered) {
      const turn = await readTurn(trx, tenantId, Number(id));
      if (turn?.chatId === chatId && turn.ask) return turn;
    }
    return null;
  }
  const row = (await sql<{ source_account_id: string; source_event_id: string; payload: StoredTurn }>`SELECT
      source_account_id, source_event_id, payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id IN (${TURN_ACCOUNT}, ${INTENT_ACCOUNT})
      AND payload->>'chatId' = ${chatId} AND source_event_id <> ${String(updateId)} AND received_at > now() - interval '1 day'
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0];
  if (row?.source_account_id !== TURN_ACCOUNT) return null;
  const turn = parseReceipt(Number(row.source_event_id), row.payload);
  return turn?.ask ? turn : null;
}

interface DraftState {
  rev: number; stage: string; taskId: string; revisionId: string | null; taskState: string;
  chatId: string; title: string; requesterName: string | null;
}

async function draftState(trx: Kysely<Database>, tenantId: string, requestId: string): Promise<DraftState | null> {
  const row = (await sql<{ rev: string | number; stage: string; current_task_id: string; chat_id: string;
    current_design_revision_id: string | null; state: string; title: string | null; first_name: string | null; copy: unknown }>`
    SELECT r.rev, r.stage, r.current_task_id::text, r.chat_id, t.current_design_revision_id::text, t.state,
      coalesce(root.title, t.title) AS title, src.payload->'message'->'from'->>'first_name' AS first_name,
      (SELECT coalesce(e.data->'payload'->'exactCopy', e.data->'exactCopy') FROM hawa.task_events e
        WHERE e.tenant_id = r.tenant_id AND e.task_id = r.root_task_id AND e.event_type = 'task.created'
        ORDER BY e.aggregate_version LIMIT 1) AS copy
    FROM hawa.requests r
    JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
    LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
    LEFT JOIN hawa.inbox_events src ON src.tenant_id = r.tenant_id AND src.source_account_id = 'telegram'
      AND src.source_event_id = r.chat_id || ':lc-' || r.request_id::text || '-r0'
    WHERE r.tenant_id = ${tenantId}::uuid AND r.request_id = ${requestId}::uuid AND r.owner = 'restate'`.execute(trx)).rows[0];
  if (!row) return null;
  return { rev: Number(row.rev), stage: row.stage, taskId: row.current_task_id, revisionId: row.current_design_revision_id,
    taskState: row.state, chatId: row.chat_id, title: displayTitle(row.title, row.copy),
    requesterName: row.first_name?.trim() ? row.first_name.trim().slice(0, 60) : null };
}

/**
 * The Desk's approval evidence for the draft, bound to the picture this member was sent: the latest QA
 * run of the revision passed, its checked PPTX and the photo's PNG come from the one Canva capture it
 * checked, and the PNG is the photo's bytes. Null fields say why it cannot be approved here.
 */
async function approvalEvidence(trx: Kysely<Database>, tenantId: string, input: { chatId: string; requestId: string;
  rev: number; taskId: string; revisionId: string }): Promise<
  { ok: true; pinnedExportIds: string[]; rtlVisualReview?: { confirmed: true; exportSha256: string };
    visualCheck: Record<string, unknown> } | { ok: false; why: 'check' | 'desk' }> {
  const qc = (await sql<{ status: string; critical_pass: boolean | null; report: { exportArtifactId?: unknown; captureVersion?: unknown;
    rtlVisualReviewRequired?: unknown; exportSha256?: unknown } | null }>`SELECT status, critical_pass, report
    FROM hawa.qc_runs WHERE tenant_id = ${tenantId}::uuid AND task_id = ${input.taskId}::uuid
      AND design_revision_id = ${input.revisionId}::uuid ORDER BY started_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (!qc || qc.status !== 'passed' || qc.critical_pass !== true) return { ok: false, why: 'check' };
  const checkedId = qc.report?.exportArtifactId;
  const captureVersion = qc.report?.captureVersion;
  if (typeof checkedId !== 'string' || typeof captureVersion !== 'string' || !captureVersion) return { ok: false, why: 'desk' };
  // The photo this member was sent, as Core chose it for the alert of this revision, and its sent mark.
  type PhotoAlert = { chatId?: unknown; image?: { source?: unknown; taskId?: unknown; id?: unknown; sha256?: unknown } };
  const projected = (await sql<{ result: { officePhotoAlerts?: unknown } }>`SELECT result FROM hawa.lifecycle_projections
    WHERE tenant_id = ${tenantId}::uuid AND request_id = ${input.requestId}::uuid AND rev = ${input.rev}`.execute(trx)).rows[0];
  const photo = Array.isArray(projected?.result?.officePhotoAlerts)
    ? (projected.result.officePhotoAlerts as PhotoAlert[]).find((a) => a?.chatId === input.chatId) : undefined;
  const messageId = await alertSentTo(trx, tenantId, input.chatId, input.requestId, input.rev);
  const image = photo?.image;
  if (!image || image.source !== 'canva_export' || image.taskId !== input.taskId || typeof image.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image.id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(checkedId) ||
      !messageId) return { ok: false, why: 'desk' };
  const files = (await sql<{ id: string; format: string; sha256: string; capture_version: string | null }>`SELECT b.id::text, b.format, b.sha256,
      o.metadata->>'designUpdatedAt' AS capture_version
    FROM hawa.canva_export_bytes b
    JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
    WHERE b.tenant_id = ${tenantId}::uuid AND b.task_id = ${input.taskId}::uuid
      AND b.id IN (${image.id}::uuid, ${checkedId}::uuid)`.execute(trx)).rows;
  const png = files.find((f) => f.id === image.id && f.format === 'png' && f.sha256 === image.sha256);
  const pptx = files.find((f) => f.id === checkedId && f.format === 'pptx');
  if (!png || !pptx || png.capture_version !== captureVersion || pptx.capture_version !== captureVersion) return { ok: false, why: 'desk' };
  return { ok: true, pinnedExportIds: [png.id, pptx.id],
    ...(qc.report?.rtlVisualReviewRequired === true && typeof qc.report.exportSha256 === 'string'
      ? { rtlVisualReview: { confirmed: true as const, exportSha256: qc.report.exportSha256 } } : {}),
    visualCheck: { channel: 'telegram_photo', chatId: input.chatId, messageId, requestRev: input.rev,
      imageSha256: png.sha256, exportArtifactId: png.id } };
}

// ---------------------------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------------------------

export interface OfficeTurnDeps { db: Kysely<Database>; deliverableStore: DeliverableStore; tenantId: string }
export type OfficeTurnAnswer = { status: number; extra: Record<string, unknown> };

/**
 * Handles an office member's words about a draft, or answers null when the update is not that (intake
 * then reads it as before). The answer is a chat answer to the member, recorded once per update.
 */
export async function officeTelegramTurn(deps: OfficeTurnDeps, update: Record<string, unknown>): Promise<OfficeTurnAnswer | null> {
  const message = officeMessageOf(update);
  if (!message) return null;
  const { db, tenantId } = deps;
  const tx = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, SYSTEM(tenantId), fn);
  let receipt = await tx((trx) => readTurn(trx, tenantId, message.updateId));
  if (receipt && receipt.chatId !== message.chatId) return { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } };
  if (receipt?.answer) return receipt.answer;
  if (!receipt) {
    const plan = await tx((trx) => planOf(trx, tenantId, message));
    if (!plan) return null;
    const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    receipt = await tx((trx) => recordTurn(trx, tenantId, { updateId: message.updateId, chatId: message.chatId,
      messageId: message.messageId, lang: requesterLang(message.text), plan }, hash));
  }
  const outcome = await carryOut(deps, receipt);
  if (outcome.retry) return outcome.retry;
  const answer: OfficeTurnAnswer = { status: 200, extra: { lifecycleAction: 'chat-answer', chatId: message.chatId,
    chatAnswer: { text: outcome.text, parseMode: 'HTML' }, officeTurn: receipt.plan.kind === 'decide' ? receipt.plan.intent : receipt.plan.kind } };
  await tx((trx) => extendTurn(trx, tenantId, message.updateId, { answer, ...(outcome.ask ? { ask: outcome.ask } : {}) }));
  return answer;
}

async function planOf(trx: Kysely<Database>, tenantId: string, m: OfficeMessage): Promise<OfficePlan | null> {
  const reading = readOfficeIntent(m.text);
  if (m.replyTo) {
    const alert = await officeAlertFor(trx, tenantId, m.chatId, m.replyTo);
    if (alert) {
      return reading.intent === 'unclear' ? { kind: 'ask-what', requestId: alert.requestId, alertRev: alert.rev }
        : { kind: 'decide', intent: reading.intent, requestId: alert.requestId, alertRev: alert.rev, words: m.text,
          ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}) };
    }
    const asked = await openAsk(trx, tenantId, m.chatId, m.updateId, m.replyTo);
    if (!asked) return null;
    const ask = asked.ask!;
    // Words in reply to the bot's question that do not answer it: asked again, plainly.
    return answerTo(ask, m.text) ?? (ask.kind === 'ask-which' ? { ...ask }
      : ask.kind === 'ask-what' || ask.kind === 'ask-late' ? { kind: 'ask-what', requestId: ask.requestId, alertRev: ask.alertRev } : null);
  }
  const asked = await openAsk(trx, tenantId, m.chatId, m.updateId, null);
  const answered = asked ? answerTo(asked.ask!, m.text) : null;
  if (answered) return answered;
  // With no reply, only words that clearly decide are the office's; the rest (the owner's own briefs,
  // questions, thanks) are read by intake as before.
  if (reading.intent === 'unclear' || (reading.intent === 'change' && asksForNewDesign(m.text))) return null;
  // A change with no reply from a member who has designs of their own on the way (the owner as a
  // requester) is about their own design: requester routing places it, never on someone else's draft.
  const own = await ownOpenRequests(trx, tenantId, m.chatId);
  if (reading.intent === 'change' && own) return null;
  // ADR-182: so is a cancellation ("cancel that"). Approval or rejection words with no reply from such a
  // member ("ok send it when it's ready") may be about their own design too: the one waiting draft is
  // named and asked about, never decided by guess.
  if (own && reading.intent === 'reject' && reading.rejectionCategory === 'task') return null;
  const queue = await officeQueue(trx, tenantId, m.chatId);
  if (!queue.length) return null;
  const decision = { intent: reading.intent, words: m.text,
    ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}) };
  if (queue.length === 1 && !own) return { kind: 'decide', ...decision, requestId: queue[0].requestId, alertRev: null };
  // ADR-040 addendum (2026-10-01): with several waiting, words with no reply are about the draft this
  // member was sent last, when it came within two hours and no other came close to it. The answer
  // names that draft first, so a wrong guess shows. A member with designs of their own on the way is
  // still asked (ADR-182): their words may be about those.
  const last = own ? null : lastSentDraft(queue, Date.now());
  if (last) return { kind: 'decide', ...decision, requestId: last.requestId, alertRev: null, lastSent: last.sentAt };
  return { kind: 'ask-which', ...decision, options: queue };
}

/** "the newest", "latest one", "the most recent"; Sorani "the newest", "the latest". */
const NEWEST = /^(?:(?:the\s+)?(?:newest|latest|most\s+recent)(?:\s+(?:one|draft|design))?|نوێترین(?:یان)?|دواهەمین)[\s.!]*$/iu;

/** The member's answer to the bot's question, as a decision, or null when the words do not answer it. */
function answerTo(ask: OfficePlan, text: string): OfficePlan | null {
  if (ask.kind === 'ask-which') {
    // A brief or a change of the member's own is not an answer, even if it shares a word with a title.
    if (asksForNewDesign(text) || ['new_brief', 'change'].includes(readIntentByRules(text).intent)) return null;
    // The list is newest first: "the newest" is its first line (parseChoice takes "latest" as the last).
    const choice = NEWEST.test(corePhrase(text)) ? { option: 0 } : parseChoice(text, { options: ask.options, allowNew: false });
    if (!choice || !('option' in choice)) return null;
    return { kind: 'decide', intent: ask.intent, requestId: ask.options[choice.option].requestId, alertRev: null, words: ask.words,
      ...(ask.rejectionCategory ? { rejectionCategory: ask.rejectionCategory } : {}) };
  }
  if (ask.kind === 'ask-what' || ask.kind === 'ask-late') {
    const reading = readOfficeIntent(text);
    if (reading.intent === 'unclear') return null;
    return { kind: 'decide', intent: reading.intent, requestId: ask.requestId, alertRev: ask.alertRev, words: text,
      ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}),
      ...(ask.kind === 'ask-late' ? { acknowledge: ask.updateIds } : {}) };
  }
  return null;
}

type Outcome = { text: string; ask?: OfficePlan; retry?: undefined } | { retry: OfficeTurnAnswer };

/**
 * Carries out the plan. Words with no reply that were taken to be about the draft last sent to this
 * member (ADR-040 addendum, 2026-10-01) are answered with that draft named first, and when it was sent.
 */
async function carryOut(deps: OfficeTurnDeps, receipt: TurnReceipt): Promise<Outcome> {
  const outcome = await carryOutPlan(deps, receipt);
  const plan = receipt.plan;
  if (outcome.retry || plan.kind !== 'decide' || !plan.lastSent) return outcome;
  const state = await withRlsContext(deps.db, SYSTEM(deps.tenantId), (trx) => draftState(trx, deps.tenantId, plan.requestId));
  const about = say(OFFICE_MESSAGES.aboutDraft, receipt.lang,
    { title: bold(state?.title ?? '?'), when: whenText(Date.parse(plan.lastSent), Date.now(), receipt.lang) });
  return { ...outcome, text: `${about}\n${outcome.text}` };
}

async function carryOutPlan(deps: OfficeTurnDeps, receipt: TurnReceipt): Promise<Outcome> {
  const { db, tenantId } = deps;
  const tx = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, SYSTEM(tenantId), fn);
  const lang = receipt.lang;
  const plan = receipt.plan;
  const phrase = (p: Phrase, params: Record<string, string> = {}) => say(p, lang, params);
  if (plan.kind === 'ask-which') return { text: phrase(OFFICE_MESSAGES.whichDraft, { list: choiceList(plan.options, lang, Date.now()) }), ask: plan };
  const state = await tx((trx) => draftState(trx, tenantId, plan.requestId));
  if (!state) return { text: phrase(OFFICE_MESSAGES.notRecorded, { title: bold('?') }) };
  const title = bold(state.title);
  const requester = state.chatId === receipt.chatId ? phrase(OFFICE_MESSAGES.you)
    : state.requesterName ? bold(state.requesterName) : phrase(OFFICE_MESSAGES.theRequester);
  if (plan.kind === 'ask-what') return { text: phrase(OFFICE_MESSAGES.whatToDo, { title }), ask: plan };

  // The draft the member answered must be the one still waiting; someone may have decided first. A
  // replay of this turn's own recorded decision is sent again as it was (the Desk's receipts answer it).
  const decided = await priorDecision(db, tenantId, receipt);
  if (!decided) {
    const alertRev = plan.alertRev ?? state.rev;
    if (state.stage !== 'in_review' || state.taskState !== 'human_review' || !state.revisionId) {
      return { text: stageWords(state.stage, phrase, title) };
    }
    if (alertRev !== state.rev) return { text: phrase(OFFICE_MESSAGES.olderDraft, { title }) };
  }
  if (namedOfficeReviewMode()) return { text: phrase(OFFICE_MESSAGES.namedReviewer, { title }) };
  if (plan.kind !== 'decide') return { text: phrase(OFFICE_MESSAGES.whatToDo, { title }), ask: plan };

  const target = receipt.target ?? { taskId: state.taskId, revisionId: state.revisionId! };
  if (!receipt.target) await tx((trx) => extendTurn(trx, tenantId, receipt.updateId, { target }));
  const actionId = officeActionId(receipt.chatId, receipt.updateId, plan.intent);
  const rev = plan.alertRev ?? state.rev;
  const telegram = { chatId: receipt.chatId, updateId: receipt.updateId, messageId: receipt.messageId };
  const base = { tenantId, taskId: target.taskId, revisionId: target.revisionId, requestId: plan.requestId, actionId,
    auth: OFFICE_ACTOR, officeRole: OFFICE_ACTOR.role, reviewerSessionHash: null, telegramChatId: receipt.chatId };
  const words = plan.words.slice(0, 2000);

  if (plan.intent === 'approve') {
    let body = receipt.approval;
    if (!body) {
      if (!decided) {
        // Words the requester sent after the draft reached the office are read before approving (finding 13).
        const unread = await tx(async (trx) => {
          const pending = await pendingLateChanges(trx, tenantId, plan.requestId);
          const done = new Set(await acknowledgedLateChanges(trx, tenantId, plan.requestId));
          return pending.filter((change) => !done.has(change.updateId) && !(plan.acknowledge ?? []).includes(change.updateId));
        });
        if (unread.length) {
          const ask: OfficePlan = { kind: 'ask-late', requestId: plan.requestId, alertRev: rev,
            updateIds: [...new Set([...(plan.acknowledge ?? []), ...unread.map((c) => c.updateId)])] };
          return { text: lateText(phrase, requester, title, unread.map((c) => c.text)), ask };
        }
      }
      const evidence = await tx((trx) => approvalEvidence(trx, tenantId, { chatId: receipt.chatId, requestId: plan.requestId,
        rev, taskId: target.taskId, revisionId: target.revisionId }));
      if (!evidence.ok) return { text: phrase(evidence.why === 'check' ? OFFICE_MESSAGES.checkFailed : OFFICE_MESSAGES.useDesk, { title }) };
      body = { action: 'approve', reason: `Approved in Telegram by office member ${receipt.chatId}, on the draft's picture`,
        pinnedExportIds: evidence.pinnedExportIds, ...(evidence.rtlVisualReview ? { rtlVisualReview: evidence.rtlVisualReview } : {}),
        telegram: { ...telegram, visualCheck: evidence.visualCheck } };
      // The body is read back as stored, so the first send and every replay carry the same bytes (the
      // Desk's fingerprint of a retried action is over its body, and JSONB orders keys its own way).
      body = await tx(async (trx) => {
        await extendTurn(trx, tenantId, receipt.updateId, { approval: body });
        return (await readTurn(trx, tenantId, receipt.updateId))?.approval;
      });
      if (!body) throw new Error('The office approval was not stored');
    }
    const approved = await decideRequestOwned({ db, deliverableStore: deps.deliverableStore }, { ...base, body,
      isOwnedApproval: true, isOwnedRejection: false, revisionRequest: null, rejectionCategory: null,
      pinIds: (body.pinnedExportIds as string[]) ?? [] });
    if (!approved.ok) return refusal(approved, db, tenantId, plan.requestId, phrase, title);
    const delivery = await startRequestOwnedDelivery({ db }, { tenantId, taskId: target.taskId, requestId: plan.requestId,
      actionId: officeActionId(receipt.chatId, receipt.updateId, 'deliver'), auth: OFFICE_ACTOR, officeRole: OFFICE_ACTOR.role,
      body: { approvalId: approved.body.decisionId, ...(plan.acknowledge?.length ? { acknowledgeLateChanges: plan.acknowledge } : {}) },
      instance: 'telegram-office', reason: `Deliver approved files (approved in Telegram by office member ${receipt.chatId})` });
    if (delivery.ok && delivery.body.code === 'LATE_REQUESTER_CHANGE') {
      const late = Array.isArray(delivery.body.lateChanges) ? delivery.body.lateChanges as Array<{ text?: string }> : [];
      return { text: phrase(OFFICE_MESSAGES.approvedNotSent, { requester, title, words: quoted(late.map((c) => String(c.text ?? ''))) }) };
    }
    if (delivery.ok) return { text: phrase(OFFICE_MESSAGES.approvedSending, { title, requester }) };
    if (delivery.status === 503) return { retry: { status: 503, extra: { code: 'OFFICE_DECISION_UNCERTAIN' } } };
    log.warn(`[core:office-telegram] delivery of request ${plan.requestId} not started: ${delivery.status} ${delivery.title}`);
    return { text: phrase(OFFICE_MESSAGES.approvedSendFailed, { title }) };
  }

  if (plan.intent === 'change') {
    const revisionRequest: StructuredRevisionRequest = { scope: 'full_design', category: 'aesthetic_preference', targetNodes: [],
      priority: 'medium', isReusableFeedback: false, comment: words };
    const sent = await decideRequestOwned({ db, deliverableStore: deps.deliverableStore }, { ...base,
      body: { action: 'revision_requested', revisionRequest, telegram }, isOwnedApproval: false, isOwnedRejection: false,
      revisionRequest, rejectionCategory: null, pinIds: [] });
    if (!sent.ok) return refusal(sent, db, tenantId, plan.requestId, phrase, title, true);
    return { text: state.chatId === receipt.chatId ? phrase(OFFICE_MESSAGES.sentBackOwn, { title })
      : phrase(OFFICE_MESSAGES.sentBack, { title, requester }) };
  }

  const category = plan.rejectionCategory ?? 'concept';
  const rejected = await decideRequestOwned({ db, deliverableStore: deps.deliverableStore }, { ...base,
    body: { action: 'reject', rejectionCategory: category, reason: words, telegram }, isOwnedApproval: false, isOwnedRejection: true,
    revisionRequest: null, rejectionCategory: category, pinIds: [] });
  if (!rejected.ok) return refusal(rejected, db, tenantId, plan.requestId, phrase, title);
  return { text: phrase(OFFICE_MESSAGES.rejected, { title, requester }) };
}

/** Whether this turn's own decision is already recorded (a replay after the request moved on). */
async function priorDecision(db: Kysely<Database>, tenantId: string, receipt: TurnReceipt): Promise<boolean> {
  if (receipt.plan.kind !== 'decide') return false;
  const actionId = officeActionId(receipt.chatId, receipt.updateId, receipt.plan.intent);
  return withRlsContext(db, SYSTEM(tenantId), async (trx) => Boolean(await trx.selectFrom('approvals').select('id')
    .where('tenant_id', '=', tenantId).where('nonce', '=', `desk:${actionId}`).executeTakeFirst()));
}

function stageWords(stage: string, phrase: (p: Phrase, params?: Record<string, string>) => string, title: string): string {
  if (['approved', 'delivering', 'delivered'].includes(stage)) return phrase(OFFICE_MESSAGES.alreadyApproved, { title });
  if (stage === 'rejected') return phrase(OFFICE_MESSAGES.alreadyRejected, { title });
  if (stage === 'manual') return phrase(OFFICE_MESSAGES.alreadySentBack, { title });
  return phrase(OFFICE_MESSAGES.notWaiting, { title });
}

/** Iraq's clock (UTC+3, no daylight saving): the office's day and time. */
const IRAQ_OFFSET_MS = 3 * 60 * 60_000;
const iraqDay = (at: number) => Math.floor((at + IRAQ_OFFSET_MS) / 86_400_000);

/** When a draft was sent, as the member says it: "just now", "12 minutes ago", "yesterday 20:41", "3 days ago". */
export function whenText(at: number, now: number, lang: RequesterLang): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return say(OFFICE_MESSAGES.justNow, lang);
  if (minutes < 2) return say(OFFICE_MESSAGES.aMinuteAgo, lang);
  if (minutes < 60) return say(OFFICE_MESSAGES.minutesAgo, lang, { n: minutes });
  const local = new Date(at + IRAQ_OFFSET_MS);
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const days = iraqDay(now) - iraqDay(at);
  if (days <= 0) return say(OFFICE_MESSAGES.todayAt, lang, { time });
  if (days === 1) return say(OFFICE_MESSAGES.yesterdayAt, lang, { time });
  return say(OFFICE_MESSAGES.daysAgo, lang, { n: days });
}

/**
 * The numbered "which draft?" list, newest first, each line with what tells it apart: when it was sent,
 * its photo count, "newest" on the first, and who asked for it when they are not all the same person.
 */
export function choiceList(options: readonly QueuedDraft[], lang: RequesterLang, now: number): string {
  const requesters = new Set(options.map((o) => (o.own ? 'you' : `${o.requester ?? ''}`)));
  const comma = lang === 'ckb' ? '، ' : ', ';
  return options.map((o, i) => {
    const photos = o.photos ?? 0;
    const facts = [
      o.sentAt ? say(OFFICE_MESSAGES.sentWhen, lang, { when: whenText(Date.parse(o.sentAt), now, lang) }) : '',
      photos === 0 ? say(OFFICE_MESSAGES.noPhotos, lang) : photos === 1 ? say(OFFICE_MESSAGES.onePhoto, lang)
        : say(OFFICE_MESSAGES.photos, lang, { n: photos }),
      i === 0 && options.length > 1 ? say(OFFICE_MESSAGES.newest, lang) : '',
      requesters.size > 1 ? say(OFFICE_MESSAGES.fromRequester, lang, { requester: o.own ? say(OFFICE_MESSAGES.you, lang)
        : o.requester ? escapeTelegramHtml(o.requester) : say(OFFICE_MESSAGES.theRequester, lang) }) : '',
    ].filter(Boolean);
    return `${i + 1}. ${bold(o.title)} (${facts.join(comma)})`;
  }).join('\n');
}

const quoted = (texts: string[]) => texts.filter((t) => t.trim()).slice(0, 5)
  .map((t) => `«${escapeTelegramHtml(t.length > 600 ? `${t.slice(0, 600)}…` : t)}»`).join('\n') || '«…»';

function lateText(phrase: (p: Phrase, params?: Record<string, string>) => string, requester: string, title: string, words: string[]): string {
  return phrase(OFFICE_MESSAGES.lateWords, { requester, title, words: quoted(words) });
}

/** What the member is told when the Desk's path refused: truthfully, by what happened. */
async function refusal(answer: Extract<OfficeActionAnswer, { ok: false }>, db: Kysely<Database>, tenantId: string, requestId: string,
  phrase: (p: Phrase, params?: Record<string, string>) => string, title: string, revise = false): Promise<Outcome> {
  if (answer.status === 503) return { retry: { status: 503, extra: { code: 'OFFICE_DECISION_UNCERTAIN' } } };
  if (answer.status === 412) return { text: phrase(OFFICE_MESSAGES.checkFailed, { title }) };
  if (answer.status === 422) return { text: phrase(OFFICE_MESSAGES.useDesk, { title }) };
  if (answer.status === 409) {
    // Someone decided first (the Desk, another member), or the draft changed: say what it is now.
    const now = await withRlsContext(db, SYSTEM(tenantId), (trx) => draftState(trx, tenantId, requestId));
    if (now && now.stage !== 'in_review') return { text: stageWords(now.stage, phrase, title) };
    // Still waiting: a request opened for a designer by hand has no automatic next round (ADR-126).
    if (revise && answer.title === 'Stale Lifecycle Decision') return { text: phrase(OFFICE_MESSAGES.madeByHand, { title }) };
  }
  log.warn(`[core:office-telegram] decision on request ${requestId} refused: ${answer.status} ${answer.title}`);
  return { text: phrase(OFFICE_MESSAGES.notRecorded, { title }) };
}
