/**
 * ChatInbox: one Virtual Object per Telegram chat (architecture programme Phase 2.1, ADR-034,
 * PHASE2_DESIGN.md section 2.2).
 *
 * The poller (telegram-poller.ts) sends every update here, keyed by its chat, with idempotency key
 * `tg-<update_id>`. Restate runs one update at a time per chat, in order, and chats side by side, so a
 * long download in one chat no longer holds the others. The handler passes the stored per-chat mode to
 * Core intake and sends lifecycle decisions under a stable key; repeated failures park the update.
 *
 * The rules are those of Core's polled-update-dispatch.ts, with the attempt count held in Restate's
 * journal instead of a Postgres row:
 *  - intake's deliberate answer (2xx, or a 4xx refusal) is final;
 *  - a retryable answer (5xx, 408, 429, or no answer in time) is journaled, and after 2, 4, 8 and
 *    16 s the update is tried again; after five such answers it is parked (Core stores the dead
 *    letter, alerts the office and tells the sender). The chat waits about 30 s at most, as before;
 *  - a database outage, a thrown kill switch, or a Core that does not answer at all is not journaled:
 *    the step throws and Restate retries it until it can go on. Nothing could be saved or parked then
 *    either, and parking a client's message because Core was restarting would lose nothing but help
 *    nobody. Those retries never end in a dead letter; after many hours the invocation pauses, which
 *    /health reports.
 *
 * No handler here waits for a person, and none awaits another object: an invocation pins its chat for
 * the length of one intake call.
 */
import * as restate from '@restatedev/restate-sdk';
import { openCustomerWebRequest, type SignedCustomerOpenCommand } from './customer-web-entry.js';
import {forwardCustomerAction,type SignedCustomerActionCommand} from './customer-web-actions.js';
import { coreInternalFromEnv } from './delivery.js';
import type { OutboundMessage } from '@hawa/contracts';
import { withInvocationLogContext, log } from '../logging.js';
import type { TelegramUpdateLike } from './telegram-poller.js';
import type { OpenAutomaticEvent, OpenManualEvent, RequesterDecisionEvent, WithdrawEvent } from './request-lifecycle.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { officeAlertKey, officeAlertRoute } from './office-chats.js';
import { ACCESS_MESSAGES, INBOX_MESSAGES, requesterLang, say, type RequesterLang } from '@hawa/integrations';

/** Fields are only ever added, and only as optional (PHASE2_DESIGN.md section 4). */
export interface HandleUpdateInput {
  v: 1;
  update: TelegramUpdateLike;
  /** When the poller took the update from Telegram (ms since the epoch). */
  polledAt?: number;
}

export type IntakeMode = 'legacy' | 'lifecycle';

/**
 * The request stages in which a requester's words are kept on the request for the office: after the
 * design reached the office (finding 13), and while it is still being made or waits (ADR-144).
 */
export type LateChangeStage = 'in_review' | 'approved' | 'delivering' | 'delivered' | 'designing' | 'manual' | 'awaiting_answer';
export const LATE_CHANGE_STAGES: readonly LateChangeStage[] = ['in_review', 'approved', 'delivering', 'delivered', 'designing', 'manual', 'awaiting_answer'];

