import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { parseOfficeApprovalProof } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
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
  it('refuses approval before the gateway when the latest critical QA failed', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    const failedQcId = randomUUID();
    await withRlsContext(db, scope, async (trx) => {
      const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
        .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
      await sql`INSERT INTO hawa.qc_runs
        (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
          report, report_sha256, started_at)
        VALUES (${failedQcId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid,
          ${firstQc.qc_profile_id}::uuid, 2, 'failed', false, '{}'::jsonb, ${'f'.repeat(64)},
          clock_timestamp() + interval '1 minute')`.execute(trx);
    });
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const director = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const response = await director.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'approve', reason: 'Ready', pinnedExportIds: [randomUUID()] }),
    });
    expect(response.status).toBe(412);
    expect(transport).not.toHaveBeenCalled();
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select('id').where('task_id', '=', taskId).execute(),
    }));
    expect(rows.request).toMatchObject({ stage: 'in_review', rev: '2' });
    expect(rows.approvals).toHaveLength(0);
  });

  it('rechecks the exact QA run inside the projection transaction', async () => {
    const { requestId, taskId, revisionId } = await reviewableRequest();
    const actualQcId = randomUUID();
    const expectedQcId = randomUUID();
    const actualHash = 'a'.repeat(64);
    await withRlsContext(db, scope, async (trx) => {
      const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
        .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
      await sql`INSERT INTO hawa.qc_runs
        (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
          report, report_sha256, started_at)
        VALUES (${actualQcId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid,
          ${firstQc.qc_profile_id}::uuid, 2, 'passed', true, '{}'::jsonb, ${actualHash},
          clock_timestamp() + interval '1 minute')`.execute(trx);
    });
    const actionId = randomUUID();
    await expect(projectLifecycleOfficeDecision(db, {
      requestId, tenantId, taskId, revisionId, actionId,
      actor: { userId, role: 'art_director' }, reason: 'Checked the final export',
      decision: 'approved', expectedRev: 2, rev: 3,
      key: `${requestId}:3:officeDecision:desk:${actionId}`,
      deskRequestFingerprint: 'b'.repeat(64),
      approvalProof: { qcRunId: expectedQcId, qcReportHash: actualHash,
        pinnedExports: [{ artifactId: randomUUID(), format: 'pptx', sha256: 'c'.repeat(64), byteSize: 1 }] },
    })).rejects.toMatchObject({ code: 'APPROVAL_EVIDENCE_CHANGED' });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select('id').where('task_id', '=', taskId).execute(),
    }));
    expect(rows.request).toMatchObject({ stage: 'in_review', rev: '2' });
    expect(rows.approvals).toHaveLength(0);
  });

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
    const feedback = { scope: 'copy', category: 'factual_error', targetNodes: ['venue'],
      priority: 'high', isReusableFeedback: false, comment: 'Correct the venue' };
    const body = { action: 'revision_requested', revisionRequest: feedback };
    const missingKey = await director.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(missingKey.status).toBe(422);
    const denied = await operator.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(denied.status).toBe(403);
    const incomplete = await director.request(path, { method: 'POST', headers,
      body: JSON.stringify({ action: 'revision_requested', revisionRequest: { comment: feedback.comment } }) });
    expect(incomplete.status).toBe(422);
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
      body: JSON.stringify({ ...body, revisionRequest: { ...feedback, scope: 'layout' } }) });
    expect(changed.status).toBe(409);
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select(['id', 'decided_by', 'decision_payload']).where('task_id', '=', taskId).execute(),
      receipts: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
    }));
    expect(rows.request).toMatchObject({ stage: 'manual', rev: '3' });
    expect(rows.approvals).toMatchObject([{ id: result.decisionId, decided_by: userId,
      decision_payload: { revisionRequest: feedback } }]);
    expect(rows.receipts.map((row) => Number(row.rev)).sort()).toEqual([1, 2, 3]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('approves only the checked stored export and replays its original proof after a lost answer', async () => {
    const { requestId, taskId, revisionId, chatId, runId } = await reviewableRequest();
    let state = { v: 1, requestId, tenantId, chatId, owner: 'restate', stage: 'in_review', rev: 2,
      taskId, runId, outcome: { revisionId } } as unknown as AutomaticLifecycleState;
    const object: AutomaticOpenContext = {
      key: requestId, get: async () => state, run: async (_name, action) => action(),
      set: (_name, value) => { state = value as AutomaticLifecycleState; },
      send: () => { throw new Error('no message expected'); },
      startDesign: () => { throw new Error('no design expected'); },
    };
    const internal = createApp({ db } as any);
    const core = { post: async <T>(path: string, payload: unknown): Promise<T> => {
      const answer = await internal.request(`/v1${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
      if (!answer.ok) throw new Error(`Core projection HTTP ${answer.status}: ${await answer.text()}`);
      return answer.json() as Promise<T>;
    } };
    const actionId = randomUUID();
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': actionId };
    const path = `/v1/tasks/${taskId}/revisions/${revisionId}/decisions`;
    const body = { action: 'approve', reason: 'Approved after checking the export', pinnedExportIds: [] as string[] };
    const bytes = Buffer.from('The checked editable deck bytes for this isolated office review fixture.');
    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const report = { exportArtifactId: artifactId, exportSha256: sha256, captureVersion: '200',
      rtlVisualReviewRequired: false };
    const reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    const qcRunId = randomUUID();
    const operationId = randomUUID();
    await withRlsContext(db, scope, async (trx) => {
      const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
        .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
        .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${userId}, ${'approval-' + actionId},
          ${sha256}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
          ${JSON.stringify({ format: 'pptx', designUpdatedAt: '200' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes
        (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${artifactId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid,
          ${operationId}::uuid, 'pptx', ${sha256}, ${bytes})`.execute(trx);
      await sql`INSERT INTO hawa.qc_runs
        (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
          report, report_sha256, started_at)
        VALUES (${qcRunId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid,
          ${firstQc.qc_profile_id}::uuid, 2, 'passed', true, ${JSON.stringify(report)}::jsonb, ${reportHash},
          clock_timestamp() + interval '1 minute')`.execute(trx);
    });
    body.pinnedExportIds = [artifactId];
    const store = { captureEvidenceRequired: true,
      find: async (_tenant: string, _user: string, _task: string, ids: string[]) => ids.includes(artifactId)
        ? [{ artifactId, format: 'pptx' as const, sha256, byteSize: bytes.length }] : [],
      read: async () => bytes,
    };
    expect(parseOfficeApprovalProof({ qcRunId, qcReportHash: reportHash,
      pinnedExports: [{ artifactId, format: 'pptx', sha256, byteSize: bytes.length }] })).not.toBeNull();
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
        return Response.json({ detail: error instanceof Error ? error.message : 'conflict' }, { status: 409 });
      }
    });
    vi.stubGlobal('fetch', transport);
    const director = createApp({ db, deliverableStore: store,
      testAuth: { principal: { role: 'art_director', userId } } } as any);
    const operator = createApp({ db, deliverableStore: store,
      testAuth: { principal: { role: 'operator', userId } } } as any);
    expect((await operator.request(path, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(403);
    expect((await director.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, pinnedExportIds: [] }) })).status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
    loseFirstAnswer = true;
    const uncertain = await director.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(uncertain.status, await uncertain.text()).toBe(503);
    expect(state.stage).toBe('approved');
    const restartedCore = createApp({ db, deliverableStore: { ...store,
      find: async () => { throw new Error('provider unavailable after commit'); } },
      testAuth: { principal: { role: 'art_director', userId } } } as any);
    const replay = await restartedCore.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(replay.status).toBe(201);
    const result = await replay.json() as Record<string, unknown>;
    expect(result).toMatchObject({ decisionId: expect.any(String), decision: 'approved', requestId, requestRev: 3 });
    expect((await restartedCore.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, reason: 'Changed reason' }) })).status).toBe(409);
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state', 'version']).where('id', '=', taskId).executeTakeFirst(),
      approvals: await trx.selectFrom('approvals').select(['id', 'decision', 'qc_run_id', 'decision_payload'])
        .where('task_id', '=', taskId).execute(),
      receipts: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
    }));
    expect(rows.request).toMatchObject({ stage: 'approved', rev: '3' });
    expect(rows.task?.state).toBe('approved');
    expect(rows.approvals).toMatchObject([{ id: result.decisionId, decision: 'approved', qc_run_id: qcRunId,
      decision_payload: { pinnedExports: [{ artifactId, sha256, byteSize: bytes.length }] } }]);
    expect(rows.receipts.map((row) => Number(row.rev)).sort()).toEqual([1, 2, 3]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
