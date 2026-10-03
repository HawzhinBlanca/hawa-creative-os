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
 * (requester-turn.ts) plus a few office phrases.
 *
 * ADR-200 (owner, 2026-10-01: "the chat from telegram should work like a chat"): when those rules are
 * not certain, the words are also read by a model in the context of the chat (office-intent-model.ts):
 * the drafts waiting, which picture this member saw last, their last messages and the bot's answers.
 * The model is advice. Refusing or negating words never approve, an approval needs a clear target,
 * and an approval that would send a draft to someone other than this member is first asked about
 * ("Send <title> to <requester> now?"); a plain yes sends that revision, anything else is a new turn.
 * The conversation names drafts too: "the other one", "the one for Sewa", "the earlier draft", and
 * words right after the bot asked about a draft are about that draft. Without the model (off, failed,
 * or refused by the office's allowance) the rules decide alone, as before.
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
import type { OfficeIntentModel, OfficeModelDecision, OfficeModelLine } from './office-intent-model.js';
import { activeChatRequests } from './requester-turn-store.js';
import { REDO_WINDOW_DAYS, asksForNewDesign, corePhrase, parseChoice, readIntentByRules, readsAsChange, readsAsRedo, refusesApproval,
  saysMoreThanRefusal, titleMatch } from './requester-turn.js';

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
/**
 * "no, cancel this", "cancel it": a rejection of the whole design (category `task`). Hunt 3 (2026-10-03): "forget it"
 * is a dismissal like "never mind" (ADR-272), not a rejection; "forget the design" names what it rejects.
 */
const OFFICE_CANCEL = /^(?:no[\s,،!.]+)?(?:(?:cancel|scrap|drop)(?:\s+(?:it|this|that|the\s+design))?|forget\s+(?:about\s+)?the\s+design)[\s!.]*$/iu;
/**
 * ADR-253 (live 2026-10-02, L20): a polite request around cancelling words: "could you please cancel …",
 * "can you drop it?", "would you kindly cancel this". The requester rules strip a leading "please", not
 * "could you please", so "could you please cancel the Quality Assurance Workshop poster, we don't need it
 * anymore" read as nothing, the model's rejection was refused for want of rejecting words, and the owner
 * was asked "What should I do with …?". Read for cancelling only: what remains must cancel by itself.
 */
const POLITE_ASK = /^(?:(?:could|can|would|will)\s+(?:you|u)(?:\s+(?:please|pls|kindly|just))*\s+|(?:i|we)(?:'d|\s+would)\s+like\s+(?:you\s+)?to\s+|(?:please|pls|kindly)\s+)+/iu;
function cancelsPolitely(core: string): boolean {
  const asked = core.replace(POLITE_ASK, '');
  if (asked === core || !asked) return false;
  const rest = asked.replace(/[\s?؟]+$/u, '');
  const reading = readIntentByRules(rest);
  return OFFICE_CANCEL.test(rest) || (reading.intent === 'cancel' && !reading.bareCancel);
}

/**
 * Approval words that refuse it ("the design is not approved", "don't send it", "I can't approve this")
 * are found by the requester rules' refusal reading (requester-turn.ts `refusesApproval`). The owner's
 * words of 2026-10-01 ("the design is not approved, the images cut with no content awareness, should
 * have more images…") read as approval, because "approved" is an approval phrase and nothing after it
 * read as a change.
 */

/**
 * The version of the rules that read an office member's words. A question the bot asked (a pending
 * choice) is stamped with it; an answer to a question asked under another version, or longer ago than
 * `PENDING_ASK_MS`, does nothing and is told so (ADR-040 addendum, incident 2026-10-01: a "which
 * draft?" saved under the old rules held an approval reading of "the design is not approved, …", and
 * "3" an hour later, after the fix was deployed, applied it). Raise it whenever the reading changes:
 * 3 is ADR-200 (the model reading, the conversation's references and the send confirmation).
 */
export const OFFICE_TURN_RULES = 3;
/** How long a question the bot asked an office member stays open. */
export const PENDING_ASK_MS = 30 * 60_000;
/** Negation anywhere in kept words: approval reached through a choice must have none. */
const NEGATION = /\b(?:not|no|nope|never|nothing|none|neither|nor|without|wrong|bad|but|however|except)\b|n'?t\b|(?:^|[\s,،.!])(?:نا|نەخێر|نەک)(?=$|[\s,،.!])|(?:نییە|نەکراوە|ناکەم|ناکەین|ناوێت|مە[یی]?نێر|نە[یی]?نێر)/iu;

/**
 * Whether kept words are an approval and nothing else, by the current rules: they read as approval,
 * refuse nothing, negate nothing, ask nothing and ask for no change. Approval reached by answering a
 * numbered or named choice requires it; otherwise the member is asked (ADR-040 addendum, 2026-10-01).
 */
export function unambiguousApproval(words: string): boolean {
  const t = String(words ?? '').trim();
  return readOfficeIntent(t).intent === 'approve' && !refusesApproval(t) && !NEGATION.test(t) && !/[?؟]/u.test(t) &&
    !readsAsChange(t) && readIntentByRules(t).intent !== 'change';
}

/**
 * What an office member's words mean for a draft. A change mixed with approval ("ok but make the title
 * bigger") is a change: nothing is approved until the words say nothing else.
 */
export function readOfficeIntent(text: string): { intent: OfficeIntent; rejectionCategory?: RejectionCategory } {
  const t = String(text ?? '').trim();
  if (!t || t.startsWith('/')) return { intent: 'unclear' };
  const core = corePhrase(t);
  if (OFFICE_CANCEL.test(core) || OFFICE_CANCEL.test(t) || cancelsPolitely(core)) return { intent: 'reject', rejectionCategory: 'task' };
  // A refusal is never approval. With anything said about the draft it is what to change ("not approved,
  // the photos are cropped badly"); "not approved" alone rejects; "not good", "don't send it" alone are
  // asked about.
  const refuses = refusesApproval(t);
  if (refuses && saysMoreThanRefusal(t)) return { intent: 'change' };
  if (OFFICE_REJECT.test(core) || OFFICE_REJECT.test(t)) return { intent: 'reject', rejectionCategory: 'concept' };
  if (refuses) return /approv|پەسەند/iu.test(t) ? { intent: 'reject', rejectionCategory: 'concept' } : { intent: 'unclear' };
  // A new brief ("make a poster for Nawroz") is never a change to a draft: intake opens it as before.
  if (asksForNewDesign(t)) return { intent: 'unclear' };
  const reading = readIntentByRules(t);
  if (reading.intent === 'new_brief') return { intent: 'unclear' };
  if (reading.intent === 'change' || readsAsChange(t)) return { intent: 'change' };
  // Hunt 3 (2026-10-03): a cancel that names nothing ("never mind", "stop", "no need", "forget it") may be about the
  // last thing said, as a requester's is (ADR-251): it rejected the only waiting draft with no question. It is
  // unclear: with a reply the member is asked what to do; without one, intake reads it.
  if (reading.intent === 'cancel' && !reading.bareCancel) return { intent: 'reject', rejectionCategory: 'task' };
  const approves = reading.intent === 'approval' || OFFICE_APPROVE.test(core) || OFFICE_APPROVE.test(t.replace(/\s+/g, ' '));
  // "approved?", "is it approved?" ask; they approve nothing.
  if (approves && !/[?؟]\s*$/u.test(t)) return { intent: 'approve' };
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
      lastSent?: string;
      /** ADR-200: how the draft was found (a reply, the only one waiting, the conversation, a name, the model…). */
      basis?: TargetBasis;
      /**
       * ADR-200: approval said "yes" to the bot's "Send … now?", or "send it anyway" after the requester's
       * late words were shown: it is not asked about again.
       */
      confirmed?: boolean;
      /** ADR-200: the revision a confirmation named; it approves no other. */
      revisionId?: string;
      /** ADR-200: approval asked about whoever asked for the draft: its words or its target are not certain. */
      needsConfirm?: boolean;
      /** ADR-200: a "yes" to a confirmation asked too long ago or under other rules: asked again. */
      again?: boolean }
  /**
   * "Which draft?": the member's words are kept, never what they were read as. The answer reads them
   * again by the rules of its own time (ADR-040 addendum, incident 2026-10-01).
   */
  | { kind: 'ask-which'; words: string; options: QueuedDraft[] }
  /** "What should I do with …?" (with `facts`: who asked for it, when it came, its photos, first). */
  | { kind: 'ask-what'; requestId: string; alertRev: number | null; facts?: boolean }
  | { kind: 'ask-late'; requestId: string; alertRev: number | null; updateIds: string[] }
  /**
   * ADR-200: "Send <title> to <requester> now?", stamped with the revision it names. A plain yes in
   * any language approves that revision; a plain no sends nothing; anything else is a new turn.
   */
  | { kind: 'ask-send'; requestId: string; rev: number; revisionId: string }
  /** ADR-200: a plain no (or "cancel") to "Send … now?": nothing is sent or decided. */
  | { kind: 'not-sent'; requestId: string }
  /** An answer to a question asked too long ago or under other rules: nothing is done. */
  | { kind: 'lost-track' }
  /**
   * ADR-239: the member cancelled a request of their own in their own words. It is theirs as its
   * requester: intake reads the words and withdraws it (ADR-230); the office turn answers nothing.
   */
  | { kind: 'requester-withdraw'; requestId: string };

/** ADR-200: how the decision's draft was found. */
export type TargetBasis = 'reply' | 'only' | 'discussion' | 'last-shown' | 'choice' | 'words' | 'model' | 'confirm';

/** ADR-200: what read the words (kept on the turn's receipt). */
export type ReadingNote = { source: 'rules'; consulted?: boolean } |
  { source: 'model'; kind: OfficeModelDecision['kind']; draft: number; confidence: number };

interface TurnReceipt {
  updateId: number; chatId: string; messageId: string | null; lang: RequesterLang; plan: OfficePlan;
  /** ADR-200: the member's words (the chat's history for the next reading), and what read them. */
  text?: string; reading?: ReadingNote;
  /** The draft the decision was first sent for, so a replay names the same task and revision. */
  target?: { taskId: string; revisionId: string };
  /** The approval body as first built (pins, visual check), so a replay sends the same decision. */
  approval?: Record<string, unknown>;
  /** A question the answer asked (the next message may answer it). */
  ask?: OfficePlan;
  /** The rules version the question was asked under, and when (ISO): see `OFFICE_TURN_RULES`. */
  askRules?: number; askedAt?: string;
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

/**
 * The message id of the draft picture this member was sent for a request's revision (their sent mark),
 * or null. ADR-253: an alert whose picture could not be sent went as its words (the worker marks it
 * `pictureNotSent`): the member saw no picture, so it is not one.
 */
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
    if (m && chat === chatId && typeof row.payload?.messageId === 'string') return row.payload.pictureNotSent === true ? null : row.payload.messageId;
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
  /** ADR-200: whose draft it is (a model reading needs every client's consent). */
  clientId?: string | null;
}

/**
 * ADR-200: who asked for a request, when its opening message did not keep the Telegram update (a typed
 * brief): the first name on the latest intake decision of its private chat (`senderName`).
 */
const REQUESTER_NAME = sql`(SELECT i.payload->>'senderName' FROM hawa.inbox_events i
  WHERE i.tenant_id = r.tenant_id AND i.source_account_id = 'lifecycle_chat_intent' AND i.payload->>'chatId' = r.chat_id
    AND i.payload->>'senderId' = r.chat_id AND i.payload ? 'senderName' ORDER BY i.received_at DESC, i.id DESC LIMIT 1)`;

/** At most this many drafts are listed, newest first. */
const QUEUE_LIST = 5;

/**
 * The drafts waiting in the office queue (request-owned, in review, the task awaiting its decision),
 * newest first by when this member was sent each one's alert, with the facts that tell them apart.
 * ADR-231 (live 2026-10-01 14:03Z): only drafts that can still be decided: the task has a current
 * revision, and that revision has no approval standing (one not invalidated). "Which draft do you
 * mean?" listed two designs already approved beside the one waiting.
 */
async function officeQueue(trx: Kysely<Database>, tenantId: string, chatId: string): Promise<QueuedDraft[]> {
  const first = officeChatIds()[0] ?? '';
  return (await sql<{ request_id: string; title: string | null; copy: unknown; photos: string | number; chat_id: string;
    first_name: string | null; alerted_at: Date | string | null; updated_at: Date | string; client_id: string | null }>`SELECT r.request_id::text,
      coalesce(root.title, t.title) AS title, r.chat_id, r.updated_at, t.client_id::text AS client_id,
      coalesce(src.payload->'message'->'from'->>'first_name', ${REQUESTER_NAME}) AS first_name,
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
    WHERE r.tenant_id = ${tenantId}::uuid AND r.owner = 'restate' AND r.stage = 'in_review' AND t.state = 'human_review'
      AND t.current_design_revision_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hawa.approvals a WHERE a.tenant_id = t.tenant_id AND a.task_id = t.id
        AND a.design_revision_id = t.current_design_revision_id AND a.decision = 'approved'
        AND NOT EXISTS (SELECT 1 FROM hawa.task_events i WHERE i.tenant_id = a.tenant_id AND i.task_id = a.task_id
          AND i.event_type = 'approval.invalidated' AND i.data->>'invalidatedApprovalId' = a.id::text))`.execute(trx)).rows
    .map((row) => ({ requestId: row.request_id, title: displayTitle(row.title, row.copy),
      sentAt: new Date(row.alerted_at ?? row.updated_at).toISOString(), alerted: row.alerted_at !== null,
      photos: Number(row.photos) || 0, requester: row.first_name?.trim() ? row.first_name.trim().slice(0, 60) : null,
      own: row.chat_id === chatId, clientId: row.client_id }))
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

/** ADR-200 addendum: whether this chat has a design of its own on the way or delivered in the last week. */
async function ownRecentDesign(trx: Kysely<Database>, tenantId: string, chatId: string): Promise<boolean> {
  return (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.requests WHERE tenant_id = ${tenantId}::uuid
    AND chat_id = ${chatId} AND owner = 'restate' AND (stage IN ('designing', 'awaiting_answer', 'manual', 'approved', 'delivering')
      OR (stage = 'delivered' AND updated_at > now() - make_interval(days => ${REDO_WINDOW_DAYS}::int))) LIMIT 1`.execute(trx)).rows.length > 0;
}

/** A draft's name for the office, cleaned as it is read (draft-title.ts): old titles show as new ones. */
const displayTitle = (value: string | null | undefined, copy?: unknown) => {
  const t = cleanDraftTitle(value, copy) || 'Untitled design';
  return Array.from(t).length > 80 ? `${Array.from(t).slice(0, 79).join('')}…` : t;
};

/** A stored turn as JSON: every field is checked before it is used. */
interface StoredTurn {
  chatId?: unknown; messageId?: unknown; lang?: unknown; plan?: { kind?: unknown }; text?: unknown;
  target?: { taskId?: unknown; revisionId?: unknown }; approval?: Record<string, unknown>; ask?: unknown;
  askRules?: unknown; askedAt?: unknown;
  answer?: { status?: unknown; extra?: Record<string, unknown> };
}

function parseReceipt(updateId: number, payload: StoredTurn | undefined): TurnReceipt | null {
  if (!payload || typeof payload.chatId !== 'string' || !payload.plan || typeof payload.plan.kind !== 'string') return null;
  const target = payload.target;
  const answer = payload.answer;
  return { updateId, chatId: payload.chatId, messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
    lang: payload.lang === 'ckb' ? 'ckb' : 'en', plan: payload.plan as OfficePlan,
    ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
    ...(target && typeof target.taskId === 'string' && typeof target.revisionId === 'string'
      ? { target: { taskId: target.taskId, revisionId: target.revisionId } } : {}),
    ...(payload.approval ? { approval: payload.approval } : {}), ...(payload.ask ? { ask: payload.ask as OfficePlan } : {}),
    ...(typeof payload.askRules === 'number' ? { askRules: payload.askRules } : {}),
    ...(typeof payload.askedAt === 'string' ? { askedAt: payload.askedAt } : {}),
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
  const payload = { chatId: receipt.chatId, messageId: receipt.messageId, lang: receipt.lang, plan: receipt.plan,
    ...(receipt.text !== undefined ? { text: receipt.text } : {}), ...(receipt.reading ? { reading: receipt.reading } : {}) };
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
      coalesce(root.title, t.title) AS title, coalesce(src.payload->'message'->'from'->>'first_name', ${REQUESTER_NAME}) AS first_name,
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

export interface OfficeTurnDeps {
  db: Kysely<Database>; deliverableStore: DeliverableStore; tenantId: string;
  /** ADR-200: the model reading of words the rules are not certain about; null or absent: the rules alone. */
  model?: OfficeIntentModel | null;
}
export type OfficeTurnAnswer = { status: number; extra: Record<string, unknown> };

/**
 * ADR-200: whether an approval that would send a draft to someone other than the approving member is
 * confirmed first ("Send <title> to <requester> now?"). On unless `HAWA_OFFICE_CONFIRM_SEND` says off.
 * Off, approval words that are certain send at once, as before; an approval whose words or draft are
 * not certain is still asked about.
 */
export function sendConfirmationOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:off|false|0|no)$/i.test(String(env.HAWA_OFFICE_CONFIRM_SEND ?? '').trim());
}

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
    const planned = await tx((trx) => planOf(trx, tenantId, message, Date.now()));
    let plan: OfficePlan | null;
    let reading: ReadingNote = { source: 'rules' };
    if (planned?.kind === 'consult') {
      // ADR-200: outside any transaction (the call may take seconds); once per update (its ledger).
      const decision = deps.model ? await deps.model.read({ tenantId, updateId: message.updateId, chatId: message.chatId,
        text: message.text, drafts: planned.drafts, history: planned.history, replyTo: planned.replyTo }).catch((error) => {
        log.warn('[core:office-telegram] the office reading failed:', error instanceof Error ? error.message : error);
        return null;
      }) : null;
      plan = combine(message.text, planned, decision, Date.now());
      reading = decision ? { source: 'model', kind: decision.kind, draft: decision.draft, confidence: decision.confidence }
        : { source: 'rules', consulted: Boolean(deps.model) };
    } else plan = planned;
    if (!plan) return null;
    const ownCancel = await tx((trx) => ownRequestCancelled(trx, tenantId, message, plan!));
    if (ownCancel) plan = { kind: 'requester-withdraw', requestId: ownCancel };
    const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    receipt = await tx((trx) => recordTurn(trx, tenantId, { updateId: message.updateId, chatId: message.chatId,
      messageId: message.messageId, lang: requesterLang(message.text), plan, text: message.text.slice(0, 2000), reading }, hash));
  }
  // ADR-239: recorded, so a replay hands the same words to intake whatever the queue holds by then.
  if (receipt.plan.kind === 'requester-withdraw') return null;
  const outcome = await carryOut(deps, receipt);
  if (outcome.retry) return outcome.retry;
  const answer: OfficeTurnAnswer = { status: 200, extra: { lifecycleAction: 'chat-answer', chatId: message.chatId,
    chatAnswer: { text: outcome.text, parseMode: 'HTML' },
    officeTurn: outcome.ask?.kind === 'ask-send' ? 'ask-send' : receipt.plan.kind === 'decide' ? receipt.plan.intent : receipt.plan.kind } };
  // A question is stamped with the rules it was asked under and when, so its answer can tell (see `openAskIsCurrent`).
  await tx((trx) => extendTurn(trx, tenantId, message.updateId, { answer,
    ...(outcome.ask ? { ask: outcome.ask, askRules: OFFICE_TURN_RULES, askedAt: new Date().toISOString() } : {}) }));
  return answer;
}

/**
 * ADR-239 (live 2026-10-01): the owner is an office member and a requester in one chat. "please cancel
 * the Quality Assurance Workshop poster, it was only a test", about their own draft waiting for review,
 * was taken as the office's rejection ("Rejected: … Nothing was sent to you."). Words that cancel a
 * whole request (the rules' `task` rejection: "cancel it", "scrap this", "please cancel the … poster"),
 * said in this message about a request this member asked for, are the requester's: the request id, so
 * intake withdraws it as any requester's cancel (ADR-230). Rejecting words ("reject", "not approved")
 * and approval stay the office's (ADR-040, ADR-200). An answer to the bot's question (kept words) is not
 * handed over: intake would read only the answer.
 */
async function ownRequestCancelled(trx: Kysely<Database>, tenantId: string, m: OfficeMessage, plan: OfficePlan): Promise<string | null> {
  if (plan.kind !== 'decide' || plan.intent !== 'reject' || plan.rejectionCategory !== 'task' || plan.words !== m.text) return null;
  // ADR-253 (R8): the member asked for it themselves: the request is in this chat AND its requester (the
  // sender of its source message, or the sender its opening decision was recorded for, as intake reads
  // it) is this member. A request in the chat that someone else asked for, or whose requester is not
  // known, stays the office's to reject.
  const request = (await activeChatRequests(trx, tenantId, m.chatId)).find((r) => r.requestId === plan.requestId);
  return request && request.requesterId === m.chatId ? plan.requestId : null;
}

/**
 * ADR-253: the member's own latest message was answered by intake with a question (as any requester's:
 * "Do you want me to cancel …?", "Which design is this for?"), within `PENDING_ASK_MS`, no office alert
 * reached them since, and these words answer it plainly: yes, no, a number or a name it listed. The
 * answer is intake's. Before, a double-role member's "yes" to "Do you want me to cancel <their own
 * draft>?" was read by the office turn, and a model could take it for approval of that very draft.
 */
async function answersIntakeQuestion(trx: Kysely<Database>, tenantId: string, m: OfficeMessage, queue: readonly QueuedDraft[],
  now: number): Promise<boolean> {
  const row = (await sql<{ source_account_id: string; payload: { plan?: { kind?: unknown; options?: unknown; allowNew?: unknown } };
    received_at: Date | string }>`SELECT source_account_id, payload, received_at FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id IN (${TURN_ACCOUNT}, ${INTENT_ACCOUNT})
      AND payload->>'chatId' = ${m.chatId} AND source_event_id <> ${String(m.updateId)} AND received_at > now() - interval '1 day'
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0];
  if (row?.source_account_id !== INTENT_ACCOUNT || row.payload?.plan?.kind !== 'ask') return false;
  const askedAt = new Date(row.received_at).getTime();
  if (!(now - askedAt >= 0 && now - askedAt <= PENDING_ASK_MS)) return false;
  if (queue.some((q) => q.alerted && q.sentAt && Date.parse(q.sentAt) > askedAt)) return false;
  const options = Array.isArray(row.payload.plan.options)
    ? (row.payload.plan.options as Array<{ requestId?: unknown; title?: unknown }>).filter((o) => typeof o?.title === 'string')
      .map((o) => ({ requestId: String(o.requestId ?? ''), title: String(o.title) })) : [];
  return plainYes(m.text) || PLAIN_NO.test(corePhrase(m.text)) ||
    (options.length > 0 && parseChoice(m.text, { options, allowNew: row.payload.plan.allowNew === true }) !== null);
}

/** ADR-200: what the model is asked with, and what the rules alone would do when no reading comes. */
interface Consult {
  kind: 'consult';
  /** The rules' plan: what is done when the model is off, fails, refuses, or is unsure. */
  fallback: OfficePlan | null;
  reading: { intent: OfficeIntent; rejectionCategory?: RejectionCategory };
  queue: QueuedDraft[];
  own: boolean;
  replied: { requestId: string; rev: number } | null;
  discussion: string | null;
  reference: Reference;
  drafts: Parameters<OfficeIntentModel['read']>[0]['drafts'];
  history: OfficeModelLine[];
  replyTo: string | null;
}

type Planned = OfficePlan | Consult | null;

async function planOf(trx: Kysely<Database>, tenantId: string, m: OfficeMessage, now: number): Promise<Planned> {
  const reading = readOfficeIntent(m.text);
  let replied: { requestId: string; rev: number } | null = null;
  let repliedAsk: OfficePlan | null = null;
  if (m.replyTo) {
    const alert = await officeAlertFor(trx, tenantId, m.chatId, m.replyTo);
    if (alert) replied = { requestId: alert.requestId, rev: alert.rev };
    else {
      const asked = await openAsk(trx, tenantId, m.chatId, m.updateId, m.replyTo);
      if (!asked) return null;
      const ask = asked.ask!;
      // A reply to a question asked too long ago, or under other rules, answers nothing.
      if (!openAskIsCurrent(asked, now)) {
        const stale = staleAnswer(ask, m.text, true);
        if (stale !== undefined) return stale;
      } else {
        const answer = answerTo(ask, m.text);
        if (answer) return answer;
        // Words in reply to the bot's question that do not answer it: asked again, plainly. Words in
        // reply to "Send … now?" that are neither yes nor no are a new turn about that draft (ADR-200).
        if (ask.kind !== 'ask-send') {
          return ask.kind === 'ask-which' ? { ...ask }
            : ask.kind === 'ask-what' || ask.kind === 'ask-late' ? { kind: 'ask-what', requestId: ask.requestId, alertRev: ask.alertRev } : null;
        }
      }
      repliedAsk = ask;
    }
  } else {
    const asked = await openAsk(trx, tenantId, m.chatId, m.updateId, null);
    if (asked) {
      // Words that would answer a question asked too long ago, or under other rules, do nothing ("3" an
      // hour after "which draft?"); words that do not answer it are read as if it had not been asked.
      if (!openAskIsCurrent(asked, now)) {
        const stale = staleAnswer(asked.ask!, m.text, false);
        if (stale !== undefined) return stale;
      } else {
        const answered = answerTo(asked.ask!, m.text);
        if (answered) return answered;
      }
    }
  }

  const turns = await recentTurns(trx, tenantId, m.chatId, m.updateId);
  const rules = readIntentByRules(m.text).intent;
  const certainlyNotOffice = !replied && (asksForNewDesign(m.text) || rules === 'new_brief' || (rules === 'acknowledgement' && !plainYes(m.text)));
  // With no reply, only words that clearly decide are the office's; a brief or thanks of the member's
  // own is read by intake as before, and asks no model. "looks good", "ok" may be about a draft (ADR-200).
  if (!replied && reading.intent === 'unclear' && certainlyNotOffice) return null;
  if (!replied && reading.intent === 'change' && asksForNewDesign(m.text)) return null;
  const queue = await officeQueue(trx, tenantId, m.chatId);
  if (!replied && await answersIntakeQuestion(trx, tenantId, m, queue, now)) return null;
  const inQueue = (id: string | null | undefined) => (id && queue.some((q) => q.requestId === id) ? id : null);
  // ADR-200: the draft the bot was just talking about with this member (its last question or answer).
  const discussion = inQueue(repliedAsk && 'requestId' in repliedAsk ? repliedAsk.requestId : discussed(turns, now));

  if (replied) {
    const fallback: OfficePlan = reading.intent === 'unclear' ? { kind: 'ask-what', requestId: replied.requestId, alertRev: replied.rev }
      : { kind: 'decide', intent: reading.intent, requestId: replied.requestId, alertRev: replied.rev, words: m.text, basis: 'reply',
        ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}) };
    const reference = referencedDraft(m.text, queue, replied.requestId, lastList(turns, now));
    // A reply that decides in plain words is certain; so is a reply about a draft no longer waiting.
    const certain = !inQueue(replied.requestId) || (reading.intent !== 'unclear' &&
      (reading.intent !== 'approve' || unambiguousApproval(m.text)) && reference === null);
    if (certain) return fallback;
    return consultOf(m, fallback, reading, queue, false, replied, discussion, reference, turns, now);
  }

  if (!queue.length) return null;
  // ADR-182: a change or a cancellation with no reply from a member who has designs of their own on the
  // way is about their own design (requester routing places it), unless the bot was just talking about
  // a waiting draft with them (ADR-200).
  const own = await ownOpenRequests(trx, tenantId, m.chatId);
  if (!discussion && own && (reading.intent === 'change' || (reading.intent === 'reject' && reading.rejectionCategory === 'task'))) return null;
  // ADR-200 addendum (incident 2026-10-01 12:33Z): redo words ("try again", "make another version")
  // from a member who is also a requester, with a design of their own delivered in the last week, are
  // about that design: intake redoes it. Words about a waiting draft reply to it or follow the bot's
  // question about it.
  if (!discussion && readsAsRedo(m.text) && await ownRecentDesign(trx, tenantId, m.chatId)) return null;
  const anchor = discussion ?? lastSentDraft(queue, now)?.requestId ?? null;
  const reference = referencedDraft(m.text, queue, anchor, lastList(turns, now));
  const fallback = rulesPlan(reading, m.text, queue, own, discussion, reference, now);
  const certain = reference === null && fallback?.kind === 'decide' && ['only', 'discussion'].includes(fallback.basis ?? '') &&
    (fallback.intent !== 'approve' || unambiguousApproval(m.text));
  if (certain) return fallback;
  return consultOf(m, fallback, reading, queue, own, null, discussion, reference, turns, now);
}

/**
 * What the rules alone do with words that reply to nothing (ADR-040 addendum, ADR-182): the draft the
 * bot was just talking about (ADR-200), the one waiting, or the one this member was sent last;
 * otherwise "which draft?". Unclear words are left to intake, unless they name a draft (ADR-200).
 */
function rulesPlan(reading: Consult['reading'], words: string, queue: QueuedDraft[], own: boolean, discussion: string | null,
  reference: Reference, now: number): OfficePlan | null {
  const named = reference && 'index' in reference ? queue[reference.index] : null;
  if (reading.intent === 'unclear') {
    // "not this one, the other", "the Dara one looks good": the draft is named, the rest is not clear
    // to the rules: asked about, by name. Unclear words that name no draft are left to intake.
    return named ? { kind: 'ask-what', requestId: named.requestId, alertRev: null } : null;
  }
  const decision = { intent: reading.intent, words, ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}) };
  if (named) return { kind: 'decide', ...decision, requestId: named.requestId, alertRev: null, basis: 'words', lastSent: named.sentAt,
    ...(reading.intent === 'approve' ? { needsConfirm: true } : {}) };
  if (reference) return { kind: 'ask-which', words, options: queue };
  if (discussion) return { kind: 'decide', ...decision, requestId: discussion, alertRev: null, basis: 'discussion' };
  if (queue.length === 1 && !own) return { kind: 'decide', ...decision, requestId: queue[0].requestId, alertRev: null, basis: 'only' };
  // ADR-231 (live 2026-10-01 14:03Z): approval words with one draft that can be approved are about it,
  // even from a member with designs of their own on the way: it is confirmed by name ("Send … to … now?"),
  // never asked about as a list of one, and never sent unconfirmed.
  if (queue.length === 1 && reading.intent === 'approve') {
    return { kind: 'decide', ...decision, requestId: queue[0].requestId, alertRev: null, basis: 'words', lastSent: queue[0].sentAt, needsConfirm: true };
  }
  // ADR-040 addendum (2026-10-01): with several waiting, words with no reply are about the draft this
  // member was sent last, when it came within two hours and no other came close to it. The answer
  // names that draft first, so a wrong guess shows. A member with designs of their own on the way is
  // still asked (ADR-182): their words may be about those.
  const last = own ? null : lastSentDraft(queue, now);
  if (last) return { kind: 'decide', ...decision, requestId: last.requestId, alertRev: null, lastSent: last.sentAt, basis: 'last-shown' };
  return { kind: 'ask-which', words, options: queue };
}

