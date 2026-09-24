import { afterAll, describe, it, expect } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * N3 (architecture programme 1.3, SPLIT_PLAN.md section 5): what `POST /tasks/:taskId/<word>` answers,
 * pinned while a `:control` catch-all served pause, resume, cancel and retry, and kept since SPLIT_PLAN
 * F9 replaced it with four explicit paths.
 *
 * The catch-all was registered before six other POST routes of the same shape and answered 404 for an
 * unknown task (503 when Postgres could not be read) before it looked at the word, so those six relied
 * on it. Each of them now gives that answer itself, and this file says so whichever way the routes are
 * arranged.
 */
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' };
const UNKNOWN = '00000000-0000-4000-8000-00000000dead';

describe('N3: task control semantics', () => {
  const INTERCEPTED = ['redrive', 'chat-approval-action', 'revisions', 'comments', 'feedback', 'publish-omnichannel'];

  // Production runs with Postgres; the database-less app is what most route tests use.
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => db.destroy());
  const apps = { memory: () => createApp(), postgres: () => createApp({ db }) };

  it.each(INTERCEPTED.flatMap((word) => (['memory', 'postgres'] as const).map((store) => [word, store] as const)))(
    'POST /tasks/<unknown>/%s answers 404 (%s)',
    async (word, store) => {
      const res = await apps[store]().request(`/v1/tasks/${UNKNOWN}/${word}`, { method: 'POST', headers, body: '{}' });
      expect(res.status).toBe(404);
    }
  );

  const newTask = async (app: ReturnType<typeof createApp>, title: string, clientId = 'kaae') => {
    const created = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title, clientId }) });
    expect(created.status).toBe(201);
    return (await created.json()).id as string;
  };
  const control = (app: ReturnType<typeof createApp>, id: string, word: string) =>
    app.request(`/v1/tasks/${id}/${word}`, { method: 'POST', headers, body: '{}' });
  const statusOf = async (app: ReturnType<typeof createApp>, id: string) => (await (await app.request(`/v1/tasks/${id}`, { headers })).json()).status;

  // Today's words, pinned as they are rather than as they should be: cancel hands the task to an
  // operator, and pause, resume and retry all move it to PLANNING, through the state machine.
  it('POST /tasks/<task>/cancel is accepted with 202 and hands the task to an operator', async () => {
    const app = createApp();
    const id = await newTask(app, 'Control cancel');
    const res = await control(app, id, 'cancel');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ taskId: id, workflowId: `wf_${id}` });
    expect(await statusOf(app, id)).toBe('OPERATOR_REQUIRED');
  });

  it.each(['pause', 'resume', 'retry'])('POST /tasks/<task>/%s is accepted with 202 where the state machine allows it', async (word) => {
    const app = createApp();
    const id = await newTask(app, `Control ${word}`);
    // RECEIVED cannot move to PLANNING, so the control is refused rather than forced.
    expect((await control(app, id, word)).status).toBe(409);
    expect((await control(app, id, 'cancel')).status).toBe(202);
    const res = await control(app, id, word);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ taskId: id, workflowId: `wf_${id}` });
    expect(await statusOf(app, id)).toBe('PLANNING');
  });

  // Whoever answers these six after the catch-all is gone must still refuse to act on the copy of the
  // task this process holds when Postgres cannot be read; the catch-all's readCurrentTask used to
  // answer 503 for all of them.
  it.each(INTERCEPTED)('POST /tasks/<task>/%s answers 503 when Postgres cannot be read, not from memory', async (word) => {
    const coreDb = createDb(process.env.TEST_DATABASE_URL!);
    const app = createApp({ db: coreDb });
    // KAAE's id in the test database's seed; with Postgres a task names its client by id.
    const id = await newTask(app, `Control ${word}: database gone`, 'c1000000-0000-4000-8000-000000000002');
    // Core holds the task in memory now; nothing below may be answered from that copy.
    expect((await app.request(`/v1/tasks/${id}`, { headers })).status).toBe(200);
    await coreDb.destroy();
    const res = await control(app, id, word);
    expect(res.status).toBe(503);
    expect((await res.json()).detail).toMatch(/could not be read from the database/);
  });

  it('POST /tasks/<task>/approve is not a control: 404, and the task is not approved', async () => {
    const app = createApp();
    const created = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Control approve', clientId: 'kaae' }) });
    const { id } = await created.json();
    const before = (await (await app.request(`/v1/tasks/${id}`, { headers })).json()).status;
    expect((await app.request(`/v1/tasks/${id}/approve`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await app.request(`/v1/tasks/${UNKNOWN}/approve`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await (await app.request(`/v1/tasks/${id}`, { headers })).json()).status).toBe(before);
  });
});
