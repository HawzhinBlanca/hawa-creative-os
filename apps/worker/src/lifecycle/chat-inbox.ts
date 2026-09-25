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
 * Slice 2.3 routes decisions from here (PHASE2_DESIGN.md 2.2): for a chat on HAWA_LIFECYCLE_CHATS
 * (read once, in the journaled `mode` step) intake runs in mode `lifecycle` and answers what a new
 * request is instead of saving it; ChatInbox opens a RequestLifecycle for each. In either mode an
 * answer, a requester's button or a change aimed at a request the lifecycle owns comes back as a
 * decision and is routed to that request, so a chat taken off the flag still finishes its lifecycle
 * requests there. Every route is a one-way send, keyed by the update: nothing here waits for the
 * lifecycle or for Telegram. A lifecycle chat's "new request or a change?" question and its answered
 * albums are this object's state (`chat`), handed to intake with each update, not Core's memory.
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
import {
  lifecycleOwnsChat,
  type AnswerEvent,
  type ChatIntakeState,
  type IntakeDecision,
  type OpenEvent,
  type OutboundMessage,
  type RequesterDecisionEvent,
} from '@hawa/contracts';
import { requestIdFor } from '@hawa/domain';
import { withInvocationLogContext, log } from '../logging.js';
import { chatKey, type TelegramUpdateLike } from './telegram-poller.js';
import { TelegramSenderApi } from './telegram-sender.js';

/** Fields are only ever added, and only as optional (PHASE2_DESIGN.md section 4). */
export interface HandleUpdateInput {
  v: 1;
  update: TelegramUpdateLike;
  /** When the poller took the update from Telegram (ms since the epoch). */
  polledAt?: number;
}

export type IntakeMode = 'legacy' | 'lifecycle';

/** What Core's intake answered, as journaled. `decision` and `chat` only from a Core with slice 2.3. */
export type IntakeAnswer =
  | { kind: 'done'; intakeStatus: number; duplicate?: boolean; decision?: IntakeDecision; chat?: ChatIntakeState }
  | { kind: 'retry'; reason: string };

/** The Core calls ChatInbox makes (core-client.ts). A thrown error means "wait and try again". */
export interface ChatInboxCore {
  /** `chat`: the chat's state, sent in lifecycle mode only. */
  intake(update: TelegramUpdateLike, mode: IntakeMode, chat?: ChatIntakeState): Promise<IntakeAnswer>;
  park(update: TelegramUpdateLike, reason: string): Promise<void>;
}

/** Where ChatInbox routes a decision: one-way sends, each keyed so a replay sends nothing twice. */
export interface InboxRoutes {
  open(requestId: string, event: OpenEvent, idempotencyKey: string): void;
  answer(requestId: string, event: AnswerEvent, idempotencyKey: string): void;
  requesterDecision(requestId: string, event: RequesterDecisionEvent, idempotencyKey: string): void;
  /** A message to its chat's TelegramSender, keyed by its own key. */
  send(message: OutboundMessage): void;
}

/** The parts of Restate's ObjectContext the handler uses; tests pass a small journal. */
export interface InboxContext {
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
  set(name: string, value: unknown): void;
  now(): Promise<number>;
  /** State read (slice 2.3); absent in a context that keeps none. */
  get?<T>(name: string): Promise<T | null>;
  /** Slice 2.3: where decisions go. */
  routes?: InboxRoutes;
}

export interface ChatInboxView {
  v: 1;
  lastUpdateId: number;
  lastOutcome: 'handled' | 'parked' | 'routed';
  lastIntakeStatus?: number;
  at: number;
}

/** The chat's own state (slice 2.3), key `chat`: what intake reads with each update of a lifecycle chat. */
export interface ChatInboxState extends ChatIntakeState {
  v: 1;
}

export interface HandleUpdateResult {
  outcome: 'handled' | 'parked' | 'routed';
  intakeStatus?: number;
  attempts: number;
  /** For a routed decision: what it was. */
  decision?: IntakeDecision['kind'];
}

export interface HandleUpdateOptions {
  /** Whether a chat is on HAWA_LIFECYCLE_CHATS; tests pass their own. */
  lifecycleChat?: (chat: string) => boolean;
}

export const CHAT_STATE_KEY = 'chat';
/** Albums are answered once; one older than this is forgotten (Telegram sends an album within seconds). */
export const ALBUM_MEMORY_MS = 15 * 60_000;
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

/** Only a real chat (a Telegram id) can hold lifecycle requests: Core opens one for a numeric chat only. */
const isChatId = (chat: string) => /^-?\d{1,20}$/.test(chat);

