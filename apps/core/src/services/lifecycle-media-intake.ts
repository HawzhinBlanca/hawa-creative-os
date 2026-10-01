/**
 * The durable records behind natural media intake (ADR-145), in the inbox ledger each decision of
 * Core's Telegram intake already uses (`hawa.inbox_events`, one row per update and kind, first write
 * wins, so a replay reads the first decision back and nothing is used twice):
 *
 *  - `lifecycle_photo_held`: a photo sent with no words and no reply, kept (its bytes in the blob
 *    store) until its sender's words arrive; `lifecycle_photo_used` says which update used it, once;
 *    `lifecycle_photo_asked` that the bot asked what to design with it.
 *  - `lifecycle_text_deferred` / `lifecycle_text_released`: a message that arrived while its sender's
 *    brief was still held for photos (ADR-143), set behind that brief so it is read once the brief has
 *    opened (ChatInbox runs one update of a chat at a time, so the message cannot simply wait).
 *  - `lifecycle_media_answer`: the words said about a video, an unreadable file or an edit, given
 *    again word for word on a replay.
 *  - `lifecycle_unlisted_reply`: that a sender outside the intake list was answered in a chat today.
 *    Only the chat, the day and the update are kept (N5): no words, no name.
 */
import { createHash } from 'node:crypto';
import { parseBlobRef, type BlobRef } from '@hawa/contracts';
import { sql, type Database, type Kysely } from '@hawa/db';

type Tx = Kysely<Database>;
type Json = Record<string, unknown>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** How long a captionless photo waits for its sender's words, and a brief for a photo after it. */
export const photoJoinMs = (): number => {
  const minutes = Number(process.env.HAWA_PHOTO_JOIN_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? Math.round(minutes) : 5) * 60_000;
};
/** Once the bot has asked what to design with a photo, it waits as long as an album with no words (ADR-143). */
export const askedPhotoMs = (): number => {
  const minutes = Number(process.env.HAWA_ALBUM_BRIEF_WINDOW_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 && minutes <= 7 * 24 * 60 ? Math.round(minutes) : 120) * 60_000;
};
/** A held brief is never held longer than this (ADR-143's own bound); a message is never deferred longer. */
const HELD_BRIEF_MS = 10 * 60_000;

async function readRow(trx: Tx, tenantId: string, kind: string, id: string): Promise<{ payload: Json; payload_hash: string; at: number } | null> {
  const row = (await sql<{ payload: Json; payload_hash: string; at: number }>`SELECT payload, payload_hash,
      (extract(epoch FROM received_at) * 1000)::float8 AS at FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${kind} AND source_event_id = ${id}
    LIMIT 1`.execute(trx)).rows[0];
  return row ? { ...row, at: Number(row.at) } : null;
}
async function insertRow(trx: Tx, tenantId: string, kind: string, id: string, payload: Json, hash: string): Promise<void> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, ${kind}, ${id}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${hash}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
}
const nowMs = async (trx: Tx) =>
  Number((await sql<{ now: number }>`SELECT (extract(epoch FROM now()) * 1000)::float8 AS now`.execute(trx)).rows[0].now);

export interface SenderScope { chatId: string; senderId: string; topic: string }

// --- held photos -----------------------------------------------------------------------------------

export interface HeldPhoto extends SenderScope {
  updateId: number;
  messageId: string;
  image: BlobRef;
  /** When the photo arrived (ms since the epoch, the ledger's clock). */
  at: number;
}

export async function readHeldPhoto(trx: Tx, tenantId: string, updateId: number): Promise<HeldPhoto | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_photo_held', String(updateId));
  if (!row) return null;
  const image = parseBlobRef(row.payload.image);
  if (!image || typeof row.payload.chatId !== 'string' || typeof row.payload.senderId !== 'string')
    throw new Error('Invalid stored held photo');
  return { updateId, chatId: row.payload.chatId, senderId: row.payload.senderId, topic: String(row.payload.topic ?? ''),
    messageId: String(row.payload.messageId ?? ''), image, at: row.at };
}

