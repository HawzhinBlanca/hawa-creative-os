import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, questionIdOf, type IntakeAnswerBody, type ProjectionResponse } from '@hawa/contracts';
import { plan, projectionRequestFor, requestIdFor } from '@hawa/domain';
import { createApp } from '../src/app.js';

/**
 * Intake's decide mode (slice 2.3 part C; PHASE2_DESIGN.md 2.2 and 3): the worker's ChatInbox hands an
 * update to POST /v1/internal/telegram/intake with the chat's mode, and intake answers what it decided
 * instead of saving or sending for what the request lifecycle owns:
 * - mode 'lifecycle': a new request is answered `new_request` with its classified draft, and nothing
 *   is saved or sent; the decision is written before it is answered, so the same update asked again
 *   is answered from the record (no second paid classification);
 * - both modes: a requester's button, an answer and a change aimed at a lifecycle-owned task are
 *   routed, never acted on by Core as well; without a ChatInbox to route to they are refused;
 * - the "new or a change?" question of a lifecycle chat lives in ChatInbox's state, not Core's memory.
 */
const classifier = vi.hoisted(() => ({ clarifyFor: null as string | null, instructionOnlyFor: null as string | null }));
vi.mock('../src/services/telegram-classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/telegram-classifier.js')>();
  return {
    ...actual,
    classifyInboundTelegramMessage: vi.fn(async (input: Parameters<typeof actual.classifyInboundTelegramMessage>[0], options?: Parameters<typeof actual.classifyInboundTelegramMessage>[1]) => {
      if (classifier.clarifyFor && input.messageText === classifier.clarifyFor) {
        return { kind: 'feedback', intent: 'revision_feedback', confidence: 0.5, isInstructionOnly: false, needsClarification: true, clarifyingQuestion: 'Is this a change to your last design, or a new one?', directive: input.messageText, reason: 'test' };
      }
      if (classifier.instructionOnlyFor && input.messageText === classifier.instructionOnlyFor) {
        return { kind: 'new_brief', intent: 'design_request', confidence: 0.9, isInstructionOnly: true, needsClarification: false, directive: input.messageText, reason: 'test' };
      }
      return actual.classifyInboundTelegramMessage(input, options);
    }),
  };
});
const { classifyInboundTelegramMessage } = await import('../src/services/telegram-classifier.js');
// The owner lookup, made to fail as a database that dropped the connection fails.
const ownerLookup = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/services/telegram-intake/decide-mode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/telegram-intake/decide-mode.js')>();
  return {
    ...actual,
    lifecycleOwnerOf: vi.fn(async (...args: Parameters<typeof actual.lifecycleOwnerOf>) => {
      if (ownerLookup.fail) throw new Error('Connection terminated unexpectedly');
      return actual.lifecycleOwnerOf(...args);
    }),
  };
});

