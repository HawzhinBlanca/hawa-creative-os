/**
 * ADR-142: the office runs a request's automatic design again after it ended without a draft.
 *
 * Production task ba4469f2 (2026-09-29) failed at its layout for a reason on the office's side and
 * could not be started again by anyone: the legacy re-drive answered LIFECYCLE_OWNED and the request
 * object had no action for it. The whole chain is exercised here as the Desk drives it: the Desk's
 * re-drive of the task, the signed office event checked by the gateway, the request object's
 * officeRetry, Core's projection, and the DesignRun input it starts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { officeRetryActionId, projectLifecycleOfficeRetry } from '../src/services/lifecycle-office-retry.js';
import { checkSignedOfficeRetry } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { recordDesignFinished, recordOfficeRetry, type AutomaticLifecycleState, type AutomaticOpenContext,
  type LifecycleState } from '../../worker/src/lifecycle/request-lifecycle.js';
import { validDesignRun, type DesignRunInput } from '../../worker/src/lifecycle/design-run.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const secret = ['office', 'retry', 'gateway', 'fixture'].join('_');
const ingress = 'http://restate.retry-fixture:8080';
const saved = { token: process.env.HAWA_WORKER_TOKEN, ingress: process.env.RESTATE_INGRESS_URL, users: process.env.TELEGRAM_ALLOWED_USERS };

beforeAll(() => { process.env.HAWA_WORKER_TOKEN = secret; process.env.RESTATE_INGRESS_URL = ingress; });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const [k, v] of [['HAWA_WORKER_TOKEN', saved.token], ['RESTATE_INGRESS_URL', saved.ingress], ['TELEGRAM_ALLOWED_USERS', saved.users]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await db.destroy();
});

/** The owner's request as Core projected it, and the failed layout reported as production reported it. */
async function failedReportCover() {
  const requestId = randomUUID();
  const chatId = String(76_000_000 + Math.floor(Math.random() * 8_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = '88880002';
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'Design a professional report cover for KAAE using only the provided field-visit photos and the provided text.',
      title: 'KAAE: KAAE K-12 Pilot Study…', designInstructions: 'Design a professional report cover for KAAE.',
      exactCopy: ['KAAE K-12 Pilot Study', 'Field Visit Report', 'Insights from KAAE school field visits and next steps toward'],
      clientId, autoGenerate: true, designStudio: true },
  });
  const taskId = opened.taskId;
  const runId = `dr-${taskId}`;
  const failed = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2, key: `${requestId}:2:designFinished:${runId}`,
    report: { status: 'DESIGN_FAILED', code: 'STUDIO_RUN_LIMIT_TOO_SMALL', runId: randomUUID(),
      detail: 'STUDIO_RUN_LIMIT_TOO_SMALL at stage laying_out: the next model request needs a $2.13 advance reservation' },
  });
  expect(failed).toMatchObject({ stage: 'manual', status: 'DESIGN_FAILED' });
  // The requester heard, in plain words, that the office is on it and nothing needs sending again.
  expect(failed.message?.text).toBe("<b>KAAE K-12 Pilot Study…</b> needs a little more time. The office is on it and will send your draft here; you don't need to send anything again.");
  expect(failed.officeAlert?.text).toContain('STUDIO_RUN_LIMIT_TOO_SMALL');
  const designInput: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId,
    rawText: 'Design a professional report cover', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`,
    canvaAutoGenerate: true, designStudio: true };
  const state: AutomaticLifecycleState = { v: 1, requestId, tenantId, chatId, owner: 'restate', stage: 'manual', rev: 2, taskId,
    openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), runId, designInput,
    outcome: { eventId: `dr-finished:${runId}`, sha256: 'b'.repeat(64), status: 'DESIGN_FAILED' } };
  return { requestId, taskId, chatId, state };
}

/** The request object, in memory, with Core reached through its own internal routes. */
function requestObject(initial: LifecycleState) {
  let state: LifecycleState | null = initial;
  const started: DesignRunInput[] = [];
  const app = createApp({ db } as any);
  const core = { post: async <T>(path: string, body: unknown): Promise<T> => {
    const res = await app.request(`/v1${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Core ${res.status}: ${JSON.stringify(json)}`), { status: res.status, body: json });
    return json as T;
  } };
  const ctx: AutomaticOpenContext = {
    key: initial.requestId, get: async () => state, run: async (_n, action) => action(),
    set: (_n, value) => { state = value; }, send: () => { throw new Error('no requester message expected'); },
    startDesign: (input) => { started.push(input); },
  };
  return { ctx, core: core as any, started, state: () => state as AutomaticLifecycleState };
}

/** Restate's ingress as the office gateway answers it: the signature checked, then the request object. */
function gateway(object: ReturnType<typeof requestObject>) {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`${ingress}/OfficeDecisionGateway/retryDesign`);
    const input = JSON.parse(String(init.body));
    calls.push(input);
    const verdict = checkSignedOfficeRetry(input, secret);
    if (verdict !== 'ok') return new Response(JSON.stringify({ message: verdict }), { status: verdict === 'invalid' ? 400 : 401 });
    try {
      const reply = await recordOfficeRetry(object.ctx, object.core, input.event);
      return new Response(JSON.stringify(reply), { status: 200 });
    } catch (error: any) {
      // Core's 4xx is a terminal error of the handler: Restate's ingress answers it with that status.
      if (error?.status >= 400 && error.status < 500) return new Response(JSON.stringify({ message: error.message }), { status: error.status });
      throw error;
    }
  }));
  return calls;
}

const desk = (taskId: string, bearer = 'test_bearer', body: unknown = { reason: 'Run limit fixed in ADR-142; retry the report cover.' }) =>
  createApp({ db, extraBearerTokens: { designer_fixture_token: 'designer' } } as any).request(`/v1/tasks/${taskId}/redrive`, { method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const rows = (requestId: string, taskId: string) => withRlsContext(db, scope, async (trx) => ({
  request: await trx.selectFrom('requests').select(['rev', 'stage']).where('request_id', '=', requestId).executeTakeFirstOrThrow(),
  task: await trx.selectFrom('tasks').select(['state']).where('id', '=', taskId).executeTakeFirstOrThrow(),
}));

describe('the office retries a request whose automatic design ended without a draft (ADR-142)', () => {
  it('the Desk\'s re-drive of the failed task designs the same task again under an attempt run; a second click is the same retry', async () => {
    const { requestId, taskId, state } = await failedReportCover();
    const object = requestObject(state);
    const calls = gateway(object);
    const res = await desk(taskId);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ requestId, taskId, rev: 3, stage: 'designing', attempt: 1, runId: `dr-${taskId}-a1`,
      actionId: officeRetryActionId(requestId, 2), replayed: false });
    // One signed event, attributed to the office operator who pressed the button.
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).event).toMatchObject({ kind: 'retry', expectedRev: 2, taskId,
      actor: { userId: scope.userId, role: 'operator' }, reason: 'Run limit fixed in ADR-142; retry the report cover.' });
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '3', stage: 'designing' }, task: { state: 'received' } });
    // The request object starts the same task's design again, under a key its workflow admits.
    expect(object.started).toHaveLength(1);
    const input = object.started[0];
    expect(input).toMatchObject({ taskId, redriveAttempt: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}-a1` } });
    expect(validDesignRun(input, `dr-${taskId}-a1`)).toBe(true);
    expect(validDesignRun(input, `dr-${taskId}`)).toBe(false);
    expect(object.state()).toMatchObject({ stage: 'designing', rev: 3, runId: `dr-${taskId}-a1`, outcome: undefined });

    // A second click while it designs is the same retry: answered from its receipt, nothing restarted.
    const again = await desk(taskId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ runId: `dr-${taskId}-a1`, attempt: 1, replayed: true });
    expect(calls).toHaveLength(1);
    expect(object.started).toHaveLength(1);
  });

  it('the attempt\'s outcome is projected as the first one was; retries are counted and limited', async () => {
    const { requestId, taskId, state } = await failedReportCover();
    const object = requestObject(state);
    gateway(object);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await desk(taskId);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ attempt, runId: `dr-${taskId}-a${attempt}`, rev: 1 + 2 * attempt });
      // The attempt run reports back through the request object and Core's design-outcome route.
      const finished = await recordDesignFinished({ ...object.ctx, send: () => {} }, object.core, {
        v: 1, eventId: `dr-finished:dr-${taskId}-a${attempt}`, requestId, runId: `dr-${taskId}-a${attempt}`, round: 0, taskId,
        report: { status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED' } });
      expect(finished).toMatchObject({ ignored: false, stage: 'manual', rev: 2 + 2 * attempt });
      expect((await rows(requestId, taskId)).task.state).toBe('failed_operator');
    }
    const limited = await desk(taskId);
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({ title: 'RETRY_LIMIT_REACHED' });
    expect(object.started.map((i) => i.lifecycle.runId)).toEqual([1, 2, 3].map((n) => `dr-${taskId}-a${n}`));
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '8', stage: 'manual' }, task: { state: 'failed_operator' } });
  });

  it('refuses a retry the request is not waiting for, a role that may not spend, and a changed replay', async () => {
    const { requestId, taskId, state } = await failedReportCover();
    const object = requestObject(state);
    const calls = gateway(object);
    // A designer is not an office retry role.
    expect((await desk(taskId, 'designer_fixture_token')).status).toBe(403);
    const actor = { userId: scope.userId, role: 'operator' };
    const key = (rev: number, actionId: string) => `${requestId}:${rev}:officeRetry:desk:${actionId}`;
    const actionId = randomUUID();
    // Core refuses a service identity and an unknown role outright.
    await expect(projectLifecycleOfficeRetry(db, { requestId, tenantId, taskId, actionId, reason: 'r',
      actor: { userId: '00000000-0000-4000-b000-000000000011', role: 'operator' }, expectedRev: 2, rev: 3, key: key(3, actionId) }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED_ACTOR' });
    await projectLifecycleOfficeRetry(db, { requestId, tenantId, taskId, actionId, actor, reason: 'retry', expectedRev: 2, rev: 3, key: key(3, actionId) });
    await expect(projectLifecycleOfficeRetry(db, { requestId, tenantId, taskId, actionId, actor, reason: 'changed', expectedRev: 2, rev: 3, key: key(3, actionId) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // Designing now: nothing to retry, from the Desk or from Core.
    const other = randomUUID();
    await expect(projectLifecycleOfficeRetry(db, { requestId, tenantId, taskId, actionId: other, actor, reason: 'again', expectedRev: 3, rev: 4, key: key(4, other) }))
      .rejects.toMatchObject({ code: 'WRONG_STAGE' });
    expect(calls).toHaveLength(0);
  });

  it('the gateway admits only a well-formed retry signed with the worker credential', () => {
    const event = { v: 1 as const, kind: 'retry' as const, eventId: `desk:${randomUUID()}`, requestId: randomUUID(), taskId: randomUUID(),
      actionId: '', expectedRev: 2, actor: { userId: scope.userId, role: 'operator' }, reason: 'retry' };
    event.actionId = event.eventId.slice(5);
    expect(checkSignedOfficeRetry({ v: 1, event, signature: signLifecycleOfficeEvent(secret, event) }, secret)).toBe('ok');
    expect(checkSignedOfficeRetry({ v: 1, event, signature: signLifecycleOfficeEvent('other', event) }, secret)).toBe('unauthorized');
    expect(checkSignedOfficeRetry({ v: 1, event: { ...event, actor: { ...event.actor, role: 'designer' } }, signature: 'x' }, secret)).toBe('invalid');
    expect(checkSignedOfficeRetry({ v: 1, event: { ...event, expectedRev: 1 }, signature: 'x' }, secret)).toBe('invalid');
  });
});
