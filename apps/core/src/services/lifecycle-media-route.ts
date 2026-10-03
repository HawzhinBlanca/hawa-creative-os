/**
 * Natural media intake for Core's Telegram intake route (ADR-145): what a photo with no words, a
 * video, a file the design cannot use, and a sender outside the intake list are answered. The route
 * calls these before and around its text path; each returns the intake answer (status and fields for
 * ChatInbox) or null when the update is not theirs.
 *
 * A photo with no words and no reply, outside an album:
 *  - is kept (`lifecycle_photo_held`) and answered "settle later": ChatInbox settles it after the
 *    album quiet period (ADR-143's durable delayed call), so words sent right after it arrive first;
 *  - words from the same sender that open a request within the join window (5 minutes, or the album
 *    window once the bot has asked) take the photo with them (the route's openBrief, `claimPhoto`);
 *  - at its settle, a photo that no words took joins the request its sender's words opened in the
 *    five minutes before it: added to the design while the design has not started using pictures,
 *    otherwise passed to the office as a note on that request; with no such request, the bot asks for
 *    the words once. A brief ADR-143 still holds for photos takes the photo when it opens.
 * Every decision is recorded once per update and replays word for word.
 */
import { SYSTEM_AUTOMATION_USER_ID, type BlobRef } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { ACCESS_MESSAGES, MEDIA_MESSAGES, bold, requesterLang, say, type RequesterLang } from '@hawa/integrations';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { blobStoreFor } from './blob-store-context.js';
import { heldPhotoCandidate, retainLifecyclePhoto } from './lifecycle-photo.js';
import { actsInGroup, isGroupChat, replyLanguage } from './lifecycle-album.js';
import { shortTitle } from './requester-turn.js';
import { claimPhoto, holdPhoto, markPhotoAsked, pendingHeldBrief, readHeldPhoto, readMediaAnswer, readPhotoUse,
  recentOpenBy, recordMediaAnswer, unlistedReplyDue, type HeldPhoto, type StoredAnswer } from './lifecycle-media-intake.js';
import type { LateRequesterChange } from './lifecycle-chat-target.js';

type Tx = Kysely<Database>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

/** The intake answer the route wraps in its envelope. */
export type MediaAnswer = StoredAnswer;

const chatAnswer = (chatId: string, text: string, extra: Json = {}): MediaAnswer =>
  ({ status: 200, extra: { lifecycleAction: 'chat-answer', chatId, chatAnswer: { text, parseMode: 'HTML' }, ...extra } });

/** Which kind of media a message carries that a design cannot use as it is. */
export function unusableMedia(message: Json | null): 'video' | 'file' | null {
  if (!message) return null;
  // Only a message whose media is a video alone: a picture or a file beside it is judged as that file.
  if (['photo', 'document', 'voice', 'audio', 'sticker'].some((key) => message[key] !== undefined)) return null;
  if (['video', 'video_note', 'animation', 'live_photo'].some((key) => message[key] !== undefined)) return 'video';
  return null;
}

const MEDIA_KEYS = ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'animation', 'live_photo', 'sticker'];
/**
 * ADR-144 §2.7 (ADR-160): in a group, a member's photo with words, file, voice note, video or sticker
 * that is not addressed to the bot (a reply to it, a mention of it in the caption, a command) and whose
 * words are no clear brief is not read, as such a text would not be. An album is judged whole at its
 * settle, and a photo with no words is kept quietly for its sender's words (its settle says nothing).
 */
export function groupMediaNotAddressed(update: Json): boolean {
  const message = record(update.message);
  if (!message || !isGroupChat(message) || message.media_group_id !== undefined) return false;
  if (!MEDIA_KEYS.some((key) => message[key] !== undefined) || heldPhotoCandidate(update)) return false;
  return !actsInGroup(message);
}

/** The words of a message, as its sender wrote them (text or caption). */
export const wordsOf = (message: Json | null): string =>
  typeof message?.text === 'string' ? message.text : typeof message?.caption === 'string' ? message.caption : '';

