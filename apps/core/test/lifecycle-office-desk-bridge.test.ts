import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { checkSignedOfficeDecision, type SignedOfficeDecision } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { recordOfficeRevision, type AutomaticLifecycleState, type AutomaticOpenContext } from '../../worker/src/lifecycle/request-lifecycle.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000001';
const secret = ['desk', 'office', 'gateway', 'fixture'].join('_');
const savedToken = process.env.HAWA_WORKER_TOKEN;
const savedIngress = process.env.RESTATE_INGRESS_URL;
const savedUsers = process.env.TELEGRAM_ALLOWED_USERS;
const scope = { tenantId, userId, role: 'operator' as const };

beforeAll(() => {
  process.env.HAWA_WORKER_TOKEN = secret;
  process.env.RESTATE_INGRESS_URL = 'http://restate.fixture:8080';
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (savedToken === undefined) delete process.env.HAWA_WORKER_TOKEN;
  else process.env.HAWA_WORKER_TOKEN = savedToken;
  if (savedIngress === undefined) delete process.env.RESTATE_INGRESS_URL;
  else process.env.RESTATE_INGRESS_URL = savedIngress;
  if (savedUsers === undefined) delete process.env.TELEGRAM_ALLOWED_USERS;
  else process.env.TELEGRAM_ALLOWED_USERS = savedUsers;
  await db.destroy();
});

async function reviewableRequest() {
  const requestId = randomUUID();
  const chatId = String(75_000_000 + Math.floor(Math.random() * 8_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = chatId;
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'Autumn poster', title: 'Autumn poster', designInstructions: 'Use exact copy',
      exactCopy: ['Autumn poster'], clientId, autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;
  const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
    tenantId, taskId, clientId, canvaDesignId: designId,
    editUrl: `https://www.canva.com/design/${designId}/edit`,
  }, trx));
  const runId = `dr-${taskId}`;
  const designed = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2,
    key: `${requestId}:2:designFinished:${runId}`,
    report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId },
  });
  expect(designed.stage).toBe('in_review');
  return { requestId, taskId, revisionId: designed.revisionId!, chatId, runId };
}

describe('authenticated Desk to private lifecycle office decision', () => {
  it('keeps server identity, replays a lost response, and refuses changed intent under one action key', async () => {
    const { requestId, taskId, revisionId, chatId, runId } = await reviewableRequest();
    let state = { v: 1, requestId, tenantId, chatId, owner: 'restate', stage: 'in_review', rev: 2,
      taskId, runId, outcome: { revisionId } } as unknown as AutomaticLifecycleState;
    const object: AutomaticOpenContext = {
      key: requestId,
      get: async () => state,
      run: async (_name, action) => action(),
      set: (_name, value) => { state = value as AutomaticLifecycleState; },
      send: () => { throw new Error('no message expected'); },
      startDesign: () => { throw new Error('no design expected'); },
    };
    const internal = createApp({ db } as any);
    const core = { post: async <T>(path: string, payload: unknown): Promise<T> => {
      const answer = await internal.request(`/v1${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
      if (!answer.ok) throw new Error(`Core projection HTTP ${answer.status}`);
      return answer.json() as Promise<T>;
    } };
    let loseFirstAnswer = false;
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://restate.fixture:8080/OfficeDecisionGateway/decide');
      const envelope = JSON.parse(String(init?.body)) as SignedOfficeDecision;
      expect(checkSignedOfficeDecision(envelope, secret)).toBe('ok');
      try {
        const result = await recordOfficeRevision(object, core, envelope.event);
        if (loseFirstAnswer) { loseFirstAnswer = false; throw new Error('Desk response lost after commit'); }
        return Response.json(result);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Desk response lost')) throw error;
        return Response.json({ title: 'conflict' }, { status: 409 });
      }
    });
    vi.stubGlobal('fetch', transport);
    const path = `/v1/tasks/${taskId}/revisions/${revisionId}/decisions`;
    const director = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const operator = createApp({ db, testAuth: { principal: { role: 'operator', userId } } });
    const actionId = randomUUID();
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': actionId };
    const body = { action: 'revision_requested', revisionRequest: { comment: 'Correct the venue' } };
    const missingKey = await director.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(missingKey.status).toBe(422);
    const denied = await operator.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(denied.status).toBe(403);
    expect(transport).not.toHaveBeenCalled();

    loseFirstAnswer = true;
    const uncertain = await director.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(uncertain.status).toBe(503);
    const restartedCore = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const accepted = await restartedCore.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(accepted.status).toBe(201);
    const result = await accepted.json() as Record<string, unknown>;
    expect(result).toMatchObject({ decisionId: expect.any(String), requestId, requestRev: 3,
      actor: { userId, role: 'art_director', verifiedServerSide: true } });
    const changed = await restartedCore.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, revisionRequest: { comment: 'Different venue' } }) });
    expect(changed.status).toBe(409);
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select(['id', 'decided_by']).where('task_id', '=', taskId).execute(),
      receipts: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
    }));
    expect(rows.request).toMatchObject({ stage: 'manual', rev: '3' });
    expect(rows.approvals).toEqual([{ id: result.decisionId, decided_by: userId }]);
    expect(rows.receipts.map((row) => Number(row.rev)).sort()).toEqual([1, 2, 3]);
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
