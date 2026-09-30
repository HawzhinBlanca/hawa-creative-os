/**
 * One brief sent as several messages (ADR-156, audit #10).
 *
 * Telegram splits a message longer than 4,096 characters into several, sent within a second; a
 * requester who forwards an invitation often forwards several messages at once. Each arrives as its own
 * update. Read one by one, the first opened a paid draft with half the copy and the rest became a
 * second request or a change.
 *
 * ADR-143 already holds a text brief for a few seconds (`lifecycle_brief_held`) so that photos sent
 * right after it join it. A text from the same sender, chat and topic that arrives while that brief is
 * held, and continues it, is joined to it (`lifecycle_brief_part`, keyed by its own update, first write
 * wins) instead of being read on its own. It continues the brief when it came within a few seconds of
 * the part before it (bounded: `HAWA_BRIEF_PART_SECONDS`, default 5, at most 30) and either the part
 * before it was long enough to have been split by Telegram, or both are forwarded messages. The
 * brief opens, at its settle, with every part in the order they were sent.
 *
 * ADR-182: people also type a brief as several short messages, add a line of style right after it, or
 * send a forward right after "make a poster from the message below". Such a message continues the
 * brief when it came within the brief's own hold of the part before it and its words read as more of
 * the brief (`TypedContinuation`); the brief then waits until its sender has been quiet for that long.
 */
import { sql, type Database, type Kysely } from '@hawa/db';

type Tx = Kysely<Database>;
type Json = Record<string, any>;

/** Telegram splits at 4,096 characters; a part this long or longer was most likely split. */
export const SPLIT_PART_CHARS = 3000;
/** How long after the part before it a continuation may arrive (Telegram message dates are in seconds). */
export const briefPartSeconds = (): number => {
  const seconds = Number(process.env.HAWA_BRIEF_PART_SECONDS);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 30 ? Math.round(seconds) : 5;
};
const MAX_PARTS = 20;
const MAX_CHARS = 100_000;

export interface PartMessage { text: string; date: number; forwarded: boolean; reply: boolean }

/** The fields of a Telegram message that decide whether it continues a brief. */
export function partMessage(message: Json | null | undefined): PartMessage | null {
  if (!message || typeof message !== 'object' || typeof message.text !== 'string' || !Number.isSafeInteger(message.date)) return null;
  return { text: message.text, date: Number(message.date),
    forwarded: Boolean(message.forward_origin || message.forward_date || message.forward_from || message.forward_sender_name || message.forward_from_chat),
    reply: Boolean(message.reply_to_message) };
}

/**
 * Whether `next` continues the brief whose last part is `previous`: sent within the window, not a
 * reply or a command, and either `previous` was long enough to have been split, or both were forwarded.
 * The separator keeps a split part's line and puts a blank line between forwards.
 */
export function continuesBrief(previous: PartMessage, next: PartMessage, windowSeconds = briefPartSeconds(),
  typed?: TypedContinuation, soFar = previous.text): { separator: string; typed?: true } | null {
  const gap = next.date - previous.date;
  if (!next.text.trim() || next.reply || next.text.trim().startsWith('/') || gap < 0) return null;
  if (gap <= windowSeconds) {
    if (previous.forwarded && next.forwarded) return { separator: '\n\n' };
    if (previous.text.length >= SPLIT_PART_CHARS && !next.forwarded) return { separator: '\n' };
  }
  // ADR-182: a brief typed as several messages, or a forward sent right after its instruction.
  if (typed && gap <= typed.windowSeconds) {
    if (next.forwarded && !previous.forwarded) return { separator: '\n\n', typed: true };
    if (!next.forwarded && typed.continues(next.text, soFar)) return { separator: previous.forwarded ? '\n\n' : '\n', typed: true };
  }
  return null;
}

/**
 * ADR-182: how a typed message continues a held brief: within `windowSeconds` of the part before it
 * (the brief's own hold for photos, HAWA_BRIEF_PHOTO_WAIT_MS), when `continues` reads its words as
 * more of the brief so far (requester-turn.ts `readsAsBriefContinuation`).
 */
export interface TypedContinuation { windowSeconds: number; continues(text: string, soFar: string): boolean }

