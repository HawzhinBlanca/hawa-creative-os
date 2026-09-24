import { CHANNEL_INGRESS_USER_ID, PRIMARY_OPERATOR_USER_ID } from '@hawa/contracts';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) throw new Error('Only disposable hawa_repair database admitted');
describe.skipIf(!url)('chat intake with real isolated PostgreSQL', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenant = '00000000-0000-4000-a000-000000000001';
  const client = 'c1000000-0000-4000-8000-000000000002';
  const input = (): ChatIntake => ({ platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: 'test-channel',
    rawText: 'KAAE\n\nUse navy.\n---\nInvitation\nMr. / Ms. / Dr. [Full Name]', clientId: client,
    title: 'Invitation', headlineEn: 'Invitation', copyEn: 'Mr. / Ms. / Dr. [Full Name]',
    designInstructions: 'Use navy.', exactCopy: [{ text: 'Invitation\nMr. / Ms. / Dr. [Full Name]' }] });
  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES ('00000000-0000-4000-b000-000000000001','isolated-operator@example.test','Isolated operator') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${client}::uuid,${tenant}::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(async () => { await db.destroy(); vi.unstubAllEnvs(); });

  it('commits original event, task and outbox once under concurrent retries', async () => {
    const i = input(); const results = await Promise.all(Array.from({ length: 5 }, () => persistChatIntake(db, i)));
    expect(new Set(results.map(x => x.task.id)).size).toBe(1);
    expect(results.filter(x => x.created)).toHaveLength(1);
    const id = results[0].task.id;
    const events = await db.selectFrom('task_events').selectAll().where('task_id', '=', id).execute();
    expect(events).toHaveLength(1); expect((events[0].data as any).payload.rawRequestText).toBe(i.rawText);
    expect((events[0].data as any).payload.designInstructions).toBe(i.designInstructions);
    expect(await db.selectFrom('outbox_commands').selectAll().where('aggregate_id', '=', id).execute()).toHaveLength(1);
  });
  it('does not swallow a failed aggregate or poison a later retry', async () => {
    const i = input();
    await expect(persistChatIntake(db, { ...i, clientId: randomUUID() })).rejects.toThrow();
    expect(await db.selectFrom('inbox_events').selectAll().where('source_event_id', '=', `${i.sourceChannelId}:${i.sourceEventId}`).execute()).toHaveLength(0);
    expect((await persistChatIntake(db, i)).created).toBe(true);
  });
  it('rejects a changed source event without changing the original task', async () => {
    const i = input(); const first = await persistChatIntake(db, i);
    await expect(persistChatIntake(db, { ...i, rawText: 'changed' })).rejects.toThrow('different content');
    expect((await db.selectFrom('tasks').selectAll().where('id', '=', first.task.id).executeTakeFirst())?.description).toBe(i.rawText);
  });
  it('accepts idempotent replay when rawJson object keys are in different order', async () => {
    const eventId = randomUUID();
    const i1: ChatIntake = { ...input(), sourceEventId: eventId, rawJson: { alpha: 1, beta: 'two', gamma: [3, 4] } };
    const first = await persistChatIntake(db, i1);
    expect(first.created).toBe(true);

    const i2: ChatIntake = { ...input(), sourceEventId: eventId, rawJson: { gamma: [3, 4], alpha: 1, beta: 'two' } };
    const second = await persistChatIntake(db, i2);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });
  it('survives a new HTTP app instance and preserves the source/copy after refresh', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge: any = { dispatchOutboundMessage: dispatch };
    const payload = { update_id: `test-${randomUUID()}`, message: { message_id: 101, from: { id: 123, first_name: 'Test' },
      chat: { id: 'isolated-test' }, text: 'KAAE invitation\n---\nHAWA TEST\nExact test copy.' } };
    const send = (app: any) => app.request('/api/webhooks/telegram', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify(payload) });
    const first = await send(createApp({ db, telegramBridge: bridge })); expect(first.status).toBe(201);
    const firstBody = await first.json();
    const restarted = createApp({ db, telegramBridge: bridge });
    const replay = await send(restarted); expect(replay.status).toBe(200); expect((await replay.json()).task.id).toBe(firstBody.task.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const read = await restarted.request(`/v1/tasks/${firstBody.task.id}`, { headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` } });
    const task = await read.json(); expect(read.status).toBe(200); expect(task.sourcePlatform).toBe('telegram');
    expect(task.designInstructions).toBe('KAAE invitation'); expect(task.copyEn).toBe('Exact test copy.');
    const list = await restarted.request('/v1/tasks', { headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` } });
    expect((await list.json()).items.some((x: any) => x.id === firstBody.task.id)).toBe(true);
  });
  it('keeps an unrecognised client unscoped and never schedules automatic drafting for it', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const payload = { update_id: `test-${randomUUID()}`, message: { message_id: 102, from: { id: 555, first_name: 'Stranger <b>' },
      chat: { id: 'isolated-stranger' }, text: 'Hello, please make me a poster.\n---\nBIG SALE\nEverything half price.' } };
    const res = await app.request('/api/webhooks/telegram?generate=true', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify(payload) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.clientId).toBeNull();
    const row = await db.selectFrom('tasks').select(['client_id', 'requested_by']).where('id', '=', body.task.id).executeTakeFirst();
    expect(row?.client_id).toBeNull();
    // ADR-027: a channel message is attributed to the Channel Ingress identity, never to the Primary Operator.
    expect(row?.requested_by).toBe(CHANNEL_INGRESS_USER_ID);
    expect(row?.requested_by).not.toBe(PRIMARY_OPERATOR_USER_ID);
    const outbox = await db.selectFrom('outbox_commands').select(['payload']).where('aggregate_id', '=', body.task.id).execute();
    expect(outbox).toHaveLength(1);
    expect((outbox[0].payload as any).autoGenerate).toBeUndefined();
    expect((outbox[0].payload as any).variant).toEqual({ width: 1080, height: 1080 });
    // the requester is told the truth, in escaped HTML, and the message contains no Canva link
    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0][1];
    expect(sent.parse_mode).toBe('HTML');
    expect(sent.text).toContain('No client was named');
    expect(sent.text).not.toContain('canva.com/design');
    expect(sent.text).toContain('Stranger &lt;b&gt;');
  });
  it('records the request language from its script (Sorani for Arabic script, English otherwise)', async () => {
    const ku = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: 'lang-' + randomUUID().slice(0, 8), clientId: null, title: 'وۆرکشۆپ', rawText: 'وۆرکشۆپی دڵنیایی جۆری', designInstructions: '', exactCopy: [] });
    const en = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: 'lang-' + randomUUID().slice(0, 8), clientId: null, title: 'Workshop', rawText: 'Quality assurance workshop', designInstructions: '', exactCopy: [] });
    const rows = await db.selectFrom('tasks').select(['id', 'language']).where('id', 'in', [ku.task.id, en.task.id]).execute();
    expect(Object.fromEntries(rows.map((r) => [r.id, r.language]))).toEqual({ [ku.task.id]: 'ckb', [en.task.id]: 'en' });
  });

  it('schedules exactly one durable automatic draft for a scoped KAAE request', async () => {
    // The disposable database accumulates rows across runs; a fresh chat id keeps the daily cap out of this test.
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '100000');
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const payload = { update_id: `test-${randomUUID()}`, message: { message_id: 103, from: { id: 556, first_name: 'Office' },
      chat: { id: `isolated-office-${randomUUID()}` }, text: 'KAAE invitation\n---\nINVITATION\nYou are cordially invited.' } };
    const res = await app.request('/api/webhooks/telegram?generate=true', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify(payload) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.clientId).toBe(client);
    const outbox = await db.selectFrom('outbox_commands').select(['payload']).where('aggregate_id', '=', body.task.id).execute();
    expect(outbox).toHaveLength(1);
    expect((outbox[0].payload as any)).toMatchObject({ workflow: 'canva', autoGenerate: true, variant: { width: 1080, height: 1350 } });
    const sent = dispatch.mock.calls[0][1];
    expect(sent.text).toContain('Preparing your Canva draft');
    expect(sent.text).not.toContain('canva.com/design');
    vi.unstubAllEnvs();
  });
  it('caps automatic drafts per sender per day and tells the sender the request is saved for manual design', async () => {
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '1');
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const chat = `isolated-cap-${randomUUID()}`;
    const send = (n: number) => app.request('/api/webhooks/telegram?generate=true', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
      body: JSON.stringify({ update_id: `test-${randomUUID()}`, message: { message_id: n, from: { id: 777, first_name: 'Office' },
        chat: { id: chat }, text: `KAAE invitation ${n}\n---\nINVITATION ${n}\nYou are cordially invited.` } }) });
    const first = await (await send(1)).json();
    const second = await (await send(2)).json();
    const payloads = await Promise.all([first, second].map(async (b) =>
      (await db.selectFrom('outbox_commands').select(['payload']).where('aggregate_id', '=', b.task.id).executeTakeFirst())?.payload as any));
    expect(payloads[0].autoGenerate).toBe(true);
    expect(payloads[1].autoGenerate).toBeUndefined();
    expect(payloads[1].autoGenerateDeclined).toBe('SENDER_DAILY_CAP');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][1].text).toContain('Preparing your Canva draft');
    expect(dispatch.mock.calls[1][1].text).toContain('daily limit for automatic drafts');
    expect(dispatch.mock.calls[1][1].text).not.toContain('Preparing your Canva draft');
    vi.unstubAllEnvs();
  });
  it('keeps a Desk session across a Core restart and honours a revocation made on another instance', async () => {
    const first = createApp({ db });
    const login = await first.request('/v1/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: process.env.HAWA_ADMIN_KEY }) });
    expect(login.status).toBe(201);
    const { token, durable } = await login.json();
    expect(durable).toBe(true);
    const restarted = createApp({ db });
    const who = await restarted.request('/v1/auth/session', { headers: { Authorization: `Bearer ${token}` } });
    expect(who.status).toBe(200);
    expect((await who.json()).user.role).toBe('administrator');
    const list = await restarted.request('/v1/tasks', { headers: { Authorization: `Bearer ${token}` } });
    expect(list.status).toBe(200);
    // Revoke on the restarted instance; the first instance must stop accepting it once it re-checks.
    expect((await restarted.request('/v1/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await restarted.request('/v1/tasks', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    const stored = await sql<any>`SELECT revoked_at FROM hawa.desk_sessions WHERE token_hash=encode(digest(${token},'sha256'),'hex')`.execute(db);
    expect(stored.rows[0]?.revoked_at).toBeTruthy();
  });
  it('denies unbound chat approval before fabricating a task or sending any acknowledgment', async () => {
    const dispatch = vi.fn(); const app = createApp({ db, telegramBridge: { answerCallbackQuery: dispatch } as any });
    const res = await app.request('/api/webhooks/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify({ update_id: randomUUID(), callback_query: { from: { id: 123 }, data: 'approve:unknown' } }) });
    expect(res.status).toBe(422); expect(dispatch).not.toHaveBeenCalled();
  });
});