/** Keeps a captionless photo for its sender's words. `payloadHash` pins the update it came from. */
export async function holdPhoto(trx: Tx, tenantId: string, photo: Omit<HeldPhoto, 'at'>, payloadHash: string,
  update: unknown): Promise<HeldPhoto> {
  // The update is kept so that an overdue settle (the sweep) can be sent again, as ADR-143 keeps a held brief's.
  await insertRow(trx, tenantId, 'lifecycle_photo_held', String(photo.updateId), {
    chatId: photo.chatId, senderId: photo.senderId, topic: photo.topic, messageId: photo.messageId, image: photo.image, update,
  }, payloadHash);
  const row = await readRow(trx, tenantId, 'lifecycle_photo_held', String(photo.updateId));
  if (!row || row.payload_hash !== payloadHash) throw new Error('This held photo already has different content');
  return (await readHeldPhoto(trx, tenantId, photo.updateId))!;
}

/** `album`: the photo is one of a photo burst (ADR-160 addendum), decided with its set by the album settle. */
export interface PhotoUse { byUpdateId: number; how: 'brief' | 'revision' | 'joined' | 'passed' | 'album'; requestId?: string }

export async function readPhotoUse(trx: Tx, tenantId: string, photoUpdateId: number): Promise<PhotoUse | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_photo_used', String(photoUpdateId));
  if (!row) return null;
  return { byUpdateId: Number(row.payload.byUpdateId), how: row.payload.how as PhotoUse['how'],
    ...(typeof row.payload.requestId === 'string' ? { requestId: row.payload.requestId } : {}) };
}

/** Claims a held photo for one update. Returns the claim that stands: this one, or an earlier one. */
export async function claimPhoto(trx: Tx, tenantId: string, photoUpdateId: number, use: PhotoUse): Promise<PhotoUse> {
  await insertRow(trx, tenantId, 'lifecycle_photo_used', String(photoUpdateId), { ...use },
    sha(`${photoUpdateId}:${use.byUpdateId}`));
  return (await readPhotoUse(trx, tenantId, photoUpdateId))!;
}

export async function markPhotoAsked(trx: Tx, tenantId: string, photoUpdateId: number): Promise<void> {
  await insertRow(trx, tenantId, 'lifecycle_photo_asked', String(photoUpdateId), {}, sha(String(photoUpdateId)));
}

/**
 * The sender's photos that are waiting for words at `now`: held, not used, from the same chat and
 * topic, within the join window (or the longer window once the bot asked about them). Oldest first.
 */
export async function waitingPhotos(trx: Tx, tenantId: string, scope: SenderScope, now?: number): Promise<HeldPhoto[]> {
  const at = now ?? await nowMs(trx);
  const rows = (await sql<{ source_event_id: string; asked: boolean }>`SELECT h.source_event_id,
      EXISTS (SELECT 1 FROM hawa.inbox_events a WHERE a.tenant_id = h.tenant_id AND a.source_account_id = 'lifecycle_photo_asked'
        AND a.source_event_id = h.source_event_id) AS asked
    FROM hawa.inbox_events h
    WHERE h.tenant_id = ${tenantId}::uuid AND h.source_account_id = 'lifecycle_photo_held'
      AND h.payload->>'chatId' = ${scope.chatId} AND h.payload->>'senderId' = ${scope.senderId}
      AND coalesce(h.payload->>'topic', '') = ${scope.topic}
      AND h.received_at > to_timestamp(${(at - Math.max(photoJoinMs(), askedPhotoMs())) / 1000})
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events u WHERE u.tenant_id = h.tenant_id
        AND u.source_account_id = 'lifecycle_photo_used' AND u.source_event_id = h.source_event_id)
    ORDER BY h.received_at, h.id LIMIT 10`.execute(trx)).rows;
  const photos: HeldPhoto[] = [];
  for (const row of rows) {
    const photo = await readHeldPhoto(trx, tenantId, Number(row.source_event_id));
    if (photo && at - photo.at <= (row.asked ? askedPhotoMs() : photoJoinMs())) photos.push(photo);
  }
  return photos;
}

