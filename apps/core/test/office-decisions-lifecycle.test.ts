import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import type { LifecycleEvent, LifecycleEventType, LifecycleStateV1, ProjectionResponse } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { apply, plan, projectionRequestFor, requestIdFor, type LifecycleEffect } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import * as pendingChange from '../src/services/pending-change.js';

vi.mock('../src/services/pending-change.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/pending-change.js')>();
  return { ...real, pendingChangeOf: vi.fn(real.pendingChangeOf) };
});

/**
 * Slice 2.4 (PHASE2_DESIGN.md section 3; ADR-034): the office's decisions on a request the lifecycle
 * owns. The Desk's routes check what they can without writing, then ask RequestLifecycle.officeDecision
 * through Restate's ingress, synchronously, under the key `desk:<actionId>`, and answer what the object
 * decided.
 *
 * Restate is a fake ingress here: it keeps an answer per idempotency key (a second call with the key
 * waits for the first and gets its answer, as Restate's ingress does), runs one invocation per object
 * at a time, and runs the real state machine (@hawa/domain) with Core's real projection endpoint, as
 * the worker's shell does. The chaos suite runs the same on the real Restate (scenarios L4.*).
 */
const url = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const WORKER = ['worker', 'office', 'token'].join('_');

type Answer = { status: number; body: unknown };

