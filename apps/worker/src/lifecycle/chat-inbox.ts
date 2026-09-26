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
import { withInvocationLogContext, log } from '../logging.js';
import type { TelegramUpdateLike } from './telegram-poller.js';
import type { RequesterDecisionEvent } from './request-lifecycle.js';

/** Fields are only ever added, and only as optional (PHASE2_DESIGN.md section 4). */
export interface HandleUpdateInput {
  v: 1;
  update: TelegramUpdateLike;
  /** When the poller took the update from Telegram (ms since the epoch). */
  polledAt?: number;
}

export type IntakeMode = 'legacy' | 'lifecycle';

/** What Core's intake answered, as journaled. */
export type IntakeAnswer =
  | { kind: 'done'; intakeStatus: number; duplicate?: boolean;
      /** When mode=lifecycle and Core routed the update as a requester revision. */
      lifecycleAction?: 'requester-revision';
      requestId?: string; newTaskId?: string; round?: number; directive?: string;
      priorTaskId?: string; rawText?: string; }
  | { kind: 'retry'; reason: string };

/** The Core calls ChatInbox makes (core-client.ts). A thrown error means "wait and try again". */
export interface ChatInboxCore {
  intake(update: TelegramUpdateLike, mode: IntakeMode, requestId?: string): Promise<IntakeAnswer>;
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
}

export interface ChatInboxView {
  v: 1;
  lastUpdateId: number;
  lastOutcome: 'handled' | 'parked';
  lastIntakeStatus?: number;
  at: number;
  /** Set once when the first RequestLifecycle-owned request opens for this chat. Never reverts. */
  mode?: IntakeMode;
  /** The requestId of the lifecycle request that claimed this chat (stored alongside mode). */
  requestId?: string;
}

export interface HandleUpdateResult {
  outcome: 'handled' | 'parked';
  intakeStatus?: number;
  attempts: number;
}

export const INTAKE_ATTEMPTS = 5;
/** Waits between retryable answers: 2, 4, 8 and 16 s, the backoff Core's poller used. */
const retryDelayMs = (k: number) => 2000 * 2 ** k;

export async function handleUpdate(ctx: InboxContext, input: HandleUpdateInput, core: ChatInboxCore): Promise<HandleUpdateResult> {
  const update = input.update;
  // Read the per-chat mode and requestId from Restate state, journaled so a replay agrees.
  // RequestLifecycle.open sets the mode to 'lifecycle' via setMode before the first owned update arrives.
  const { mode, requestId: lifecycleRequestId } = await ctx.run<{ mode: IntakeMode; requestId?: string }>('mode', async () => {
    const view = await ctx.get<ChatInboxView>('inbox');
    if (view?.mode === 'lifecycle') return { mode: 'lifecycle', requestId: view.requestId };
    return { mode: 'legacy' };
  });

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
  if (done) {
    // In lifecycle mode, if Core recognised the update as a requester revision decision, fire the
    // lifecycle handler so RequestLifecycle can advance its state machine. Idempotency key:
    // chatinbox:revision:<update_id> — stable, unique per update, replay-safe.
    if (done.lifecycleAction === 'requester-revision' &&
        done.requestId && done.newTaskId && done.round !== undefined && done.directive && done.priorTaskId) {
      const lcEvent: RequesterDecisionEvent & { newTaskId: string } = {
        v: 1,
        eventId: `chatinbox:revision:${update.update_id}`,
        requestId: done.requestId,
        round: done.round,
        directive: done.directive,
        priorTaskId: done.priorTaskId,
        newTaskId: done.newTaskId,
        ...(done.rawText !== undefined ? { rawText: done.rawText as string } : {}),
      };
      // Keep the Restate context alive until the send is durably recorded. A failed import or send
      // retries this handler from its journaled Core answer under the same event key.
      await ctx.sendLifecycleDecision(done.requestId, lcEvent);
    }
    ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'handled',
      lastIntakeStatus: done.intakeStatus, at,
      ...(mode === 'lifecycle' ? { mode, requestId: lifecycleRequestId } : {}),
    } satisfies ChatInboxView);
    return { outcome: 'handled', intakeStatus: done.intakeStatus, attempts: reasons.length + 1 };
  }

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
