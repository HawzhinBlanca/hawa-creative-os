/**
 * RequestLifecycle: one Restate Virtual Object per request (architecture programme Phase 2, slice 2.3;
 * PHASE2_DESIGN.md sections 2.3, 2.7 and 4, ADR-034). A request is the chain of rounds of one design,
 * from the brief to its delivery; its key is the request id.
 *
 * This is the shell around the pure state machine in packages/domain/src/request-lifecycle.ts. Every
 * handler does the same, in the same order, so every invocation's journal has the same shape:
 *   1. read the state (`lc`), the journaled clock, and the settings (one `config` step);
 *   2. plan: an event seen before, or one the stage does not take, changes nothing and answers;
 *   3. project: Core writes what the event decided to Postgres, in one transaction, with the
 *      revision the object expects and the key `<requestId>:<rev>:<event>` (step `project:<rev>`);
 *   4. apply Core's answer: the next state, set in one `ctx.set`, and the effects;
 *   5. emit the effects, in order, as one-way sends only: messages to the chat's TelegramSender,
 *      design runs and deliveries started, reminders and the expiry sent to itself with a delay.
 *
 * No handler waits for a person, and none awaits another object or a workflow: that would keep the
 * invocation, and the object, pinned to a deployment until the other side answered (section 4). Each
 * handler runs for seconds; waiting is a stage. A delayed reminder or expiry carries the stage epoch
 * it was scheduled in, and one from an older stage does nothing.
 *
 * When Core cannot take a projection:
 * - a design outcome waits 30 minutes, then is kept (`outcomeDeferred`), the requester and the office
 *   are told, and it is offered again every 10 minutes (retryProjection);
 * - any other event waits for Core without a limit of its own (the service's retry policy pauses it
 *   after many hours, which /health reports);
 * - 409 AHEAD (Postgres holds projections this state does not know, after a Restate restore): the
 *   object takes Postgres's revision, tells the office, and projects the event again;
 * - 409 STALE_REVISION (Postgres behind the object: a second writer, or a Postgres restore): the
 *   office is told and the invocation pauses until a person has looked; resumed, it asks again;
 * - a refusal of the event itself (KEY_REUSED, an op Core finds invalid): the office is told and the
 *   event ends with a terminal error.
 */
import * as restate from '@restatedev/restate-sdk';
import {
  type AnswerEvent,
  type CancelEvent,
  type DeliveryFinishedEvent,
  type DeliveryInput,
  type DesignFinishedEvent,
  type ExpireEvent,
  type LifecycleEvent,
  type LifecycleEventType,
  type LifecycleMessage,
  type LifecycleStateV1,
  type LifecycleView,
  type MessageSentEvent,
  type OfficeDecisionEvent,
  type OpenEvent,
  type OutboundMessage,
  type ProjectionRequest,
  type RemindEvent,
  type RequesterDecisionEvent,
  type RetryProjectionEvent,
} from '@hawa/contracts';
import {
  apply,
  plan,
  projectionRequestFor,
  reconcileAhead,
  recordRunInvocation,
  upgrade,
  viewOf,
  LifecycleEventUnreadableError,
  type LifecycleEffect,
  type ProjectionOutcome,
  type RequesterNotice,
  type RequesterNoticeWhy,
} from '@hawa/domain';
import { chaosPoint } from '@hawa/observability';
import { composeOutcomeUnrecordedAlert, composeOutcomeUnrecordedMessage } from '../delivery-notification.js';
import { log, withInvocationLogContext } from '../logging.js';
import type { DeliveryHandlers } from './delivery.js';
import type { DesignRunHandlers, DesignRunInput } from './design-run.js';
import { projectionCoreFromEnv, type ProjectionAnswer, type ProjectionCore } from './projection-client.js';
import { TelegramSenderApi } from './telegram-sender.js';

/** The state key: one key, versioned (section 4 rule 4). */
export const STATE_KEY = 'lc';

/**
 * A design outcome waits this long for Core before it is kept and offered again later. Other events
 * wait without a limit of their own.
 */