/** Restate's ingress, as far as Core's forwarding sees it. */
class FakeIngress {
  readonly states = new Map<string, LifecycleStateV1>();
  readonly effects: LifecycleEffect[] = [];
  readonly invocations: Array<{ handler: string; key: string | undefined }> = [];
  private readonly answers = new Map<string, Promise<Answer>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Drop the connection after the object answered, this many times: Core never hears the answer. */
  dropAnswers = 0;
  private server?: http.Server;
  project: (requestId: string, body: unknown) => Promise<{ status: number; body: any }> = async () => ({ status: 503, body: null });

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  /** One exclusive handler of RequestLifecycle, as the worker's shell runs it (plan, project, apply). */
  async invoke(type: LifecycleEventType, requestId: string, payload: Record<string, unknown>): Promise<unknown> {
    const run = async () => {
      const ev = { ...payload, type } as LifecycleEvent;
      const s = this.states.get(requestId);
      const now = Date.now();
      const p = plan(s, ev, now);
      if (p.ignored) return p.reply ?? null;
      const projected = await this.project(requestId, projectionRequestFor(s, ev, p));
      if (projected.status !== 200) {
        throw Object.assign(new Error(`projection refused: ${projected.status} ${JSON.stringify(projected.body)}`), { terminal: true });
      }
      const applied = apply(s, ev, projected.body as ProjectionResponse, now);
      if (applied.ignored) return applied.reply ?? null;
      this.states.set(requestId, applied.next);
      this.effects.push(...applied.effects);
      return applied.reply ?? null;
    };
    const before = this.queues.get(requestId) ?? Promise.resolve();
    const mine = before.then(run, run);
    this.queues.set(requestId, mine.catch(() => undefined));
    return mine;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const match = /^\/RequestLifecycle\/([^/]+)\/(\w+)$/.exec(req.url || '');
    if (!match || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const [, requestId, handler] = match;
    const key = req.headers['idempotency-key'] as string | undefined;
    this.invocations.push({ handler, key });
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    const work = async (): Promise<Answer> => {
      try {
        return { status: 200, body: await this.invoke(handler as LifecycleEventType, decodeURIComponent(requestId), payload) };
      } catch (err) {
        return { status: (err as { terminal?: boolean }).terminal ? 422 : 500, body: { message: (err as Error).message } };
      }
    };
    let answer: Promise<Answer>;
    if (key && this.answers.has(`${requestId}:${key}`)) answer = this.answers.get(`${requestId}:${key}`)!;
    else {
      answer = work();
      if (key) this.answers.set(`${requestId}:${key}`, answer);
    }
    const done = await answer;
    if (this.dropAnswers > 0) {
      this.dropAnswers--;
      req.socket.destroy();
      return;
    }
    res.writeHead(done.status, { 'content-type': 'application/json' }).end(JSON.stringify(done.body));
  }

  /** Invocations of officeDecision that ran (not answered from a key). */
  ran(handler = 'officeDecision'): number {
    return this.invocations.filter((i) => i.handler === handler).length;
  }
}

describe.skipIf(!url)('slice 2.4: the office\'s decisions on a lifecycle request go through RequestLifecycle', () => {
  const db = createDb(url || 'postgres://localhost/hawa_test');
  const ingress = new FakeIngress();
  const bridge = {
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
    downloadFile: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  let ingressUrl = '';
  let app: ReturnType<typeof createApp>;
  const newApp = () => createApp({
    db,
    testAuth: { roleHeader: true },
    deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)),
    telegramBridge: bridge as never,
  } as never);

  beforeAll(async () => {
    ingressUrl = await ingress.start();
  });
  afterAll(async () => {
    await ingress.stop();
    await db.destroy();
  });
  beforeEach(() => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('RESTATE_INGRESS_URL', ingressUrl);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '1000000');
    app = newApp();
    // The projection the object asks for, through whichever Core is up.
    ingress.project = async (requestId, body) => {
      const res = await app.request(`/v1/internal/lifecycle/${requestId}/project`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    ingress.dropAnswers = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const asOwner = <T>(fn: (trx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>) =>
    withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);
  const one = async <T>(q: ReturnType<typeof sql<T>>) => (await asOwner(async (trx) => (await q.execute(trx)).rows))[0];
  const artDirector = (actionId?: string) => ({
    'Content-Type': 'application/json', 'x-user-role': 'art_director', ...(actionId ? { 'Idempotency-Key': actionId } : {}),
  });
  const operator = (actionId?: string) => ({ 'Content-Type': 'application/json', 'x-user-role': 'operator', ...(actionId ? { 'Idempotency-Key': actionId } : {}) });

  let seq = 0;
  const newChat = () => String(9_430_000 + Math.floor(Math.random() * 60_000) + ++seq);

  /** A Canva design bound to the task, with a PNG and a checked PPTX export, as a design run leaves them. */
  async function canvaDraftOf(taskId: string, designId: string) {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const deck = Buffer.from(`PPTX_${randomUUID()}`);
    const ids: Record<string, string> = {};
    await asOwner(async (trx) => {
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      for (const [format, bytes] of [['png', png], ['pptx', deck]] as const) {
        const op = randomUUID();
        const id = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
          VALUES (${op}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, ${SYSTEM_AUTOMATION_USER_ID}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format })}::jsonb, now(), now())`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
          VALUES (${id}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
            ${format === 'pptx' ? JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' }) : null}::jsonb, now())`.execute(trx);
        ids[format] = id;
      }
    });
    return ids as { png: string; pptx: string };
  }

