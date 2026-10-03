import { isCustomerOpenCommand } from '@hawa/contracts';
import { customerWebOpenEvent, recordCustomerWebMessage } from '../customer/customer-web-lifecycle.js';
import {customerActionEvent,projectCustomerAction,acknowledgeCustomerAction,CustomerActionError} from '../customer/customer-actions.js';
import type {CustomerActionCommand,CustomerActionEvent,CustomerActionResult} from '@hawa/contracts';
import {isCustomerActionCommand,isCustomerActionEvent} from '@hawa/contracts';
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
import { SYSTEM_AUTOMATION_USER_ID, type BlobRef, type DeliveryOutcome } from '@hawa/contracts';
import { createLifecycleSourceIntake } from '../services/lifecycle-source-intake.js';
import { openDraft } from '../services/lifecycle-open-draft.js';
import { assertSourceIdentity, SourceConflict } from '../services/lifecycle-source-store.js';
import { MAX_REQUEST_DELIVERABLES, chooseWaitingChatRequest, parseCompleteRevisionRequest, parseOfficeApprovalProof, parseRejectionCategory } from '@hawa/domain';
import { planLifecycleBriefDeliverables } from '../services/lifecycle-brief-deliverables.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { createChatCampaignIntake } from '../services/chat-campaign-intake.js';
import { blobStoreFor } from '../services/blob-store-context.js';
import { burstPhotoCandidate, heldPhotoCandidate, lifecyclePhotoInput, retainLifecyclePhoto } from '../services/lifecycle-photo.js';
import { createMediaRoute, groupMediaNotAddressed, unusableMedia, wordsOf } from '../services/lifecycle-media-route.js';
import { deferMessage, pendingHeldBrief, readDeferral, releaseDeferral, overdueDeferrals, overduePhotos,
  claimPhoto, holdPhoto, markPhotoAsked, pendingEditWords, readHeldPhoto, readMediaAnswer, recordMediaAnswer,
  waitingPhotos } from '../services/lifecycle-media-intake.js';
import { createEditIntake } from '../services/lifecycle-edit-intake.js';
import { CLIENT_QUESTION_MESSAGES, INBOX_MESSAGES, INTAKE_LIMIT_MESSAGES, MEDIA_MESSAGES, ROUTING_MESSAGES, LIFECYCLE_MESSAGES, WITHDRAW_MESSAGES, bold, requesterLang, say } from '@hawa/integrations';
import { AlbumConflict, albumMessage, isAlbumConfirmation, readAlbumPart, partReply, assertAlbumSource,
  confirmAlbum, normalizedAlbumUpdate, retainAlbumPart, type AlbumSnapshot, type AlbumOutcome,
  albumSettleMs, bindTextToAlbum, briefPhotoWaitMs, heldBriefReplay, holdBrief, isHeldBrief, overdueSettles, settleAlbum,
  settleHeldBrief, cutAlbumWaits, actsInGroup, outsideBursts } from '../services/lifecycle-album.js';
import { classifyWithHeuristics } from '../services/telegram-classifier.js';
import { createTelegramUpdateState } from '../services/telegram-intake/update-state.js';
import { log } from '../logging.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { pauseRequesterDesign } from '../services/requester-hold.js';
import { acceptEarlyHold, EarlyHoldConflict } from '../services/early-requester-hold.js';
import { briefAnchorFor } from '../services/lifecycle-brief-anchor.js';
import { lateChangeOfficeAlert, lateChangeTargets, linkedLifecycleReplies, readNewBriefDecision, recordNewBriefDecision,
  readRevisionPhotoDecision, recordRevisionPhotoDecision,
  readRoutingRefusal, recordRoutingRefusal,
  revisionIntakeReceipts, verifiedRevisionIntake, waitingLifecycleRequests,
  type ClientChoice, type LateChangeStage, type LateRequesterChange, type WaitingLifecycleRequest } from '../services/lifecycle-chat-target.js';
import { parkTelegramUpdate, parkedUpdateChat } from '../services/polled-update-dispatch.js';
import { createLifecycleChatAnswers } from '../services/lifecycle-chat-answers.js';
import { activeChatRequests, openingChatRequests, pendingAskFor, readIntentReceipt, recordIntentReceipt, replyBindings,
  type IntentReceipt } from '../services/requester-turn-store.js';
import { askText, conflictOfficeAlert, designName, forwardOfficeAlert, forwardText, hasLetters, langOf, noteText, nothingToChangeText, planTurn, questionOfficeAlert,
  opensForAPerson, readIntentByRules, readsAsBriefContinuation, redoText, requestLabel, shortTitle, slowDesignOfficeAlert, slowDesigns, statusText, tellOfficeAlert,
  requesterName, spokenStage, whoWrote,
  tellText, thanksText, waitsForRequester,
  withoutBotMentions, keepsIt, parseChoice, type ChatRequestView, type IntentReading, type PendingAsk, type TurnPlan } from '../services/requester-turn.js';
import { spokenTitle } from '../services/request-title.js';
import { briefPartSeconds, briefParts, joinBriefPart, joinedWords, readBriefPart } from '../services/lifecycle-brief-parts.js';
import { officeChatFor, officeChatsFor, withOfficeAlerts } from '../services/office-chats.js';
import { WITHDRAWABLE_STAGES, nothingToCancelText, projectLifecycleWithdraw, recordWithdrawnOutcome, withdrawTooLateText, type WithdrawActor } from '../services/lifecycle-withdraw.js';
import { addPhotoMaterial, MATERIAL_STAGES, photoMaterialLine } from '../services/lifecycle-photo-material.js';
// ADR-250: words read as a brief that edit a design on the way.
import { reconsiderNewBrief } from '../services/brief-or-change.js';
import { createRequesterIntentModel, type RequesterIntentModel } from '../services/requester-intent-model.js';
import { LifecycleProjectionConflict, confirmLifecycleQuestionSent, projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen, projectLifecycleRequesterRevision, projectLifecycleRequesterRevisionWithIntake } from '../services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart, reconcileLifecycleChatOnlyDelivery } from '../services/lifecycle-delivery-projection.js';
import { projectLifecycleOfficeRetry } from '../services/lifecycle-office-retry.js';
import { chatAutoDraftsEnabled, type ChatIntake } from '../services/chat-intake.js';
import type { RouteContext } from './types.js';
import { parseNativeReviewSubmission } from '@hawa/domain';
import { projectLifecycleNativeReview } from '../services/lifecycle-native-review.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';
import { officeTelegramTurn } from '../services/office-telegram-turn.js';
import { createOfficeIntentModel, type OfficeIntentModel } from '../services/office-intent-model.js';
import { createCopyExtractionModel, extractRequestCopy, type CopyExtractionModel } from '../services/request-copy-extraction.js';
import { CLIENT_QUESTION_MS, CLIENT_QUESTION_RULES, answeredUpdateOf, clientName, clientQuestionTimeout, knownClientNames,
  overdueClientQuestions, pendingClientQuestion, readClientAnswer, readClientResolution, recordClientQuestion, resolveClientQuestion,
  saysDontKnow, timedOutClientQuestion, type ClientQuestion, bareOrganisationName, clientQuestionNotes, deadlineWords, keepClientQuestionNote,
  recentNamedOrganisation, recordNamedOrganisation, withClientQuestionNotes, type ClientQuestionNote } from '../services/lifecycle-client-question.js';
import { plainClientAnswer, resolveSourceClient } from '../services/lifecycle-source-natural.js';

/** /v1/internal/*, under any of the prefixes registerRoute mounts routes at. */
export function isInternalPath(path: string): boolean {
  return /^\/(?:api\/)?(?:v1\/)?internal(?:\/|$)/.test(path);
}

// The worker credential rules live in services/worker-credential.ts (ADR-129: services sign with it too).
export { acceptedServiceTokensOf, serviceTokenOf, workerSigningSecretOf } from '../services/worker-credential.js';

interface UpdateLike { update_id: number; [kind: string]: unknown }

const byRequest = (requests: ChatRequestView[], id: string) => requests.find((r) => r.requestId === id);
/** ADR-255: stages a cancel of several designs can still concern (a too-late one is told so, as any cancel is). */
const OPEN_LIFECYCLE_STAGES: readonly string[] = ['designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering'];

/** A Telegram document that is an SVG file (by its declared type or its name). */
function isSvgDocument(document: unknown): boolean {
  if (!document || typeof document !== 'object') return false;
  const doc = document as Record<string, unknown>;
  return /^image\/svg(?:\+xml)?$/i.test(String(doc.mime_type ?? '').trim()) || /\.svgz?$/i.test(String(doc.file_name ?? '').trim());
}

/** The chat an update came from, for the chaos suite's point (the dead letter's own reading). */
const chatOf = (u: UpdateLike): string => parkedUpdateChat(u) ?? '';

const isUpdate = (u: unknown): u is UpdateLike =>
  Boolean(u) && typeof u === 'object' && Number.isSafeInteger((u as UpdateLike).update_id) && (u as UpdateLike).update_id > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The answer for a requester's words that reached a request after its design went to the office
 * (finding 13 of the Phase 4 review). The same stored change always gives the same answer.
 */
function lateChangeAnswer(chatId: string, late: LateRequesterChange, update: UpdateLike): Record<string, unknown> {
  // ADR-231: the office's alert names the requester; the update is the same on a replay, so is the alert.
  const officeAlert = lateChangeOfficeAlert(late, chatId, officeChatFor(chatId), requesterName(fromOf(update)));
  return { code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change', chatId,
    requestId: late.requestId, requestStage: late.requestStage, ...(officeAlert ? { officeAlert } : {}),
    // ADR-144: what the requester is told comes from Core, in their language, and replays as it was.
    ...(late.answer ? { chatAnswer: { text: late.answer, parseMode: 'HTML' } } : {}) };
}

/** ADR-231: the Telegram sender of an update (its `from`), for naming the requester to the office. */
const fromOf = (u: UpdateLike): unknown =>
  ((u.message ?? u.edited_message ?? u.channel_post) as Record<string, unknown> | undefined)?.from;
/** ADR-231: the subject of an office alert about this update: the requester's name, else "A requester". */
const whoSent = (u: UpdateLike): string => whoWrote(requesterName(fromOf(u)));

/** Who sent a message, in which chat and topic: the scope a kept photo or a deferred message belongs to. */
function senderScopeOf(update: UpdateLike): { chatId: string; senderId: string; topic: string } | null {
  const message = update.message && typeof update.message === 'object' ? update.message as Record<string, any> : null;
  const sender = message?.from?.id;
  if (!message || !Number.isSafeInteger(sender) || message.from?.is_bot === true) return null;
  return { chatId: String(message.chat?.id ?? ''), senderId: String(sender),
    topic: message.message_thread_id === undefined ? '' : String(message.message_thread_id) };
}
const updateHash = (update: unknown) => createHash('sha256').update(JSON.stringify(update)).digest('hex');
const SYSTEM_SCOPE = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };

/**
 * The office's alert for a change or answer the bot could not apply by itself (the day's automatic
 * allowance is used up, or the question or original brief cannot be found): the requester is told the
 * office has it (ADR-145), so the office must, with the words quoted. Null without an office chat.
 */
function revisionBlockedAlert(chatId: string, code: string, update: UpdateLike): { chatId: string; text: string } | null {
  const office = officeChatFor(chatId);
  if (!office || office === chatId || !['DAILY_CAP_REACHED', 'PARENT_BRIEF_MISSING', 'QUESTION_MISSING'].includes(code)) return null;
  const message = update.message && typeof update.message === 'object' ? update.message as Record<string, unknown> : null;
  const words = String(message?.text ?? message?.caption ?? '').trim();
  const why = code === 'DAILY_CAP_REACHED' ? 'the automatic design allowance for today is used up'
    : code === 'QUESTION_MISSING' ? 'the question it answers could not be found' : 'the original brief could not be found';
  return { chatId: office, text: [`${whoSent(update)} sent a change or answer that was not applied, because ${why}.`,
    'Nothing was started. Please make the change and send the design to them; they were told the office has it.',
    '', 'Their words:', (words.length > 1500 ? `${words.slice(0, 1500)}…` : words) || '(a photo or file, in the chat)'].join('\n') };
}


/**
 * Conversation fuzz (2026-10-03): the name of a brief kept for the "who is it for?" answer, as the requester would say
 * it: its event ("Nawroz Celebration") in English, else "your design" in their language (`title`: at a sentence's start).
 */
function keptBriefName(words: string, lang: 'en' | 'ckb', title = false): string {
  const line = String(words).split(/\n/).find((l) => l.trim()) ?? '';
  const name = lang === 'en' ? spokenTitle(line).trim() : '';
  if (name && Array.from(name).length <= 60 && !/[?!]/.test(name)) return name;
  const yours = say(LIFECYCLE_MESSAGES.yourDesign, lang);
  return title && lang === 'en' ? yours.charAt(0).toUpperCase() + yours.slice(1) : yours;
}

