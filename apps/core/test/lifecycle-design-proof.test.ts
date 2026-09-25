import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, RevisionRepository, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { lifecycleDesignProofHeaders } from '../../worker/src/lifecycle/design-proof.js';
import { createRedrive } from '../src/services/redrive.js';

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

async function post(path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
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

  it('refuses legacy task design routes while the request is designing, then permits a manual revision draft', async () => {
    const { requestId, taskId } = await ownedTask();
    const base = `/v1/tasks/${taskId}`;
    for (const path of [`${base}/route`, `${base}/briefs`, `${base}/generate`, `${base}/revisions`]) {
      expect(await post(path)).toMatchObject({ status: 409, body: { title: 'LIFECYCLE_OWNED' } });
    }
    const [briefs, revisionsBefore] = await withRlsContext(db, scope, (trx) => Promise.all([
      trx.selectFrom('design_briefs').select('id').where('task_id', '=', taskId).execute(),
      trx.selectFrom('design_revisions').select('id').where('task_id', '=', taskId).execute(),
    ]));
    expect([briefs, revisionsBefore]).toEqual([[], []]);
    await withRlsContext(db, scope, async (trx) => {
      await trx.updateTable('requests').set({ stage: 'manual', rev: 2 })
        .where('request_id', '=', requestId).execute();
    });
    for (const path of [`${base}/route`, `${base}/briefs`, `${base}/generate`]) {
      expect(await post(path)).toMatchObject({ status: 409, body: { title: 'LIFECYCLE_OWNED' } });
    }
    expect(await post(`${base}/revisions`)).toMatchObject({
      status: 400, body: { title: 'Invalid Design Nodes' },
    });
    expect(await post(`${base}/revisions`, {}, {
      nodes: [{ id: 'headline', type: 'text', text: 'Office supplied copy' }],
    })).toMatchObject({ status: 201 });
    const reviewer = createApp({ db, testAuth: { principal: { role: 'reviewer', userId } } });
    const reviewerResult = await reviewer.request(`${base}/revisions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'headline-2', type: 'text', text: 'Unapproved copy' }] }),
    });
    expect(reviewerResult.status).toBe(403);
    const [request, revisions] = await withRlsContext(db, scope, async (trx) => Promise.all([
      trx.selectFrom('requests').select('stage').where('request_id', '=', requestId).executeTakeFirst(),
      trx.selectFrom('design_revisions').select('id').where('task_id', '=', taskId).execute(),
    ]));
    expect(request?.stage).toBe('manual');
    expect(revisions).toHaveLength(1);
  });

  it('keeps task control and redrive actions out of a lifecycle-owned request', async () => {
    const { taskId } = await ownedTask();
    const before = await withRlsContext(db, scope, (trx) => trx.selectFrom('tasks')
      .select(['state', 'version']).where('id', '=', taskId).executeTakeFirstOrThrow());
    for (const action of ['pause', 'resume', 'cancel', 'retry', 'redrive']) {
      expect(await post(`/v1/tasks/${taskId}/${action}`)).toMatchObject({
        status: 409, body: { title: 'LIFECYCLE_OWNED' },
      });
    }
    const after = await withRlsContext(db, scope, (trx) => trx.selectFrom('tasks')
      .select(['state', 'version']).where('id', '=', taskId).executeTakeFirstOrThrow());
    expect(after).toEqual(before);
  });

  it('refuses legacy review and delivery for a request-owned task before either can write', async () => {
    const { requestId, taskId } = await ownedTask();
    const revisionId = await withRlsContext(db, scope, async (trx) => {
      await trx.updateTable('requests').set({ stage: 'manual', rev: 2 })
        .where('request_id', '=', requestId).execute();
      const revision = await new RevisionRepository(trx).createRevision({ tenantId, taskId,
        neutralManifest: { nodes: [{ id: 'headline', type: 'text', text: 'Office copy' }] } }, trx);
      return revision.id;
    });
    const reviewPath = `/v1/tasks/${taskId}/revisions/${revisionId}/decisions`;
    const director = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const decision = await director.request(reviewPath, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'approve' }) });
    expect({ status: decision.status, body: await decision.json() }).toMatchObject({
      status: 422, body: { title: 'Unsupported Lifecycle Decision' },
    });
    expect(await post(`/v1/tasks/${taskId}/publish`)).toMatchObject({
      status: 409, body: { title: 'LIFECYCLE_OWNED' },
    });
    expect(await post(`/v1/tasks/${taskId}/publish-omnichannel`)).toMatchObject({
      status: 409, body: { title: 'LIFECYCLE_OWNED' },
    });
    const prepare = await app.request(`/v1/internal/lifecycle/${requestId}/deliveries/${randomUUID()}/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskId, tenantId }),
    });
    expect({ status: prepare.status, body: await prepare.json() }).toMatchObject({
      status: 409, body: { code: 'LIFECYCLE_OWNED' },
    });
    await expect(withRlsContext(db, scope, (trx) => new RevisionRepository(trx).recordApproval({
      tenantId, taskId, revisionId, decision: 'revision_requested', decidedBy: userId,
    }, trx))).rejects.toThrow('LIFECYCLE_OWNED');
    const [approvals, publications, outbox] = await withRlsContext(db, scope, async (trx) => Promise.all([
      trx.selectFrom('approvals').select('id').where('task_id', '=', taskId).execute(),
      trx.selectFrom('publications').select('id').where('task_id', '=', taskId).execute(),
      trx.selectFrom('outbox_commands').select('id').where('aggregate_id', '=', taskId)
        .where('command_type', '=', 'notify.published').execute(),
    ]));
    expect([approvals, publications, outbox]).toEqual([[], [], []]);
  });

  it('does not let an older round task accept a manual revision', async () => {
    const { requestId, taskId } = await ownedTask();
    const successor = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: String(82_000_000 + Math.floor(Math.random() * 8_000_000)),
      rawText: 'Later round', title: 'Later round', designInstructions: '',
      exactCopy: ['Later round'], clientId, autoGenerate: false });
    await withRlsContext(db, scope, async (trx) => {
      await trx.updateTable('requests').set({ stage: 'manual', rev: 2,
        current_task_id: successor.task.id }).where('request_id', '=', requestId).execute();
    });
    expect(await post(`/v1/tasks/${taskId}/revisions`, {}, {
      nodes: [{ id: 'headline', type: 'text', text: 'Stale round' }],
    })).toMatchObject({ status: 409, body: { title: 'LIFECYCLE_OWNED' } });
  });

  it('refuses a direct redrive service call and an unauthenticated task control', async () => {
    const { taskId } = await ownedTask();
    const redrive = createRedrive({ db, probeModelProvider: async () => 'healthy' } as Parameters<typeof createRedrive>[0]);
    expect(await redrive.redriveTask(taskId)).toMatchObject({
      ok: false, code: 'LIFECYCLE_OWNED',
    });
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.canva_design_plans
      (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid,
        ${userId}, ${`failed-plan-${taskId}`}, 'fixture-hash', '{}'::jsonb, 'failed')`.execute(trx));
    expect(await redrive.sweepFailedTasks(tenantId)).toMatchObject({ swept: 0, redriven: 0 });
    const anonymous = createApp({ db });
    const response = await anonymous.request(`/v1/tasks/${taskId}/pause`, { method: 'POST' });
    expect(response.status).toBe(401);
    const outbox = await withRlsContext(db, scope, (trx) => trx.selectFrom('outbox_commands')
      .select('id').where('aggregate_id', '=', taskId).where('command_type', '=', 'task.dispatch').execute());
    expect(outbox).toEqual([]);
  });
});
