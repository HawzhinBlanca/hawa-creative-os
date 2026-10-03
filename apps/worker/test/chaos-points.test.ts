import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { DurableStepJournal, withStepChaosPoints } from '../src/durable-context.js';
import type { TelegramSender } from '../src/delivery-notification.js';

/**
 * The chaos suite (packages/testkit/chaos) kills the worker at named points: after a side effect and
 * before its record. These tests pin where each point sits, by reading the database at the moment a
 * point is reached: a point one line too late would kill the worker after the record, and the suite
 * would prove nothing about the crash it names.
 */
const tenantId = '00000000-0000-4000-a000-000000000006';
const userId = '00000000-0000-4000-b000-000000000006';
const botToken = ['worker', 'chaos', 'bot', 'token'].join('_');
let db: Kysely<Database>;
let control: http.Server;
/** What the database said at each point, in the order the points were reached. */
let reached: Array<{ point: string; detail: any; at: any }> = [];
let observe: (point: string, detail: any) => Promise<any> = async () => null;

beforeAll(async () => {
  db = createDb(process.env.TEST_DATABASE_URL!);
  control = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const { point, detail } = JSON.parse(body || '{}');
      reached.push({ point, detail, at: await observe(point, detail).catch((e) => String(e)) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"held":false}');
    });
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
});
afterEach(() => {
  vi.unstubAllEnvs();
  reached = [];
  observe = async () => null;
});
afterAll(async () => {
  control?.close();
  await db?.destroy();
});
const armControl = () => vi.stubEnv('HAWA_CHAOS_CONTROL_URL', `http://127.0.0.1:${(control.address() as AddressInfo).port}/__chaos`);
const asAdmin = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, { tenantId, userId, role: 'administrator' }, fn);

describe('worker chaos points', () => {
  // The Telegram send point, pinned on a queued message (notify.telegram). It was pinned on Core's
  // requester delivery (notify.published), which ADR-135 stage 2d retired; the points are the same.
  it('message: it is sent before worker.sender.after-telegram and marked sent only after it; the command is recorded after worker.outbox.before-record', async () => {
    armControl();
    const chat = String(7000 + Math.floor(Math.random() * 1000));
    const idempotencyKey = `chaos-points-${randomUUID()}`;
    await asAdmin((trx) => new OutboxRepository(db).enqueue({
      tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType: 'notify.telegram', idempotencyKey,
      payload: { chatId: chat, message: 'Chaos message' },
    }, trx));
    const sends: string[] = [];
    observe = async () => asAdmin(async (trx) => {
      const cmd = (await sql<any>`SELECT id, state FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${idempotencyKey}`.execute(trx)).rows[0];
      const marks = (await sql<any>`SELECT event_kind FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_event_id LIKE ${cmd.id + ':%'} ORDER BY received_at`.execute(trx)).rows;
      return { state: cmd.state, sends: [...sends], marks: marks.map((m: any) => String(m.event_kind).replace(/^telegram_[a-z]+_/, '')) };
    });
    const sender: TelegramSender = {
      async dispatchOutboundDocument() { sends.push('document'); return { success: true, messageId: '11' }; },
      async dispatchOutboundMessage() { sends.push('message'); return { success: true, messageId: '12' }; },
    };
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, telegramBotToken: botToken, officeAlertChatId: '9999',
      telegramSender: () => sender,
    });
    await consumer.processBatch(100);

    const mine = reached.filter((r) => r.detail?.commandType === 'notify.telegram' || r.point === 'worker.sender.after-telegram');
    expect(mine.map((r) => [r.point, r.detail.kind ?? r.detail.commandType])).toEqual([
      ['worker.outbox.after-claim', 'notify.telegram'],
      ['worker.sender.after-telegram', 'message'],
      ['worker.outbox.before-record', 'notify.telegram'],
    ]);
    // At the send point the send has happened and its mark still says only "attempted".
    const afterSend = mine[1].at;
    expect(afterSend.sends).toEqual(['message']);
    expect(afterSend.marks).not.toContain('sent');
    // Before the record the command is still leased: killed here, it is claimed again.
    expect(mine[2].at.state).toBe('leased');
    const final = await asAdmin(async (trx) => (await sql<any>`SELECT state FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${idempotencyKey}`.execute(trx)).rows[0].state);
    expect(final).toBe('delivered');
  });

  it('workflow steps: worker.step.after-action is reached after the action and before the step is journalled, and not on replay', async () => {
    armControl();
    const journal = new DurableStepJournal('task-wf-chaos');
    const ctx = withStepChaosPoints(journal, 'task-chaos');
    let journalledAtPoint: boolean | null = null;
    observe = async (point, detail) => {
      if (point === 'worker.step.after-action') journalledAtPoint = (journal as any).journal.has(detail.step);
      return null;
    };
    const first = await ctx.run('canva-create-draft', async () => ({ planId: 'p1' }));
    expect(first).toEqual({ planId: 'p1' });
    expect(reached.map((r) => [r.point, r.detail])).toEqual([['worker.step.after-action', { step: 'canva-create-draft', taskId: 'task-chaos' }]]);
    expect(journalledAtPoint).toBe(false);
    // Replayed from the journal: the action does not run, so neither does its point.
    await ctx.run('canva-create-draft', async () => ({ planId: 'never' }));
    expect(reached).toHaveLength(1);
  });
});
