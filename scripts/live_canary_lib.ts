/**
 * The nightly live canary's conversation and its checks (ADR-240). Pure: what is said, what the bot is
 * expected to answer, and how its answers are judged, over a `CanaryWorld` that live_canary.ts backs
 * with Restate (ingress for the updates, the admin SQL for the journal and the request objects) and the
 * tests back with a fake. Nothing here talks to production by itself.
 *
 * The bot is judged semantically: the request object's stage after each turn, and key phrases in what
 * it said (never whole strings), so a wording change does not fail the night but a wrong reading does.
 */
import { isReservedCanaryChatId } from '../packages/contracts/src/canary.js';

export interface CanaryConfig {
  chatId: string;
  clientId: string;
  /** How a requester names the canary client in a brief (a name or short code intake recognises). */
  clientName: string;
  /** The spend a paid night may report before the canary fails (the hard cap is the client's limit). */
  maxUsd: number;
  /** How long a turn may take to be answered, and how long the bot must be quiet before it is judged. */
  replyTimeoutMs: number;
  quietMs: number;
  /** How long a paid night waits for the draft. */
  draftTimeoutMs: number;
}

export function canaryConfigFromEnv(env: Record<string, string | undefined>): { config: CanaryConfig | null; problems: string[] } {
  const problems: string[] = [];
  const chatId = env.HAWA_CANARY_CHAT_ID?.trim() || '';
  const clientId = env.HAWA_CANARY_CLIENT_ID?.trim() || '';
  const clientName = env.HAWA_CANARY_CLIENT_NAME?.trim() || '';
  if (!isReservedCanaryChatId(chatId)) problems.push('HAWA_CANARY_CHAT_ID is not set to an id from 4503599627370496 to 9007199254740991');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) problems.push('HAWA_CANARY_CLIENT_ID is not a client id');
  if (!clientName || clientName.length > 60 || /[\n\r]/.test(clientName)) problems.push('HAWA_CANARY_CLIENT_NAME is not set');
  const number = (key: string, fallback: number) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) { problems.push(`${key} is not a positive number`); return fallback; }
    return value;
  };
  const config: CanaryConfig = { chatId, clientId: clientId.toLowerCase(), clientName,
    maxUsd: number('HAWA_CANARY_MAX_USD', 0.5), replyTimeoutMs: number('HAWA_CANARY_REPLY_TIMEOUT_MS', 120_000),
    quietMs: number('HAWA_CANARY_QUIET_MS', 6000), draftTimeoutMs: number('HAWA_CANARY_DRAFT_TIMEOUT_MS', 30 * 60_000) };
  return { config: problems.length ? null : config, problems };
}

/** What the bot said: one TelegramSender invocation, decoded from Restate's journal. */
export interface BotMessage {
  invocationId: string;
  /** The TelegramSender object's key: the chat it was addressed to. */
  chatId: string;
  createdAtMs: number;
  key: string;
  kind: string;
  text: string;
  taskId?: string;
  /** Set when an office alert about a canary request was moved to the canary chat. */
  canaryFor?: string;
  /** What the sender's step answered; `pending` until it has. */
  outcome: 'canary_sink' | 'sent' | 'refused' | 'uncertain' | 'pending' | 'unknown';
}

/** A RequestLifecycle object's state, as far as the canary reads it. */
export interface RequestView {
  requestId: string;
  chatId: string;
  stage: string;
  rev: number;
  taskId: string;
  title?: string;
}

/** The brief a request was opened from (RequestLifecycle.open's input). */
export interface OpenDraft {
  clientId: string | null;
  title: string;
  rawText: string;
  exactCopy: Array<{ role?: string; text: string }>;
  headlineEn?: string;
  copyMethod?: string;
}

/** Everything the canary does to and reads from the live system. */
export interface CanaryWorld {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Whether Core and Restate answer; null when they do, else what is wrong. */
  health(): Promise<string | null>;
  /** One text message from the canary chat, as Telegram would deliver it. */
  send(updateId: number, messageId: number, text: string): Promise<void>;
  /** Whether ChatInbox has finished the update (its invocation, sent at `sentAtMs`, completed). */
  inboxDone(updateId: number, sentAtMs: number): Promise<boolean>;
  /** Every TelegramSender invocation created at or after `sinceMs`, any chat. */
  botMessages(sinceMs: number): Promise<BotMessage[]>;
  /** Every request object of the canary chat, whatever its stage. */
  canaryRequests(): Promise<RequestView[]>;
  openDraft(requestId: string): Promise<OpenDraft | null>;
  /** The most a design run of the task reported spending, or null when none ran. */
  designSpend(taskId: string): Promise<number | null>;
}

