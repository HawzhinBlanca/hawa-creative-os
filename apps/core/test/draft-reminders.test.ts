import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, OutboxRepository } from '@hawa/db';
import { composeDraftReminder, inOfficeHours, remindUnansweredDrafts } from '../src/services/draft-reminders.js';

/** A draft nobody answered is asked about once a day later, once more at five days, and no more. */
describe('draft reminders', () => {
  it('ask in plain words, with the three buttons and the task, in office hours only', () => {
    const r = composeDraftReminder('00000000-0000-4000-c000-000000000001', 'KAAE <evening>', 1);
    expect(r.text).toContain('Is this design right for you?');
    expect(r.text).toContain('KAAE &lt;evening&gt;');
    expect(r.reply_markup.inline_keyboard.flat().length).toBe(3);
    expect(inOfficeHours(new Date('2026-09-24T07:00:00Z'))).toBe(true); // 10:00 in Erbil
    expect(inOfficeHours(new Date('2026-09-24T20:00:00Z'))).toBe(false); // 23:00
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('draft reminders (PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const userId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId, role: 'operator' } as const;
  const outbox = new OutboxRepository(db);
  const officeHours = new Date(new Date().toISOString().slice(0, 10) + 'T07:00:00Z');
  afterAll(() => db.destroy());

  /** A task in review whose draft was delivered `hoursAgo` hours ago to a new chat. */
  const draft = async (hoursAgo: number) => {
    const taskId = randomUUID();
    const chat = String(80000000 + Math.floor(Math.random() * 9000000));
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Reminder check', 'human_review')`.execute(trx);
      await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'task.created', idempotencyKey: `reminder-test:${taskId}`, payload: { sourcePlatform: 'telegram', sourceChannelId: chat } }, trx);
      await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'notify.telegram', idempotencyKey: `reminder-test-draft:${taskId}`, payload: { chatId: chat, status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } }, trx);
      await sql`UPDATE hawa.outbox_commands SET state = 'delivered', created_at = now() - make_interval(hours => ${hoursAgo}) WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.telegram'`.execute(trx);
    });
    return { taskId, chat };
  };
  const reminders = async (taskId: string) =>
    (await withRlsContext(db, operator, async (trx) => (await sql<{ key: string }>`SELECT idempotency_key AS key FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND idempotency_key LIKE 'notify.telegram:reminder%' ORDER BY idempotency_key`.execute(trx)).rows)).map((r) => r.key);
  const pass = () => remindUnansweredDrafts({ db, outbox, tenantId, userId, now: officeHours, from: '2026-01-01T00:00:00Z' });

  it('a day after an unanswered draft, one reminder; a second pass writes nothing more', async () => {
    const { taskId } = await draft(26);
    const fresh = await draft(3);
    await pass();
    await pass();
    expect(await reminders(taskId)).toEqual([`notify.telegram:reminder1:${taskId}`]);
    expect(await reminders(fresh.taskId)).toEqual([]);
  });

  it('five days on, the second reminder', async () => {
    const { taskId } = await draft(5 * 24 + 2);
    await pass();
    expect(await reminders(taskId)).toEqual([`notify.telegram:reminder5:${taskId}`]);
  });

  it('never for a draft the requester answered, by a button or any message after it', async () => {
    const pressed = await draft(30);
    const wrote = await draft(30);
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram', ${`${pressed.chat}:${randomUUID()}`}, 'telegram_requester_chg', ${JSON.stringify({ taskId: pressed.taskId })}::jsonb, 'x', true)`.execute(trx);
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram', ${`${wrote.chat}:${randomUUID()}`}, 'telegram_update', '{}'::jsonb, 'y', true)`.execute(trx);
    });
    await pass();
    expect(await reminders(pressed.taskId)).toEqual([]);
    expect(await reminders(wrote.taskId)).toEqual([]);
  });

  it('never at night, and never for drafts sent before reminders existed', async () => {
    const { taskId } = await draft(30);
    expect(await remindUnansweredDrafts({ db, outbox, tenantId, userId, now: new Date('2026-09-24T21:00:00Z'), from: '2026-01-01T00:00:00Z' })).toBe(0);
    await remindUnansweredDrafts({ db, outbox, tenantId, userId, now: officeHours });
    expect(await reminders(taskId)).toEqual([]);
  });
});
