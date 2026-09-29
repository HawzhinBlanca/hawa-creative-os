/**
 * Core's internal API for the request lifecycle on Restate (architecture programme Phase 2, ADR-034,
 * PHASE2_DESIGN.md section 2.8). Slice 2.1 adds the two calls the worker's ChatInbox makes:
 *
 *   POST /v1/internal/telegram/intake  {v, update, mode: 'legacy'}  → {v, kind: 'handled', intakeStatus, …}
 *   POST /v1/internal/telegram/park    {v, update, reason, notifySender?} → {v, parked, alreadyParked}
 *
 * Every Telegram chat is owned by RequestLifecycle (ADR-135): both modes, `legacy` (the first
 * update of a chat, as ChatInbox sends it) and `lifecycle`, are handled alike. Intake checks request
 * ownership and a committed revision receipt before deciding whether the update belongs to a
 * waiting request or opens a new one. Since stage 2 of ADR-135 there is no other intake: a button
 * press (only the old intake's messages carried buttons) is a stale reply, and the answers to
 * greetings, questions, thanks, standing rules and chat commands come from
 * services/lifecycle-chat-answers.ts and are sent by ChatInbox.
 *
 * Only the worker calls these, with HAWA_WORKER_TOKEN: a `service` principal that app.ts's
 * verifyRequestAuth accepts on /v1/internal/* and nowhere else, and those routes accept nothing else.
 *
 * Codes the worker waits on instead of counting an attempt (apps/worker/src/lifecycle/core-client.ts):
 * DATABASE_UNAVAILABLE, INTAKE_PAUSED (the office's kill switch) and NOT_CONFIGURED. A dead letter
 * made while the database is down or intake is switched off would help nobody: the update waits.
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { chaosPoint } from '@hawa/observability';
import { sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, parseBlobRef, parseLifecycleAlbumRef, parseLifecycleSourceRef, type DeliveryOutcome } from '@hawa/contracts';
import { createLifecycleSourceIntake } from '../services/lifecycle-source-intake.js';
import { assertSourceIdentity, SourceConflict } from '../services/lifecycle-source-store.js';
import { chooseWaitingChatRequest, parseCompleteRevisionRequest, parseOfficeApprovalProof, parseRejectionCategory } from '@hawa/domain';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { createChatCampaignIntake } from '../services/chat-campaign-intake.js';
import { blobStoreFor } from '../services/blob-store-context.js';
import { lifecyclePhotoInput, retainLifecyclePhoto } from '../services/lifecycle-photo.js';
import { AlbumConflict, albumMessage, isAlbumConfirmation, readAlbumPart, partReply, assertAlbumSource,
  confirmAlbum, normalizedAlbumUpdate, retainAlbumPart, type AlbumSnapshot } from '../services/lifecycle-album.js';
import { classifyWithHeuristics } from '../services/telegram-classifier.js';
import { createTelegramUpdateState } from '../services/telegram-intake/update-state.js';
import { log } from '../logging.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { lateChangeOfficeAlert, lateChangeTargets, linkedLifecycleReplies, readNewBriefDecision, recordNewBriefDecision,
  readRevisionPhotoDecision, recordRevisionPhotoDecision,
  readRoutingRefusal, recordRoutingRefusal,
  revisionIntakeReceipts, verifiedRevisionIntake, waitingLifecycleRequests,
  type LateRequesterChange } from '../services/lifecycle-chat-target.js';
import { PARKED_UPDATE_NOTICE, parkTelegramUpdate, parkedUpdateChat } from '../services/polled-update-dispatch.js';
import { createLifecycleChatAnswers } from '../services/lifecycle-chat-answers.js';
import { LifecycleProjectionConflict, confirmLifecycleQuestionSent, projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen, projectLifecycleRequesterRevision, projectLifecycleRequesterRevisionWithIntake } from '../services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart } from '../services/lifecycle-delivery-projection.js';
import { splitBilingualRequest, type ChatIntake } from '../services/chat-intake.js';
import type { RouteContext } from './types.js';
import { parseNativeReviewSubmission } from '@hawa/domain';
import { projectLifecycleNativeReview } from '../services/lifecycle-native-review.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';

/** /v1/internal/*, under any of the prefixes registerRoute mounts routes at. */
export function isInternalPath(path: string): boolean {
  return /^\/(?:api\/)?(?:v1\/)?internal(?:\/|$)/.test(path);
}

// The worker credential rules live in services/worker-credential.ts (ADR-129: services sign with it too).
export { acceptedServiceTokensOf, serviceTokenOf, workerSigningSecretOf } from '../services/worker-credential.js';

interface UpdateLike { update_id: number; [kind: string]: unknown }

/** The chat an update came from, for the chaos suite's point (the dead letter's own reading). */
const chatOf = (u: UpdateLike): string => parkedUpdateChat(u) ?? '';

const isUpdate = (u: unknown): u is UpdateLike =>
  Boolean(u) && typeof u === 'object' && Number.isSafeInteger((u as UpdateLike).update_id) && (u as UpdateLike).update_id > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The answer for a requester's words that reached a request after its design went to the office
 * (finding 13 of the Phase 4 review). The same stored change always gives the same answer.
 */
function lateChangeAnswer(chatId: string, late: LateRequesterChange): Record<string, unknown> {
  const office = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean);
  const officeAlert = lateChangeOfficeAlert(late, chatId, office);
  return { code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change', chatId,
    requestId: late.requestId, requestStage: late.requestStage, ...(officeAlert ? { officeAlert } : {}) };
}

