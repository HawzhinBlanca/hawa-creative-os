import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { TaskRepository } from '../src/repositories/task.repository.js';

/**
 * `tasks` has FORCE ROW LEVEL SECURITY and the runtime role (hawa_app, which TEST_DATABASE_URL
 * connects as) does not bypass it. updateStatus read the task outside any tenant context, found no
 * row, and threw "not found" for every task; its one caller, the Canva status route, swallowed that,
 * which is part of how production tasks stayed RECEIVED after their designs were delivered.
 */
describe('TaskRepository.updateStatus under row-level security', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' };
  const repo = new TaskRepository(db);
  afterAll(() => db.destroy());

  const newTask = async () =>
    (
      await withRlsContext(db, scope, (trx) =>
        repo.createTaskAggregate({
          tenantId, userId: operatorUserId, idempotencyKey: `rls-status-${randomUUID()}`,
          title: 'RLS status test', description: 'status move under tenant context',
          clientId: null, actorType: 'user', actorId: operatorUserId, enqueueOutbox: false,
        } as any, trx)
      )
    ).task.id as string;

  it('moves the task, with its event, when given the tenant identity', async () => {
    const taskId = await newTask();
    const updated = await repo.updateStatus(taskId, 'RECEIVED', 'OPERATOR_REQUIRED', operatorUserId, 'workflow', 'Automatic draft failed', undefined, scope);
    expect(updated.state).toBe('failed_operator');
    expect(updated.status).toBe('OPERATOR_REQUIRED');

    const events = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT data FROM hawa.task_events WHERE task_id = ${taskId}::uuid AND event_type = 'task.state_changed'`.execute(trx)).rows);
    expect(events.map((e: any) => e.data.toState)).toEqual(['failed_operator']);
  });

  it('uses the caller transaction when one is given', async () => {
    const taskId = await newTask();
    const updated = await withRlsContext(db, scope, (trx) =>
      repo.updateStatus(taskId, 'RECEIVED', 'AWAITING_APPROVAL', operatorUserId, 'workflow', 'Draft delivered', undefined, { trx }));
    expect(updated.state).toBe('human_review');
  });

  it('still cannot see a task without a tenant context, which is why the scope is required', async () => {
    const taskId = await newTask();
    await expect(repo.updateStatus(taskId, 'RECEIVED', 'AWAITING_APPROVAL', operatorUserId, 'workflow', 'no scope')).rejects.toThrow(/not found/);
  });
});
