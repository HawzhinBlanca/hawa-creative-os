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
const classifier = vi.hoisted(() => ({ clarifyFor: null as string | null }));
vi.mock('../src/services/telegram-classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/telegram-classifier.js')>();
  return {
    ...actual,
    classifyInboundTelegramMessage: vi.fn(async (input: Parameters<typeof actual.classifyInboundTelegramMessage>[0], options?: Parameters<typeof actual.classifyInboundTelegramMessage>[1]) => {
      if (classifier.clarifyFor && input.messageText === classifier.clarifyFor) {
        return { kind: 'feedback', intent: 'revision_feedback', confidence: 0.5, isInstructionOnly: false, needsClarification: true, clarifyingQuestion: 'Is this a change to your last design, or a new one?', directive: input.messageText, reason: 'test' };
      }
      return actual.classifyInboundTelegramMessage(input, options);
    }),
  };
});
const { classifyInboundTelegramMessage } = await import('../src/services/telegram-classifier.js');

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

/** Telegram, recorded: nothing Core sends in decide mode may reach it. */
function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    sent.push({ url: url.replace(/bot[^/]+/, 'bot…'), ...body });
    return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
  });
  return { sent };
}

const intake = async (app: any, update: unknown, mode: 'legacy' | 'lifecycle', chat?: unknown) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, mode, ...(chat ? { chat } : {}) }) });
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

  it('without a ChatInbox to route to (Core\'s own poller, a webhook), such an update is refused, not acted on', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const telegram = fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { taskId } = await lifecycleRequest(app, chat);
    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': String(process.env.TELEGRAM_WEBHOOK_SECRET) },
      body: JSON.stringify(button(updateId(), chat, `rq:ok:${taskId}`)),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'LIFECYCLE_OWNED' });
    expect(telegram.sent).toHaveLength(0);
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
