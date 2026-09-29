/**
 * Durable album collection. The settled album (ADR-143), a natural brief, or a compatible
 * confirmation freezes the complete selected input set.
 */
import { createHash } from 'node:crypto';
import { parseLifecycleAlbumRef, type BlobRef, type LifecycleAlbumRef } from '@hawa/contracts';
import { sql, type Database, type Kysely, type BlobStore } from '@hawa/db';
import { lifecycleStillImageFile, retainLifecyclePhoto } from './lifecycle-photo.js';
import { classifyWithHeuristics, isAcknowledgement, isSoraniText } from './telegram-classifier.js';
import { ALBUM_MESSAGES, TELEGRAM_CAPTION_LIMIT, requesterLang, say } from '@hawa/integrations';

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
/** `settle`: the photo was saved; the caller schedules the album's settle instead of sending a message. */
export interface AlbumMessage { status: number; message: string; noticeKey: string; settle?: true }
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
/**
 * A saved photo says nothing to the requester: the album settles once no photo has arrived for a
 * quiet period (ADR-143), and then starts the design or asks what to design. Only a refused photo
 * is answered at once.
 */
export function partReply(part: Part): AlbumMessage {
  return part.error
    ? { status: 422, message: part.error, noticeKey: `album-error:${part.source.update_id}` }
    : { status: 202, message: '', noticeKey: `album-received:${part.groupKey}`, settle: true };
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
    // The design already started from the settled album; its task files are frozen (ADR-143).
    if (await event(trx, tenant, 'lifecycle_album_frozen', groupKey))
      return ALBUM_TEXT.latePhoto[await replyLanguage(trx, tenant, chatId,
        [typeof msg.caption === 'string' ? msg.caption : ''], record(msg.from)?.language_code)];
    const priorParts = (await parts(trx, tenant, groupKey)).filter((part) => part.source.update_id !== update.update_id);
    if (priorParts.some((part) => part.senderId !== senderId || part.topic !== base.topic))
      throw new AlbumConflict('Album parts must belong to one sender and topic.');
    if (priorParts.length >= 10) return say(ALBUM_MESSAGES.tooMany, wordsLang(msg));
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
    error = say(ALBUM_MESSAGES.notPhotos, wordsLang(msg));
  }
  let image: BlobRef | null = null;
  if (!error) {
    const retained = await retainLifecyclePhoto(store, download, fileId!);
    if (retained.kind === 'download_unavailable') throw new Error('ALBUM_PHOTO_UNAVAILABLE');
    if (retained.kind === 'store_unavailable') throw new Error('ALBUM_STORE_UNAVAILABLE');
    if (retained.kind === 'unsupported') error = say(ALBUM_MESSAGES.photoUnreadable, wordsLang(msg));
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
  // A confirmation sent as a plain message is bound by bindTextToAlbum (ADR-143); never asked for.
  const lang = wordsLang(msg);
  if (!replyId) return refuse(say(ALBUM_MESSAGES.notFound, lang));
  const rows = (await sql<{ payload: Part }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_part'
      AND payload->>'chatId' = ${chatId} AND payload->>'messageId' = ${replyId}`.execute(trx)).rows;
  if (rows.length !== 1 || rows[0].payload.senderId !== senderId || rows[0].payload.topic !== topic)
    return refuse(say(ALBUM_MESSAGES.notFound, lang));
  const groupKey = rows[0].payload.groupKey;
  await lock(trx, tenant, groupKey);
  if (await event(trx, tenant, 'lifecycle_album_frozen', groupKey))
    return refuse(say(ALBUM_MESSAGES.alreadyStarted, lang));
  const selected = await parts(trx, tenant, groupKey);
  if (selected.length < 2 || selected.length > 10 || selected.some((part) => part.error || !part.image))
    return refuse(say(ALBUM_MESSAGES.needsTwo, lang));
  if (selected.some((part) => part.senderId !== senderId || part.topic !== topic))
    return refuse(say(ALBUM_MESSAGES.somethingWrong, lang));
  const messages = selected.map((part) => record(part.source.message)!);
  const captions = [...new Set(messages.map((message) => typeof message.caption === 'string' ? message.caption.trim() : '').filter(Boolean))];
  const replies = [...new Set(messages.map((message) => positiveId(record(message.reply_to_message)?.message_id)).filter(Boolean))];
  if (replies.length > 1 || (replies.length === 1 && messages.some((message) => !record(message.reply_to_message))))
    return refuse(say(ALBUM_MESSAGES.mixedReplies, lang));
  if (captions.length > 1) return refuse(say(ALBUM_MESSAGES.captions, lang));
  // ADR-148: a caption Telegram cut is never the whole brief; the album waits for the rest.
  if (messages.some((message) => captionMayBeCut(message.caption))) {
    return finish({ status: 202, message: say(ALBUM_MESSAGES.captionCut, lang), noticeKey: `album-confirm:${update.update_id}` });
  }
  if (!captions.length && !replies.length) {
    // No brief: ask what to design (ADR-143); a later brief from this sender binds the album.
    await markSettled(trx, tenant, groupKey, 'asked', update.update_id);
    return finish(await albumQuestion(trx, tenant, chatId, groupKey, selected));
  }
  const text = captions[0] || 'The requester attached an album with no written instructions. Use it as reference for the existing brief; do not infer or change factual copy from image text.';
  const normalized: Update = { update_id: update.update_id, message: {
    ...msg, text, ...(replies[0] ? { reply_to_message: { message_id: Number(replies[0]) } } : {}),
    album_source: selected.map((part) => ({ updateId: part.source.update_id, hash: hash(part.source) })),
  } };
  if (!replies.length) delete (normalized.message as Message).reply_to_message;
  const ref = parseLifecycleAlbumRef({ updateId: update.update_id,
    sha256: hash({ groupKey, source: update, selected }), images: selected.map((part) => part.image) });
  if (!ref) return refuse(say(ALBUM_MESSAGES.tooLarge, lang));
  const result: Confirmation = { source: update, chatId, snapshot: { ref, update: normalized, chatId } };
  await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), result, hash(update));
  await save(trx, tenant, 'lifecycle_album_frozen', groupKey, { updateId: update.update_id }, ref.sha256);
  return result;
}

// ---------------------------------------------------------------------------------------------
// ADR-143: an album settles by itself, and the requester's own words bind a waiting album.
//
// Telegram delivers an album as separate updates with no expected total. A saved photo schedules a
// settle (a durable Restate delayed call in ChatInbox); only the settle scheduled by the newest photo
// acts, once no photo came for the quiet period. A caption or a brief sent next to the album starts
// one request; an album with no words is asked about, so an accidental album starts no paid design.

/** Every settle outcome is stored under its source update, so a replay answers the same way. */
export type AlbumOutcome =
  | { kind: 'none' }
  | { kind: 'skip' }
  | { kind: 'reply'; reply: AlbumMessage }
  | { kind: 'snapshot'; snapshot: AlbumSnapshot }
  /** ADR-148: settle this album again after `delayMs`; `notice` is said beside it (once, keyed by the update). */
  | { kind: 'wait'; delayMs: number; notice: string | null };

type Lang = 'en' | 'ckb';

const envNumber = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
};
/** The quiet period after an album's newest photo before the album settles (HAWA_ALBUM_SETTLE_MS). */
export const albumSettleMs = (): number => envNumber('HAWA_ALBUM_SETTLE_MS', 8000, 2000, 120_000);
/** How long a text brief waits for photos sent right after it; 0 opens it at once (HAWA_BRIEF_PHOTO_WAIT_MS). */
export const briefPhotoWaitMs = (): number => envNumber('HAWA_BRIEF_PHOTO_WAIT_MS', 15_000, 0, 120_000);
/** How long an album with no brief accepts one from its sender. */
const briefWindowMs = (): number => envNumber('HAWA_ALBUM_BRIEF_WINDOW_MINUTES', 120, 1, 7 * 24 * 60) * 60_000;
/** How long an unsettled album is still settled by a sweep (the captioned album before ADR-143). */
export const albumResumeMs = (): number => envNumber('HAWA_ALBUM_RESUME_HOURS', 72, 1, 14 * 24) * 3_600_000;
/** A settle this long after the newest photo is a sweep or a lost timer, not the album's own settle. */
const LATE_SETTLE_MS = 5 * 60_000;
/** A held brief joins an album that started at most this long after it, and is never held longer. */
const HELD_BRIEF_MS = 10 * 60_000;

// --- ADR-148: a caption Telegram cut at its limit ----------------------------------------------------
//
// A standard Telegram account can send at most TELEGRAM_CAPTION_LIMIT (1024) UTF-16 units of caption,
// and Telegram silently keeps only the first 1024. A caption that long is therefore never taken as the
// whole brief: the album waits for the rest (the sender's next message joins it), asked once, for the
// held-brief window at most. Then it opens with the caption's complete lines only: a cut line is never copy.

/** Whether Telegram may have cut this caption: it is at the caption limit, counted as Telegram counts (JS length). */
export const captionMayBeCut = (caption: unknown): boolean =>
  typeof caption === 'string' && caption.length >= TELEGRAM_CAPTION_LIMIT;
/** How long an album whose caption was cut waits for the rest before it opens without its cut line. */
export const CUT_CAPTION_WAIT_MS = HELD_BRIEF_MS;

/**
 * The caption without its cut last line: the lines before the last one, else (one line) the sentences
 * before the last one. Empty when no complete line or sentence is left.
 */
export function withoutCutLine(caption: string): string {
  const at = caption.lastIndexOf('\n');
  if (at >= 0) return caption.slice(0, at).trim();
  const ends = [...caption.matchAll(/[.!?\u061F\u06D4\u2026](?=\s)/gu)];
  const last = ends.at(-1);
  return last?.index !== undefined ? caption.slice(0, last.index + 1).trim() : '';
}

/**
 * The rest of a cut caption joins it: the caption, a newline, the rest. When the rest repeats what
 * Telegram kept (the whole brief sent again, or the cut line sent again whole), the repeat replaces the
 * kept text instead of doubling it, so the cut line is not copy.
 */
export function joinCutCaption(caption: string, rest: string): string {
  const flat = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
  const again = flat(rest);
  const head = flat(caption).slice(0, 80);
  if (head.length >= 40 && again.startsWith(head)) return rest;
  const at = caption.lastIndexOf('\n');
  const cutLine = at >= 0 ? flat(caption.slice(at + 1)) : '';
  if (cutLine.length >= 12 && again.startsWith(cutLine)) return `${caption.slice(0, at).trimEnd()}\n${rest}`;
  return `${caption}\n${rest}`;
}

/** The caption Telegram may have cut, as it arrived, or null. */
const cutCaptionOf = (messages: Message[]): string | null => {
  const cut = messages.map((message) => message.caption).find(captionMayBeCut);
  return typeof cut === 'string' ? cut : null;
};
async function cutAsked(trx: Tx, tenant: string, groupKey: string): Promise<{ updateId: number; at: number } | null> {
  const row = (await sql<{ payload: { updateId: number }; at: number }>`SELECT payload,
      (extract(epoch FROM received_at) * 1000)::float8 AS at FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_cut' AND source_event_id = ${groupKey}`.execute(trx)).rows[0];
  return row ? { updateId: Number(row.payload.updateId), at: Number(row.at) } : null;
}

const REFERENCE_DIRECTIVE = 'The requester attached an album with no written instructions. Use it as reference for the existing brief; do not infer or change factual copy from image text.';
const easternDigits = (n: number) => String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);

