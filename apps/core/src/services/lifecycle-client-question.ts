/**
 * ADR-235 (owner, 2026-10-01: "ask who it's for"): a brief from a chat bound to no organisation, whose
 * words name none, is not opened silently for a designer. It is kept, with its words and its photo, and
 * its sender is asked in words who it is for. Invariant #4 still holds: the organisation is never
 * guessed. It comes from the sender's answer, read by the same client matching intake uses (packs,
 * names, Sorani aliases), or, when they do not know or name none the office works with, the office
 * chooses it, as before.
 *
 * The question and its answer are rows of the inbox ledger (first write wins): the question under the
 * brief's update, its resolution under the same id with the update that answered it. A replay of either
 * update decides the same, and the kept brief opens once, under the answering update.
 *
 * Questions follow ADR-040's pending-choice rules: stamped (`CLIENT_QUESTION_RULES`), dated, and only
 * answered by a reply to the question or by words that answer it (a short answer that names an
 * organisation, or "I don't know"). Anything else is read as if no question had been asked. An answer
 * after `CLIENT_QUESTION_MS`, or to a question with an older stamp, opens the kept brief for the office
 * to choose, and says so: the words are kept, never lost and never guessed for.
 */
import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import type { BlobRef } from '@hawa/contracts';
import { plainClientAnswer, resolveSourceClient } from './lifecycle-source-natural.js';

type Tx = Kysely<Database>;

/** Raised whenever the way a question is asked or read changes: older questions are then expired. */
export const CLIENT_QUESTION_RULES = 1;
/** As ADR-040's pending choices: thirty minutes. */
export const CLIENT_QUESTION_MS = 30 * 60_000;
/** A question older than this is no longer read at all: the next message is read as any message is. */
const FORGOTTEN_MS = 24 * 60 * 60_000;

const QUESTION = 'lifecycle_client_question';
const RESOLUTION = 'lifecycle_client_resolution';

export interface ClientQuestion {
  /** The brief's update: the question's key. */
  briefUpdateId: number;
  chatId: string;
  senderId: string;
  topicId: string;
  /** The brief, as it would have opened. */
  words: string;
  instructionOnly: boolean;
  /** The photo the brief came with, already retained. */
  image?: Pick<BlobRef, 'sha256' | 'size' | 'mediaType'>;
  /** What the sender was asked (and the names listed: an office member's chat only). */
  text: string;
  listed: string[];
  askedAt: string;
  askRules: number;
  payloadHash: string;
}

export type ClientAnswerOutcome = 'client' | 'office' | 'unmatched' | 'expired';
export interface ClientResolution { byUpdateId: number; outcome: ClientAnswerOutcome; clientId?: string }