/** What Core's intake answered, as journaled. */
export type IntakeAnswer =
  | { kind: 'done'; intakeStatus: number; duplicate?: boolean;
      /** When mode=lifecycle and Core routed the update as a requester revision. */
      lifecycleAction?: 'open-request' | 'new-brief-required' | 'requester-revision' | 'requester-answer' |
        'request-choice-required' | 'revision-blocked' | 'park-update' | 'album-message' | 'source-message' |
        'late-change' | 'chat-answer' | 'settle-later' |
        /** ADR-230: the requester's cancel withdraws `requestId`; RequestLifecycle answers once it is closed. */
        'withdraw';
      albumMessage?: string; albumNoticeKey?: string;
      /**
       * settle-later (ADR-143): settle this update after `delayMs` (a saved album photo, or a held brief;
       * since ADR-145 also a photo kept for its words, or a message set behind a held brief).
       */
      settle?: { kind: 'album' | 'brief' | 'photo'; delayMs: number };
      /** ADR-145: words Core says beside its answer, sent once per update. */
      notice?: { text: string; parseMode?: 'HTML' };
      /** ADR-235: the key the notice is sent under instead of the update's (a kept brief's timeout). */
      noticeKey?: string;
      /** ADR-235: "who is this design for?" was asked; settle the brief's update after `delayMs` (its timeout). */
      clientQuestionSettle?: { delayMs: number };
      /** ADR-145 (N5): a sender outside the intake list was already answered in this chat today. */
      quiet?: boolean;
      /**
       * chat-answer: Core's answer to a greeting, question, rule or command (ADR-135 stage 2c), and
       * since ADR-144 to thanks, a status question, a note passed to the office or a question back.
       * late-change: what the requester is told, in their language (ADR-144).
       */
      chatAnswer?: { text: string; parseMode?: 'HTML' };
      sourceMessage?: string; sourceNoticeKey?: string;
      draft?: OpenManualEvent['draft'] | OpenAutomaticEvent['draft'];
      /** open-request: the other requests the same update opens, one per language (ADR-139). */
      siblings?: Array<{ requestId: string; draft: OpenManualEvent['draft'] | OpenAutomaticEvent['draft'] }>;
      requestId?: string; newTaskId?: string; round?: number; directive?: string;
      /** withdraw (ADR-255): every request the requester's cancel named together, `requestId` first. */
      requestIds?: string[];
      priorTaskId?: string; rawText?: string; chatId?: string; questionId?: string;
      code?: 'AMBIGUOUS_REQUEST' | 'STALE_REQUEST_REPLY' | 'DAILY_CAP_REACHED' |
        'PARENT_BRIEF_MISSING' | 'QUESTION_MISSING' | 'LIFECYCLE_MEDIA_NOT_ADMITTED' | 'LATE_REQUESTER_CHANGE' |
        /** Reserved for new-brief-required; Core does not send it, and the answer names no command (ADR-144). */
        'NEW_BRIEF_REQUIRED';
      reason?: string;
      /**
       * late-change: the stage the request was in. late-change and chat-answer: Core's alert for the
       * office chat (if any), e.g. "the requester is happy with it" (ADR-144).
       */
      requestStage?: LateChangeStage; officeAlert?: { chatId: string; text: string };
      /** ADR-155 section 6: the same alert for every office member; the first is `officeAlert`. */
      officeAlerts?: Array<{ chatId: string; text: string }>; }
  | { kind: 'retry'; reason: string };

/** The Core calls ChatInbox makes (core-client.ts). A thrown error means "wait and try again". */
export interface ChatInboxCore {
  intake(update: TelegramUpdateLike, mode: IntakeMode, requestId?: string, options?: { settle?: boolean }): Promise<IntakeAnswer>;
  park(update: TelegramUpdateLike, reason: string): Promise<void>;
}

/** Context the setMode handler uses; tests pass a minimal stub. */
export interface SetModeContext {
  get<T>(name: string): Promise<T | null>;
  set(name: string, value: unknown): void;
}

/** The parts of Restate's ObjectContext the handler uses; tests pass a small journal. */
export interface InboxContext {
  get<T>(name: string): Promise<T | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
  set(name: string, value: unknown): void;
  now(): Promise<number>;
  /**
   * Fire-and-forget a requester decision to RequestLifecycle via Restate's objectSendClient.
   * Only available in the real VO context; tests may stub this as a no-op.
   */
  sendLifecycleDecision(requestId: string, event: RequesterDecisionEvent & { newTaskId: string }): Promise<void> | void;
  sendLifecycleOpen(requestId: string, event: OpenManualEvent | OpenAutomaticEvent): Promise<void> | void;
  /** ADR-230: fire-and-forget a requester's withdraw to RequestLifecycle; absent in older test harnesses. */
  sendLifecycleWithdraw?(requestId: string, event: WithdrawEvent): Promise<void> | void;
  sendNotice(message: OutboundMessage): void;
  /** A durable delayed call of this chat's `settle` handler (ADR-143), under a stable idempotency key. */
  scheduleSettle(input: SettleInput, delayMs: number, key: string): void;
}

/** A settle of an update Core has already saved: an album photo or a held text brief (ADR-143). */
export interface SettleInput {
  v: 1;
  update: TelegramUpdateLike;
  /** 0 for the settle the update itself scheduled; each "not yet" answer schedules the next. */
  attempt?: number;
}

/** A held brief waits for an album its sender is still sending; this bounds the re-checks. */
export const MAX_SETTLE_ROUNDS = 60;

export interface ChatInboxView {
  v: 1;
  lastUpdateId: number;
  lastOutcome: 'handled' | 'parked';
  lastIntakeStatus?: number;
  at: number;
  /** Set once when the first RequestLifecycle-owned request opens for this chat. Never reverts. */
  mode?: IntakeMode;
  /** Historical request hint; Core selects the actual target from current request state. */
  requestId?: string;
}

export interface HandleUpdateResult {
  outcome: 'handled' | 'parked';
  intakeStatus?: number;
  attempts: number;
}

export const INTAKE_ATTEMPTS = 5;