/** What the requester is told, in English, or in Sorani when the chat writes Sorani. */
export const ALBUM_TEXT = {
  question: (count: number, lang: Lang): string =>
    say(ALBUM_MESSAGES.question, lang, { count: lang === 'ckb' ? easternDigits(count) : count }),
  followUp: ALBUM_MESSAGES.followUp,
  latePhoto: ALBUM_MESSAGES.latePhoto,
  photoMissing: ALBUM_MESSAGES.photoMissing,
  onePhoto: ALBUM_MESSAGES.onePhoto,
  captions: ALBUM_MESSAGES.captions,
  mixedReplies: ALBUM_MESSAGES.mixedReplies,
  noAlbum: ALBUM_MESSAGES.noAlbum,
} as const;
/** The language of an album message's own words (ADR-145: the script with more letters), else English. */
const wordsLang = (msg: Message): Lang => requesterLang(typeof msg.caption === 'string' ? msg.caption : typeof msg.text === 'string' ? msg.text : '');

/**
 * The lifecycle answers in Sorani when the requester writes Sorani (the reply rule of
 * telegram-intake/replies.ts). With no words of their own, the chat's newest brief decides, then the
 * sender's Telegram language.
 */
export async function replyLanguage(trx: Tx, tenant: string, chatId: string, texts: string[],
  languageCode?: unknown): Promise<Lang> {
  const own = texts.map((text) => (typeof text === 'string' ? text.trim() : '')).filter(Boolean);
  // ADR-145: the script with more letters decides (a Latin brand name in a Sorani caption stays Sorani).
  if (own.length) return requesterLang(own.join('\n'));
  const last = (await sql<{ raw: string | null }>`SELECT payload->'draft'->>'rawText' AS raw FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_chat_open' AND payload->>'chatId' = ${chatId}
    ORDER BY received_at DESC LIMIT 1`.execute(trx)).rows[0]?.raw;
  if (typeof last === 'string' && last.trim()) return requesterLang(last);
  return typeof languageCode === 'string' && /^(?:ckb|ku)(?:$|[-_])/i.test(languageCode) ? 'ckb' : 'en';
}

