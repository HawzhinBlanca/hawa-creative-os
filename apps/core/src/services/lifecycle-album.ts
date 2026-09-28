/** Durable album collection. A requester confirmation freezes the complete selected input set. */
import { createHash } from 'node:crypto';
import { parseLifecycleAlbumRef, type BlobRef, type LifecycleAlbumRef } from '@hawa/contracts';
import { sql, type Database, type Kysely, type BlobStore } from '@hawa/db';
import { lifecycleStillImageFile, retainLifecyclePhoto } from './lifecycle-photo.js';

type Update = { update_id: number; [key: string]: unknown };
type Message = Record<string, unknown>;
type Tx = Kysely<Database>;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Message)[key])}`).join(',')}}`;
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const record = (value: unknown): Message | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Message : null;
const positiveId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : null;

export class AlbumConflict extends Error {}
export interface AlbumMessage { status: number; message: string; noticeKey: string }
export interface AlbumSnapshot { ref: LifecycleAlbumRef; update: Update; chatId: string }
export const normalizedAlbumUpdate = (snapshot: AlbumSnapshot): Update => JSON.parse(canonical(snapshot.update));

/** Reproduce the confirmed message order and refuse a missing or foreign task-file binding. */
export function orderedAlbumImages<T extends { sha256: string; media_type: string; size: string | number }>(
  value: unknown, refs: T[],
): T[] {
  if (value === undefined) return refs;
  const album = parseLifecycleAlbumRef(value);
  if (!album) throw new Error('The task album manifest is invalid');
  const wanted = [...new Map(album.images.map((image) => [image.sha256, image])).values()];
  if (wanted.length !== refs.length) throw new Error('The task files differ from the confirmed album');
  return wanted.map((image) => {
    const ref = refs.find((candidate) => candidate.sha256 === image.sha256);
    if (!ref || ref.media_type !== image.mediaType || Number(ref.size) !== image.size)
      throw new Error('A confirmed album image is missing or changed');
    return ref;
  });
}
interface Part {
  groupKey: string; chatId: string; groupId: string; senderId: string; topic: string;
  messageId: string; source: Update; image: BlobRef | null; error?: string;
}
interface Confirmation { source: Update; chatId: string; snapshot?: AlbumSnapshot; reply?: AlbumMessage }

export function albumMessage(update: unknown): Message | null {
  const message = record(record(update)?.message);
  return message && typeof message.media_group_id === 'string' &&
    message.media_group_id.length > 0 && message.media_group_id.length <= 200 ? message : null;
}
export function isAlbumConfirmation(update: unknown): boolean {
  const text = record(record(update)?.message)?.text;
  return typeof text === 'string' && /^\/use_album(?:@\w+)?\s*$/i.test(text);
}

