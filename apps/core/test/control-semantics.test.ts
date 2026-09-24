import { afterAll, describe, it, expect } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * N3 (architecture programme 1.3, SPLIT_PLAN.md section 5): what `POST /tasks/:taskId/<word>` answers
 * today, pinned before the `:control` catch-all is replaced by four explicit paths (SPLIT_PLAN F9).
 *
 * The catch-all is registered before six other POST routes of the same shape and answers 404 for an
 * unknown task before it looks at the word, so today those six rely on it for their 404. After F9
 * each of them must give that answer itself, and this file says so whichever way the routes are
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

  const newTask = async (app: ReturnType<typeof createApp>, title: string) => {
    const created = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title, clientId: 'kaae' }) });
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