const AFFIRM_CORE = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'go', 'proceed', 'start', 'continue',
  'use', 'confirm', 'confirmed', 'done', 'do', 'بەڵێ', 'ئەرێ', 'باشە', 'ئۆکەی', 'بەکاریان', 'بەکاری', 'بەکاربهێنە',
  'دەست', 'پێبکە', 'بەردەوام', 'بەردەوامبە', 'تەواو']);
const AFFIRM_FILLER = new Set(['please', 'the', 'these', 'those', 'them', 'it', 'all', 'photos', 'photo', 'pictures',
  'images', 'pics', 'now', 'ahead', 'on', 'with', 'and', 'that', 'this', 'one', 'album', 'تکایە', 'ئەم', 'ئەو',
  'ئەوانە', 'وێنانە', 'وێنەکان', 'هەموو', 'ئێستا', 'بە', 'و', 'بهێنە', 'پێ', 'بکە']);

/** "yes", "go ahead", "use them", "بەڵێ" and the like: an OK to go on that says nothing about what to design. */
export function isAffirmativeOnly(text: string): boolean {
  const t = text.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '').trim();
  if (!t || t.length > 80) return false;
  if (/^[\u{1F44D}\u{2705}\u{1F44C}\s]+$/u.test(t)) return true;
  const words = t.toLowerCase().replace(/[.,!?;:،؛؟"'’()-]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8 && words.some((w) => AFFIRM_CORE.has(w)) &&
    words.every((w) => AFFIRM_CORE.has(w) || AFFIRM_FILLER.has(w));
}

const NEW_COMMAND = /^\/new(?:@\w+)?(?:\s+|$)/i;
/** Whether the words describe a design to make (the intake's own rule), not only an OK or chatter. */
export function isBriefText(text: string): boolean {
  const body = text.replace(NEW_COMMAND, '').trim();
  if (!body || body.startsWith('/') || isAffirmativeOnly(body)) return false;
  return classifyWithHeuristics(body, false, false).kind === 'new_brief';
}
/** A caption and a brief sent next to it are one brief: the caption first, as the requester sent them. */
function joinBriefs(first: string, second: string): string {
  const prefix = NEW_COMMAND.test(first) || NEW_COMMAND.test(second) ? '/new ' : '';
  return prefix + [first.replace(NEW_COMMAND, '').trim(), second.replace(NEW_COMMAND, '').trim()].filter(Boolean).join('\n\n');
}

type SettledState = 'asked' | 'refused' | 'superseded' | 'expired';
async function markSettled(trx: Tx, tenant: string, groupKey: string, state: SettledState, updateId: number): Promise<void> {
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenant}::uuid, 'lifecycle_album_settled', ${groupKey}, 'lifecycle_album_settled',
      ${JSON.stringify({ state, updateId })}::jsonb, ${hash({ groupKey, state, updateId })}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
}
async function settledState(trx: Tx, tenant: string, groupKey: string): Promise<SettledState | null> {
  const row = await event<{ state: SettledState }>(trx, tenant, 'lifecycle_album_settled', groupKey);
  return row?.payload.state ?? null;
}
const frozen = async (trx: Tx, tenant: string, groupKey: string) =>
  Boolean(await event(trx, tenant, 'lifecycle_album_frozen', groupKey));