async function readRow<T>(trx: Tx, tenantId: string, kind: string, id: string): Promise<T | null> {
  const row = (await sql<{ payload: T }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${kind} AND source_event_id = ${id} LIMIT 1`.execute(trx)).rows[0];
  return row?.payload ?? null;
}
async function insertRow(trx: Tx, tenantId: string, kind: string, id: string, payload: object): Promise<void> {
  const hash = createHash('sha256').update(`${kind}:${id}:${JSON.stringify(payload)}`).digest('hex');
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, ${kind}, ${id}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${hash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
}

/** Keeps the brief and its question; the first one stands (a replay of the brief asks the same). */
export async function recordClientQuestion(trx: Tx, tenantId: string, question: ClientQuestion): Promise<ClientQuestion> {
  await insertRow(trx, tenantId, QUESTION, String(question.briefUpdateId), question);
  return (await readRow<ClientQuestion>(trx, tenantId, QUESTION, String(question.briefUpdateId)))!;
}

export function readClientResolution(trx: Tx, tenantId: string, briefUpdateId: number): Promise<ClientResolution | null> {
  return readRow<ClientResolution>(trx, tenantId, RESOLUTION, String(briefUpdateId));
}

/** Records the answer; the first one stands, so a kept brief opens once. */
export async function resolveClientQuestion(trx: Tx, tenantId: string, briefUpdateId: number, resolution: ClientResolution): Promise<ClientResolution> {
  await insertRow(trx, tenantId, RESOLUTION, String(briefUpdateId), resolution);
  return (await readClientResolution(trx, tenantId, briefUpdateId))!;
}

/**
 * The sender's newest question in this chat (and topic) still open, or answered by this very update (a
 * replay), asked within a day.
 */
export async function pendingClientQuestion(trx: Tx, tenantId: string, scope: { chatId: string; senderId: string; topicId: string },
  updateId: number): Promise<{ question: ClientQuestion; resolution: ClientResolution | null } | null> {
  const rows = (await sql<{ payload: ClientQuestion; resolution: ClientResolution | null }>`SELECT q.payload, r.payload AS resolution
    FROM hawa.inbox_events q LEFT JOIN hawa.inbox_events r ON r.tenant_id = q.tenant_id
      AND r.source_account_id = ${RESOLUTION} AND r.source_event_id = q.source_event_id
    WHERE q.tenant_id = ${tenantId}::uuid AND q.source_account_id = ${QUESTION}
      AND q.payload->>'chatId' = ${scope.chatId} AND q.payload->>'senderId' = ${scope.senderId}
      AND q.payload->>'topicId' = ${scope.topicId} AND q.received_at > now() - (${FORGOTTEN_MS} * interval '1 millisecond')
      AND (r.id IS NULL OR r.payload->>'byUpdateId' = ${String(updateId)})
    ORDER BY q.received_at DESC, q.id DESC LIMIT 1`.execute(trx)).rows[0];
  return rows ? { question: rows.payload, resolution: rows.resolution } : null;
}

/** The update whose answer the bot sent as this message (ChatInbox keys its answers by update). */
export async function answeredUpdateOf(trx: Tx, tenantId: string, replyMessageId: string | null): Promise<number | null> {
  if (!replyMessageId) return null;
  const row = (await sql<{ source_event_id: string }>`SELECT source_event_id FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery' AND event_kind = 'telegram_message_sent'
      AND source_event_id LIKE 'lc:chatinbox:%' AND payload->>'messageId' = ${replyMessageId} LIMIT 1`.execute(trx)).rows[0];
  const id = row && /:(\d{1,18}):send$/.exec(row.source_event_id)?.[1];
  return id ? Number(id) : null;
}

/** "I don't know", "not sure", "just make it", in English or Sorani: the office chooses. */
const DONT_KNOW = /^(?:(?:i|we)\s+)?(?:(?:don'?t|do\s+not|dont)\s+know|not\s+sure|no\s+idea|no\s+clue|unsure)\b|^(?:just\s+(?:make|do|design)\s+it|(?:it\s+)?doesn'?t\s+matter|whatever|any(?:one)?|skip\s+it)\b|نازانم|نازانین|دڵنیا\s*نیم|گرنگ\s+نییە|(?:تەنها|هەر)\s+دروستی\s+بکە/iu;
/** Words that ask for a design (a design noun, a date or a number): a brief, not an answer. */
const NAMES_A_DESIGN = /\b(?:poster|flyer|banner|design|invitation|invite|card|post|story|brochure|certificate|announcement|graphic|cover|leaflet|thumbnail|advert)s?\b|پۆستەر|پۆست|دیزاین|بانگهێشت|\p{N}/iu;
export const saysDontKnow = (text: string) => text.trim().split(/\s+/).length <= 8 && DONT_KNOW.test(text.trim());

/**
 * The organisations an office member is offered by name (active clients, at most twelve), with the short
 * code people use when the name does not carry it: "Kurdistan Accrediting Association for Education (KAAE)".
 */
export async function knownClientNames(trx: Tx, tenantId: string): Promise<string[]> {
  return (await sql<{ name: string; code: string }>`SELECT name, code FROM hawa.clients WHERE tenant_id = ${tenantId}::uuid
    AND status = 'active' ORDER BY name LIMIT 12`.execute(trx)).rows
    .filter((r) => typeof r.name === 'string' && r.name.trim())
    .map((r) => {
      const code = String(r.code ?? '').trim();
      return /^[a-z0-9]{2,8}$/i.test(code) && !r.name.toLowerCase().includes(code.toLowerCase()) ? `${r.name.trim()} (${code.toUpperCase()})` : r.name.trim();
    });
}

/**
 * What these words do to an open question: nothing (they are read as any message is), or its answer.
 * A reply to the question always answers it; without a reply, only "I don't know" or a short answer
 * that names one organisation does. An answer late, or to an older stamp, is `expired`.
 */
export async function readClientAnswer(trx: Tx, tenantId: string, input: { question: ClientQuestion; text: string;
  repliedToQuestion: boolean; now?: number }): Promise<Omit<ClientResolution, 'byUpdateId'> | null> {
  const { question, text } = input;
  const dontKnow = saysDontKnow(text);
  const clientId = dontKnow ? null : await resolveSourceClient(trx, tenantId, { chatId: question.chatId, words: text });
  // Without a reply, a short answer names the organisation and nothing else: "KAAE poster for Nawroz" is a
  // new brief, read as one, and never taken as the answer.
  if (!input.repliedToQuestion && !dontKnow && !(clientId && plainClientAnswer(text) && !NAMES_A_DESIGN.test(text))) return null;
  const late = (input.now ?? Date.now()) - Date.parse(question.askedAt) > CLIENT_QUESTION_MS || question.askRules !== CLIENT_QUESTION_RULES;
  if (late) return { outcome: 'expired' };
  if (clientId) return { outcome: 'client', clientId };
  return { outcome: dontKnow ? 'office' : 'unmatched' };
}