export const PROJECT_RETRY = { initialRetryInterval: 1000, retryIntervalFactor: 2, maxRetryInterval: 30_000, maxRetryDuration: 30 * 60 * 1000 };
/** AHEAD answered this often in one invocation means something keeps writing: it is held like a stale revision. */
const MAX_RECONCILIATIONS = 2;

// ---------------------------------------------------------------------------------------------
// Settings, read once per invocation inside a journaled step, so a replay on another colour agrees.

export interface LifecycleConfig {
  /** HAWA_LIFECYCLE_REMINDER_SCALE: multiplies reminder and expiry delays (tests: 0.0001). */
  reminderScale: number;
  /** The office chat that hears about what a person must look at. */
  officeChatId: string | null;
}

/** HAWA_LIFECYCLE_REMINDER_SCALE: a number in (0, 1]; anything else is 1 (real days). */
export function reminderScaleFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}

export function lifecycleConfigFromEnv(env: Record<string, string | undefined> = process.env): LifecycleConfig {
  const raw = env.HAWA_LIFECYCLE_REMINDER_SCALE;
  const reminderScale = reminderScaleFrom(raw);
  if (raw && raw.trim() && reminderScale === 1 && Number(raw) !== 1) log.warn(`[RequestLifecycle] HAWA_LIFECYCLE_REMINDER_SCALE=${raw} is not a number in (0, 1]; real days are used`);
  return {
    reminderScale,
    officeChatId: (env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).find(Boolean) || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Handlers and their payloads

/** Every exclusive handler, by the event type it takes (the payload is the event without `type`). */
export const LIFECYCLE_EVENT_HANDLERS = [
  'open', 'designFinished', 'answer', 'requesterDecision', 'officeDecision', 'deliveryFinished',
  'messageSent', 'remind', 'expire', 'cancel', 'retryProjection',
] as const satisfies readonly LifecycleEventType[];

type Payloads = {
  open: OpenEvent;
  designFinished: DesignFinishedEvent;
  answer: AnswerEvent;
  requesterDecision: RequesterDecisionEvent;
  officeDecision: OfficeDecisionEvent;
  deliveryFinished: DeliveryFinishedEvent;
  messageSent: MessageSentEvent;
  remind: RemindEvent;
  expire: ExpireEvent;
  cancel: CancelEvent;
  retryProjection: RetryProjectionEvent;
};

export type RequestLifecycleHandlers = {
  [K in keyof Payloads]: (ctx: restate.ObjectContext, payload: Payloads[K]) => Promise<unknown>;
} & { get: (ctx: restate.ObjectSharedContext) => Promise<LifecycleView | null> };

/** How other services name it (objectSendClient). */
export const RequestLifecycleApi: restate.VirtualObjectDefinition<'RequestLifecycle', RequestLifecycleHandlers> = { name: 'RequestLifecycle' };
const DesignRunApi: restate.WorkflowDefinition<'DesignRun', DesignRunHandlers> = { name: 'DesignRun' };
const DeliveryApi: restate.WorkflowDefinition<'Delivery', DeliveryHandlers> = { name: 'Delivery' };

/**
 * A handler's payload as the event the state machine reads. The payload's own version is checked by
 * plan(); a payload that is not an object at all is refused here.
 */
export function eventOf(type: LifecycleEventType, payload: unknown): LifecycleEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LifecycleEventUnreadableError(`${type} was sent ${Array.isArray(payload) ? 'a list' : typeof payload}, not an event`);
  }
  const eventId = (payload as { eventId?: unknown }).eventId;
  if (typeof eventId !== 'string' || !eventId) throw new LifecycleEventUnreadableError(`${type} carries no event id`);
  return { ...(payload as object), type } as LifecycleEvent;
}

// ---------------------------------------------------------------------------------------------
// The shell

export interface LifecycleDeps {
  /** Core's projection endpoint; null while the worker has no HAWA_WORKER_TOKEN (every event waits). */
  core(): ProjectionCore | null;
  config(): LifecycleConfig;
}

export function lifecycleDepsFromEnv(): LifecycleDeps {
  let core: ProjectionCore | null | undefined;
  return {
    core: () => (core === undefined ? (core = projectionCoreFromEnv()) : core),
    config: () => lifecycleConfigFromEnv(),
  };
}