async function albumQuestion(trx: Tx, tenant: string, chatId: string, groupKey: string, selected: Part[]): Promise<AlbumMessage> {
  const first = record(selected[0]?.source.message);
  const lang = await replyLanguage(trx, tenant, chatId, [], record(first?.from)?.language_code);
  return { status: 202, message: ALBUM_TEXT.question(selected.length, lang), noticeKey: `album-question:${groupKey}` };
}

/** Receipt times of a group's saved photos, in database time (ms). */
async function albumTimes(trx: Tx, tenant: string, groupKey: string): Promise<{ first: number; last: number; now: number }> {
  const row = (await sql<{ first: number | null; last: number | null; now: number }>`SELECT
      (extract(epoch FROM min(received_at)) * 1000)::float8 AS first,
      (extract(epoch FROM max(received_at)) * 1000)::float8 AS last,
      (extract(epoch FROM now()) * 1000)::float8 AS now
    FROM hawa.inbox_events WHERE tenant_id = ${tenant}::uuid
      AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending')
      AND payload->>'groupKey' = ${groupKey}`.execute(trx)).rows[0];
  const now = Number(row?.now ?? Date.now());
  return { first: Number(row?.first ?? now), last: Number(row?.last ?? now), now };
}

function albumShape(selected: Part[]) {
  const messages = selected.map((part) => record(part.source.message)!);
  const captions = [...new Set(messages.map((message) => typeof message.caption === 'string' ? message.caption.trim() : '').filter(Boolean))];
  const replies = [...new Set(messages.map((message) => positiveId(record(message.reply_to_message)?.message_id)).filter(Boolean))] as string[];
  const mixedReplies = replies.length > 1 || (replies.length === 1 && messages.some((message) => !record(message.reply_to_message)));
  return { messages, captions, replies, mixedReplies, cutCaption: cutCaptionOf(messages) };
}

/** Freeze the selected photos under one source update; the rest of intake reads it like any message. */
async function freeze(trx: Tx, tenant: string, input: { groupKey: string; selected: Part[]; identity: Update;
  chatId: string; base: Message; text: string; replyId: string | null }): Promise<AlbumOutcome> {
  const { base, identity, selected, groupKey } = input;
  const message: Message = { message_id: base.message_id, date: base.date, chat: base.chat, from: base.from,
    ...(base.message_thread_id !== undefined ? { message_thread_id: base.message_thread_id } : {}),
    text: input.text, ...(input.replyId ? { reply_to_message: { message_id: Number(input.replyId) } } : {}),
    album_source: selected.map((part) => ({ updateId: part.source.update_id, hash: hash(part.source) })) };
  const ref = parseLifecycleAlbumRef({ updateId: identity.update_id,
    sha256: hash({ groupKey, source: identity, selected }), images: selected.map((part) => part.image) });
  if (!ref) {
    const reply = { status: 422, message: say(ALBUM_MESSAGES.tooLarge, requesterLang(input.text)),
      noticeKey: `album-confirm:${identity.update_id}` };
    await save(trx, tenant, 'lifecycle_album_confirm', String(identity.update_id), { source: identity, chatId: input.chatId, reply }, hash(identity));
    await markSettled(trx, tenant, groupKey, 'refused', identity.update_id);
    return { kind: 'reply', reply };
  }
  const snapshot: AlbumSnapshot = { ref, update: { update_id: identity.update_id, message }, chatId: input.chatId };
  await save(trx, tenant, 'lifecycle_album_confirm', String(identity.update_id),
    { source: identity, chatId: input.chatId, snapshot } satisfies Confirmation, hash(identity));
  await save(trx, tenant, 'lifecycle_album_frozen', groupKey, { updateId: identity.update_id }, ref.sha256);
  return { kind: 'snapshot', snapshot };
}

const outcomeOf = (prior: Confirmation): AlbumOutcome => prior.snapshot ? { kind: 'snapshot', snapshot: prior.snapshot }
  : prior.reply ? { kind: 'reply', reply: prior.reply } : { kind: 'skip' };
const senderLock = (trx: Tx, tenant: string, chatId: string, senderId: string) => lock(trx, tenant, `sender:${chatId}:${senderId}`);

// --- held briefs: a text brief waits briefly for photos sent right after it ------------------

interface HeldBrief { updateId: number; chatId: string; senderId: string; topic: string; update: Update; at: number }
type HeldState = 'held' | 'consumed' | 'released';

