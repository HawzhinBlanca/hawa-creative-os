/**
 * Revision-round lifecycle integration test.
 *
 * Verifies the full multi-round rev sequence:
 *   designing(1) → in_review(2) → manual(3) → designing(4) → in_review(5)
 *
 * Uses the same test setup pattern as lifecycle-office-desk-bridge.test.ts:
 * direct projection calls for setup, HTTP for the tested route.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvaBindingRepository, createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import {
  projectLifecycleOpen,
  projectLifecycleDesignOutcome,
  projectLifecycleOfficeDecision,
} from '../src/services/lifecycle-projection.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const token = ['worker', 'lifecycle', 'revision', 'round', 'test'].join('_');
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

/** Post to the internal lifecycle route via the full app stack. */
async function post(requestId: string, path: string, body: unknown) {
  const res = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

/**
 * Set up a request that has completed its first design and is in `in_review` (rev=2).
 * Uses the same pattern as reviewableRequest() in lifecycle-office-desk-bridge.test.ts.
 */
async function reviewableRequest() {
  const requestId = randomUUID();
  const chatId = String(73_000_000 + Math.floor(Math.random() * 9_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = chatId;

  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'Revision round poster', title: 'Revision round poster',
      designInstructions: 'Use exact copy', exactCopy: ['Revision round poster'],
      clientId, autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;

  // Create a Canva binding so design-outcome produces an in_review revision
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

  return { requestId, taskId, revisionId: designed.revisionId!, chatId };
}

/**
 * Office marks "revision_requested": in_review(expectedRev) → manual(expectedRev+1).
 */
async function officeRevise(requestId: string, taskId: string, revisionId: string, expectedRev: number) {
  const actionId = randomUUID();
  const rev = expectedRev + 1;
  const result = await projectLifecycleOfficeDecision(db, {
    requestId, tenantId, taskId, revisionId, actionId,
    actor: { userId, role: 'art_director' },
    reason: 'Align the logo colour to the brand palette',
    expectedRev, rev, key: `${requestId}:${rev}:officeDecision:desk:${actionId}`,
  });
  expect(result.stage).toBe('manual');
  expect(result.rev).toBe(rev);
  return result;
}

/**
 * Create a bare task that represents a new lifecycle-intaked revision round task.
 * The task just needs to exist with request_id=null and have an outbox_commands delivery row.
 */
async function intakeNewTask() {
  const newTaskId = randomUUID();
  await withRlsContext(db, scope, async (trx) => {
    await trx.insertInto('tasks').values({
      id: newTaskId, tenant_id: tenantId, title: 'Revision round task', state: 'received',
      client_id: clientId, delivery_executor_pin: 'restate',
      created_at: new Date(), updated_at: new Date(),
    }).execute();
    await trx.insertInto('outbox_commands').values({
      id: randomUUID(), tenant_id: tenantId, aggregate_id: newTaskId,
      aggregate_type: 'task', command_type: 'task.created',
      idempotency_key: `task.created:${newTaskId}`,
      payload: { lifecycleOwner: 'restate' },
      state: 'delivered', created_at: new Date(),
    }).execute();
  });
  return newTaskId;
}

describe('lifecycle revision round — /requester-revision route', () => {
  it('projects requester revision: manual(3) → designing(4), new task is claimed', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    await officeRevise(requestId, taskId, revisionId, 2);
    const newTaskId = await intakeNewTask();

    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Please use deep navy blue for the logo' }],
    });
    expect(result).toMatchObject({ status: 200, body: {
      v: 1, requestId, stage: 'designing', rev: 4,
      newTaskId, round: 1, runId: `dr-${newTaskId}`,
    } });

    // Verify DB: request at rev 4, designing, pointing at newTaskId
    const req = await withRlsContext(db, scope, async (trx) =>
      trx.selectFrom('requests').selectAll()
        .where('tenant_id', '=', tenantId).where('request_id', '=', requestId)
        .executeTakeFirstOrThrow());
    expect(Number(req.rev)).toBe(4);
    expect(req.stage).toBe('designing');
    expect(req.current_task_id).toBe(newTaskId);

    // Verify DB: new task is now owned by the request
    const newTask = await withRlsContext(db, scope, async (trx) =>
      trx.selectFrom('tasks').select('request_id')
        .where('tenant_id', '=', tenantId).where('id', '=', newTaskId).executeTakeFirstOrThrow());
    expect(newTask.request_id).toBe(requestId);
  });

  it('replays idempotently: second call returns same receipt', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    await officeRevise(requestId, taskId, revisionId, 2);
    const newTaskId = await intakeNewTask();

    const body = {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Navy blue logo please' }],
    };
    const first = await post(requestId, 'requester-revision', body);
    expect(first.status).toBe(200);
    const second = await post(requestId, 'requester-revision', body);
    expect(second).toEqual(first);
  });

  it('409 IDEMPOTENCY_CONFLICT on same key with different directive', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    await officeRevise(requestId, taskId, revisionId, 2);
    const newTaskId = await intakeNewTask();

    await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Original directive' }],
    });
    const changed = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Different directive — conflict' }],
    });
    expect(changed).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('400 on bad key (round mismatch in key vs ops)', async () => {
    const { requestId } = await reviewableRequest();
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4,
      key: `${requestId}:4:requesterRevision:r99`,  // key says round 99
      ops: [{ kind: 'requesterRevision', priorTaskId: randomUUID(), newTaskId: randomUUID(),
        round: 1, directive: 'Bad key round mismatch' }],
    });
    expect(result.status).toBe(400);
  });

  it('400 on expectedRev < 3 (requester revision only after office revise)', async () => {
    const { requestId } = await reviewableRequest();
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 1, rev: 2,
      key: `${requestId}:2:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: randomUUID(), newTaskId: randomUUID(),
        round: 1, directive: 'Too early' }],
    });
    expect(result.status).toBe(400);
  });

  it('409 STALE_REVISION when request is not at expectedRev', async () => {
    const { requestId, taskId } = await reviewableRequest();
    // Request is at rev 2 (in_review), not manual(3) — expectedRev 3 → STALE_REVISION
    const newTaskId = await intakeNewTask();
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'This should fail' }],
    });
    expect(result).toMatchObject({ status: 409, body: { code: 'STALE_REVISION' } });
  });

  it('second design-outcome at rev 5 succeeds after the revision round', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    await officeRevise(requestId, taskId, revisionId, 2);
    const newTaskId = await intakeNewTask();

    // Requester revision: manual(3) → designing(4)
    await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Navy blue logo' }],
    });

    // Create a Canva binding for the new task so design-outcome reaches in_review
    const newDesignId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId: newTaskId, clientId, canvaDesignId: newDesignId,
      editUrl: `https://www.canva.com/design/${newDesignId}/edit`,
    }, trx));

    const newRunId = `dr-${newTaskId}`;
    const outcome2 = await post(requestId, 'design-outcome', {
      v: 1, expectedRev: 4, rev: 5, key: `${requestId}:5:designFinished:${newRunId}`,
      ops: [{ kind: 'recordOutcome', taskId: newTaskId, runId: newRunId, report: {
        status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: newDesignId, notifyRequester: false,
      } }],
    });
    expect(outcome2).toMatchObject({ status: 200, body: {
      rev: 5, stage: 'in_review', taskId: newTaskId,
    } });
  });
});