const TENANT = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const OFFICE = 91000013;
const WORKER = ['worker', 'decide', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  // A bot token, so a message Core sends would reach the recorded Telegram: "nothing sent" means it.
  process.env.TELEGRAM_BOT_TOKEN = ['700000456', ['decide', 'fixture', 'bot'].join('_')].join(':');
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  vi.unstubAllEnvs();
  classifier.clarifyFor = null;
  classifier.instructionOnlyFor = null;
  ownerLookup.fail = false;
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const asOwner = <T>(fn: (trx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>) =>
  withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
const chatId = () => 63_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_200_000_000 + Math.floor(Math.random() * 800_000_000);
const from = { id: OFFICE, is_bot: false, first_name: 'Owner' };
const text = (id: number, chat: number, words: string, extra: Record<string, unknown> = {}) => ({
  update_id: id, message: { message_id: id % 100000, from, chat: { id: chat, type: 'private' }, date: 1790000000, text: words, ...extra },
});
const button = (id: number, chat: number, data: string) => ({
  update_id: id, callback_query: { id: `cb-${id}`, from, data, message: { message_id: 5, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'draft' } },
});
const BRIEF = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';

const INGRESS = 'http://restate-ingress.test:8080';
/** Telegram and Restate's ingress, recorded: nothing Core sends in decide mode may reach Telegram. */
function fakeTelegram(ingress: { status?: number } = {}) {
  const realFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  const restate: Array<{ path: string; key: string | null; body: any }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${INGRESS}/`)) {
      const headers = new Headers(init?.headers);
      restate.push({ path: url.slice(INGRESS.length), key: headers.get('idempotency-key'), body: JSON.parse(String(init?.body)) });
      const status = ingress.status ?? 202;
      return Response.json(status < 300 ? { invocationId: `inv_${restate.length}`, status: 'Accepted' } : { message: 'down' }, { status });
    }
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    sent.push({ url: url.replace(/bot[^/]+/, 'bot…'), ...body });
    return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
  });
  return { sent, restate };
}

/** As the worker's ChatInbox asks (it routes decisions); `{ routes: false }` asks as a ChatInbox built before 2.3C. */
const intake = async (app: any, update: unknown, mode: 'legacy' | 'lifecycle', chat?: unknown, opts: { routes?: boolean } = {}) => {
  const body = { v: 1, update, mode, ...(chat ? { chat } : {}), ...(opts.routes === false ? {} : { routesDecisions: true }) };
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as IntakeAnswerBody & Record<string, any> };
};
const tasksInChat = async (chat: number) =>
  (await asOwner((trx) => trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()))
    .filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

/** A request the lifecycle owns, opened through Core's projection as the worker's RequestLifecycle opens one. */
async function lifecycleRequest(app: any, chat: number) {
  const requestId = requestIdFor(String(chat), 700_001, 0);
  const ev = {
    type: 'open' as const, v: 1 as const, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: String(chat),
    origin: { kind: 'telegram' as const, chatId: String(chat), updateId: 700_001 },
    draft: { title: 'KAAE: members evening…', rawText: BRIEF, clientId: KAAE, designInstructions: '', exactCopy: [], autoGenerate: true },
  };
  const p = plan(undefined, ev, Date.now());
  if (p.ignored) throw new Error('ignored');
  const res = await app.request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST', headers: worker, body: JSON.stringify(projectionRequestFor(undefined, ev, p)) });
  expect(res.status).toBe(200);
  const answer = (await res.json()) as ProjectionResponse;
  return { requestId, taskId: (answer.results[0] as { taskId: string }).taskId };
}
/** Opens a decided draft through Core's projection, as RequestLifecycle.open does for update `update` of `chat`. */
async function openDecided(app: any, chat: number, update: number, draft: unknown) {
  const requestId = requestIdFor(String(chat), update, 0);
  const ev = {
    type: 'open' as const, v: 1 as const, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: String(chat),
    origin: { kind: 'telegram' as const, chatId: String(chat), updateId: update }, draft: draft as any,
  };
  const p = plan(undefined, ev, Date.now());
  if (p.ignored) throw new Error('ignored');
  const res = await app.request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST', headers: worker, body: JSON.stringify(projectionRequestFor(undefined, ev, p)) });
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectionResponse).results[0] as { taskId: string; autoGenerate: boolean; stage: string; autoGenerateDeclined?: string };
}
const setState = (taskId: string, state: string) => asOwner((trx) => sql`UPDATE hawa.tasks SET state = ${state}::hawa.task_state WHERE id = ${taskId}::uuid`.execute(trx));

describe('intake in mode lifecycle (a flagged chat)', () => {
  it('a new request is decided, not saved: its draft goes back, nothing is sent, and the decision is on record', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const update = text(updateId(), chat, BRIEF);
    const app = createApp({ db } as any);

    const first = await intake(app, update, 'lifecycle', {});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ v: 1, kind: 'decision', intakeStatus: 200, decision: { kind: 'new_request', tenantId: TENANT } });
    const decision = first.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>;
    expect(decision.requests).toHaveLength(1);
    expect(decision.requests[0]).toMatchObject({ index: 0, draft: { clientId: KAAE, autoGenerate: true, rawText: BRIEF, variant: { width: 1080, height: 1350 } } });
    expect(decision.requests[0].draft.title).toContain('KAAE');
    expect(await tasksInChat(chat)).toHaveLength(0);
    expect(telegram.sent).toHaveLength(0);

    // Asked again (the worker lost the answer): the same decision, from its record, classified once.
    const calls = vi.mocked(classifyInboundTelegramMessage).mock.calls.length;
    const again = await intake(createApp({ db } as any), update, 'lifecycle', {});
    expect(again.body).toMatchObject({ kind: 'decision', replayed: true, decision: first.body.decision });
    expect(vi.mocked(classifyInboundTelegramMessage).mock.calls.length).toBe(calls);
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('English and Kurdish copy for one graphic each are two requests, indexed', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const bilingual = 'KAAE poster\nHere is the text to add on each of the Kurdish and English graphics:\nMembers evening\nDecember 4\n_____\nئێوارەی ئەندامان\n\n٤ی کانوونی یەکەم';
    const answer = await intake(createApp({ db } as any), text(updateId(), chat, bilingual), 'lifecycle', {});
    const decision = answer.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>;
    expect(decision.kind).toBe('new_request');
    expect(decision.requests.map((r) => r.index)).toEqual([0, 1]);
    expect(decision.requests[0].draft.rawText).toContain('English copy only');
    expect(decision.requests[1].draft.rawText).toContain('Kurdish copy only');
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('the "new or a change?" question is kept by ChatInbox: asked as a clarify decision, answered from the state it sends back', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    classifier.clarifyFor = 'make it gold please';
    const asked = await intake(app, text(updateId(), chat, 'make it gold please'), 'lifecycle', {});
    expect(asked.body).toMatchObject({ kind: 'decision', decision: { kind: 'clarify', remember: { rawText: 'make it gold please' } } });
    expect(asked.body.chat?.pendingClarification).toMatchObject({ rawText: 'make it gold please' });
    const clarify = asked.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'clarify' }>;
    expect(clarify.messages).toEqual([expect.objectContaining({ chatId: String(chat), class: 'courtesy', text: expect.stringContaining('Clarification needed') })]);
    expect(telegram.sent).toHaveLength(0);

    // A fresh Core (restarted) reads the question from the state ChatInbox hands back: "new" makes the
    // kept words a new request, and the question is cleared.
    const answered = await intake(createApp({ db } as any), text(updateId(), chat, 'new'), 'lifecycle', asked.body.chat);
    expect(answered.body).toMatchObject({ kind: 'decision', decision: { kind: 'new_request' } });
    const opened = answered.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>;
    expect(opened.requests[0].draft.rawText).toBe('make it gold please');
    expect(answered.body.chat?.pendingClarification).toBeUndefined();
  });
});

describe('instructions without copy in a flagged chat (review of 2.3C)', () => {
  it('are opened by the lifecycle as a request for the art director, with the notice routed, not saved or sent by Core', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const words = 'use a darker blue and more space around the logo';
    classifier.instructionOnlyFor = words;
    const id = updateId();
    const answer = await intake(createApp({ db } as any), text(id, chat, words), 'lifecycle', {});
    expect(answer.body).toMatchObject({ kind: 'decision', decision: { kind: 'new_request' } });
    const decision = answer.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>;
    expect(decision.requests).toHaveLength(1);
    expect(decision.requests[0].draft).toMatchObject({ isInstructionOnly: true, autoGenerate: false, exactCopy: [] });
    expect(decision.messages).toEqual([expect.objectContaining({ key: `instruction:${chat}:${id}`, chatId: String(chat), class: 'courtesy', text: expect.stringContaining('Design instruction received') })]);
    expect(telegram.sent).toHaveLength(0);
    expect(await tasksInChat(chat)).toHaveLength(0);

    // Opened, it is saved as the legacy path saves it: marked instruction-only, not designed.
    const opened = await openDecided(createApp({ db } as any), chat, id, decision.requests[0].draft);
    expect(opened).toMatchObject({ autoGenerate: false, stage: 'manual' });
    const rows = await tasksInChat(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ isInstructionOnly: true });
    expect(rows[0].payload.autoGenerate).toBeUndefined();
  });
});

describe('a database error while reading who owns a button\'s task (review of 2.3C)', () => {
  it('is a 503 the poller retries, with the button answered, not a thrown 500', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const saved = await intake(app, text(updateId(), chat, BRIEF), 'legacy');
    const taskId = saved.body.taskIds![0];
    ownerLookup.fail = true;
    const answer = await intake(app, button(updateId(), chat, `rq:ok:${taskId}`), 'legacy');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ kind: 'handled', intakeStatus: 503 });
    expect(telegram.sent.filter((m) => String(m.url).endsWith('/answerCallbackQuery'))).toEqual([
      expect.objectContaining({ text: expect.stringContaining('not available right now') }),
    ]);
  });
});

describe('the daily cap of automatic drafts in a flagged chat (review of 2.3C)', () => {
  const UNSCOPED = 'Members evening poster\n---\nDecember 4, 2026\nErbil';

  it('a brief that names no client is not an automatic draft, so it does not use the sender\'s allowance', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '1');
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const u1 = updateId();
    const unscoped = await intake(app, text(u1, chat, UNSCOPED), 'lifecycle', {});
    const draft1 = (unscoped.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>).requests[0].draft;
    // Read as the legacy path saves it: without a client nothing is designed automatically.
    expect(draft1).toMatchObject({ clientId: null, autoGenerate: false });
    const opened1 = await openDecided(app, chat, u1, draft1);
    expect(opened1).toMatchObject({ autoGenerate: false, stage: 'manual' });

    // The brief that names KAAE still has the sender's one automatic draft of the day.
    const u2 = updateId();
    const scoped = await intake(app, text(u2, chat, BRIEF), 'lifecycle', {});
    const draft2 = (scoped.body.decision as Extract<IntakeAnswerBody['decision'], { kind: 'new_request' }>).requests[0].draft;
    const opened2 = await openDecided(app, chat, u2, draft2);
    expect(opened2.autoGenerateDeclined).toBeUndefined();
    expect(opened2).toMatchObject({ autoGenerate: true, stage: 'designing' });
    const payloads = (await tasksInChat(chat)).map((r: any) => ({ client: r.payload.clientId ?? null, auto: r.payload.autoGenerate === true }));
    expect(payloads).toEqual(expect.arrayContaining([{ client: null, auto: false }, { client: KAAE, auto: true }]));
  });

  it('createRequest saves an unscoped draft that asks for automatic drafting as a manual request (a draft from an older intake)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '1');
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const u1 = updateId();
    const opened1 = await openDecided(app, chat, u1, { title: 'Owner: Members evening…', rawText: UNSCOPED, clientId: null, designInstructions: '', exactCopy: [], autoGenerate: true });
    expect(opened1).toMatchObject({ autoGenerate: false, stage: 'manual' });
    const opened2 = await openDecided(app, chat, updateId(), { title: 'KAAE: members evening…', rawText: BRIEF, clientId: KAAE, designInstructions: '', exactCopy: [], autoGenerate: true });
    expect(opened2.autoGenerateDeclined).toBeUndefined();
    expect(opened2.stage).toBe('designing');
  });
});

describe('the waiting "new or a change?" question of a flagged chat (review of 2.3C)', () => {
  it('is cleared by a button or a command, not only by a typed answer', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { taskId } = await lifecycleRequest(app, chat);
    const waiting = { pendingClarification: { rawText: 'make it gold please', askedAt: Date.now() - 1000, updateId: 1 } };
    const tapped = await intake(app, button(updateId(), chat, `rq:ok:${taskId}`), 'lifecycle', waiting);
    expect(tapped.body).toMatchObject({ kind: 'decision', decision: { kind: 'requester', action: 'ok' } });
    expect(tapped.body.chat).toEqual({});
    const status = await intake(app, text(updateId(), chat, '/status'), 'lifecycle', waiting);
    expect(status.body.kind).toBe('handled');
    expect(status.body.chat).toEqual({});
  });
});

describe('updates aimed at a request the lifecycle owns are routed, whatever the chat\'s mode', () => {
  it('the requester\'s buttons: approve, change, a designer, a size, an answer', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await lifecycleRequest(app, chat);

    for (const [action, expected] of [
      ['ok', { kind: 'requester', action: 'ok' }], ['chg', { kind: 'requester', action: 'chg' }], ['dsg', { kind: 'requester', action: 'dsg' }], ['sst', { kind: 'requester', action: 'sst' }],
      ['a2', { kind: 'answer', questionId: questionIdOf(taskId), answer: { option: 2 } }],
    ] as const) {
      const id = updateId();
      const answer = await intake(app, button(id, chat, `rq:${action}:${taskId}`), 'legacy');
      expect(answer.body, action).toMatchObject({ kind: 'decision', decision: { ...expected, requestId, callbackQueryId: `cb-${id}` } });
    }
    // Core acted on none of them: no message, no size task, no requester mark of its own.
    expect(telegram.sent).toHaveLength(0);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a reply to a draft is routed as a change; a reply to a task waiting on a question is its answer', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await lifecycleRequest(app, chat);
    await setState(taskId, 'human_review');
    const draftMessage = { message_id: 44, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, date: 1790000000, caption: `🎨 Canva draft · Task ID: ${taskId}` };

    const change = await intake(app, text(updateId(), chat, 'make the logo bigger', { reply_to_message: draftMessage }), 'legacy');
    expect(change.body).toMatchObject({ kind: 'decision', decision: { kind: 'change', requestId, replyToTaskId: taskId, directive: expect.stringMatching(/logo bigger/i) } });

    await setState(taskId, 'paused');
    const answer = await intake(app, text(updateId(), chat, 'The KAAE seal', { reply_to_message: draftMessage }), 'lifecycle', {});
    expect(answer.body).toMatchObject({ kind: 'decision', decision: { kind: 'answer', requestId, questionId: questionIdOf(taskId), answer: { text: 'The KAAE seal' } } });
    expect(telegram.sent).toHaveLength(0);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  const webhook = (app: any, update: unknown) => app.request('/api/webhooks/telegram?generate=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': String(process.env.TELEGRAM_WEBHOOK_SECRET) },
    body: JSON.stringify(update),
  });

  it('through Core\'s own poller or a webhook (no ChatInbox), Core routes it itself through Restate\'s ingress, with the keys ChatInbox uses (review of 2.3C)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('RESTATE_INGRESS_URL', INGRESS);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await lifecycleRequest(app, chat);
    const id = updateId();
    const res = await webhook(app, button(id, chat, `rq:ok:${taskId}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, routed: 'requester' });
    expect(telegram.restate).toEqual([{
      path: `/RequestLifecycle/${requestId}/requesterDecision/send`, key: `tg:${chat}:${id}`,
      body: { v: 1, eventId: `tg:${chat}:${id}`, taskId, kind: 'ok', actorId: String(OFFICE), callbackQueryId: `cb-${id}` },
    }]);
    // A typed change to its draft goes the same way.
    await setState(taskId, 'human_review');
    const draftMessage = { message_id: 44, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, date: 1790000000, caption: `🎨 Canva draft · Task ID: ${taskId}` };
    const change = updateId();
    expect((await webhook(app, text(change, chat, 'make the logo bigger', { reply_to_message: draftMessage }))).status).toBe(200);
    expect(telegram.restate[1]).toMatchObject({ path: `/RequestLifecycle/${requestId}/requesterDecision/send`, key: `tg:${chat}:${change}`, body: { kind: 'change', taskId } });
    expect(telegram.sent).toHaveLength(0);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('with Restate\'s ingress down it is a 503 the poller retries; with none configured it is refused and the requester told', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('RESTATE_INGRESS_URL', INGRESS);
    const down = fakeTelegram({ status: 500 });
    const chat = chatId();
    const app = createApp({ db } as any);
    const { taskId } = await lifecycleRequest(app, chat);
    const retried = await webhook(app, button(updateId(), chat, `rq:ok:${taskId}`));
    expect(retried.status).toBe(503);
    expect(down.sent).toHaveLength(0);

    vi.stubEnv('RESTATE_INGRESS_URL', '');
    const refused = await webhook(app, button(updateId(), chat, `rq:ok:${taskId}`));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'LIFECYCLE_OWNED' });
    // Acted on by nobody, so the requester hears it: the button is answered.
    expect(down.sent).toEqual([expect.objectContaining({ url: expect.stringMatching(/answerCallbackQuery$/), text: expect.stringMatching(/could not be passed on/i) })]);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a ChatInbox built before 2.3C (it does not route) gets it routed by Core and answered handled, and again with the same keys when it asks again', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('RESTATE_INGRESS_URL', INGRESS);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await lifecycleRequest(app, chat);
    const id = updateId();
    const first = await intake(app, button(id, chat, `rq:dsg:${taskId}`), 'legacy', undefined, { routes: false });
    expect(first.body).toMatchObject({ v: 1, kind: 'handled', intakeStatus: 200, routedByCore: 'requester' });
    expect(first.body.decision).toBeUndefined();
    const again = await intake(app, button(id, chat, `rq:dsg:${taskId}`), 'legacy', undefined, { routes: false });
    expect(again.body).toMatchObject({ kind: 'handled', intakeStatus: 200, routedByCore: 'requester' });
    expect(telegram.restate.map((r) => [r.path, r.key])).toEqual([
      [`/RequestLifecycle/${requestId}/requesterDecision/send`, `tg:${chat}:${id}`],
      [`/RequestLifecycle/${requestId}/requesterDecision/send`, `tg:${chat}:${id}`],
    ]);
    expect(telegram.sent).toHaveLength(0);
    // A ChatInbox that routes gets the decision itself, and Core sends nothing to Restate.
    const routed = await intake(app, button(updateId(), chat, `rq:chg:${taskId}`), 'legacy');
    expect(routed.body).toMatchObject({ kind: 'decision', decision: { kind: 'requester', action: 'chg' } });
    expect(telegram.restate).toHaveLength(2);
  });

  it('a legacy chat\'s own request is untouched: a brief in mode legacy is saved and acknowledged as before', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const answer = await intake(createApp({ db } as any), text(updateId(), chat, BRIEF), 'legacy');
    expect(answer.body).toMatchObject({ kind: 'handled', intakeStatus: 201 });
    expect(answer.body.decision).toBeUndefined();
    expect(await tasksInChat(chat)).toHaveLength(1);
    const owner = await asOwner(async (trx) => (await sql<{ request_id: string | null }>`SELECT request_id::text FROM hawa.tasks WHERE id = ${answer.body.taskIds![0]}::uuid`.execute(trx)).rows[0]);
    expect(owner.request_id).toBeNull();
    expect(telegram.sent.filter((m) => String(m.chat_id) === String(chat))).toHaveLength(1);
  });
});
