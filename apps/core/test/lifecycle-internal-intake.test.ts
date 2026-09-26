import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, readTelegramKillSwitch, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { PARKED_UPDATE_NOTICE } from '../src/services/polled-update-dispatch.js';
import { productionAppOptions } from '../src/entrypoint-options.js';
import { telegramPollerOf } from '../src/services/telegram-poller-owner.js';

/**
 * Core's side of Phase 2.1 (PHASE2_DESIGN.md slice 2.1), against the per-file test database as
 * hawa_app (row-level security as in production): the worker's ChatInbox hands each update to
 * POST /v1/internal/telegram/intake, which runs today's intake unchanged, and dead-letters one intake
 * keeps failing through POST /v1/internal/telegram/park. HAWA_TELEGRAM_POLLER decides which process
 * polls; unset, Core does, exactly as before.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000007;
const WORKER = ['worker', 'intake', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await createApp({ db } as any).request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active: false }) });
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 62_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const brief = (id: number, chat: number) => ({
  update_id: id,
  message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' },
});

/** Telegram's sendMessage, recorded; anything else goes to the real fetch. */
function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { sent };
}

const tasksInChat = async (chat: number) =>
  (await withRlsContext(db, scope, (trx) =>
    trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
  )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

const intake = async (app: any, update: unknown, mode?: string, requestId?: string) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, ...(mode ? { mode } : { mode: 'legacy' }), ...(requestId ? { requestId } : {}) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function seedWaitingRequest(app: any, chat: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
      parent_request_id, owner, stage, rev, chat_id)
    VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid,
      null, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

describe('POST /v1/internal/telegram/intake', () => {
  it('runs today\'s intake: a brief becomes one task, and the same update again is a duplicate, not a second task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);

    const first = await intake(app, update);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ v: 1, kind: 'handled', intakeStatus: 201, duplicate: false });
    expect(first.body.taskIds).toHaveLength(1);

    // Delivered again: by Restate after a worker restart, or by the other poller after a rollback.
    const again = await intake(createApp({ db } as any), update);
    expect(again.body).toMatchObject({ kind: 'handled', intakeStatus: 200, duplicate: true, taskIds: first.body.taskIds });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('answers INTAKE_PAUSED while the office has switched Telegram off, and starts nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    expect((await app.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active: true }) })).status).toBe(200);
    const paused = await intake(app, brief(updateId(), chat));
    expect(paused.body).toMatchObject({ kind: 'handled', intakeStatus: 503, code: 'INTAKE_PAUSED' });
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('accepts lifecycle mode and falls through to legacy intake when no manual request matches', async () => {
    // lifecycle is now a supported mode (Phase 2.3 Q/A loop).
    // When no lifecycle request is in manual stage for the chat, it falls through to legacy intake.
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);
    const result = await intake(app, update, 'lifecycle');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: 'handled', intakeStatus: 201 });
    // A mode we have never heard of is still refused.
    expect((await intake(app, { message: {} })).status).toBe(400);
  });

  it('routes a requester revision directive to the open lifecycle request (Q/A loop)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId: priorTaskId } = await seedWaitingRequest(app, chat);

    // 2) Send the requester's directive update in lifecycle mode.
    const directiveUpdate = {
      update_id: updateId(),
      message: { message_id: 9999, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
        chat: { id: chat, type: 'private' }, date: 1790000001, text: 'Please make the background blue' },
    };
    const result = await intake(app, directiveUpdate, 'lifecycle', requestId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'requester-revision',
      requestId, round: 1, priorTaskId,
    });
    expect(result.body.newTaskId).toBeDefined();
    expect(result.body.directive).toBe('Please make the background blue');
    const child = (await tasksInChat(chat)).find((task: any) =>
      task.aggregate_id === result.body.newTaskId);
    expect(child?.payload).toMatchObject({
      autoGenerate: true, designStudio: true, exactCopy: [{ text: 'December 4, 2026' }],
      variant: { width: 1200, height: 1697 },
      studioOptions: { tier: 'quality', parentTaskId: priorTaskId, revisionRound: 1,
        revisionDirective: 'Please make the background blue' },
    });
    expect((child?.payload as any).designInstructions).toContain('Make the approved event design');
  });

  it('refuses a capped revision durably and leaves the request waiting', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedWaitingRequest(app, chat);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '0');
    const update = brief(updateId(), chat);
    update.message.text = 'Make the background blue';
    const first = await intake(app, update, 'lifecycle', requestId);
    expect(first.body).toMatchObject({ intakeStatus: 409, code: 'DAILY_CAP_REACHED',
      lifecycleAction: 'revision-blocked', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
    const replay = await intake(createApp({ db } as any), update, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 409, code: 'DAILY_CAP_REACHED',
      lifecycleAction: 'revision-blocked' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('refuses a revision when the prior source brief is missing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedWaitingRequest(app, chat);
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.outbox_commands
      SET payload = payload - 'exactCopy'
      WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid
        AND command_type = 'task.created'`.execute(trx));
    const update = brief(updateId(), chat);
    update.message.text = 'Change the background';
    const result = await intake(app, update, 'lifecycle', requestId);
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'PARENT_BRIEF_MISSING',
      lifecycleAction: 'revision-blocked', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('replays the same Telegram revision update after Core advanced the request, without a legacy task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    update.message.text = 'Move the venue to Erbil';
    const first = await intake(app, update, 'lifecycle', requestId);
    expect(first.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId, priorTaskId: taskId, duplicate: false });
    const adopted = await app.request(`/v1/internal/lifecycle/${requestId}/requester-revision-intake`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, updateId: update.update_id,
        expectedRev: 3, priorTaskId: taskId, newTaskId: first.body.newTaskId,
        round: 1, directive: update.message.text }),
    });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({ requestId, newTaskId: first.body.newTaskId,
      stage: 'designing', rev: 4, directive: update.message.text });
    const forgedAdoption = await app.request(`/v1/internal/lifecycle/${requestId}/requester-revision-intake`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, updateId: update.update_id,
        expectedRev: 3, priorTaskId: taskId, newTaskId: randomUUID(),
        round: 1, directive: update.message.text }),
    });
    expect(forgedAdoption.status).toBe(409);
    const replay = await intake(createApp({ db } as any), update, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId, newTaskId: first.body.newTaskId, duplicate: true });
    const changed = await intake(app, { ...update, message: { ...update.message, text: 'Different direction' } },
      'lifecycle', requestId);
    expect(changed.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const changedReply = await intake(app, { ...update,
      message: { ...update.message, reply_to_message: { message_id: 734 } } },
    'lifecycle', requestId);
    expect(changedReply.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await tasksInChat(chat)).toHaveLength(2);
  });

  it('requires a linked reply for two waiting requests and refuses a stale linked reply', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const first = await seedWaitingRequest(app, chat);
    const second = await seedWaitingRequest(app, chat);
    const unlinkedUpdate = brief(updateId(), chat);
    unlinkedUpdate.message.text = 'Use the blue background';
    const ambiguous = await intake(app, unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguous.body).toMatchObject({ intakeStatus: 409, code: 'AMBIGUOUS_REQUEST',
      lifecycleAction: 'request-choice-required', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(2);

    await withRlsContext(db, scope, (trx) => sql`
      INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
        event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery',
        ${`lc:${second.requestId}:3:office-revision-notify:send`},
        'telegram_message_sent', ${JSON.stringify({ messageId: '734' })}::jsonb,
        'test-sent-mark', true)`.execute(trx));
    const linkedUpdate = brief(updateId(), chat);
    linkedUpdate.message.text = 'Make this one blue';
    (linkedUpdate.message as Record<string, unknown>).reply_to_message = { message_id: 734 };
    const linked = await intake(app, linkedUpdate, 'lifecycle', first.requestId);
    expect(linked.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId: second.requestId, priorTaskId: second.taskId });
    // The first answer was lost; even after one request advanced, the same update cannot be
    // reinterpreted as a directive for the other waiting request.
    const ambiguousReplay = await intake(createApp({ db } as any), unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguousReplay.body).toMatchObject({ intakeStatus: 409, code: 'AMBIGUOUS_REQUEST',
      lifecycleAction: 'request-choice-required' });
    const changedAmbiguity = await intake(app,
      { ...unlinkedUpdate, message: { ...unlinkedUpdate.message, text: 'Changed under the same ID' } },
      'lifecycle', first.requestId);
    expect(changedAmbiguity.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const staleUpdate = brief(updateId(), chat);
    staleUpdate.message.text = 'Another change';
    (staleUpdate.message as Record<string, unknown>).reply_to_message = { message_id: 734 };
    const stale = await intake(app, staleUpdate, 'lifecycle', first.requestId);
    expect(stale.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY',
      lifecycleAction: 'request-choice-required' });
    expect(await tasksInChat(chat)).toHaveLength(3);
  });

  it('answers NOT_CONFIGURED without the webhook secret', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db } as any);
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    expect((await intake(app, brief(updateId(), chatId()))).body).toMatchObject({ intakeStatus: 503, code: 'NOT_CONFIGURED' });
    // lifecycle mode also gets NOT_CONFIGURED when webhook secret is absent.
    expect((await intake(app, brief(updateId(), chatId()), 'lifecycle')).body).toMatchObject({ intakeStatus: 503, code: 'NOT_CONFIGURED' });
  });

  it('passes intake\'s deliberate refusal on as final (a sender outside the allowlist in production)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', String(OFFICE));
    const app = createApp({ db } as any);
    const stranger = brief(updateId(), chatId());
    stranger.message.from.id = 12345;
    expect((await intake(app, stranger)).body).toMatchObject({ kind: 'handled', intakeStatus: 403 });
  });
});

describe('POST /v1/internal/telegram/park', () => {
  it('dead-letters the update by id, alerts the office and tells the sender, once however often it is asked', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['700000123', ['fixture', 'bot', 'secret'].join('_')].join(':'));
    const telegram = fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const park = (app: any) => app.request('/v1/internal/telegram/park', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, reason: 'intake answered HTTP 500 after 5 attempts', notifySender: true }) });

    const first = await park(createApp({ db } as any));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ parked: true, alreadyParked: false });
    const second = await park(createApp({ db } as any));
    expect(await second.json()).toMatchObject({ parked: true, alreadyParked: true });

    const rows = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload, processing_error FROM hawa.inbox_events WHERE source_account_id = 'telegram' AND source_event_id = ${`parked-update-${update.update_id}`}`.execute(trx)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ update_id: update.update_id, kind: 'message' });
    expect(rows[0].processing_error).toMatch(/HTTP 500 after 5 attempts/);
    const alerts = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload FROM hawa.outbox_commands WHERE idempotency_key = ${`notify.office:telegram-update-parked:${update.update_id}`}`.execute(trx)).rows);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0].payload)).not.toContain('KAAE members evening');
    expect(telegram.sent.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text)).toEqual([PARKED_UPDATE_NOTICE]);
  });

  it('refuses every credential but the worker\'s', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const res = await createApp({ db } as any).request('/v1/internal/telegram/park', { method: 'POST', headers: admin, body: JSON.stringify({ v: 1, update: brief(updateId(), chatId()), reason: 'x' }) });
    expect(res.status).toBe(401);
  });
});

describe('the kill switch the worker\'s poller reads', () => {
  it('is the switch the office throws in Core (its own row in Postgres, not the bot\'s)', async () => {
    const app = createApp({ db } as any);
    // The worker reads it as System Automation, its own database identity.
    const automation = { tenantId, userId: SYSTEM_AUTOMATION_USER_ID };
    const set = (active: boolean) => app.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active }) });
    // The route answers at once and saves the switch in the background (channel-kill-switches.ts).
    expect((await set(true)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(true), { timeout: 5000, interval: 50 });
    expect((await set(false)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(false), { timeout: 5000, interval: 50 });
  });
});

describe('HAWA_TELEGRAM_POLLER', () => {
  it('leaves polling in Core unless it says worker', () => {
    expect(telegramPollerOf({})).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: 'core' })).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: 'nonsense' })).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: ' Worker ' })).toBe('worker');
    expect(productionAppOptions({}).enableTelegramPolling).toBe(true);
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'worker' }).enableTelegramPolling).toBe(false);
  });

  it('"poll now" is refused with 409 while the worker polls, and works as before otherwise', async () => {
    fakeTelegram();
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'worker');
    const app = createApp({ db } as any);
    const refused = await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin });
    expect(refused.status).toBe(409);
    expect((await app.request('/v1/adapters/telegram/status')).status).toBe(200);
    expect(await (await app.request('/v1/adapters/telegram/status')).json()).toMatchObject({ poller: 'worker' });
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'core');
    expect(await (await app.request('/v1/adapters/telegram/status')).json()).toMatchObject({ poller: 'core' });
    expect((await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin })).status).not.toBe(409);
  });
});
