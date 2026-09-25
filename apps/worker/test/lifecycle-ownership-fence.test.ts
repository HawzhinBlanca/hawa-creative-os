import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { createApp } from '../../core/src/app.js';
import { projectLifecycleOpen } from '../../core/src/services/lifecycle-projection.js';
import { persistChatIntake } from '../../core/src/services/chat-intake.js';
import { OutboxConsumer } from '../src/outbox-consumer.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const inTenant = <T>(action: (trx: Kysely<Database>) => Promise<T>): Promise<T> => withRlsContext(db, scope, action);
afterAll(() => db.destroy());

function draft(requestId: string) {
  return {
    platform: 'telegram' as const,
    sourceEventId: `lc-${requestId}-r0`, sourceChannelId: '7654321',
    rawText: 'Autumn workshop poster', title: 'Autumn workshop poster',
    designInstructions: 'Use the supplied title', exactCopy: ['Autumn workshop poster'],
    clientId: null, autoGenerate: false,
  };
}

async function ownedTask() {
  const requestId = randomUUID();
  const result = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`, draft: draft(requestId),
  });
  return { ...result, requestId };
}

describe('one executor per lifecycle task', () => {
  it('refuses both legacy Canva status aliases before a task event or notification is written', async () => {
    const { taskId, requestId } = await ownedTask();
    const before = await inTenant(async (trx) => ({
      events: await trx.selectFrom('task_events').select('id').where('task_id', '=', taskId).execute(),
      commands: await trx.selectFrom('outbox_commands').select('id').where('aggregate_id', '=', taskId).execute(),
    }));
    const app = createApp({ db, testAuth: { principal: { role: 'operator', userId } } });
    for (const alias of ['canva-status', 'canva-ready']) {
      const response = await app.request(`/v1/tasks/${taskId}/notifications/${alias}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DRAFT_READY', designId: 'DA12345678' }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ title: 'LIFECYCLE_OWNED' });
    }
    const after = await inTenant(async (trx) => ({
      task: await trx.selectFrom('tasks').select(['state', 'request_id']).where('id', '=', taskId).executeTakeFirst(),
      events: await trx.selectFrom('task_events').select('id').where('task_id', '=', taskId).execute(),
      commands: await trx.selectFrom('outbox_commands').select('id').where('aggregate_id', '=', taskId).execute(),
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
    }));
    expect(after.events).toEqual(before.events);
    expect(after.commands).toEqual(before.commands);
    expect(after.task).toMatchObject({ state: 'received', request_id: requestId });
    expect(after.request).toMatchObject({ stage: 'manual', rev: '1' });

  });

  it('does not dispatch requeued task.created or task.dispatch to the legacy workflow', async () => {
    const { taskId } = await ownedTask();
    const outbox = new OutboxRepository(db);
    await inTenant(async (trx) => {
      await sql`UPDATE hawa.outbox_commands SET state = 'pending', available_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'task.created'`.execute(trx);
      await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId,
        commandType: 'task.dispatch', idempotencyKey: `rogue-dispatch:${taskId}`, payload: { taskId } }, trx);
    });
    const calls: string[] = [];
    const consumer = new OutboxConsumer(db, { tenantId, userId, batchSize: 10,
      dispatcher: { dispatch: async (cmd: { command_type: string }) => { calls.push(cmd.command_type); return { workflowId: 'should-not-run' }; } } as any,
      telegramBotToken: null });
    const summary = await consumer.processBatch(10);
    expect(summary.succeeded).toBe(2);
    expect(summary.errors).toEqual([]);
    expect(calls).toEqual([]);
    const commands = await inTenant((trx) => trx.selectFrom('outbox_commands').select(['command_type', 'state'])
      .where('aggregate_id', '=', taskId).orderBy('command_type').execute());
    expect(commands).toEqual([
      expect.objectContaining({ command_type: 'task.created', state: 'delivered' }),
      expect.objectContaining({ command_type: 'task.dispatch', state: 'delivered' }),
    ]);
  });

  it('continues to accept an outcome for a legacy task', async () => {
    const legacy = await persistChatIntake(db, { ...draft(randomUUID()), sourceEventId: randomUUID() });
    const app = createApp({ db, testAuth: { principal: { role: 'operator', userId } } });
    const response = await app.request(`/v1/tasks/${legacy.task.id}/notifications/canva-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'MANUAL_DESIGN_REQUIRED', notifyRequester: false }),
    });
    expect(response.status).toBe(200);

    // A forged lifecycle marker without a matching request row is a visible consistency failure;
    // it cannot launch either executor under an ambiguous owner.
    await inTenant((trx) => sql`UPDATE hawa.outbox_commands
      SET payload = payload || '{"lifecycleOwner":"restate"}'::jsonb
      WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${legacy.task.id}::uuid
        AND command_type = 'task.created'`.execute(trx).then(() => undefined));
    const calls: string[] = [];
    const consumer = new OutboxConsumer(db, { tenantId, userId, batchSize: 10,
      dispatcher: { dispatch: async (cmd: { command_type: string }) => { calls.push(cmd.command_type); return { workflowId: 'should-not-run' }; } } as any,
      telegramBotToken: null });
    const summary = await consumer.processBatch(10);
    expect(summary.deadLettered).toBe(1);
    expect(summary.errors[0]?.error).toContain('LIFECYCLE_OWNERSHIP_INCONSISTENT');
    expect(calls).toEqual([]);
  });
});