export function registerLifecycleInternalRoutes(ctx: RouteContext): void {
  const { app, db, problem, verifyRequestAuth, channelKillSwitches } = ctx;
  const sourceIntake = createLifecycleSourceIntake(ctx);
  const chatAnswers = createLifecycleChatAnswers(ctx);
  // ADR-145: photos with no words, videos, files, edits and senders outside the intake list.
  const mediaRoute = createMediaRoute(ctx);
  const edits = createEditIntake(ctx);
  // ADR-144: the intake router, asked only about what the rules cannot place. Tests pass their own.
  const intentModel: RequesterIntentModel | null = ctx.options?.requesterIntentModel !== undefined
    ? ctx.options.requesterIntentModel : (db ? createRequesterIntentModel(db) : null);
  // ADR-200: the same router reads an office member's words when the office turn's rules are not certain.
  const officeModel: OfficeIntentModel | null = ctx.options?.officeIntentModel !== undefined ? ctx.options.officeIntentModel
    : ctx.options?.requesterIntentModel === null ? null : (db ? createOfficeIntentModel(db) : null);
  // ADR-232: the copy of a request written as a sentence, chosen once per update through the same ledger.
  const copyModel: CopyExtractionModel | null = ctx.options?.copyExtractionModel !== undefined ? ctx.options.copyExtractionModel
    : ctx.options?.requesterIntentModel === null ? null : (db ? createCopyExtractionModel(db) : null);

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

  const intakeHandler = async (c: Context): Promise<Response> => {
    const body = await readBody(c);
    const incoming = body?.update;
    if (!isUpdate(incoming)) return problem(c, 400, 'Invalid update', 'The body must carry a Telegram update with a positive update_id');
    let preparedUpdate: UpdateLike = incoming;
    // ChatInbox sends `legacy` for a chat's first update and `lifecycle` after that. Since ADR-135
    // every chat is lifecycle-owned and both are handled alike; unknown modes are refused explicitly.
    const mode = body?.mode ?? 'legacy';
    // The worker opens every request an answer names (ADR-139); an older worker opened only the first.
    const acceptsLanguageSiblings = body?.languageSiblings === true;
    const deliverableCapacity = Number.isInteger(body?.maxDeliverables) && Number(body?.maxDeliverables) >= 1 &&
      Number(body?.maxDeliverables) <= MAX_REQUEST_DELIVERABLES ? Number(body?.maxDeliverables) : acceptsLanguageSiblings ? 2 : 1;
    // ADR-143: `settle` is the worker's delayed settle of this (already saved) update; `briefHold`
    // says the worker schedules settles, so a text brief may wait for photos sent right after it.
    let settle = body?.settle === true;
    const holdBriefs = body?.briefHold === true;
    // ADR-145: a message set behind its sender's held brief, now read as it arrived (never held again).
    let releasedDeferral = false;
    // ADR-145: words said beside the answer (a video's words were used; a file could not be opened).
    let beside: { text: string; parseMode: 'HTML' } | null = null;
    // ADR-235: the key ChatInbox sends `beside` under, when it must not be the update's usual notice key.
    let besideKey: string | null = null;
    // ADR-235: the settle of a kept brief whose question nobody answered: it opens for the office.
    let clientTimeout: ClientQuestion | null = null;
    if (mode !== 'legacy' && mode !== 'lifecycle') {
      return problem(c, 400, 'Unknown intake mode', `This Core runs intake in mode "legacy" or "lifecycle", not "${String(mode)}"`);
    }

    const handled = (intakeStatus: number, extra: Record<string, unknown> = {}) =>
      // ADR-155 section 6: an office alert reaches every office member, not only the first (office-chats.ts).
      c.json({ v: 1, kind: 'handled', intakeStatus, ...withOfficeAlerts(extra),
        ...(beside && !extra.notice ? { notice: beside, ...(besideKey ? { noticeKey: besideKey } : {}) } : {}) }, 200);

    const senderAllowedFor = (u: UpdateLike): boolean => {
      const carrier = (u.message ?? u.edited_message ?? u.channel_post) as Record<string, any> | undefined;
      const senderId = String(carrier?.from?.id ?? '');
      return !ctx.isProduction || ctx.telegramIntakeUsers.includes('*') || process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*' ||
        (ctx.telegramIntakeUsers.length > 0 && ctx.telegramIntakeUsers.includes(senderId));
    };
    /** Keeps words on a request for the office (the late-change store) under this update, once (ADR-145). */
    const recordLate = async (u: UpdateLike, late: LateRequesterChange): Promise<{ status: number; extra: Record<string, unknown> }> => {
      const chatId = chatOf(u);
      const payloadHash = updateHash(u);
      const stored = await withRlsContext(db!, SYSTEM_SCOPE, (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, u.update_id,
        { code: 'LATE_REQUESTER_CHANGE', chatId, payloadHash, late }));
      if (stored.payloadHash !== payloadHash || stored.chatId !== chatId || stored.code !== 'LATE_REQUESTER_CHANGE' || !stored.late) {
        return { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } };
      }
      return { status: 409, extra: lateChangeAnswer(chatId, stored.late, u) };
    };

    /**
     * ADR-156 (audit P3): an SVG logo or graphic goes to the office: kept as a note on the sender's one
     * open design (the late-change store, so Deliver waits for someone to read it), else passed on as
     * words about no current design. Answered once; a replay gives the same answer.
     */
    const svgToOffice = async (u: UpdateLike, chatId: string, senderId: string, message: Record<string, unknown>): Promise<Response> => {
      const doc = message.document as Record<string, unknown>;
      const name = typeof doc?.file_name === 'string' && doc.file_name.trim() ? doc.file_name.trim().slice(0, 120) : 'logo.svg';
      const caption = typeof message.caption === 'string' ? message.caption.trim() : '';
      const lang = caption ? requesterLang(caption)
        : await withRlsContext(db!, SYSTEM_SCOPE, (trx) => mediaRoute.langFor(trx, chatId, message));
      const words = `${caption || '(no words)'}\n[The requester sent a logo or graphic as an SVG file ("${name}"). It is in the Telegram chat; the bot cannot place SVG files, so please add it to the design.]`;
      const requests = await withRlsContext(db!, SYSTEM_SCOPE, (trx) => activeChatRequests(trx, DEFAULT_TENANT_ID, chatId));
      const open = requests.filter((r) => ['designing', 'manual', 'awaiting_answer', 'in_review', 'approved'].includes(r.stage) &&
        (!r.requesterId || r.requesterId === senderId || ctx.telegramAllowedUsers.includes(senderId)));
      if (open.length === 1) {
        const target = open[0];
        const kept = await recordLate(u, { requestId: target.requestId, taskId: target.currentTaskId, requestRev: target.rev,
          requestStage: target.stage as LateChangeStage, text: words, kind: 'change', title: shortTitle(target.title),
          answer: say(MEDIA_MESSAGES.svgPassedForDesign, lang, { title: designName(target.title, lang) }) });
        return handled(kept.status, kept.extra);
      }
      const office = officeChatFor(chatId);
      const alerted = Boolean(office && office !== chatId);
      const answer = { status: 200, extra: { lifecycleAction: 'chat-answer', chatId, media: 'svg',
        chatAnswer: { text: say(alerted ? MEDIA_MESSAGES.svgPassed : MEDIA_MESSAGES.svgKept, lang), parseMode: 'HTML' },
        ...(alerted ? { officeAlert: { chatId: office!, text: [`${whoSent(u)} sent a logo or graphic as an SVG file ("${name}"), which the bot cannot place, and has no single open design to add it to. It is in the Telegram chat.`,
          '', 'Their words:', caption || '(no words)'].join('\n') } } : {}) } };
      const stored = await withRlsContext(db!, SYSTEM_SCOPE, (trx) => recordMediaAnswer(trx, DEFAULT_TENANT_ID, u.update_id, updateHash(u), answer));
      return handled(stored.status, stored.extra);
    };

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
      // ADR-040 addendum: an office member approving, sending back or rejecting a draft in their private
      // chat, in plain words, through the Desk's own actions. Anything else of theirs is read below.
      if (!settle) {
        const office = await officeTelegramTurn({ db, deliverableStore: ctx.deliverableStore, tenantId: DEFAULT_TENANT_ID,
          model: officeModel }, incoming);
        if (office) return handled(office.status, office.extra);
      }
    }

    let admittedAlbum: AlbumSnapshot | undefined;
    // A retained burst photo, either settled alone or joined to the rest of a cut caption.
    let boundPhoto: BlobRef | undefined;
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
    const incomingMessage = (preparedUpdate.message && typeof preparedUpdate.message === 'object'
      ? preparedUpdate.message : null) as Record<string, unknown> | null;
    // A `/use_album` reply to a photo keeps its old meaning; a plain one binds like any text (ADR-143).
    const repliedConfirmation = isAlbumConfirmation(preparedUpdate) && Boolean(incomingMessage?.reply_to_message);
    const textMessage = !albumPart && !repliedConfirmation && typeof incomingMessage?.text === 'string';
    // ADR-235: the settle ChatInbox scheduled for a kept brief's question (or the sweep sent again). Not yet
    // due, or answered: nothing. Due: the brief is read again below and opens for the office to choose,
    // as "not sure" does, and its sender hears it once. A replay of a timeout that won opens nothing new.
    if (settle && textMessage && db) {
      const due = await withRlsContext(db, SYSTEM_SCOPE, (trx) => clientQuestionTimeout(trx, DEFAULT_TENANT_ID, preparedUpdate.update_id));
      if (due?.kind === 'skip') return handled(200, { settle: 'skipped' });
      if (due?.kind === 'open') {
        clientTimeout = due.question;
        settle = false;
        releasedDeferral = true;
        // ADR-284 addendum (live canary 2026-10-03): once the kept brief has opened, its request's first answer said
        // it (with "a designer will make …"); the notice stays only for a brief that does not open after all.
        const openedAlready = await withRlsContext(db, SYSTEM_SCOPE, (trx) => readNewBriefDecision(trx, DEFAULT_TENANT_ID, preparedUpdate.update_id));
        if (!openedAlready) {
          beside = { text: say(CLIENT_QUESTION_MESSAGES.timedOutToOffice, requesterLang(due.question.words)), parseMode: 'HTML' };
          besideKey = `client-question:${due.question.briefUpdateId}`;
        }
      }
    }
    // ADR-145: the settle of a message set behind its sender's held brief. While that brief is still
    // held it waits again; once the brief has opened, the message is read as it arrived.
    if (settle && textMessage && db) {
      const deferral = await withRlsContext(db, SYSTEM_SCOPE, (trx) => readDeferral(trx, DEFAULT_TENANT_ID, preparedUpdate.update_id));
      if (deferral) {
        if (!deferral.released) {
          const scope = senderScopeOf(preparedUpdate);
          const held = scope && await withRlsContext(db, SYSTEM_SCOPE, (trx) =>
            pendingHeldBrief(trx, DEFAULT_TENANT_ID, scope, preparedUpdate.update_id));
          if (held) return handled(202, { lifecycleAction: 'settle-later', chatId: chatOf(preparedUpdate),
            settle: { kind: 'brief', delayMs: albumSettleMs() } });
          await withRlsContext(db, SYSTEM_SCOPE, (trx) => releaseDeferral(trx, DEFAULT_TENANT_ID, preparedUpdate.update_id));
        }
        settle = false;
        releasedDeferral = true;
      }
    }
    // ADR-160 addendum: a photo outside an album, with or without words, is kept as a member of a photo
    // burst while the worker schedules settles (`briefHold`), and settles as an album does: the photos its
    // sender sent within the album quiet period are one set. A captioned photo in a group that does not
    // act stays a passive message (below). Its settle is the burst's, whatever its words.
    const burst = !albumPart && db ? burstPhotoCandidate(preparedUpdate) : null;
    const burstPart = !settle && holdBriefs && burst !== null && (!burst.captioned || actsInGroup(incomingMessage));
    const burstSettle = settle && burst !== null && Boolean(await withRlsContext(db!, SYSTEM_SCOPE,
      (trx) => readAlbumPart(trx, DEFAULT_TENANT_ID, preparedUpdate)));
    // A kept photo's settle (ADR-145) is decided below; any other settle of a non-album, non-text
    // update has nothing to do.
    if (settle && !albumPart && !burstSettle && !textMessage && !heldPhotoCandidate(preparedUpdate)) return handled(200, { settle: 'skipped' });
    // ADR-160: a photo with words may be the rest of a caption Telegram cut (bound below if a cut album waits).
    const restPhoto = !albumPart && !settle && Boolean(db) && lifecyclePhotoInput(preparedUpdate)?.captionless === false;
    if (albumPart || repliedConfirmation || (textMessage && (db || settle)) || restPhoto || burstPart || burstSettle) {
      if (!db) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
      const tx = <T>(fn: (trx: import('@hawa/db').Kysely<import('@hawa/db').Database>) => Promise<T>) =>
        withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
      const source = preparedUpdate;
      const chatId = chatOf(source);
      const msg = source.message as Record<string, unknown>;
      const senderId = String((msg.from as { id?: unknown } | undefined)?.id ?? '');
      const senderAllowed = !ctx.isProduction || ctx.telegramIntakeUsers.includes('*') ||
        process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*' || ctx.telegramIntakeUsers.includes(senderId);
      // The worker schedules this update's settle (a durable delayed call) instead of sending anything.
      const settleLater = (kind: 'album' | 'brief' | 'photo', delayMs: number) =>
        handled(202, { lifecycleAction: 'settle-later', chatId, settle: { kind, delayMs } });
      const reply = (answer: { status: number; message: string; noticeKey: string; settle?: true }, kind: 'album' | 'photo' = 'album') => answer.settle
        ? settleLater(kind, albumSettleMs())
        : handled(answer.status, { lifecycleAction: 'album-message', chatId,
          albumMessage: answer.message, albumNoticeKey: answer.noticeKey });
      const admit = async (outcome: AlbumOutcome, point: string): Promise<Response | null> => {
        if (outcome.kind === 'reply') return reply(outcome.reply);
        if (outcome.kind === 'skip' || outcome.kind === 'alone') return handled(200, { settle: 'skipped' });
        // ADR-160 addendum: a photo burst sent right after its sender's brief became that design's material.
        if (outcome.kind === 'answer') return handled(200, { lifecycleAction: 'chat-answer', chatId,
          chatAnswer: { text: outcome.text, parseMode: 'HTML' }, media: 'photos-joined' });
        if (outcome.kind === 'late') {
          const kept = await recordLate(source, outcome.change);
          return handled(kept.status, kept.extra);
        }
        if (outcome.kind === 'photo') {
          boundPhoto = outcome.image;
          preparedUpdate = outcome.update;
          await chaosPoint(point, { updateId: source.update_id, chat: chatId });
          return null;
        }
        // ADR-160: the album waits for the rest of a caption Telegram cut; the question is said beside it.
        if (outcome.kind === 'wait') return handled(202, { lifecycleAction: 'settle-later', chatId,
          settle: { kind: 'album', delayMs: outcome.delayMs }, ...(outcome.notice ? { notice: { text: outcome.notice } } : {}) });
        if (outcome.kind === 'none') return null;
        admittedAlbum = outcome.snapshot;
        preparedUpdate = normalizedAlbumUpdate(admittedAlbum);
        await chaosPoint(point, { updateId: source.update_id, chat: chatId });
        return null;
      };
      const albumDeps = (trx: import('@hawa/db').Kysely<import('@hawa/db').Database>) => ({
        linkedReply: async (chat: string, replyId: string) => (await linkedLifecycleReplies(trx, DEFAULT_TENANT_ID, chat, replyId)).length > 0 ||
          (await lateChangeTargets(trx, DEFAULT_TENANT_ID, chat, replyId)).length > 0,
        decided: async (chat: string, updateId: number) => Boolean(await readNewBriefDecision(trx, DEFAULT_TENANT_ID, updateId) ||
          await readRoutingRefusal(trx, DEFAULT_TENANT_ID, updateId) ||
          await readRevisionPhotoDecision(trx, DEFAULT_TENANT_ID, updateId)) ||
          (await revisionIntakeReceipts(trx, DEFAULT_TENANT_ID, chat, updateId)).length > 0,
      });
      try {
        if ((albumPart || burstSettle) && settle) {
          if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
          const outcome = await tx((trx) => settleAlbum(trx, DEFAULT_TENANT_ID, source));
          if (outcome.kind === 'alone') {
            // A burst of one photo is read as ADR-145 reads a lone photo: a photo with words as it arrived
            // (now, after the quiet period), a kept photo with no words by its own settle below.
            if (burst?.captioned) {
              boundPhoto = outcome.image;
              settle = false;
            }
          } else {
            const settled = await admit(outcome, 'core.intake.after-album-settle');
            if (settled) return settled;
          }
        } else if (textMessage) {
          // ADR-235: a kept brief's timeout is read below as the brief; it is no held brief or album words.
          const heldReplay = settle || clientTimeout ? 'none' : await tx((trx) => heldBriefReplay(trx, DEFAULT_TENANT_ID, source));
          if (clientTimeout) {
            // Nothing here.
          } else if (settle) {
            const held = await tx((trx) => settleHeldBrief(trx, DEFAULT_TENANT_ID, source));
            if (held === 'skip') return handled(200, { settle: 'skipped' });
            if (held === 'wait') return settleLater('brief', albumSettleMs());
            // `release`: intake decides the brief below as it decides any brief, now without a hold.
          } else if (heldReplay !== 'none') {
            // A replay of a held brief: still waiting, taken by an album, or decided (replayed below).
            if (heldReplay === 'held') return settleLater('brief', briefPhotoWaitMs());
            if (heldReplay === 'consumed') return handled(200, { duplicate: true, settle: 'skipped' });
          } else if (senderAllowed) {
            const bound = await admit(await tx((trx) => bindTextToAlbum(trx, DEFAULT_TENANT_ID, source, albumDeps(trx))),
              'core.intake.after-album-confirmation');
            if (bound) return bound;
          }
        } else if (restPhoto || burstPart) {
          // ADR-160: the rest sent as a photo with words: its words join the cut caption, its picture the album.
          if (restPhoto && senderAllowed && await tx((trx) => cutAlbumWaits(trx, DEFAULT_TENANT_ID, source))) {
            const photo = lifecyclePhotoInput(source)!;
            const kept = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
              (id) => ctx.telegramBridge?.downloadFile(id) ?? Promise.resolve(null), photo.fileId);
            if (kept.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
            if (kept.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
            if (kept.kind === 'stored') {
              const bound = await admit(await tx((trx) => bindTextToAlbum(trx, DEFAULT_TENANT_ID, source, albumDeps(trx),
                { words: photo.directive, image: kept.ref })), 'core.intake.after-album-confirmation');
              if (bound) return bound;
            }
          }
          if (burstPart && !admittedAlbum && !boundPhoto) {
            // ADR-160 addendum: kept as a photo of a burst; nothing is said until the burst settles.
            if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
            const keepForWords = async () => {
              // A photo with no words is also kept as ADR-145 keeps it, so words sent right after a lone
              // photo take it as before (a burst's settle claims it for its set).
              const part = await tx((trx) => readAlbumPart(trx, DEFAULT_TENANT_ID, source));
              if (burst!.captioned || !part?.image) return;
              await tx((trx) => holdPhoto(trx, DEFAULT_TENANT_ID, { updateId: source.update_id, chatId, senderId: part.senderId,
                topic: part.topic, messageId: part.messageId, image: part.image! }, updateHash(source), source));
            };
            const priorPart = await tx((trx) => readAlbumPart(trx, DEFAULT_TENANT_ID, source));
            if (priorPart) {
              await keepForWords();
              return reply(partReply(priorPart), 'photo');
            }
            const old = await createTelegramUpdateState(ctx).telegramUpdateHandled(chatId, String(source.update_id));
            if (old) return handled(200, { duplicate: true, ...(old.taskId ? { taskIds: [old.taskId] } : {}) });
            const kept = await retainAlbumPart(tx, DEFAULT_TENANT_ID, source, blobStoreFor(db, ctx.options?.blobStore),
              (id) => ctx.telegramBridge?.downloadFile(id) ?? Promise.resolve(null), { burst: true });
            await keepForWords();
            return reply(kept, 'photo');
          }
        } else if (albumPart) {
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

    // ADR-185: a clear hold must commit before brief settlement can admit the first paid call.
    if (db && !settle && !admittedAlbum && !boundPhoto &&
        typeof (preparedUpdate.message as Record<string, unknown> | undefined)?.text === 'string' && senderAllowedFor(preparedUpdate)) {
      const words = withoutBotMentions(String((preparedUpdate.message as Record<string, unknown>).text));
      try {
        const early = await withRlsContext(db, SYSTEM_SCOPE, trx=>acceptEarlyHold(trx, DEFAULT_TENANT_ID, {
          update:preparedUpdate,text:words,payloadHash:updateHash(preparedUpdate),isHold:readIntentByRules(words).intent==='hold',
          answer:say(ROUTING_MESSAGES.holdConfirmed,requesterLang(words),{title:say(LIFECYCLE_MESSAGES.yourDesign,requesterLang(words))}),
        }));
        if (early) return handled(200, { chatAnswer:{text:early.answer,parseMode:'HTML'}, earlyHold:true, chatId:early.anchor.chatId,
          ...(early.officeAlerts ? {officeAlerts:early.officeAlerts} : {}) });
      } catch (error) {
        if (error instanceof EarlyHoldConflict) return handled(409,{code:'IDEMPOTENCY_CONFLICT'});
        throw error;
      }
    }

    // ADR-145: a message from a sender whose brief ADR-143 still holds for photos is read after that
    // brief opens, so a correction to it is a change to it and not a second request. ChatInbox runs one
    // update of a chat at a time, and the brief's own settle queues behind this update: the message is
    // therefore settled later instead of being made to wait here.
    if (db && !settle && !releasedDeferral && !admittedAlbum && !boundPhoto && typeof (preparedUpdate.message as Record<string, unknown> | undefined)?.text === 'string') {
      const source = preparedUpdate;
      const scope = senderScopeOf(source);
      const hash = updateHash(source);
      const outcome = await withRlsContext(db, SYSTEM_SCOPE, async (trx) => {
        // ADR-156 (audit #10): the rest of a long message Telegram split, or a forward sent with others,
        // joined to its sender's held brief; a replay says the same.
        const part = await readBriefPart(trx, DEFAULT_TENANT_ID, source.update_id);
        if (part) return part.payloadHash === hash ? 'joined' as const : 'conflict' as const;
        const prior = await readDeferral(trx, DEFAULT_TENANT_ID, source.update_id);
        if (prior && prior.payloadHash !== hash) return 'conflict' as const;
        if (prior?.released) return 'released' as const;
        if (!prior && (await isHeldBrief(trx, DEFAULT_TENANT_ID, source) ||
            await readNewBriefDecision(trx, DEFAULT_TENANT_ID, source.update_id) ||
            await readIntentReceipt(trx, DEFAULT_TENANT_ID, source.update_id) ||
            await readRoutingRefusal(trx, DEFAULT_TENANT_ID, source.update_id))) return 'decided' as const;
        const held = scope ? await pendingHeldBrief(trx, DEFAULT_TENANT_ID, scope, source.update_id) : null;
        if (!held) {
          if (!prior) return 'none' as const;
          await releaseDeferral(trx, DEFAULT_TENANT_ID, source.update_id);
          return 'released' as const;
        }
        // ADR-182: a brief typed as several messages, a line of style or a forward sent right after it.
        const typed = { windowSeconds: Math.max(briefPartSeconds(), Math.round(briefPhotoWaitMs() / 1000)),
          continues: (words: string, soFar: string) => readsAsBriefContinuation(withoutBotMentions(words), withoutBotMentions(soFar)) };
        if (!prior && await joinBriefPart(trx, DEFAULT_TENANT_ID, source, held.updateId, hash, typed)) return 'joined' as const;
        if (!prior) await deferMessage(trx, DEFAULT_TENANT_ID, source.update_id, scope!, held.updateId, hash, source);
        return 'deferred' as const;
      });
      if (outcome === 'conflict') return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
      // Nothing is said for a joined part: the brief it belongs to is answered when it opens.
      if (outcome === 'joined') return handled(200, { briefPart: true, chatId: chatOf(source) });
      if (outcome === 'deferred') return handled(202, { lifecycleAction: 'settle-later', chatId: chatOf(source),
        settle: { kind: 'brief', delayMs: albumSettleMs() } });
      if (outcome === 'released') releasedDeferral = true;
    }

    // ADR-182: an edited message read again as a new one: thanks corrected into other thanks says nothing.
    let rereadEdit = false;
    // ADR-145: an edited message or caption. Words still held (a kept photo, a voice note or PDF not yet
    // used) take the new words; words that opened or changed a design become a note to the office on it;
    // words that opened nothing are read again as a new message; an edit to anything else goes to the office.
    if (db && preparedUpdate.edited_message && !preparedUpdate.message) {
      const edited = await edits.handle(preparedUpdate, {
        senderAllowed: senderAllowedFor(preparedUpdate),
        recordLate: (late) => recordLate(preparedUpdate, late),
        officeChatId: officeChatFor(chatOf(preparedUpdate)),
      });
      if (edited.kind === 'answer') return handled(edited.answer.status, edited.answer.extra);
      if (edited.kind === 'reread') {
        preparedUpdate = edited.update;
        rereadEdit = true;
      }
    }

    let update = preparedUpdate;
    // An album admitted above or a released held brief is decided now, not held again.
    let mayHoldBrief = holdBriefs && !settle && !releasedDeferral && !admittedAlbum && !boundPhoto && briefPhotoWaitMs() > 0;

    // A decision must replay even if the flag changed after the first answer was lost.
    const sourceChat = chatOf(update);
    let priorRefusal: Awaited<ReturnType<typeof readRoutingRefusal>> = null;
    let priorRevisionPhoto: Awaited<ReturnType<typeof readRevisionPhotoDecision>> = null;
    let priorIntent: IntentReceipt | null = null;
    if (db && sourceChat) {
      try {
        const prior = await withRlsContext(db,
          { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
          async (trx) => ({
            open: await readNewBriefDecision(trx, DEFAULT_TENANT_ID, update.update_id),
            refusal: await readRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id),
            revisionPhoto: await readRevisionPhotoDecision(trx, DEFAULT_TENANT_ID, update.update_id),
            intent: await readIntentReceipt(trx, DEFAULT_TENANT_ID, update.update_id),
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
          if (1 + (prior.open.siblings?.length ?? 0) > deliverableCapacity) {
            return handled(503, { code: 'LANGUAGE_SIBLINGS_UNSUPPORTED' });
          }
          return handled(200, { duplicate: true, lifecycleAction: 'open-request',
            requestId: prior.open.requestId, chatId: sourceChat, draft: prior.open.draft,
            ...(prior.open.siblings?.length ? { siblings: prior.open.siblings } : {}),
            ...(prior.open.deliverableCount ? {deliverableCount:prior.open.deliverableCount} : {}) });
        }
        // ADR-144: a message's intent is decided once. An answer recorded with the decision (thanks,
        // a status, a question, a note passed to the office) is given again word for word.
        priorIntent = prior.intent;
        if (priorIntent) {
          const hash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
          if (priorIntent.payloadHash !== hash || priorIntent.chatId !== sourceChat) {
            return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
          }
          if (priorIntent.answer) {
            // A late change replays exactly as it was answered (finding 13); other answers say they repeat.
            const extra = priorIntent.answer.extra;
            return handled(priorIntent.answer.status, extra.lifecycleAction === 'late-change' ? extra : { ...extra, duplicate: true });
          }
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
        return handled(409, lateChangeAnswer(sourceChat, priorRefusal.late, update));
      }
      const blocked = priorRefusal.code !== 'AMBIGUOUS_REQUEST' && priorRefusal.code !== 'STALE_REQUEST_REPLY';
      const alert = blocked ? revisionBlockedAlert(sourceChat, priorRefusal.code, update) : null;
      return handled(409, { code: priorRefusal.code,
        lifecycleAction: blocked ? 'revision-blocked' : 'request-choice-required',
        chatId: sourceChat, ...(alert ? { officeAlert: alert } : {}) });
    }

    // ADR-145: words said about this update's media (a picture that could not be opened, a video, a kept
    // photo's question, an edit) are given again as they were, before anything is downloaded again.
    if (db && !settle) {
      const said = await withRlsContext(db, SYSTEM_SCOPE, (trx) => readMediaAnswer(trx, DEFAULT_TENANT_ID, update.update_id));
      if (said) {
        if (said.payloadHash !== updateHash(update) && !said.payloadHash.startsWith('settle:')) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
        return handled(said.status, { ...said.extra, duplicate: true });
      }
    }

    // ADR-144 §2.7 (ADR-160): in a group, a member's media is read only when addressed to the bot; it is
    // kept as a passive message, as group conversation is (lifecycle-chat-answers.ts, a group PDF).
    if (!settle && groupMediaNotAddressed(update)) return handled(200, { status: 'MESSAGE_ONLY' });
    // An admitted album's words were bound to its photos: they answer no voice note or PDF (a replay of
    // one that completed a cut caption, below, is admitted above by its recorded album decision).
    const sourceAnswer = admittedAlbum || boundPhoto ? null : await sourceIntake(update);
    if (sourceAnswer && 'album' in sourceAnswer) {
      // ADR-160 F8 (the remainder): a voice note's or a PDF's confirmed words completed a cut caption;
      // the album is read now as an album bound by typed words is.
      const { album } = sourceAnswer;
      if (album.kind === 'reply') return handled(album.reply.status, { lifecycleAction: 'album-message', chatId: chatOf(update),
        albumMessage: album.reply.message, albumNoticeKey: album.reply.noticeKey });
      admittedAlbum = album.snapshot;
      update = normalizedAlbumUpdate(admittedAlbum);
      mayHoldBrief = false;
    } else if (sourceAnswer) return handled(sourceAnswer.status, sourceAnswer.extra);

    // ADR-145: a photo with no words is kept for its sender's words (and settled later); a video is
    // explained, and its words, if any, are read as a message. Nothing is parked for an operator.
    if (db && chatOf(update) && !admittedAlbum && !priorRevisionPhoto && update.message) {
      const hash = updateHash(update);
      if (settle) {
        const settled = await mediaRoute.settlePhoto(update, chatOf(update), albumSettleMs(), (late) => recordLate(update, late));
        if (settled) return handled(settled.status, settled.extra);
      } else if (heldPhotoCandidate(update)) {
        if (!senderAllowedFor(update)) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
        const held = await mediaRoute.holdPhotoUpdate(update, chatOf(update), hash, albumSettleMs());
        if (held) return handled(held.status, held.extra);
      }
      if (!settle) {
        // A stranger's video is refused before anything of it is recorded (audit S5).
        if (unusableMedia(update.message as Record<string, unknown>) && !senderAllowedFor(update)) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
        const unusable = await mediaRoute.unusable(update, chatOf(update), hash);
        if (unusable && 'answer' in unusable) return handled(unusable.answer.status, unusable.answer.extra);
        if (unusable) beside = unusable.notice;
      }
    }

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
        const pressed = (update.callback_query as { from?: { language_code?: unknown } }).from?.language_code;
        const popupLang = typeof pressed === 'string' && /^(?:ckb|ku)(?:$|[-_])/i.test(pressed) ? 'ckb' as const : 'en' as const;
        await ctx.telegramBridge.answerCallbackQuery(button.id, say(INBOX_MESSAGES.buttonPopup, popupLang), false).catch(() => false);
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
        /**
         * A file the design cannot use, or a picture that could not be opened: answered in words, once
         * (ADR-145). Nothing is parked for an operator any more; updates parked before keep their replay.
         */
        const holdMedia = async (phrase: 'fileUnsupported' | 'photoUnreadable' | 'photosUnplaced' = 'fileUnsupported') => {
          if (!senderAllowed) {
            return handled(403, { code: 'SENDER_NOT_ALLOWED' });
          }
          const answer = await mediaRoute.unreadableFile(update, chatId, updateHash(update), phrase);
          return handled(answer.status, answer.extra);
        };
        if (media && chatId && (media.photo || media.voice || media.audio || media.document ||
            media.video || media.video_note || media.animation || media.live_photo || media.caption) && !photoInput && !beside) {
          // A channel's own post is no requester's message: nothing is said in a channel (ADR-145).
          if (update.channel_post && !update.message) return handled(200, { ignored: true, reason: 'CHANNEL_POST_MEDIA' });
          // ADR-156 (audit P3): a logo sent as an SVG file. The design path places only PNG, JPEG and WebP,
          // and the bot does not draw a requester's vector file itself (it can load other files): the
          // office gets it, on the sender's one open design when there is one. Never "send it again".
          if (update.message && isSvgDocument(media.document)) {
            if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
            return await svgToOffice(update, chatId, senderId, media);
          }
          // A file the design cannot use, even with words: its caption never designs without it (ADR-069),
          // so the file is asked for again in a form that can be used.
          return await holdMedia(media.photo || (media.document && /^image\//i.test(String((media.document as Record<string, unknown>).mime_type ?? '')))
            ? 'photoUnreadable' : 'fileUnsupported');
        }
        // ADR-145: a message edited before the bot read it (held for photos, or set behind a held
        // brief) is read with its new words; the update itself, and so every receipt, stays the same.
        const editedWords = msg && !photoInput && !admittedAlbum && !boundPhoto
          ? await withRlsContext(db, SYSTEM_SCOPE, (trx) => pendingEditWords(trx, DEFAULT_TENANT_ID, update.update_id)) : null;
        // ADR-182: "@hawa_office_bot" addresses the bot in a group; it is not part of the words, which
        // become a brief's copy or its title.
        const rawText: string = withoutBotMentions((() => {
          if (photoInput) return photoInput.directive;
          if (editedWords !== null) return editedWords;
          if (msg && typeof msg === 'object') {
            const t = (msg as Record<string, unknown>).text ?? (msg as Record<string, unknown>).caption;
            return typeof t === 'string' ? t : '';
          }
          return '';
        })());
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
            const alert = actionFor(code) === 'revision-blocked' ? revisionBlockedAlert(chatId, code, update) : null;
            return handled(409, { code, lifecycleAction: actionFor(code), chatId, ...(alert ? { officeAlert: alert } : {}) });
          };
          try {
            const TENANT = DEFAULT_TENANT_ID;
            const system = { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
            const text = rawText.trim();
            // ADR-144: an answer to "which design?" carries the words of the message it was asked about.
            const directive = priorIntent?.plan.kind === 'revise' ? priorIntent.plan.directive : text;
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
            const receipts = await withRlsContext(db, system,
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

            /** A held brief's words with the parts joined to it while it waited (ADR-156). */
            const withBriefParts = async (words: string, heldUpdateId: number | null): Promise<string> => heldUpdateId === null ? words
              : joinedWords(words, await withRlsContext(db, system, (trx) => briefParts(trx, TENANT, heldUpdateId)));

            /**
             * ADR-235: a brief that names no organisation, from a chat bound to none, is kept and its sender is
             * asked who it is for. The organisations are listed only in an office member's own chat.
             */
            const askWhoItsFor = async (briefText: string, instructionOnly: boolean, scope: NonNullable<ReturnType<typeof senderScopeOf>>,
              image: ClientQuestion['image'] | undefined): Promise<Response> => {
              const chat = (msg as Record<string, any>)?.chat;
              const officeChat = chat?.type === 'private' && scope.senderId === chatId && ctx.telegramAllowedUsers.includes(scope.senderId);
              const lang = requesterLang(briefText);
              const { stored, answered } = await withRlsContext(db, system, async (trx) => {
                const names = officeChat ? await knownClientNames(trx, TENANT) : [];
                const text = names.length ? say(CLIENT_QUESTION_MESSAGES.askClientNamed, lang, { list: names.map(bold).join(', ') })
                  : say(CLIENT_QUESTION_MESSAGES.askClient, lang);
                const stored = await recordClientQuestion(trx, TENANT, { briefUpdateId: update.update_id, chatId, senderId: scope.senderId,
                  topicId: scope.topic, words: briefText, instructionOnly, ...(image ? { image } : {}), text, listed: names,
                  askedAt: new Date().toISOString(), askRules: CLIENT_QUESTION_RULES, payloadHash, sourceUpdate: update });
                return { stored, answered: await readClientResolution(trx, TENANT, update.update_id) };
              });
              if (stored.payloadHash !== payloadHash || stored.chatId !== chatId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
              // ChatInbox settles the brief's update when the question times out (a durable delayed call).
              return handled(200, { lifecycleAction: 'chat-answer', chatId, clientQuestion: true,
                clientQuestionSettle: { delayMs: CLIENT_QUESTION_MS },
                chatAnswer: { text: stored.text, parseMode: 'HTML' }, ...(answered ? { duplicate: true } : {}) });
            };

            /** Opens a lifecycle request for a brief (ADR-135), one per language (ADR-139). */
            const openBrief = async (briefText: string, instructionOnly: boolean, takeHeldPhoto = true,
              /** ADR-235: the organisation the sender named for a kept brief, or the office to choose it; and its photo. */
              opts: { clientId?: string; forOffice?: boolean; keptImage?: ClientQuestion['image']; clientChoice?: ClientChoice;
                /** Conversation fuzz (2026-10-03): a change or a deadline kept with the brief while it waited for its answer. */
                notes?: ClientQuestionNote[] } = {}): Promise<Response> => {
              // ADR-235: the kept brief whose question timed out opens, as it was kept, for the office to choose.
              if (clientTimeout && clientTimeout.briefUpdateId === update.update_id) {
                const timedOut = clientTimeout;
                briefText = timedOut.words;
                // Conversation fuzz (2026-10-03): with the change or deadline kept with it while it waited.
                const notes = await withRlsContext(db, system, (trx) => clientQuestionNotes(trx, TENANT, timedOut.briefUpdateId));
                instructionOnly = clientTimeout.instructionOnly;
                takeHeldPhoto = false;
                opts = { forOffice: true, ...(clientTimeout.image ? { keptImage: clientTimeout.image } : {}), ...(notes.length ? { notes } : {}),
                  clientChoice: { outcome: 'timeout', lang: requesterLang(clientTimeout.words) } };
                // ADR-284 addendum (live canary 2026-10-03): the request's first answer says it, with "a designer will
                // make …", in one message; the notice is said only if the brief does not open after all.
                beside = null;
                besideKey = null;
              }
              // What was to be said beside the answer before this brief was read (a video's words were used).
              const besideOnEntry = beside;
              const sender = (msg as Record<string, { id?: unknown; first_name?: unknown }>).from;
              // ADR-145: the newest photo its sender sent with no words, kept for these words.
              const scope = senderScopeOf(update);
              // A photo of a burst still settling with others is not taken alone (ADR-160 addendum).
              const heldPhoto = takeHeldPhoto && !opts.keptImage && !photoInput && !admittedAlbum && !boundPhoto && scope && !mayHoldBrief
                ? (await withRlsContext(db, system, async (trx) => outsideBursts(trx, TENANT, await waitingPhotos(trx, TENANT, scope)))).at(-1) ?? null : null;
              if (!senderAllowed) {
                return handled(403, { code: 'SENDER_NOT_ALLOWED' });
              }
              if (briefText.length > 100_000) return handled(413, { code: 'BRIEF_TOO_LONG' });
              // A text brief waits a moment for photos sent right after it (ADR-143): its settle
              // opens it, alone or with the album that followed.
              if (mayHoldBrief && !photoInput && await withRlsContext(db, system, (trx) => holdBrief(trx, TENANT, update))) {
                return handled(202, { lifecycleAction: 'settle-later', chatId,
                  settle: { kind: 'brief', delayMs: briefPhotoWaitMs() } });
              }
              const {requestId,allocation,parts}=planLifecycleBriefDeliverables(briefText,{chatId,updateId:update.update_id,instructionOnly,acceptsLanguageSiblings});
              /**
               * ADR-250 (friction 4): a brief the bot cannot start by itself (more designs than one request holds, a
               * size the design path does not make) opens nothing. The requester hears so in their language, as a
               * chat answer the worker sends (a bare 422 was never sent), and the office gets the words to follow up.
               * They are never told to send it again in groups or to choose a size.
               */
              const cannotStart = (code: 'DELIVERABLE_LIMIT' | 'UNSUPPORTED_CANVAS', detail: { count: number } | { size: string }, why: string) => {
                const office = officeChatFor(chatId);
                const alerted = Boolean(office && office !== chatId);
                const phrase = 'count' in detail ? (alerted ? INTAKE_LIMIT_MESSAGES.tooManyPassed : INTAKE_LIMIT_MESSAGES.tooManyKept)
                  : (alerted ? INTAKE_LIMIT_MESSAGES.sizePassed : INTAKE_LIMIT_MESSAGES.sizeKept);
                const alert = alerted ? { chatId: office!, text: [`${whoSent(update)} sent a brief the bot could not start by itself: ${why}. ` +
                  'Nothing was opened; please follow up with them in their chat.', '', 'Their words:', Array.from(briefText).slice(0, 3000).join('')].join('\n') } : null;
                return handled(422, { code, lifecycleAction: 'chat-answer', chatId,
                  chatAnswer: { text: say(phrase, requesterLang(briefText), detail), parseMode: 'HTML' }, ...(alert ? { officeAlert: alert } : {}) });
              };
              if (allocation.kind === 'limit') return cannotStart('DELIVERABLE_LIMIT', { count: allocation.count },
                `it asks for ${allocation.count} designs, and one request holds at most ${MAX_REQUEST_DELIVERABLES}`);
              if (parts.length > MAX_REQUEST_DELIVERABLES) return cannotStart('DELIVERABLE_LIMIT', { count: parts.length },
                `its formats and languages need ${parts.length} designs, and one request holds at most ${MAX_REQUEST_DELIVERABLES}`);
              if (parts.length > deliverableCapacity) return handled(503,{code:'LANGUAGE_SIBLINGS_UNSUPPORTED'});
              const unsupported=parts.find(p=>p.variant && (p.variant.width<640 || p.variant.width>2400 || p.variant.height<640 || p.variant.height>2400));
              if (unsupported) return cannotStart('UNSUPPORTED_CANVAS', { size: `${unsupported.variant!.width} × ${unsupported.variant!.height}` },
                `it asks for a ${unsupported.variant!.width} × ${unsupported.variant!.height} px canvas, outside the supported 640–2400 px range`);
              const prepare = async (part: (typeof parts)[number]) => {
                const prepared=await createChatCampaignIntake(ctx).prepareChatCampaignDraft({
                  platform: 'telegram', sourceEventId: `lc-${part.requestId}-r0`, sourceChannelId: chatId,
                  senderName: typeof sender?.first_name === 'string' ? sender.first_name : 'Requester',
                  rawText: part.text, rawJson: part.lang ? { ...update, hawaLanguageGraphic: part.lang } : update,
                  explicitClientId:opts.clientId ?? part.clientId,variantOverride:part.variant,
                  autoGenerate: !instructionOnly && !part.detailsRequired && chatAutoDraftsEnabled(),
                  isInstructionOnly: instructionOnly || part.detailsRequired,
                });
                // ADR-232: a request written as a sentence is not its own copy. The model reads one brief per
                // update (a split brief's parts are taken by the rules); its intake headline fields stay off
                // the draft, as before, unless the copy was taken from the sentence.
                const { headlineEn: _he, headlineCkb: _hc, copyEn: _ce, copyCkb: _cc, ...plain } = prepared;
                const draft = await extractRequestCopy(plain, { model: parts.length === 1 ? copyModel : null, tenantId: TENANT,
                  updateId: update.update_id, senderName: typeof sender?.first_name === 'string' ? sender.first_name : 'Requester' });
                return parts.length>1 && allocation.kind==='multiple' ? {...draft,title:`${draft.title} (${parts.indexOf(part)+1}/${parts.length})`} : draft;
              };
              let prepared = await prepare(parts[0]);
              // Conversation fuzz (2026-10-03): words kept with the brief while it waited are never its copy or its name.
              // The requester's words keep them (the office reads them); a change is an instruction for the design too.
              if (opts.notes?.length) {
                const changes = opts.notes.filter((n) => n.kind === 'change').map((n) => n.words.trim());
                prepared = { ...prepared, rawText: withClientQuestionNotes(prepared.rawText, opts.notes),
                  ...(changes.length ? { designInstructions: [prepared.designInstructions, ...changes].filter(Boolean).join('\n\n') } : {}) };
              }
              let lifecycleImage: ChatIntake['lifecycleImage'];
              if (opts.keptImage) {
                // ADR-235: the photo the kept brief came with, retained when the question was asked.
                lifecycleImage = { ...opts.keptImage, updateId: update.update_id };
              } else if (boundPhoto) {
                lifecycleImage = { ...boundPhoto, updateId: update.update_id };
              } else if (photoInput) {
                if (!ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                const photo = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                  (id) => ctx.telegramBridge!.downloadFile(id), photoInput.fileId);
                if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                // A caption never designs without its picture (ADR-069): the picture is asked for again.
                if (photo.kind === 'unsupported') return await holdMedia('photoUnreadable');
                lifecycleImage = { ...photo.ref, updateId: update.update_id };
              } else if (heldPhoto) {
                // ADR-145: the photo its sender sent just before (or while the brief waited for photos).
                lifecycleImage = { ...heldPhoto.image, updateId: update.update_id };
                beside = { text: say(MEDIA_MESSAGES.photoUsedWithWords, requesterLang(briefText)), parseMode: 'HTML' };
              }
              // ADR-235: nothing names the organisation (the chat is bound to none, the words name none): the
              // brief is kept and its sender asked. Never guessed; a split brief or an album opens as before.
              // Brief phrasing fuzz (2026-10-03, class 5): a request for a design with no copy of its own ("could you
              // make a poster for us?") is asked too; it opens for a designer once answered. Other words opened for a
              // designer (a change, redo words or a subject with nothing on the way) open as before.
              if (!opts.clientId && !opts.forOffice && parts.length === 1 && (!instructionOnly || readIntentByRules(briefText).intent === 'new_brief') &&
                  !parts[0].detailsRequired &&
                  prepared.clientId === null && !admittedAlbum && !boundPhoto && scope) {
                // Conversation fuzz (2026-10-03): the organisation its sender named alone just before ("KAAE", then the brief)
                // says who it is for; they were asked what to design for it, never again who it is for.
                const named = await withRlsContext(db, system, (trx) => recentNamedOrganisation(trx, TENANT,
                  { chatId, senderId: scope.senderId, topicId: scope.topic }, update.update_id));
                if (named) return await openBrief(briefText, instructionOnly, takeHeldPhoto, named.clientId ? { ...opts, clientId: named.clientId }
                  : { ...opts, forOffice: true, clientChoice: { outcome: 'unmatched', lang: requesterLang(briefText), named: named.name.slice(0, 120) } });
                // A held photo is not used yet (the answer's brief takes it): its notice is not said.
                beside = besideOnEntry;
                return await askWhoItsFor(briefText, instructionOnly, scope, photoInput && lifecycleImage
                  ? { sha256: lifecycleImage.sha256, size: lifecycleImage.size, mediaType: lifecycleImage.mediaType } : undefined);
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
              const stored = await withRlsContext(db, system, async (trx) => {
                if (heldPhoto) {
                  // One photo is used once: words that took it first keep it (then this brief opens without it).
                  const claim = await claimPhoto(trx, TENANT, heldPhoto.updateId, { byUpdateId: update.update_id, how: 'brief', requestId });
                  if (claim.byUpdateId !== update.update_id) return null;
                }
                const briefAnchor = await briefAnchorFor(trx,TENANT,update);
                return recordNewBriefDecision(trx, TENANT, update.update_id,
                  { requestId, chatId, payloadHash, draft,
                    ...(briefAnchor ? {briefAnchor} : {}),
                    ...((lifecycleImage || admittedAlbum || allocation.kind==='multiple') ? { sourceUpdate: update } : {}),
                    ...(allocation.kind==='multiple' ? {deliverableCount:parts.length,
                      deliverableDetailsRequired:parts.filter(p=>p.detailsRequired).map(p=>p.requestId)} : {}),
                    ...(siblings.length ? { siblings } : {}),
                    ...(opts.clientChoice ? { clientChoice: opts.clientChoice } : {}) });
              });
              if (!stored) {
                beside = null;
                return openBrief(briefText, instructionOnly, false, opts);
              }
              if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
                  stored.requestId !== requestId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
              await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: 200 });
              return handled(200, { duplicate: false, lifecycleAction: 'open-request',
                requestId, chatId, draft: stored.draft, ...(stored.siblings?.length ? { siblings: stored.siblings } : {}),
                ...(stored.deliverableCount ? {deliverableCount:stored.deliverableCount} : {}) });
            };

            /**
             * A round on a request that waits for the requester: their change, or their answer. ADR-200
             * addendum: `reopen`, a new round of a design delivered recently, asked for with redo words
             * (text only: a photo kept from before stays for words that name it); `answer`, what the
             * requester hears when the round starts ("I'll redo …"), in place of the usual line.
             */
            const reviseRequest = async (openRequest: Omit<Pick<WaitingLifecycleRequest, 'request_id' | 'rev' | 'stage' |
              'current_task_id' | 'client_id' | 'question'>, 'stage'> & { stage: WaitingLifecycleRequest['stage'] | 'delivered' },
            words: string, opts: { reopen?: true; redo?: true; answer?: string } = {}): Promise<Response> => {
              if (Boolean(opts.reopen) !== (openRequest.stage === 'delivered')) throw new LifecycleProjectionConflict('WRONG_STAGE', 'Only redo words reopen a delivered design');
              if (openRequest.stage === 'awaiting_answer' &&
                  (!openRequest.question || !UUID.test(openRequest.question.id))) {
                return await refuseWithReceipt('QUESTION_MISSING');
              }
              const questionId = openRequest.stage === 'awaiting_answer'
                ? openRequest.question!.id : undefined;
              const requestId = openRequest.request_id;
              const expectedRev = Number(openRequest.rev);
              const nextRev = expectedRev + 1;
              // Derive the round from the revision number: first office-revise lands at rev=3;
              // subsequent revisions increment by 2 each time (office+requester), so round = (rev - 1) / 2.
              const round = Math.max(1, Math.floor((expectedRev - 1) / 2));
              let lifecycleImage = priorRevisionPhoto?.image ?? boundPhoto;
              // ADR-145: a photo its sender sent with no words just before this change goes with it.
              const scope = senderScopeOf(update);
              const heldPhoto = !photoInput && !lifecycleImage && !admittedAlbum && scope && !openRequest.question && !opts.reopen && !opts.redo
                ? (await withRlsContext(db, system, async (trx) => outsideBursts(trx, TENANT, await waitingPhotos(trx, TENANT, scope)))).at(-1) ?? null : null;
              if (heldPhoto) {
                const stored = await withRlsContext(db, system, async (trx) => {
                  const claim = await claimPhoto(trx, TENANT, heldPhoto.updateId,
                    { byUpdateId: update.update_id, how: 'revision', requestId: openRequest.request_id });
                  if (claim.byUpdateId !== update.update_id) return null;
                  return recordRevisionPhotoDecision(trx, TENANT, update.update_id, { requestId: openRequest.request_id, chatId,
                    payloadHash, image: heldPhoto.image, heldPhotoUpdateId: heldPhoto.updateId });
                });
                if (stored) {
                  if (stored.payloadHash !== payloadHash || stored.requestId !== openRequest.request_id) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  lifecycleImage = stored.image;
                  beside = { text: say(MEDIA_MESSAGES.photoUsedWithWords, requesterLang(words)), parseMode: 'HTML' };
                }
              }
              if (photoInput && !priorRevisionPhoto) {
                if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
                if (!lifecycleImage) {
                  if (!ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                  const photo = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                    (id) => ctx.telegramBridge!.downloadFile(id), photoInput.fileId);
                  if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                  if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                  if (photo.kind === 'unsupported') return await holdMedia('photoUnreadable');
                  lifecycleImage = photo.ref;
                }
                // Retained bytes still need the same durable revision/request binding before projection.
                const stored = await withRlsContext(db, system,
                  (trx) => recordRevisionPhotoDecision(trx, TENANT, update.update_id,
                    { requestId, chatId, payloadHash, image: lifecycleImage! }));
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
                round, directive: words, sourceEventId, sourceChannelId: chatId,
                rawText: words, sourceUpdateHash: payloadHash, sourceUpdate: update,
                ...(lifecycleImage ? { lifecycleImage } : {}),
                ...(admittedAlbum ? { lifecycleAlbum: admittedAlbum.ref } : {}),
                clientId: openRequest.client_id,
                ...(questionId ? { questionId } : {}),
                ...(opts.reopen ? { reopenDelivered: true as const } : {}),
                // ADR-233: redo words on a design sent back for changes are a fresh round too.
                ...(opts.redo && !opts.reopen && !questionId && !lifecycleImage && !admittedAlbum ? { redo: true as const } : {}),
                expectedRev, rev: nextRev, key,
              });
              await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: 200 });
              return handled(200, { duplicate: false,
                lifecycleAction: questionId ? 'requester-answer' : 'requester-revision',
                requestId, newTaskId: projected.newTaskId,
                round: projected.round, directive: projected.directive,
                priorTaskId: openRequest.current_task_id, rawText: words, chatId,
                ...(questionId ? { questionId } : {}),
                ...(opts.answer ? { chatAnswer: { text: opts.answer, parseMode: 'HTML' } } : {}),
              });
            };

            const replied = msg && typeof msg === 'object' ? (msg as Record<string, unknown>).reply_to_message : null;
            const messageId = replied && typeof replied === 'object'
              ? (replied as Record<string, unknown>).message_id : null;
            const replyMessageId = Number.isSafeInteger(messageId) && Number(messageId) > 0 ? String(messageId) : null;
            const newCommand = /^\/new(?:@\w+)?(?:\s+|$)/i.exec(text);
            const newBriefText = newCommand ? text.slice(newCommand[0].length).trim() : text;
            if (newCommand && !newBriefText) {
              return handled(422, { code: 'NEW_BRIEF_EMPTY', lifecycleAction: 'new-brief-required', chatId });
            }

            // --- ADR-144: a message is read in the context of the chat's requests, once ---
            // ADR-156 (audit #11, #12): a photo with words, a photo sent as a reply and an album with words
            // are read as text is, so they choose their design (or a new one) by the same rules and the
            // same ownership. A revision photo decided before that routing existed replays below as it was.
            const mediaKind: 'photo' | 'album' | null = photoInput ? 'photo' : admittedAlbum ? 'album' : null;
            const photoWithoutWords = photoInput?.captionless === true;
            if (msg && (!priorRevisionPhoto || priorRevisionPhoto.heldPhotoUpdateId || priorIntent)) {
              if (!senderAllowed) return handled(403, { code: 'SENDER_NOT_ALLOWED' });
              const message = msg as Record<string, any>;
              // A photo with no words is answered in the chat's language (ADR-143's rule), words in their own.
              // ADR-251 (friction 11): so is a message with no letters ("👍", "?", "2").
              const lang = photoWithoutWords || !hasLetters(text)
                ? await withRlsContext(db, system, (trx) => mediaRoute.langFor(trx, chatId, message)) : langOf(text);
              const group = ['group', 'supergroup'].includes(String(message.chat?.type || ''));
              const botName = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
              const entities = Array.isArray(message.entities) ? message.entities : Array.isArray(message.caption_entities) ? message.caption_entities : [];
              // Entity offsets count in the message as sent, before the bot's name was taken out of its words.
              const sent = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : text;
              const mentionsBot = entities.some((e: any) =>
                (e?.type === 'mention' && Number.isInteger(e.offset) && Number.isInteger(e.length) &&
                  ((mention: string) => mention.endsWith('bot') || (botName && mention === `@${botName}`))(
                    sent.slice(e.offset, e.offset + e.length).toLowerCase())) ||
                (e?.type === 'text_mention' && e.user?.is_bot === true));
              const groupCommand = /^\/(?:task|brief|design|campaign)(?:@\w+)?(?:\s+|$)/i.exec(text);
              // An album admitted in a group already passed ADR-160's gate (`actsInGroup`: addressed to the
              // bot, or a clear brief) when its photos settled or its sender's words bound them; its frozen
              // message keeps the words but not their mention entities, so it is not read for them again.
              const addressed = !group || mediaKind === 'album' || Boolean(boundPhoto) || message.reply_to_message?.from?.is_bot === true ||
                mentionsBot || text.startsWith('/');
              const { requests, bindings, opening } = await withRlsContext(db, system, async (trx) => ({
                // Seven days of delivered designs: redo words may mean one (ADR-200 addendum); planTurn
                // keeps three days for everything else.
                requests: await activeChatRequests(trx, TENANT, chatId, 7),
                bindings: replyMessageId ? await replyBindings(trx, TENANT, chatId, replyMessageId)
                  : { requestIds: [] as string[], askUpdateId: null as number | null },
                opening: priorIntent ? [] : await openingChatRequests(trx, TENANT, chatId, update.update_id),
              }));
              // ADR-235: the answer to "who is this design for?" opens the kept brief, for the organisation named or
              // for the office to choose. Words that do not answer it are read as any message is.
              // Conversation fuzz (2026-10-03): with the brief still waiting for that answer (`waiting`).
              const waiting: { question: ClientQuestion | null } = { question: null };
              if (!priorIntent && !newCommand && !groupCommand && !mediaKind) {
                const scope = senderScopeOf(update);
                const kept = scope && await withRlsContext(db, system, async (trx) => {
                  const pending = await pendingClientQuestion(trx, TENANT, { chatId, senderId: scope.senderId, topicId: scope.topic }, update.update_id);
                  if (!pending) return null;
                  if (pending.resolution) return { question: pending.question, resolution: pending.resolution };
                  const repliedToQuestion = (await answeredUpdateOf(trx, TENANT, replyMessageId)) === pending.question.briefUpdateId;
                  const answer = await readClientAnswer(trx, TENANT, { question: pending.question, text, repliedToQuestion });
                  if (!answer) {
                    waiting.question = pending.question;
                    return null;
                  }
                  const resolution = await resolveClientQuestion(trx, TENANT, pending.question.briefUpdateId, { byUpdateId: update.update_id, ...answer });
                  return resolution.byUpdateId === update.update_id ? { question: pending.question, resolution } : null;
                });
                // An organisation named after the question timed out: the office is told, nothing opens again.
                const late = !kept && scope ? await withRlsContext(db, system, async (trx) => {
                  const timedOut = await timedOutClientQuestion(trx, TENANT, { chatId, senderId: scope.senderId, topicId: scope.topic });
                  if (!timedOut || saysDontKnow(text)) return null;
                  const replied = (await answeredUpdateOf(trx, TENANT, replyMessageId)) === timedOut.question.briefUpdateId;
                  const clientId = await resolveSourceClient(trx, TENANT, { chatId, words: text });
                  if (!clientId || (!replied && !(plainClientAnswer(text) && !/\p{N}/u.test(text) &&
                    !/\b(?:poster|flyer|banner|design|invitation|card|post|story)s?\b|پۆستەر|پۆست|دیزاین/iu.test(text)))) return null;
                  return { ...timedOut, client: await clientName(trx, TENANT, clientId) ?? text.trim() };
                }) : null;
                if (late) {
                  const lang = requesterLang(text, requesterLang(late.question.words));
                  const title = late.title ?? say(LIFECYCLE_MESSAGES.yourDesign, lang);
                  const office = officeChatFor(chatId);
                  return handled(200, { lifecycleAction: 'chat-answer', chatId,
                    chatAnswer: { text: say(CLIENT_QUESTION_MESSAGES.clientNoted, lang, { title: bold(title), client: bold(late.client) }), parseMode: 'HTML' },
                    ...(office ? { officeAlert: { chatId: office, text: `The requester says "${title}" is for ${late.client}. ` +
                      'It was passed to you because they had not said who it was for; please assign it in the Desk.' } } : {}) });
                }
                // A kept brief the requester withdrew (below) never opens; this update said so already.
                if (kept && kept.resolution.outcome === 'withdrawn') {
                  const lang = requesterLang(text, requesterLang(kept.question.words));
                  return handled(200, { lifecycleAction: 'chat-answer', chatId, duplicate: true,
                    chatAnswer: { text: say(WITHDRAW_MESSAGES.withdrawn, lang, { title: bold(keptBriefName(kept.question.words, lang)) }), parseMode: 'HTML' } });
                }
                if (kept) {
                  const { question, resolution } = kept;
                  // Answered in the language of the answer (an English brief may be answered in Sorani).
                  const lang = requesterLang(text, requesterLang(question.words));
                  mayHoldBrief = false;
                  // ADR-284 addendum (live canary 2026-10-03): "No problem. I've passed it to the office…" and "Got it. A
                  // designer will make …" came back to back. The request's first answer says both, in the answer's language.
                  const officeChooses = resolution.outcome === 'office' || resolution.outcome === 'unmatched' || resolution.outcome === 'expired'
                    ? { outcome: resolution.outcome, lang, ...(resolution.outcome === 'unmatched' && text.trim() ? { named: text.trim().slice(0, 120) } : {}) } as ClientChoice : null;
                  // Conversation fuzz (2026-10-03): a change or a deadline kept with the brief while it waited opens with it.
                  const notes = await withRlsContext(db, system, (trx) => clientQuestionNotes(trx, TENANT, question.briefUpdateId));
                  return await openBrief(question.words, question.instructionOnly, true, { ...(notes.length ? { notes } : {}),
                    ...(resolution.outcome === 'client' && resolution.clientId ? { clientId: resolution.clientId } : { forOffice: true }),
                    ...(officeChooses ? { clientChoice: officeChooses } : {}),
                    ...(question.image ? { keptImage: question.image } : {}) });
                }
              }
              let reading: IntentReading;
              let plan: TurnPlan;
              let askedAboutBrief: PendingAsk | null = null;
              if (priorIntent) {
                reading = priorIntent.reading;
                plan = priorIntent.plan;
              } else if (newCommand || groupCommand) {
                // "/new …" (and "/task …", "/design …", in a group or a private chat: ADR-156) is a new
                // brief by the sender's own word; the words after the command are the brief.
                const body = newCommand ? newBriefText : text.slice(groupCommand![0].length).trim();
                const asRead = readIntentByRules(body);
                if (!body || !['new_brief', 'change', 'unclear'].includes(asRead.intent)) {
                  return handled(422, { code: 'NEW_BRIEF_EMPTY', lifecycleAction: 'new-brief-required', chatId });
                }
                reading = { ...asRead, intent: 'new_brief', explicitNew: true, reason: 'Sent as a new brief with a command' };
                plan = { kind: 'open', text: body, instructionOnly: asRead.intent !== 'new_brief' || asRead.instructionOnly === true };
              } else {
                // A photo with no words, sent as a reply, is material for a design (ADR-156): it is read as
                // a change to the design the reply points at (or the only one), never as a new request.
                // Words sent with a photo or an album carry new material: they are never redo words
                // (ADR-200 addendum), and are read as before.
                reading = photoWithoutWords
                  ? { intent: 'change', reason: 'A photo sent as a reply, with no words', source: 'rules' }
                  : readIntentByRules(text, { redo: !mediaKind });
                // A follow-up that could concern a request whose open is still in flight waits for it
                // (ChatInbox tries again in 2 s): read now, it would miss that request (F4).
                if (opening.length && !['acknowledgement', 'conversation'].includes(reading.intent) &&
                    !(reading.intent === 'new_brief' && reading.explicitNew)) {
                  return handled(503, { code: 'REQUEST_OPENING', chatId });
                }
                const asked = await withRlsContext(db, system, (trx) =>
                  pendingAskFor(trx, TENANT, chatId, senderId, update.update_id, bindings.askUpdateId));
                // Conversation fuzz: "Do you want me to cancel …?" about a kept brief names no request; the planner never sees it.
                askedAboutBrief = asked?.intent === 'cancel' && asked.options.length === 1 && asked.options[0].requestId.startsWith('brief:') ? asked : null;
                const pendingAsk = askedAboutBrief ? null : asked;
                const input = { text, reading, requests, bound: bindings.requestIds,
                  unboundReply: Boolean(replyMessageId) && bindings.requestIds.length === 0 && !bindings.askUpdateId,
                  senderId, officeIds: ctx.telegramAllowedUsers, group, addressed, pendingAsk, now: Date.now(),
                  repliedToAsk: Boolean(bindings.askUpdateId),
                  foreignReply: Boolean(replyMessageId) && message.reply_to_message?.from?.is_bot === true &&
                    bindings.requestIds.length === 0 && !bindings.askUpdateId };
                plan = planTurn(input);
                // ADR-250 (L19): words read as a brief of their own that edit a design on the way ("take KAAE's
                // out of the title") are a change to it, or asked about; never a second request and paid round.
                const edit = mediaKind ? null : reconsiderNewBrief(input, plan);
                if (edit) {
                  reading = edit.reading;
                  plan = edit.plan;
                }
                // What the rules cannot place is asked of the intake router once, within the office's
                // budget; without it (no key, no consent, no allowance, no answer) the question stands.
                // ADR-230 addendum (L17): cancel words the rules cannot place are asked as a cancel, and read the same way.
                // ADR-255: a question that names every design the words named together ("Do you want me to cancel
                // both …?") is already the one question; the router, which picks one design, is not asked.
                if (plan.kind === 'ask' && !plan.every && (plan.intent === 'unclear' || (plan.intent === 'cancel' && reading.cancelWords)) && intentModel) {
                  const candidates = requests.filter((r) => plan.kind === 'ask' && plan.options.some((o) => o.requestId === r.requestId));
                  const modelReading = await intentModel.read({ tenantId: TENANT, updateId: update.update_id, chatId,
                    text, requests: candidates, lang });
                  if (modelReading && reading.cancelWords && modelReading.intent !== 'cancel') {
                    // ADR-250 (friction 6): the router has no "cancel"; it reads cancel words as a change (kept for
                    // the office) or chatter (the greeting). It may only say which design the cancel is about:
                    // the requester is then asked about that one by name, and nothing is withdrawn unasked.
                    if (modelReading.intent === 'change' && modelReading.requestId) {
                      reading = { ...reading, source: 'model', requestId: modelReading.requestId,
                        ...(modelReading.confidence !== undefined ? { confidence: modelReading.confidence } : {}) };
                      plan = planTurn({ ...input, reading, pendingAsk: null });
                    }
                  } else if (modelReading) {
                    // ADR-200 addendum: redo words the router reads as a change redo the design it names.
                    reading = { ...modelReading, instructionOnly: reading.instructionOnly, substantial: reading.substantial,
                      ...(reading.redo && modelReading.intent === 'change' ? { redo: reading.redo } : {}) };
                    plan = planTurn({ ...input, reading, pendingAsk: null });
                  }
                }
              }
              // ADR-156: what a plan cannot carry of its media. An album's photos cannot follow a later answer
              // (its projection binds them to this update), so an album whose words only answer, ask or tell
              // goes to the office whole. A photo's words that are chat, or find nothing to change, are asked
              // about with the photo kept (ADR-145); a photo with no words replying to a design's brief
              // rather than its revision notice cannot start a round, and is kept for the words that will.
              if (!priorIntent && mediaKind === 'album' && !['open', 'revise', 'passive'].includes(plan.kind) &&
                  !(plan.kind === 'note' && plan.note === 'change')) {
                // "Change or new?" with no design waiting for changes among the choices: a brief with photos
                // opens as it always did (ADR-143). Anything else is the office's to place.
                const brief = classifyWithHeuristics(text, false, false);
                const opensAsBefore = plan.kind === 'ask' && plan.allowNew && brief.kind === 'new_brief' &&
                  !plan.options.some((o) => { const r = byRequest(requests, o.requestId); return r ? waitsForRequester(r) : false; });
                plan = opensAsBefore ? { kind: 'open', text, instructionOnly: brief.isInstructionOnly === true }
                  : { kind: 'forward', words: `${text}\n[The requester also sent an album of photos with these words. They are in the Telegram chat.]` };
              }
              if (!priorIntent && mediaKind === 'photo' && photoInput) {
                const keepAndAsk = plan.kind === 'conversation' || (plan.kind === 'reply' && plan.what === 'nothing-to-change') ||
                  (plan.kind === 'revise' && photoWithoutWords && !(await withRlsContext(db, system, (trx) =>
                    linkedLifecycleReplies(trx, TENANT, chatId, photoInput.replyMessageId ?? '0'))).some((l) =>
                    l.requestId === (plan as { requestId: string }).requestId && l.rev === byRequest(requests, l.requestId)?.rev));
                if (keepAndAsk) {
                  const kept = await mediaRoute.holdPhotoUpdate(update, chatId, payloadHash, albumSettleMs(), { fileId: photoInput.fileId }, boundPhoto);
                  if (kept) return handled(kept.status, kept.extra);
                }
                if (plan.kind === 'ask') plan = { ...plan, photo: true };
                if (plan.kind === 'tell' || plan.kind === 'forward') {
                  plan = { ...plan, words: `${photoWithoutWords ? '(no words)' : plan.words}\n[The requester also sent a photo. It is in the Telegram chat.]` };
                }
              }
              // ADR-200: the sender's first name, so the office can name whose draft it is ("the one for Sewa").
              const firstName = (sender as { first_name?: unknown } | undefined)?.first_name;
              const senderName = typeof firstName === 'string' && firstName.trim() ? Array.from(firstName.trim()).slice(0, 60).join('') : undefined;
              const receipt = (answer?: { status: number; extra: Record<string, unknown> }): IntentReceipt => ({
                updateId: update.update_id, chatId, senderId, ...(senderName ? { senderName } : {}),
                messageId: Number.isSafeInteger(message.message_id) ? String(message.message_id) : null,
                payloadHash, reading, plan, ...(answer ? { answer } : {}) });
              const decided = async (status: number, extra: Record<string, unknown>): Promise<Response> => {
                const stored = await withRlsContext(db, system, (trx) => recordIntentReceipt(trx, TENANT, receipt({ status, extra })));
                if (stored.payloadHash !== payloadHash || stored.chatId !== chatId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                const answer = stored.answer ?? { status, extra };
                await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: answer.status });
                return handled(answer.status, { ...answer.extra, duplicate: false });
              };
              const chatAnswer = (words: string, extra: Record<string, unknown> = {}) =>
                ({ lifecycleAction: 'chat-answer', chatId, chatAnswer: { text: words, parseMode: 'HTML' }, intent: reading.intent, ...extra });
              /**
               * Conversation fuzz (2026-10-03): a brief kept while the bot waits to hear who it is for (ADR-235) is not a
               * request yet, so the planner cannot see it. "Is it ready?" was told "I don't have a design in progress"; a
               * cancel was told "There's nothing open for me to cancel", and the brief still opened for the office when
               * the question timed out. Now a status question hears the brief waits for that answer; a cancel is asked
               * about ("Do you want me to cancel …?") and only "yes" withdraws the kept brief, which then never opens.
               */
              if (!priorIntent && !mediaKind && (waiting.question || askedAboutBrief)) {
                const brief = waiting.question;
                const option = brief ? `brief:${brief.briefUpdateId}` : null;
                const name = (title: boolean) => bold(keptBriefName(brief?.words ?? '', lang, title));
                if (askedAboutBrief && brief && askedAboutBrief.options[0].requestId === option) {
                  if (keepsIt(text)) {
                    plan = { kind: 'reply', what: 'status', requestIds: [] };
                    return await decided(200, chatAnswer(say(ROUTING_MESSAGES.statusAwaitingAnswer, lang, { title: name(true), question: brief.text })));
                  }
                  const choice = parseChoice(text, askedAboutBrief);
                  if (choice && 'option' in choice && choice.option === 0) {
                    const won = await withRlsContext(db, system, (trx) =>
                      resolveClientQuestion(trx, TENANT, brief.briefUpdateId, { byUpdateId: update.update_id, outcome: 'withdrawn' }));
                    if (won.byUpdateId === update.update_id) {
                      plan = { kind: 'reply', what: 'nothing-to-cancel', requestIds: [] };
                      return await decided(200, chatAnswer(say(WITHDRAW_MESSAGES.withdrawn, lang, { title: name(false) }), { withdrawnBrief: brief.briefUpdateId }));
                    }
                  }
                }
                // Words that answer neither question are read as usual; these two are about the waiting brief.
                if (brief && plan.kind === 'reply' && plan.what === 'status' && !plan.requestIds.length && reading.intent !== 'deadline') {
                  return await decided(200, chatAnswer(say(ROUTING_MESSAGES.statusAwaitingAnswer, lang, { title: name(true), question: brief.text })));
                }
                if (brief && option && plan.kind === 'reply' && plan.what === 'nothing-to-cancel') {
                  plan = { kind: 'ask', intent: 'cancel', words: text, options: [{ requestId: option, title: keptBriefName(brief.words, lang, false) }], allowNew: false };
                  return await decided(200, chatAnswer(say(WITHDRAW_MESSAGES.askCancel, lang, { title: name(false) }), { choiceRequired: true }));
                }
                // Conversation fuzz (2026-10-03): a change no design on the way took went to the office as words about a design
                // "no longer open"; a deadline got the question back and its words were lost. Both are kept with the brief,
                // which opens with them, and the question is asked again.
                const unplaced = plan.kind === 'forward' || (plan.kind === 'reply' && !plan.requestIds.length &&
                  (plan.what === 'status' || plan.what === 'nothing-to-change'));
                if (brief && unplaced && (reading.intent === 'change' || reading.intent === 'deadline')) {
                  const kind = reading.intent;
                  await withRlsContext(db, system, (trx) => keepClientQuestionNote(trx, TENANT,
                    { briefUpdateId: brief.briefUpdateId, updateId: update.update_id, kind, words: text }));
                  const when = kind === 'deadline' && lang === 'en' ? deadlineWords(text) : null;
                  const phrase = kind === 'change' ? CLIENT_QUESTION_MESSAGES.changeKeptAsk
                    : when ? CLIENT_QUESTION_MESSAGES.deadlineKeptAskWhen : CLIENT_QUESTION_MESSAGES.deadlineKeptAsk;
                  plan = { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
                  return await decided(200, chatAnswer(say(phrase, lang, { title: name(false), question: brief.text, ...(when ? { when } : {}) }),
                    { keptWithBrief: brief.briefUpdateId }));
                }
              }
              /**
               * Conversation fuzz (2026-10-03): an organisation's name sent alone with nothing open ("KAAE", "for Erbil Chess
               * Club") opened a request for a designer named after it, or went to the office as words about a design "no longer
               * open". Its sender is asked what to design for it, nothing opens, and the brief that follows is for it.
               */
              const scopeOfSender = senderScopeOf(update);
              if (!priorIntent && !mediaKind && !waiting.question && !askedAboutBrief && scopeOfSender &&
                  (plan.kind === 'open' || plan.kind === 'conversation' || plan.kind === 'forward') &&
                  !requests.some((r) => ['designing', 'awaiting_answer', 'in_review', 'manual', 'approved', 'delivering'].includes(r.stage))) {
                const bare = await withRlsContext(db, system, (trx) => bareOrganisationName(trx, TENANT, chatId, text));
                if (bare) {
                  await withRlsContext(db, system, (trx) => recordNamedOrganisation(trx, TENANT, { updateId: update.update_id, chatId,
                    senderId: scopeOfSender.senderId, topicId: scopeOfSender.topic, name: bare.name, clientId: bare.clientId, at: new Date().toISOString() }));
                  plan = { kind: 'reply', what: 'nothing-to-change', requestIds: [] };
                  return await decided(200, chatAnswer(say(CLIENT_QUESTION_MESSAGES.whatToDesignFor, lang, { client: bold(bare.name) }),
                    { namedOrganisation: bare.name }));
                }
              }
              if (!priorIntent && (plan.kind === 'open' || plan.kind === 'revise' || plan.kind === 'redo' || plan.kind === 'conversation')) {
                // The side effect has its own receipt; this one keeps the reading for the next replay.
                const stored = await withRlsContext(db, system, (trx) => recordIntentReceipt(trx, TENANT, receipt()));
                if (stored.payloadHash !== payloadHash || stored.chatId !== chatId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
              }
              /**
               * ADR-156 (audit P2): a round planned on a request that moved on before it started (the office
               * sent it back, another message started it) is never left without an answer. The chat's
               * requests are read again and the words planned once more; a second miss goes to the office.
               */
              const replan = async (why: string): Promise<Response> => {
                log.warn(`[core:internal] update ${update.update_id}: the planned round could not start (${why}); reading the chat again`);
                const fresh = await withRlsContext(db, system, (trx) => activeChatRequests(trx, TENANT, chatId, 7));
                const words = plan.kind === 'revise' || plan.kind === 'redo' ? plan.directive : text;
                const again = planTurn({ text: words, reading, requests: fresh,
                  bound: bindings.requestIds, unboundReply: false, senderId, officeIds: ctx.telegramAllowedUsers, group,
                  addressed: true, pendingAsk: null, now: Date.now() });
                // Only a plan about the same words on a current design: never a new request, never chat.
                const safe = again.kind === 'note' || again.kind === 'ask' || again.kind === 'tell' || again.kind === 'revise' || again.kind === 'redo';
                return carryOut(safe ? again : { kind: 'forward', words }, fresh, true);
              };
              const carryOut = async (plan: TurnPlan, requests: ChatRequestView[], retried = false): Promise<Response> => {
              const byId = (id: string) => byRequest(requests, id);
              switch (plan.kind) {
                case 'open': {
                  // A brief held for photos was read before it was held: an edit since then gives its words.
                  // ADR-156 (audit #10): the rest of a long message Telegram split, or forwards sent with it,
                  // were joined to the held brief while it waited.
                  const first = editedWords !== null && !plan.resolves ? editedWords.trim() : plan.text;
                  const words = await withBriefParts(first, plan.resolves ? null : update.update_id);
                  // ADR-182: a brief typed as several messages is read whole: complete, it is drafted as any
                  // complete brief is, not left to a designer because its first line alone said little.
                  return await openBrief(words, words === first ? plan.instructionOnly : plan.instructionOnly && opensForAPerson(words));
                }
                case 'revise': {
                  const target = byId(plan.requestId);
                  if (!target || !waitsForRequester(target)) return retried ? carryOut({ kind: 'forward', words: plan.directive }, requests, true)
                    : replan('STALE_REVISION');
                  try {
                    return await reviseRequest({ request_id: target.requestId, rev: target.rev,
                      stage: target.stage as WaitingLifecycleRequest['stage'], current_task_id: target.currentTaskId,
                      client_id: target.clientId, question: target.question }, plan.directive,
                    plan.redo ? { redo: true, answer: redoText(target.stage, target.title, lang, true) } : {});
                  } catch (err) {
                    if (!(err instanceof LifecycleProjectionConflict) || !['STALE_REVISION', 'WRONG_STAGE', 'NOT_CURRENT_DRAFT'].includes(err.code)) throw err;
                    return retried ? carryOut({ kind: 'forward', words: plan.directive }, requests, true) : replan(err.code);
                  }
                }
                case 'redo': {
                  // ADR-200 addendum: redo words about a design delivered recently start a new round of its
                  // request, with the words as the change ("I'll redo …").
                  const target = byId(plan.requestId);
                  const asNote: TurnPlan = { kind: 'note', note: 'change', requestId: plan.requestId, words: plan.directive, redo: true,
                    ...(plan.resolves ? { resolves: plan.resolves } : {}) };
                  if (!target || target.stage !== 'delivered') {
                    return retried || !target ? carryOut(target ? asNote : { kind: 'forward', words: plan.directive }, requests, true)
                      : replan('STALE_REVISION');
                  }
                  try {
                    return await reviseRequest({ request_id: target.requestId, rev: target.rev, stage: 'delivered',
                      current_task_id: target.currentTaskId, client_id: target.clientId, question: null }, plan.directive,
                    { reopen: true, answer: redoText('delivered', target.title, lang, true) });
                  } catch (err) {
                    if (!(err instanceof LifecycleProjectionConflict)) throw err;
                    // A design a designer made by hand, or one whose brief cannot be found: the office redoes
                    // it, with the words kept on it. The day's allowance used up is told as any change's is.
                    // ADR-231: this update's receipt already holds the redo plan, so the note's answer is the one
                    // given now (as after a replan); without it the requester got IDEMPOTENCY_CONFLICT and no answer.
                    if (['WRONG_STAGE', 'PARENT_BRIEF_MISSING'].includes(err.code)) return carryOut(asNote, requests, true);
                    if (!['STALE_REVISION', 'NOT_CURRENT_DRAFT'].includes(err.code)) throw err;
                    return retried ? carryOut(asNote, requests, true) : replan(err.code);
                  }
                }
                case 'conversation':
                  return await answerChat(update);
                case 'passive':
                  // Group conversation is kept as a passive message, as lifecycle-chat-answers.ts keeps it.
                  if (!priorIntent) {
                    const stored = await withRlsContext(db, system, (trx) => recordIntentReceipt(trx, TENANT, receipt()));
                    if (stored.payloadHash !== payloadHash || stored.chatId !== chatId) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  }
                  return await answerChat(update);
                case 'reply': {
                  if (rereadEdit && plan.what === 'thanks') return await decided(200, { edit: 'unchanged', intent: reading.intent });
                  const shown = plan.requestIds.map(byId).filter((r): r is ChatRequestView => Boolean(r));
                  // ADR-182: asked about a design taking longer than usual, the office is told and the
                  // requester hears so, rather than "it usually takes a few minutes" an hour later.
                  const now = Date.now();
                  const slow = plan.what === 'status' ? slowDesigns(shown, now) : [];
                  const office = slow.length ? officeChatFor(chatId) : undefined;
                  const alerted = Boolean(office && office !== chatId);
                  const words = plan.what === 'thanks' ? thanksText(shown, lang)
                    : plan.what === 'status' ? statusText(shown, lang, new Set(alerted ? slow.map((r) => r.requestId) : []))
                      // ADR-230 addendum (L12): a cancel with nothing open to withdraw.
                      : plan.what === 'nothing-to-cancel' ? nothingToCancelText(shown, lang)
                      : nothingToChangeText(lang);
                  return await decided(200, chatAnswer(words, alerted
                    ? { officeAlert: { chatId: office!, text: slowDesignOfficeAlert(whoSent(update), slow, now) } } : {}));
                }
                case 'ask': {
                  // ADR-156: the photo asked about is kept under this update, and the answer carries it.
                  if (plan.photo && photoInput && !retried) {
                    const refused = await keepPhotoForAnswer(photoInput.fileId);
                    if (refused) return refused;
                  }
                  return await decided(200, chatAnswer(askText(plan, lang), { choiceRequired: true }));
                }
                case 'forward': {
                  const office = officeChatFor(chatId);
                  const alerted = Boolean(office && office !== chatId);
                  return await decided(200, chatAnswer(forwardText(lang, alerted, plan.question === true),
                    alerted ? { officeAlert: { chatId: office!, text: retried ? conflictOfficeAlert(whoSent(update), plan.words)
                      : plan.question ? questionOfficeAlert(whoSent(update), plan.words) : forwardOfficeAlert(whoSent(update), plan.words) } } : {}));
                }
                case 'tell': {
                  const target = byId(plan.requestId);
                  if (!target) return await decided(200, chatAnswer(statusText([], lang)));
                  const office = officeChatFor(chatId);
                  const alert = office && office !== chatId ? { chatId: office, text: tellOfficeAlert(plan.note, {
                    who: whoSent(update), taskId: target.currentTaskId, title: target.title, words: plan.words,
                    stage: target.stage }) } : null;
                  return await decided(200, chatAnswer(tellText(plan.note, target.title, lang, Boolean(alert)),
                    { requestId: target.requestId, note: plan.note, ...(alert ? { officeAlert: alert } : {}) }));
                }
                case 'cancel-all': {
                  // ADR-255: several designs named together ("cancel both of them"). One decision names them all;
                  // ChatInbox hands each to its own RequestLifecycle, which closes it (Core checks this decision)
                  // and tells the requester, or, for one approved or sent meanwhile, keeps the cancel and says so.
                  const targets = plan.requestIds.map(byId).filter((r): r is ChatRequestView => Boolean(r) && OPEN_LIFECYCLE_STAGES.includes(r!.stage));
                  const withdrawable = targets.filter((r) => (WITHDRAWABLE_STAGES as readonly string[]).includes(r.stage));
                  const resolves = plan.resolves ? { resolves: plan.resolves } : {};
                  if (targets.length < 2 || !withdrawable.length) {
                    // One left (or none that can still be withdrawn): a cancel of one design, as before.
                    const one = withdrawable[0] ?? targets[0];
                    return one ? carryOut({ kind: 'note', note: 'cancel', requestId: one.requestId, words: plan.words, ...resolves }, requests, retried)
                      : await decided(200, chatAnswer(statusText([], lang)));
                  }
                  return await decided(200, { lifecycleAction: 'withdraw', chatId, requestId: withdrawable[0].requestId,
                    requestIds: [withdrawable[0], ...targets.filter((r) => r !== withdrawable[0])].map((r) => r.requestId),
                    requestStage: withdrawable[0].stage, intent: reading.intent });
                }
                case 'note': {
                  const target = byId(plan.requestId);
                  if (!target) return await decided(200, chatAnswer(statusText([], lang)));
                  // ADR-230: a cancel the plan is sure of withdraws a request nothing has been approved for.
                  // The decision is recorded here; RequestLifecycle closes the request (Core checks this
                  // decision) and tells the requester and the office once it is closed.
                  if (plan.note === 'cancel' && (WITHDRAWABLE_STAGES as readonly string[]).includes(target.stage)) {
                    return await decided(200, { lifecycleAction: 'withdraw', chatId, requestId: target.requestId,
                      requestStage: target.stage, intent: reading.intent });
                  }
                  // ADR-156 (audit #11, #12): a photo sent with the words, or kept with a question these
                  // words answer, is material for a design still being made; after that it stays in the chat.
                  const material = plan.note === 'change' && (MATERIAL_STAGES as readonly string[]).includes(target.stage);
                  let image: BlobRef | null = null;
                  let heldFrom: number | null = null;
                  if (material && boundPhoto && !plan.resolves) {
                    image = boundPhoto;
                  } else if (material && photoInput && !plan.resolves) {
                    if (!ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                    const photo = await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                      (id) => ctx.telegramBridge!.downloadFile(id), photoInput.fileId);
                    if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                    if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                    if (photo.kind === 'unsupported') return await holdMedia('photoUnreadable');
                    image = photo.ref;
                  } else if (material && plan.resolves) {
                    const held = await withRlsContext(db, system, (trx) => readHeldPhoto(trx, TENANT, plan.resolves!));
                    if (held && held.chatId === chatId && held.senderId === senderId) { image = held.image; heldFrom = held.updateId; }
                  }
                  // ADR-250 (friction 3): a photo its sender sent with no words just before this change goes with
                  // it, as it goes with a brief or a round (ADR-145): material while the design can use it, else
                  // passed to the office with the words. It was dropped here, and later taken by unrelated words.
                  let passedFrom: number | null = null;
                  const sentJustBefore = plan.note === 'change' && !photoInput && !boundPhoto && !admittedAlbum && !plan.resolves
                    ? senderScopeOf(update) : null;
                  if (sentJustBefore) {
                    const held = (await withRlsContext(db, system, async (trx) =>
                      outsideBursts(trx, TENANT, await waitingPhotos(trx, TENANT, sentJustBefore)))).at(-1) ?? null;
                    if (held && material) { image = held.image; heldFrom = held.updateId; }
                    else if (held) passedFrom = held.updateId;
                  }
                  const title = bold(shortTitle(target.title));
                  const stored = await withRlsContext(db, system, async (trx) => {
                    let used: 'added' | 'passed' | null = null;
                    if (image && heldFrom !== null) {
                      // One photo is used once: words that took it first keep it.
                      const claim = await claimPhoto(trx, TENANT, heldFrom, { byUpdateId: update.update_id, how: 'joined', requestId: target.requestId });
                      if (claim.byUpdateId !== update.update_id) image = null;
                    }
                    let photoPassed = false;
                    if (passedFrom !== null) {
                      const claim = await claimPhoto(trx, TENANT, passedFrom, { byUpdateId: update.update_id, how: 'passed', requestId: target.requestId });
                      photoPassed = claim.byUpdateId === update.update_id;
                    }
                    const into = { requestId: target.requestId, taskId: target.currentTaskId, stage: target.stage };
                    if (image) used = await addPhotoMaterial(trx, TENANT, into, image);
                    // ADR-160 addendum: an album's (or a photo burst's) photos are its material too.
                    let albumUsed: 'added' | 'passed' | null = null;
                    if (material && admittedAlbum && !plan.resolves) {
                      for (const albumImage of admittedAlbum.ref.images) {
                        if ((albumUsed = await addPhotoMaterial(trx, TENANT, into, albumImage)) === 'passed') break;
                      }
                    }
                    // A photo with no words that became the design's own material needs no note (ADR-145's rule).
                    if (used === 'added' && photoWithoutWords) {
                      const answer = { status: 200, extra: chatAnswer(say(MEDIA_MESSAGES.photoAdded, lang, { title }),
                        { media: 'photo-joined', requestId: target.requestId }) };
                      return { stored: await recordIntentReceipt(trx, TENANT, receipt(answer)), answer };
                    }
                    const photoLine = used ? photoMaterialLine(used)
                      : photoInput ? '[The requester also sent a photo. It is in the Telegram chat.]'
                        : photoPassed ? '[The requester sent a photo just before these words. It is in the Telegram chat.]'
                        : albumUsed === 'added' ? `[The requester sent ${admittedAlbum!.ref.images.length} photos with this. They were added to the design's files.]`
                          : admittedAlbum ? '[The requester also sent an album of photos with these words. They are in the Telegram chat.]' : '';
                    const words = photoLine ? `${photoWithoutWords ? '(no words)' : plan.words}\n${photoLine}` : plan.words;
                    const held = plan.note === 'hold' && await pauseRequesterDesign(trx,TENANT,
                      {requestId:target.requestId,taskId:target.currentTaskId,requestRev:target.rev,requestStage:target.stage,text:words},update.update_id);
                    const said = photoWithoutWords && material ? say(MEDIA_MESSAGES.photoPassed, lang, { title })
                      // ADR-230: a cancel kept as a note came too late; the requester hears that, truthfully.
                      : plan.note === 'cancel' ? withdrawTooLateText(target.stage, target.title, lang, Boolean(officeChatFor(chatId)),
                        requestLabel({ title: target.title, askedAt: target.createdAt, words: target.words }, lang))
                      : noteText(plan.note, spokenStage(target), target.title, lang, held, plan.redo === true,
                        plan.feedback === true);
                    const late: LateRequesterChange = { requestId: target.requestId, taskId: target.currentTaskId,
                      requestRev: target.rev, requestStage: target.stage as LateChangeStage, text: words,
                      kind: plan.note, ...(plan.note === 'hold' ? {held} : {}), title: shortTitle(target.title), answer: said };
                    const refusal = await recordRoutingRefusal(trx, TENANT, update.update_id,
                      { code: 'LATE_REQUESTER_CHANGE', chatId, payloadHash, late });
                    if (refusal.payloadHash !== payloadHash || refusal.chatId !== chatId ||
                        refusal.code !== 'LATE_REQUESTER_CHANGE' || !refusal.late) return null;
                    // ADR-250 (friction 3): the requester hears where the photo they sent just before went.
                    const photoNotice = heldFrom !== null && !plan.resolves && used
                      ? say(used === 'added' ? MEDIA_MESSAGES.photoAdded : MEDIA_MESSAGES.photoPassed, lang, { title })
                      : photoPassed ? say(MEDIA_MESSAGES.photoPassed, lang, { title }) : null;
                    const answer = { status: 409, extra: { ...lateChangeAnswer(chatId, refusal.late, update), intent: reading.intent,
                      ...(photoNotice ? { notice: { text: photoNotice, parseMode: 'HTML' } } : {}) } };
                    return { stored: await recordIntentReceipt(trx, TENANT, receipt(answer)), answer };
                  });
                  if (!stored || stored.stored.payloadHash !== payloadHash) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  // A note made after a round could not start: this update's receipt keeps that plan, and
                  // the note itself (the late-change record) is what a replay gives.
                  const answer = stored.stored.answer ?? (retried ? stored.answer : null);
                  if (!answer) return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                  await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatId, status: answer.status });
                  return handled(answer.status, answer.extra);
                }
              }
              };
              /** Keeps the photo asked about under this update, for the answer (a refusal response, or null). */
              const keepPhotoForAnswer = async (fileId: string): Promise<Response | null> => {
                const scope = senderScopeOf(update);
                if (!scope) return null;
                if (!await withRlsContext(db, system, (trx) => readHeldPhoto(trx, TENANT, update.update_id))) {
                  if (!boundPhoto && !ctx.telegramBridge) return handled(503, { code: 'NOT_CONFIGURED' });
                  const photo = boundPhoto ? { kind: 'stored' as const, ref: boundPhoto }
                    : await retainLifecyclePhoto(blobStoreFor(db, ctx.options?.blobStore),
                      (id) => ctx.telegramBridge!.downloadFile(id), fileId);
                  if (photo.kind === 'store_unavailable') return handled(503, { code: 'NOT_CONFIGURED' });
                  if (photo.kind === 'download_unavailable') return handled(503, { code: 'PHOTO_UNAVAILABLE' });
                  if (photo.kind === 'unsupported') return await holdMedia('photoUnreadable');
                  await withRlsContext(db, system, (trx) => holdPhoto(trx, TENANT, { updateId: update.update_id, chatId: scope.chatId,
                    senderId: scope.senderId, topic: scope.topic, messageId: String(message.message_id ?? ''), image: photo.ref }, payloadHash, update));
                }
                // Asked about: no settle asks again, and it waits as long as the question does.
                await withRlsContext(db, system, (trx) => markPhotoAsked(trx, TENANT, update.update_id));
                return null;
              };
              return await carryOut(plan, requests);
            }

            // Photos, albums and a replayed revision photo keep the routing they had (media admission
            // is its own change): bound by a reply, or to the one request that waits.
            const { waiting, links } = await withRlsContext(db, system, async (trx) => ({
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
              const targets = await withRlsContext(db, system,
                (trx) => lateChangeTargets(trx, TENANT, chatId, replyMessageId));
              if (targets.length === 1) {
                const words = photoInput
                  ? `${photoInput.captionless ? '(no words)' : directive}\n[The requester also sent a photo. It is in the Telegram chat and was not kept.]`
                  : directive;
                const late: LateRequesterChange = { ...targets[0], text: words };
                const stored = await withRlsContext(db, system,
                  (trx) => recordRoutingRefusal(trx, DEFAULT_TENANT_ID, update.update_id,
                    { code: 'LATE_REQUESTER_CHANGE', chatId, payloadHash, late }));
                if (stored.payloadHash !== payloadHash || stored.chatId !== chatId ||
                    stored.code !== 'LATE_REQUESTER_CHANGE' || !stored.late) {
                  return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
                }
                return handled(409, lateChangeAnswer(chatId, stored.late, update));
              }
            }
            if (replyMessageId && (links.length === 0 || newCommand)) return await refuseWithReceipt('STALE_REQUEST_REPLY');
            if (links.length > 1) return await refuseWithReceipt('AMBIGUOUS_REQUEST');
            // A captioned photo brief opens a request when nothing waits, or with /new.
            const mayOpen = Boolean(msg) && !replyMessageId && (Boolean(newCommand) || waiting.length === 0);
            if (mayOpen) {
              const classification = classifyWithHeuristics(newBriefText, false, false);
              if (classification.kind !== 'new_brief') {
                if (newCommand) return handled(422, { code: 'NEW_BRIEF_EMPTY',
                  lifecycleAction: 'new-brief-required', chatId });
                // Questions, greetings and lasting preferences are answered below
                // (lifecycle-chat-answers.ts): they never become design tasks.
              } else {
                return await openBrief(newBriefText, classification.isInstructionOnly);
              }
            }
            const choice = chooseWaitingChatRequest(waiting.map((r) =>
              ({ requestId: r.request_id, rev: Number(r.rev) })), links[0]);
            if (choice.kind === 'ambiguous' || choice.kind === 'stale_reply') {
              return await refuseWithReceipt(choice.kind === 'ambiguous' ? 'AMBIGUOUS_REQUEST' : 'STALE_REQUEST_REPLY');
            }
            const openRequest = choice.kind === 'target'
              ? waiting.find((r) => r.request_id === choice.requestId) : undefined;
            if (priorRevisionPhoto && priorRevisionPhoto.requestId !== openRequest?.request_id) {
              return handled(409, { code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (openRequest) return await reviseRequest(openRequest, directive);
            // A photo whose words are not a brief, with no design waiting for it: kept for the words, and
            // asked about (ADR-145). Album photos that answer no current design are explained.
            if (photoInput) {
              const kept = await mediaRoute.holdPhotoUpdate(update, chatId, payloadHash, albumSettleMs(), { fileId: photoInput.fileId }, boundPhoto);
              if (kept) return handled(kept.status, kept.extra);
            }
            if (photoInput || admittedAlbum) return await holdMedia(admittedAlbum ? 'photosUnplaced' : 'photoUnreadable');
            // No waiting request and not a new brief (a question, a greeting, a rule): the chat's
            // answer below.
          } catch (err) {
            if (err instanceof LifecycleProjectionConflict) {
              log.warn(`[core:internal] lifecycle intake conflict for update ${update.update_id}: ${err.code} ${err.message}`);
              if (err.code === 'DAILY_CAP_REACHED' || err.code === 'PARENT_BRIEF_MISSING') {
                return await refuseWithReceipt(err.code);
              }
              // Treat projection conflicts as a handled non-retryable result (409-like). ADR-156 (audit P2):
              // never without an answer: the requester hears the office has the words, and the office does.
              const office = officeChatFor(chatId);
              const alerted = Boolean(office && office !== chatId);
              return handled(409, { code: err.code, detail: err.message, lifecycleAction: 'chat-answer', chatId,
                chatAnswer: { text: forwardText(photoInput?.captionless ? 'en' : langOf(rawText), alerted), parseMode: 'HTML' },
                ...(alerted ? { officeAlert: { chatId: office!, text: conflictOfficeAlert(whoSent(update),
                  photoInput?.captionless ? '(a photo with no words, in the chat)' : rawText.trim()) } } : {}) });
            }
            if ((err as { status?: number })?.status === 503) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
            throw err; // unexpected; let Restate retry
          }
        }
      }
    }

    // --- anything the lifecycle path did not take: a greeting, a question, a rule, a command ---
    return await answerChat(update);
  };

  internal('/telegram/intake', async (c) => {
    const response = await intakeHandler(c);
    // N5 (ADR-145): a sender outside the intake list is answered once per chat per day, in words, and
    // nothing else of theirs is kept; every other refusal of theirs that day says nothing (`quiet`).
    if (response.status !== 200 || !db) return response;
    const answer = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (answer?.intakeStatus !== 403 || answer.code !== 'SENDER_NOT_ALLOWED' || answer.lifecycleAction) return response;
    const body = await readBody(c);
    const update = body?.update;
    if (!isUpdate(update)) return response;
    const said = await mediaRoute.notAllowed(update as UpdateLike & Record<string, unknown>, chatOf(update));
    return c.json({ v: 1, kind: 'handled', intakeStatus: said.status, ...said.extra }, 200);
  });

  // ADR-143: the settles the worker's poller sends again: albums saved before settles existed (the
  // owner's album of 2026-09-29) and any whose delayed call was lost. Each settle decides for itself.
  internal('/telegram/settle-sweep', async (c) => {
    if (!db) return problem(c, 503, 'Database Unavailable', 'The sweep reads the saved albums');
    const due = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
      async (trx) => [...await overdueSettles(trx, DEFAULT_TENANT_ID),
        // ADR-235: kept briefs whose question nobody answered and whose own delayed settle was lost.
        ...await overdueClientQuestions(trx, DEFAULT_TENANT_ID) as Array<{ chatId: string; update: any }>,
        // ADR-145: kept photos never settled, and messages set behind a held brief never read.
        ...await overduePhotos(trx, DEFAULT_TENANT_ID), ...await overdueDeferrals(trx, DEFAULT_TENANT_ID)]);
    return c.json({ v: 1, due }, 200);
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
        // The offset is the worker poller's: it moved past the update when Restate accepted it. Every
        // office member but the sender's own chat hears of it (ADR-155 section 6).
        await parkTelegramUpdate(db, scope, update, reason, { officeChatIds: officeChatsFor(parkedUpdateChat(update)) });
        log.error(`[core:internal] update ${update.update_id} parked for an operator: ${reason}`);
        const chat = parkedUpdateChat(update);
        if (body?.notifySender !== false && chat && ctx.telegramBridge) {
          // Best effort, as before: the dead letter and the office alert are what must not be lost.
          const carrier = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
          await ctx.telegramBridge.dispatchOutboundMessage(chat, { text: say(INBOX_MESSAGES.couldNotRead, requesterLang(wordsOf(carrier ?? null))) })
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

  internal('/customer/actions/:actionId/:operation',async c=>{
    if(!db)return problem(c,503,'Database Required');
    const body=await readBody(c),operation=c.req.param('operation'),id=c.req.param('actionId');
    const event=operation==='event' ? body : body?.event;
    if(!isCustomerActionCommand(event) || event.tenantId!==DEFAULT_TENANT_ID || event.actionId!==id)
      return c.json({code:'DESIGN_ACTION_INVALID'},403);
    try {
      if(operation==='event')return c.json(await customerActionEvent(db,event));
      if(!isCustomerActionEvent(event))return c.json({code:'DESIGN_ACTION_INVALID'},403);
      if(operation==='project') {
        const basis=body?.basis as {taskId:string;rev:number;stage:string;round:number;questionId?:string}|undefined;
        if(!basis || typeof basis.taskId!=='string' || !UUID.test(basis.taskId) || !Number.isSafeInteger(basis.rev) || basis.rev<0 ||
          typeof basis.stage!=='string' || !Number.isSafeInteger(basis.round) || basis.round<0 || basis.round>10000 ||
          (basis.questionId!==undefined && !UUID.test(basis.questionId)))return c.json({code:'DESIGN_ACTION_INVALID'},403);
        return c.json(await projectCustomerAction(db,event,basis,ctx.canvaConnectService ?? undefined));
      }
      if(operation==='ack') {
        const result=body?.result as CustomerActionResult|undefined;
        if(!result || result.v!==1 || result.actionId!==event.actionId || result.requestId!==event.requestId || !result.accepted)
          return c.json({code:'DESIGN_ACTION_INVALID'},403);
        return c.json(await acknowledgeCustomerAction(db,event,result));
      }
      return c.json({code:'DESIGN_ACTION_INVALID'},404);
    } catch(error) {
      if(error instanceof CustomerActionError)return c.json({code:error.code},error.status);
      if(error instanceof LifecycleProjectionConflict)return c.json({code:error.code},409);
      return c.json({code:'DESIGN_SERVICE_UNAVAILABLE'},503);
    }
  });
  internal('/customer/:requestId/open-event', async c => {
    const id=c.req.param('requestId') ?? '';
    if(!UUID.test(id)) return problem(c,400,'Invalid customer request','A request UUID is required');
    if(!db) return problem(c,503,'Database Unavailable','The web request needs its retained evidence');
    const refs=await readBody(c);
    if(!isCustomerOpenCommand(refs)) return problem(c,400,'Invalid customer command','Stored command references are required');
    try { return c.json(await customerWebOpenEvent(db,DEFAULT_TENANT_ID,id,refs)); }
    catch(error) {
      if(error instanceof LifecycleProjectionConflict) return c.json({code:error.code,detail:error.message},409);
      return problem(c,503,'Customer Request Unavailable','The admission could not be read');
    }
  });
  internal('/customer/web-message', async c => {
    const body=await readBody(c);
    if(!db) return problem(c,503,'Database Unavailable','The web message needs durable storage');
    try { return c.json(await recordCustomerWebMessage(db,DEFAULT_TENANT_ID,body as unknown as import('@hawa/contracts').OutboundMessage)); }
    catch(error) {
      if(error instanceof LifecycleProjectionConflict) return c.json({code:error.code,detail:error.message},409);
      return problem(c,503,'Web Message Unavailable','The message record did not commit');
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
        // The task's first design run, or an office retry's attempt run (ADR-142).
        typeof runId !== 'string' || (runId !== `dr-${taskId}` && !new RegExp(`^dr-${taskId}-a[1-9][0-9]*$`).test(runId)) ||
        body.key !== `${requestId}:${rev}:designFinished:${runId}` ||
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
            sessionHash: actor.sessionHash as string } : {}),
          // ADR-040 addendum: an office member deciding in their private Telegram chat, by its id.
          ...(actor.authMethod === 'telegram_office' && typeof actor.telegramChatId === 'string' &&
            /^[1-9][0-9]{0,19}$/.test(actor.telegramChatId) ? { authMethod: 'telegram_office' as const,
            telegramChatId: actor.telegramChatId } : {}) },
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

  // ADR-142: the office runs a design that ended without a draft again, on the same task, under a new
  // attempt run. manual (rev N) -> designing (rev N+1); the task failed_operator -> received.
  internal('/lifecycle/:requestId/office-retry', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor)
      ? op.actor as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 2 ||
        rev !== expectedRev + 1 || op?.kind !== 'retryDesign' ||
        !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.actionId || '')) ||
        body.key !== `${requestId}:${rev}:officeRetry:desk:${op.actionId}` ||
        !actor || !UUID.test(String(actor.userId || '')) || typeof actor.role !== 'string' || actor.role.length > 60 ||
        typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 2000) {
      return problem(c, 400, 'Invalid office retry', 'Expected one versioned retryDesign action for the current request');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleOfficeRetry(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string, actionId: op.actionId as string,
        actor: { userId: actor.userId as string, role: actor.role }, reason: op.reason.trim(),
        expectedRev, rev, key: body.key as string,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle office retry ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The office retry did not commit; retry with the same key');
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
  // ADR-230: RequestLifecycle withdraws a request (its requester's cancel, or the office's Cancel in the
  // Desk): the request is closed (`cancelled`) with its current task, under one receipt. A requester's
  // cancel that came too late is kept for the office and answered truthfully; the request is unchanged.
  internal('/lifecycle/:requestId/withdraw', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor) ? op.actor as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    const eventId = typeof op?.eventId === 'string' ? op.eventId : '';
    const parsedActor: WithdrawActor | null = actor?.kind === 'requester' && Number.isSafeInteger(actor.updateId) && Number(actor.updateId) > 0
      ? { kind: 'requester', updateId: Number(actor.updateId) }
      : actor?.kind === 'office' && UUID.test(String(actor.userId || '')) && typeof actor.role === 'string' && actor.role.length <= 60
        ? { kind: 'office', userId: String(actor.userId), role: actor.role } : null;
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 1 || rev !== expectedRev + 1 ||
        op?.kind !== 'withdraw' || !UUID.test(String(op.taskId || '')) || !parsedActor ||
        body.key !== `${requestId}:${rev}:withdraw:${eventId}` ||
        typeof op.reason !== 'string' || op.reason.length > 2000 || (parsedActor.kind === 'office' && !op.reason.trim())) {
      return problem(c, 400, 'Invalid withdraw', 'Expected one versioned withdraw of the current request by its requester or the office');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleWithdraw(db, { requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string,
        eventId, actor: parsedActor, reason: (op.reason as string).trim(), expectedRev, rev, key: body.key as string });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle withdraw ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The withdraw did not commit; retry with the same key');
    }
  });

  // ADR-230: a design run that finished after its request was withdrawn is recorded, and goes nowhere.
  internal('/lifecycle/:requestId/withdrawn-outcome', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const taskId = String(body?.taskId || '');
    const runId = String(body?.runId || '');
    const report = body?.report && typeof body.report === 'object' && !Array.isArray(body.report) ? body.report as Record<string, unknown> : null;
    if (!UUID.test(requestId) || body?.v !== 1 || !UUID.test(taskId) ||
        (runId !== `dr-${taskId}` && !new RegExp(`^dr-${taskId}-a[1-9][0-9]*$`).test(runId)) ||
        body.eventId !== `dr-finished:${runId}` || !report || JSON.stringify(report).length > 4000) {
      return problem(c, 400, 'Invalid withdrawn outcome', 'Expected the finished run of a withdrawn request');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle record requires a database');
    try {
      return c.json({ v: 1, ...await recordWithdrawnOutcome(db, { requestId, tenantId: DEFAULT_TENANT_ID, taskId, runId,
        eventId: body.eventId as string, report }) }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code, detail: error.message }, 409);
      log.error(`[core:internal] withdrawn outcome ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Record Unavailable', 'The record did not commit; retry the same report');
    }
  });

  // ADR-230 repair: a delivery that finished chat-only before chat-only deliveries closed their request.
  internal('/lifecycle/:requestId/delivery-reconcile', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 5 || rev !== expectedRev + 1 ||
        op?.kind !== 'reconcileDelivery' || !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.approvalId || '')) ||
        typeof op.deliveryId !== 'string' || !Number.isInteger(op.run) || Number(op.run) < 1 ||
        body.key !== `${requestId}:${rev}:deliveryReconciled:${op.deliveryId}`) {
      return problem(c, 400, 'Invalid delivery repair', 'Expected one versioned repair of the current delivery');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await reconcileLifecycleChatOnlyDelivery(db, { requestId, tenantId: DEFAULT_TENANT_ID,
        taskId: op.taskId as string, approvalId: op.approvalId as string, deliveryId: op.deliveryId as string,
        run: op.run as number, expectedRev, rev, key: body.key as string });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code, detail: error.message }, 409);
      log.error(`[core:internal] lifecycle delivery repair ${requestId} failed:`, error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The repair did not commit; retry with the same key');
    }
  });
}
