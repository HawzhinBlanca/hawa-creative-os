/**
 * Full lifecycle journey integration test.
 *
 * Exercises the complete request lifecycle in sequence, using direct projection calls for
 * setup steps and HTTP for the steps under test. Recovery (idempotent replay) is verified
 * at each major transition.
 *
 * Journey: intake(rev0→1) → design1(rev1→2, in_review) → office-revise(rev2→3, manual)
 *        → requester-revision(rev3→4, designing) → design2(rev4→5, in_review)
 *        → office-approve(rev5→6, approved) → delivery-start(rev6→7, delivering)
 *
 * Tests: full happy path, idempotent replay of requester-revision, stale-rev protection,
 *        wrong-task protection, and the office-approve route validation.
 */

import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvaBindingRepository, createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import {
  projectLifecycleOpen,
  projectLifecycleDesignOutcome,
  projectLifecycleOfficeDecision,
} from '../src/services/lifecycle-projection.js';
import { projectLifecycleDeliveryStart } from '../src/services/lifecycle-delivery-projection.js';
import type { Database, Kysely } from '@hawa/db';

const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const token = ['worker', 'lifecycle', 'full', 'journey', 'test'].join('_');
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

/** POST to the internal lifecycle route via the full app stack. Returns status + parsed body. */
async function post(requestId: string, path: string, body: unknown) {
  const res = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

/** Open a request, produce a Canva binding and drive design outcome to in_review. Returns rev=2 state. */
async function setupInReview() {
  const requestId = randomUUID();
  const chatId = String(74_000_000 + Math.floor(Math.random() * 9_000_000));
  process.env.TELEGRAM_ALLOWED_USERS = chatId;

  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: {
      platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chatId,
      rawText: 'Spring campaign poster', title: 'Spring campaign poster',
      designInstructions: 'Use exact copy', exactCopy: ['Spring campaign poster'],
      clientId, autoGenerate: true, designStudio: false,
    },
  });
  const taskId = opened.taskId;

  // Create Canva binding so design-outcome gets a revision
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
  return { requestId, taskId, revisionId: designed.revisionId!, chatId, runId, designId };
}

/** Drive office-revise (in_review → manual) using the direct projection. Returns rev=3 state. */
async function setupOfficeRevise(requestId: string, taskId: string, revisionId: string) {
  const actionId = randomUUID();
  const result = await projectLifecycleOfficeDecision(db, {
    requestId, tenantId, taskId, revisionId, actionId,
    actor: { userId, role: 'art_director' },
    reason: 'Please increase the font size on the headline',
    expectedRev: 2, rev: 3, key: `${requestId}:3:officeDecision:desk:${actionId}`,
  });
  expect(result.stage).toBe('manual');
  return { actionId, rev: result.rev };
}

/** Create a bare lifecycle-intaked task (received state, request_id=null, outbox 'delivered'). */
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

/** Read the current request state from the DB. */
async function readRequest(requestId: string) {
  return withRlsContext(db, scope, (trx) =>
    trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId)
      .executeTakeFirstOrThrow());
}

/** Read a task's request_id. */
async function taskRequestId(taskId: string) {
  const row = await withRlsContext(db, scope, (trx) =>
    trx.selectFrom('tasks').select('request_id')
      .where('tenant_id', '=', tenantId).where('id', '=', taskId)
      .executeTakeFirstOrThrow());
  return row.request_id;
}

// ---------------------------------------------------------------------------
// Helper: set up an approved request with QC + approval proof
// ---------------------------------------------------------------------------