function consultOf(m: OfficeMessage, fallback: OfficePlan | null, reading: Consult['reading'], queue: QueuedDraft[], own: boolean,
  replied: Consult['replied'], discussion: string | null, reference: Reference, turns: RecentTurn[], now: number): Consult {
  const newest = queue.find((q) => q.alerted);
  const drafts = queue.map((q) => ({ title: q.title, sent: agoText(q.sentAt ? Date.parse(q.sentAt) : now, now), lastShown: q === newest,
    photos: q.photos ?? 0, requester: q.own ? 'you' : q.requester ?? 'a requester', clientId: q.clientId ?? null }));
  const at = (id: string | null) => queue.findIndex((q) => q.requestId === id) + 1;
  const replyTo = replied ? (at(replied.requestId) ? `the picture of draft ${at(replied.requestId)}` : 'the picture of a draft no longer waiting')
    : discussion && m.replyTo ? `the bot's question about draft ${at(discussion)}` : null;
  return { kind: 'consult', fallback, reading, queue, own, replied, discussion, reference, drafts,
    history: historyLines(turns, queue, now), replyTo };
}

/**
 * ADR-200: the model's reading, held to the rules. The draft: a reply, then a draft the words name
 * (the conversation's "the other one", a name), then the draft the bot was just talking about, then
 * the model's pick when it is sure, then the rules' only or last-shown draft; a disagreement asks
 * "which draft?". The meaning: refusing words are read by the rules, never as approval; a rejection
 * needs rejecting words; approval is confirmed unless its words only approve and its draft is certain.
 */
