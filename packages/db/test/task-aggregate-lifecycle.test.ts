import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { OutboxRepository, TaskRepository } from '../src/index.js';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';

/**
 * A task the RequestLifecycle object owns (PHASE2_DESIGN.md 2.8, ADR-034) is created with its
 * `task.created` outbox row already recorded: legacy queries (the daily cap, reply lookups, reminders)
 * read that row as the request's facts, and the outbox consumer must never dispatch it, because the
 * lifecycle starts the design run itself. The task names its request.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const SYSTEM = SYSTEM_AUTOMATION_USER_ID;
const scope = { tenantId: TENANT, userId: SYSTEM, role: 'operator' };

describe.skipIf(!appUrl)('createTaskAggregate for a lifecycle-owned request', () => {
  const db = createDb(appUrl!);
  afterAll(() => db.destroy());

  const create = (extra: Record<string, unknown>) => {
    const key = `test:lifecycle:${randomUUID()}`;
    return withRlsContext(db, scope, (trx) =>
      new TaskRepository(db).createTaskAggregate({
        tenantId: TENANT, userId: SYSTEM, idempotencyKey: key, title: 'Lifecycle task', clientId: null,
        actorType: 'workflow', payload: { autoGenerate: true, sourcePlatform: 'telegram', sourceChannelId: '9300101' }, ...extra,
      }, trx)).then((r) => ({ ...r, key }));
  };
  const outboxRow = (key: string) => withRlsContext(db, scope, async (trx) =>
    (await sql<{ state: string; delivered_at: Date | null; last_error: string | null; payload: Record<string, unknown> }>`
      SELECT state, delivered_at, last_error, payload FROM hawa.outbox_commands WHERE tenant_id = ${TENANT}::uuid AND idempotency_key = ${key}`.execute(trx)).rows[0]);

  it('records the task.created row as delivered, owned by the lifecycle, and names the request on the task', async () => {
    const requestId = randomUUID();
    const { task, key, created } = await create({ outboxState: 'recorded', requestId });
    expect(created).toBe(true);
    expect(task.request_id).toBe(requestId);
    const row = await outboxRow(key);
    expect(row).toMatchObject({ state: 'delivered', last_error: 'OWNED_BY_LIFECYCLE' });
    expect(row.delivered_at).toBeInstanceOf(Date);
    expect(row.payload).toMatchObject({ lifecycleOwner: 'restate', autoGenerate: true, taskId: task.id });
  });

  it('is never claimed by the outbox consumer', async () => {
    const { key } = await create({ outboxState: 'recorded', requestId: randomUUID() });
    const claimed = await withRlsContext(db, scope, (trx) => new OutboxRepository(db).claimDue(500, 30, undefined, trx));
    const row = await outboxRow(key);
    expect(claimed.map((c) => (c as { idempotency_key?: string; idempotencyKey?: string }).idempotency_key ?? (c as { idempotencyKey?: string }).idempotencyKey)).not.toContain(key);
    expect(row.state).toBe('delivered');
  });

  it('asked again with the same key and payload answers the same task (the payload hash ignores the owner mark)', async () => {
    const requestId = randomUUID();
    const first = await create({ outboxState: 'recorded', requestId });
    const again = await withRlsContext(db, scope, (trx) =>
      new TaskRepository(db).createTaskAggregate({
        tenantId: TENANT, userId: SYSTEM, idempotencyKey: first.key, title: 'Lifecycle task', clientId: null,
        actorType: 'workflow', payload: { autoGenerate: true, sourcePlatform: 'telegram', sourceChannelId: '9300101' }, outboxState: 'recorded', requestId,
      }, trx));
    expect(again).toMatchObject({ created: false });
    expect(again.task.id).toBe(first.task.id);
  });

  it('without the option nothing changes: pending, no owner mark, no request', async () => {
    const { task, key } = await create({});
    expect(task.request_id).toBeNull();
    const row = await outboxRow(key);
    expect(row).toMatchObject({ state: 'pending', last_error: null, delivered_at: null });
    expect(row.payload.lifecycleOwner).toBeUndefined();
  });
});