/** Who sent the update or pressed the button, for the lifecycle's record. */
function senderOf(update: TelegramUpdateLike): string {
  const u = update as { callback_query?: { from?: { id?: unknown } }; message?: { from?: { id?: unknown } } };
  const id = u.callback_query?.from?.id ?? u.message?.from?.id;
  return id === undefined || id === null ? '' : String(id);
}

/** The chat's state as kept, with albums older than ALBUM_MEMORY_MS forgotten. */
export function prunedChatState(raw: unknown, now: number): ChatInboxState {
  const s = raw && typeof raw === 'object' ? (raw as ChatInboxState) : ({} as ChatInboxState);
  const albums = Object.entries(s.albumsAcked ?? {}).filter(([, at]) => Number.isFinite(at) && now - Number(at) < ALBUM_MEMORY_MS);
  return {
    v: 1,
    ...(s.pendingClarification ? { pendingClarification: s.pendingClarification } : {}),
    ...(albums.length ? { albumsAcked: Object.fromEntries(albums) } : {}),
  };
}

/**
 * Routes one decision, in order: the requests it opens or the events it hands to a request, then the
 * messages it carries. Keys are the update's (`tg:<chat>:<update>`) or the request's open key, so a
 * replayed invocation (or a second one for the same update) routes nothing twice.
 */
export function routeDecision(routes: InboxRoutes, chat: string, update: TelegramUpdateLike, decision: IntakeDecision): void {
  const updateId = update.update_id;
  const eventId = `tg:${chat}:${updateId}`;
  const actorId = senderOf(update);
  switch (decision.kind) {
    case 'new_request':
      for (const r of decision.requests) {
        const requestId = requestIdFor(chat, updateId, r.index);
        routes.open(requestId, {
          v: 1, eventId: `open:${requestId}`, requestId, tenantId: decision.tenantId ?? DEFAULT_TENANT_ID, chatId: chat,
          origin: { kind: 'telegram', chatId: chat, updateId }, draft: r.draft,
        }, `open:${requestId}`);
      }
      break;
    case 'answer':
      routes.answer(decision.requestId, {
        v: 1, eventId, questionId: decision.questionId, answer: decision.answer, actorId,
        ...(decision.callbackQueryId ? { callbackQueryId: decision.callbackQueryId } : {}),
      }, eventId);
      break;
    case 'requester': {
      const size = decision.action === 'sst' || decision.action === 'ssq' || decision.action === 'sls';
      routes.requesterDecision(decision.requestId, {
        v: 1, eventId, taskId: decision.taskId, kind: size ? 'size' : (decision.action as 'ok' | 'chg' | 'dsg'), actorId: decision.actorId || actorId,
        ...(size ? { sizeAction: decision.action } : {}),
        ...(decision.callbackQueryId ? { callbackQueryId: decision.callbackQueryId } : {}),
      }, eventId);
      break;
    }
    case 'change':
      routes.requesterDecision(decision.requestId, {
        v: 1, eventId, taskId: decision.replyToTaskId, kind: 'change', directive: decision.directive, actorId,
        ...(decision.photoFileIds?.length ? { photoFileIds: decision.photoFileIds } : {}),
      }, eventId);
      break;
    default:
      break;
  }
  const messages = 'messages' in decision && Array.isArray(decision.messages) ? decision.messages : [];
  for (const m of messages) if (m?.key && m.chatId) routes.send({ ...m, v: 1 });
}

export const INTAKE_ATTEMPTS = 5;
/** Waits between retryable answers: 2, 4, 8 and 16 s, the backoff Core's poller used. */
const retryDelayMs = (k: number) => 2000 * 2 ** k;