/**
 * The language the requester wrote in (ADR-145): Sorani when their words are mostly in Arabic script,
 * English when mostly Latin; the notices below answer in kind (requester-messages catalogue).
 */
function languageOf(update: TelegramUpdateLike): RequesterLang {
  const u = update as { message?: { text?: unknown; caption?: unknown }; edited_message?: { text?: unknown; caption?: unknown } };
  const message = u.message ?? u.edited_message;
  const words = typeof message?.text === 'string' ? message.text : typeof message?.caption === 'string' ? message.caption : '';
  return requesterLang(words);
}
/** The chat an update came from, for a notice Core gave no chat for (a bare refusal). */
function chatOfUpdate(update: TelegramUpdateLike): string | null {
  const u = update as { message?: { chat?: { id?: unknown } }; edited_message?: { chat?: { id?: unknown } } };
  const id = (u.message ?? u.edited_message)?.chat?.id;
  return Number.isSafeInteger(id) && Number(id) !== 0 ? String(id) : null;
}
/** Waits between retryable answers: 2, 4, 8 and 16 s, the backoff Core's poller used. */
const retryDelayMs = (k: number) => 2000 * 2 ** k;

export async function handleUpdate(ctx: InboxContext, input: HandleUpdateInput, core: ChatInboxCore): Promise<HandleUpdateResult> {
  const update = input.update;
  // Read state directly through Restate's context. A ctx.get inside ctx.run records a nested
  // journal operation that is skipped when the completed run replays after a crash.
  // A chat's first update arrives in legacy mode. Core answers both modes alike since ADR-135 (every
  // chat is lifecycle-owned); an open-request sets lifecycle mode for the chat's later updates.
  const view = await ctx.get<ChatInboxView>('inbox');
  const mode: IntakeMode = view?.mode === 'lifecycle' ? 'lifecycle' : 'legacy';
  const lifecycleRequestId = view?.mode === 'lifecycle' ? view.requestId : undefined;

  const reasons: string[] = [];
  let done: Extract<IntakeAnswer, { kind: 'done' }> | null = null;
  for (let k = 0; k < INTAKE_ATTEMPTS && !done; k++) {
    // Lines are written inside the step, so a replay of the journal does not write them again.
    const answer = await ctx.run(`intake-${k}`, async () => {
      const a = await core.intake(update, mode, lifecycleRequestId);
      if (a.kind === 'retry') log.warn(`[chat-inbox] update ${update.update_id} attempt ${k + 1}/${INTAKE_ATTEMPTS} failed: ${a.reason}`);
      else if (a.intakeStatus >= 400) log.warn(`[chat-inbox] update ${update.update_id} refused by intake with HTTP ${a.intakeStatus}`);
      return a;
    });
    if (answer.kind === 'done') {
      done = answer;
      break;
    }
    reasons.push(answer.reason);
    if (k < INTAKE_ATTEMPTS - 1) await ctx.sleep(retryDelayMs(k));
  }

  const at = await ctx.now();
  if (done) return applyAnswer(ctx, update, done, core, { mode, lifecycleRequestId, at, attempts: reasons.length + 1 });

  const reason = `${reasons[reasons.length - 1]} after ${INTAKE_ATTEMPTS} attempts`;
  // Core stores the dead letter (id and kind only), alerts the office and tells the sender, once.
  await ctx.run('park', async () => {
    await core.park(update, reason);
    log.error(`[chat-inbox] update ${update.update_id} parked for an operator: ${reason}`);
    return true;
  });
  ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'parked', at,
    ...(mode === 'lifecycle' ? { mode, requestId: lifecycleRequestId } : {}),
  } satisfies ChatInboxView);
  return { outcome: 'parked', attempts: INTAKE_ATTEMPTS };
}

/**
 * The settle of a saved album photo or a held brief (ADR-143), run by a durable delayed call to this
 * chat's object, so it waits behind the chat's earlier updates and survives a restart. Core decides
 * under its own locks and stores the outcome, so a repeated settle answers the same and opens nothing
 * twice. A settle whose Core calls keep failing is left to the poller's sweep, never parked: the
 * update was handled when it arrived.
 */