/**
 * The request the sender's words opened in the last few minutes, before `beforeMs`: the one a
 * captionless photo sent right after a brief joins. Read from the open decisions this sender's text
 * or captioned photo made (ADR-144's intent record names the sender; a photo brief keeps its update).
 */
export async function recentOpenBy(trx: Tx, tenantId: string, scope: SenderScope, beforeMs: number):
  Promise<{ requestId: string; updateId: number; at: number; album: boolean;ambiguous:boolean } | null> {
  const row = (await sql<{ source_event_id: string; request_id: string; at: number; album: boolean;ambiguous:boolean }>`SELECT o.source_event_id,
      o.payload->>'requestId' AS request_id, (extract(epoch FROM o.received_at) * 1000)::float8 AS at,
      (o.payload->'draft'->'lifecycleAlbum') IS NOT NULL AS album,
      jsonb_array_length(coalesce(o.payload->'siblings','[]'::jsonb))>0 AS ambiguous
    FROM hawa.inbox_events o
    WHERE o.tenant_id = ${tenantId}::uuid AND o.source_account_id = 'lifecycle_chat_open'
      AND o.payload->>'chatId' = ${scope.chatId}
      AND o.received_at > to_timestamp(${(beforeMs - photoJoinMs()) / 1000}) AND o.received_at <= to_timestamp(${beforeMs / 1000})
      AND (EXISTS (SELECT 1 FROM hawa.inbox_events i WHERE i.tenant_id = o.tenant_id AND i.source_account_id = 'lifecycle_chat_intent'
            AND i.source_event_id = o.source_event_id AND i.payload->>'senderId' = ${scope.senderId})
        OR o.payload->'sourceUpdate'->'message'->'from'->>'id' = ${scope.senderId}
        OR EXISTS (SELECT 1 FROM hawa.inbox_events b WHERE b.tenant_id = o.tenant_id AND b.source_account_id = 'lifecycle_brief_held'
            AND b.source_event_id = o.source_event_id AND b.payload->>'senderId' = ${scope.senderId}))
    ORDER BY o.received_at DESC, o.id DESC LIMIT 1`.execute(trx)).rows[0];
  return row ? { requestId: row.request_id, updateId: Number(row.source_event_id), at: Number(row.at), album: row.album,ambiguous:row.ambiguous } : null;
}

/** The sender's brief ADR-143 still holds for photos (not released, not taken by an album), if any. */
export async function pendingHeldBrief(trx: Tx, tenantId: string, scope: SenderScope, exceptUpdateId: number, now?: number):
  Promise<{ updateId: number; at: number } | null> {
  const at = now ?? await nowMs(trx);
  const row = (await sql<{ source_event_id: string; at: number }>`SELECT h.source_event_id,
      (extract(epoch FROM h.received_at) * 1000)::float8 AS at FROM hawa.inbox_events h
    WHERE h.tenant_id = ${tenantId}::uuid AND h.source_account_id = 'lifecycle_brief_held'
      AND h.payload->>'chatId' = ${scope.chatId} AND h.payload->>'senderId' = ${scope.senderId}
      AND coalesce(h.payload->>'topic', '') = ${scope.topic} AND h.source_event_id <> ${String(exceptUpdateId)}
      AND h.received_at > to_timestamp(${(at - HELD_BRIEF_MS) / 1000})
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events s WHERE s.tenant_id = h.tenant_id
        AND s.source_account_id IN ('lifecycle_brief_consumed', 'lifecycle_brief_released')
        AND s.source_event_id = h.source_event_id)
    ORDER BY h.received_at DESC LIMIT 1`.execute(trx)).rows[0];
  return row ? { updateId: Number(row.source_event_id), at: Number(row.at) } : null;
}