function requestIdForUpdate(chatId: string, updateId: number): string {
  const bytes = Buffer.from(createHash('sha256').update(`telegram-new-brief:${chatId}:${updateId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The request a bilingual brief opens for its second language (ADR-139), as stable as the first's. */
function languageRequestIdFor(chatId: string, updateId: number, lang: 'ckb'): string {
  const bytes = Buffer.from(createHash('sha256').update(`telegram-new-brief:${chatId}:${updateId}:${lang}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openDraft(value: unknown, requestId: string): ChatIntake | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.platform !== 'telegram' || d.sourceEventId !== `lc-${requestId}-r0` ||
      typeof d.sourceChannelId !== 'string' || !/^-?\d{1,20}$/.test(d.sourceChannelId) ||
      typeof d.rawText !== 'string' || !d.rawText.trim() || d.rawText.length > 100_000 ||
      typeof d.title !== 'string' || !d.title.trim() || d.title.length > 500 ||
      typeof d.designInstructions !== 'string' || d.designInstructions.length > 100_000 ||
      !Array.isArray(d.exactCopy) || d.exactCopy.length > 500 || JSON.stringify(d.exactCopy).length > 100_000 ||
      !(d.clientId === null || (typeof d.clientId === 'string' && UUID.test(d.clientId))) ||
      (d.autoGenerate !== undefined && typeof d.autoGenerate !== 'boolean') ||
      (d.isInstructionOnly !== undefined && typeof d.isInstructionOnly !== 'boolean')) return null;
  const variant = d.variant;
  if (variant !== undefined && (!variant || typeof variant !== 'object' ||
      !Number.isInteger((variant as any).width) || !Number.isInteger((variant as any).height) ||
      (variant as any).width < 640 || (variant as any).width > 2400 ||
      (variant as any).height < 640 || (variant as any).height > 2400)) return null;
  if (d.designStudio !== undefined && typeof d.designStudio !== 'boolean') return null;
  const options = d.studioOptions;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
      JSON.stringify(options).length > 2000 ||
      (Object.keys(options).some((key) => !['tier', 'imagery', 'previews', 'holdForSelection'].includes(key))) ||
      ((options as any).tier !== undefined && !['fast', 'quality'].includes((options as any).tier)) ||
      ((options as any).imagery !== undefined && !['none', 'abstract', 'photographic'].includes((options as any).imagery)) ||
      ((options as any).previews !== undefined && (!Number.isInteger((options as any).previews) || (options as any).previews < 1 || (options as any).previews > 4)) ||
      ((options as any).holdForSelection !== undefined && typeof (options as any).holdForSelection !== 'boolean'))) return null;
  const image = d.lifecycleImage;
  const source = d.lifecycleSource === undefined ? undefined : parseLifecycleSourceRef(d.lifecycleSource);
  if (d.lifecycleSource !== undefined && (!source || image || d.lifecycleAlbum)) return null;
  const album = d.lifecycleAlbum === undefined ? undefined : parseLifecycleAlbumRef(d.lifecycleAlbum);
  if ((d.lifecycleAlbum !== undefined && !album) || (image && album)) return null;
  const imageRef = image === undefined ? undefined : parseBlobRef(image);
  if (image !== undefined && (!imageRef || !Number.isSafeInteger((image as any).updateId) ||
      (image as any).updateId <= 0 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(imageRef.mediaType) ||
      imageRef.size > 20 * 1024 * 1024)) return null;
  // Select the contract explicitly. A worker payload cannot choose the database principal, tenant,
  // outbox owner or a second source through spare JSON fields.
  return {
    platform: 'telegram', sourceEventId: d.sourceEventId as string, sourceChannelId: d.sourceChannelId as string,
    rawText: d.rawText as string, title: d.title as string,
    designInstructions: d.designInstructions as string, exactCopy: d.exactCopy as unknown[],
    clientId: d.clientId as string | null,
    ...(d.autoGenerate !== undefined ? { autoGenerate: d.autoGenerate as boolean } : {}),
    ...(d.isInstructionOnly !== undefined ? { isInstructionOnly: d.isInstructionOnly as boolean } : {}),
    ...(variant ? { variant: variant as { width: number; height: number } } : {}),
    ...(d.designStudio !== undefined ? { designStudio: d.designStudio as boolean } : {}),
    ...(options ? { studioOptions: options as ChatIntake['studioOptions'] } : {}),
    ...(imageRef ? { lifecycleImage: { ...imageRef, updateId: (image as { updateId: number }).updateId } } : {}),
    ...(album ? { lifecycleAlbum: album } : {}),
    ...(source ? { lifecycleSource: source } : {}),
  };
}

