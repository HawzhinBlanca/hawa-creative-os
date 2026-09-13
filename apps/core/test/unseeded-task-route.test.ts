import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '@hawa/db';

// Regression for the restart case: a task that exists in PostgreSQL but not in a fresh process's
// in-memory map must be routable. The handler used to read `task.status` from the empty map and
// answered 500. Runs against the local test database only (never a default production URL).
describe('routing a persisted task from a fresh process', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN!}` };
  let app: any;
  beforeAll(() => { app = createApp({ db }); });
  afterAll(async () => { await db.destroy().catch(() => {}); });

  it('POST /v1/tasks/:taskId/route answers 202 after the process that created the task is gone', async () => {
    const createRes = await app.request('/v1/tasks', {
      method: 'POST', headers,
      body: JSON.stringify({ title: 'PostgreSQL-persisted task, routed after restart', priority: 'routine' }),
    });
    expect(createRes.status).toBe(201);
    const taskId = (await createRes.json()).id;

    const restartedApp = createApp({ db });
    const routeRes = await restartedApp.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST', headers,
      body: JSON.stringify({ clientId: 'c1000000-0000-4000-8000-000000000002', reason: 'Route persisted task across restarts' }),
    });
    expect(routeRes.status).toBe(202);
    const body = await routeRes.json();
    expect(body.commandId).toBeDefined();
    expect(body.taskId).toBe(taskId);

    const read = await restartedApp.request(`/v1/tasks/${taskId}`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).clientId).toBe('c1000000-0000-4000-8000-000000000002');
  });
});