  /** A lifecycle request whose first draft is in review: opened, designed, its outcome projected. */
  async function requestInReview() {
    const chat = newChat();
    const requestId = requestIdFor(chat, 810_001, 0);
    await ingress.invoke('open', requestId, {
      v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: chat, origin: { kind: 'telegram', chatId: chat, updateId: 810_001 },
      draft: { title: 'KAAE: Members evening', rawText: `Members evening ${randomUUID()}`, clientId: KAAE, designInstructions: '', exactCopy: [], autoGenerate: true, variant: { width: 1080, height: 1350 } },
    });
    const opened = ingress.states.get(requestId)!;
    const taskId = opened.rounds[0].taskId;
    const designId = `DAGoffice${randomUUID().slice(0, 8)}`;
    const exports = await canvaDraftOf(taskId, designId);
    await ingress.invoke('designFinished', requestId, {
      v: 1, eventId: `dr-finished:${opened.rounds[0].runId}`, runId: opened.rounds[0].runId, round: 0, taskId,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId },
    });
    const s = ingress.states.get(requestId)!;
    expect(s.stage).toBe('in_review');
    return { chat, requestId, taskId, revisionId: s.draft!.revisionId!, exports, designId };
  }

  const approve = (a: { taskId: string; revisionId: string; exports: { png: string } }, actionId?: string, target = app) =>
    target.request(`/tasks/${a.taskId}/revisions/${a.revisionId}/decisions`, {
      method: 'POST', headers: artDirector(actionId), body: JSON.stringify({ action: 'approve', reason: 'Brand verified', pinnedExportIds: [a.exports.png] }),
    });
  const approvals = async (taskId: string) => (await asOwner(async (trx) => (await sql<{ id: string; decision: string; nonce: string }>`
    SELECT id::text, decision::text, nonce FROM hawa.approvals WHERE tenant_id = ${TENANT}::uuid AND task_id = ${taskId}::uuid`.execute(trx)).rows));
  const taskState = async (taskId: string) => (await one(sql<{ state: string }>`SELECT state::text FROM hawa.tasks WHERE id = ${taskId}::uuid`))?.state;

  it('GET /tasks/:id names the request, its revision, stage and owner; a task Core owns has none', async () => {
    const r = await requestInReview();
    const res = await app.request(`/tasks/${r.taskId}`, { headers: operator() });
    expect(res.status).toBe(200);
    const task = await res.json();
    const s = ingress.states.get(r.requestId)!;
    expect(task.lifecycle).toEqual({ requestId: r.requestId, rev: s.rev, stage: 'in_review', owner: 'restate' });

    const legacy = randomUUID();
    await asOwner((trx) => sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
      VALUES (${legacy}::uuid, ${TENANT}::uuid, ${KAAE}::uuid, 'Legacy', 'x', 'received', 3, 1, now(), now())`.execute(trx));
    expect((await (await app.request(`/tasks/${legacy}`, { headers: operator() })).json()).lifecycle).toBeNull();
  });

  it('a double click (one action id, two requests at once) records one approval, and both are answered 200 with it', async () => {
    const r = await requestInReview();
    const actionId = randomUUID();
    const [a, b] = await Promise.all([approve(r, actionId), approve(r, actionId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ja, jb] = [await a.json(), await b.json()];
    const rows = await approvals(r.taskId);
    expect(rows).toEqual([{ id: expect.any(String), decision: 'approved', nonce: `lc:${actionId}` }]);
    expect(ja.decisionId).toBe(rows[0].id);
    expect(jb.decisionId).toBe(rows[0].id);
    expect(ja).toMatchObject({ actionId, executor: 'restate', decision: 'approved', lifecycle: { requestId: r.requestId, stage: 'approved' } });
    // The object ran the decision once; the second request was answered from its key.
    expect(ingress.invocations.filter((i) => i.key === `desk:${actionId}`)).toHaveLength(2);
    expect(ingress.states.get(r.requestId)!.stage).toBe('approved');
    expect(await taskState(r.taskId)).toBe('approved');
    // Core's own rule for a pending change was never asked: the object decides it.
    expect(vi.mocked(pendingChange.pendingChangeOf)).not.toHaveBeenCalled();

    // A second click with a new id reaches the object, which refuses it: still one row.
    const again = await approve(r, randomUUID());
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ code: 'WRONG_STAGE' });
    expect(await approvals(r.taskId)).toHaveLength(1);
  });

  it('Core dies after the object accepted, before the Desk heard: the Desk\'s retry with the same id gets 200 and the same approval, one row', async () => {
    const r = await requestInReview();
    const actionId = randomUUID();
    ingress.dropAnswers = 1;
    const cut = await approve(r, actionId);
    // The Desk hears no answer it can trust (here Core says the lifecycle did not answer).
    expect(cut.status).toBe(503);
    expect(ingress.states.get(r.requestId)!.stage).toBe('approved');
    expect(await approvals(r.taskId)).toHaveLength(1);

    // A restarted Core; the Desk sends the same press again.
    app = newApp();
    const retry = await approve(r, actionId, app);
    expect(retry.status).toBe(200);
    const body = await retry.json();
    const rows = await approvals(r.taskId);
    expect(rows).toHaveLength(1);
    expect(body).toMatchObject({ decisionId: rows[0].id, actionId, lifecycle: { stage: 'approved' } });
    const second = await (await approve(r, actionId, app)).json();
    expect(second.decisionId).toBe(body.decisionId);
    expect(ingress.ran()).toBeGreaterThanOrEqual(3);
    expect(ingress.states.get(r.requestId)!.decisions!.filter((d) => d.eventId === `desk:${actionId}`)).toHaveLength(1);
  });

  it('approving the old round while the requester\'s change is being made is refused by the lifecycle (409 with the pending change in words)', async () => {
    const r = await requestInReview();
    await ingress.invoke('requesterDecision', r.requestId, { v: 1, eventId: `tg:${r.chat}:900001`, taskId: r.taskId, kind: 'change', directive: 'Make the logo bigger', actorId: '7' });
    const s = ingress.states.get(r.requestId)!;
    expect(s.stage).toBe('designing');
    const res = await approve(r, randomUUID());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'CHANGE_PENDING', title: 'Replaced By A Newer Revision' });
    expect(body.detail).toContain(s.rounds[1].taskId);
    expect(await approvals(r.taskId)).toHaveLength(0);
    expect(await taskState(r.taskId)).toBe('human_review');
    expect(vi.mocked(pendingChange.pendingChangeOf)).not.toHaveBeenCalled();
  });

  it('Deliver: the lifecycle claims the publication for the Delivery workflow and moves the task; its report completes both', async () => {
    const r = await requestInReview();
    expect((await approve(r, randomUUID())).status).toBe(200);
    const [approval] = await approvals(r.taskId);
    const actionId = randomUUID();
    const res = await app.request(`/tasks/${r.taskId}/publish`, { method: 'POST', headers: operator(actionId), body: JSON.stringify({ destination: 'google_drive' }) });
    expect(res.status).toBe(202);
    const body = await res.json();
    const deliveryId = `dl-${r.requestId}-${approval.id}`;
    expect(body).toMatchObject({ executor: 'restate', status: 'PUBLISHING', actionId, deliveryId, lifecycle: { stage: 'delivering' } });
    expect(await taskState(r.taskId)).toBe('publishing');
    const pub = await one(sql<{ executor: string; executor_run: number; state: string }>`SELECT executor, executor_run, state::text FROM hawa.publications
      WHERE publication_key = ${`pub_key_${r.taskId}_${approval.id}`}`);
    expect(pub).toEqual({ executor: 'restate', executor_run: 1, state: 'pending' });
    expect(ingress.effects.filter((e) => e.type === 'startDelivery')).toEqual([expect.objectContaining({ deliveryId, approvalId: approval.id, taskId: r.taskId, run: 1 })]);
    // Nothing was queued for Core's own delivery.
    expect(await one(sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE aggregate_id = ${r.taskId}::uuid AND command_type = 'notify.published'`)).toEqual({ n: 0 });

    // Pressed again while it runs: the lifecycle says so, nothing starts twice.
    const twice = await app.request(`/tasks/${r.taskId}/publish`, { method: 'POST', headers: operator(randomUUID()), body: '{}' });
    expect(twice.status).toBe(422);
    expect(ingress.effects.filter((e) => e.type === 'startDelivery')).toHaveLength(1);

    // The workflow's report, as Delivery sends it to the object.
    await ingress.invoke('deliveryFinished', r.requestId, {
      v: 1, eventId: `dl-finished:${deliveryId}`, deliveryId, outcome: 'delivered', uncertain: [], sheetsConfirmed: true, archived: true, filesSent: 1,
    });
    expect(ingress.states.get(r.requestId)!.stage).toBe('delivered');
    expect(await taskState(r.taskId)).toBe('complete');
    expect(await one(sql<{ state: string; executor_finished_run: number }>`SELECT state::text, executor_finished_run FROM hawa.publications
      WHERE publication_key = ${`pub_key_${r.taskId}_${approval.id}`}`)).toEqual({ state: 'complete', executor_finished_run: 1 });
  });

  it('a delivery that left nothing in Drive puts the task back to APPROVED; the next Deliver retries the archive under the next run', async () => {
    const r = await requestInReview();
    expect((await approve(r, randomUUID())).status).toBe(200);
    const [approval] = await approvals(r.taskId);
    expect((await app.request(`/tasks/${r.taskId}/publish`, { method: 'POST', headers: operator(randomUUID()), body: '{}' })).status).toBe(202);
    const deliveryId = `dl-${r.requestId}-${approval.id}`;
    await ingress.invoke('deliveryFinished', r.requestId, {
      v: 1, eventId: `dl-finished:${deliveryId}`, deliveryId, outcome: 'chat_only', uncertain: [], sheetsConfirmed: false, archived: false, filesSent: 1,
    });
    expect(await taskState(r.taskId)).toBe('approved');
    expect(ingress.states.get(r.requestId)!.stage).toBe('delivered');
    const again = await app.request(`/tasks/${r.taskId}/publish`, { method: 'POST', headers: operator(randomUUID()), body: '{}' });
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ deliveryId: `${deliveryId}:archive:2` });
    expect(await taskState(r.taskId)).toBe('publishing');
    expect((await one(sql<{ executor_run: number }>`SELECT executor_run FROM hawa.publications WHERE publication_key = ${`pub_key_${r.taskId}_${approval.id}`}`))?.executor_run).toBe(2);
  });

  it('revise: the request goes to the office (the revision request recorded); the office\'s capture in Canva puts it back in review', async () => {
    const r = await requestInReview();
    const res = await app.request(`/tasks/${r.taskId}/revisions/${r.revisionId}/decisions`, {
      method: 'POST', headers: artDirector(randomUUID()), body: JSON.stringify({ action: 'revision_requested', revisionRequest: { comment: 'Tighter margins' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: 'revision_requested', lifecycle: { stage: 'manual' } });
    expect(await taskState(r.taskId)).toBe('revision_requested');
    expect((await approvals(r.taskId)).map((a) => a.decision)).toEqual(['revision_requested']);

    // The office changed the design in Canva; its new checked export is stored after the request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deck = Buffer.from(`PPTX_changed_${randomUUID()}`);
    await asOwner(async (trx) => {
      const op = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${op}::uuid, ${TENANT}::uuid, ${r.taskId}::uuid, ${KAAE}::uuid, ${SYSTEM_AUTOMATION_USER_ID}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${r.designId}, 1, '{"format":"pptx"}'::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${randomUUID()}::uuid, ${TENANT}::uuid, ${r.taskId}::uuid, ${KAAE}::uuid, ${op}::uuid, 'pptx', ${createHash('sha256').update(deck).digest('hex')}, ${deck},
          ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())`.execute(trx);
    });
    // The Desk's re-drive of a round with a Canva design is its capture (Canva is not reachable here:
    // the exports are not made again, and the stored check is the one captured).
    const capture = await app.request(`/tasks/${r.taskId}/redrive`, { method: 'POST', headers: operator(randomUUID()), body: '{}' });
    expect(capture.status).toBe(200);
    expect(await capture.json()).toMatchObject({ status: 'LIFECYCLE_CAPTURE', executor: 'restate', lifecycle: { stage: 'in_review' } });
    const s = ingress.states.get(r.requestId)!;
    expect(s.stage).toBe('in_review');
    expect(s.draft!.revisionId).not.toBe(r.revisionId);
    expect(await taskState(r.taskId)).toBe('human_review');
    expect((await one(sql<{ rev: string }>`SELECT current_design_revision_id::text AS rev FROM hawa.tasks WHERE id = ${r.taskId}::uuid`))?.rev).toBe(s.draft!.revisionId);
  });

  it('reject ends the request; cancel is the lifecycle\'s, and pause is refused for a lifecycle task', async () => {
    const r = await requestInReview();
    const paused = await app.request(`/tasks/${r.taskId}/pause`, { method: 'POST', headers: operator(), body: '{}' });
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ code: 'LIFECYCLE_OWNED' });
    const rejected = await app.request(`/tasks/${r.taskId}/revisions/${r.revisionId}/decisions`, {
      method: 'POST', headers: artDirector(randomUUID()), body: JSON.stringify({ action: 'reject', reason: 'Off brand' }),
    });
    expect(rejected.status).toBe(200);
    expect(await taskState(r.taskId)).toBe('rejected');
    expect(ingress.states.get(r.requestId)!.stage).toBe('cancelled');
    const cancel = await app.request(`/tasks/${r.taskId}/cancel`, { method: 'POST', headers: operator(randomUUID()), body: '{}' });
    expect(cancel.status).toBe(422);
    expect(await cancel.json()).toMatchObject({ code: 'WRONG_STAGE' });

    const other = await requestInReview();
    const cancelled = await app.request(`/tasks/${other.taskId}/cancel`, { method: 'POST', headers: operator(randomUUID()), body: JSON.stringify({ reason: 'Client withdrew' }) });
    expect(cancelled.status).toBe(202);
    expect(ingress.states.get(other.requestId)!.stage).toBe('cancelled');
    // Review cannot be cancelled in the task's vocabulary: an operator has it, as the legacy cancel did.
    expect(await taskState(other.taskId)).toBe('failed_operator');
  });

  it('re-drive of a failed round: the lifecycle starts the next attempt\'s design run and abandons the studio run nobody follows', async () => {
    const chat = newChat();
    const requestId = requestIdFor(chat, 810_002, 0);
    await ingress.invoke('open', requestId, {
      v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: chat, origin: { kind: 'telegram', chatId: chat, updateId: 810_002 },
      draft: { title: 'KAAE: Staff day', rawText: `Staff day ${randomUUID()}`, clientId: KAAE, designInstructions: '', exactCopy: [], autoGenerate: true },
    });
    const opened = ingress.states.get(requestId)!;
    const taskId = opened.rounds[0].taskId;
    const studioRun = randomUUID();
    await asOwner((trx) => sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
      VALUES (${studioRun}::uuid, ${TENANT}::uuid, ${taskId}::uuid, ${KAAE}::uuid, 'test', ${`s-${taskId}`}, 'h', '{}'::jsonb, 'standard', 'rendering', '{}'::jsonb)`.execute(trx));
    await ingress.invoke('designFinished', requestId, {
      v: 1, eventId: `dr-finished:${opened.rounds[0].runId}`, runId: opened.rounds[0].runId, round: 0, taskId, report: { status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED' },
    });
    expect(ingress.states.get(requestId)!.stage).toBe('manual');
    const res = await app.request(`/tasks/${taskId}/redrive`, { method: 'POST', headers: operator(randomUUID()), body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'LIFECYCLE_REDRIVE', lifecycle: { stage: 'designing' } });
    expect(ingress.effects.filter((e) => e.type === 'startDesignRun' && e.taskId === taskId).map((e) => (e as { runId: string }).runId)).toEqual([`dr-${taskId}`, `dr-${taskId}-a1`]);
    expect((await one(sql<{ status: string }>`SELECT status FROM hawa.design_studio_runs WHERE id = ${studioRun}::uuid`))?.status).toBe('abandoned');
    // Nothing was queued for the legacy dispatcher.
    expect(await one(sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'task.dispatch'`)).toEqual({ n: 0 });
  });

  it('Restate unreachable: 503, nothing written, and the same press later is taken once', async () => {
    const r = await requestInReview();
    vi.stubEnv('RESTATE_INGRESS_URL', 'http://127.0.0.1:9');
    const actionId = randomUUID();
    const down = await approve(r, actionId, newApp());
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: 'LIFECYCLE_UNAVAILABLE', actionId });
    expect(await approvals(r.taskId)).toHaveLength(0);
    vi.stubEnv('RESTATE_INGRESS_URL', ingressUrl);
    expect((await approve(r, actionId, newApp())).status).toBe(200);
    expect(await approvals(r.taskId)).toHaveLength(1);
  });
});