const isGaveUp = (err: unknown): boolean => {
  const name = String((err as { name?: unknown })?.name ?? '');
  return err instanceof restate.TerminalError || name.includes('Terminal');
};

/** A plain-text office alert, keyed so that it is sent once however often it is asked for. */
function officeAlert(config: LifecycleConfig, key: string, lines: string[], s: { tenantId?: string; taskId?: string | null }): OutboundMessage | null {
  if (!config.officeChatId) {
    log.error(`[RequestLifecycle] no office chat is configured to hear: ${lines[0]}`);
    return null;
  }
  return {
    v: 1, key, chatId: config.officeChatId, kind: 'text', text: lines.join('\n'), class: 'critical',
    ...(s.tenantId ? { tenantId: s.tenantId } : {}),
    ...(s.taskId ? { taskId: s.taskId } : {}),
  };
}

/** What the requester is told when an answer, button or change of theirs changed nothing (review of 2.3C). */
const NOTICE_WORDS: Record<RequesterNoticeWhy, { toast: string; text: string }> = {
  not_waiting: {
    toast: 'This question was already answered.',
    text: 'ℹ️ This design is not waiting for an answer any more. To change it, reply to the newest draft with what to change.',
  },
  still_designing: {
    toast: 'Your design is still being made.',
    text: '⏳ Your design is still being made. Reply to the draft with your change once it arrives.',
  },
  answer_first: {
    toast: 'Please answer the question about this design first.',
    text: '❓ Please answer the question about this design first: tap one of its options or reply to it.',
  },
  with_office: {
    toast: 'The art director is working on this design.',
    text: '🧑‍🎨 The art director is working on this design and will send it to you here.',
  },
  approved: {
    toast: 'This design is already approved.',
    text: '✅ This design is already approved. Send a new message for a new request.',
  },
  delivered: {
    toast: 'This design was already delivered.',
    text: '✅ This design was already delivered. Send a new message for a new request.',
  },
  cancelled: {
    toast: 'This request was cancelled.',
    text: 'This request was cancelled. Send a new message for a new request.',
  },
  size_asked: {
    toast: 'That size was already asked for.',
    text: 'That size was already asked for; it will arrive in this chat.',
  },
};

/** The notice as a message: a tapped button is answered (its toast), a typed message is replied to. */
export function requesterNoticeMessage(n: RequesterNotice): OutboundMessage {
  const words = NOTICE_WORDS[n.why] ?? NOTICE_WORDS.still_designing;
  return n.callbackQueryId
    ? { v: 1, key: `cb:${n.callbackQueryId}`, chatId: n.chatId, kind: 'callback_answer', callbackQueryId: n.callbackQueryId, text: words.toast, class: 'courtesy', tenantId: n.tenantId }
    : { v: 1, key: `ignored:${n.eventId}`, chatId: n.chatId, kind: 'text', text: words.text, class: 'courtesy', tenantId: n.tenantId };
}

function sendMessage(ctx: restate.ObjectContext, m: OutboundMessage | LifecycleMessage | null): void {
  if (!m || !m.chatId || !m.key) return;
  ctx.objectSendClient(TelegramSenderApi, String(m.chatId)).send({ ...m, v: 1 } as OutboundMessage, restate.rpc.sendOpts({ idempotencyKey: m.key }));
}