// --- messages set behind a held brief ----------------------------------------------------------------

export async function readDeferral(trx: Tx, tenantId: string, updateId: number):
  Promise<{ behind: number; payloadHash: string; released: boolean; at: number } | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_text_deferred', String(updateId));
  if (!row) return null;
  const released = Boolean(await readRow(trx, tenantId, 'lifecycle_text_released', String(updateId)));
  return { behind: Number(row.payload.behind), payloadHash: row.payload_hash, released, at: row.at };
}

export async function deferMessage(trx: Tx, tenantId: string, updateId: number, scope: SenderScope, behind: number,
  payloadHash: string, update: unknown): Promise<{ behind: number; payloadHash: string }> {
  await insertRow(trx, tenantId, 'lifecycle_text_deferred', String(updateId), { ...scope, behind, update }, payloadHash);
  const stored = await readDeferral(trx, tenantId, updateId);
  if (!stored || stored.payloadHash !== payloadHash) throw new Error('This deferred message already has different content');
  return stored;
}

export async function releaseDeferral(trx: Tx, tenantId: string, updateId: number): Promise<void> {
  await insertRow(trx, tenantId, 'lifecycle_text_released', String(updateId), {}, sha(`released:${updateId}`));
}

/** Deferred messages whose settle is overdue (the sweep asks again): at most ten minutes old. */
export async function overdueDeferrals(trx: Tx, tenantId: string, limit = 50): Promise<Array<{ chatId: string; update: Json }>> {
  return (await sql<{ chat_id: string; update: Json }>`SELECT d.payload->>'chatId' AS chat_id, d.payload->'update' AS update
    FROM hawa.inbox_events d
    WHERE d.tenant_id = ${tenantId}::uuid AND d.source_account_id = 'lifecycle_text_deferred'
      AND d.received_at < now() - interval '75 seconds' AND d.received_at > now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events r WHERE r.tenant_id = d.tenant_id
        AND r.source_account_id = 'lifecycle_text_released' AND r.source_event_id = d.source_event_id)
    ORDER BY d.received_at LIMIT ${limit}`.execute(trx)).rows.filter((r) => r.update).map((r) => ({ chatId: r.chat_id, update: r.update }));
}

/** Held photos whose settle is overdue and that were neither used nor asked about. */
export async function overduePhotos(trx: Tx, tenantId: string, limit = 50): Promise<Array<{ chatId: string; update: Json }>> {
  return (await sql<{ chat_id: string; update: Json }>`SELECT h.payload->>'chatId' AS chat_id, h.payload->'update' AS update
    FROM hawa.inbox_events h
    WHERE h.tenant_id = ${tenantId}::uuid AND h.source_account_id = 'lifecycle_photo_held'
      AND h.received_at < now() - interval '75 seconds' AND h.received_at > now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events u WHERE u.tenant_id = h.tenant_id
        AND u.source_account_id IN ('lifecycle_photo_used', 'lifecycle_photo_asked') AND u.source_event_id = h.source_event_id)
    ORDER BY h.received_at LIMIT ${limit}`.execute(trx)).rows.filter((r) => r.update).map((r) => ({ chatId: r.chat_id, update: r.update }));
}

// --- answers given once ------------------------------------------------------------------------------

export interface StoredAnswer { status: number; extra: Record<string, unknown> }

export async function readMediaAnswer(trx: Tx, tenantId: string, updateId: number): Promise<(StoredAnswer & { payloadHash: string }) | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_media_answer', String(updateId));
  if (!row) return null;
  const answer = row.payload.answer as StoredAnswer | undefined;
  if (!answer || typeof answer.status !== 'number' || !answer.extra) throw new Error('Invalid stored media answer');
  return { ...answer, payloadHash: row.payload_hash };
}