export function registerLifecycleInternalRoutes(ctx: RouteContext): void {
  const { app, db, problem, verifyRequestAuth, channelKillSwitches } = ctx;
  const sourceIntake = createLifecycleSourceIntake(ctx);
  const chatAnswers = createLifecycleChatAnswers(ctx);

  // Registered on /v1/internal/* only (not under every prefix, as registerRoute does): one address,
  // which nginx does not need to serve, for one caller.
  const internal = (path: string, handler: (c: Context) => Promise<Response>) =>
    app.post(`/v1/internal${path}`, async (c: Context) => {
      const auth = verifyRequestAuth(c);
      if (!auth.authenticated || auth.role !== 'service') return problem(c, 401, 'Authentication Required', 'This route takes the worker\'s credential only');
      return handler(c);
    });

  internal('/lifecycle/:requestId/native-review',async c=>{
    const event=parseNativeReviewSubmission(await c.req.json().catch(()=>null));
    if (!event || event.requestId !== c.req.param('requestId')) return problem(c,422,'Invalid Native Review');
    if (!db) return problem(c,503,'Database Required');
    try { return c.json(await projectLifecycleNativeReview(db,DEFAULT_TENANT_ID,event)); }
    catch(error) {
      if (error instanceof CanvaFlowError) return problem(c,error.status,error.code,error.message);
      return problem(c,503,'Native Review Unavailable','Retry the identical submission.');
    }
  });

  const readBody = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body = await c.req.json();
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  internal('/telegram/intake', async (c) => {
    const body = await readBody(c);
    const incoming = body?.update;
    if (!isUpdate(incoming)) return problem(c, 400, 'Invalid update', 'The body must carry a Telegram update with a positive update_id');
    let preparedUpdate: UpdateLike = incoming;
    // ChatInbox sends `legacy` for a chat's first update and `lifecycle` after that. Since ADR-135
    // every chat is lifecycle-owned and both are handled alike; unknown modes are refused explicitly.
    const mode = body?.mode ?? 'legacy';
    // The worker opens every request an answer names (ADR-139); an older worker opened only the first.
    const acceptsLanguageSiblings = body?.languageSiblings === true;
    if (mode !== 'legacy' && mode !== 'lifecycle') {
      return problem(c, 400, 'Unknown intake mode', `This Core runs intake in mode "legacy" or "lifecycle", not "${String(mode)}"`);
    }

    const handled = (intakeStatus: number, extra: Record<string, unknown> = {}) =>
      c.json({ v: 1, kind: 'handled', intakeStatus, ...extra }, 200);

    // What intake answers when the update opens no request and changes none (ADR-135 stage 2c).
    const answerChat = async (update: UpdateLike): Promise<Response> => {
      let answer: Awaited<ReturnType<typeof chatAnswers.answer>>;
      try {
        answer = await chatAnswers.answer(update, chatOf(update));
      } catch (err) {
        if ((err as { status?: number })?.status === 503) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
        throw err;
      }
      await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatOf(update), status: answer.status });
      return handled(answer.status, answer.extra);
    };

    // Kept as the Telegram configuration check it has always been: the worker waits on NOT_CONFIGURED.
    if (!process.env.TELEGRAM_WEBHOOK_SECRET) return handled(503, { code: 'NOT_CONFIGURED', detail: 'TELEGRAM_WEBHOOK_SECRET is not configured' });
    // Intake refuses while the office has switched Telegram off; the update waits in its chat for the
    // switch, as it waited in Telegram when Core polled. Asked here so the answer is not a retry.
    if (await intakeRefused(channelKillSwitches, 'telegram')) return handled(503, { code: 'INTAKE_PAUSED' });

    if (db) {
      try { await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
        trx => assertSourceIdentity(trx, DEFAULT_TENANT_ID, incoming)); }
      catch (error) {
        if (error instanceof SourceConflict) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        throw error;
      }
    }

    let admittedAlbum: AlbumSnapshot | undefined;
    if (db) {
      try {
        await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
          (trx) => assertAlbumSource(trx, DEFAULT_TENANT_ID, preparedUpdate));
      } catch (error) {
        if (error instanceof AlbumConflict) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        throw error;
      }
    }
    const albumPart = albumMessage(preparedUpdate);
    if (albumPart || isAlbumConfirmation(preparedUpdate)) {
      if (!db) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
      const tx = <T>(fn: (trx: import('@hawa/db').Kysely<import('@hawa/db').Database>) => Promise<T>) =>
        withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
      const source = preparedUpdate;
      const chatId = chatOf(source);
      const msg = source.message as Record<string, unknown>;
      const senderId = String((msg.from as { id?: unknown } | undefined)?.id ?? '');
      const senderAllowed = !ctx.isProduction || ctx.telegramIntakeUsers.includes('*') ||
        process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*' || ctx.telegramIntakeUsers.includes(senderId);
      const reply = (answer: { status: number; message: string; noticeKey: string }) =>
        handled(answer.status, { lifecycleAction: 'album-message', chatId,
          albumMessage: answer.message, albumNoticeKey: answer.noticeKey });
      try {
        if (albumPart) {
          const priorPart = await tx((trx) => readAlbumPart(trx, DEFAULT_TENANT_ID, source));
          if (priorPart) return reply(partReply(priorPart));
          const priorRouting = await tx((trx) => readRoutingRefusal(trx, DEFAULT_TENANT_ID, source.update_id));
          // Every chat is lifecycle-owned (ADR-135): an album part is kept unless a refusal replays.
          if (!priorRouting) {
            if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
            const old = await createTelegramUpdateState(ctx).telegramUpdateHandled(chatId, String(source.update_id));
            if (old) return handled(200, { duplicate: true, ...(old.taskId ? { taskIds: [old.taskId] } : {}) });
            return reply(await retainAlbumPart(tx, DEFAULT_TENANT_ID, source, blobStoreFor(db, ctx.options?.blobStore),
              (id) => ctx.telegramBridge?.downloadFile(id) ?? Promise.resolve(null)));
          }
        } else {
          if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
          const confirmed = await tx((trx) => confirmAlbum(trx, DEFAULT_TENANT_ID, source));
          if (confirmed.reply) return reply(confirmed.reply);
          admittedAlbum = confirmed.snapshot;
          if (!admittedAlbum) throw new Error('Album confirmation has no stored result');
          preparedUpdate = normalizedAlbumUpdate(admittedAlbum);
          await chaosPoint('core.intake.after-album-confirmation', { updateId: source.update_id, chat: chatId });
        }
      } catch (error) {
        if (error instanceof AlbumConflict) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        if (error instanceof Error && error.message === 'ALBUM_STORE_UNAVAILABLE') return handled(503, { code: 'NOT_CONFIGURED' });
        if (error instanceof Error && error.message === 'ALBUM_PHOTO_UNAVAILABLE') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
        throw error;
      }
    }

    const update = preparedUpdate;

    // A decision must replay even if the flag changed after the first answer was lost.
    const sourceChat = chatOf(update);
    let priorRefusal: Awaited<ReturnType<typeof readRoutingRefusal>> = null;
    let priorRevisionPhoto: Awaited<ReturnType<typeof readRevisionPhotoDecision>> = null;
    if (db && sourceChat) {
      try {
        const prior = await withRlsContext(db,
          { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
          async (trx) => ({
            open: await readNewBriefDecision(trx, DEFAULT_TENANT_ID, update.update_id),
            refusal: await readRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id),
            revisionPhoto: await readRevisionPhotoDecision(trx, DEFAULT_TENANT_ID, update.update_id),
          }));
        priorRefusal = prior.refusal;
        priorRevisionPhoto = prior.revisionPhoto;
        // A valid photo can subsequently hit the daily cap or a missing parent brief.
        // That refusal replays before the pending image decision; both carry this update hash.
        if (prior.open && (priorRefusal || priorRevisionPhoto)) {
          return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        }
        if (priorRevisionPhoto) {
          const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
          if (priorRevisionPhoto.payloadHash !== hash || priorRevisionPhoto.chatId !== sourceChat) {
            return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
          }
        }
        if (prior.open) {
          const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
          if (prior.open.payloadHash !== hash || prior.open.chatId !== sourceChat) {
            return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
          }
          // A decision that opened one request per language cannot be replayed to a worker that
          // would open only the first: the update is retried and, if that worker stays, parked for
          // an operator rather than losing a language (ADR-139).
          if (prior.open.siblings?.length && !acceptsLanguageSiblings) {
            return handled(503, { code: 'LANGUAGE_SIBLINGS_UNSUPPORTED' });
          }
          return handled(200, { duplicate: true, lifecycleAction: 'open-request',
            requestId: prior.open.requestId, chatId: sourceChat, draft: prior.open.draft,
            ...(prior.open.siblings?.length ? { siblings: prior.open.siblings } : {}) });
        }
      } catch (err) {
        if ((err as { status?: number })?.status === 503) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
        throw err;
      }
    }

    // A deliberate lifecycle refusal replays as it was first answered when Telegram repeats the
    // same update ID, whatever intake would decide today.
    if (priorRefusal) {
      const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
      if (priorRefusal.payloadHash !== hash || priorRefusal.chatId !== sourceChat) {
        return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
      }
      if (priorRefusal.code === 'LIFECYCLE_MEDIA_NOT_ADMITTED') {
        return handled(422, { code: priorRefusal.code, lifecycleAction: 'park-update',
          chatId: sourceChat, reason: 'A lifecycle chat media update needs operator review; no task was started' });
      }
      if (priorRefusal.code === 'LATE_REQUESTER_CHANGE' && priorRefusal.late) {
        return handled(409, lateChangeAnswer(sourceChat, priorRefusal.late));
      }
      return handled(409, { code: priorRefusal.code,
        lifecycleAction: priorRefusal.code === 'AMBIGUOUS_REQUEST' ||
          priorRefusal.code === 'STALE_REQUEST_REPLY' ? 'request-choice-required' : 'revision-blocked',
        chatId: sourceChat });
    }

    const sourceAnswer = await sourceIntake(update);
    if (sourceAnswer) return handled(sourceAnswer.status, sourceAnswer.extra);

    // A button press. Lifecycle messages carry no buttons, so every button is under a message the
    // old intake sent (a draft's Approve / Change / Ask a designer, an office review card, a
    // reminder). That intake is gone (ADR-135 stage 2): the press changes nothing and is answered as
    // a stale reply, under a receipt that replays. Its data is never read as a requester's words.
    const button = update.callback_query && typeof update.callback_query === 'object'
      ? update.callback_query as { id?: unknown; from?: { id?: unknown } } : null;
    if (button && !priorRevisionPhoto && !admittedAlbum && chatOf(update)) {
      if (!db) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
      const presser = String(button.from?.id ?? '');
      if (ctx.isProduction && !ctx.telegramIntakeUsers.includes('*') && process.env.TELEGRAM_INTAKE_ALLOWED_USERS !== '*' &&
          !ctx.telegramIntakeUsers.includes(presser)) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
      const chatId = chatOf(update);
      const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
      try {
        const stored = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
          (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id, { code: 'STALE_REQUEST_REPLY', chatId, payloadHash }));
        if (stored.payloadHash !== payloadHash || stored.chatId !== chatId || stored.code !== 'STALE_REQUEST_REPLY') {
          return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        }
      } catch (err) {
        if ((err as { status?: number })?.status === 503) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
        throw err;
      }
      // Stops the button's spinner; the answer itself is ChatInbox's notice.
      if (typeof button.id === 'string' && ctx.telegramBridge) {
        await ctx.telegramBridge.answerCallbackQuery(button.id, 'This button no longer does anything.', false).catch(() => false);
      }
      await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: 409 });
      return handled(409, { code: 'STALE_REQUEST_REPLY', lifecycleAction: 'request-choice-required', chatId });
    }

    // --- bind a requester answer to one request, then replay it by update ID ---
    {
      // The chat's stored request ID is only a hint. A chat can contain more than one request.
      if (!db) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
      {
        // Extract the directive text from the Telegram update.
        const msg = (update as Record<string, unknown>).message;
        const chatId: string = chatOf(update);
        const carrier = update.message ?? update.edited_message ?? update.channel_post;
        const media = carrier && typeof carrier === 'object' ? carrier as Record<string, unknown> : null;
        const photoInput = lifecyclePhotoInput(update);
        const sender = media?.from as { id?: unknown } | undefined;
        const senderId = String(sender?.id ?? '');
        const isIntakeOpen = ctx.telegramIntakeUsers.includes('*') || process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*';
        const senderAllowed = !ctx.isProduction || isIntakeOpen ||
          (ctx.telegramIntakeUsers.length > 0 && ctx.telegramIntakeUsers.includes(senderId));
        const holdMedia = async () => {
          // Hold unsupported input as a whole; a caption cannot replace an unavailable file.
          if (!senderAllowed) {
            return handled(403, { code: 'SENDER_NOT_ALLOWED' });
          }
          const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
          const stored = await withRlsContext(db,
            { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
            (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id,
              { code: 'LIFECYCLE_MEDIA_NOT_ADMITTED', chatId, payloadHash }));
          if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
              stored.code !== 'LIFECYCLE_MEDIA_NOT_ADMITTED') {
            return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
          }
          return handled(422, { code: stored.code, lifecycleAction: 'park-update', chatId,
            reason: 'A lifecycle chat media update needs operator review; no task was started' });
        };
        if (media && chatId && (media.photo || media.voice || media.audio || media.document ||
            media.video || media.video_note || media.animation || media.live_photo || media.caption) && !photoInput) {
          return holdMedia();
        }
        const rawText: string = (() => {
          if (photoInput) return photoInput.directive;
          if (msg && typeof msg === 'object') {
            const t = (msg as Record<string, unknown>).text ?? (msg as Record<string, unknown>).caption;
            return typeof t === 'string' ? t : '';
          }
          return '';
        })();
        if (rawText.trim() && chatId) {
          const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
          type RefusalCode = 'AMBIGUOUS_REQUEST' | 'STALE_REQUEST_REPLY' |
            'DAILY_CAP_REACHED' | 'PARENT_BRIEF_MISSING' | 'QUESTION_MISSING';
          const actionFor = (code: RefusalCode) => code === 'AMBIGUOUS_REQUEST' ||
            code === 'STALE_REQUEST_REPLY' ? 'request-choice-required' : 'revision-blocked';
          const refuseWithReceipt = async (code: RefusalCode) => {
            const stored = await withRlsContext(db,
              { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
              (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id,
                { code, chatId, payloadHash }));
            if (stored.payloadHash !== payloadHash || stored.chatId !== chatId || stored.code !== code) {
              return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
            }
            return handled(409, { code, lifecycleAction: actionFor(code), chatId });
          };
          try {
            const TENANT = DEFAULT_TENANT_ID;
            const directive = rawText.trim();
            // An update that already saved something (a request the old intake made before the
            // switch, a rule, an answered greeting) is not read again: its old receipt wins, and a
            // recorded answer is given again, word for word (lifecycle-chat-answers.ts).
            const oldIntake = await createTelegramUpdateState(ctx)
              .telegramUpdateHandled(chatId, String(update.update_id));
            if (oldIntake) {
              const answered = await chatAnswers.replay(chatId, update.update_id);
              if (answered) return handled(answered.status, answered.extra);
              return handled(200, { duplicate: true,
                ...(oldIntake.taskId ? { taskIds: [oldIntake.taskId] } : {}) });
            }
            // A lost answer from Core must replay before reading today's stage. The original
            // projection already moved manual → designing; falling through would answer it as chat.
            const receipts = await withRlsContext(db,
              { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
              (trx) => revisionIntakeReceipts(trx, TENANT, chatId, update.update_id));
            if (receipts.length > 1) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
            if (receipts.length === 1) {
              const result = receipts[0].result as Record<string, unknown>;
              if (result?.requestId !== receipts[0].request_id || result.directive !== directive ||
                  result.sourceUpdateHash !== payloadHash ||
                  typeof result.newTaskId !== 'string' || typeof result.priorTaskId !== 'string' ||
                  typeof result.round !== 'number') return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
              return handled(200, { duplicate: true,
                lifecycleAction: typeof result.questionId === 'string' ? 'requester-answer' : 'requester-revision',
                requestId: result.requestId, newTaskId: result.newTaskId, round: result.round,
                directive: result.directive, priorTaskId: result.priorTaskId, rawText: directive, chatId,
                ...(typeof result.questionId === 'string' ? { questionId: result.questionId } : {}) });
            }

            const replied = msg && typeof msg === 'object' ? (msg as Record<string, unknown>).reply_to_message : null;
            const messageId = replied && typeof replied === 'object'
              ? (replied as Record<string, unknown>).message_id : null;
            const replyMessageId = Number.isSafeInteger(messageId) && Number(messageId) > 0 ? String(messageId) : null;
            const newCommand = /^\/new(?:@\w+)?(?:\s+|$)/i.exec(directive);
            const newBriefText = newCommand ? directive.slice(newCommand[0].length).trim() : directive;
            if (newCommand && !newBriefText) {
              return handled(422, { code: 'NEW_BRIEF_EMPTY', lifecycleAction: 'new-brief-required', chatId });
            }
            const { waiting, links } = await withRlsContext(db,
              { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => ({
                waiting: await waitingLifecycleRequests(trx, TENANT, chatId),
                links: replyMessageId ? await linkedLifecycleReplies(trx, TENANT, chatId, replyMessageId) : [],
              }));
            // A reply to a request whose design already went to the office (in review, approved,
            // delivering or delivered) cannot change that design, and it was a stale reply that kept
            // nothing. Its words are kept, the office is alerted, and Deliver waits for someone to
            // acknowledge them (finding 13 of the Phase 4 review).
            if (replyMessageId && !newCommand && !priorRevisionPhoto &&
                !links.some((link) => waiting.some((request) =>
                  request.request_id === link.requestId && Number(request.rev) === link.rev))) {
              const targets = await withRlsContext(db,
                { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
                (trx) => lateChangeTargets(trx, TENANT, chatId, replyMessageId));
              if (targets.length === 1) {
                const text = photoInput
                  ? `${photoInput.captionless ? '(no words)' : directive}\n[The requester also sent a photo. It is in the Telegram chat and was not kept.]`
                  : directive;
                const late: LateRequesterChange = { ...targets[0], text };
                const stored = await withRlsContext(db,
                  { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
                  (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id,
                    { code: 'LATE_REQUESTER_CHANGE', chatId, payloadHash, late }));
                if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
                    stored.code !== 'LATE_REQUESTER_CHANGE' || !stored.late) {
                  return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                }
                return handled(409, lateChangeAnswer(chatId, stored.late));
              }
            }
            if (replyMessageId && (links.length === 0 || newCommand)) return refuseWithReceipt('STALE_REQUEST_REPLY');
            if (links.length > 1) return refuseWithReceipt('AMBIGUOUS_REQUEST');
            // An explicit new brief may coexist with a waiting request. A reply to a lifecycle
            // notice always remains bound to that notice, including a stale reply.
            const mayOpen = Boolean(msg) && !replyMessageId && (Boolean(newCommand) || waiting.length === 0);
            if (mayOpen) {
              const classification = classifyWithHeuristics(newBriefText, false, false);
              if (classification.kind !== 'new_brief') {
                if (newCommand) return handled(422, { code: 'NEW_BRIEF_EMPTY',
                  lifecycleAction: 'new-brief-required', chatId });
                // Questions, greetings and lasting preferences are answered below
                // (lifecycle-chat-answers.ts): they never become design tasks.
              } else {
                const sender = (msg as Record<string, { id?: unknown; first_name?: unknown }>).from;
                if (!senderAllowed) {
                  return handled(403, { code: 'SENDER_NOT_ALLOWED' });
                }
                if (newBriefText.length > 100_000) return handled(413, { code: 'BRIEF_TOO_LONG' });
                // Every brief opens a lifecycle request (ADR-135).
                {
                  const requestId = requestIdForUpdate(chatId, update.update_id);
                  // English and Kurdish copy for one graphic per language opens one request per
                  // language, as legacy intake made one task per language (ADR-139). Only for a worker
                  // that opens every request of the answer: an older one would open the first alone.
                  const bilingual = acceptsLanguageSiblings && !classification.isInstructionOnly
                    ? splitBilingualRequest(newBriefText) : null;
                  const parts: Array<{ requestId: string; text: string; lang?: 'en' | 'ckb' }> = bilingual
                    ? [{ requestId, text: bilingual.en, lang: 'en' },
                      { requestId: languageRequestIdFor(chatId, update.update_id, 'ckb'), text: bilingual.ckb, lang: 'ckb' }]
                    : [{ requestId, text: newBriefText }];
                  const prepare = (part: (typeof parts)[number]) => createChatCampaignIntake(ctx).prepareChatCampaignDraft({
                    platform: 'telegram', sourceEventId: `lc-${part.requestId}-r0`, sourceChannelId: chatId,
                    senderName: typeof sender?.first_name === 'string' ? sender.first_name : 'Requester',
                    rawText: part.text, rawJson: part.lang ? { ...update, hawaLanguageGraphic: part.lang } : update,
                    autoGenerate: !classification.isInstructionOnly,
                    isInstructionOnly: classification.isInstructionOnly,
                  });
                  const prepared = await prepare(parts[0]);
                  let lifecycleImage: ChatIntake['lifecycleImage'];
                  if (photoInput) {
                    if (!ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                    const photo = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                      (id) => ctx.telegramBridge!.downloadFile(id), photoInput.fileId);
                    if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                    if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                    if (photo.kind === 'unsupported') return holdMedia();
                    lifecycleImage = { ...photo.ref, updateId: update.update_id };
                  }
                  const media = { ...(lifecycleImage ? { lifecycleImage } : {}),
                    ...(admittedAlbum ? { lifecycleAlbum: admittedAlbum.ref } : {}) };
                  const draft = openDraft({ ...prepared, ...media }, requestId);
                  if (!draft) return handled(422, { code: 'INVALID_BRIEF' });
                  const siblings: Array<{ requestId: string; draft: ChatIntake }> = [];
                  for (const part of parts.slice(1)) {
                    const sibling = openDraft({ ...(await prepare(part)), ...media }, part.requestId);
                    if (!sibling) return handled(422, { code: 'INVALID_BRIEF' });
                    siblings.push({ requestId: part.requestId, draft: sibling });
                  }
                  const stored = await withRlsContext(db,
                    { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
                    (trx) => recordNewBriefDecision(trx, TENANT, update.update_id,
                      { requestId, chatId, payloadHash, draft,
                        ...((lifecycleImage || admittedAlbum) ? { sourceUpdate: update } : {}),
                        ...(siblings.length ? { siblings } : {}) }));
                  if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
                      stored.requestId !== requestId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: 200 });
                  return handled(200, { duplicate: false, lifecycleAction: 'open-request',
                    requestId, chatId, draft: stored.draft, ...(stored.siblings?.length ? { siblings: stored.siblings } : {}) });
                }
              }
            }
            const choice = chooseWaitingChatRequest(waiting.map((r) =>
              ({ requestId: r.request_id, rev: Number(r.rev) })), links[0]);
            if (choice.kind === 'ambiguous' || choice.kind === 'stale_reply') {
              return refuseWithReceipt(choice.kind === 'ambiguous' ? 'AMBIGUOUS_REQUEST' : 'STALE_REQUEST_REPLY');
            }
            const openRequest = choice.kind === 'target'
              ? waiting.find((r) => r.request_id === choice.requestId) : undefined;
            if (priorRevisionPhoto && priorRevisionPhoto.requestId !== openRequest?.request_id) {
              return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (openRequest) {
              if (openRequest.stage === 'awaiting_answer' &&
                  (!openRequest.question || !UUID.test(openRequest.question.id))) {
                return refuseWithReceipt('QUESTION_MISSING');
              }
              const questionId = openRequest.stage === 'awaiting_answer'
                ? openRequest.question!.id : undefined;
              const requestId = openRequest.request_id;
              const expectedRev = Number(openRequest.rev);
              const nextRev = expectedRev + 1;
              // Derive the round from the revision number: first office-revise lands at rev=3;
              // subsequent revisions increment by 2 each time (office+requester), so round = (rev - 1) / 2.
              const round = Math.max(1, Math.floor((expectedRev - 1) / 2));
              if (round >= 1) {
                let lifecycleImage = priorRevisionPhoto?.image;
                if (photoInput && !lifecycleImage) {
                  if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
                  if (!ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                  const photo = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                    (id) => ctx.telegramBridge!.downloadFile(id), photoInput.fileId);
                  if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                  if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                  if (photo.kind === 'unsupported') return holdMedia();
                  const stored = await withRlsContext(db,
                    { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
                    (trx) => recordRevisionPhotoDecision(trx, TENANT, update.update_id,
                      { requestId, chatId, payloadHash, image: photo.ref }));
                  if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
                      stored.requestId !== requestId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  lifecycleImage = stored.image;
                  await chaosPoint('core.intake.after-revision-photo-decision',
                    { updateId: update.update_id, chat: chatId, requestId });
                }
                const sourceEventId = `lc-${requestId}-r${round}-u${update.update_id}`;
                const key = `${requestId}:${nextRev}:requesterRevisionIntake:u${update.update_id}`;
                const projected = await projectLifecycleRequesterRevisionWithIntake(db, {
                  requestId, tenantId: TENANT, priorTaskId: openRequest.current_task_id,
                  round, directive, sourceEventId, sourceChannelId: chatId,
                  rawText: directive, sourceUpdateHash: payloadHash, sourceUpdate: update,
                  ...(lifecycleImage ? { lifecycleImage } : {}),
                  ...(admittedAlbum ? { lifecycleAlbum: admittedAlbum.ref } : {}),
                  clientId: openRequest.client_id,
                  ...(questionId ? { questionId } : {}),
                  expectedRev, rev: nextRev, key,
                });
                await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: 200 });
                return handled(200, { duplicate: false,
                  lifecycleAction: questionId ? 'requester-answer' : 'requester-revision',
                  requestId, newTaskId: projected.newTaskId,
                  round: projected.round, directive: projected.directive,
                  priorTaskId: openRequest.current_task_id, rawText: directive, chatId,
                  ...(questionId ? { questionId } : {}),
                });
              }
            }
            if (photoInput || admittedAlbum) return holdMedia();
            // No waiting request and not a new brief (a question, a greeting, a rule): the chat's
            // answer below.
          } catch (err) {
            if (err instanceof LifecycleProjectionConflict) {
              log.warn(`[core:internal] lifecycle intake conflict for update ${update.update_id}: ${err.code} ${err.message}`);
              if (err.code === 'DAILY_CAP_REACHED' || err.code === 'PARENT_BRIEF_MISSING') {
                return refuseWithReceipt(err.code);
              }
              // Treat projection conflicts as a handled non-retryable result (409-like).
              return handled(409, { code: err.code, detail: err.message });
            }
            if ((err as { status?: number })?.status === 503) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
            throw err; // unexpected; let Restate retry
          }
        }
      }
    }

    // --- anything the lifecycle path did not take: a greeting, a question, a rule, a command ---
    return answerChat(update);
  });

  internal('/telegram/park', async (c) => {
    const body = await readBody(c);
    const update = body?.update;
    if (!isUpdate(update)) return problem(c, 400, 'Invalid update', 'The body must carry a Telegram update with a positive update_id');
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'intake kept failing';
    if (!db) return problem(c, 503, 'Database Unavailable', 'There is no database to store the dead letter in');
    const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID };
    const sourceEventId = `parked-update-${update.update_id}`;
    try {
      // ChatInbox runs one update of a chat at a time, so a second park of this update is only the
      // worker asking again after an answer it did not get: it stores nothing and tells nobody again.
      const already = await withRlsContext(db, { ...scope, role: 'operator' }, async (trx) =>
        (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.inbox_events WHERE tenant_id = ${scope.tenantId}::uuid
          AND source_account_id = 'telegram' AND source_event_id = ${sourceEventId}`.execute(trx)).rows.length > 0);
      if (!already) {
        const office = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean);
        // The offset is the worker poller's: it moved past the update when Restate accepted it.
        await parkTelegramUpdate(db, scope, update, reason, { officeChatId: office });
        log.error(`[core:internal] update ${update.update_id} parked for an operator: ${reason}`);
        const chat = parkedUpdateChat(update);
        if (body?.notifySender !== false && chat && ctx.telegramBridge) {
          // Best effort, as before: the dead letter and the office alert are what must not be lost.
          await ctx.telegramBridge.dispatchOutboundMessage(chat, { text: PARKED_UPDATE_NOTICE })
            .then((sent) => { if (!sent.success) throw new Error(sent.error || 'send failed'); })
            .catch((err: unknown) => log.warn(`[core:internal] could not tell the sender that update ${update.update_id} was parked:`, err instanceof Error ? err.message : err));
        }
      }
      return c.json({ v: 1, parked: true, alreadyParked: already }, 200);
    } catch (err) {
      log.error(`[core:internal] update ${update.update_id} could not be parked:`, err instanceof Error ? err.message : err);
      return problem(c, 503, 'Database Unavailable', 'The dead letter could not be stored; ask again');
    }
  });

  // RequestLifecycle's first projection. Only the worker credential can reach it; a flagged
  // ChatInbox admission sends the owner an open event. One transaction pins task/outbox ownership.
  internal('/lifecycle/:requestId/project', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const ops = body?.ops;
    const first = Array.isArray(ops) && ops.length === 1 ? ops[0] as Record<string, unknown> : null;
    const draft = first?.kind === 'createRequest' ? openDraft(first.draft, requestId) : null;
    if (!UUID.test(requestId) || body?.v !== 1 || body.expectedRev !== 0 || body.rev !== 1 ||
        body.key !== `${requestId}:1:open` || !draft) {
      return problem(c, 400, 'Invalid lifecycle projection', 'Expected one versioned createRequest operation with a stable round-zero source');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleOpen(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, expectedRev: 0, rev: 1,
        key: body.key as string, draft,
      }, blobStoreFor(db, ctx.options?.blobStore));
      if (draft.lifecycleSource) await chaosPoint('core.source.after-projection', { requestId });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle open ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The projection did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/design-outcome', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const report = op?.report && typeof op.report === 'object' && !Array.isArray(op.report)
      ? op.report as Record<string, unknown> : null;
    const runId = op?.runId;
    const taskId = op?.taskId;
    const clean = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value);
    // Flexible rev: first round is expectedRev=1, rev=2; revision rounds are (1+2k)→(2+2k).
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 ||
        !Number.isInteger(expectedRev) || expectedRev < 1 || rev !== expectedRev + 1 ||
        op?.kind !== 'recordOutcome' || typeof taskId !== 'string' || !UUID.test(taskId) ||
        runId !== `dr-${taskId}` || body.key !== `${requestId}:${rev}:designFinished:${runId}` ||
        !report || !clean(report.status) ||
        (report.code !== undefined && !clean(report.code)) ||
        (report.designId !== undefined && (typeof report.designId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(report.designId))) ||
        (report.detail !== undefined && (typeof report.detail !== 'string' || report.detail.length > 500)) ||
        (report.runId !== undefined && (typeof report.runId !== 'string' || report.runId.length > 100)) ||
        (report.notifyRequester !== undefined && typeof report.notifyRequester !== 'boolean')) {
      return problem(c, 400, 'Invalid design outcome projection', 'Expected one versioned recordOutcome operation for the current design round');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDesignOutcome(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: taskId as string, runId: runId as string,
        expectedRev, rev, key: body.key as string,
        report: report as unknown as Parameters<typeof projectLifecycleDesignOutcome>[1]['report'],
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle design outcome ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The projection did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/question-sent', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const rev = body?.expectedRev;
    const taskId = body?.taskId;
    const questionId = body?.questionId;
    const messageId = body?.messageId;
    if (!UUID.test(requestId) || body?.v !== 1 || body.requestId !== requestId ||
        !Number.isInteger(rev) || (rev as number) < 2 ||
        typeof taskId !== 'string' || !UUID.test(taskId) ||
        typeof questionId !== 'string' || !UUID.test(questionId) ||
        body.messageKey !== `${requestId}:${rev}:design-outcome` ||
        typeof messageId !== 'string' || !/^[1-9][0-9]*$/.test(messageId) ||
        !Number.isSafeInteger(Number(messageId))) {
      return problem(c, 400, 'Invalid question send confirmation', 'The confirmation must name the current question and Telegram message');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The question send confirmation requires a database');
    try {
      const result = await confirmLifecycleQuestionSent(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, expectedRev: rev as number,
        taskId, questionId, messageKey: body.messageKey as string, messageId,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] question send confirmation ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Question Confirmation Unavailable', 'The confirmation did not commit; retry the same message');
    }
  });

  // The versioned office transition records the decision, task transition, request revision
  // and replay receipt in one transaction. Works across all revision rounds (expectedRev ≥ 2).
  internal('/lifecycle/:requestId/office-decision', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor)
      ? op.actor as Record<string, unknown> : null;
    const actionId = op?.actionId;
    const revisionRequest = op?.revisionRequest === undefined ? undefined : parseCompleteRevisionRequest(op.revisionRequest);
    const approvalProof = op?.approvalProof === undefined ? undefined : parseOfficeApprovalProof(op.approvalProof);
    const isApproval = op?.kind === 'recordOfficeApproval';
    const isRejection = op?.kind === 'recordOfficeRejection';
    // Flexible rev: first office decision is expectedRev=2, rev=3; later rounds follow the same +1 pattern.
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 ||
        !Number.isInteger(expectedRev) || expectedRev < 2 || rev !== expectedRev + 1 ||
        (!isApproval && !isRejection && op?.kind !== 'recordOfficeRevision') || typeof op.taskId !== 'string' || !UUID.test(op.taskId) ||
        typeof op.revisionId !== 'string' || !UUID.test(op.revisionId) ||
        typeof actionId !== 'string' || !UUID.test(actionId) ||
        body.key !== `${requestId}:${rev}:officeDecision:desk:${actionId}` ||
        !actor || typeof actor.userId !== 'string' || !UUID.test(actor.userId) ||
        typeof actor.role !== 'string' || actor.role.length > 60 ||
        typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 2000 ||
        (op.revisionRequest !== undefined && (!revisionRequest || revisionRequest.comment !== op.reason.trim())) ||
        (isApproval && (!approvalProof || revisionRequest || op.rejectionCategory !== undefined || !/^[a-f0-9]{64}$/.test(String(op.deskRequestFingerprint || '')))) ||
        (isRejection && (!parseRejectionCategory(op.rejectionCategory) || revisionRequest || op.revisionRequest !== undefined)) ||
        (!isApproval && (op.approvalProof !== undefined || op.deskRequestFingerprint !== undefined)) ||
        (!isRejection && op.rejectionCategory !== undefined)) {
      return problem(c, 400, 'Invalid office decision', 'Expected one versioned attributed review decision for the current draft');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleOfficeDecision(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string,
        revisionId: op.revisionId as string, actionId: actionId as string,
        actor: { userId: actor.userId as string, role: actor.role as string,
          ...(actor.authMethod === 'google_oidc' ? { authMethod: 'google_oidc' as const,
            sessionHash: actor.sessionHash as string } : {}) },
        reason: (op.reason as string).trim(), expectedRev, rev, key: body.key as string,
        ...(revisionRequest ? { revisionRequest } : {}),
        ...(isRejection ? { decision: 'rejected', rejectionCategory: parseRejectionCategory(op.rejectionCategory)! } : {}),
        ...(approvalProof ? { decision: 'approved', approvalProof,
          deskRequestFingerprint: op.deskRequestFingerprint as string } : {}),
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle office revision ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The office decision did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/delivery-start', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor)
      ? op.actor as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 3 ||
        rev !== expectedRev + 1 || op?.kind !== 'startDelivery' ||
        !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.revisionId || '')) ||
        !UUID.test(String(op.approvalId || '')) || !UUID.test(String(op.actionId || '')) ||
        body.key !== `${requestId}:${rev}:officeDecision:desk:${op.actionId}` ||
        !actor || !UUID.test(String(actor.userId || '')) || typeof actor.role !== 'string' ||
        typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 2000) {
      return problem(c, 400, 'Invalid delivery start', 'Expected one versioned request-owned delivery action');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDeliveryStart(db, ctx.deliverableStore, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string,
        revisionId: op.revisionId as string, approvalId: op.approvalId as string,
        actionId: op.actionId as string,
        actor: { userId: actor.userId as string, role: actor.role }, reason: op.reason.trim(),
        expectedRev, rev, key: body.key as string,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code,
        detail: error.message }, 409);
      log.error(`[core:internal] lifecycle delivery start ${requestId} failed:`, error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The delivery start did not commit; retry with the same key');
    }
  });

  // Requester sends their revision directive after the office marks "revise": manual → designing.
  // The worker must intake the new task first (lc-<requestId>-r<round> source event) and pass its id.
  internal('/lifecycle/:requestId/requester-revision', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    const round = Number(op?.round);
    if (!UUID.test(requestId) || body?.v !== 1 ||
        !Number.isInteger(expectedRev) || expectedRev < 3 || rev !== expectedRev + 1 ||
        op?.kind !== 'requesterRevision' ||
        !UUID.test(String(op.priorTaskId || '')) || !UUID.test(String(op.newTaskId || '')) ||
        !Number.isInteger(round) || round < 1 ||
        typeof op.directive !== 'string' || !String(op.directive).trim() || String(op.directive).length > 5000 ||
        body.key !== `${requestId}:${rev}:requesterRevision:r${round}`) {
      return problem(c, 400, 'Invalid requester revision', 'Expected one versioned requesterRevision for a manual-stage request');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleRequesterRevision(db, {
        requestId, tenantId: DEFAULT_TENANT_ID,
        priorTaskId: op.priorTaskId as string, newTaskId: op.newTaskId as string,
        round, directive: String(op.directive).trim(), expectedRev, rev, key: body.key as string,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle requester revision ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The requester revision did not commit; retry with the same key');
    }
  });

  // The Telegram intake projection has already committed rev N+1 and claimed the child task.
  // RequestLifecycle reads that exact receipt before starting DesignRun; it must not project again.
  internal('/lifecycle/:requestId/requester-revision-intake', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const updateId = Number(body?.updateId);
    const expectedRev = Number(body?.expectedRev);
    const round = Number(body?.round);
    const questionId = typeof body?.questionId === 'string' ? body.questionId : undefined;
    if (!UUID.test(requestId) || body?.v !== 1 ||
        !Number.isSafeInteger(updateId) || updateId <= 0 ||
        !Number.isInteger(expectedRev) || expectedRev < (questionId ? 2 : 3) ||
        !Number.isInteger(round) || round < 1 ||
        (questionId !== undefined && !UUID.test(questionId)) ||
        !UUID.test(String(body?.priorTaskId || '')) || !UUID.test(String(body?.newTaskId || '')) ||
        typeof body?.directive !== 'string' || !body.directive.trim() || body.directive.length > 5000) {
      return problem(c, 400, 'Invalid requester revision intake receipt',
        'Expected a versioned Telegram update and the exact admitted revision task');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle receipt requires a database');
    const result = await withRlsContext(db,
      { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
      (trx) => verifiedRevisionIntake(trx, { tenantId: DEFAULT_TENANT_ID, requestId,
        updateId, expectedRev, priorTaskId: body.priorTaskId as string,
        newTaskId: body.newTaskId as string, round, directive: body.directive as string,
        ...(questionId ? { questionId } : {}) }));
    if (!result) return problem(c, 409, 'Requester revision receipt mismatch',
      'The admitted update, request, revision and child task do not match');
    return c.json({ v: 1, ...result }, 200);
  });

  internal('/lifecycle/:requestId/delivery-finished', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const outcome = op?.outcome as DeliveryOutcome | undefined;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 4 ||
        rev !== expectedRev + 1 || op?.kind !== 'finishDelivery' ||
        !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.approvalId || '')) ||
        typeof op.deliveryId !== 'string' || !Number.isInteger(op.run) || Number(op.run) < 1 ||
        body.key !== `${requestId}:${rev}:deliveryFinished:${op.deliveryId}` ||
        !outcome || !['delivered', 'chat_only', 'uncertain', 'failed'].includes(outcome.outcome) ||
        !Array.isArray(outcome.uncertain) || outcome.uncertain.length > 50 ||
        outcome.uncertain.some((item) => typeof item !== 'string' || item.length > 500) ||
        typeof outcome.archived !== 'boolean' || typeof outcome.sheetsConfirmed !== 'boolean' ||
        !Number.isInteger(outcome.filesSent) || outcome.filesSent < 0 ||
        (outcome.reason !== undefined && (typeof outcome.reason !== 'string' || outcome.reason.length > 2000))) {
      return problem(c, 400, 'Invalid delivery result', 'Expected one versioned workflow outcome');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDeliveryFinish(db, { requestId, tenantId: DEFAULT_TENANT_ID,
        taskId: op.taskId as string, approvalId: op.approvalId as string,
        deliveryId: op.deliveryId as string, run: op.run as number, outcome,
        expectedRev, rev, key: body.key as string });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code,
        detail: error.message }, 409);
      log.error(`[core:internal] lifecycle delivery result ${requestId} failed:`, error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The delivery result did not commit; retry with the same key');
    }
  });
}
