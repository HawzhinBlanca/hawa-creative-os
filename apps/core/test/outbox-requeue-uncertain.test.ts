import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, OutboxRepository, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Bug hunt 2026-09-24. A Telegram send that may have arrived (TELEGRAM_DELIVERY_UNCERTAIN,
 * TELEGRAM_RECEIPT_INVALID) is dead-lettered on purpose so it is never sent twice (canvaStatusHandler,
 * outbox-consumer.ts: "A lost response can follow a successful send. Never automatically resend it.").
 * POST /v1/system/outbox/requeue puts every `failed` row back to `pending` with attempts 0, uncertain
 * ones included, and deploy.sh ends every deploy with "Next: requeue dead-lettered commands if any".
 * The worker's notify.telegram handler has no guard, so the requester gets the message again.
 * (`ids` is used here so the test touches only its own row; `{"all":true}` runs the same UPDATE.)
 */
describe('HUNT: requeue resends messages that may already have arrived', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000002', role: 'administrator' };
  afterAll(async () => {
    // Only this suite's own rows (earlier runs included) are retired; nothing tenant-wide.
    await withRlsContext(db, scope, (trx) =>
      trx.updateTable('outbox_commands').set({ state: 'dead' } as any)
        .where('tenant_id', '=', tenantId).where('idempotency_key', 'like', 'hunt-uncertain-%').where('state', '!=', 'dead').execute()
    );
    await db.destroy();
  });

  it('a DELIVERY_UNCERTAIN dead letter stays dead after a requeue', async () => {
    const outbox = new OutboxRepository(db);
    const cmd = await withRlsContext(db, scope, (trx) =>
      outbox.enqueue({
        tenantId,
        aggregateType: 'task',
        aggregateId: randomUUID(),
        commandType: 'notify.telegram',
        idempotencyKey: `hunt-uncertain-${randomUUID()}`,
        payload: { chatId: '4242', message: { text: 'Your Canva draft is ready' } },
      }, trx)
    );
    // What canvaStatusHandler does when the inline send's answer was lost.
    await withRlsContext(db, scope, (trx) => outbox.markUncertain(cmd.id, 'TELEGRAM_DELIVERY_UNCERTAIN', trx));

    const res = await createApp({ db } as any).request('/v1/system/outbox/requeue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY}` },
      body: JSON.stringify({ ids: [cmd.id] }),
    });
    const after = await withRlsContext(db, scope, (trx) => outbox.findById(tenantId, cmd.id, trx));
    // Clean up our own row whatever happened, so the worker of another suite never sends it.
    await withRlsContext(db, scope, async (trx) => {
      await outbox.markPermanentFailure(cmd.id, 'hunt test cleanup', trx);
      await outbox.retire(tenantId, cmd.id, 'hunt test cleanup', 'hunt', trx);
    });

    expect({ http: res.status, stateAfterRequeue: after?.state }).toEqual({ http: 200, stateAfterRequeue: 'failed' });
  });

  // 2026-09-24 fix: the others are requeued as before, the uncertain one is listed as kept, and it is
  // sent again only when an administrator names it and confirms.
  it('requeues the rest, lists what it kept, and replays an uncertain one only when named and confirmed', async () => {
    const outbox = new OutboxRepository(db);
    // These rows are pending for a moment in a tenant another suite drains: notify.whatsapp has no
    // transport, so whoever leases one sends nothing.
    const enqueue = (text: string) => withRlsContext(db, scope, (trx) =>
      outbox.enqueue({
        tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType: 'notify.whatsapp',
        idempotencyKey: `hunt-uncertain-${randomUUID()}`, payload: { chatId: '4242', message: { text } },
      }, trx));
    const uncertain = await enqueue('may have arrived');
    const plain = await enqueue('never sent');
    // Each has a send the worker began and never heard back about (apps/worker delivery-notification.ts).
    const markAttempted = (id: string) => withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
      (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
      VALUES (${tenantId}::uuid, 'telegram_delivery', ${`${id}:message`}, 'telegram_message_attempted', '{}'::jsonb, ${`${id}:message:attempted`}, true, clock_timestamp())`.execute(trx));
    const released = async (id: string) => (await withRlsContext(db, scope, (trx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_event_id = ${`${id}:message`} AND event_kind = 'telegram_message_released'`.execute(trx))).rows[0].n;
    await withRlsContext(db, scope, async (trx) => {
      await outbox.markUncertain(uncertain.id, 'TELEGRAM_RECEIPT_INVALID', trx);
      await outbox.markPermanentFailure(plain.id, 'TELEGRAM_SEND_FAILED: HTTP 502', trx);
    });
    await markAttempted(uncertain.id);
    await markAttempted(plain.id);
    const requeue = (body: Record<string, unknown>) => createApp({ db } as any).request('/v1/system/outbox/requeue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY}` },
      body: JSON.stringify(body),
    });
    const stateOf = async (id: string) => (await withRlsContext(db, scope, (trx) => outbox.findById(tenantId, id, trx)))?.state;
    try {
      const first = await (await requeue({ ids: [uncertain.id, plain.id] })).json();
      expect(first.commands.map((c: any) => c.id)).toEqual([plain.id]);
      expect(first.keptUncertain.map((c: any) => c.id)).toEqual([uncertain.id]);
      expect([await stateOf(plain.id), await stateOf(uncertain.id)]).toEqual(['pending', 'failed']);
      // A requeue alone restarts the command, not the send that may have arrived.
      expect(await released(plain.id)).toBe(0);

      const confirmed = await (await requeue({ ids: [uncertain.id], confirmUncertainReplay: true })).json();
      expect(confirmed.commands.map((c: any) => c.id)).toEqual([uncertain.id]);
      expect(await stateOf(uncertain.id)).toBe('pending');
      // The administrator confirmed: the worker may make that send once more.
      expect([await released(uncertain.id), await released(plain.id)]).toEqual([1, 0]);
    } finally {
      await withRlsContext(db, scope, async (trx) => {
        for (const id of [uncertain.id, plain.id]) {
          await outbox.markPermanentFailure(id, 'hunt test cleanup', trx);
          await outbox.retire(tenantId, id, 'hunt test cleanup', 'hunt', trx);
        }
      });
    }
  });
  it('the per-task redrive releases a send that may have arrived only when the replay is confirmed', async () => {
    const outbox = new OutboxRepository(db);
    const taskId = randomUUID();
    const cmd = await withRlsContext(db, scope, (trx) => outbox.enqueue({
      tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'notify.whatsapp',
      idempotencyKey: `hunt-uncertain-${randomUUID()}`, payload: { chatId: '4242', message: { text: 'may have arrived' } },
    }, trx));
    await withRlsContext(db, scope, async (trx) => {
      await outbox.markPermanentFailure(cmd.id, 'TELEGRAM_SEND_FAILED: HTTP 502', trx);
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`${cmd.id}:message`}, 'telegram_message_uncertain', '{}'::jsonb, 'x', true, clock_timestamp())`.execute(trx);
    });
    const redrive = (body: Record<string, unknown>) => createApp({ db } as any).request(`/v1/tasks/${taskId}/outbox/${cmd.id}/redrive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ADMIN_KEY}` },
      body: JSON.stringify(body),
    });
    const released = async () => (await withRlsContext(db, scope, (trx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_event_id = ${`${cmd.id}:message`} AND event_kind = 'telegram_message_released'`.execute(trx))).rows[0].n;
    try {
      expect((await redrive({})).status).toBe(200);
      expect(await released()).toBe(0);
      await withRlsContext(db, scope, (trx) => outbox.markPermanentFailure(cmd.id, 'TELEGRAM_SEND_FAILED: HTTP 502', trx));
      expect((await redrive({ confirmUncertainReplay: true })).status).toBe(200);
      expect(await released()).toBe(1);
    } finally {
      await withRlsContext(db, scope, async (trx) => {
        await outbox.markPermanentFailure(cmd.id, 'hunt test cleanup', trx);
        await outbox.retire(tenantId, cmd.id, 'hunt test cleanup', 'hunt', trx);
      });
    }
  });
});