export async function settleUpdate(ctx: InboxContext, input: SettleInput, core: ChatInboxCore): Promise<HandleUpdateResult> {
  const update = input.update;
  const attempt = Number.isSafeInteger(input.attempt) && Number(input.attempt) > 0 ? Number(input.attempt) : 0;
  const view = await ctx.get<ChatInboxView>('inbox');
  const mode: IntakeMode = view?.mode === 'lifecycle' ? 'lifecycle' : 'legacy';
  const lifecycleRequestId = view?.mode === 'lifecycle' ? view.requestId : undefined;
  let done: Extract<IntakeAnswer, { kind: 'done' }> | null = null;
  let tries = 0;
  for (let k = 0; k < INTAKE_ATTEMPTS && !done; k++) {
    tries = k + 1;
    const answer = await ctx.run(`settle-${k}`, async () => {
      const a = await core.intake(update, mode, lifecycleRequestId, { settle: true });
      if (a.kind === 'retry') log.warn(`[chat-inbox] settle of update ${update.update_id} attempt ${k + 1}/${INTAKE_ATTEMPTS} failed: ${a.reason}`);
      return a;
    });
    if (answer.kind === 'done') { done = answer; break; }
    if (k < INTAKE_ATTEMPTS - 1) await ctx.sleep(retryDelayMs(k));
  }
  if (!done) {
    log.error(`[chat-inbox] settle of update ${update.update_id} failed ${INTAKE_ATTEMPTS} times; the poller's sweep asks again`);
    return { outcome: 'handled', attempts: INTAKE_ATTEMPTS };
  }
  const at = await ctx.now();
  return applyAnswer(ctx, update, done, core, { mode, lifecycleRequestId, at, attempts: tries, settleAttempt: attempt });
}