/** Records the answer once; the first record wins and is what a replay gives. */
export async function recordMediaAnswer(trx: Tx, tenantId: string, updateId: number, payloadHash: string,
  answer: StoredAnswer): Promise<StoredAnswer & { payloadHash: string }> {
  await insertRow(trx, tenantId, 'lifecycle_media_answer', String(updateId), { answer }, payloadHash);
  return (await readMediaAnswer(trx, tenantId, updateId))!;
}

// --- senders outside the intake list (N5) -----------------------------------------------------------

/**
 * Whether this update is the one a chat outside the intake list is answered for today (UTC day). The
 * first update of the day wins; a replay of that update is answered again, every other update is not.
 */
export async function unlistedReplyDue(trx: Tx, tenantId: string, chatId: string, updateId: number,
  lang: 'en' | 'ckb'): Promise<{ due: boolean; lang: 'en' | 'ckb' }> {
  const day = (await sql<{ day: string }>`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`.execute(trx)).rows[0].day;
  const id = `${chatId}:${day}`;
  await insertRow(trx, tenantId, 'lifecycle_unlisted_reply', id, { updateId, lang }, sha(`${id}:${updateId}`));
  const row = await readRow(trx, tenantId, 'lifecycle_unlisted_reply', id);
  return { due: Number(row?.payload.updateId) === updateId, lang: row?.payload.lang === 'ckb' ? 'ckb' : 'en' };
}

// --- edited messages ---------------------------------------------------------------------------------

/** What an edit was decided to be, recorded once so that a replay decides the same. */
export type EditDecision = { kind: 'reread' } | { kind: 'answered' };

export async function readEditDecision(trx: Tx, tenantId: string, updateId: number): Promise<(EditDecision & { payloadHash: string }) | null> {
  const row = await readRow(trx, tenantId, 'lifecycle_edit_decision', String(updateId));
  return row ? { kind: row.payload.kind === 'reread' ? 'reread' : 'answered', payloadHash: row.payload_hash } : null;
}
export async function recordEditDecision(trx: Tx, tenantId: string, updateId: number, decision: EditDecision,
  payloadHash: string): Promise<EditDecision & { payloadHash: string }> {
  await insertRow(trx, tenantId, 'lifecycle_edit_decision', String(updateId), { ...decision }, payloadHash);
  return (await readEditDecision(trx, tenantId, updateId))!;
}

/**
 * New words for a message the bot has not read yet (a brief held for photos, a message set behind it,
 * a voice note or PDF not confirmed): kept under the edit's update, and used when that message is read.
 */