function combine(words: string, c: Consult, d: OfficeModelDecision | null, now: number): OfficePlan | null {
  if (!d || d.kind === 'unclear' || d.confidence < 0.6) return c.fallback;
  if (d.kind === 'new_request' || d.kind === 'chat') {
    if (d.confidence < 0.7) return c.fallback;
    return c.replied ? { kind: 'ask-what', requestId: c.replied.requestId, alertRev: c.replied.rev } : null;
  }
  const { queue } = c;
  const pick = d.draft >= 1 && d.draft <= queue.length ? queue[d.draft - 1] : null;
  const ask: OfficePlan = { kind: 'ask-which', words, options: queue };
  let target: { requestId: string; alertRev: number | null; basis: TargetBasis; sentAt?: string } | null = null;
  const disagrees = (id: string) => pick !== null && pick.requestId !== id && d.confidence >= 0.75;
  if (c.reference && 'index' in c.reference) {
    const named = queue[c.reference.index];
    target = { requestId: named.requestId, alertRev: null, basis: 'words', sentAt: named.sentAt };
  } else if (c.reference && 'ambiguous' in c.reference) {
    return ask;
  } else if (c.replied) {
    target = { requestId: c.replied.requestId, alertRev: c.replied.rev, basis: 'reply' };
  } else if (c.discussion) {
    target = { requestId: c.discussion, alertRev: null, basis: 'discussion' };
  } else if (pick && d.confidence >= 0.75) {
    target = { requestId: pick.requestId, alertRev: null, basis: 'model', sentAt: pick.sentAt };
  } else if (queue.length === 1 && !c.own) {
    target = { requestId: queue[0].requestId, alertRev: null, basis: 'only' };
  } else if (queue.length === 1 && c.reading.intent === 'approve') {
    // ADR-231: approval words with one draft that can be approved: confirmed by name (never certain here).
    target = { requestId: queue[0].requestId, alertRev: null, basis: 'words', sentAt: queue[0].sentAt };
  } else if (!c.own) {
    const last = lastSentDraft(queue, now);
    if (last) target = { requestId: last.requestId, alertRev: null, basis: 'last-shown', sentAt: last.sentAt };
  }
  // A question about no particular draft ("is my poster ready?") is not the office's: intake answers it.
  if (d.kind === 'question' && (!target || ['only', 'last-shown'].includes(target.basis))) return c.fallback;
  if (!target || disagrees(target.requestId)) return ask;
  // ADR-182: a member with designs of their own on the way may mean those; the model's guess never
  // sends their words back on someone else's draft. Intake (requester routing) places them.
  if (c.own && target.basis === 'model' && (d.kind === 'change' || d.kind === 'reject')) return null;
  const named = ['words', 'model', 'last-shown'].includes(target.basis) ? { lastSent: target.sentAt } : {};
  const on = { requestId: target.requestId, alertRev: target.alertRev, basis: target.basis, words };
  const rules = c.reading;
  const byRules = (): OfficePlan => rules.intent === 'unclear' || rules.intent === 'approve'
    ? { kind: 'ask-what', requestId: target!.requestId, alertRev: target!.alertRev }
    : { kind: 'decide', intent: rules.intent, ...on, ...named, ...(rules.rejectionCategory ? { rejectionCategory: rules.rejectionCategory } : {}) };
  if (d.kind === 'question') return { kind: 'ask-what', requestId: target.requestId, alertRev: target.alertRev, facts: true };
  // Rejecting needs rejecting words: the model alone asks what to do.
  if (d.kind === 'reject') return rules.intent === 'reject' ? byRules() : { kind: 'ask-what', requestId: target.requestId, alertRev: target.alertRev };
  if (d.kind === 'change') return rules.intent === 'reject' ? byRules() : { kind: 'decide', intent: 'change', ...on, ...named };
  // Approval: words the rules read as a refusal, a change or a rejection are read by the rules.
  if (refusesApproval(words) || rules.intent === 'change' || rules.intent === 'reject') return byRules();
  const certain = unambiguousApproval(words) && ['reply', 'only', 'discussion'].includes(target.basis);
  return { kind: 'decide', intent: 'approve', ...on, ...named, ...(certain ? {} : { needsConfirm: true }) };
}