/** One projection, as the step `project:<rev>` (or `project:<rev>:held`) journals it. */
async function projectStep(
  ctx: restate.ObjectContext,
  core: ProjectionCore,
  requestId: string,
  body: ProjectionRequest,
  deferrable: boolean,
  held = false
): Promise<ProjectionAnswer | { kind: 'unavailable' }> {
  const step = `project:${body.rev}${held ? ':held' : ''}`;
  const action = async (): Promise<ProjectionAnswer> => {
    const answer = await core.project(requestId, body);
    // Held after a revision Postgres does not agree with: pause again (not journaled) until it does;
    // resumed, ask again.
    if (held && answer.kind === 'conflict' && answer.conflict.code !== 'KEY_REUSED') {
      throw new restate.PauseError(`${answer.conflict.code}: Postgres holds revision ${answer.conflict.pgRev} of request ${requestId}, where this object expected ${body.expectedRev}; a person must look`);
    }
    // The chaos suite kills the worker here: Core has the projection, the journal does not.
    await chaosPoint('worker.rl.after-project', { requestId, key: body.key, rev: body.rev });
    return answer;
  };
  try {
    // Without options a step is retried under the service's retry policy, which pauses the invocation
    // after many hours instead of retrying for ever.
    return deferrable && !held ? await ctx.run(step, action, PROJECT_RETRY) : await ctx.run(step, action);
  } catch (err) {
    // Only the design outcome's step gives up; the state machine keeps the outcome for later.
    if (deferrable && !held && isGaveUp(err)) {
      log.warn(`[RequestLifecycle] Core did not take projection ${body.key} within ${PROJECT_RETRY.maxRetryDuration / 60000} minutes; the outcome is kept and offered again`);
      return { kind: 'unavailable' };
    }
    throw err;
  }
}

/**
 * The body of every exclusive handler. Exported for the handler tests, which pass a fake context
 * (packages/testkit/src/fake-restate-context.ts) that can crash after any journal entry and replay.
 */
export async function handleLifecycleEvent(ctx: restate.ObjectContext, type: LifecycleEventType, payload: unknown, deps: LifecycleDeps): Promise<unknown> {
  try {
    return await handle(ctx, type, payload, deps);
  } catch (err) {
    // A malformed event is final: retrying it cannot help. A state from a newer build (retried until
    // that build is live again) and anything else are retried.
    if (err instanceof LifecycleEventUnreadableError) throw new restate.TerminalError(err.message, { errorCode: 400 });
    throw err;
  }
}