async function event<T>(trx: Tx, tenant: string, account: string, id: string): Promise<{ payload: T; payload_hash: string } | undefined> {
  return (await sql<{ payload: T; payload_hash: string }>`SELECT payload, payload_hash FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = ${account} AND source_event_id = ${id}`.execute(trx)).rows[0];
}
async function save(trx: Tx, tenant: string, account: string, id: string, payload: unknown, digest: string): Promise<void> {
  if (['lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_album_confirm'].includes(account)) {
    await lock(trx, tenant, `source:${id}`);
    const prior = (await sql<{ payload_hash: string }>`SELECT payload_hash FROM hawa.inbox_events
      WHERE tenant_id = ${tenant}::uuid AND source_event_id = ${id}
        AND source_account_id IN ('lifecycle_album_pending', 'lifecycle_album_confirm')`.execute(trx)).rows;
    if (prior.some((row) => row.payload_hash !== digest)) throw new AlbumConflict('The album source update changed kind or content.');
  }
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenant}::uuid, ${account}, ${id}, ${account}, ${JSON.stringify(payload)}::jsonb, ${digest}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const saved = await event(trx, tenant, account, id);
  if (!saved || saved.payload_hash !== digest) throw new AlbumConflict('This source update already has different content.');
}
export async function assertAlbumSource(trx: Tx, tenant: string, update: Update): Promise<void> {
  const rows = (await sql<{ payload_hash: string }>`SELECT payload_hash FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_event_id = ${String(update.update_id)}
      AND source_account_id IN ('lifecycle_album_pending', 'lifecycle_album_confirm')`.execute(trx)).rows;
  if (rows.some((row) => row.payload_hash !== hash(update))) throw new AlbumConflict('The recorded album source changed.');
}
async function lock(trx: Tx, tenant: string, group: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle-album:${tenant}:${group}`}, 0))`.execute(trx);
}
async function parts(trx: Tx, tenant: string, group: string): Promise<Part[]> {
  return (await sql<{ payload: Part }>`SELECT DISTINCT ON (source_event_id) payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending')
      AND payload->>'groupKey' = ${group}
    ORDER BY source_event_id, (source_account_id = 'lifecycle_album_part') DESC`.execute(trx)).rows
    .map((row) => row.payload).sort((a, b) => Number(a.messageId) - Number(b.messageId));
}
export async function readAlbumPart(trx: Tx, tenant: string, update: Update): Promise<Part | null> {
  const prior = await event<Part>(trx, tenant, 'lifecycle_album_part', String(update.update_id));
  if (prior && prior.payload_hash !== hash(update)) throw new AlbumConflict('This album update changed after it was saved.');
  return prior?.payload ?? null;
}
export async function hasAlbum(trx: Tx, tenant: string, chatId: string, groupId: string): Promise<boolean> {
  return (await parts(trx, tenant, hash([chatId, groupId]))).length > 0;
}
export async function readAlbumConfirmation(trx: Tx, tenant: string, update: Update): Promise<Confirmation | null> {
  const prior = await event<Confirmation>(trx, tenant, 'lifecycle_album_confirm', String(update.update_id));
  if (prior && prior.payload_hash !== hash(update)) throw new AlbumConflict('This album confirmation changed after it was saved.');
  return prior?.payload ?? null;
}
export async function verifyAlbumSnapshot(trx: Tx, tenant: string, ref: LifecycleAlbumRef,
  sourceUpdate?: unknown): Promise<AlbumSnapshot | null> {
  const prior = await event<Confirmation>(trx, tenant, 'lifecycle_album_confirm', String(ref.updateId));
  const snap = prior?.payload.snapshot;
  if (!snap || !parseLifecycleAlbumRef(ref) || canonical(snap.ref) !== canonical(ref) ||
      (sourceUpdate !== undefined && hash(sourceUpdate) !== hash(snap.update))) return null;
  // JSONB reorders object keys. Compare the ordered image fields, not incidental serialization.
  return snap;
}
export function partReply(part: Part): AlbumMessage {
  return part.error
    ? { status: 422, message: part.error, noticeKey: `album-error:${part.source.update_id}` }
    : { status: 202, message: 'Album photos are being saved. After every photo has finished sending, reply to any photo in this album with /use_album. No design has started yet.',
      noticeKey: `album-received:${part.groupKey}` };
}

/** The caller supplies a tenant-scoped transaction runner, not a long transaction around Telegram. */
export async function retainAlbumPart(tx: <T>(fn: (trx: Tx) => Promise<T>) => Promise<T>, tenant: string,
  update: Update, store: BlobStore | null, download: (id: string) => Promise<Buffer | null | undefined>): Promise<AlbumMessage> {
  const prior = await tx((trx) => readAlbumPart(trx, tenant, update));
  if (prior) return partReply(prior);
  const msg = albumMessage(update)!;
  const chatId = String(record(msg.chat)?.id ?? '');
  const groupId = String(msg.media_group_id);
  const groupKey = hash([chatId, groupId]);
  const senderId = positiveId(record(msg.from)?.id);
  const messageId = positiveId(msg.message_id);
  if (!senderId || !messageId || !/^-?\d{1,20}$/.test(chatId)) throw new AlbumConflict('The album sender or message identity is unavailable.');
  const base: Part = { groupKey, chatId, groupId, senderId, messageId,
    topic: String(msg.message_thread_id ?? ''), source: update, image: null };
  const check = async (trx: Tx): Promise<string | null> => {
    await lock(trx, tenant, groupKey);
    if (await event(trx, tenant, 'lifecycle_album_frozen', groupKey))
      return 'This album was already submitted. This late photo was not added to the design. Send a new album or ask the office to revise the request.';
    const priorParts = (await parts(trx, tenant, groupKey)).filter((part) => part.source.update_id !== update.update_id);
    if (priorParts.some((part) => part.senderId !== senderId || part.topic !== base.topic))
      throw new AlbumConflict('Album parts must belong to one sender and topic.');
    if (priorParts.length >= 10) return 'This album exceeds ten photos. No complete album can be submitted; send a smaller album.';
    return null;
  };
  let error = await tx(async (trx) => {
    const error = await check(trx);
    // Persist the received identity before network I/O. A missing download remains part of
    // the album and blocks confirmation until the same update is successfully retried.
    await save(trx, tenant, 'lifecycle_album_pending', String(update.update_id), base, hash(update));
    return error;
  });
  const fileId = lifecycleStillImageFile(msg, true);
  if (!error && !fileId) {
    error = 'This album contains unsupported media. Send only still photos in a new album; no design has started.';
  }
  let image: BlobRef | null = null;
  if (!error) {
    const retained = await retainLifecyclePhoto(store, download, fileId!);
    if (retained.kind === 'download_unavailable') throw new Error('ALBUM_PHOTO_UNAVAILABLE');
    if (retained.kind === 'store_unavailable') throw new Error('ALBUM_STORE_UNAVAILABLE');
    if (retained.kind === 'unsupported') error = 'An album photo is unsupported or too large. Send a corrected album; no design has started.';
    else image = retained.ref;
  }
  return tx(async (trx) => {
    const finalError = await check(trx) ?? error;
    const raced = await readAlbumPart(trx, tenant, update);
    if (raced) return partReply(raced);
    const saved: Part = { ...base, image: finalError ? null : image, ...(finalError ? { error: finalError } : {}) };
    await save(trx, tenant, 'lifecycle_album_part', String(update.update_id), saved, hash(update));
    return partReply(saved);
  });
}