export interface Check { step: string; name: string; ok: boolean; detail: string }

export interface CanaryResult {
  v: 1;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string;
  /** paid: the first brief got a real automatic design round; stub: every canary request went to a designer. */
  mode: 'paid' | 'stub' | 'unknown';
  checks: Check[];
  requests: Array<{ requestId: string; title?: string; stage: string; openedThisRun: boolean }>;
  spentUsd: number | null;
  reason?: string;
}

/** Stages a canary request may be left in; anything else is cleaned up (ADR-230 withdraw). */
export const CLOSED_STAGES = new Set(['cancelled', 'delivered', 'rejected', 'expired']);
/** Stages a requester's cancel withdraws. */
export const WITHDRAWABLE_STAGES = new Set(['manual', 'designing', 'awaiting_answer', 'in_review']);

/**
 * Update ids for one night: 9,000,000,000,000 + the day's number × 1000 + the turn. Far above real
 * update ids (about 6.4e8), below the copy reader's 2^51 offset, never the owner's manual tests'
 * 8,000,000,000 + n, and new every night (Restate keeps `tg-<id>` idempotency keys for 7 days).
 */
export const CANARY_UPDATE_BASE = 9_000_000_000_000;
export function nightUpdateBase(nowMs: number): number {
  return CANARY_UPDATE_BASE + Math.floor(nowMs / 86_400_000) * 1000;
}