/**
 * Whether a turn's question may still be answered: asked under the current rules
 * (`OFFICE_TURN_RULES`; a question stored before the stamp existed has none) and within
 * `PENDING_ASK_MS`.
 */
export function openAskIsCurrent(turn: Pick<TurnReceipt, 'askRules' | 'askedAt'>, now: number): boolean {
  if (turn.askRules !== OFFICE_TURN_RULES || typeof turn.askedAt !== 'string') return false;
  const at = Date.parse(turn.askedAt);
  return Number.isFinite(at) && now - at >= 0 && now - at <= PENDING_ASK_MS;
}

/** "the newest", "latest one", "the most recent"; Sorani "the newest", "the latest". */
const NEWEST = /^(?:(?:the\s+)?(?:newest|latest|most\s+recent)(?:\s+(?:one|draft|design))?|نوێترین(?:یان)?|دواهەمین)[\s.!]*$/iu;

/**
 * ADR-200: a plain yes to "Send … now?", in English, Sorani, Kurmanji or Arabic: "yes", "ok", "sure",
 * "send it", "go ahead", "looks good", "👍", "بەڵێ" (yes), "باشە" (ok), "بینێرە" (send it), "erê",
 * "نعم". Only these words, said on their own: "ok but change the title" is not a yes.
 */
