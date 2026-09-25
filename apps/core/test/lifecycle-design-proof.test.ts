import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { lifecycleDesignProofHeaders } from '../../worker/src/lifecycle/design-proof.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const token = ['worker', 'design', 'proof', 'fixture'].join('_');
const savedToken = process.env.HAWA_WORKER_TOKEN;
const savedUsers = process.env.TELEGRAM_ALLOWED_USERS;
beforeAll(() => { process.env.HAWA_WORKER_TOKEN = token; });
afterAll(async () => {
  if (savedToken === undefined) delete process.env.HAWA_WORKER_TOKEN;
  else process.env.HAWA_WORKER_TOKEN = savedToken;
  if (savedUsers === undefined) delete process.env.TELEGRAM_ALLOWED_USERS;
  else process.env.TELEGRAM_ALLOWED_USERS = savedUsers;
  await db.destroy();
});

const app = createApp({ db, testAuth: { principal: { role: 'operator', userId } } });
const scope = { tenantId, userId, role: 'operator' as const };
async function ownedTask() {
  const requestId = randomUUID();
  const chat = String(62_000_000 + Math.floor(Math.random() * 8_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = chat;
  const result = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
      rawText: 'Autumn workshop poster', title: 'Autumn workshop poster',
      designInstructions: 'Use the exact copy', exactCopy: ['Autumn workshop poster'],
      clientId, autoGenerate: true, designStudio: false },
  });
  expect(result.stage).toBe('designing');
  return { requestId, taskId: result.taskId, runId: `dr-${result.taskId}` };
}

function proof(requestId: string, taskId: string, runId: string, path: string) {
  return lifecycleDesignProofHeaders({ taskId, requestId, runId, method: 'POST', path }, token);
}

async function post(path: string, headers: Record<string, string> = {}) {
  const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  return { status: response.status, body: await response.json() as { title?: string } };
}

describe('one write owner for lifecycle-owned designs', () => {
  it('blocks generation, Studio and binding before any effect without the current worker proof', async () => {
    const { requestId, taskId, runId } = await ownedTask();
    const operationId = randomUUID();
    const base = `/v1/tasks/${taskId}`;
    const paths = [`${base}/canva/generate`, `${base}/canva/plans/${operationId}/resume`,
      `${base}/canva/plans/${operationId}/abandon`, `${base}/canva/imports/${operationId}/resume`,
      `${base}/canva/design`, `${base}/canva/exports`, `${base}/canva/exports/${operationId}/resume`,
      `${base}/canva/studio`, `${base}/canva/studio/${operationId}/resume`,
      `${base}/canva/studio/${operationId}/select`, `${base}/canva/studio/${operationId}/abandon`,
      `${base}/canva/parity-check`, `${base}/canva/studio/${operationId}/parity`,
      `${base}/canva-binding`];
    for (const path of paths) {
      expect(await post(path)).toMatchObject({ status: 409, body: { title: 'LIFECYCLE_OWNED' } });
      expect(await post(path, proof(requestId, taskId, runId, paths[0]))).toMatchObject(
        path === paths[0] ? { status: 422, body: { title: 'REQUEST_KEY_REQUIRED' } }
          : { status: 409, body: { title: 'LIFECYCLE_OWNED' } },
      );
    }
    const [generation, studio, binding] = await withRlsContext(db, scope, async (trx) => Promise.all([
      trx.selectFrom('canva_design_plans').select('id').where('task_id', '=', taskId).execute(),
      trx.selectFrom('design_studio_runs').select('id').where('task_id', '=', taskId).execute(),
      trx.selectFrom('canva_bindings').select('id').where('task_id', '=', taskId).execute(),
    ]));
    expect([generation, studio, binding]).toEqual([[], [], []]);
    expect(await post(`${base}/design-feedback`)).toMatchObject({
      status: 422, body: { title: 'Invalid Verdict' },
    });
  });

  it('accepts a path-bound worker proof for current design writes and refuses it after the request leaves designing', async () => {
    const { requestId, taskId, runId } = await ownedTask();
    const paths = [`/v1/tasks/${taskId}/canva/generate`, `/v1/tasks/${taskId}/canva/studio`,
      `/v1/tasks/${taskId}/canva-binding`];
    expect(await post(paths[0], proof(requestId, taskId, runId, paths[0]))).toMatchObject({ status: 422 });
    expect(await post(paths[1], proof(requestId, taskId, runId, paths[1]))).toMatchObject({ status: 400 });
    expect(await post(paths[2], proof(requestId, taskId, runId, paths[2]))).toMatchObject({ status: 422 });
    await withRlsContext(db, scope, async (trx) => {
      await trx.updateTable('requests').set({ stage: 'manual', rev: 2 })
        .where('request_id', '=', requestId).execute();
    });
    expect(await post(paths[0], proof(requestId, taskId, runId, paths[0]))).toMatchObject({
      status: 409, body: { title: 'LIFECYCLE_OWNED' },
    });
  });

  it('keeps an ordinary legacy task on its existing Canva path', async () => {
    const task = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: String(81_000_000 + Math.floor(Math.random() * 8_000_000)),
      rawText: 'Legacy poster', title: 'Legacy poster', designInstructions: '',
      exactCopy: ['Legacy poster'], clientId, autoGenerate: false });
    expect(await post(`/v1/tasks/${task.task.id}/canva/generate`)).toMatchObject({
      status: 422, body: { title: 'REQUEST_KEY_REQUIRED' },
    });
  });
});