async function heldBriefState(trx: Tx, tenant: string, updateId: number): Promise<HeldState> {
  if (await event(trx, tenant, 'lifecycle_brief_consumed', String(updateId))) return 'consumed';
  if (await event(trx, tenant, 'lifecycle_brief_released', String(updateId))) return 'released';
  return 'held';
}
async function heldBrief(trx: Tx, tenant: string, updateId: number): Promise<HeldBrief | null> {
  const row = (await sql<{ payload: Omit<HeldBrief, 'at' | 'updateId'>; at: number }>`SELECT payload,
      (extract(epoch FROM received_at) * 1000)::float8 AS at FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_brief_held'
      AND source_event_id = ${String(updateId)}`.execute(trx)).rows[0];
  return row ? { ...row.payload, updateId, at: Number(row.at) } : null;
}
/** The sender's newest brief still held when the album's photos arrived. */
async function heldBriefBefore(trx: Tx, tenant: string, scope: { chatId: string; senderId: string; topic: string },
  fromMs: number, toMs: number): Promise<HeldBrief | null> {
  const rows = (await sql<{ source_event_id: string }>`SELECT h.source_event_id FROM hawa.inbox_events h
    WHERE h.tenant_id = ${tenant}::uuid AND h.source_account_id = 'lifecycle_brief_held'
      AND h.payload->>'chatId' = ${scope.chatId} AND h.payload->>'senderId' = ${scope.senderId}
      AND h.payload->>'topic' = ${scope.topic}
      AND h.received_at >= to_timestamp(${fromMs / 1000}) AND h.received_at <= to_timestamp(${toMs / 1000})
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events s WHERE s.tenant_id = h.tenant_id
        AND s.source_account_id IN ('lifecycle_brief_consumed', 'lifecycle_brief_released')
        AND s.source_event_id = h.source_event_id)
    ORDER BY h.received_at DESC LIMIT 1`.execute(trx)).rows;
  return rows[0] ? heldBrief(trx, tenant, Number(rows[0].source_event_id)) : null;
}
const messageScope = (update: Update) => {
  const msg = record(update.message);
  return { msg, chatId: String(record(msg?.chat)?.id ?? ''), senderId: positiveId(record(msg?.from)?.id),
    topic: String(msg?.message_thread_id ?? '') };
};

/** Hold a text brief (ADR-143): its settle opens it, alone or with the album that followed it. */
export async function holdBrief(trx: Tx, tenant: string, update: Update): Promise<boolean> {
  const { chatId, senderId, topic } = messageScope(update);
  if (!senderId || !/^-?\d{1,20}$/.test(chatId)) return false;
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenant}::uuid, 'lifecycle_brief_held', ${String(update.update_id)}, 'lifecycle_brief_held',
      ${JSON.stringify({ chatId, senderId, topic, update })}::jsonb, ${hash(update)}, true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const stored = await event(trx, tenant, 'lifecycle_brief_held', String(update.update_id));
  if (!stored || stored.payload_hash !== hash(update)) throw new AlbumConflict('This held brief already has different content.');
  return true;
}
/** Whether this update was held as a brief (a replay answers "settle later" again). */
export async function isHeldBrief(trx: Tx, tenant: string, update: Update): Promise<boolean> {
  const stored = await event(trx, tenant, 'lifecycle_brief_held', String(update.update_id));
  if (stored && stored.payload_hash !== hash(update)) throw new AlbumConflict('This held brief changed after it was saved.');
  return Boolean(stored);
}
/**
 * A replayed held brief: `held` answers "settle later" again, `released` replays the decision intake
 * recorded for it, `consumed` answers that an album took it; `none` if it was never held.
 */
export async function heldBriefReplay(trx: Tx, tenant: string, update: Update): Promise<'none' | HeldState> {
  return await isHeldBrief(trx, tenant, update) ? heldBriefState(trx, tenant, update.update_id) : 'none';
}

/**
 * The held brief's settle: `skip` when an album took it (or it was never held), `wait` while an album
 * its sender began after it is still arriving, else `release`: intake opens it as it opens any brief.
 */