/** What ChatInbox does with Core's final answer, for an update and for its settle alike. */
async function applyAnswer(ctx: InboxContext, update: TelegramUpdateLike, done: Extract<IntakeAnswer, { kind: 'done' }>,
  core: ChatInboxCore, info: { mode: IntakeMode; lifecycleRequestId?: string; at: number; attempts: number; settleAttempt?: number },
): Promise<HandleUpdateResult> {
  const { mode, lifecycleRequestId, at } = info;
  const settling = info.settleAttempt !== undefined;
  /**
   * Core's office alert to every office member (ADR-155 section 6); a Core from before sends one. The
   * first keeps the key the single alert always had, so an alert sent before is never sent again.
   */
  const alertOffice = (key: string) => {
    const alerts = done.officeAlerts?.length ? done.officeAlerts : done.officeAlert ? [done.officeAlert] : [];
    // ADR-240: about the canary's chat, the alert is recorded in that chat instead of reaching the office.
    alerts.forEach((alert, index) => ctx.sendNotice({ v: 1, key: officeAlertKey(key, index, alert.chatId),
      ...officeAlertRoute(alert.chatId, chatOfUpdate(update)), kind: 'text', class: 'critical', text: alert.text }));
  };
  {
    if (done.lifecycleAction === 'settle-later') {
      if (!done.settle) throw new Error('Core returned an incomplete settle');
      const next = settling ? info.settleAttempt! + 1 : 0;
      if (next > MAX_SETTLE_ROUNDS) {
        log.error(`[chat-inbox] update ${update.update_id} still not settled after ${MAX_SETTLE_ROUNDS} rounds; the poller's sweep asks again`);
      } else {
        ctx.scheduleSettle({ v: 1, update, attempt: next }, done.settle.delayMs,
          next === 0 ? `settle:${update.update_id}` : `settle:${update.update_id}:${next}`);
      }
    }
    if (done.lifecycleAction === 'source-message') {
      if (!done.chatId || !done.sourceMessage || !done.sourceNoticeKey) throw new Error('Core returned an incomplete source notice');
      ctx.sendNotice({ v: 1, key: `chatinbox:${done.sourceNoticeKey}`, chatId: done.chatId,
        kind: 'text', class: 'critical', text: done.sourceMessage });
    }
    if (done.lifecycleAction === 'chat-answer') {
      if (!done.chatId || !done.chatAnswer?.text) throw new Error('Core returned an incomplete chat answer');
      // Keyed by the update: a replay of this handler, or Core giving its recorded answer again, sends it once.
      ctx.sendNotice({ v: 1, key: `chatinbox:chat-answer:${update.update_id}`, chatId: done.chatId,
        kind: 'text', class: 'critical', text: done.chatAnswer.text,
        ...(done.chatAnswer.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}) });
      // ADR-144: approval or timing words passed to the office (never an approval by themselves).
      alertOffice(`notify.office:requester-note:${update.update_id}`);
      // ADR-235: the question's timeout, a durable delayed settle of the brief's update under its own key
      // (a replay schedules nothing twice; an answer before it makes the settle open nothing).
      if (done.clientQuestionSettle) ctx.scheduleSettle({ v: 1, update, attempt: 0 }, done.clientQuestionSettle.delayMs,
        `settle:${update.update_id}:client-question`);
    }
    if (done.lifecycleAction === 'album-message') {
      if (!done.chatId || !done.albumMessage || !done.albumNoticeKey) throw new Error('Core returned an incomplete album notice');
      ctx.sendNotice({ v: 1, key: `chatinbox:${done.albumNoticeKey}`, chatId: done.chatId,
        kind: 'text', class: 'critical', text: done.albumMessage });
    }
    if (done.lifecycleAction === 'park-update') {
      if (done.code !== 'LIFECYCLE_MEDIA_NOT_ADMITTED' || !done.reason) {
        throw new Error('Core returned an invalid lifecycle media hold');
      }
      await ctx.run('park', () => core.park(update, done.reason!));
      if (!settling) ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'parked', at,
        ...(mode === 'lifecycle' ? { mode, requestId: lifecycleRequestId } : {}),
      } satisfies ChatInboxView);
      return { outcome: 'parked', intakeStatus: done.intakeStatus, attempts: info.attempts };
    }
    if (done.lifecycleAction === 'open-request') {
      if (!done.requestId || !done.chatId || !done.draft) throw new Error('Core returned an incomplete lifecycle open');
      // An English-and-Kurdish brief opens one request per language (ADR-139): each under its own
      // stable open key, so a replay of this handler sends none of them twice.
      for (const open of [{ requestId: done.requestId, draft: done.draft }, ...(done.siblings ?? [])]) {
        const event = { v: 1 as const, eventId: `open:${open.requestId}`, requestId: open.requestId,
          tenantId: '00000000-0000-4000-a000-000000000001', chatId: done.chatId,
          draft: open.draft } as OpenManualEvent | OpenAutomaticEvent;
        await ctx.sendLifecycleOpen(open.requestId, event);
      }
    }
    // In lifecycle mode, if Core recognised the update as a requester revision decision, fire the
    // lifecycle handler so RequestLifecycle can advance its state machine. Idempotency key:
    // chatinbox:revision:<update_id> — stable, unique per update, replay-safe.
    if ((done.lifecycleAction === 'requester-revision' || done.lifecycleAction === 'requester-answer') &&
        done.requestId && done.newTaskId && done.round !== undefined && done.directive && done.priorTaskId) {
      const lcEvent: RequesterDecisionEvent & { newTaskId: string } = {
        v: 1,
        eventId: `chatinbox:revision:${update.update_id}`,
        requestId: done.requestId,
        round: done.round,
        directive: done.directive,
        priorTaskId: done.priorTaskId,
        newTaskId: done.newTaskId,
        ...(done.questionId ? { questionId: done.questionId } : {}),
        ...(done.rawText !== undefined ? { rawText: done.rawText as string } : {}),
        // ADR-182: the requester's change started the next draft; they are told so, once. ADR-200
        // addendum: redo words are answered by Core's own line, naming the design ("I'll redo …").
        // ADR-233: said by the round's DesignRun once Core admits the design, not here: a round refused at
        // admission ("a designer will make this change by hand") was announced a second before (L13).
        ...(done.lifecycleAction === 'requester-revision' && done.chatId ? { startNotice: {
          key: `chatinbox:change-taken:${update.update_id}`, chatId: done.chatId,
          text: done.chatAnswer?.text || say(INBOX_MESSAGES.changeTaken, languageOf(update)),
          ...(done.chatAnswer?.text && done.chatAnswer.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}),
        } } : {}),
      };
      // Keep the Restate context alive until the send is durably recorded. A failed import or send
      // retries this handler from its journaled Core answer under the same event key.
      await ctx.sendLifecycleDecision(done.requestId, lcEvent);
      if (done.lifecycleAction === 'requester-answer' && done.chatId) {
        ctx.sendNotice({ v: 1, key: `chatinbox:answer-accepted:${update.update_id}`,
          chatId: done.chatId, kind: 'text', class: 'critical',
          // Sorani (native review pending, ADR-144): "Thanks, I'll use that and carry on with the same design."
          text: say(INBOX_MESSAGES.answerTaken, languageOf(update)),
        });
      }
    }
    if (done.lifecycleAction === 'withdraw') {
      // ADR-230: Core decided the cancel withdraws this request. RequestLifecycle closes it (Core checks
      // this update's decision) and tells the requester and the office, so nothing is said here. The
      // event key is the update: a replay of this handler sends it once.
      if (!done.requestId || !done.chatId) throw new Error('Core returned an incomplete withdraw');
      if (!ctx.sendLifecycleWithdraw) throw new Error('This ChatInbox cannot reach RequestLifecycle.withdraw');
      // ADR-255: a cancel that named several designs ("cancel both of them") withdraws each through its own
      // object, under the same update's event (each object keys it by its own request).
      for (const requestId of done.requestIds?.length ? done.requestIds : [done.requestId]) {
        await ctx.sendLifecycleWithdraw(requestId, { v: 1, kind: 'withdraw', eventId: `chatinbox:withdraw:${update.update_id}`,
          requestId, updateId: update.update_id });
      }
    }
    if (done.lifecycleAction === 'request-choice-required' && done.chatId &&
        (done.code === 'AMBIGUOUS_REQUEST' || done.code === 'STALE_REQUEST_REPLY')) {
      ctx.sendNotice({ v: 1, key: `chatinbox:request-choice:${update.update_id}`,
        chatId: done.chatId, kind: 'text', class: 'critical',
        // ADR-144: no reply target is demanded. Core no longer answers a text message this way (it
        // asks which design, in words); a photo with two designs waiting, or a button under an old
        // draft, still does.
        text: say(done.code === 'STALE_REQUEST_REPLY' ? INBOX_MESSAGES.staleButton : INBOX_MESSAGES.whichWaitingDesign, languageOf(update)),
      });
    }
    if (done.lifecycleAction === 'late-change') {
      // The requester replied after the design reached the office. Core kept the words; the office
      // hears them quoted, and the requester is told plainly that they changed nothing by themselves.
      if (done.code !== 'LATE_REQUESTER_CHANGE' || !done.chatId || !done.requestId || !done.requestStage) {
        throw new Error('Core returned an incomplete late change');
      }
      alertOffice(`notify.office:late-change:${done.requestId}:${update.update_id}`);
      // ADR-144: Core words the answer (in the requester's language) when it has the request's name;
      // otherwise these, which say what happened without a refusal.
      const lang = languageOf(update);
      // Without an office chat nobody was alerted: the words are kept for the office (the Desk shows
      // them before Deliver), and the requester is told exactly that.
      const told = Boolean(done.officeAlert);
      const fallback = say(!told ? INBOX_MESSAGES.lateChangeKept
        : done.requestStage === 'delivered' ? INBOX_MESSAGES.lateChangeDelivered
          : done.requestStage === 'delivering' ? INBOX_MESSAGES.lateChangeDelivering
            : INBOX_MESSAGES.lateChangeReview, lang);
      ctx.sendNotice({ v: 1, key: `chatinbox:late-change:${update.update_id}`,
        chatId: done.chatId, kind: 'text', class: 'critical', text: done.chatAnswer?.text || fallback,
        ...(done.chatAnswer?.text && done.chatAnswer.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}),
      });
    }
    if (done.lifecycleAction === 'new-brief-required' && done.chatId) {
      ctx.sendNotice({ v: 1, key: `chatinbox:new-brief-required:${update.update_id}`,
        chatId: done.chatId, kind: 'text', class: 'critical',
        // ADR-144: no command is asked for; the next message with the brief opens the request.
        text: say(INBOX_MESSAGES.whatToDesign, languageOf(update)),
      });
    }
    if (done.lifecycleAction === 'revision-blocked' && done.chatId &&
        (done.code === 'DAILY_CAP_REACHED' || done.code === 'PARENT_BRIEF_MISSING' ||
          done.code === 'QUESTION_MISSING')) {
      // ADR-145: the requester's words go to the office, which makes the change; the requester is told
      // so, and is never asked to send it again. Without an office chat to tell, they are told plainly.
      alertOffice(`notify.office:revision-blocked:${update.update_id}`);
      const lang = languageOf(update);
      ctx.sendNotice({ v: 1, key: `chatinbox:revision-blocked:${update.update_id}`,
        chatId: done.chatId, kind: 'text', class: 'critical',
        text: say(!done.officeAlert ? INBOX_MESSAGES.changeNotStarted
          : done.code === 'DAILY_CAP_REACHED' ? INBOX_MESSAGES.changeToOffice
            : done.code === 'QUESTION_MISSING' ? INBOX_MESSAGES.answerToOffice : INBOX_MESSAGES.changeToOfficeToFinish, lang),
      });
    }
    // N5 (ADR-145): a sender outside the intake list hears one polite line. Core words it (once per chat
    // per day) and says `quiet` for the rest of the day; a Core that gave no words at all gets these.
    if (done.intakeStatus === 403 && !done.chatAnswer && !done.quiet) {
      const chat = done.chatId ?? chatOfUpdate(update);
      if (chat) ctx.sendNotice({ v: 1, key: `chatinbox:not-allowed:${update.update_id}`, chatId: chat, kind: 'text',
        class: 'critical', text: say(ACCESS_MESSAGES.notAllowed, languageOf(update)) });
    }
    // ADR-145: words Core said beside its answer (the photo sent before was used; a video's words were).
    if (done.notice) {
      const chat = done.chatId ?? chatOfUpdate(update);
      if (chat) ctx.sendNotice({ v: 1, key: done.noticeKey ? `chatinbox:${done.noticeKey}` : `chatinbox:notice:${update.update_id}`, chatId: chat, kind: 'text',
        class: 'critical', text: done.notice.text, ...(done.notice.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}) });
    }
    if (!settling) {
      ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'handled',
        lastIntakeStatus: done.intakeStatus, at,
        ...(mode === 'lifecycle' || done.lifecycleAction === 'open-request'
          ? { mode: 'lifecycle' as const, requestId: done.requestId ?? lifecycleRequestId } : {}),
      } satisfies ChatInboxView);
    } else if (done.lifecycleAction === 'open-request' && done.requestId) {
      // A settle that opened a request moves the chat to lifecycle mode, as an update's open does.
      const view = await ctx.get<ChatInboxView>('inbox');
      if (view?.mode !== 'lifecycle') ctx.set('inbox', { v: 1, lastUpdateId: view?.lastUpdateId ?? 0,
        lastOutcome: view?.lastOutcome ?? 'handled',
        ...(view?.lastIntakeStatus !== undefined ? { lastIntakeStatus: view.lastIntakeStatus } : {}),
        at: view?.at ?? at, mode: 'lifecycle', requestId: done.requestId } satisfies ChatInboxView);
    }
    return { outcome: 'handled', intakeStatus: done.intakeStatus, attempts: info.attempts };
  }
}

