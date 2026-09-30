/**
 * Voice notes and PDFs without formats (audit F6, ADR-145).
 *
 * A requester sends a voice note (Telegram gives it no caption) or a PDF with a natural caption. Its
 * organisation is found the way a text brief's is (the chat's bound client, or the one client its
 * words name), or, when a caption line says "Client: …", that one; only when none can be told is the
 * requester asked "Which organisation is it for?", in words. A design that waits for their changes
 * is not assumed: they are asked whether the recording or file is a change to it or a new design.
 * Once the words are turned into text, the requester confirms them with "yes" (or "بەڵێ"), or sends
 * the corrected text: no command, no reply to a particular message. No design starts before the
 * words are confirmed.
 *
 * Every question, answer and confirmation is recorded in the inbox ledger under the update that
 * carried it (first write wins), so a replay decides the same and nothing is used twice.
 */
import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import { normalizeKurdishIncomingText } from '@hawa/integrations';
import { matchRequestClient } from './client-packs.js';
import { isAcknowledgement } from './telegram-classifier.js';
import { readIntentByRules } from './requester-turn.js';

type Tx = Kysely<Database>;
type Json = Record<string, unknown>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function readRow(trx: Tx, tenantId: string, kind: string, id: string): Promise<{ payload: Json; payload_hash: string } | null> {
  return (await sql<{ payload: Json; payload_hash: string }>`SELECT payload, payload_hash FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${kind} AND source_event_id = ${id} LIMIT 1`.execute(trx)).rows[0] ?? null;
}
async function insertRow(trx: Tx, tenantId: string, kind: string, id: string, payload: Json, hash: string): Promise<void> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, ${kind}, ${id}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${hash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
}

// --- the organisation ------------------------------------------------------------------------------

/**
 * The one active client the chat or the words name: the chat's bound client pack, else the one pack
 * the words name, else the one active client whose code or full name the words contain as a word.
 * Two named clients, or none, is `null`: the requester is asked, never guessed for.
 */