export async function settleHeldBrief(trx: Tx, tenant: string, update: Update): Promise<'skip' | 'wait' | 'release'> {
  if (!await isHeldBrief(trx, tenant, update)) return 'skip';
  const held = (await heldBrief(trx, tenant, update.update_id))!;
  await senderLock(trx, tenant, held.chatId, held.senderId);
  const state = await heldBriefState(trx, tenant, held.updateId);
  if (state === 'consumed') return 'skip';
  if (state === 'released') return 'release';
  const now = Number((await sql<{ now: number }>`SELECT (extract(epoch FROM now()) * 1000)::float8 AS now`.execute(trx)).rows[0].now);
  if (now - held.at < HELD_BRIEF_MS) {
    const groups = (await sql<{ group_key: string }>`SELECT DISTINCT payload->>'groupKey' AS group_key FROM hawa.inbox_events
      WHERE tenant_id = ${tenant}::uuid AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending')
        AND payload->>'chatId' = ${held.chatId} AND payload->>'senderId' = ${held.senderId}
        AND payload->>'topic' = ${held.topic} AND received_at >= to_timestamp(${held.at / 1000})`.execute(trx)).rows;
    for (const { group_key: groupKey } of groups) {
      if (!await frozen(trx, tenant, groupKey) && !await settledState(trx, tenant, groupKey)) return 'wait';
    }
  }
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    VALUES (${tenant}::uuid, 'lifecycle_brief_released', ${String(held.updateId)}, 'lifecycle_brief_released',
      ${JSON.stringify({ chatId: held.chatId })}::jsonb, ${hash(update)}, true) ON CONFLICT DO NOTHING`.execute(trx);
  return 'release';
}

// --- the album's settle -------------------------------------------------------------------------

/**
 * Settle an album from the photo that scheduled it. Only the newest photo's settle acts: an older
 * one is skipped (a newer photo scheduled its own). The outcome is stored under that photo's update
 * ID, so a retried or repeated settle answers the same, and the album is frozen once.
 */
export async function settleAlbum(trx: Tx, tenant: string, update: Update): Promise<AlbumOutcome> {
  const part = await readAlbumPart(trx, tenant, update);
  if (!part) return { kind: 'skip' };
  const prior = await readAlbumConfirmation(trx, tenant, update);
  if (prior) return outcomeOf(prior);
  await senderLock(trx, tenant, part.chatId, part.senderId);
  await lock(trx, tenant, part.groupKey);
  const raced = await readAlbumConfirmation(trx, tenant, update);
  if (raced) return outcomeOf(raced);
  const { groupKey, chatId } = part;
  if (await frozen(trx, tenant, groupKey)) return { kind: 'skip' };
  const state = await settledState(trx, tenant, groupKey);
  if (state && state !== 'asked') return { kind: 'skip' };
  const selected = await parts(trx, tenant, groupKey);
  if (Math.max(...selected.map((p) => p.source.update_id)) !== update.update_id) return { kind: 'skip' };
  const times = await albumTimes(trx, tenant, groupKey);
  const late = times.now - times.last > LATE_SETTLE_MS;
  // A settle long after the photos (a sweep after a lost timer, or an album saved before ADR-143)
  // starts nothing once the chat has moved on to another request.
  if (late && (await sql`SELECT 1 FROM hawa.requests WHERE tenant_id = ${tenant}::uuid AND chat_id = ${chatId}
      AND created_at > to_timestamp(${times.last / 1000}) LIMIT 1`.execute(trx)).rows.length) {
    await markSettled(trx, tenant, groupKey, 'superseded', update.update_id);
    return { kind: 'skip' };
  }
  const first = record(selected[0].source.message);
  const { captions, replies, mixedReplies, cutCaption } = albumShape(selected);
  const lang = await replyLanguage(trx, tenant, chatId, captions, record(first?.from)?.language_code);
  const answer = async (message: string, settled: SettledState): Promise<AlbumOutcome> => {
    await markSettled(trx, tenant, groupKey, settled, update.update_id);
    const reply: AlbumMessage = { status: settled === 'asked' ? 202 : 422, message, noticeKey: `album-settle:${update.update_id}` };
    await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), { source: update, chatId, reply }, hash(update));
    return { kind: 'reply', reply };
  };
  if (selected.some((p) => !p.image && !p.error)) return answer(ALBUM_TEXT.photoMissing[lang], 'refused');
  if (selected.some((p) => p.error)) {
    // Each refused photo was answered when it arrived.
    await markSettled(trx, tenant, groupKey, 'refused', update.update_id);
    return { kind: 'skip' };
  }
  if (selected.length < 2) return answer(ALBUM_TEXT.onePhoto[lang], 'refused');
  if (mixedReplies) return answer(ALBUM_TEXT.mixedReplies[lang], 'refused');
  if (captions.length > 1) return answer(ALBUM_TEXT.captions[lang], 'asked');
  const lastMessage = record(update.message)!;
  const caption = captions[0] ?? '';
  // ADR-148: Telegram kept only the start of this caption. The album waits for the rest (the sender's
  // next message joins it in bindTextToAlbum); the requester is asked once, beside a durable settle
  // after the held-brief window. Past it, the album opens with the caption's complete lines only.
  if (cutCaption !== null) {
    const asked = await cutAsked(trx, tenant, groupKey);
    const notice = !asked || asked.updateId === update.update_id ? say(ALBUM_MESSAGES.captionCut, lang) : null;
    if (!asked) {
      await save(trx, tenant, 'lifecycle_album_cut', groupKey, { updateId: update.update_id, chatId },
        hash({ groupKey, updateId: update.update_id }));
      await markSettled(trx, tenant, groupKey, 'asked', update.update_id);
      return { kind: 'wait', delayMs: CUT_CAPTION_WAIT_MS, notice };
    }
    const waited = times.now - asked.at;
    if (waited < CUT_CAPTION_WAIT_MS) {
      return { kind: 'wait', delayMs: Math.min(CUT_CAPTION_WAIT_MS, Math.max(albumSettleMs(), Math.ceil(CUT_CAPTION_WAIT_MS - waited))), notice };
    }
    // No rest came: the complete lines are the brief. A caption with no complete line or sentence left
    // has no brief to open; the requester was asked, and the album lapses with its window.
    const kept = withoutCutLine(cutCaption);
    if (!kept) return { kind: 'skip' };
    return freeze(trx, tenant, { groupKey, selected, identity: update, chatId, base: lastMessage, text: kept,
      replyId: replies[0] ?? null });
  }
  // Photos sent in reply to a request's notice are that request's reference, as a replied photo is.
  if (replies.length === 1) return freeze(trx, tenant, { groupKey, selected, identity: update, chatId,
    base: lastMessage, text: caption || REFERENCE_DIRECTIVE, replyId: replies[0] });
  if (caption && isBriefText(caption)) return freeze(trx, tenant, { groupKey, selected, identity: update, chatId,
    base: lastMessage, text: caption, replyId: null });
  // A brief its sender sent just before the photos is this album's brief.
  const held = await heldBriefBefore(trx, tenant, { chatId, senderId: part.senderId, topic: part.topic },
    times.first - HELD_BRIEF_MS, times.last);
  const heldMessage = held ? record(held.update.message) : null;
  if (held && heldMessage && typeof heldMessage.text === 'string') {
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${tenant}::uuid, 'lifecycle_brief_consumed', ${String(held.updateId)}, 'lifecycle_brief_consumed',
        ${JSON.stringify({ groupKey, updateId: update.update_id })}::jsonb, ${hash({ groupKey, updateId: update.update_id })}, true)
      ON CONFLICT DO NOTHING`.execute(trx);
    return freeze(trx, tenant, { groupKey, selected, identity: update, chatId,
      base: heldMessage, text: heldMessage.text, replyId: null });
  }
  if (late && times.now - times.last > briefWindowMs()) {
    await markSettled(trx, tenant, groupKey, 'expired', update.update_id);
    return { kind: 'skip' };
  }
  await markSettled(trx, tenant, groupKey, 'asked', update.update_id);
  const question = await albumQuestion(trx, tenant, chatId, groupKey, selected);
  await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), { source: update, chatId, reply: question }, hash(update));
  return { kind: 'reply', reply: question };
}

// --- the requester's own words bind a waiting album --------------------------------------------