const YES_WORD = '(?:yes|yeah|yep|yup|ya|ok(?:ay)?|sure|of\\s+course|certainly|correct|right|confirm(?:ed)?|please(?:\\s+do)?|do\\s+it|go(?:\\s+ahead)?|' +
  'approved?|looks?\\s+(?:good|great|fine|perfect)|good|great|perfect|fine|lgtm|پەسەندە|جوانە|' +
  'send(?:\\s+(?:it|them))?(?:\\s+now)?|👍|✅|👌|بەڵێ|بەلێ|ئا|ئەرێ|ئەڵبەت|باشە|بنێرە|بینێرە|بینێرن|ئێستا\\s+بینێرە|erê|belê|نعم|ايوه|تمام)';
const PLAIN_YES = new RegExp(`^(?:${YES_WORD}[\\s,،!.]*)+$`, 'iu');
/** "no", "not yet", "wait", "hold on", "don't"; Sorani "no", "not yet", "wait". */
const NO_WORD = '(?:no|nope|nah|not\\s+(?:yet|now)|wait|hold\\s+on|hold\\s+it|don\'?t|stop|later|نا|نەخێر|نە|هێشتا\\s+نا|ڕاوەستە|چاوەڕێ\\s+بکە|na|nexêr)';
const PLAIN_NO = new RegExp(`^(?:${NO_WORD}[\\s,،!.]*)+$`, 'iu');

