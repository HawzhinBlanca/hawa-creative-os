import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const token = ['worker', 'lifecycle', 'outcome', 'fixture'].join('_');
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

async function post(requestId: string, path: string, body: unknown, bearer = token) {
  const res = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

async function opened() {
  const requestId = randomUUID();
  const chat = String(73_000_000 + Math.floor(Math.random() * 9_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = chat;
  const start = await post(requestId, 'project', {
    v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    ops: [{ kind: 'createRequest', draft: { platform: 'telegram',
      sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
      rawText: 'Autumn workshop poster', title: 'Autumn workshop poster',
      designInstructions: 'Use the exact copy', exactCopy: ['Autumn workshop poster'],
      clientId, autoGenerate: true, designStudio: false,
      variant: { width: 1080, height: 1350 },
    } }],
  });
  expect(start).toMatchObject({ status: 200, body: { v: 1, requestId, stage: 'designing', autoGenerate: true,
    design: { clientId, designStudio: false, variant: { width: 1080, height: 1350 } } } });
  return { requestId, taskId: start.body.taskId as string };
}

function outcome(requestId: string, taskId: string, report: Record<string, unknown>) {
  const runId = `dr-${taskId}`;
  return { v: 1, expectedRev: 1, rev: 2,
    key: `${requestId}:2:designFinished:${runId}`,
    ops: [{ kind: 'recordOutcome', taskId, runId, report }],
  };
}

describe('versioned lifecycle design outcome', () => {
  it('commits a failed run, task event and one hash-bound receipt before returning the message', async () => {
    const { requestId, taskId } = await opened();
    process.env.TELEGRAM_ALLOWED_USERS = '88880001';
    const body = outcome(requestId, taskId, { status: 'DESIGN_REJECTED', code: 'COPY_REQUIRED' });
    expect((await post(requestId, 'design-outcome', body, 'wrong-token')).status).toBe(401);
    const first = await post(requestId, 'design-outcome', body);
    expect(first).toMatchObject({ status: 200, body: { v: 1, requestId, taskId, rev: 2,
      stage: 'manual', status: 'DESIGN_REJECTED', message: { parseMode: 'HTML' } } });
    // ADR-145 (#16, #22): the requester is asked for the words in plain language, without the task
    // id; the office's alert names the task.
    expect(first.body.message.text).not.toContain(taskId);
    expect(first.body.message.text).toContain('What text should go on');
    expect(first.body.officeAlert).toMatchObject({ chatId: '88880001' });
    // ADR-233: by its short id on the Desk search line, in plain words, with no code.
    expect(first.body.officeAlert.text.endsWith(`\nDesk search: ${taskId.slice(0, 8)}`)).toBe(true);
    expect(first.body.officeAlert.text).not.toContain('COPY_REQUIRED');
    const replay = await post(requestId, 'design-outcome', body);
    expect(replay).toEqual(first);
    const changed = structuredClone(body);
    changed.ops[0].report.code = 'OTHER';
    expect(await post(requestId, 'design-outcome', changed)).toMatchObject({
      status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['rev', 'stage']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state', 'request_id']).where('id', '=', taskId).executeTakeFirst(),
      receipts: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
      events: await trx.selectFrom('task_events').select('event_type').where('task_id', '=', taskId).execute(),
    }));
    expect(rows.request).toMatchObject({ rev: '2', stage: 'manual' });
    expect(rows.task).toMatchObject({ state: 'failed_operator', request_id: requestId });
    expect(rows.receipts.map((r) => Number(r.rev)).sort()).toEqual([1, 2]);
    expect(rows.events.some((e) => e.event_type === 'task.state_changed')).toBe(true);
  });

  it('does not ask a question from a report without a matching persisted Studio question', async () => {
    const { requestId, taskId } = await opened();
    const result = await post(requestId, 'design-outcome', outcome(requestId, taskId,
      { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId: randomUUID() }));
    expect(result).toMatchObject({ status: 200, body: { stage: 'manual', rev: 2 } });
    expect(result.body.question).toBeUndefined();
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select('stage').where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirst(),
    }));
    expect(rows.request?.stage).toBe('manual');
    expect(rows.task?.state).toBe('failed_operator');
  });

  it('creates a Desk revision for a bound design in the same projection', async () => {
    const { requestId, taskId } = await opened();
    const unbound = await post(requestId, 'design-outcome', outcome(requestId, taskId,
      { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA12345678' }));
    expect(unbound).toMatchObject({ status: 409, body: { code: 'UNVERIFIED_DESIGN' } });
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId, clientId, canvaDesignId: 'DA12345678',
      editUrl: 'https://www.canva.com/design/DA12345678/edit',
    }, trx));
    const result = await post(requestId, 'design-outcome', outcome(requestId, taskId,
      { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DA12345678' }));
    expect(result).toMatchObject({ status: 200, body: { stage: 'in_review', rev: 2,
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } });
    expect(result.body.revisionId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state', 'current_design_revision_id']).where('id', '=', taskId).executeTakeFirst(),
    }));
    expect(rows.request).toMatchObject({ stage: 'in_review', rev: '2' });
    expect(rows.task).toMatchObject({ state: 'human_review', current_design_revision_id: result.body.revisionId });
  });

  it('persists the exact review link and replays it across a changed deployment URL', async () => {
    const { requestId, taskId } = await opened();
    const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, trx => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId, clientId, canvaDesignId: designId, editUrl: `https://www.canva.com/design/${designId}/edit`,
    }, trx));
    vi.stubEnv('PUBLIC_TUNNEL_URL', 'https://desk.example.test');
    try {
      process.env.TELEGRAM_ALLOWED_USERS = '940001111';
      const payload = outcome(requestId, taskId, { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId,
        reviewUrl: 'https://outside.test/forged' });
      const first = await post(requestId, 'design-outcome', payload);
      expect(first.status).toBe(200);
      // ADR-145 (#16): the review link is the office's alone; the requester's message carries none.
      expect(first.body.message.text).not.toMatch(/desk\.example\.test|outside\.test|canva\.com/);
      expect(first.body.officeAlert).toMatchObject({ chatId: '940001111' });
      expect(first.body.officeAlert.text).toContain(`https://desk.example.test/#/work?task=${taskId}&revision=${first.body.revisionId}`);
      vi.stubEnv('PUBLIC_TUNNEL_URL', 'https://changed.example.test');
      expect(await post(requestId, 'design-outcome', payload)).toEqual(first);
    } finally { vi.unstubAllEnvs(); }
  });

  it('records one versioned office revision request on the current draft and replays its receipt', async () => {
    const { requestId, taskId } = await opened();
    const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId, clientId, canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit`,
    }, trx));
    const designed = await post(requestId, 'design-outcome', outcome(requestId, taskId,
      { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId }));
    expect(designed.status).toBe(200);
    const revisionId = designed.body.revisionId as string;
    const before = await withRlsContext(db, scope, (trx) => trx.selectFrom('tasks')
      .select('version').where('id', '=', taskId).executeTakeFirstOrThrow());
    const actionId = randomUUID();
    const decision = { v: 1, expectedRev: 2, rev: 3,
      key: `${requestId}:3:officeDecision:desk:${actionId}`,
      ops: [{ kind: 'recordOfficeRevision', taskId, revisionId, actionId,
        actor: { userId: scope.userId, role: 'art_director' }, reason: 'Correct the venue before approval' }],
    };
    expect((await post(requestId, 'office-decision', decision, 'wrong-token')).status).toBe(401);
    expect(await post(requestId, 'office-decision', { ...decision,
      ops: [{ ...decision.ops[0], revisionId: randomUUID() }] })).toMatchObject({
      status: 409, body: { code: 'NOT_CURRENT_DRAFT' },
    });
    expect(await post(requestId, 'office-decision', { ...decision,
      ops: [{ ...decision.ops[0], actor: { ...decision.ops[0].actor, role: 'operator' } }] })).toMatchObject({
      status: 409, body: { code: 'UNAUTHORIZED_ACTOR' },
    });
    const [first, simultaneous] = await Promise.all([
      post(requestId, 'office-decision', decision), post(requestId, 'office-decision', decision),
    ]);
    expect(first).toMatchObject({ status: 200, body: { v: 1, requestId, taskId, revisionId,
      rev: 3, stage: 'manual', actionId, approvalId: expect.any(String) } });
    expect(simultaneous).toEqual(first);
    expect(await post(requestId, 'office-decision', decision)).toEqual(first);
    const changed = structuredClone(decision);
    changed.ops[0].reason = 'Different decision';
    expect(await post(requestId, 'office-decision', changed)).toMatchObject({
      status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['rev', 'stage']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state', 'version']).where('id', '=', taskId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select(['id', 'nonce', 'decision', 'decided_by', 'qc_run_id'])
        .where('task_id', '=', taskId).execute(),
      qcRuns: await trx.selectFrom('qc_runs').select(['id', 'status']).where('task_id', '=', taskId)
        .where('design_revision_id', '=', revisionId).execute(),
      receipts: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
    }));
    expect(rows.request).toMatchObject({ rev: '3', stage: 'manual' });
    expect(rows.task).toMatchObject({ state: 'revision_requested', version: String(Number(before.version) + 1) });
    expect(rows.qcRuns).toEqual([expect.objectContaining({ id: expect.any(String), status: 'failed' })]);
    expect(rows.approvals).toEqual([expect.objectContaining({ id: first.body.approvalId,
      nonce: `desk:${actionId}`, decision: 'revision_requested', decided_by: scope.userId,
      qc_run_id: rows.qcRuns[0]?.id })]);
    expect(rows.receipts.map((r) => Number(r.rev)).sort()).toEqual([1, 2, 3]);
  });

  it('atomically rejects the current draft with a category and refuses changed or stale retries', async () => {
    const { requestId, taskId } = await opened();
    const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId, clientId, canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit`,
    }, trx));
    const designed = await post(requestId, 'design-outcome', outcome(requestId, taskId,
      { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId }));
    expect(designed.status).toBe(200);
    const revisionId = designed.body.revisionId as string;
    const actionId = randomUUID();
    const decision = { v: 1, expectedRev: 2, rev: 3,
      key: `${requestId}:3:officeDecision:desk:${actionId}`,
      ops: [{ kind: 'recordOfficeRejection', taskId, revisionId, actionId,
        actor: { userId: scope.userId, role: 'art_director' },
        reason: 'Concept does not meet the brief', rejectionCategory: 'concept' }],
    };
    expect((await post(requestId, 'office-decision', { ...decision, ops: [{ ...decision.ops[0],
      rejectionCategory: 'other' }] })).status).toBe(400);
    expect(await post(requestId, 'office-decision', { ...decision, ops: [{ ...decision.ops[0],
      actor: { userId: scope.userId, role: 'operator' } }] })).toMatchObject({
      status: 409, body: { code: 'UNAUTHORIZED_ACTOR' },
    });
    const [first, concurrent] = await Promise.all([
      post(requestId, 'office-decision', decision), post(requestId, 'office-decision', decision),
    ]);
    expect(first).toMatchObject({ status: 200, body: { stage: 'rejected', rev: 3,
      taskState: 'rejected', approvalId: expect.any(String) } });
    expect(concurrent).toEqual(first);
    expect(await post(requestId, 'office-decision', decision)).toEqual(first);
    expect(await post(requestId, 'office-decision', { ...decision, ops: [{ ...decision.ops[0],
      reason: 'A different decision' }] })).toMatchObject({
      status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      revision:await trx.selectFrom('design_revisions').select('source_sha256').where('tenant_id','=',tenantId).where('task_id','=',taskId).where('id','=',revisionId).executeTakeFirstOrThrow(),
      request: await trx.selectFrom('requests').select(['rev', 'stage']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state']).where('id', '=', taskId).executeTakeFirst(),
      approval: await trx.selectFrom('approvals').select(['decision', 'reason', 'decision_payload'])
        .where('task_id', '=', taskId).executeTakeFirst(),
      events: await trx.selectFrom('task_events').select(['event_type'])
        .where('task_id', '=', taskId).where('event_type', '=', 'design.rejected').execute(),
      feedback: await trx.selectFrom('feedback_events').select(['category', 'actor_id', 'target'])
        .where('task_id', '=', taskId).execute(),
    }));
    expect(rows.request).toMatchObject({ rev: '3', stage: 'rejected' });
    expect(rows.task).toMatchObject({ state: 'rejected' });
    expect(rows.approval).toMatchObject({ decision: 'rejected', reason: decision.ops[0].reason,
      decision_payload: { rejectionCategory: 'concept' } });
    expect(rows.events).toHaveLength(1);
    expect(rows.feedback).toEqual([expect.objectContaining({ category: 'rejection.concept',
      actor_id: scope.userId, target: {kind:'revision_decision_v1',sourceSha256:rows.revision.source_sha256, approvalId: first.body.approvalId,
        decision: 'rejected', revisionId, rejectionCategory: 'concept' } })]);
  });
});