export async function handleUpdate(ctx: InboxContext, input: HandleUpdateInput, core: ChatInboxCore, options: HandleUpdateOptions = {}): Promise<HandleUpdateResult> {
  const update = input.update;
  const chat = chatKey(update);
  // The one read of the per-chat flag, journaled so that a replay on the other colour agrees with it
  // even if the flag changed in between. After a request is open, only its owner decides (Core reads
  // tasks.request_id), so this decides new requests only.
  const lifecycleChat = options.lifecycleChat ?? ((c: string) => lifecycleOwnsChat(c, process.env));
  const mode = await ctx.run<IntakeMode>('mode', async () => (isChatId(chat) && lifecycleChat(chat) ? 'lifecycle' : 'legacy'));
  // A lifecycle chat's state goes to intake with the update (its question, its albums).
  let chatState: ChatInboxState | undefined;
  if (mode === 'lifecycle' && ctx.get) chatState = prunedChatState(await ctx.get<ChatInboxState>(CHAT_STATE_KEY), await ctx.now());

  const reasons: string[] = [];
  let done: Extract<IntakeAnswer, { kind: 'done' }> | null = null;
  for (let k = 0; k < INTAKE_ATTEMPTS && !done; k++) {
    // Lines are written inside the step, so a replay of the journal does not write them again.
    const answer = await ctx.run(`intake-${k}`, async () => {
      const a = mode === 'lifecycle' ? await core.intake(update, mode, stripVersion(chatState)) : await core.intake(update, mode);
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
    // The chat's state after the update, as intake left it (lifecycle mode only).
    if (mode === 'lifecycle' && done.chat) ctx.set(CHAT_STATE_KEY, prunedChatState({ ...done.chat, v: 1 }, at));
    const decision = done.decision;
    if (decision && decision.kind === 'park') {
      await parkUpdate(ctx, core, update, decision.reason);
      ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'parked', at } satisfies ChatInboxView);
      return { outcome: 'parked', attempts: reasons.length + 1 };
    }
    if (decision) {
      if (!ctx.routes) throw new Error('ChatInbox cannot route a decision: this context has no routes');
      routeDecision(ctx.routes, chat, update, decision);
      ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'routed', lastIntakeStatus: done.intakeStatus, at } satisfies ChatInboxView);
      return { outcome: 'routed', intakeStatus: done.intakeStatus, attempts: reasons.length + 1, decision: decision.kind };
    }
    ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'handled', lastIntakeStatus: done.intakeStatus, at } satisfies ChatInboxView);
    return { outcome: 'handled', intakeStatus: done.intakeStatus, attempts: reasons.length + 1 };
  }

  const reason = `${reasons[reasons.length - 1]} after ${INTAKE_ATTEMPTS} attempts`;
  await parkUpdate(ctx, core, update, reason);
  ctx.set('inbox', { v: 1, lastUpdateId: update.update_id, lastOutcome: 'parked', at } satisfies ChatInboxView);
  return { outcome: 'parked', attempts: INTAKE_ATTEMPTS };
}

/** Core stores the dead letter (id and kind only), alerts the office and tells the sender, once. */
async function parkUpdate(ctx: InboxContext, core: ChatInboxCore, update: TelegramUpdateLike, reason: string): Promise<void> {
  await ctx.run('park', async () => {
    await core.park(update, reason);
    log.error(`[chat-inbox] update ${update.update_id} parked for an operator: ${reason}`);
    return true;
  });
}

/** The state as intake reads it (without this object's own version field). */
function stripVersion(s: ChatInboxState | undefined): ChatIntakeState {
  if (!s) return {};
  const { v: _v, ...rest } = s;
  void _v;
  return rest;
}

/** Steps that throw (a wait) back off from 2 s to a 30 s ceiling, without a limit of their own. */
const WAIT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };

/** RequestLifecycle's handlers ChatInbox sends to, named here (not imported: RequestLifecycle is the older module). */
type LifecycleInbound = {
  open: (ctx: restate.ObjectContext, e: OpenEvent) => Promise<unknown>;
  answer: (ctx: restate.ObjectContext, e: AnswerEvent) => Promise<unknown>;
  requesterDecision: (ctx: restate.ObjectContext, e: RequesterDecisionEvent) => Promise<unknown>;
};
const RequestLifecycleInbound: restate.VirtualObjectDefinition<'RequestLifecycle', LifecycleInbound> = { name: 'RequestLifecycle' };

function inboxContext(ctx: restate.ObjectContext): InboxContext {
  return {
    run: (name, action) => ctx.run(name, action, WAIT_RETRY),
    sleep: (ms) => ctx.sleep(ms),
    set: (name, value) => ctx.set(name, value),
    now: () => ctx.date.now(),
    get: <T>(name: string) => ctx.get<T>(name) as Promise<T | null>,
    routes: {
      open: (requestId, event, key) => { ctx.objectSendClient(RequestLifecycleInbound, requestId).open(event, restate.rpc.sendOpts({ idempotencyKey: key })); },
      answer: (requestId, event, key) => { ctx.objectSendClient(RequestLifecycleInbound, requestId).answer(event, restate.rpc.sendOpts({ idempotencyKey: key })); },
      requesterDecision: (requestId, event, key) => { ctx.objectSendClient(RequestLifecycleInbound, requestId).requesterDecision(event, restate.rpc.sendOpts({ idempotencyKey: key })); },
      send: (m) => { ctx.objectSendClient(TelegramSenderApi, String(m.chatId)).send(m, restate.rpc.sendOpts({ idempotencyKey: m.key })); },
    },
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
    /** The chat's own state (slice 2.3): its waiting question and answered albums. */
    getChat: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<ChatInboxState | null> =>
      (await ctx.get<ChatInboxState>(CHAT_STATE_KEY)) ?? null
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