async function handle(ctx: restate.ObjectContext, type: LifecycleEventType, payload: unknown, deps: LifecycleDeps): Promise<unknown> {
  const ev = eventOf(type, payload);
  const requestId = ctx.key;
  let s = upgrade(await ctx.get<unknown>(STATE_KEY));
  const now = await ctx.date.now();
  const config = await ctx.run('config', async () => deps.config());

  const first = plan(s, ev, now);
  if (first.ignored) {
    log.info(`[RequestLifecycle] ${requestId} ${type} ${ev.eventId} changes nothing: ${first.reason}`);
    // The requester is told (a tapped button answered, a typed message replied to), keyed by the
    // event, so a replayed invocation sends nothing twice. The state is not touched.
    if (first.notice) sendMessage(ctx, requesterNoticeMessage(first.notice));
    return first.reply ?? null;
  }
  if (type === 'open' && (ev as OpenEvent).requestId !== requestId) {
    throw new restate.TerminalError(`open names request ${(ev as OpenEvent).requestId}, but this object is ${requestId}`, { errorCode: 400 });
  }
  const core = deps.core();
  if (!core) throw new Error('RequestLifecycle has no Core client: HAWA_WORKER_TOKEN is not set in this worker; the event waits');

  const deferrable = type === 'designFinished' || type === 'retryProjection';
  let outcome: ProjectionOutcome | null = null;
  let reconciled = 0;
  let current = first;
  while (!outcome) {
    const body = projectionRequestFor(s, ev, current);
    let answer = await projectStep(ctx, core, requestId, body, deferrable);
    const taskOf = { tenantId: s?.tenantId, taskId: s?.rounds.find((r) => r.round === s?.round)?.taskId ?? null };

    if (answer.kind === 'conflict' && answer.conflict.code === 'AHEAD' && s && reconciled < MAX_RECONCILIATIONS) {
      reconciled++;
      const pgRev = answer.conflict.pgRev;
      s = reconcileAhead(s, pgRev);
      ctx.set(STATE_KEY, s);
      sendMessage(ctx, officeAlert(config, `lc-ahead:${requestId}:${pgRev}`, [
        'Hawa alert: a request\'s record in Postgres is ahead of what the request lifecycle remembers (Restate was restored, or something else wrote to it).',
        `Request: ${requestId}`,
        `Postgres revision: ${pgRev}; the lifecycle had ${body.expectedRev}`,
        `The lifecycle took Postgres's revision and went on with ${type}. Nothing already sent is sent again. Check the request in the Desk.`,
      ], taskOf));
      const again = plan(s, ev, now);
      if (again.ignored) {
        if (again.notice) sendMessage(ctx, requesterNoticeMessage(again.notice));
        return again.reply ?? null;
      }
      current = again;
      continue;
    }

    // Stale, or ahead again and again: only a person can say which record is right. (Ahead with no state
    // at all is a request this object never opened: refused below.)
    if (answer.kind === 'conflict' && (answer.conflict.code === 'STALE_REVISION' || (answer.conflict.code === 'AHEAD' && s))) {
      sendMessage(ctx, officeAlert(config, `lc-stale:${body.key}`, [
        'Hawa alert: a request\'s record in Postgres does not match the request lifecycle, and the lifecycle has stopped for it.',
        `Request: ${requestId}`,
        `Postgres revision: ${answer.conflict.pgRev}; the lifecycle expected ${body.expectedRev} (${answer.conflict.code})`,
        `Event waiting: ${type}. Only a second writer or a restored database explains this. Resume the paused invocation once the record is right.`,
      ], taskOf));
      answer = await projectStep(ctx, core, requestId, body, deferrable, true);
    }

    if (answer.kind === 'unavailable') {
      outcome = { status: 'unavailable' };
    } else if (answer.kind === 'projected') {
      outcome = answer.response;
    } else {
      const why = answer.kind === 'conflict' ? `${answer.conflict.code} (Postgres revision ${answer.conflict.pgRev})` : `${answer.code}: ${answer.message}`;
      sendMessage(ctx, officeAlert(config, `lc-refused:${body.key}`, [
        'Hawa alert: Core refused to record a step of a request, so the request lifecycle dropped it.',
        `Request: ${requestId}`,
        `Event: ${type} (${ev.eventId})`,
        `Answer: ${why.slice(0, 500)}`,
        'Check the request in the Desk and finish this step by hand.',
      ], taskOf));
      throw new restate.TerminalError(`projection ${body.key} refused: ${why}`, { errorCode: 422 });
    }
  }

  const applied = apply(s, ev, outcome, now, { reminderScale: config.reminderScale });
  if (applied.ignored) {
    log.info(`[RequestLifecycle] ${requestId} ${type} ${ev.eventId} changes nothing: ${applied.reason}`);
    return applied.reply ?? null;
  }
  ctx.set(STATE_KEY, applied.next);
  let state = applied.next;
  for (const effect of applied.effects) state = await emit(ctx, effect, state, config);
  if (state !== applied.next) ctx.set(STATE_KEY, state);
  return applied.reply ?? null;
}