/** The sender's newest album that still waits for words: not frozen, no refused photo, in its window. */
async function waitingAlbum(trx: Tx, tenant: string, scope: { chatId: string; senderId: string; topic: string },
  onlyGroup?: string): Promise<{ groupKey: string; selected: Part[] } | null> {
  const rows = (await sql<{ group_key: string; last: number; now: number }>`SELECT payload->>'groupKey' AS group_key,
      (extract(epoch FROM max(received_at)) * 1000)::float8 AS last, (extract(epoch FROM now()) * 1000)::float8 AS now
    FROM hawa.inbox_events WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_part'
      AND payload->>'chatId' = ${scope.chatId} AND payload->>'senderId' = ${scope.senderId}
      AND payload->>'topic' = ${scope.topic}
      AND (${onlyGroup === undefined}::boolean OR payload->>'groupKey' = ${onlyGroup ?? ''})
      AND received_at > now() - make_interval(secs => ${albumResumeMs() / 1000})
    GROUP BY 1 ORDER BY max(received_at) DESC LIMIT 5`.execute(trx)).rows;
  for (const row of rows) {
    if (await frozen(trx, tenant, row.group_key)) continue;
    const state = await settledState(trx, tenant, row.group_key);
    if (state && state !== 'asked') continue;
    const selected = await parts(trx, tenant, row.group_key);
    if (selected.length < 2 || selected.some((p) => p.error || !p.image)) continue;
    const { captions, cutCaption } = albumShape(selected);
    // An album with no words, or whose caption Telegram cut (ADR-148), waits for words as long as asked.
    if ((!captions.length || cutCaption !== null) && Number(row.now) - Number(row.last) > briefWindowMs()) continue;
    return { groupKey: row.group_key, selected };
  }
  return null;
}

/**
 * A text from the album's sender, before or after the album settled: a brief starts one request with
 * the photos, an OK starts a captioned album or is asked what to design, anything else (thanks, a
 * question) is left to intake. A `/use_album` sent as a plain message is such an OK (compatibility).
 */
export async function bindTextToAlbum(trx: Tx, tenant: string, update: Update, deps: {
  linkedReply(chatId: string, replyId: string): Promise<boolean>;
  decided(chatId: string, updateId: number): Promise<boolean>;
}): Promise<AlbumOutcome> {
  const { msg, chatId, senderId, topic } = messageScope(update);
  if (!msg || typeof msg.text !== 'string' || msg.media_group_id !== undefined || !senderId) return { kind: 'none' };
  const text = msg.text.trim();
  const confirmation = isAlbumConfirmation(update);
  if (!text || (text.startsWith('/') && !confirmation && !NEW_COMMAND.test(text))) return { kind: 'none' };
  const prior = await readAlbumConfirmation(trx, tenant, update);
  if (prior) return outcomeOf(prior);
  const affirmative = confirmation || isAffirmativeOnly(text);
  const brief = !affirmative && isBriefText(text);
  // ADR-148: any other words (not thanks or an OK) may be the rest of a caption Telegram cut.
  const maybeRest = !affirmative && !brief && !text.startsWith('/') && !isAcknowledgement(text);
  if (!affirmative && !brief && !maybeRest) return { kind: 'none' };
  // An update intake already decided keeps that decision, even if an album has arrived since.
  if (!/^-?\d{1,20}$/.test(chatId) || await deps.decided(chatId, update.update_id)) return { kind: 'none' };
  await senderLock(trx, tenant, chatId, senderId);
  const replyId = positiveId(record(msg.reply_to_message)?.message_id);
  let onlyGroup: string | undefined;
  if (replyId) {
    const photo = (await sql<{ payload: Part }>`SELECT payload FROM hawa.inbox_events
      WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_part'
        AND payload->>'chatId' = ${chatId} AND payload->>'messageId' = ${replyId} LIMIT 1`.execute(trx)).rows[0]?.payload;
    if (photo) onlyGroup = photo.groupKey;
    // A reply to a request's own notice is about that request.
    else if (await deps.linkedReply(chatId, replyId)) return { kind: 'none' };
  }
  const reply = async (message: string, noticeKey: string, status = 422): Promise<AlbumOutcome> => {
    const answer: AlbumMessage = { status, message, noticeKey };
    await save(trx, tenant, 'lifecycle_album_confirm', String(update.update_id), { source: update, chatId, reply: answer }, hash(update));
    return { kind: 'reply', reply: answer };
  };
  const album = await waitingAlbum(trx, tenant, { chatId, senderId, topic }, onlyGroup);
  const lang = await replyLanguage(trx, tenant, chatId, confirmation ? [] : [text], record(msg.from)?.language_code);
  if (!album) return confirmation ? reply(ALBUM_TEXT.noAlbum[lang], `album-confirm:${update.update_id}`) : { kind: 'none' };
  await lock(trx, tenant, album.groupKey);
  if (await frozen(trx, tenant, album.groupKey)) return confirmation
    ? reply(say(ALBUM_MESSAGES.alreadyStarted, lang), `album-confirm:${update.update_id}`)
    : { kind: 'none' };
  const { captions, replies, mixedReplies, cutCaption } = albumShape(album.selected);
  // Words that are not a brief bind only an album whose caption Telegram cut (ADR-148).
  if (maybeRest && (cutCaption === null || captions.length > 1)) return { kind: 'none' };
  if (mixedReplies) return reply(ALBUM_TEXT.mixedReplies[lang], `album-confirm:${update.update_id}`);
  const caption = captions.length === 1 ? captions[0] : '';
  if (cutCaption !== null && captions.length === 1) {
    // An OK is not the rest: the album keeps waiting (the held-brief window still bounds it).
    if (affirmative) return reply(say(ALBUM_MESSAGES.captionCut, lang), `album-rest:${update.update_id}`, 202);
    const prefix = NEW_COMMAND.test(text) ? '/new ' : '';
    return freeze(trx, tenant, { groupKey: album.groupKey, selected: album.selected, identity: update, chatId,
      base: msg, text: prefix + joinCutCaption(cutCaption, text.replace(NEW_COMMAND, '').trim()), replyId: replies[0] ?? null });
  }
  let briefText: string;
  if (brief) briefText = caption ? joinBriefs(caption, text) : text;
  else if (caption) briefText = caption;
  else if (replies.length === 1) briefText = REFERENCE_DIRECTIVE;
  else {
    await markSettled(trx, tenant, album.groupKey, 'asked', update.update_id);
    return reply(captions.length > 1 ? ALBUM_TEXT.captions[lang] : ALBUM_TEXT.followUp[lang],
      `album-followup:${update.update_id}`, 202);
  }
  return freeze(trx, tenant, { groupKey: album.groupKey, selected: album.selected, identity: update, chatId,
    base: msg, text: briefText, replyId: replies[0] ?? null });
}

