import crypto from 'node:crypto';
import { afterAll, describe, it, expect } from 'vitest';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createDb, withRlsContext, TaskRepository, type TaskState } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * The workflow controller routes (GET /tasks/:taskId/workflow/state, POST /tasks/:taskId/workflow/:action)
 * kept a TaskWorkflowController per task in Core's memory (architecture programme 1.3, SPLIT_PLAN.md
 * G6, `workflowControllers`). A restart lost every pause, checkpoint and audit line; a second Core
 * process answered with a different state; and pause, resume and cancel changed only this process's
 * copy of the task, never Postgres, so the Desk and the worker never saw them. Nothing in the Desk
 * called them.
 *
 * The state is now read from the task as Postgres has it, and the actions are retired (410): the
 * durable controls are POST /tasks/:taskId/pause, resume, cancel and retry, and a design run's
 * checkpoints and replay are the worker's Restate journal.
 */
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const tenantId = '00000000-0000-4000-a000-000000000001';
const UNKNOWN = '00000000-0000-4000-8000-00000000beef';

describe('workflow controller routes read Postgres, not Core memory', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => db.destroy());

  const newTask = async (app: ReturnType<typeof createApp>, title: string) => {
    const created = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `workflow-state-${crypto.randomUUID()}` },
      body: JSON.stringify({ title }),
    });
    expect(created.status).toBe(201);
    return (await created.json()).id as string;
  };
  const moveInPostgres = (taskId: string, toState: TaskState) =>
    withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      new TaskRepository(trx).transitionState(
        { taskId, tenantId, toState, actorType: 'workflow', actorId: SYSTEM_AUTOMATION_USER_ID, reason: 'test: moved outside this process' },
        trx
      ));
  const stateInPostgres = async (taskId: string) =>
    (await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      new TaskRepository(trx).findById(taskId, tenantId, trx)))?.state;
  const stateOf = async (app: ReturnType<typeof createApp>, taskId: string) => {
    const res = await app.request(`/v1/tasks/${taskId}/workflow/state`, { headers });
    return { status: res.status, body: await res.json() };
  };
  const act = (app: ReturnType<typeof createApp>, taskId: string, action: string) =>
    app.request(`/v1/tasks/${taskId}/workflow/${action}`, { method: 'POST', headers, body: JSON.stringify({ reason: 'test' }) });

  it('reports the state Postgres has, including a move made by another process', async () => {
    const app = createApp({ db });
    const taskId = await newTask(app, 'Workflow state from Postgres');
    const before = await stateOf(app, taskId);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ taskId, executionState: 'RUNNING', status: 'RECEIVED' });

    // The requester was asked a question: the task waits (paused). This process was not told.
    await moveInPostgres(taskId, 'paused');
    expect((await stateOf(app, taskId)).body).toMatchObject({ taskId, executionState: 'PAUSED', status: 'PAUSED' });
  });

  it('gives a new process (a restart, a second replica) the same answer', async () => {
    const first = createApp({ db });
    const taskId = await newTask(first, 'Workflow state after a restart');
    await moveInPostgres(taskId, 'cancelled');
    const restarted = createApp({ db });
    const again = await stateOf(restarted, taskId);
    expect(again.body).toMatchObject({ taskId, executionState: 'CANCELLED', status: 'CANCELLED' });
    expect((await stateOf(first, taskId)).body).toEqual(again.body);
  });

  it('answers 404 for a task nobody has, instead of inventing a running workflow for it', async () => {
    const app = createApp({ db });
    expect((await stateOf(app, UNKNOWN)).status).toBe(404);
    expect((await stateOf(app, 'not-a-uuid')).status).toBe(404);
    expect((await act(app, UNKNOWN, 'pause')).status).toBe(404);
  });

  it.each(['pause', 'resume', 'cancel', 'crash', 'checkpoint', 'replay'])(
    'retires POST workflow/%s (410), naming the durable route, and leaves the task as Postgres has it',
    async (action) => {
      const app = createApp({ db });
      const taskId = await newTask(app, `Workflow ${action} retired`);
      const res = await act(app, taskId, action);
      expect(res.status).toBe(410);
      expect((await res.json()).detail).toContain(`/tasks/${taskId}/`);
      // Nothing moved, in Postgres or in the answer of a process that holds no copy of the task.
      expect(await stateInPostgres(taskId)).toBe('received');
      expect((await stateOf(createApp({ db }), taskId)).body).toMatchObject({ executionState: 'RUNNING', status: 'RECEIVED' });
    }
  );

  it.each(['teleport', 'constructor', 'toString'])('still refuses an action it never had (%s)', async (action) => {
    const app = createApp({ db });
    const taskId = await newTask(app, `Workflow unknown action ${action}`);
    expect((await act(app, taskId, action)).status).toBe(400);
  });

  it('works the same without a database, from the task this process holds', async () => {
    const app = createApp();
    const created = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Workflow state without a database' }) });
    expect(created.status).toBe(201);
    const taskId = (await created.json()).id as string;
    expect((await stateOf(app, taskId)).body).toMatchObject({ taskId, executionState: 'RUNNING', status: 'RECEIVED' });
    expect((await act(app, taskId, 'pause')).status).toBe(410);
    expect((await stateOf(app, taskId)).body).toMatchObject({ executionState: 'RUNNING', status: 'RECEIVED' });
  });
});