async function setupApprovedRequest() {
  const { requestId, taskId, revisionId, designId } = await setupInReview();
  // Set up QC run + export bytes so office approval can validate the proof
  const bytes = Buffer.from(`QC deck ${randomUUID()}`);
  const artifactId = randomUUID();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const qcRunId = randomUUID();
  const report = { exportArtifactId: artifactId, exportSha256: sha256, captureVersion: '300' };
  const reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  await withRlsContext(db, scope, async (trx) => {
    const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
      .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
      .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId).executeTakeFirstOrThrow();
    const operationId = randomUUID();
    await trx.insertInto('canva_remote_operations' as any).values({
      id: operationId, tenant_id: tenantId, task_id: taskId, client_id: clientId,
      actor_id: userId, request_key: `deliver-${operationId}`, request_hash: sha256,
      kind: 'export', status: 'retrieved', design_id: binding.canva_design_id,
      binding_version: binding.version, metadata: { format: 'pptx', designUpdatedAt: '300' },
    } as any).execute();
    await trx.insertInto('canva_export_bytes' as any).values({
      id: artifactId, tenant_id: tenantId, task_id: taskId, client_id: clientId,
      operation_id: operationId, format: 'pptx', sha256, content: bytes,
    } as any).execute();
    await trx.insertInto('qc_runs' as any).values({
      id: qcRunId, tenant_id: tenantId, task_id: taskId, design_revision_id: revisionId,
      qc_profile_id: firstQc.qc_profile_id, attempt: 2, status: 'passed', critical_pass: true,
      report, report_sha256: reportHash, started_at: new Date(Date.now() + 60_000),
    } as any).execute();
  });
  const actionId = randomUUID();
  const approval = await projectLifecycleOfficeDecision(db, {
    requestId, tenantId, taskId, revisionId, actionId,
    actor: { userId, role: 'art_director' },
    reason: 'All checks pass; approved for delivery',
    decision: 'approved', expectedRev: 2, rev: 3,
    key: `${requestId}:3:officeDecision:desk:${actionId}`,
    deskRequestFingerprint: 'b'.repeat(64),
    approvalProof: { qcRunId, qcReportHash: reportHash,
      pinnedExports: [{ artifactId, format: 'pptx', sha256, byteSize: bytes.length }] },
  });
  return { requestId, taskId, revisionId, approval, artifactId, bytes, sha256 };
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('lifecycle full journey — multi-round revision to delivery-start', () => {

  // ─── 1. Full multi-round happy path ─────────────────────────────────────
  it('happy path: intake → design1(rev2) → office-revise(rev3) → requester-revision(rev4) → design2(rev5)', async () => {
    const { requestId, taskId, revisionId } = await setupInReview();
    await setupOfficeRevise(requestId, taskId, revisionId);

    const newTaskId = await intakeNewTask();

    // requester-revision: manual(3) → designing(4)
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Increase headline font to 64pt bold' }],
    });
    expect(result).toMatchObject({ status: 200, body: {
      requestId, stage: 'designing', rev: 4, newTaskId, round: 1, runId: `dr-${newTaskId}`,
    } });

    // DB: request advanced to rev4, designing, new task claimed
    const req = await readRequest(requestId);
    expect(Number(req.rev)).toBe(4);
    expect(req.stage).toBe('designing');
    expect(req.current_task_id).toBe(newTaskId);
    expect(await taskRequestId(newTaskId)).toBe(requestId);

    // Create Canva binding for new task → second design outcome
    const newDesignId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId: newTaskId, clientId, canvaDesignId: newDesignId,
      editUrl: `https://www.canva.com/design/${newDesignId}/edit`,
    }, trx));

    const newRunId = `dr-${newTaskId}`;
    const outcome2 = await post(requestId, 'design-outcome', {
      v: 1, expectedRev: 4, rev: 5,
      key: `${requestId}:5:designFinished:${newRunId}`,
      ops: [{ kind: 'recordOutcome', taskId: newTaskId, runId: newRunId,
        report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: newDesignId, notifyRequester: false } }],
    });
    expect(outcome2).toMatchObject({ status: 200, body: { rev: 5, stage: 'in_review', taskId: newTaskId } });

    const req2 = await readRequest(requestId);
    expect(Number(req2.rev)).toBe(5);
    expect(req2.stage).toBe('in_review');
  });

  // ─── 2. Idempotent replay of requester-revision ──────────────────────────
  it('requester-revision replays idempotently with the same receipt', async () => {
    const { requestId, taskId, revisionId } = await setupInReview();
    await setupOfficeRevise(requestId, taskId, revisionId);
    const newTaskId = await intakeNewTask();

    const body = {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Make the background darker' }],
    };
    const first = await post(requestId, 'requester-revision', body);
    expect(first.status).toBe(200);
    const second = await post(requestId, 'requester-revision', body);
    expect(second).toEqual(first);
  });

  // ─── 3. Stale revision protection ────────────────────────────────────────
  it('rejects requester-revision when request is not at expectedRev', async () => {
    const { requestId, taskId } = await setupInReview();
    // Request is at rev=2 (in_review), but we ask for expectedRev=3 (manual)
    const newTaskId = await intakeNewTask();
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Should fail: request is in_review not manual' }],
    });
    expect(result).toMatchObject({ status: 409, body: { code: 'STALE_REVISION' } });
  });

  // ─── 4. Wrong prior task protection ─────────────────────────────────────
  it('rejects requester-revision when priorTaskId does not match current task', async () => {
    // Set up a manual-stage request with a real task
    const { requestId, taskId, revisionId } = await setupInReview();
    await setupOfficeRevise(requestId, taskId, revisionId);
    const newTaskId = await intakeNewTask();
    // Pass a different UUID as priorTaskId — should get NOT_CURRENT_DRAFT
    const wrongTaskId = randomUUID();
    const result = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: wrongTaskId, newTaskId,
        round: 1, directive: 'Wrong prior task' }],
    });
    expect(result).toMatchObject({ status: 409, body: { code: 'NOT_CURRENT_DRAFT' } });
  });

  // ─── 5. New task already owned protection ────────────────────────────────
  it('rejects requester-revision when the new task is already owned by another request', async () => {
    const { requestId: r1, taskId: t1, revisionId: rv1 } = await setupInReview();
    await setupOfficeRevise(r1, t1, rv1);

    const { requestId: r2, taskId: t2, revisionId: rv2 } = await setupInReview();
    await setupOfficeRevise(r2, t2, rv2);

    // Create a task and claim it for r1
    const newTaskId = await intakeNewTask();
    await post(r1, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${r1}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: t1, newTaskId,
        round: 1, directive: 'First claimant' }],
    });

    // r2 tries to use the already-claimed task
    const result2 = await post(r2, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${r2}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: t2, newTaskId,
        round: 1, directive: 'Should fail: task already owned' }],
    });
    expect(result2).toMatchObject({ status: 409, body: { code: 'TASK_ALREADY_OWNED' } });
  });

  // ─── 6. Bad payload: invalid v, round < 1, empty directive ───────────────
  it('returns 400 for malformed requester-revision payloads', async () => {
    const { requestId } = await setupInReview();
    const newTaskId = await intakeNewTask();

    // wrong version
    const r1 = await post(requestId, 'requester-revision', {
      v: 2, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: randomUUID(), newTaskId, round: 1, directive: 'x' }],
    });
    expect(r1.status).toBe(400);

    // round = 0 (invalid)
    const r2 = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r0`,
      ops: [{ kind: 'requesterRevision', priorTaskId: randomUUID(), newTaskId, round: 0, directive: 'x' }],
    });
    expect(r2.status).toBe(400);

    // empty directive
    const r3 = await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: randomUUID(), newTaskId, round: 1, directive: '' }],
    });
    expect(r3.status).toBe(400);
  });

  // ─── 7. Full journey through office approval ─────────────────────────────
  it('office approval (rev5→6) succeeds after the revision round produces in_review', async () => {
    const { requestId, taskId, revisionId } = await setupInReview();
    await setupOfficeRevise(requestId, taskId, revisionId);
    const newTaskId = await intakeNewTask();

    // requester-revision → designing(4)
    await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Increase font size and add brand logo' }],
    });

    // Second design produces in_review(5)
    const newDesignId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withRlsContext(db, scope, (trx) => new CanvaBindingRepository(trx).createBinding({
      tenantId, taskId: newTaskId, clientId, canvaDesignId: newDesignId,
      editUrl: `https://www.canva.com/design/${newDesignId}/edit`,
    }, trx));
    const newRunId = `dr-${newTaskId}`;
    const outcome2 = await projectLifecycleDesignOutcome(db, {
      requestId, tenantId, taskId: newTaskId, runId: newRunId, expectedRev: 4, rev: 5,
      key: `${requestId}:5:designFinished:${newRunId}`,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: newDesignId },
    });
    expect(outcome2.stage).toBe('in_review');
    const revisionId2 = outcome2.revisionId!;

    // Office approval: in_review(5) → approved(6) — needs QC proof
    const bytes2 = Buffer.from(`QC deck ${randomUUID()}`);
    const artifactId2 = randomUUID();
    const sha256_2 = createHash('sha256').update(bytes2).digest('hex');
    const qcRunId2 = randomUUID();
    const report2 = { exportArtifactId: artifactId2, exportSha256: sha256_2, captureVersion: '300' };
    const reportHash2 = createHash('sha256').update(JSON.stringify(report2)).digest('hex');
    await withRlsContext(db, scope, async (trx) => {
      const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
        .where('tenant_id', '=', tenantId).where('task_id', '=', newTaskId).executeTakeFirstOrThrow();
      const firstQc = await trx.selectFrom('qc_runs').select('qc_profile_id')
        .where('tenant_id', '=', tenantId).where('design_revision_id', '=', revisionId2).executeTakeFirstOrThrow();
      const opId = randomUUID();
      await (trx as any).insertInto('canva_remote_operations').values({
        id: opId, tenant_id: tenantId, task_id: newTaskId, client_id: clientId, actor_id: userId,
        request_key: `deliver-${opId}`, request_hash: sha256_2, kind: 'export', status: 'retrieved',
        design_id: binding.canva_design_id, binding_version: binding.version,
        metadata: { format: 'pptx', designUpdatedAt: '300' },
      }).execute();
      await (trx as any).insertInto('canva_export_bytes').values({
        id: artifactId2, tenant_id: tenantId, task_id: newTaskId, client_id: clientId,
        operation_id: opId, format: 'pptx', sha256: sha256_2, content: bytes2,
      }).execute();
      await (trx as any).insertInto('qc_runs').values({
        id: qcRunId2, tenant_id: tenantId, task_id: newTaskId, design_revision_id: revisionId2,
        qc_profile_id: firstQc.qc_profile_id, attempt: 2, status: 'passed', critical_pass: true,
        report: report2, report_sha256: reportHash2, started_at: new Date(Date.now() + 60_000),
      }).execute();
    });
    const actionId2 = randomUUID();
    const approved = await projectLifecycleOfficeDecision(db, {
      requestId, tenantId, taskId: newTaskId, revisionId: revisionId2, actionId: actionId2,
      actor: { userId, role: 'art_director' },
      reason: 'Revision round accepted; approved for delivery',
      decision: 'approved', expectedRev: 5, rev: 6,
      key: `${requestId}:6:officeDecision:desk:${actionId2}`,
      deskRequestFingerprint: 'c'.repeat(64),
      approvalProof: { qcRunId: qcRunId2, qcReportHash: reportHash2,
        pinnedExports: [{ artifactId: artifactId2, format: 'pptx', sha256: sha256_2, byteSize: bytes2.length }] },
    });
    expect(approved.stage).toBe('approved');
    expect(approved.rev).toBe(6);

    const req = await readRequest(requestId);
    expect(Number(req.rev)).toBe(6);
    expect(req.stage).toBe('approved');
    expect(req.current_task_id).toBe(newTaskId);
  });

  // ─── 8. Lifecycle projections have monotonic revisions ───────────────────
  it('lifecycle_projections table has monotonically increasing revisions throughout the journey', async () => {
    const { requestId, taskId, revisionId } = await setupInReview();
    await setupOfficeRevise(requestId, taskId, revisionId);
    const newTaskId = await intakeNewTask();
    await post(requestId, 'requester-revision', {
      v: 1, expectedRev: 3, rev: 4, key: `${requestId}:4:requesterRevision:r1`,
      ops: [{ kind: 'requesterRevision', priorTaskId: taskId, newTaskId,
        round: 1, directive: 'Make font larger' }],
    });

    const projections = await withRlsContext(db, scope, (trx) =>
      trx.selectFrom('lifecycle_projections').select('rev')
        .where('tenant_id', '=', tenantId).where('request_id', '=', requestId)
        .orderBy('rev', 'asc').execute());
    const revs = projections.map((p) => Number(p.rev));
    // Should have revs 1 (open/intake), 2 (design outcome), 3 (office revise), 4 (requester revision)
    expect(revs).toEqual([1, 2, 3, 4]);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
  });
});