/**
 * When the last typed part joined to a held brief arrived (ms since the epoch), or null with none. A
 * Telegram split or a set of forwards arrives within a second and waits for nothing more (ADR-156).
 */
export async function lastBriefPartAt(trx: Tx, tenantId: string, heldUpdateId: number): Promise<number | null> {
  const at = (await sql<{ at: number | null }>`SELECT (extract(epoch FROM max(received_at)) * 1000)::float8 AS at
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_brief_part'
      AND payload->>'held' = ${String(heldUpdateId)} AND payload->>'typed' = 'true'`.execute(trx)).rows[0]?.at;
  return at === null || at === undefined ? null : Number(at);
}

export interface BriefPart { updateId: number; heldUpdateId: number; text: string; separator: string; date: number; payloadHash: string }

export async function readBriefPart(trx: Tx, tenantId: string, updateId: number): Promise<BriefPart | null> {
  const row = (await sql<{ payload: Json; payload_hash: string }>`SELECT payload, payload_hash FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_brief_part' AND source_event_id = ${String(updateId)}
    LIMIT 1`.execute(trx)).rows[0];
  if (!row) return null;
  const p = row.payload;
  if (!Number.isSafeInteger(p.held) || typeof p.text !== 'string' || typeof p.separator !== 'string') throw new Error('Invalid stored brief part');
  return { updateId, heldUpdateId: Number(p.held), text: p.text, separator: p.separator, date: Number(p.date), payloadHash: row.payload_hash };
}

/** The parts joined to a held brief, in the order they were sent. */
export async function briefParts(trx: Tx, tenantId: string, heldUpdateId: number): Promise<BriefPart[]> {
  const rows = (await sql<{ source_event_id: string }>`SELECT source_event_id FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_brief_part' AND payload->>'held' = ${String(heldUpdateId)}
    ORDER BY (payload->>'date')::bigint, source_event_id::bigint LIMIT ${MAX_PARTS}`.execute(trx)).rows;
  const parts: BriefPart[] = [];
  for (const row of rows) {
    const part = await readBriefPart(trx, tenantId, Number(row.source_event_id));
    if (part) parts.push(part);
  }
  return parts;
}

/** The brief's words with its joined parts after them. */
export function joinedWords(first: string, parts: Array<Pick<BriefPart, 'text' | 'separator'>>): string {
  return parts.reduce((words, part) => `${words}${part.separator}${part.text.trim()}`, first);
}

/**
 * Joins `update` (a text message) to the sender's held brief when it continues it. Returns whether it
 * was joined. The caller holds the sender's scope (the brief is still held, not released or consumed).
 */
export async function joinBriefPart(trx: Tx, tenantId: string, update: { update_id: number; message?: unknown },
  heldUpdateId: number, payloadHash: string, typed?: TypedContinuation): Promise<boolean> {
  const next = partMessage(update.message as Json);
  if (!next) return false;
  const held = (await sql<{ update: Json }>`SELECT payload->'update' AS update FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_brief_held' AND source_event_id = ${String(heldUpdateId)}
    LIMIT 1`.execute(trx)).rows[0];
  const first = partMessage(held?.update?.message);
  if (!first) return false;
  const parts = await briefParts(trx, tenantId, heldUpdateId);
  if (parts.length >= MAX_PARTS) return false;
  const last = parts.at(-1);
  const previous: PartMessage = last
    ? { text: last.text, date: last.date, forwarded: first.forwarded, reply: false }
    : first;
  const joins = continuesBrief(previous, next, briefPartSeconds(), typed, joinedWords(first.text, parts));
  if (!joins || joinedWords(first.text, parts).length + next.text.length > MAX_CHARS) return false;
  const message = update.message as Json;
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'lifecycle_brief_part', ${String(update.update_id)}, 'lifecycle_brief_part',
      ${JSON.stringify({ held: heldUpdateId, chatId: String(message.chat?.id ?? ''), senderId: String(message.from?.id ?? ''),
        text: next.text, separator: joins.separator, date: next.date, ...(joins.typed ? { typed: true } : {}) })}::jsonb, ${payloadHash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await readBriefPart(trx, tenantId, update.update_id);
  return Boolean(stored && stored.payloadHash === payloadHash && stored.heldUpdateId === heldUpdateId);
}