// --- the sweep: albums and held briefs whose settle never ran -------------------------------------

/**
 * Albums and held briefs whose settle is overdue: saved before ADR-143 (no timer was ever set), or
 * whose timer was lost. The worker's poller sends each one's settle to its ChatInbox; the settle
 * itself decides, under the same locks, whether anything is left to do.
 */
export async function overdueSettles(trx: Tx, tenant: string, limit = 50): Promise<Array<{ chatId: string; update: Update }>> {
  const due: Array<{ chatId: string; update: Update }> = [];
  const overdueSecs = (albumSettleMs() + 60_000) / 1000;
  const groups = (await sql<{ group_key: string }>`SELECT payload->>'groupKey' AS group_key FROM hawa.inbox_events
    WHERE tenant_id = ${tenant}::uuid AND source_account_id = 'lifecycle_album_part'
      AND received_at > now() - make_interval(secs => ${albumResumeMs() / 1000})
    GROUP BY 1 HAVING max(received_at) < now() - make_interval(secs => ${overdueSecs})
    ORDER BY max(received_at) LIMIT ${limit * 2}`.execute(trx)).rows;
  for (const { group_key: groupKey } of groups) {
    if (due.length >= limit) break;
    if (await frozen(trx, tenant, groupKey) || await settledState(trx, tenant, groupKey)) continue;
    const selected = await parts(trx, tenant, groupKey);
    const newest = selected.reduce<Part | null>((a, p) => !a || p.source.update_id > a.source.update_id ? p : a, null);
    if (!newest || await event(trx, tenant, 'lifecycle_album_confirm', String(newest.source.update_id))) continue;
    // A photo still being downloaded has no settle of its own yet; its update's retry schedules one.
    if (!await event(trx, tenant, 'lifecycle_album_part', String(newest.source.update_id))) continue;
    due.push({ chatId: newest.chatId, update: newest.source });
  }
  // ADR-148: an album whose caption Telegram cut, asked for the rest, whose own delayed settle is
  // overdue: its settle opens it with the caption's complete lines (or finds that the rest came).
  const cutSecs = (CUT_CAPTION_WAIT_MS + 60_000) / 1000;
  const cuts = (await sql<{ group_key: string }>`SELECT c.source_event_id AS group_key FROM hawa.inbox_events c
    WHERE c.tenant_id = ${tenant}::uuid AND c.source_account_id = 'lifecycle_album_cut'
      AND c.received_at < now() - make_interval(secs => ${cutSecs})
      AND c.received_at > now() - make_interval(secs => ${briefWindowMs() / 1000})
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events f WHERE f.tenant_id = c.tenant_id
        AND f.source_account_id = 'lifecycle_album_frozen' AND f.source_event_id = c.source_event_id)
    ORDER BY c.received_at LIMIT ${limit}`.execute(trx)).rows;
  for (const { group_key: groupKey } of cuts) {
    if (due.length >= limit) break;
    if (await settledState(trx, tenant, groupKey) !== 'asked') continue;
    const selected = await parts(trx, tenant, groupKey);
    const newest = selected.reduce<Part | null>((a, p) => !a || p.source.update_id > a.source.update_id ? p : a, null);
    const cut = cutCaptionOf(selected.map((part) => record(part.source.message) ?? {}));
    // Nothing complete is left to open with: the settle would only skip.
    if (!newest || cut === null || !withoutCutLine(cut)) continue;
    if (await event(trx, tenant, 'lifecycle_album_confirm', String(newest.source.update_id))) continue;
    due.push({ chatId: newest.chatId, update: newest.source });
  }
  const heldSecs = (briefPhotoWaitMs() + 60_000) / 1000;
  const held = (await sql<{ payload: { chatId: string; update: Update } }>`SELECT h.payload FROM hawa.inbox_events h
    WHERE h.tenant_id = ${tenant}::uuid AND h.source_account_id = 'lifecycle_brief_held'
      AND h.received_at > now() - interval '24 hours' AND h.received_at < now() - make_interval(secs => ${heldSecs})
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events s WHERE s.tenant_id = h.tenant_id
        AND s.source_account_id IN ('lifecycle_brief_consumed', 'lifecycle_brief_released')
        AND s.source_event_id = h.source_event_id)
    ORDER BY h.received_at LIMIT ${limit}`.execute(trx)).rows;
  for (const row of held) if (due.length < limit) due.push({ chatId: row.payload.chatId, update: row.payload.update });
  return due;
}