/** Steps that throw (a wait) back off from 2 s to a 30 s ceiling, without a limit of their own. */
const WAIT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };

function inboxContext(ctx: restate.ObjectContext): InboxContext {
  // Lazy import to break the potential circular reference at module-load time.
  // RequestLifecycleApi is used only at runtime when sendLifecycleDecision is called.
  return {
    get: (name) => ctx.get(name),
    run: (name, action) => ctx.run(name, action, WAIT_RETRY),
    sleep: (ms) => ctx.sleep(ms),
    set: (name, value) => ctx.set(name, value),
    now: () => ctx.date.now(),
    sendLifecycleDecision: async (requestId, event) => {
      // Dynamic import avoids the circular dep at module level; the API object is a stable singleton.
      const { RequestLifecycleApi } = await import('./request-lifecycle.js');
      ctx.objectSendClient(RequestLifecycleApi, requestId)
        .requesterDecision(event, restate.rpc.sendOpts({ idempotencyKey: event.eventId }));
    },
    sendLifecycleOpen: async (requestId, event) => {
      const { RequestLifecycleApi } = await import('./request-lifecycle.js');
      ctx.objectSendClient(RequestLifecycleApi, requestId)
        .open(event, restate.rpc.sendOpts({ idempotencyKey: event.eventId }));
    },
    sendLifecycleWithdraw: async (requestId, event) => {
      const { RequestLifecycleApi } = await import('./request-lifecycle.js');
      ctx.objectSendClient(RequestLifecycleApi, requestId)
        .withdraw(event, restate.rpc.sendOpts({ idempotencyKey: event.eventId }));
    },
    sendNotice: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
      .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
    scheduleSettle: (input, delayMs, key) => ctx.objectSendClient(chatInbox, ctx.key)
      .settle(input, restate.rpc.sendOpts({ idempotencyKey: key, delay: delayMs })),
  };
}