/** ADR-200: a plain yes, said on its own (politeness around it allowed). */
export function plainYes(text: string): boolean {
  const t = String(text ?? '').trim();
  return Boolean(t) && (PLAIN_YES.test(t) || PLAIN_YES.test(corePhrase(t)));
}

/** The member's answer to the bot's question, as a decision, or null when the words do not answer it. */
function answerTo(ask: OfficePlan, text: string): OfficePlan | null {
  if (ask.kind === 'ask-which') {
    // A brief or a change of the member's own is not an answer, even if it shares a word with a title.
    if (asksForNewDesign(text) || ['new_brief', 'change'].includes(readIntentByRules(text).intent)) return null;
    // The list is newest first: "the newest" is its first line (parseChoice takes "latest" as the last).
    const choice = NEWEST.test(corePhrase(text)) ? { option: 0 } : parseChoice(text, { options: ask.options, allowNew: false });
    if (!choice || !('option' in choice)) return null;
    const requestId = ask.options[choice.option].requestId;
    // ADR-040 addendum (incident 2026-10-01): the kept words are read again now, never as they were
    // read when the question was asked. Approval through a choice needs words that only approve;
    // anything less is asked about, and a refusal with feedback is the change.
    const reading = readOfficeIntent(ask.words);
    if (reading.intent === 'unclear' || (reading.intent === 'approve' && !unambiguousApproval(ask.words))) {
      return { kind: 'ask-what', requestId, alertRev: null };
    }
    return { kind: 'decide', intent: reading.intent, requestId, alertRev: null, words: ask.words, basis: 'choice',
      ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}) };
  }
  if (ask.kind === 'ask-what' || ask.kind === 'ask-late') {
    const reading = readOfficeIntent(text);
    if (reading.intent === 'unclear') return null;
    return { kind: 'decide', intent: reading.intent, requestId: ask.requestId, alertRev: ask.alertRev, words: text, basis: 'discussion',
      ...(reading.rejectionCategory ? { rejectionCategory: reading.rejectionCategory } : {}),
      // "send it anyway" after the requester's late words were shown is the confirmation (ADR-200).
      ...(ask.kind === 'ask-late' ? { acknowledge: ask.updateIds, ...(reading.intent === 'approve' ? { confirmed: true } : {}) } : {}) };
  }
  if (ask.kind === 'ask-send') {
    const core = corePhrase(text);
    if (plainYes(text)) {
      return { kind: 'decide', intent: 'approve', requestId: ask.requestId, alertRev: ask.rev, revisionId: ask.revisionId, words: text,
        basis: 'confirm', confirmed: true };
    }
    // "no", "not yet", "cancel it": nothing is sent. Rejecting the design takes rejecting words.
    if (PLAIN_NO.test(core) || PLAIN_NO.test(text.trim()) || OFFICE_CANCEL.test(core)) return { kind: 'not-sent', requestId: ask.requestId };
  }
  return null;
}

