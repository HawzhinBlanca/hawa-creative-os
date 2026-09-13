import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') throw new Error('Only disposable hawa_repair database admitted');
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
  it('denies unbound chat approval before fabricating a task or sending any acknowledgment', async () => {
    const dispatch = vi.fn(); const app = createApp({ db, telegramBridge: { answerCallbackQuery: dispatch } as any });
    const res = await app.request('/api/webhooks/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! }, body: JSON.stringify({ update_id: randomUUID(), callback_query: { from: { id: 123 }, data: 'approve:unknown' } }) });
    expect(res.status).toBe(422); expect(dispatch).not.toHaveBeenCalled();
  });
});