export async function resolveSourceClient(trx: Tx, tenantId: string, input: { chatId: string; words: string }): Promise<string | null> {
  const words = input.words.trim();
  const active = async (id: string) => Boolean((await sql<{ one: number }>`SELECT 1 AS one FROM hawa.clients
    WHERE tenant_id = ${tenantId}::uuid AND id::text = ${id} AND status = 'active'`.execute(trx)).rows[0]);
  const pack = matchRequestClient({ chatId: input.chatId, rawText: words, normalizedText: normalizeKurdishIncomingText(words) });
  if ((pack.kind === 'chat' || pack.kind === 'named') && await active(pack.pack.id)) return pack.pack.id;
  if (pack.kind === 'ambiguous' || !words) return null;
  const said = words.toLowerCase().normalize('NFKC');
  const rows = (await sql<{ id: string; code: string; name: string }>`SELECT id::text, code, name FROM hawa.clients
    WHERE tenant_id = ${tenantId}::uuid AND status = 'active' LIMIT 500`.execute(trx)).rows;
  const named = rows.filter((row) => [row.code, row.name].some((value) => {
    const v = String(value || '').toLowerCase().normalize('NFKC').trim();
    if (v.length < 3) return false;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // A whole word: a Sorani suffix after a Latin name is still the name ("KAAEی").
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![A-Za-z0-9])`, 'u').test(said);
  }));
  return named.length === 1 ? named[0].id : null;
}

// --- questions about a source, and their answers ------------------------------------------------------

export type SourceNeed = 'client' | 'target';
export interface SourceOption { requestId: string; title: string }
export interface SourceQuestion {
  sourceUpdateId: number; need: SourceNeed; chatId: string; senderId: string; topicId: string; messageId: string;
  options: SourceOption[];
}

/** Asks one question about a source (once per source and need). */
export async function askAboutSource(trx: Tx, tenantId: string, question: SourceQuestion): Promise<void> {
  await insertRow(trx, tenantId, 'lifecycle_source_pending', `${question.sourceUpdateId}:${question.need}`,
    { ...question }, sha(`${question.sourceUpdateId}:${question.need}`));
}

export interface SourceResolution { byUpdateId: number; clientId?: string; targetRequestId?: string; isNew?: boolean }

export async function readResolution(trx: Tx, tenantId: string, sourceUpdateId: number, need: SourceNeed): Promise<SourceResolution | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_source_resolution', `${sourceUpdateId}:${need}`);
  return row ? row.payload as unknown as SourceResolution : null;
}
/** Records the answer to one question; the first answer stands. */
export async function resolveSource(trx: Tx, tenantId: string, sourceUpdateId: number, need: SourceNeed,
  resolution: SourceResolution): Promise<SourceResolution> {
  await insertRow(trx, tenantId, 'lifecycle_source_resolution', `${sourceUpdateId}:${need}`, { ...resolution },
    sha(`${sourceUpdateId}:${need}:${resolution.byUpdateId}`));
  return (await readResolution(trx, tenantId, sourceUpdateId, need))!;
}

/** The sender's newest question about a source that is still open (a day at most). */
export async function openSourceQuestion(trx: Tx, tenantId: string, scope: { chatId: string; senderId: string; topicId: string }):
  Promise<SourceQuestion | null> {
  const row = (await sql<{ payload: SourceQuestion }>`SELECT q.payload FROM hawa.inbox_events q
    WHERE q.tenant_id = ${tenantId}::uuid AND q.source_account_id = 'lifecycle_source_pending'
      AND q.payload->>'chatId' = ${scope.chatId} AND q.payload->>'senderId' = ${scope.senderId}
      AND q.payload->>'topicId' = ${scope.topicId} AND q.received_at > now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events r WHERE r.tenant_id = q.tenant_id
        AND r.source_account_id = 'lifecycle_source_resolution' AND r.source_event_id = q.source_event_id)
    ORDER BY q.received_at DESC, q.id DESC LIMIT 1`.execute(trx)).rows[0];
  return row?.payload ?? null;
}

// --- the words to confirm ---------------------------------------------------------------------------

/**
 * What the requester was shown to confirm: the whole text when it is short enough to confirm with
 * "yes", else only its start (the requester sends the words to print). Recorded once per source.
 */
export interface SourceCandidate { sourceUpdateId: number; text: string; confirmable: boolean }

export async function recordCandidate(trx: Tx, tenantId: string, candidate: SourceCandidate): Promise<SourceCandidate> {
  await insertRow(trx, tenantId, 'lifecycle_source_candidate', String(candidate.sourceUpdateId), { ...candidate },
    sha(`${candidate.sourceUpdateId}:${candidate.text}`));
  const row = await readRow(trx, tenantId, 'lifecycle_source_candidate', String(candidate.sourceUpdateId));
  return row!.payload as unknown as SourceCandidate;
}
export async function readCandidate(trx: Tx, tenantId: string, sourceUpdateId: number): Promise<SourceCandidate | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_source_candidate', String(sourceUpdateId));
  return row ? row.payload as unknown as SourceCandidate : null;
}

/**
 * The sender's newest source whose words were shown and not yet confirmed (a day at most): the one a
 * "yes" or a corrected text confirms. A newer source of theirs replaces an older one.
 */
export async function unconfirmedSource(trx: Tx, tenantId: string, scope: { chatId: string; senderId: string; topicId: string }):
  Promise<number | null> {
  const row = (await sql<{ source_event_id: string; confirmed: boolean }>`SELECT u.source_event_id,
      EXISTS (SELECT 1 FROM hawa.inbox_events c WHERE c.tenant_id = u.tenant_id AND c.source_account_id = 'lifecycle_source_confirmation'
        AND c.source_event_id = u.source_event_id) AS confirmed
    FROM hawa.inbox_events u
    WHERE u.tenant_id = ${tenantId}::uuid AND u.source_account_id = 'lifecycle_source_upload' AND u.event_kind = 'lifecycle_source_upload'
      AND u.payload->>'chatId' = ${scope.chatId} AND u.payload->>'senderId' = ${scope.senderId}
      AND u.payload->>'topicId' = ${scope.topicId} AND u.received_at > now() - interval '1 day'
      AND EXISTS (SELECT 1 FROM hawa.inbox_events k WHERE k.tenant_id = u.tenant_id AND k.source_account_id = 'lifecycle_source_candidate'
        AND k.source_event_id = u.source_event_id)
    ORDER BY u.received_at DESC, u.id DESC LIMIT 1`.execute(trx)).rows[0];
  return row && !row.confirmed ? Number(row.source_event_id) : null;
}

// --- reading the requester's reply ---------------------------------------------------------------------

/** English and Sorani words that confirm ("yes", "that's right", "بەڵێ" yes, "ڕاستە" it is right). */
const YES = /^(?:yes|yeah|yep|yup|ya|correct|right|exactly|confirmed?|perfect|ok(?:ay)?|sure|that'?s\s+(?:right|correct|it)|it'?s\s+(?:right|correct)|looks\s+(?:right|good|correct)|all\s+good|good|👍|✅|👌|بەڵێ|بەلێ|ئەرێ|ڕاستە|دروستە|تەواوە|باشە|هەمووی\s+ڕاستە)(?:[\s,.!]+(?:yes|correct|thanks?|thank\s+you|please|سوپاس|بەڵێ|ڕاستە))*[\s.!👍✅]*$/iu;
/** "no", "wrong", "not right", "نەخێر" (no), "هەڵەیە" (it is wrong): the corrected text is asked for. */
const NO = /^(?:no|nope|nah|wrong|incorrect|not\s+(?:right|correct)|that'?s\s+(?:wrong|not\s+right)|نەخێر|نا|هەڵەیە|ڕاست\s+نییە)[\s.!]*$/iu;

export type SourceReply = { kind: 'yes' } | { kind: 'no' } | { kind: 'copy'; copy: string } | { kind: 'other' };

/** Words of three letters or more (two in Arabic script), for comparing a correction with the words shown. */
const wordsOf = (text: string) => new Set(text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w.length >= (/[؀-ۿ]/.test(w) ? 2 : 3)));

/** Whether a reply repeats much of the words shown (a corrected copy of them), not other words. */
export function repeatsShownWords(reply: string, shown: string): boolean {
  const said = wordsOf(reply);
  const candidate = wordsOf(shown);
  if (!said.size || !candidate.size) return false;
  const shared = [...said].filter((w) => candidate.has(w)).length;
  return shared >= 2 && shared / Math.min(said.size, candidate.size) >= 0.4;
}

/** A question, not copy: it ends in a question mark, or opens as one. */
const QUESTION = /[?؟]\s*$|^(?:what|which|how|who|where|when|why|can|could|would|will|do|does|is|are)\b[^\n]*$/i;

/**
 * ADR-156 (audit #13): a plain answer to "Which organisation is it for?": a few words ("KAAE", "it's for
 * the engineers' union"), not a question, a change, a new brief or any other request. A longer message
 * that happens to name an organisation is read as any message is, and the question stays open.
 */
export function plainClientAnswer(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('/') || isAcknowledgement(t) || t.split(/\s+/).length > 6 || QUESTION.test(t)) return false;
  const reading = readIntentByRules(t);
  return !['status', 'cancel', 'approval', 'deadline', 'delivery_request', 'change'].includes(reading.intent) && !reading.explicitNew;
}

/**
 * What a text message means while its sender's words wait to be confirmed: "yes" confirms them, "no"
 * asks for the corrected text, and the corrected text itself is taken exactly as sent.
 *
 * ADR-156 (audit #13): only words that look like the copy are the corrected text: words that repeat
 * much of what was shown, or copy-shaped words that are not a request, a change, a question or chat.
 * Everything else (thanks, a status question, a cancel, a new brief, "also make the background blue",
 * "what fonts do you have?", "hello") is read as any message is, and the words stay unconfirmed.
 */
export function readSourceReply(text: string, shown = ''): SourceReply {
  const t = text.trim();
  if (!t) return { kind: 'other' };
  if (YES.test(t)) return { kind: 'yes' };
  if (NO.test(t)) return { kind: 'no' };
  if (t.startsWith('/')) return { kind: 'other' };
  if (isAcknowledgement(t)) return { kind: 'other' };
  const reading = readIntentByRules(t);
  if (['acknowledgement', 'status', 'cancel', 'approval', 'deadline', 'delivery_request'].includes(reading.intent)) return { kind: 'other' };
  if (shown && repeatsShownWords(t, shown)) return { kind: 'copy', copy: text };
  if (reading.intent === 'change' || reading.intent === 'conversation' || reading.explicitNew || QUESTION.test(t)) return { kind: 'other' };
  return { kind: 'copy', copy: text };
}