/**
 * An answer to a question asked too long ago or under other rules. A yes to "Send … now?" asks it
 * again (nothing is sent on an old yes), a no sends nothing; other questions are lost track of, as
 * before (ADR-040 addendum). Undefined: the words are a new turn.
 */
function staleAnswer(ask: OfficePlan, text: string, replied: boolean): OfficePlan | null | undefined {
  if (ask.kind === 'ask-send') {
    if (plainYes(text)) return { kind: 'decide', intent: 'approve', requestId: ask.requestId, alertRev: null, words: text, needsConfirm: true, again: true };
    const answered = answerTo(ask, text);
    return answered ?? undefined;
  }
  if (replied || answerTo(ask, text)) return { kind: 'lost-track' };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// ADR-200: the conversation (this member's recent turns) and the drafts its words name
// ---------------------------------------------------------------------------------------------

interface RecentTurn { at: number; office: boolean; receipt: TurnReceipt | null }

/** This member's latest turns of the last day, newest first: office turns and (as a marker) intake turns. */
async function recentTurns(trx: Kysely<Database>, tenantId: string, chatId: string, updateId: number): Promise<RecentTurn[]> {
  return (await sql<{ source_account_id: string; source_event_id: string; payload: StoredTurn; received_at: Date | string }>`SELECT
      source_account_id, source_event_id, payload, received_at FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id IN (${TURN_ACCOUNT}, ${INTENT_ACCOUNT})
      AND payload->>'chatId' = ${chatId} AND source_event_id <> ${String(updateId)} AND received_at > now() - interval '1 day'
    ORDER BY received_at DESC, id DESC LIMIT 6`.execute(trx)).rows.map((row) => ({ at: new Date(row.received_at).getTime(),
      office: row.source_account_id === TURN_ACCOUNT,
      receipt: row.source_account_id === TURN_ACCOUNT ? parseReceipt(Number(row.source_event_id), row.payload) : null }));
}

/** The draft the bot's latest answer to this member was about, within `PENDING_ASK_MS`, or null. */
function discussed(turns: RecentTurn[], now: number): string | null {
  const latest = turns[0];
  if (!latest?.office || !latest.receipt || now - latest.at > PENDING_ASK_MS) return null;
  const ask = latest.receipt.ask;
  if (ask && 'requestId' in ask) return ask.requestId;
  const plan = latest.receipt.plan;
  return plan.kind === 'decide' || plan.kind === 'not-sent' || plan.kind === 'ask-what' ? plan.requestId : null;
}

/** The numbered list the bot last showed this member (newest first), within `PENDING_ASK_MS`. */
function lastList(turns: RecentTurn[], now: number): string[] | null {
  for (const turn of turns) {
    if (now - turn.at > PENDING_ASK_MS) return null;
    const ask = turn.receipt?.ask ?? (turn.receipt?.plan.kind === 'ask-which' ? turn.receipt.plan : undefined);
    if (ask?.kind === 'ask-which' && Array.isArray(ask.options)) return ask.options.map((o) => o.requestId);
  }
  return null;
}

/**
 * Where the words point: a draft (`index` in the queue), several (`ambiguous`), a draft that the words
 * name but nothing deterministic resolves (`mentions`: the model's pick may), or nothing (null).
 */
export type Reference = { index: number } | { ambiguous: true } | { mentions: true } | null;

const OTHER = /(?:^|[^\p{L}])(?:the\s+)?other(?:\s+(?:one|draft|design))?(?![\p{L}])|ئەوی\s*تر|ئەوەی\s*تر|ئەویتریان/iu;
const OLDER = /(?:^|[^\p{L}])(?:the\s+)?(?:earlier|older|previous)(?:\s+(?:one|draft|design))?(?![\p{L}])|پێشووەکە|کۆنەکە/iu;
const NEWER = /(?:^|[^\p{L}])(?:the\s+)?(?:newest|latest|newer|most\s+recent)(?:\s+(?:one|draft|design))?(?![\p{L}])|(?:^|[^\p{L}])the\s+new\s+(?:one|draft)(?![\p{L}])|نوێترین|نوێیەکە/iu;
const THIS_ONE = /(?:^|[^\p{L}])(?:that|this)\s+(?:one|draft|design)(?![\p{L}])/iu;
const ORDINAL_WORDS: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4,
  fifth: 5, '5th': 5, 'یەکەم': 1, 'دووەم': 2, 'سێیەم': 3, 'چوارەم': 4, 'پێنجەم': 5 };