export async function recordPendingEdit(trx: Tx, tenantId: string, editUpdateId: number, target: number, words: string,
  payloadHash: string): Promise<void> {
  await insertRow(trx, tenantId, 'lifecycle_edit_pending', String(editUpdateId), { target, words }, payloadHash);
}
/** The newest words an edit gave the message `target`, if any. */
export async function pendingEditWords(trx: Tx, tenantId: string, target: number): Promise<string | null> {
  const row = (await sql<{ words: string }>`SELECT payload->>'words' AS words FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_edit_pending' AND payload->>'target' = ${String(target)}
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0];
  return typeof row?.words === 'string' ? row.words : null;
}

export type OriginalMessage =
  | { kind: 'intent'; updateId: number; plan: { kind: string; requestId?: string } }
  | { kind: 'open'; updateId: number; requestId: string;ambiguous?:true }
  | { kind: 'held-photo'; updateId: number; used: boolean }
  | { kind: 'held-brief'; updateId: number }
  | { kind: 'deferred'; updateId: number }
  | { kind: 'source'; updateId: number; confirmed: boolean };

/** What the bot did with the message `messageId` of this chat, from its own records. */
export async function originalMessage(trx: Tx, tenantId: string, chatId: string, messageId: string): Promise<OriginalMessage | null> {
  const held = (await sql<{ source_event_id: string; released: boolean }>`SELECT h.source_event_id,
      EXISTS (SELECT 1 FROM hawa.inbox_events s WHERE s.tenant_id = h.tenant_id
        AND s.source_account_id IN ('lifecycle_brief_consumed', 'lifecycle_brief_released') AND s.source_event_id = h.source_event_id) AS released
    FROM hawa.inbox_events h WHERE h.tenant_id = ${tenantId}::uuid AND h.source_account_id = 'lifecycle_brief_held'
      AND h.payload->>'chatId' = ${chatId} AND h.payload->'update'->'message'->>'message_id' = ${messageId}
    ORDER BY h.received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (held && !held.released) return { kind: 'held-brief', updateId: Number(held.source_event_id) };
  const deferred = (await sql<{ source_event_id: string }>`SELECT d.source_event_id FROM hawa.inbox_events d
    WHERE d.tenant_id = ${tenantId}::uuid AND d.source_account_id = 'lifecycle_text_deferred'
      AND d.payload->>'chatId' = ${chatId} AND d.payload->'update'->'message'->>'message_id' = ${messageId}
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events r WHERE r.tenant_id = d.tenant_id AND r.source_account_id = 'lifecycle_text_released'
        AND r.source_event_id = d.source_event_id)
    ORDER BY d.received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (deferred) return { kind: 'deferred', updateId: Number(deferred.source_event_id) };
  const intent = (await sql<{ source_event_id: string; plan: { kind: string; requestId?: string } }>`SELECT source_event_id, payload->'plan' AS plan
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_intent'
      AND payload->>'chatId' = ${chatId} AND payload->>'messageId' = ${messageId}
    ORDER BY received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (intent?.plan?.kind) return { kind: 'intent', updateId: Number(intent.source_event_id), plan: intent.plan };
  const open = (await sql<{ source_event_id: string; request_id: string;ambiguous:boolean }>`SELECT source_event_id, payload->>'requestId' AS request_id,
      jsonb_array_length(coalesce(payload->'siblings','[]'::jsonb))>0 AS ambiguous
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
      AND payload->>'chatId' = ${chatId} AND payload->'sourceUpdate'->'message'->>'message_id' = ${messageId}
    ORDER BY received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (open) return { kind: 'open', updateId: Number(open.source_event_id), requestId: open.request_id,...(open.ambiguous ? {ambiguous:true} : {}) };
  const photo = (await sql<{ source_event_id: string; used: boolean }>`SELECT h.source_event_id,
      EXISTS (SELECT 1 FROM hawa.inbox_events u WHERE u.tenant_id = h.tenant_id AND u.source_account_id = 'lifecycle_photo_used'
        AND u.source_event_id = h.source_event_id) AS used
    FROM hawa.inbox_events h WHERE h.tenant_id = ${tenantId}::uuid AND h.source_account_id = 'lifecycle_photo_held'
      AND h.payload->>'chatId' = ${chatId} AND h.payload->>'messageId' = ${messageId}
    ORDER BY h.received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (photo) return { kind: 'held-photo', updateId: Number(photo.source_event_id), used: photo.used };
  const source = (await sql<{ source_id: string; confirmed: boolean }>`SELECT s.source_id,
      EXISTS (SELECT 1 FROM hawa.inbox_events c WHERE c.tenant_id = ${tenantId}::uuid AND c.source_account_id = 'lifecycle_source_confirmation'
        AND c.source_event_id = s.source_id) AS confirmed
    FROM (SELECT coalesce(u.payload->>'sourceUpdateId', u.source_event_id) AS source_id, u.received_at FROM hawa.inbox_events u
      WHERE u.tenant_id = ${tenantId}::uuid AND u.source_account_id IN ('lifecycle_source_upload', 'lifecycle_source_pending')
        AND u.payload->>'chatId' = ${chatId} AND u.payload->>'messageId' = ${messageId}) s
    ORDER BY s.received_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (source) return { kind: 'source', updateId: Number(source.source_id), confirmed: source.confirmed };
  return null;
}
