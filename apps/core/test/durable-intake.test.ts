import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, withRlsContext } from '@hawa/db';

describe('Milestone A: Honest, Authenticated, Durable Task Intake Integration', () => {
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
  const db = createDb(connectionString);
  const app = createApp({ db });

  const tenantId = '00000000-0000-4000-a000-000000000001';
  const testBearer = process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token';
  const authSessionBearer = `Bearer ${testBearer}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': authSessionBearer,
  };

  it('1. Rejects unauthenticated and forged task intake requests with 401 Unauthorized', async () => {
    // Unauthenticated
    const anonRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Unauthenticated Task' }),
    });
    expect(anonRes.status).toBe(401);
    const anonBody = await anonRes.json();
    expect(anonBody.status).toBe(401);

    // Forged Bearer
    const forgedRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer forged-bad-token-12345',
      },
      body: JSON.stringify({ title: 'Forged Task' }),
    });
    expect(forgedRes.status).toBe(401);
  });

  it('2. Commits task, event, and outbox atomically to PostgreSQL and returns 201 only after commit', async () => {
    const idempotencyKey = `idem_intake_test_${Date.now()}`;
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        title: 'New Spring Launch Banner',
        description: 'Brand compliant graphic for social media',
        priority: 4,
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.title).toBe('New Spring Launch Banner');
    expect(task.priority).toBe(4);
    expect(task.status).toBe('RECEIVED');
    expect(task.version).toBe(1);

    // Independent SQL readback directly from PostgreSQL
    const { dbTask, dbEvents, dbOutbox } = await withRlsContext(
      db,
      { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
      async (trx) => {
        const t = await trx.selectFrom('tasks').selectAll().where('id', '=', task.id).executeTakeFirst();
        const e = await trx.selectFrom('task_events').selectAll().where('task_id', '=', task.id).execute();
        const o = await trx.selectFrom('outbox_commands').selectAll().where('aggregate_id', '=', task.id).execute();
        return { dbTask: t, dbEvents: e, dbOutbox: o };
      }
    );

    expect(dbTask).toBeDefined();
    expect(dbTask!.title).toBe('New Spring Launch Banner');
    expect(Number(dbTask!.version)).toBe(1);

    expect(dbEvents.length).toBe(1);
    expect(dbEvents[0].event_type).toBe('task.created');
    expect(Number(dbEvents[0].aggregate_version)).toBe(1);

    expect(dbOutbox.length).toBe(1);
    expect(dbOutbox[0].command_type).toBe('task.created');
    expect(dbOutbox[0].idempotency_key).toBe(idempotencyKey);
    expect(dbOutbox[0].state).toBe('pending');
  });

  it('3. Enforces stable idempotency: replay returns 200, payload conflict returns 409', async () => {
    const idempotencyKey = `idem_replay_test_${Date.now()}`;
    const initialPayload = {
      title: 'Original Idempotency Test Task',
      description: 'First attempt',
      priority: 3,
    };

    // First attempt creates
    const res1 = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(initialPayload),
    });
    expect(res1.status).toBe(201);
    const task1 = await res1.json();

    // Second attempt with identical payload returns 200 and exact same task
    const res2 = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(initialPayload),
    });
    expect(res2.status).toBe(200);
    const task2 = await res2.json();
    expect(task2.id).toBe(task1.id);
    expect(task2.version).toBe(task1.version);

    // Third attempt with conflicting payload returns 409 Conflict
    const res3 = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        title: 'Tampered Title with Identical Idempotency Key',
        description: 'Should conflict and reject',
      }),
    });
    expect(res3.status).toBe(409);
    const conflictBody = await res3.json();
    expect(conflictBody.title).toContain('Conflict');
  });

  it('4. Persists across new process/app instances: restarts survive without in-memory state', async () => {
    const idempotencyKey = `idem_restart_${Date.now()}`;
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        title: 'Task Must Survive Process Crash',
        description: 'Testing survival across brand-new createApp instance',
        priority: 5,
      }),
    });
    expect(createRes.status).toBe(201);
    const originalTask = await createRes.json();

    // Create a brand new app instance (simulating full server restart with zero memory carryover)
    const freshApp = createApp({ db });
    const getRes = await freshApp.request(`/v1/tasks/${originalTask.id}`, {
      method: 'GET',
      headers: authHeaders,
    });

    expect(getRes.status).toBe(200);
    const recoveredTask = await getRes.json();
    expect(recoveredTask.id).toBe(originalTask.id);
    expect(recoveredTask.title).toBe('Task Must Survive Process Crash');
    expect(recoveredTask.priority).toBe(5);
    expect(recoveredTask.status).toBe('RECEIVED');
    expect(recoveredTask.version).toBe(1);
  });

  it('5. Database outage behavior: returns 503 and never fabricates 201 success when DB is down', async () => {
    const badDb = createDb('postgresql://hawa_app:invalid_pass@127.0.0.1:54332/hawa_test');
    const brokenApp = createApp({ db: badDb });

    const res = await brokenApp.request('/v1/tasks', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Task during database failure' }),
    });

    expect(res.status).toBe(503);
    const problem = await res.json();
    expect(problem.title).toBe('Durable Storage Unavailable');
    await badDb.destroy();
  });
});
