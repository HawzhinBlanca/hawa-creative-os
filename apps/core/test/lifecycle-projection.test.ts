import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import type { LifecycleEvent, LifecycleStateV1, ProjectionOp, ProjectionRequest, ProjectionResponse } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { apply, plan, projectionRequestFor, requestIdFor } from '@hawa/domain';
import { createApp } from '../src/app.js';

/**
 * Core's projection endpoint for the request lifecycle (architecture programme Phase 2, slice 2.3;
 * PHASE2_DESIGN.md 2.8): POST /v1/internal/lifecycle/:requestId/project is the only writer of a
 * lifecycle-owned request's rows. One transaction per projection, under the request's lock: the same
 * key is answered from its record, a projection at the wrong revision is refused (409 AHEAD when
 * Postgres is ahead of the object, STALE_REVISION when behind), and the ops run under the tenant the
 * object names, with row-level security. GET /v1/internal/lifecycle/:requestId reads it back.
 *
 * The app runs on this file's own database as the application role, so row-level security applies.
 */
const url = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-a000-000000000005';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const WORKER = ['worker', 'projection', 'token'].join('_');

describe.skipIf(!url)('POST /v1/internal/lifecycle/:requestId/project', () => {
  const db = createDb(url || 'postgres://localhost/hawa_test');
  const bridge = {
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    downloadFile: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  let app: ReturnType<typeof createApp>;
  afterAll(() => db.destroy());
  beforeEach(() => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    app = createApp({ db, telegramBridge: bridge as never });
  });
  afterEach(() => vi.unstubAllEnvs());

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
  const project = (requestId: string, body: unknown, headers: Record<string, string> = auth) =>
    app.request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST', headers, body: JSON.stringify(body) });
  const read = (requestId: string, tenantId = TENANT, headers: Record<string, string> = auth) =>
    app.request(`/v1/internal/lifecycle/${requestId}?tenantId=${tenantId}`, { headers });

  let chatSeq = 0;
  const newChat = () => String(9_310_000 + Math.floor(Math.random() * 80_000) + ++chatSeq);
  const openEvent = (chat: string, updateId = 700_001, draft: Record<string, unknown> = {}): Extract<LifecycleEvent, { type: 'open' }> => {
    const requestId = requestIdFor(chat, updateId, 0);
    return {
      type: 'open', v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: chat,
      origin: { kind: 'telegram', chatId: chat, updateId },
      draft: { title: 'Staff meeting', rawText: `Staff meeting ${randomUUID()}`, clientId: KAAE, designInstructions: 'Formal', exactCopy: [], autoGenerate: true, ...draft },
    };
  };
  /** The domain's own plan for the event, as the worker's shell builds it. */
  const planned = (s: LifecycleStateV1 | undefined, ev: LifecycleEvent): ProjectionRequest => {
    const p = plan(s, ev, Date.now());
    if (p.ignored) throw new Error(`plan ignored ${ev.type}: ${p.reason}`);
    return projectionRequestFor(s, ev, p);
  };
  const opened = async (chat = newChat(), draft: Record<string, unknown> = {}) => {
    const ev = openEvent(chat, 700_001, draft);
    const body = planned(undefined, ev);
    const res = await project(ev.requestId, body);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const answer = (await res.json()) as ProjectionResponse;
    const applied = apply(undefined, ev, answer, Date.now());
    if (applied.ignored) throw new Error('ignored');
    return { ev, body, answer, state: applied.next, chat };
  };
  const asOwner = <T>(fn: (trx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>) =>
    withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);

  it('opens a request: its round-0 task with a recorded task.created row, the request row owned by restate, the projection record', async () => {
    const { ev, answer } = await opened();
    expect(answer).toMatchObject({ v: 1, status: 'applied', rev: 1, stage: 'designing' });
    const [created] = answer.results;
    expect(created).toMatchObject({ op: 'createRequest', autoGenerate: true, stage: 'designing' });
    // The requester's acknowledgement is composed here (part C), to be sent by TelegramSender.
    expect((created as { messages: unknown[] }).messages).toEqual([expect.objectContaining({ key: `${ev.requestId}:1:ack`, chatId: ev.chatId, kind: 'text', class: 'courtesy' })]);
    const taskId = (created as { taskId: string }).taskId;
    const rows = await asOwner(async (trx) => ({
      request: (await sql<{ owner: string; stage: string; rev: string; root_task_id: string; current_task_id: string; chat_id: string }>`
        SELECT owner, stage, rev::text, root_task_id::text, current_task_id::text, chat_id FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows,
      task: (await sql<{ request_id: string; client_id: string }>`SELECT request_id::text, client_id::text FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows,
      outbox: (await sql<{ state: string; last_error: string; key: string; owner: string }>`
        SELECT state, last_error, idempotency_key AS key, payload->>'lifecycleOwner' AS owner FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'task.created'`.execute(trx)).rows,
      projections: (await sql<{ rev: string; idempotency_key: string }>`SELECT rev::text, idempotency_key FROM hawa.lifecycle_projections WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows,
    }));
    expect(rows.request).toEqual([{ owner: 'restate', stage: 'designing', rev: '1', root_task_id: taskId, current_task_id: taskId, chat_id: ev.chatId }]);
    expect(rows.task).toEqual([{ request_id: ev.requestId, client_id: KAAE }]);
    expect(rows.outbox).toEqual([{ state: 'delivered', last_error: 'OWNED_BY_LIFECYCLE', key: `chat:telegram:${ev.chatId}:lc-${ev.requestId}-r0`, owner: 'restate' }]);
    expect(rows.projections).toEqual([{ rev: '1', idempotency_key: `${ev.requestId}:1:open` }]);
  });

  it('the same projection asked again is answered from its record, and writes nothing twice', async () => {
    const { ev, body, answer } = await opened();
    const again = await project(ev.requestId, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...answer, status: 'replayed' });
    const counts = await asOwner(async (trx) => (await sql<{ tasks: number; projections: number }>`
      SELECT (SELECT count(*) FROM hawa.tasks WHERE request_id = ${ev.requestId}::uuid)::int AS tasks,
             (SELECT count(*) FROM hawa.lifecycle_projections WHERE request_id = ${ev.requestId}::uuid)::int AS projections`.execute(trx)).rows[0]);
    expect(counts).toEqual({ tasks: 1, projections: 1 });
  });

  it('two copies of one projection at once: one applies, the other is its replay', async () => {
    const ev = openEvent(newChat());
    const body = planned(undefined, ev);
    const [a, b] = await Promise.all([project(ev.requestId, body), project(ev.requestId, body)]);
    const statuses = [(await a.json()).status, (await b.json()).status].sort();
    expect(statuses).toEqual(['applied', 'replayed']);
  });

  it('the same key with other ops is refused (409 KEY_REUSED)', async () => {
    const { ev, body } = await opened();
    const res = await project(ev.requestId, { ...body, ops: [{ ...(body.ops[0] as object), draft: { ...(body.ops[0] as { draft: object }).draft, title: 'Another title' } }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'KEY_REUSED', pgRev: 1 });
  });

  it('a projection behind Postgres is refused 409 AHEAD with Postgres\'s revision (the object was restored)', async () => {
    const { ev, state } = await opened();
    // The object moved on (rev 2 in Postgres), then was restored to rev 1 and meets another event.
    const cancel: LifecycleEvent = { type: 'cancel', v: 1, eventId: 'cancel-1', by: 'office' };
    const first = await project(ev.requestId, planned(state, cancel));
    expect(first.status).toBe(200);
    const other: LifecycleEvent = { type: 'cancel', v: 1, eventId: 'cancel-2', by: 'requester', reason: 'restored' };
    const body = { ...planned(state, other), key: `${ev.requestId}:2:cancel-again` };
    const res = await project(ev.requestId, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AHEAD', pgRev: 2, expectedRev: 1, rev: 2 });
  });

  it('a projection ahead of Postgres is refused 409 STALE_REVISION (only a second writer or a restored Postgres explains it)', async () => {
    const { ev, state } = await opened();
    const cancel: LifecycleEvent = { type: 'cancel', v: 1, eventId: 'cancel-x', by: 'office' };
    const body = planned({ ...state, rev: 4 }, cancel);
    const res = await project(ev.requestId, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STALE_REVISION', pgRev: 1, expectedRev: 4, rev: 5 });
    const row = await asOwner(async (trx) => (await sql<{ rev: string; stage: string }>`SELECT rev::text, stage FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0]);
    expect(row).toEqual({ rev: '1', stage: 'designing' });
  });

  it('moves the request and its task in one transaction', async () => {
    const { ev, state } = await opened();
    const ops: ProjectionOp[] = [{ op: 'transition', taskId: state.rounds[0].taskId, toState: 'paused', reason: 'waiting' }];
    const res = await project(ev.requestId, { v: 1, expectedRev: 1, rev: 2, key: `${ev.requestId}:2:officeDecision`, tenantId: TENANT, stage: 'manual', ops });
    const answer = (await res.json()) as ProjectionResponse;
    expect(answer).toMatchObject({ status: 'applied', rev: 2, stage: 'manual' });
    expect(answer.results[0]).toMatchObject({ op: 'transition', changed: true, fromState: 'received', toState: 'paused', version: 2 });
    const rows = await asOwner(async (trx) => (await sql<{ state: string; stage: string; rev: string }>`
      SELECT t.state::text, r.stage, r.rev::text FROM hawa.requests r JOIN hawa.tasks t ON t.id = r.root_task_id WHERE r.request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0]);
    expect(rows).toEqual({ state: 'paused', stage: 'manual', rev: '2' });
  });

  it('cancel while designing: the request is cancelled; the task keeps a state its vocabulary cannot leave for CANCELLED', async () => {
    const { ev, state } = await opened();
    const cancel: LifecycleEvent = { type: 'cancel', v: 1, eventId: 'cancel-3', by: 'office' };
    const res = await project(ev.requestId, planned(state, cancel));
    const answer = (await res.json()) as ProjectionResponse;
    expect(answer).toMatchObject({ status: 'applied', rev: 2, stage: 'cancelled' });
    // RECEIVED → CANCELLED is not a move of the one vocabulary (packages/contracts task-status.ts).
    expect(answer.results[0]).toMatchObject({ op: 'transition', changed: false, fromState: 'received', toState: 'received' });
    // Without ifIllegal: 'keep' the same move is refused, and nothing is written.
    const refused = await project(ev.requestId, { v: 1, expectedRev: 2, rev: 3, key: `${ev.requestId}:3:x`, tenantId: TENANT, ops: [{ op: 'transition', taskId: state.rounds[0].taskId, toState: 'complete', reason: 'no' }] });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('an op that fails rolls the whole projection back: nothing written, the revision unchanged', async () => {
    const { ev, state } = await opened();
    const ops: ProjectionOp[] = [
      { op: 'transition', taskId: state.rounds[0].taskId, toState: 'paused', reason: 'first op' },
      { op: 'transition', taskId: randomUUID(), toState: 'cancelled', reason: 'a task of no request' },
    ];
    const res = await project(ev.requestId, { v: 1, expectedRev: 1, rev: 2, key: `${ev.requestId}:2:cancel`, tenantId: TENANT, stage: 'manual', ops });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'NOT_IN_REQUEST' });
    const rows = await asOwner(async (trx) => (await sql<{ state: string; rev: string; n: number }>`
      SELECT t.state::text, r.rev::text, (SELECT count(*) FROM hawa.lifecycle_projections p WHERE p.request_id = r.request_id)::int AS n
      FROM hawa.requests r JOIN hawa.tasks t ON t.id = r.root_task_id WHERE r.request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0]);
    expect(rows).toEqual({ state: 'received', rev: '1', n: 1 });
  });

  it('a request opened without a client, or over the daily cap, is the office\'s (stage manual)', async () => {
    const { answer } = await opened(newChat(), { clientId: null });
    expect(answer.stage).toBe('manual');
    // Saved as the legacy path saves it: not an automatic draft, so it does not count against the
    // sender's daily allowance (review of 2.3C).
    expect(answer.results[0]).toMatchObject({ autoGenerate: false, stage: 'manual' });
  });

  it('refuses what it cannot do instead of guessing: an office decision it cannot record, photos, a reference image', async () => {
    const { ev, state } = await opened();
    // Slice 2.4 brought the office's ops: one without the Desk's action id, or on a revision the task
    // does not have, is refused and nothing is written.
    const approval = (actionId: string) => ({ v: 1 as const, expectedRev: 1, rev: 2, key: `${ev.requestId}:2:officeDecision`, tenantId: TENANT, ops: [{ op: 'recordApproval' as const, taskId: state.rounds[0].taskId, revisionId: randomUUID(), actionId, actor: { userId: 'u', role: 'operator' } }] });
    const noAction = await project(ev.requestId, approval('a-1'));
    expect(noAction.status).toBe(422);
    expect(await noAction.json()).toMatchObject({ code: 'INVALID_OP' });
    const noRevision = await project(ev.requestId, approval(randomUUID()));
    expect(noRevision.status).toBe(422);
    expect(await noRevision.json()).toMatchObject({ code: 'DECISION_REFUSED' });
    const photos = openEvent(newChat(), 700_001, { photoFileIds: ['AgAC-file'] });
    expect((await project(photos.requestId, planned(undefined, photos))).status).toBe(422);
    const reference = openEvent(newChat(), 700_001, { studioOptions: { referenceImageBase64: 'iVBORw0KGgo=' } });
    const refused = await project(reference.requestId, planned(undefined, reference));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'INVALID_DRAFT' });
  });

  it('refuses an open whose origin is not the chat it names or a size of its parent request', async () => {
    const chat = newChat();
    const ev = openEvent(chat);
    const body = planned(undefined, ev);
    const withOrigin = (origin: unknown) => ({ ...body, ops: [{ ...(body.ops[0] as object), origin }] });
    for (const origin of [
      undefined,
      'telegram',
      { kind: 'email', chatId: chat, updateId: 1 },
      { kind: 'telegram', chatId: '999', updateId: 1 },
      { kind: 'telegram', chatId: chat, updateId: -1 },
      { kind: 'telegram', chatId: chat, updateId: '1' },
      { kind: 'size', parentRequestId: randomUUID(), action: 'sst' },
    ]) {
      const res = await project(ev.requestId, withOrigin(origin));
      expect(res.status, JSON.stringify(origin)).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'INVALID_OP' });
    }
    expect((await read(ev.requestId)).status).toBe(404);
  });

  it('refuses a malformed projection: a key that is not <requestId>:<rev>:…, a revision that is not expectedRev + 1, an unknown op', async () => {
    const ev = openEvent(newChat());
    const body = planned(undefined, ev);
    expect((await project(ev.requestId, { ...body, key: 'someone-else:1:open' })).status).toBe(422);
    expect((await project(ev.requestId, { ...body, rev: 3 })).status).toBe(422);
    expect((await project(ev.requestId, { ...body, ops: [{ op: 'dropEverything' }] })).status).toBe(422);
    expect((await project(ev.requestId, { ...body, tenantId: 'not-a-uuid' })).status).toBe(422);
    expect((await project('not-a-uuid', body)).status).toBe(422);
  });

  it('a request of one tenant is invisible to a projection under another: not found, never changed', async () => {
    const { ev, state } = await opened();
    const cancel: LifecycleEvent = { type: 'cancel', v: 1, eventId: 'cancel-t', by: 'office' };
    const res = await project(ev.requestId, { ...planned({ ...state, rev: 0 }, cancel), tenantId: OTHER_TENANT, key: `${ev.requestId}:1:cancel` });
    expect(res.status).toBe(404);
    expect((await read(ev.requestId, OTHER_TENANT)).status).toBe(404);
    // Opening the same request id again under the other tenant cannot take it over either.
    // The first tenant's client is not the other tenant's (its tasks refuse it) …
    expect((await project(ev.requestId, { ...planned(undefined, ev), tenantId: OTHER_TENANT })).status).toBe(422);
    // … and without a client, the request id is taken where the other tenant cannot see it.
    const clientless = { ...ev, tenantId: OTHER_TENANT, draft: { ...ev.draft, clientId: null } };
    const taken = await project(ev.requestId, { ...planned(undefined, clientless), tenantId: OTHER_TENANT });
    expect([403, 409], JSON.stringify(await taken.clone().json())).toContain(taken.status);
    const row = await asOwner(async (trx) => (await sql<{ rev: string; stage: string }>`SELECT rev::text, stage FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0]);
    expect(row).toEqual({ rev: '1', stage: 'designing' });
  });

  it('GET reads the request back as Postgres has it, for reconciliation', async () => {
    const { ev, state } = await opened();
    const res = await read(ev.requestId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      v: 1, requestId: ev.requestId, tenantId: TENANT, owner: 'restate', stage: 'designing', rev: 1,
      rootTaskId: state.rounds[0].taskId, currentTaskId: state.rounds[0].taskId, parentRequestId: null, chatId: ev.chatId,
      tasks: [{ id: state.rounds[0].taskId, state: 'received', version: 1 }],
      lastProjection: { rev: 1, key: `${ev.requestId}:1:open` },
    });
    expect((await read(randomUUID())).status).toBe(404);
    expect((await app.request(`/v1/internal/lifecycle/${ev.requestId}`, { headers: auth })).status).toBe(422);
  });

  it('takes the worker\'s credential only', async () => {
    const ev = openEvent(newChat());
    const body = planned(undefined, ev);
    for (const token of ['test_bearer', 'test_admin_key', 'nonsense']) {
      expect((await project(ev.requestId, body, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await read(ev.requestId, TENANT, { Authorization: `Bearer ${token}` })).status).toBe(401);
    }
    expect((await project(ev.requestId, body, { 'Content-Type': 'application/json' })).status).toBe(401);
    const row = await asOwner(async (trx) => (await sql`SELECT 1 FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows);
    expect(row).toEqual([]);
  });

  it('a change round and an answered question: a new round task in the request, the question task closed', async () => {
    const { ev, state } = await opened();
    const root = state.rounds[0].taskId;
    // The question task waits (paused), as the design outcome leaves it (recordOutcome lands later).
    await asOwner((trx) => sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${root}::uuid`.execute(trx));
    const ops: ProjectionOp[] = [
      { op: 'createRound', kind: 'answer', round: 1, parentTaskId: root, directive: 'Blue', answers: root, question: 'Which logo?', answer: { option: 1 } },
      { op: 'closeQuestion', taskId: root, questionId: 'q-1' },
    ];
    const res = await project(ev.requestId, { v: 1, expectedRev: 1, rev: 2, key: `${ev.requestId}:2:answer`, tenantId: TENANT, ops });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const answer = (await res.json()) as ProjectionResponse;
    expect(answer).toMatchObject({ stage: 'designing', results: [{ op: 'createRound', autoGenerate: true }, { op: 'closeQuestion', changed: true }] });
    const roundTask = (answer.results[0] as { taskId: string }).taskId;
    const rows = await asOwner(async (trx) => ({
      request: (await sql<{ current_task_id: string }>`SELECT current_task_id::text FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0],
      root: (await sql<{ state: string }>`SELECT state::text FROM hawa.tasks WHERE id = ${root}::uuid`.execute(trx)).rows[0],
      round: (await sql<{ request_id: string; options: Record<string, unknown> }>`
        SELECT t.request_id::text, o.payload->'studioOptions' AS options FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created' WHERE t.id = ${roundTask}::uuid`.execute(trx)).rows[0],
    }));
    expect(rows.request.current_task_id).toBe(roundTask);
    expect(rows.root.state).toBe('cancelled');
    expect(rows.round.request_id).toBe(ev.requestId);
    expect(rows.round.options).toMatchObject({ answers: root, clarified: true, revisionDirective: expect.stringContaining('Asked "Which logo?", the client answered: Blue') });

    // A change round to it: the directive and the round number, the parent named.
    const change = await project(ev.requestId, { v: 1, expectedRev: 2, rev: 3, key: `${ev.requestId}:3:requesterDecision`, tenantId: TENANT, ops: [{ op: 'createRound', kind: 'change', round: 2, parentTaskId: roundTask, directive: 'Make the logo bigger' }] });
    expect(change.status).toBe(200);
    const changeTask = ((await change.json()) as ProjectionResponse).results[0] as { taskId: string };
    const options = await asOwner(async (trx) => (await sql<{ options: Record<string, unknown> }>`
      SELECT payload->'studioOptions' AS options FROM hawa.outbox_commands WHERE aggregate_id = ${changeTask.taskId}::uuid AND command_type = 'task.created'`.execute(trx)).rows[0].options);
    expect(options).toMatchObject({ parentTaskId: roundTask, revisionDirective: 'Make the logo bigger' });
  });

  it('the legacy outcome report refuses a lifecycle-owned task (409 LIFECYCLE_OWNED) and changes nothing', async () => {
    const { state } = await opened();
    const taskId = state.rounds[0].taskId;
    const sendsBefore = bridge.dispatchOutboundMessage.mock.calls.length;
    const legacyAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
    for (const path of ['canva-status', 'canva-ready']) {
      const res = await app.request(`/v1/tasks/${taskId}/notifications/${path}`, {
        method: 'POST', headers: legacyAuth, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAGowned0001' }),
      });
      expect(res.status, path).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'LIFECYCLE_OWNED', requestId: state.requestId });
    }
    const rows = await asOwner(async (trx) => (await sql<{ state: string; notices: number }>`
      SELECT t.state::text, (SELECT count(*) FROM hawa.outbox_commands o WHERE o.aggregate_id = t.id AND o.command_type = 'notify.telegram')::int AS notices
      FROM hawa.tasks t WHERE t.id = ${taskId}::uuid`.execute(trx)).rows[0]);
    expect(rows).toEqual({ state: 'received', notices: 0 });
    expect(bridge.dispatchOutboundMessage.mock.calls.length).toBe(sendsBefore);
  });

  it('records a draft as sent the way legacy queries read it (a delivered notify.telegram row) and keeps the time', async () => {
    const { ev, state } = await opened();
    const taskId = state.rounds[0].taskId;
    const at = Date.parse('2026-09-24T09:30:00Z');
    const res = await project(ev.requestId, { v: 1, expectedRev: 1, rev: 2, key: `${ev.requestId}:2:messageSent`, tenantId: TENANT, ops: [{ op: 'recordDraftSent', taskId, key: `${ev.requestId}:1:msg:0`, at, messageId: '812' }] });
    expect(res.status).toBe(200);
    const rows = await asOwner(async (trx) => ({
      notify: (await sql<{ state: string; status: string; created_at: Date }>`
        SELECT state, payload->>'status' AS status, created_at FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.telegram'`.execute(trx)).rows,
      sentAt: (await sql<{ draft_sent_at: Date }>`SELECT draft_sent_at FROM hawa.requests WHERE request_id = ${ev.requestId}::uuid`.execute(trx)).rows[0].draft_sent_at,
    }));
    expect(rows.notify).toHaveLength(1);
    expect(rows.notify[0]).toMatchObject({ state: 'delivered', status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' });
    expect(new Date(rows.notify[0].created_at).getTime()).toBe(at);
    expect(new Date(rows.sentAt).getTime()).toBe(at);
  });
});
