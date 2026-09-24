/**
 * ChatInbox: one Virtual Object per Telegram chat (architecture programme Phase 2.1, ADR-034,
 * PHASE2_DESIGN.md section 2.2).
 *
 * The poller (telegram-poller.ts) sends every update here, keyed by its chat, with idempotency key
 * `tg-<update_id>`. Restate runs one update at a time per chat, in order, and chats side by side, so a
 * long download in one chat no longer holds the others. In slice 2.1 the handler only hands the update
 * to Core's existing intake (POST /v1/internal/telegram/intake, mode `legacy`) and, when intake keeps
 * failing, dead-letters it. The request lifecycle (2.3) routes decisions from here later.
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

/** Fields are only ever added, and only as optional (PHASE2_DESIGN.md section 4). */
export interface HandleUpdateInput {
  v: 1;
  update: TelegramUpdateLike;
  /** When the poller took the update from Telegram (ms since the epoch). */
  polledAt?: number;
}

export type IntakeMode = 'legacy';

/** What Core's intake answered, as journaled. */
export type IntakeAnswer =
  | { kind: 'done'; intakeStatus: number; duplicate?: boolean }
  | { kind: 'retry'; reason: string };

/** The Core calls ChatInbox makes (core-client.ts). A thrown error means "wait and try again". */
export interface ChatInboxCore {
  intake(update: TelegramUpdateLike, mode: IntakeMode): Promise<IntakeAnswer>;
  park(update: TelegramUpdateLike, reason: string): Promise<void>;
}

/** The parts of Restate's ObjectContext the handler uses; tests pass a small journal. */
export interface InboxContext {
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
  set(name: string, value: unknown): void;
  now(): Promise<number>;
}

export interface ChatInboxView {
  v: 1;
  lastUpdateId: number;
  lastOutcome: 'handled' | 'parked';
  lastIntakeStatus?: number;
  at: number;
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
  // The one read of the mode, journaled so that a replay on the other colour agrees with it. In 2.1
  // every chat is legacy; 2.3 reads the per-chat flag here.
  const mode = await ctx.run<IntakeMode>('mode', async () => 'legacy');

  const reasons: string[] = [];
  let done: Extract<IntakeAnswer, { kind: 'done' }> | null = null;
  for (let k = 0; k < INTAKE_ATTEMPTS && !done; k++) {
    // Lines are written inside the step, so a replay of the journal does not write them again.
    const answer = await ctx.run(`intake-${k}`, async () => {
      const a = await core.intake(update, mode);
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
    ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'handled', lastIntakeStatus: done.intakeStatus, at } satisfies ChatInboxView);
    return { outcome: 'handled', intakeStatus: done.intakeStatus, attempts: reasons.length + 1 };
  }

  const reason = `${reasons[reasons.length - 1]} after ${INTAKE_ATTEMPTS} attempts`;
  // Core stores the dead letter (id and kind only), alerts the office and tells the sender, once.
  await ctx.run('park', async () => {
    await core.park(update, reason);
    log.error(`[chat-inbox] update ${update.update_id} parked for an operator: ${reason}`);
    return true;
  });
  ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'parked', at } satisfies ChatInboxView);
  return { outcome: 'parked', attempts: INTAKE_ATTEMPTS };
}

/** Steps that throw (a wait) back off from 2 s to a 30 s ceiling, without a limit of their own. */
const WAIT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };

function inboxContext(ctx: restate.ObjectContext): InboxContext {
  return {
    run: (name, action) => ctx.run(name, action, WAIT_RETRY),
    sleep: (ms) => ctx.sleep(ms),
    set: (name, value) => ctx.set(name, value),
    now: () => ctx.date.now(),
  };
}

/** Core's client, set by index.ts when the worker has HAWA_WORKER_TOKEN; until then an update waits. */
let coreClient: ChatInboxCore | null = null;
export function useChatInboxCore(core: ChatInboxCore): void {
  coreClient = core;
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