const NONCES = ['Amber', 'Birch', 'Cedar', 'Coral', 'Dahlia', 'Ember', 'Fennel', 'Garnet', 'Hazel', 'Indigo', 'Jasper', 'Juniper',
  'Laurel', 'Linden', 'Marigold', 'Myrtle', 'Nutmeg', 'Olive', 'Poppy', 'Quartz', 'Rowan', 'Saffron', 'Sorrel', 'Tamarind',
  'Umber', 'Violet', 'Willow', 'Yarrow', 'Zinnia', 'Basil', 'Clover'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface NightPlan {
  nonce: string;
  /** The three events: named, cancelled at once, and named only after "who is this for?". */
  eventA: string; eventB: string; eventC: string;
  dateA: string; dateB: string; dateC: string;
  briefA: string; changeA: string; status: string; thanks: string; videos: string; cancelA: string;
  briefB: string; cancelB: string;
  briefC: string; answerC: string; cancelC: string;
  probe: string;
}

/**
 * The fixed conversation, with a word of the night in every event's name, so tonight's messages are
 * told from last night's and a leak names itself. No event name contains the client's name: the third
 * brief must name no organisation.
 */
export function nightPlan(nowMs: number, clientName: string): NightPlan {
  const day = Math.floor(nowMs / 86_400_000);
  const nonce = NONCES[day % NONCES.length];
  const date = (days: number) => { const d = new Date((day + days) * 86_400_000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const eventA = `${nonce} Reading Workshop`, eventB = `${nonce} Science Fair`, eventC = `${nonce} Parents Evening`;
  const [dateA, dateB, dateC] = [date(45), date(52), date(59)];
  return {
    nonce, eventA, eventB, eventC, dateA, dateB, dateC,
    probe: 'hi',
    briefA: `Could you design a ${clientName} poster for our ${eventA}? It's on ${dateA} at 10:00 AM in the Main Hall, Erbil. Registration is free.`,
    changeA: 'also please add that seats are limited',
    status: "what's the status of my design?",
    thanks: 'thanks!',
    videos: 'can you also make videos?',
    cancelA: `please cancel the ${eventA} poster, it was only a test`,
    briefB: `Could you design a ${clientName} flyer for our ${eventB}? It's on ${dateB} at 6:00 PM in the Library, Erbil.`,
    cancelB: `cancel the ${eventB} flyer, sorry, it was by mistake`,
    briefC: `Could you design a poster for our ${eventC}? It's on ${dateC} at 4:00 PM in the School Garden, Erbil. Everyone is welcome.`,
    answerC: `it's for ${clientName}`,
    cancelC: `cancel the ${eventC} poster, we don't need it anymore`,
  };
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** An error or status code: capitals and digits joined by underscores (SENDER_DAILY_CAP, HTTP_409). */
const CODE_IN_TEXT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
/** A chat or user id: nine or more digits in a row (dates and times never are). */
const LONG_NUMBER = /\d{9,}/;

/** What a requester-facing message must never carry: ids, internal codes, chat ids. */
export function internalCodeProblems(text: string, canaryChatId: string): string[] {
  const out: string[] = [];
  const plain = text.replace(/<[^>]+>/g, '');
  if (UUID_IN_TEXT.test(plain)) out.push(`a UUID (${UUID_IN_TEXT.exec(plain)![0]})`);
  if (CODE_IN_TEXT.test(plain)) out.push(`an internal code (${CODE_IN_TEXT.exec(plain)![0]})`);
  const rest = plain.replace(new RegExp(UUID_IN_TEXT.source, 'gi'), '');
  if (rest.includes(canaryChatId)) out.push('the chat id');
  else if (LONG_NUMBER.test(rest)) out.push(`a long id (${LONG_NUMBER.exec(rest)![0]})`);
  return out;
}

/**
 * ADR-232: the words on the design are taken from the requester's sentence, not the sentence itself:
 * the event's name as the headline, its date on a line, and no line that is the whole brief.
 */
export function copyExtractionProblems(draft: OpenDraft, expected: { headline: string; date: string; brief: string }): string[] {
  const out: string[] = [];
  const lines = draft.exactCopy.map((c) => String(c?.text ?? '').trim()).filter(Boolean);
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const headline = draft.exactCopy.find((c) => c?.role === 'headline')?.text ?? draft.headlineEn ?? lines[0] ?? '';
  if (squash(headline) !== squash(expected.headline)) out.push(`the headline is "${headline}", not "${expected.headline}"`);
  if (!lines.some((l) => squash(l).includes(squash(expected.date)))) out.push(`no line carries the date "${expected.date}"`);
  if (lines.some((l) => squash(l) === squash(expected.brief) || squash(l).length > 140)) out.push('a line is the whole brief sentence');
  if (squash(draft.title).includes('could you design')) out.push(`the title is the raw sentence ("${draft.title}")`);
  return out;
}

/**
 * Anything about tonight's requests that went to a chat other than the canary's and was not recorded
 * by the sink: a message that reached (or may have reached) a real person. Office alerts recorded in the
 * office member's own sender (`canary_sink`) never left it.
 */
export function leakProblems(messages: BotMessage[], canaryChatId: string, tokens: string[], requestIds: string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.chatId === canaryChatId) {
      if (m.outcome !== 'canary_sink' && m.outcome !== 'pending') out.push(`a message to the canary chat was ${m.outcome}, not recorded (${m.key})`);
      continue;
    }
    const about = tokens.some((t) => t && m.text.includes(t)) || requestIds.some((id) => m.key.includes(id));
    if (about && m.outcome !== 'canary_sink') out.push(`a message about a canary request went to chat ${m.chatId} (${m.outcome}, ${m.key})`);
  }
  return out;
}

export function summaryText(result: CanaryResult): string {
  const failed = result.checks.filter((c) => !c.ok);
  const lines = [
    `Hawa nightly canary ${result.status.toUpperCase()} (${result.mode} night) ${result.startedAt} → ${result.finishedAt}`,
    `${result.checks.length - failed.length}/${result.checks.length} checks passed; spend ${result.spentUsd === null ? 'none' : `$${result.spentUsd.toFixed(4)}`}`,
    ...(result.reason ? [`Reason: ${result.reason}`] : []),
    ...failed.map((c) => `FAIL ${c.step} · ${c.name}: ${c.detail}`),
    ...result.requests.map((r) => `request ${r.requestId.slice(0, 8)} ${r.stage}${r.title ? ` "${r.title}"` : ''}${r.openedThisRun ? '' : ' (from an earlier run)'}`),
  ];
  return `${lines.join('\n')}\n`;
}

class CanaryAbort extends Error {}

/**
 * Plays the night's conversation and judges every answer. Every request it opens, and any an earlier
 * run left open, ends withdrawn (the requester's own cancel) before it returns, whatever failed.
 */
export async function runCanary(world: CanaryWorld, config: CanaryConfig): Promise<CanaryResult> {
  const startedMs = world.now();
  const startedAt = new Date(startedMs).toISOString();
  const plan = nightPlan(startedMs, config.clientName);
  const base = nightUpdateBase(startedMs);
  const checks: Check[] = [];
  let step = 'preflight';
  let turn = 0;
  let mode: CanaryResult['mode'] = 'unknown';
  let spentUsd: number | null = null;
  const before = new Map<string, RequestView>();
  const opened = new Set<string>();
  // A check keeps its detail (what the bot said, the stage it found) only when it failed.
  const check = (name: string, ok: boolean, detail = ''): boolean => { checks.push({ step, name, ok, detail: ok ? '' : detail || 'not as expected' }); return ok; };
  const must = (name: string, ok: boolean, detail = '') => { if (!check(name, ok, detail)) throw new CanaryAbort(`${step}: ${name}: ${detail}`); };
  const ownMessages = (all: BotMessage[]) => all.filter((m) => m.chatId === config.chatId && !m.canaryFor);
  const textOf = (all: BotMessage[]) => ownMessages(all).map((m) => m.text).join('\n---\n');

  const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> => {
    const deadline = world.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (ok(value) || world.now() >= deadline) return value;
      await world.sleep(2000);
    }
  };

  /** Sends one line and returns what the bot said after it, once ChatInbox is done and the bot is quiet. */
  const say = async (text: string): Promise<BotMessage[]> => {
    turn += 1;
    const updateId = base + turn;
    const sentAt = world.now();
    await world.send(updateId, updateId - CANARY_UPDATE_BASE, text);
    const done = await waitFor(() => world.inboxDone(updateId, sentAt), Boolean, config.replyTimeoutMs);
    check(`"${text.slice(0, 40)}" was taken by ChatInbox`, done, `ChatInbox had not finished update ${updateId} after ${config.replyTimeoutMs / 1000} s`);
    const deadline = world.now() + config.replyTimeoutMs;
    let seen = -1, quietFrom = world.now();
    let messages: BotMessage[] = [];
    for (;;) {
      messages = (await world.botMessages(sentAt)).filter((m) => m.createdAtMs >= sentAt);
      if (messages.length !== seen) { seen = messages.length; quietFrom = world.now(); }
      const answered = ownMessages(messages).length > 0;
      if ((answered && world.now() - quietFrom >= config.quietMs) || world.now() >= deadline) break;
      await world.sleep(1000);
    }
    return messages;
  };
  const requests = async () => new Map((await world.canaryRequests()).map((r) => [r.requestId, r] as const));
  const newRequest = async (): Promise<RequestView | null> => {
    const now = await waitFor(requests, (m) => [...m.keys()].some((id) => !before.has(id) && !opened.has(id)), config.replyTimeoutMs);
    const fresh = [...now.values()].find((r) => !before.has(r.requestId) && !opened.has(r.requestId)) ?? null;
    if (fresh) opened.add(fresh.requestId);
    return fresh;
  };
  const stageOf = async (requestId: string) => (await requests()).get(requestId)?.stage;
  const noNewRequest = async () => [...(await requests()).keys()].every((id) => before.has(id) || opened.has(id));
  const answeredWith = (all: BotMessage[], pattern: RegExp) => pattern.test(textOf(all));

  /** The requester's cancel, answering "yes" when the bot asks to be sure; true once it is withdrawn. */
  const cancel = async (requestId: string, words: string): Promise<boolean> => {
    let said = await say(words);
    if (/do you want me to cancel/i.test(textOf(said)) && (await stageOf(requestId)) !== 'cancelled') said = [...said, ...await say('yes')];
    const stage = await waitFor(() => stageOf(requestId), (s) => s === 'cancelled', 20_000);
    return stage === 'cancelled' && /cancel/i.test(textOf(said));
  };

  let reason: string | undefined;
  let crashed = false;
  try {
    const problem = await world.health();
    must('Core and Restate answer', problem === null, problem ?? '');
    for (const [id, r] of await requests()) before.set(id, r);

    // The sink first: nothing else is said until a reply is shown to be recorded, not sent.
    step = 'sink';
    const hello = await say(plan.probe);
    const own = ownMessages(hello);
    must('the bot answers the canary chat', own.length > 0, 'no reply was recorded for "hi"');
    must('replies to the canary chat are recorded, never sent', own.every((m) => m.outcome === 'canary_sink'),
      `outcomes: ${own.map((m) => m.outcome).join(', ')} (is HAWA_CANARY_CHAT_ID set for the worker?)`);
    must('the canary chat is admitted to intake', !/only set up for the Hawa office team/i.test(textOf(hello)),
      'intake refused the sender (add the canary chat id to TELEGRAM_INTAKE_ALLOWED_USERS)');
    check('a greeting is answered as one', answeredWith(hello, /\bhi\b|hello|what would you like designed/i), textOf(hello).slice(0, 200));

    step = 'leftovers';
    for (const r of before.values()) {
      if (CLOSED_STAGES.has(r.stage) || !WITHDRAWABLE_STAGES.has(r.stage)) continue;
      check(`an earlier run's request ${r.requestId.slice(0, 8)} is withdrawn`,
        await cancel(r.requestId, `please cancel ${r.title ? `the ${r.title.replace(/…$/, '')}` : 'it'}, it was only a test`), `still ${await stageOf(r.requestId)}`);
    }

    // 1. A brief naming the canary client.
    step = 'brief';
    const briefSaid = await say(plan.briefA);
    const a = await newRequest();
    must('the brief opens one request', Boolean(a), 'no request was opened');
    mode = a!.stage === 'designing' ? 'paid' : a!.stage === 'manual' ? 'stub' : 'unknown';
    check('the request is designing (paid night) or with a designer (no paid round)', mode !== 'unknown', `stage ${a!.stage}`);
    const draft = await world.openDraft(a!.requestId);
    if (check('the brief is readable from the request', Boolean(draft))) {
      check('the request is for the canary client', draft!.clientId?.toLowerCase() === config.clientId, `client ${draft!.clientId}`);
      const copy = copyExtractionProblems(draft!, { headline: plan.eventA, date: plan.dateA, brief: plan.briefA });
      check('the copy is taken from the sentence (headline, date line, no whole sentence)', copy.length === 0, copy.join('; '));
    }
    check('the requester is told it was taken, by name', answeredWith(briefSaid, new RegExp(plan.nonce)) &&
      answeredWith(briefSaid, mode === 'paid' ? /draft/i : /designer/i), textOf(briefSaid).slice(0, 300));

    // 2. A change while the design is being made.
    step = 'change';
    const changeSaid = await say(plan.changeA);
    check('the change is acknowledged for that design', answeredWith(changeSaid, /got it|kept|add/i) && !answeredWith(changeSaid, /redo|which design|a new design/i),
      textOf(changeSaid).slice(0, 300));
    check('the change opens nothing new', await noNewRequest());

    // 3. A status question.
    step = 'status';
    const statusSaid = await say(plan.status);
    check('status names the design and where it is', answeredWith(statusSaid, new RegExp(plan.nonce)) &&
      answeredWith(statusSaid, /designer|being designed|being made|working on|final check|draft/i), textOf(statusSaid).slice(0, 300));
    check('status changes nothing', (await stageOf(a!.requestId)) !== 'cancelled' && await noNewRequest());

    // 4. Thanks.
    step = 'thanks';
    const thanksSaid = await say(plan.thanks);
    check('thanks is answered as thanks', answeredWith(thanksSaid, /thank/i), textOf(thanksSaid).slice(0, 200));
    check('thanks changes nothing', await noNewRequest());

    // 5. A question the bot cannot answer itself (live test L11).
    step = 'question';
    const videosSaid = await say(plan.videos);
    check('a question is passed on as a question, not a change', answeredWith(videosSaid, /question/i) &&
      !answeredWith(videosSaid, /added that|your change|i'll redo|redo /i), textOf(videosSaid).slice(0, 300));
    check('the question opens nothing', await noNewRequest());

    // 6. After the draft (a paid night), cancel with a reason.
    step = 'draft';
    if (mode === 'paid') {
      const stage = await waitFor(() => stageOf(a!.requestId), (s) => s !== 'designing', config.draftTimeoutMs);
      check('the paid round ends in a draft for the office', stage === 'in_review', `stage ${stage}`);
      spentUsd = await world.designSpend((await requests()).get(a!.requestId)!.taskId);
      check(`the round spent at most $${config.maxUsd.toFixed(2)}`, spentUsd === null || spentUsd <= config.maxUsd,
        `spent $${spentUsd?.toFixed(4)}`);
    }
    step = 'cancel';
    check('a cancel with a reason withdraws the design', await cancel(a!.requestId, plan.cancelA), `stage ${await stageOf(a!.requestId)}`);

    // 7. A second brief, cancelled at once.
    step = 'cancel-at-once';
    await say(plan.briefB);
    const b = await newRequest();
    if (check('the second brief opens a request', Boolean(b))) {
      check('a request cancelled at once is withdrawn', await cancel(b!.requestId, plan.cancelB), `stage ${await stageOf(b!.requestId)}`);
    }

    // 8. A brief naming no organisation: "who is this for?", then the answer.
    step = 'who';
    const whoSaid = await say(plan.briefC);
    check('a brief naming no organisation is asked who it is for', answeredWith(whoSaid, /who is this (design )?for/i), textOf(whoSaid).slice(0, 300));
    check('nothing opens before the answer', await noNewRequest());
    await say(plan.answerC);
    const c = await newRequest();
    if (check('the answer opens the kept brief', Boolean(c))) {
      const draftC = await world.openDraft(c!.requestId);
      check('the answered brief is for the canary client', draftC?.clientId?.toLowerCase() === config.clientId, `client ${draftC?.clientId}`);
      check('it is withdrawn when cancelled', await cancel(c!.requestId, plan.cancelC), `stage ${await stageOf(c!.requestId)}`);
    }
  } catch (error) {
    if (error instanceof CanaryAbort) reason = error.message;
    else { crashed = true; reason = `${step}: ${error instanceof Error ? error.message : String(error)}`; }
  }

  // Every request of tonight, and any left open, ends withdrawn: asked again by name, once.
  step = 'cleanup';
  let finalRequests = new Map<string, RequestView>();
  try {
    for (const r of (await requests()).values()) {
      if (!WITHDRAWABLE_STAGES.has(r.stage)) continue;
      await cancel(r.requestId, `please cancel ${r.title ? `the ${r.title.replace(/…$/, '')}` : 'it'}, it was only a test`).catch(() => false);
    }
    finalRequests = await requests();
    const open = [...finalRequests.values()].filter((r) => (opened.has(r.requestId) || before.has(r.requestId)) && !CLOSED_STAGES.has(r.stage));
    check('every canary request ends closed', open.length === 0, open.map((r) => `${r.requestId.slice(0, 8)} ${r.stage}`).join(', '));
    const tonight = [...opened].map((id) => finalRequests.get(id)).filter((r): r is RequestView => Boolean(r));
    check("tonight's requests end withdrawn", tonight.every((r) => r.stage === 'cancelled'), tonight.map((r) => `${r.requestId.slice(0, 8)} ${r.stage}`).join(', '));
  } catch (error) {
    crashed = true;
    reason = reason ?? `cleanup: ${error instanceof Error ? error.message : String(error)}`;
    check('every canary request ends closed', false, 'the requests could not be read');
  }

  // What was said tonight, judged as a whole: requester messages carry no internals, nothing leaked.
  step = 'hygiene';
  try {
    const all = (await world.botMessages(startedMs)).filter((m) => m.createdAtMs >= startedMs);
    const internals = ownMessages(all).flatMap((m) => internalCodeProblems(m.text, config.chatId).map((p) => `${p} in "${m.text.slice(0, 80)}"`));
    check('no requester message carries an id, a code or a chat id', internals.length === 0, internals.slice(0, 5).join('; '));
    const leaks = leakProblems(all, config.chatId, [plan.eventA, plan.eventB, plan.eventC], [...opened]);
    check('nothing about the canary reached anyone', leaks.length === 0, leaks.slice(0, 5).join('; '));
  } catch (error) {
    crashed = true;
    check('the night could be read back', false, error instanceof Error ? error.message : String(error));
  }

  const failed = checks.some((c) => !c.ok);
  return {
    v: 1,
    // error: the canary itself could not finish (an exception, not a wrong answer); both are alerted.
    status: crashed ? 'error' : failed || reason ? 'failed' : 'passed',
    startedAt, finishedAt: new Date(world.now()).toISOString(), mode, checks,
    requests: [...finalRequests.values()].filter((r) => opened.has(r.requestId) || before.has(r.requestId) && !CLOSED_STAGES.has(before.get(r.requestId)!.stage))
      .map((r) => ({ requestId: r.requestId, ...(r.title ? { title: r.title } : {}), stage: r.stage, openedThisRun: opened.has(r.requestId) })),
    spentUsd,
    ...(reason ? { reason } : {}),
  };
}