/** Core's client, set by index.ts when the worker has HAWA_WORKER_TOKEN; until then an update waits. */
let coreClient: ChatInboxCore | null = null;
export function useChatInboxCore(core: ChatInboxCore): void {
  coreClient = core;
}

/**
 * Mark a chat as lifecycle-mode: future updates from this chat are routed through RequestLifecycle
 * instead of legacy intake. Idempotent — once set, the mode cannot revert.
 *
 * Called by RequestLifecycle.open (via objectSendClient) when it claims a chat's first request.
 * The handler is exclusive so it serializes with handleUpdate in Restate's queue.
 */
export async function setMode(
  ctx: SetModeContext,
  requestId: string,
): Promise<{ mode: IntakeMode; requestId: string }> {
  const prior = await ctx.get<ChatInboxView>('inbox');
  if (prior?.mode === 'lifecycle') {
    return { mode: 'lifecycle', requestId };
  }
  // Preserve all existing fields, add or upgrade the mode. Also store requestId so lifecycle
  // intake can look up the request without a DB query on the critical path.
  const next: ChatInboxView = {
    v: 1,
    lastUpdateId: prior?.lastUpdateId ?? 0,
    lastOutcome: prior?.lastOutcome ?? 'handled',
    ...(prior?.lastIntakeStatus !== undefined ? { lastIntakeStatus: prior.lastIntakeStatus } : {}),
    at: prior?.at ?? Date.now(),
    mode: 'lifecycle',
    requestId,
  };
  ctx.set('inbox', next);
  return { mode: 'lifecycle', requestId };
}