const ORDINAL = /(?:^|[^\p{L}])(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:one|draft|design)(?![\p{L}])|(?:^|[^\p{L}])number\s+([1-5])(?![\p{N}])|(یەکەم|دووەم|سێیەم|چوارەم|پێنجەم)(?:یان|ەکە|ین)/iu;
/** "the one for Sewa", "the Sewa one", "Sewa's one", Sorani "Sewa's" (هی سێوە). */
const NAMED = [
  /(?:^|[^\p{L}])the\s+(?:one|draft|design|poster|flyer|banner|card|invitation)\s+(?:for|from|of|by|about)\s+([^,.;:!?\n]{2,40})/iu,
  /(?:^|[^\p{L}])the\s+([\p{L}\p{N}][\p{L}\p{N}'’&-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’&-]*){0,2})\s+(?:one|draft|design)(?![\p{L}])/iu,
  /([\p{L}]{2,30})['’]s\s+(?:one|draft|design|poster)(?![\p{L}])/iu,
  /(?:^|\s)(?:هی|ئەوەی)\s+([\p{L}]{2,30})/u,
];
const GENERIC = /^(?:other|earlier|older|previous|newest|latest|newer|new|last|first|second|third|fourth|fifth|same|right|wrong|this|that|next|old|final|good|bad|best)$/iu;
const words = (text: string) => text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** ADR-200: the waiting draft the member's words name, from the conversation; see `Reference`. */
export function referencedDraft(text: string, queue: readonly QueuedDraft[], anchor: string | null, list: readonly string[] | null): Reference {
  const t = String(text ?? '');
  const at = (id: string | null | undefined) => (id ? queue.findIndex((q) => q.requestId === id) : -1);
  if (OTHER.test(t)) {
    const a = at(anchor);
    return queue.length === 2 && a >= 0 ? { index: 1 - a } : { ambiguous: true };
  }
  const ordinal = ORDINAL.exec(t);
  if (ordinal) {
    const k = ordinal[2] ? Number(ordinal[2]) : ORDINAL_WORDS[(ordinal[1] ?? ordinal[3]).toLowerCase()];
    const i = list && k ? at(list[k - 1]) : -1;
    return i >= 0 ? { index: i } : { mentions: true };
  }
  if (NEWER.test(t)) return queue.length ? { index: 0 } : null;
  if (OLDER.test(t)) return queue.length === 2 ? { index: 1 } : { mentions: true };
  for (const pattern of NAMED) {
    const phrase = pattern.exec(t)?.[1]?.trim();
    if (!phrase || GENERIC.test(phrase)) continue;
    const said = new Set(words(phrase));
    if (said.has('you') || said.has('me') || said.has('mine')) {
      const mine = queue.flatMap((q, i) => (q.own ? [i] : []));
      return mine.length === 1 ? { index: mine[0] } : mine.length ? { ambiguous: true } : { mentions: true };
    }
    const byName = queue.flatMap((q, i) => (q.requester && said.has(words(q.requester)[0] ?? '') ? [i] : []));
    if (byName.length === 1) return { index: byName[0] };
    const pool = byName.length > 1 ? byName.map((i) => queue[i]) : [...queue];
    const byTitle = titleMatch(phrase, pool);
    if (byTitle !== null) return { index: queue.indexOf(pool[byTitle]) };
    return byName.length > 1 ? { ambiguous: true } : { mentions: true };
  }
  if (THIS_ONE.test(t)) {
    const a = at(anchor);
    return a >= 0 ? { index: a } : { mentions: true };
  }
  return null;
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago": for the model, in English. */
function agoText(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const unescapeHtml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * The chat so far, oldest first, as the model is shown it: the member's own words, and the bot's
 * answers with every design name that is not a waiting draft, and every requester's quoted words,
 * left out (a model reading sends only the waiting drafts' clients' words, and only with their consent).
 */
function historyLines(turns: RecentTurn[], queue: readonly QueuedDraft[], now: number): OfficeModelLine[] {
  const known = new Set(queue.flatMap((q) => [q.title, q.requester ?? '']).filter(Boolean));
  const lines: OfficeModelLine[] = [];
  for (const turn of [...turns].reverse()) {
    const r = turn.receipt;
    if (!turn.office || !r) continue;
    const said = r.text ?? (r.plan.kind === 'decide' || r.plan.kind === 'ask-which' ? r.plan.words : null);
    const ago = agoText(turn.at, now);
    if (said) lines.push({ who: 'member', text: said.slice(0, 600), ago });
    const chat = (r.answer?.extra as { chatAnswer?: { text?: unknown } } | undefined)?.chatAnswer?.text;
    if (typeof chat === 'string') {
      const bot = unescapeHtml(chat.replace(/«[^»]*»/g, '«the requester\'s words»')
        .replace(/<b>([^<]*)<\/b>/g, (_m, name: string) => (known.has(unescapeHtml(name)) ? `"${name}"` : 'a design'))
        .replace(/<[^>]+>/g, ''));
      lines.push({ who: 'bot', text: bot.slice(0, 600), ago });
    }
  }
  return lines.slice(-8);
}

type Outcome = { text: string; ask?: OfficePlan; retry?: undefined } | { retry: OfficeTurnAnswer };

/**
 * Carries out the plan. Words with no reply that were taken to be about the draft last sent to this
 * member (ADR-040 addendum, 2026-10-01) are answered with that draft named first, and when it was sent.
 */
async function carryOut(deps: OfficeTurnDeps, receipt: TurnReceipt): Promise<Outcome> {
  const outcome = await carryOutPlan(deps, receipt);
  const plan = receipt.plan;
  // "Send <title> to <requester> now?" names the draft itself (ADR-200).
  if (outcome.retry || plan.kind !== 'decide' || !plan.lastSent || outcome.ask?.kind === 'ask-send') return outcome;
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
  if (plan.kind === 'lost-track') return { text: phrase(OFFICE_MESSAGES.lostTrack) };
  if (plan.kind === 'ask-which') return { text: phrase(OFFICE_MESSAGES.whichDraft, { list: choiceList(plan.options, lang, Date.now()) }), ask: plan };
  const state = await tx((trx) => draftState(trx, tenantId, plan.requestId));
  if (!state) return { text: phrase(OFFICE_MESSAGES.notRecorded, { title: bold('?') }) };
  const title = bold(state.title);
  const own = state.chatId === receipt.chatId;
  const requester = own ? phrase(OFFICE_MESSAGES.you)
    : state.requesterName ? bold(state.requesterName) : phrase(OFFICE_MESSAGES.theRequester);
  // ADR-200: a plain no to "Send … now?": nothing is sent, and the draft keeps waiting.
  if (plan.kind === 'not-sent') return { text: phrase(OFFICE_MESSAGES.notSent, { title }) };
  if (plan.kind === 'ask-what' && plan.facts) {
    // ADR-200: a question about a draft is answered with what the office knows of it, then asked about.
    const queued = (await tx((trx) => officeQueue(trx, tenantId, receipt.chatId))).find((q) => q.requestId === plan.requestId);
    if (queued?.sentAt) {
      const photos = queued.photos ?? 0;
      return { ask: { kind: 'ask-what', requestId: plan.requestId, alertRev: plan.alertRev }, text: phrase(OFFICE_MESSAGES.draftFacts, { title, requester,
        when: whenText(Date.parse(queued.sentAt), Date.now(), lang),
        photos: photos === 0 ? phrase(OFFICE_MESSAGES.noPhotos) : photos === 1 ? phrase(OFFICE_MESSAGES.onePhoto) : phrase(OFFICE_MESSAGES.photos, { n: String(photos) }) }) };
    }
  }
  if (plan.kind === 'ask-what') return { text: phrase(OFFICE_MESSAGES.whatToDo, { title }), ask: { kind: 'ask-what', requestId: plan.requestId, alertRev: plan.alertRev } };
  // A confirmation is only ever asked, never planned: nothing to carry out. A requester's withdraw is
  // intake's (ADR-239): officeTelegramTurn never carries it out.
  if (plan.kind === 'ask-send' || plan.kind === 'requester-withdraw') return { text: phrase(OFFICE_MESSAGES.lostTrack) };

  // The draft the member answered must be the one still waiting; someone may have decided first. A
  // replay of this turn's own recorded decision is sent again as it was (the Desk's receipts answer it).
  const decided = await priorDecision(db, tenantId, receipt);
  if (!decided) {
    const alertRev = plan.alertRev ?? state.rev;
    if (state.stage !== 'in_review' || state.taskState !== 'human_review' || !state.revisionId) {
      return { text: stageWords(state.stage, phrase, title) };
    }
    if (alertRev !== state.rev) return { text: phrase(OFFICE_MESSAGES.olderDraft, { title }) };
    // ADR-200: a "yes" approves the revision it was asked about, and no newer one.
    if (plan.kind === 'decide' && plan.revisionId && plan.revisionId !== state.revisionId) return { text: phrase(OFFICE_MESSAGES.olderDraft, { title }) };
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
      // ADR-200: an approval that would send the draft to someone else is asked about first, by name;
      // so is any approval whose words or draft are not certain. The question names this revision: a
      // plain yes approves it, and nothing else does.
      if (!decided && !plan.confirmed && (plan.needsConfirm || !unambiguousApproval(plan.words) || (!own && sendConfirmationOn()))) {
        const question = phrase(own ? OFFICE_MESSAGES.confirmSendOwn : OFFICE_MESSAGES.confirmSend, { title, requester });
        return { text: plan.again ? `${phrase(OFFICE_MESSAGES.askedAgain, { title })}\n${question}` : question,
          ask: { kind: 'ask-send', requestId: plan.requestId, rev, revisionId: target.revisionId } };
      }
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
    return { text: own ? phrase(OFFICE_MESSAGES.sentBackOwn, { title })
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