/** One effect, as a one-way send. Returns the state, with a started run's invocation id kept. */
async function emit(ctx: restate.ObjectContext, effect: LifecycleEffect, state: LifecycleStateV1, config: LifecycleConfig): Promise<LifecycleStateV1> {
  switch (effect.type) {
    case 'send':
      sendMessage(ctx, { ...effect.message, tenantId: effect.message.tenantId ?? state.tenantId });
      return state;
    case 'answerCallback':
      if (!effect.chatId) return state;
      sendMessage(ctx, { v: 1, key: `cb:${effect.callbackQueryId}`, chatId: effect.chatId, kind: 'callback_answer', callbackQueryId: effect.callbackQueryId, class: 'courtesy', tenantId: state.tenantId });
      return state;
    case 'startDesignRun': {
      const input: DesignRunInput = {
        v: 1, taskId: effect.taskId, tenantId: effect.tenantId,
        lifecycle: { requestId: effect.requestId, round: effect.round, runId: effect.runId },
        ...(effect.attempt > 0 ? { redriveAttempt: effect.attempt } : {}),
      };
      // The workflow key is the run id: a second start of the same run is refused by Restate.
      const handle = ctx.workflowSendClient(DesignRunApi, effect.runId).run(input);
      const invocationId = await handle.invocationId;
      return recordRunInvocation(state, effect.runId, String(invocationId));
    }
    case 'startDelivery': {
      const input: DeliveryInput = {
        v: 1, requestId: effect.requestId, deliveryId: effect.deliveryId, tenantId: effect.tenantId, taskId: effect.taskId,
        approvalId: effect.approvalId, revisionId: effect.revisionId, chatId: effect.chatId, officeChatId: config.officeChatId,
        reportTo: 'lifecycle', run: effect.run,
      };
      ctx.workflowSendClient(DeliveryApi, effect.deliveryId).run(input);
      return state;
    }
    case 'schedule': {
      const client = ctx.objectSendClient(RequestLifecycleApi, state.requestId);
      const opts = { delay: effect.delayMs, idempotencyKey: effect.idempotencyKey };
      if (effect.handler === 'remind') client.remind(effect.event, restate.rpc.sendOpts<RemindEvent>(opts));
      else if (effect.handler === 'expire') client.expire(effect.event, restate.rpc.sendOpts<ExpireEvent>(opts));
      else client.retryProjection(effect.event, restate.rpc.sendOpts<RetryProjectionEvent>(opts));
      return state;
    }
    case 'openChild':
      ctx.objectSendClient(RequestLifecycleApi, effect.requestId).open(effect.event, restate.rpc.sendOpts({ idempotencyKey: effect.event.eventId }));
      return state;
    case 'cancelRun':
      if (effect.invocationId) ctx.cancel(effect.invocationId as restate.InvocationId);
      else log.warn(`[RequestLifecycle] ${state.requestId}: design run ${effect.runId} has no invocation id on record, so it was not cancelled; its report will be ignored`);
      return state;
    case 'outcomeUnrecorded': {
      const office = config.officeChatId;
      const requesterTold = Boolean(effect.chatId && effect.chatId !== office);
      if (effect.chatId && requesterTold) {
        sendMessage(ctx, {
          v: 1, key: `${effect.requestId}:outcome-unrecorded:${effect.runId}`, chatId: effect.chatId, kind: 'text', class: 'critical',
          text: composeOutcomeUnrecordedMessage({ taskId: effect.taskId, draftMade: /READY/.test(effect.status), officeAlerted: Boolean(office) }),
          tenantId: state.tenantId, taskId: effect.taskId,
        });
      }
      sendMessage(ctx, officeAlert(config, `notify.office:outcome-unrecorded:${effect.runId}`, [
        composeOutcomeUnrecordedAlert({ taskId: effect.taskId, status: effect.status, requesterChat: effect.chatId, requesterTold }),
      ], { tenantId: state.tenantId, taskId: effect.taskId }));
      return state;
    }
    default:
      log.error(`[RequestLifecycle] ${state.requestId}: an effect this build does not know was dropped: ${JSON.stringify(effect).slice(0, 200)}`);
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// The Virtual Object

export function createRequestLifecycle(deps: LifecycleDeps = lifecycleDepsFromEnv()) {
  const exclusive = <K extends keyof Payloads>(type: K) =>
    restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, payload: Payloads[K]): Promise<unknown> =>
      withInvocationLogContext(ctx, { requestId: ctx.key }, () => handleLifecycleEvent(ctx, type, payload, deps)));
  return restate.object({
    name: 'RequestLifecycle',
    handlers: {
      open: exclusive('open'),
      designFinished: exclusive('designFinished'),
      answer: exclusive('answer'),
      requesterDecision: exclusive('requesterDecision'),
      officeDecision: exclusive('officeDecision'),
      deliveryFinished: exclusive('deliveryFinished'),
      messageSent: exclusive('messageSent'),
      remind: exclusive('remind'),
      expire: exclusive('expire'),
      cancel: exclusive('cancel'),
      retryProjection: exclusive('retryProjection'),
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<LifecycleView | null> => {
        const s = upgrade(await ctx.get<unknown>(STATE_KEY));
        return s ? viewOf(s) : null;
      }),
    },
    options: {
      journalRetention: { days: 7 },
      idempotencyRetention: { days: 7 },
      inactivityTimeout: { minutes: 1 },
      abortTimeout: { minutes: 5 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000, maxAttempts: 300, onMaxAttempts: 'pause' },
    },
  });
}