export const chatInbox = restate.object({
  name: 'ChatInbox',
  handlers: {
    /** References authenticated at ingress; the private lifecycle is reached only through the SDK. */
    webAction:restate.handlers.object.exclusive(
      {idempotencyRetention:{days:7},journalRetention:{days:7}},
      async(ctx:restate.ObjectContext,input:SignedCustomerActionCommand)=>forwardCustomerAction({key:ctx.key,run:(name,fn)=>ctx.run(name,fn),
        send:async(requestId,event)=>{const {RequestLifecycleApi}=await import('./request-lifecycle.js');
          ctx.objectSendClient(RequestLifecycleApi,requestId).customerAction(event,restate.rpc.sendOpts({idempotencyKey:`customer-action:${event.actionId}`}));}},coreInternalFromEnv(),input)
    ),
    webOpen: restate.handlers.object.exclusive(
      { idempotencyRetention: { days: 7 }, journalRetention: { days: 1 } },
      async (ctx:restate.ObjectContext,input:SignedCustomerOpenCommand) => openCustomerWebRequest({
        key:ctx.key,run:(name,action)=>ctx.run(name,action),
        sendOpen:async(requestId,event)=>{
          const {RequestLifecycleApi}=await import('./request-lifecycle.js');
          ctx.objectSendClient(RequestLifecycleApi,requestId).open(event,restate.rpc.sendOpts({idempotencyKey:event.eventId}));
        },
      },coreInternalFromEnv(),input)
    ),
    handleUpdate: restate.handlers.object.exclusive(
      // The poller's key tg-<update_id> answers a second send for 7 days; the journal is kept a day.
      { idempotencyRetention: { days: 7 }, journalRetention: { days: 1 } },
      async (ctx: restate.ObjectContext, input: HandleUpdateInput): Promise<HandleUpdateResult> =>
        withInvocationLogContext(ctx, { requestId: `tg-${input?.update?.update_id}` }, async () => {
          if (!coreClient) throw new Error('ChatInbox has no Core client: HAWA_WORKER_TOKEN is not set in this worker');
          return handleUpdate(inboxContext(ctx), input, coreClient);
        })
    ),
    /**
     * ADR-143: the delayed settle of a saved album photo or a held brief (scheduleSettle), and the
     * poller's sweep of overdue ones. Exclusive, so it runs after the chat's earlier updates.
     */
    settle: restate.handlers.object.exclusive(
      { idempotencyRetention: { days: 7 }, journalRetention: { days: 1 } },
      async (ctx: restate.ObjectContext, input: SettleInput): Promise<HandleUpdateResult> =>
        withInvocationLogContext(ctx, { requestId: `settle-${input?.update?.update_id}` }, async () => {
          if (!coreClient) throw new Error('ChatInbox has no Core client: HAWA_WORKER_TOKEN is not set in this worker');
          if (input?.v !== 1 || !Number.isSafeInteger(input.update?.update_id) || input.update.update_id <= 0) {
            throw new restate.TerminalError('A settle names the saved update it settles', { errorCode: 400 });
          }
          return settleUpdate(inboxContext(ctx), input, coreClient);
        })
    ),
    /**
     * RequestLifecycle.open calls this (exclusive, so it serializes with handleUpdate) to upgrade
     * a chat from legacy to lifecycle mode. Idempotent: calling it twice on the same chat is safe.
     */
    setMode: restate.handlers.object.exclusive(
      { idempotencyRetention: { days: 7 } },
      async (ctx: restate.ObjectContext, requestId: string): Promise<{ mode: IntakeMode; requestId: string }> =>
        setMode(
          { get: (name) => ctx.get(name), set: (name, value) => ctx.set(name, value) },
          typeof requestId === 'string' ? requestId : '',
        )
    ),
    get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<ChatInboxView | null> =>
      (await ctx.get<ChatInboxView>('inbox')) ?? null
    ),
  },
  options: {
    // One intake call pins the chat. A 20 MB download and its reading can take minutes, so the abort
    // comes late; the design's retry policy pauses (never kills) an update that cannot go on.
    inactivityTimeout: { minutes: 1 },
    abortTimeout: { minutes: 10 },
    retryPolicy: { initialInterval: 2000, exponentiationFactor: 2, maxInterval: 30_000, maxAttempts: 500, onMaxAttempts: 'pause' },
  },
});