export async function confirmAlbum(trx: Tx, tenant: string, update: Update): Promise<Confirmation> {
  await lock(trx, tenant, `confirm:${update.update_id}`);
  const prior = await readAlbumConfirmation(trx, tenant, update);
  if (prior) return prior;
  const msg = record(update.message)!;
  const chatId = String(record(msg.chat)?.id ?? '');
  const senderId = String(record(msg.from)?.id ?? '');
  const topic = String(msg.message_thread_id ?? '');
  const replyId = positiveId(record(msg.reply_to_message)?.message_id);
  const finish = async (reply: AlbumMessage): Promise<Confirmation> => {
    const result = { source: update, chatId, reply };
    await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), result, hash(update));
    return result;
  };
  const refuse = (message: string) => finish({ status: 422, message, noticeKey: `album-confirm:${update.update_id}` });
  if (!replyId) return refuse('Reply to a photo in the album with /use_album after all photos have finished sending.');
  const rows = (await sql<{ payload: Part }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_part'
      AND payload->>'chatId' = ${chatId} AND payload->>'messageId' = ${replyId}`.execute(trx)).rows;
  if (rows.length !== 1 || rows[0].payload.senderId !== senderId || rows[0].payload.topic !== topic)
    return refuse('That photo does not identify an album saved for you in this chat and topic.');
  const groupKey = rows[0].payload.groupKey;
  await lock(trx, tenant, groupKey);
  if (await event(trx, tenant, 'lifecycle_album_frozen', groupKey))
    return refuse('This album was already submitted. Check the existing request; a second design was not started.');
  const selected = await parts(trx, tenant, groupKey);
  if (selected.length < 2 || selected.length > 10 || selected.some((part) => part.error || !part.image))
    return refuse('The album needs two to ten successfully saved still photos. Wait for all files, or send a corrected album, then confirm again.');
  if (selected.some((part) => part.senderId !== senderId || part.topic !== topic))
    return refuse('The album scope is inconsistent. Ask the office to inspect it.');
  const messages = selected.map((part) => record(part.source.message)!);
  const captions = [...new Set(messages.map((message) => typeof message.caption === 'string' ? message.caption.trim() : '').filter(Boolean))];
  const replies = [...new Set(messages.map((message) => positiveId(record(message.reply_to_message)?.message_id)).filter(Boolean))];
  if (replies.length > 1 || (replies.length === 1 && messages.some((message) => !record(message.reply_to_message))))
    return refuse('The album photos do not all reply to the same request. Send a new album with one clear request.');
  if (captions.length > 1) return refuse('Use one complete caption for the album. Multiple different captions need office review.');
  if (!captions.length && !replies.length) return refuse('The album has no brief or request reply. Send a captioned album with the exact copy to use.');
  const text = captions[0] || 'The requester attached an album with no written instructions. Use it as reference for the existing brief; do not infer or change factual copy from image text.';
  const normalized: Update = { update_id: update.update_id, message: {
    ...msg, text, ...(replies[0] ? { reply_to_message: { message_id: Number(replies[0]) } } : {}),
    album_source: selected.map((part) => ({ updateId: part.source.update_id, hash: hash(part.source) })),
  } };
  if (!replies.length) delete (normalized.message as Message).reply_to_message;
  const ref = parseLifecycleAlbumRef({ updateId: update.update_id,
    sha256: hash({ groupKey, source: update, selected }), images: selected.map((part) => part.image) });
  if (!ref) return refuse('This album exceeds the 100 MiB total image limit. Send a smaller album.');
  const result: Confirmation = { source: update, chatId, snapshot: { ref, update: normalized, chatId } };
  await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), result, hash(update));
  await save(trx, tenant, 'lifecycle_album_frozen', groupKey, { updateId: update.update_id }, ref.sha256);
  return result;
}