export function createMediaRoute(ctx: Pick<CoreContext, 'db' | 'telegramBridge' | 'options'>) {
  const { db } = ctx;
  const system = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
  const tx = <T>(fn: (trx: Tx) => Promise<T>) => withRlsContext(db!, system, fn);

  /**
   * The language for words about a photo or a file: its own words, else the chat's (ADR-143's rule). Hunt 3: words
   * with no letter ("👍", "?", "2") tell no language; they were answered in English in a Sorani chat (ADR-251).
   */
  const langFor = async (trx: Tx, chatId: string, message: Json | null): Promise<RequesterLang> => {
    const own = wordsOf(message).trim();
    if (own && /\p{L}/u.test(own)) return requesterLang(own);
    return replyLanguage(trx, DEFAULT_TENANT_ID, chatId, [], record(message?.from)?.language_code);
  };

  /** Answers once per update: a replay gives the recorded answer (the ChatInbox notice is keyed by the update). */
  const answerOnce = async (updateId: number, payloadHash: string, build: (trx: Tx) => Promise<MediaAnswer>): Promise<MediaAnswer> =>
    tx(async (trx) => {
      const prior = await readMediaAnswer(trx, DEFAULT_TENANT_ID, updateId);
      if (prior) return prior.payloadHash === payloadHash ? { status: prior.status, extra: prior.extra }
        : { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } };
      const answer = await build(trx);
      const stored = await recordMediaAnswer(trx, DEFAULT_TENANT_ID, updateId, payloadHash, answer);
      return { status: stored.status, extra: stored.extra };
    });

  /**
   * A photo with no words and no reply: kept until its sender's words arrive. Null when the update is
   * not one. `holdAnswer` is what the route answers when the photo was kept (settle later).
   */
  async function holdPhotoUpdate(update: { update_id: number } & Json, chatId: string, payloadHash: string,
    settleDelayMs: number, captioned?: { fileId: string }, retainedImage?: BlobRef): Promise<MediaAnswer | null> {
    // A captioned photo whose words are not a brief (and nothing waits for a change) is kept the same
    // way, and asked about at once: its words said what it is not.
    const message = record(update.message);
    const from = record(message?.from);
    const candidate = captioned && message && Number.isSafeInteger(from?.id) && Number.isSafeInteger(message.message_id)
      ? { fileId: captioned.fileId, messageId: String(message.message_id), senderId: String(from!.id),
        topic: message.message_thread_id === undefined ? '' : String(message.message_thread_id) }
      : heldPhotoCandidate(update);
    if (!candidate || !db) return null;
    const settleLater = { status: 202, extra: { lifecycleAction: 'settle-later', chatId, settle: { kind: 'photo', delayMs: settleDelayMs } } };
    const answered = await tx((trx) => readMediaAnswer(trx, DEFAULT_TENANT_ID, update.update_id));
    if (answered) return answered.payloadHash === payloadHash ? { status: answered.status, extra: answered.extra }
      : { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } };
    const prior = await tx((trx) => readHeldPhoto(trx, DEFAULT_TENANT_ID, update.update_id));
    if (prior && prior.chatId !== chatId) return { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } };
    if (!prior) {
      if (!retainedImage && !ctx.telegramBridge) return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
      // Only Core's source-hash-checked burst handoff supplies this internal reference (ADR221).
      const photo = retainedImage ? { kind: 'stored' as const, ref: retainedImage }
        : await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
          (id) => ctx.telegramBridge!.downloadFile(id), candidate.fileId);
      if (photo.kind === 'store_unavailable') return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
      if (photo.kind === 'download_unavailable') return { status: 503, extra: { code: 'PHOTO_UNAVAILABLE' } };
      if (photo.kind === 'unsupported') {
        return answerOnce(update.update_id, payloadHash, async (trx) =>
          chatAnswer(chatId, say(MEDIA_MESSAGES.photoUnreadable, await langFor(trx, chatId, message)), { media: 'photo-unreadable' }));
      }
      await tx((trx) => holdPhoto(trx, DEFAULT_TENANT_ID, { updateId: update.update_id, chatId, senderId: candidate.senderId,
        topic: candidate.topic, messageId: candidate.messageId, image: photo.ref }, payloadHash, update));
    }
    if (!captioned) return settleLater;
    return answerOnce(update.update_id, payloadHash, async (trx) => {
      await markPhotoAsked(trx, DEFAULT_TENANT_ID, update.update_id);
      return chatAnswer(chatId, say(MEDIA_MESSAGES.photoHeld, await langFor(trx, chatId, message)), { media: 'photo-held' });
    });
  }

  /**
   * The settle of a kept photo: taken by words already (nothing to say), waiting behind a held brief,
   * joined to the request its sender opened just before it, or asked about once.
   * `late` records a note on a request (the route's late-change store) and answers it.
   */
  async function settlePhoto(update: { update_id: number } & Json, chatId: string, settleDelayMs: number,
    late: (change: LateRequesterChange) => Promise<MediaAnswer>): Promise<MediaAnswer | null> {
    if (!db) return null;
    const photo = await tx((trx) => readHeldPhoto(trx, DEFAULT_TENANT_ID, update.update_id));
    if (!photo) return null;
    const settleAgain = { status: 202, extra: { lifecycleAction: 'settle-later', chatId, settle: { kind: 'photo', delayMs: settleDelayMs } } };
    const answered = await tx((trx) => readMediaAnswer(trx, DEFAULT_TENANT_ID, update.update_id));
    if (answered) return { status: answered.status, extra: { ...answered.extra, duplicate: true } };
    const use = await tx((trx) => readPhotoUse(trx, DEFAULT_TENANT_ID, update.update_id));
    if (use && use.byUpdateId !== update.update_id) return { status: 200, extra: { settle: 'skipped', photo: use.how } };
    const scope = { chatId, senderId: photo.senderId, topic: photo.topic };
    if (!use && await tx((trx) => pendingHeldBrief(trx, DEFAULT_TENANT_ID, scope, update.update_id))) return settleAgain;
    const opened = await tx((trx) => recentOpenBy(trx, DEFAULT_TENANT_ID, scope, photo.at));
    if (opened) {
      if (opened.ambiguous) return answerOnce(update.update_id,`settle:${update.update_id}`,async()=>({status:409,
        extra:{lifecycleAction:'request-choice-required',code:'AMBIGUOUS_REQUEST',chatId}}));
      const target = await tx((trx) => requestFor(trx, opened.requestId));
      // The open is decided but RequestLifecycle has not projected it yet: settle again shortly.
      if (!target) return settleAgain;
      // A design that waits for the requester's changes takes the photo with the words of the change.
      const waitsForChanges = target.stage === 'awaiting_answer' || (target.stage === 'manual' && target.rev >= 3);
      if (!waitsForChanges) return joinOrPass(update, chatId, photo, target, opened.album, late);
    }
    const message = record(update.message);
    // ADR-144 §2.7 (ADR-160): in a group, a photo addressed to no one is not asked about. It stays kept
    // for its sender's own words to the bot within the join window, and nothing is said.
    if (isGroupChat(message)) {
      return answerOnce(update.update_id, `settle:${update.update_id}`, async () =>
        ({ status: 200, extra: { settle: 'skipped', media: 'photo-quiet' } }));
    }
    return answerOnce(update.update_id, `settle:${update.update_id}`, async (trx) => {
      await markPhotoAsked(trx, DEFAULT_TENANT_ID, update.update_id);
      return chatAnswer(chatId, say(MEDIA_MESSAGES.photoHeld, await langFor(trx, chatId, message)), { media: 'photo-held' });
    });
  }

  interface Target { requestId: string; stage: string; rev: number; taskId: string; title: string }
  async function requestFor(trx: Tx, requestId: string): Promise<Target | null> {
    const row = (await sql<{ stage: string; rev: string | number; task_id: string; title: string | null }>`SELECT r.stage, r.rev,
        r.current_task_id::text AS task_id, coalesce(root.title, t.title) AS title
      FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
      LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
      WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.request_id = ${requestId}::uuid`.execute(trx)).rows[0];
    return row ? { requestId, stage: row.stage, rev: Number(row.rev), taskId: row.task_id, title: row.title || 'your design' } : null;
  }

  /**
   * Adds the photo to the request's task while its design has not started using pictures (no design
   * run yet, or one still reading its brief with no pinned visual basis; the old intake's rule), or
   * while a designer makes it by hand. Otherwise the photo is passed to the office as a note.
   */
  async function joinOrPass(update: { update_id: number } & Json, chatId: string, photo: HeldPhoto, target: Target,
    album: boolean, late: (change: LateRequesterChange) => Promise<MediaAnswer>): Promise<MediaAnswer> {
    const message = record(update.message);
    const joined = await tx(async (trx) => {
      const lang = await langFor(trx, chatId, message);
      const prior = await readPhotoUse(trx, DEFAULT_TENANT_ID, update.update_id);
      if (prior?.how === 'passed') return { passed: true as const, lang };
      if (prior?.how === 'joined') return { passed: false as const, lang };
      await sql`SELECT 1 FROM hawa.requests WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND request_id = ${target.requestId}::uuid
        FOR UPDATE`.execute(trx);
      const run = (await sql<{ status: string; pinned: boolean }>`SELECT r.status,
          EXISTS (SELECT 1 FROM hawa.studio_visual_inputs v WHERE v.tenant_id = r.tenant_id AND v.run_id = r.id) AS pinned
        FROM hawa.design_studio_runs r WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.task_id = ${target.taskId}::uuid
        ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r`.execute(trx)).rows[0];
      const joinable = !album && (target.stage === 'manual' ||
        (target.stage === 'designing' && (!run || (['briefing', 'conceiving'].includes(run.status) && !run.pinned))));
      // The claim comes first: words that took the photo meanwhile keep it, and nothing is attached.
      const claim = await claimPhoto(trx, DEFAULT_TENANT_ID, update.update_id,
        { byUpdateId: update.update_id, how: joinable ? 'joined' : 'passed', requestId: target.requestId });
      if (claim.byUpdateId !== update.update_id) return { taken: true as const, lang };
      if (claim.how === 'passed') return { passed: true as const, lang };
      await sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
        VALUES (${DEFAULT_TENANT_ID}::uuid, ${target.taskId}::uuid, ${photo.image.sha256}, 'reference_image')
        ON CONFLICT DO NOTHING`.execute(trx);
      return { passed: false as const, lang };
    });
    if ('taken' in joined) return { status: 200, extra: { settle: 'skipped' } };
    const title = bold(shortTitle(target.title));
    if (!joined.passed) {
      return answerOnce(update.update_id, `settle:${update.update_id}`, async () =>
        chatAnswer(chatId, say(MEDIA_MESSAGES.photoAdded, joined.lang, { title }), { media: 'photo-joined', requestId: target.requestId }));
    }
    const change: LateRequesterChange = { requestId: target.requestId, taskId: target.taskId, requestRev: target.rev,
      requestStage: target.stage as LateRequesterChange['requestStage'],
      text: '[The requester sent a photo for this design right after its brief. It is in the Telegram chat and was not added to the design.]',
      title: shortTitle(target.title), answer: say(MEDIA_MESSAGES.photoPassed, joined.lang, { title }) };
    return late(change);
  }

  /** A video, a round video or a GIF: never parked. With words, the words are used and the video is explained. */
  async function unusable(update: { update_id: number } & Json, chatId: string, payloadHash: string): Promise<
    { answer: MediaAnswer } | { words: string; notice: { text: string; parseMode: 'HTML' } } | null> {
    const message = record(update.message);
    const kind = unusableMedia(message);
    if (!kind || !db) return null;
    const words = wordsOf(message).trim();
    if (words) return { words, notice: { text: say(MEDIA_MESSAGES.videoWordsUsed, requesterLang(words)), parseMode: 'HTML' } };
    return { answer: await answerOnce(update.update_id, payloadHash, async (trx) =>
      chatAnswer(chatId, say(MEDIA_MESSAGES.videoNotUsed, await langFor(trx, chatId, message)), { media: 'video' })) };
  }

  /** A file that is not a picture, a PDF or a recording, or a picture that could not be opened. */
  async function unreadableFile(update: { update_id: number } & Json, chatId: string, payloadHash: string,
    phrase: 'fileUnsupported' | 'photoUnreadable' | 'photosUnplaced'): Promise<MediaAnswer> {
    const message = record(update.message ?? update.edited_message);
    return answerOnce(update.update_id, payloadHash, async (trx) =>
      chatAnswer(chatId, say(MEDIA_MESSAGES[phrase], await langFor(trx, chatId, message)), { media: phrase }));
  }

  /**
   * A sender outside the intake list (N5): one polite answer per chat per day, nothing else kept, no
   * design. Other updates of that chat that day are answered with nothing (`quiet`).
   */
  async function notAllowed(update: { update_id: number } & Json, chatId: string): Promise<MediaAnswer> {
    const base = { code: 'SENDER_NOT_ALLOWED' };
    if (!db || !chatId) return { status: 403, extra: base };
    const message = record(update.message ?? update.edited_message ?? update.channel_post ?? record(update.callback_query)?.message);
    const due = await tx((trx) => unlistedReplyDue(trx, DEFAULT_TENANT_ID, chatId, update.update_id, requesterLang(wordsOf(message))));
    if (!due.due) return { status: 403, extra: { ...base, quiet: true } };
    return { status: 403, extra: { ...base, lifecycleAction: 'chat-answer', chatId,
      chatAnswer: { text: say(ACCESS_MESSAGES.notAllowed, due.lang), parseMode: 'HTML' } } };
  }

  return { holdPhotoUpdate, settlePhoto, unusable, unreadableFile, notAllowed, langFor };
}
