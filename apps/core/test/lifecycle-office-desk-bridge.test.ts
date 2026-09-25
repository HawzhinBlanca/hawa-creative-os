import { createHash, randomUUID } from 'node:crypto';
import { deliveryBaseId } from '@hawa/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, PublicationRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { parseOfficeApprovalProof } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart } from '../src/services/lifecycle-delivery-projection.js';
import { PostgresDriveUploadIdentityStore } from '../src/services/drive-upload-reservation.js';
import { checkSignedOfficeDecision, type SignedOfficeDecision } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { recordDeliveryFinished, recordOfficeDeliveryStart, recordOfficeRevision,
  type AutomaticLifecycleState, type AutomaticOpenContext } from '../../worker/src/lifecycle/request-lifecycle.js';
import { runDelivery } from '../../worker/src/lifecycle/delivery.js';

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

async function approvedForDelivery() {
  const { requestId, taskId, revisionId } = await reviewableRequest();
  const bytes = Buffer.from(`Checked deck ${randomUUID()}`);
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
    await sql`INSERT INTO hawa.canva_remote_operations
      (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
      VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${userId},
        ${`deliver-${operationId}`}, ${sha256}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
        ${JSON.stringify({ format: 'pptx', designUpdatedAt: '300' })}::jsonb)`.execute(trx);
    await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
      VALUES (${artifactId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid,
        ${operationId}::uuid, 'pptx', ${sha256}, ${bytes})`.execute(trx);
    await sql`INSERT INTO hawa.qc_runs
      (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
        report, report_sha256, started_at)
      VALUES (${qcRunId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid,
        ${firstQc.qc_profile_id}::uuid, 2, 'passed', true, ${JSON.stringify(report)}::jsonb, ${reportHash},
        clock_timestamp() + interval '1 minute')`.execute(trx);
  });
  const actionId = randomUUID();
  const approval = await projectLifecycleOfficeDecision(db, { requestId, tenantId, taskId, revisionId,
    actionId, actor: { userId, role: 'art_director' }, reason: 'Checked export',
    decision: 'approved', expectedRev: 2, rev: 3,
    key: `${requestId}:3:officeDecision:desk:${actionId}`,
    deskRequestFingerprint: 'b'.repeat(64),
    approvalProof: { qcRunId, qcReportHash: reportHash,
      pinnedExports: [{ artifactId, format: 'pptx', sha256, byteSize: bytes.length }] },
  });
  const store = { captureEvidenceRequired: true,
    verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '200', observedVersion: '200' }),
    read: async (_tenant: string, _user: string, _task: string, id: string) => id === artifactId ? bytes : null,
    find: async () => [{ artifactId, format: 'pptx' as const, sha256, byteSize: bytes.length }],
  };
  const deliverAction = randomUUID();
  const start = { requestId, tenantId, taskId, revisionId, approvalId: approval.approvalId,
    actionId: deliverAction, actor: { userId, role: 'art_director' }, reason: 'Deliver approved files',
    expectedRev: 3, rev: 4, key: `${requestId}:4:officeDecision:desk:${deliverAction}` };
  return { requestId, taskId, revisionId, approval, artifactId, store, start };
}

async function recordClaimedReceipts(taskId: string, options: { sheet?: boolean; wrongDriveHash?: boolean; wrongSheetHash?: boolean } = {}) {
  await withRlsContext(db, scope, async (trx) => {
    const publication = await trx.selectFrom('publications')
      .select(['id', 'package_manifest', 'package_sha256']).where('tenant_id', '=', tenantId)
      .where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const repo = new PublicationRepository(trx);
    const files = publication.package_manifest.files as Array<{ name: string; sha256: string; size: number }>;
    const existing = await repo.getPublicationWithRefs(publication.id, tenantId, trx);
    for (const file of files.filter((item) => !existing?.driveRefs.some((ref) => ref.file_name === item.name))) {
      await repo.recordDriveRef({ tenantId, publicationId: publication.id,
        sharedDriveId: 'fixture-drive', folderId: `folder-${taskId}`, fileId: randomUUID(),
        fileName: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        expectedSha256: options.wrongDriveHash ? '0'.repeat(64) : file.sha256,
        observedSize: file.size, status: 'verified' }, trx);
    }
    if (options.sheet) await repo.recordSheetSync({ tenantId, publicationId: publication.id,
      spreadsheetId: 'fixture-sheet', sheetId: 0, taskId, rowKey: taskId, rowNumber: 1,
      expectedHash: publication.package_sha256,
      observedHash: options.wrongSheetHash ? '0'.repeat(64) : publication.package_sha256,
      status: 'synced' }, trx);
  });
}

describe('authenticated Desk to private lifecycle office decision', () => {
  it('keeps a possible Drive archive open through a failed worker report and a new request-owned run', async () => {
    const { requestId, taskId, approval, store, start } = await approvedForDelivery();
    const first = await projectLifecycleDeliveryStart(db, store, start);
    await withRlsContext(db, scope, async (trx) => {
      const publication = await trx.selectFrom('publications').select('id')
        .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      expect(await new PublicationRepository(trx).markArchiveUnconfirmed({ tenantId,
        publicationId: publication.id, taskId, code: 'DRIVE_IDENTITY_CONFLICT' }, trx)).toBe(true);
    });
    const failed = { outcome: 'failed' as const, uncertain: [], sheetsConfirmed: false,
      archived: false, filesSent: 0, reason: 'PREPARE_FAILED: DRIVE_IDENTITY_CONFLICT' };
    const finish = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: first.delivery.deliveryId, run: 1,
      outcome: failed, expectedRev: 4, rev: 5,
      key: `${requestId}:5:deliveryFinished:${first.delivery.deliveryId}` });
    expect(finish).toMatchObject({ stage: 'delivering', taskState: 'publishing' });
    const desk = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    expect((await (await desk.request(`/v1/tasks/${taskId}`)).json()).status).toBe('ARCHIVE_RECONCILIATION');

    const actionId = randomUUID();
    const second = await projectLifecycleDeliveryStart(db, store, { ...start, actionId,
      expectedRev: 5, rev: 6, key: `${requestId}:6:officeDecision:desk:${actionId}` });
    const stillHeld = await withRlsContext(db, scope, (trx) => trx.selectFrom('publications')
      .select('error_class').where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow());
    expect(stillHeld.error_class).toBe('ARCHIVE_UNCONFIRMED');
    const secondFinish = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: second.delivery.deliveryId, run: 2,
      outcome: failed, expectedRev: 6, rev: 7,
      key: `${requestId}:7:deliveryFinished:${second.delivery.deliveryId}` });
    expect(secondFinish).toMatchObject({ stage: 'delivering', taskState: 'publishing' });
    expect((await (await desk.request(`/v1/tasks/${taskId}`)).json()).status).toBe('ARCHIVE_RECONCILIATION');
  });

  it('commits one Drive upload ID across concurrent database handles before either can upload', async () => {
    const { taskId, artifactId, approval, store, start } = await approvedForDelivery();
    await projectLifecycleDeliveryStart(db, store, start);
    const publication = await withRlsContext(db, scope, (trx) => trx.selectFrom('publications')
      .select(['id', 'package_sha256', 'package_manifest'])
      .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow());
    const packaged = (publication.package_manifest.files as Array<{ name: string; sha256: string }>)[0]!;
    const identity = { tenantId, publicationKey: `pub_key_${taskId}_${approval.approvalId}`,
      taskId, artifactId, packageHash: publication.package_sha256, folderId: `folder-${taskId}`,
      filename: packaged.name, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sha256: packaged.sha256 };
    const otherDb = createDb(process.env.TEST_DATABASE_URL!);
    try {
      const first = new PostgresDriveUploadIdentityStore(db);
      const second = new PostgresDriveUploadIdentityStore(otherDb);
      const [a, b] = await Promise.all([
        first.reserve(identity, async () => `generated-${randomUUID()}`),
        second.reserve(identity, async () => `generated-${randomUUID()}`),
      ]);
      expect(a).toBe(b);
      const rows = await withRlsContext(db, scope, (trx) => sql<{ drive_file_id: string }>`
        SELECT drive_file_id FROM hawa.drive_upload_reservations
        WHERE tenant_id = ${tenantId}::uuid AND publication_id = ${publication.id}::uuid`.execute(trx));
      expect(rows.rows.map((row) => row.drive_file_id)).toEqual([a]);
      expect(await second.reserve(identity, async () => { throw new Error('should not allocate on retry'); })).toBe(a);
      await expect(first.reserve({ ...identity, sha256: 'f'.repeat(64) }, async () => 'never-used'))
        .rejects.toThrow('different bytes or destination');
    } finally {
      await otherDb.destroy();
    }
  });

  it('refuses a delivered report until the stored Drive and Sheet receipts match the claimed package', async () => {
    const { requestId, taskId, approval, store, start } = await approvedForDelivery();
    const claim = await projectLifecycleDeliveryStart(db, store, start);
    const finish = { requestId, tenantId, taskId, approvalId: approval.approvalId,
      deliveryId: claim.delivery.deliveryId, run: 1,
      outcome: { outcome: 'delivered' as const, uncertain: [], archived: true, sheetsConfirmed: true, filesSent: 1 },
      expectedRev: 4, rev: 5, key: `${requestId}:5:deliveryFinished:${claim.delivery.deliveryId}` };
    await expect(projectLifecycleDeliveryFinish(db, finish)).rejects.toThrow(/Drive receipts/);
    await recordClaimedReceipts(taskId, { wrongDriveHash: true });
    await expect(projectLifecycleDeliveryFinish(db, finish)).rejects.toThrow(/Drive receipts/);
    await withRlsContext(db, scope, async (trx) => {
      const publication = await trx.selectFrom('publications').select(['id', 'package_manifest'])
        .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      const file = (publication.package_manifest.files as Array<{ sha256: string }>)[0]!;
      await trx.updateTable('drive_refs').set({ expected_sha256: file.sha256 })
        .where('tenant_id', '=', tenantId).where('publication_id', '=', publication.id).execute();
    });
    await expect(projectLifecycleDeliveryFinish(db, finish)).rejects.toThrow(/Sheet receipt/);
    await recordClaimedReceipts(taskId, { sheet: true, wrongSheetHash: true });
    await expect(projectLifecycleDeliveryFinish(db, finish)).rejects.toThrow(/Sheet receipt/);
    await recordClaimedReceipts(taskId, { sheet: true });
    expect(await projectLifecycleDeliveryFinish(db, finish)).toMatchObject({ stage: 'delivered', taskState: 'complete' });
  });

  it('keeps uncertain requester sends unresolved and refuses a second workflow run', async () => {
    const { requestId, taskId, approval, artifactId, store, start } = await approvedForDelivery();
    const claim = await projectLifecycleDeliveryStart(db, store, start);
    await recordClaimedReceipts(taskId, { sheet: true });
    expect(await projectLifecycleDeliveryStart(db, { ...store, read: async () => { throw new Error('store away'); } }, start)).toEqual(claim);
    await expect(projectLifecycleDeliveryStart(db, store, { ...start, reason: 'changed' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const outcome = { outcome: 'uncertain' as const, uncertain: ['approved file'],
      archived: true, sheetsConfirmed: true, filesSent: 0 };
    const finish = { requestId, tenantId, taskId, approvalId: approval.approvalId,
      deliveryId: claim.delivery.deliveryId, run: 1, outcome, expectedRev: 4, rev: 5,
      key: `${requestId}:5:deliveryFinished:${claim.delivery.deliveryId}` };
    expect(await projectLifecycleDeliveryFinish(db, finish)).toMatchObject({
      stage: 'delivering', taskState: 'publishing', rev: 5 });
    expect(await projectLifecycleDeliveryFinish(db, finish)).toMatchObject({ stage: 'delivering' });
    await expect(projectLifecycleDeliveryFinish(db, { ...finish, outcome: { ...outcome, filesSent: 1 } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const nextAction = randomUUID();
    await expect(projectLifecycleDeliveryStart(db, store, { ...start, actionId: nextAction,
      expectedRev: 5, rev: 6, key: `${requestId}:6:officeDecision:desk:${nextAction}` }))
      .rejects.toMatchObject({ code: 'WRONG_STAGE' });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirst(),
      publication: await trx.selectFrom('publications').select(['error_class', 'executor_finished_run'])
        .where('task_id', '=', taskId).executeTakeFirst(),
    }));
    expect(rows.request).toMatchObject({ stage: 'delivering', rev: '5' });
    expect(rows.task?.state).toBe('publishing');
    expect(rows.publication).toMatchObject({ error_class: 'REQUESTER_SEND_UNCONFIRMED', executor_finished_run: 1 });
    const markKey = `lc:${deliveryBaseId(taskId, approval.approvalId)}:file:${artifactId}:send`;
    await withRlsContext(db, scope, async (trx) => {
      for (const outcome of ['attempted', 'uncertain']) {
        await sql`INSERT INTO hawa.inbox_events
          (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified, received_at)
          VALUES (${tenantId}::uuid, 'telegram_delivery', ${markKey}, ${`telegram_document_${outcome}`},
            ${JSON.stringify({ outcome })}::jsonb, ${`${markKey}:${outcome}`}, true, clock_timestamp())`.execute(trx);
      }
    });
    const desk = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const taskDetail = await desk.request(`/v1/tasks/${taskId}`);
    expect(taskDetail.status).toBe(200);
    expect(await taskDetail.json()).toMatchObject({ status: 'REQUESTER_SEND_RECONCILIATION' });
    const queue = await desk.request('/v1/tasks?statuses=REQUESTER_SEND_RECONCILIATION');
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({ total: 1, items: [expect.objectContaining({ id: taskId,
      status: 'REQUESTER_SEND_RECONCILIATION' })] });
    const sheetQueue = await desk.request('/v1/tasks?statuses=PUBLISH_RECONCILIATION');
    expect((await sheetQueue.json() as { items: Array<{ id: string }> }).items.map((item) => item.id))
      .not.toContain(taskId);
    const state = await desk.request(`/v1/tasks/${taskId}/publication-state`);
    expect(await state.json()).toMatchObject({ state: 'requester_send_reconciliation',
      status: 'REQUESTER_SEND_RECONCILIATION' });
    const evidence = await desk.request(`/v1/tasks/${taskId}/requester-send-evidence`);
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ taskId, requestId, requestRev: 5,
      publicationId: expect.any(String), providerReceipt: 'not_available',
      files: [expect.objectContaining({ artifactId, outcome: 'uncertain', attemptCount: 1 })],
      notice: expect.objectContaining({ outcome: 'not_attempted' }) });
    const viewer = createApp({ db, testAuth: { principal: { role: 'viewer', userId } } });
    expect((await viewer.request(`/v1/tasks/${taskId}/requester-send-evidence`)).status).toBe(403);
    expect((await desk.request(`/v1/tasks/${randomUUID()}/requester-send-evidence`)).status).toBe(404);
  });

  it('does not reopen delivery when a requester file was sent before archive failed', async () => {
    const { requestId, taskId, approval, store, start } = await approvedForDelivery();
    const claim = await projectLifecycleDeliveryStart(db, store, start);
    const result = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: claim.delivery.deliveryId, run: 1,
      outcome: { outcome: 'chat_only', uncertain: [], archived: false, sheetsConfirmed: false, filesSent: 1 },
      expectedRev: 4, rev: 5, key: `${requestId}:5:deliveryFinished:${claim.delivery.deliveryId}` });
    expect(result).toMatchObject({ stage: 'delivering', taskState: 'publishing' });
    const nextAction = randomUUID();
    await expect(projectLifecycleDeliveryStart(db, store, { ...start, actionId: nextAction,
      expectedRev: 5, rev: 6, key: `${requestId}:6:officeDecision:desk:${nextAction}` }))
      .rejects.toMatchObject({ code: 'WRONG_STAGE' });
    const publication = await withRlsContext(db, scope, (trx) => trx.selectFrom('publications')
      .select('error_class').where('task_id', '=', taskId).executeTakeFirst());
    expect(publication?.error_class).toBe('REQUESTER_SEND_UNCONFIRMED');
  });

  it('rechecks approved bytes before claim and retries a missing archive under a new request revision', async () => {
    const { requestId, taskId, approval, store, start } = await approvedForDelivery();
    await expect(projectLifecycleDeliveryStart(db, { ...store,
      read: async () => Buffer.from('changed approved export') }, start))
      .rejects.toMatchObject({ code: 'APPROVAL_EVIDENCE_CHANGED' });
    const before = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select('rev').where('request_id', '=', requestId).executeTakeFirst(),
      publication: await trx.selectFrom('publications').select('id').where('task_id', '=', taskId).executeTakeFirst(),
    }));
    expect(before.request?.rev).toBe('3');
    expect(before.publication).toBeUndefined();
    const first = await projectLifecycleDeliveryStart(db, store, start);
    const chatOnly = { outcome: 'chat_only' as const, uncertain: [], archived: false,
      sheetsConfirmed: false, filesSent: 0 };
    const firstFinish = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: first.delivery.deliveryId,
      run: 1, outcome: chatOnly, expectedRev: 4, rev: 5,
      key: `${requestId}:5:deliveryFinished:${first.delivery.deliveryId}` });
    expect(firstFinish).toMatchObject({ stage: 'approved', taskState: 'approved', rev: 5 });
    const nextAction = randomUUID();
    const second = await projectLifecycleDeliveryStart(db, store, { ...start, actionId: nextAction,
      expectedRev: 5, rev: 6, key: `${requestId}:6:officeDecision:desk:${nextAction}` });
    await recordClaimedReceipts(taskId, { sheet: true });
    expect(second.delivery).toMatchObject({ run: 2, requestRev: 6 });
    expect(second.delivery.deliveryId).toMatch(/:archive:2$/);
    const final = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: second.delivery.deliveryId,
      run: 2, outcome: { outcome: 'delivered', uncertain: [], archived: true,
        sheetsConfirmed: true, filesSent: 1 }, expectedRev: 6, rev: 7,
      key: `${requestId}:7:deliveryFinished:${second.delivery.deliveryId}` });
    expect(final).toMatchObject({ stage: 'delivered', taskState: 'complete', rev: 7 });
  });

  it('shows a request-owned Sheet failure as a staffed retry and completes only the next versioned run', async () => {
    const { requestId, taskId, approval, store, start } = await approvedForDelivery();
    const first = await projectLifecycleDeliveryStart(db, store, start);
    await recordClaimedReceipts(taskId);
    const pendingSheet = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: first.delivery.deliveryId, run: 1,
      outcome: { outcome: 'delivered', uncertain: [], archived: true, sheetsConfirmed: false, filesSent: 1 },
      expectedRev: 4, rev: 5, key: `${requestId}:5:deliveryFinished:${first.delivery.deliveryId}` });
    expect(pendingSheet).toMatchObject({ stage: 'delivering', taskState: 'publishing', rev: 5 });
    const desk = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const pendingTask = await desk.request(`/v1/tasks/${taskId}`);
    expect(pendingTask.status).toBe(200);
    expect(await pendingTask.json()).toMatchObject({ status: 'PUBLISH_RECONCILIATION', requestId });
    const storedPublication = await withRlsContext(db, scope, (trx) => trx.selectFrom('publications')
      .select(['executor', 'error_class']).where('task_id', '=', taskId).executeTakeFirst());
    expect(storedPublication).toMatchObject({ executor: 'restate', error_class: 'SHEET_UNCONFIRMED' });
    const reconciliationQueue = await desk.request('/v1/tasks?statuses=PUBLISH_RECONCILIATION');
    expect(reconciliationQueue.status).toBe(200);
    const queued = await reconciliationQueue.json() as { items: Array<{ id: string; requestId: string; status: string }>; total: number };
    expect(queued).toMatchObject({ total: 1, items: [expect.objectContaining({
      id: taskId, requestId, status: 'PUBLISH_RECONCILIATION' })] });
    const publishingQueue = await desk.request('/v1/tasks?statuses=PUBLISHING');
    expect((await publishingQueue.json() as { items: Array<{ id: string }> }).items.map((item) => item.id))
      .not.toContain(taskId);
    const nextAction = randomUUID();
    const second = await projectLifecycleDeliveryStart(db, store, { ...start, actionId: nextAction,
      expectedRev: 5, rev: 6, key: `${requestId}:6:officeDecision:desk:${nextAction}` });
    await recordClaimedReceipts(taskId, { sheet: true });
    expect(second.delivery).toMatchObject({ run: 2, requestRev: 6 });
    expect(second.delivery.deliveryId).toMatch(/:archive:2$/);
    const finished = await projectLifecycleDeliveryFinish(db, { requestId, tenantId, taskId,
      approvalId: approval.approvalId, deliveryId: second.delivery.deliveryId, run: 2,
      outcome: { outcome: 'delivered', uncertain: [], archived: true, sheetsConfirmed: true, filesSent: 1 },
      expectedRev: 6, rev: 7, key: `${requestId}:7:deliveryFinished:${second.delivery.deliveryId}` });
    expect(finished).toMatchObject({ stage: 'delivered', taskState: 'complete', rev: 7 });
    const finalTask = await desk.request(`/v1/tasks/${taskId}`);
    expect(await finalTask.json()).toMatchObject({ status: 'COMPLETE', requestId });
  });

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
    const bytes = Buffer.from('The checked editable deck bytes for this isolated office review fixture.');
    const pngBytes = Buffer.from('The selected PNG bytes for this isolated RTL sign-off fixture.');
    const artifactId = randomUUID();
    const pngArtifactId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const pngSha256 = createHash('sha256').update(pngBytes).digest('hex');
    const body = { action: 'approve', reason: 'Approved after checking the export',
      pinnedExportIds: [artifactId, pngArtifactId],
      rtlVisualReview: { confirmed: true as const, exportSha256: sha256 } };
    const report = { exportArtifactId: artifactId, exportSha256: sha256, captureVersion: '200',
      rtlVisualReviewRequired: true };
    const reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    const qcRunId = randomUUID();
    const operationId = randomUUID();
    const pngOperationId = randomUUID();
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
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${pngOperationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${userId}, ${'approval-png-' + actionId},
          ${pngSha256}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version},
          ${JSON.stringify({ format: 'png', designUpdatedAt: '200' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes
        (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${pngArtifactId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid,
          ${pngOperationId}::uuid, 'png', ${pngSha256}, ${pngBytes})`.execute(trx);
      await sql`INSERT INTO hawa.qc_runs
        (id, tenant_id, task_id, design_revision_id, qc_profile_id, attempt, status, critical_pass,
          report, report_sha256, started_at)
        VALUES (${qcRunId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid,
          ${firstQc.qc_profile_id}::uuid, 2, 'passed', true, ${JSON.stringify(report)}::jsonb, ${reportHash},
          clock_timestamp() + interval '1 minute')`.execute(trx);
    });
    const store = { captureEvidenceRequired: true,
      verifyCurrentSource: async () => ({ ok: true as const, capturedVersion: '200', observedVersion: '200' }),
      find: async (_tenant: string, _user: string, _task: string, ids: string[]) => [
        { artifactId, format: 'pptx' as const, sha256, byteSize: bytes.length },
        { artifactId: pngArtifactId, format: 'png' as const, sha256: pngSha256, byteSize: pngBytes.length },
      ].filter((item) => ids.includes(item.artifactId)),
      read: async (_tenant: string, _user: string, _task: string, id: string) =>
        id === artifactId ? bytes : id === pngArtifactId ? pngBytes : null,
    };
    expect(parseOfficeApprovalProof({ qcRunId, qcReportHash: reportHash,
      pinnedExports: [{ artifactId, format: 'pptx', sha256, byteSize: bytes.length },
        { artifactId: pngArtifactId, format: 'png', sha256: pngSha256, byteSize: pngBytes.length }],
      rtlVisualReview: body.rtlVisualReview })).not.toBeNull();
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
    expect((await director.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, pinnedExportIds: [artifactId] }) })).status).toBe(412);
    expect((await director.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, rtlVisualReview: undefined }) })).status).toBe(412);
    expect((await director.request(path, { method: 'POST', headers,
      body: JSON.stringify({ ...body, rtlVisualReview: { confirmed: true, exportSha256: pngSha256 } }) })).status).toBe(412);
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
      decision_payload: { canvaBindingId: expect.any(String), canvaBindingVersion: 1,
        canvaDesignId: expect.any(String),
        pinnedExports: [{ artifactId, sha256, byteSize: bytes.length },
        { artifactId: pngArtifactId, sha256: pngSha256, byteSize: pngBytes.length }],
        officeApprovalProof: { rtlVisualReview: body.rtlVisualReview },
        rtlVisualReview: { confirmed: true, qcRunId, exportSha256: sha256, reviewerId: userId } } }]);
    expect(rows.receipts.map((row) => Number(row.rev)).sort()).toEqual([1, 2, 3]);
    expect(transport).toHaveBeenCalledTimes(2);

    // The same approved task starts delivery through a second signed office action. Core claims
    // the publication and request revision together; the object starts only that workflow key.
    const starts: string[] = [];
    object.startDelivery = (input) => { starts.push(input.deliveryId); };
    const publisher = { publish: vi.fn(async (_ctx: unknown, request: any) => ({ ok: true, value: {
      publicationId: randomUUID(), publicationKey: request.publicationKey,
      driveFolderId: request.destination.productionRootFolderId,
      state: 'complete',
      driveFiles: request.files.map((file: any) => ({ artifactId: file.artifactId,
        fileId: `drv_${file.artifactId.slice(0, 8)}`, name: file.filename, mimeType: file.mimeType,
        expectedSha256: file.sha256, observedSize: file.byteSize, verified: true, folderId: 'kaae-owned-folder' })),
      sheet: { spreadsheetId: request.destination.spreadsheetId, sheetId: 0,
        rowKey: request.taskId, rowNumber: 12,
        expectedHash: request.packageHash, observedHash: request.packageHash, synced: true },
    } })) };
    const deliveryInternal = createAppWithClientFixtures({ db, deliverableStore: store,
      publisher, testAuth: { roleHeader: true } } as any);
    await (deliveryInternal as any).clientDnaHydrated;
    const dnaHeaders = { 'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
    const currentDna = await (await deliveryInternal.request(`/v1/clients/${clientId}/dna`, { headers: dnaHeaders })).json();
    const savedDna = await deliveryInternal.request(`/v1/clients/${clientId}/dna`, {
      method: 'POST', headers: dnaHeaders,
      body: JSON.stringify({ ...currentDna, destinations: { ...(currentDna.destinations || {}),
        productionFolderId: 'kaae-owned-folder', spreadsheetId: 'kaae-owned-sheet' } }),
    });
    expect([200, 201]).toContain(savedDna.status);
    const deliveryCore = { post: async <T>(path: string, payload: unknown): Promise<T> => {
      const answer = await deliveryInternal.request(`/v1${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
      if (!answer.ok) throw new Error(`Core delivery projection HTTP ${answer.status}: ${await answer.text()}`);
      return answer.json() as Promise<T>;
    } };
    let loseDeliveryAnswer = true;
    const deliveryTransport = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://restate.fixture:8080/OfficeDecisionGateway/decide');
      const envelope = JSON.parse(String(init?.body)) as SignedOfficeDecision;
      expect(checkSignedOfficeDecision(envelope, secret)).toBe('ok');
      if (envelope.event.kind !== 'deliver') return Response.json({ detail: 'wrong event' }, { status: 400 });
      const result = await recordOfficeDeliveryStart(object, deliveryCore, envelope.event);
      if (loseDeliveryAnswer) { loseDeliveryAnswer = false; throw new Error('Delivery answer lost after commit'); }
      return Response.json(result);
    });
    vi.stubGlobal('fetch', deliveryTransport);
    const deliveryActionId = randomUUID();
    const deliveryPath = `/v1/tasks/${taskId}/publish`;
    const deliveryHeaders = { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryActionId };
    const deliveryBody = { destination: 'google_drive', approvalId: result.decisionId };
    expect((await operator.request(deliveryPath, { method: 'POST', headers: deliveryHeaders,
      body: JSON.stringify(deliveryBody) })).status).toBe(403);
    const lost = await director.request(deliveryPath, { method: 'POST', headers: deliveryHeaders,
      body: JSON.stringify(deliveryBody) });
    expect(lost.status, await lost.text()).toBe(503);
    const resumed = createApp({ db, testAuth: { principal: { role: 'art_director', userId } } });
    const retry = await resumed.request(deliveryPath, { method: 'POST', headers: deliveryHeaders,
      body: JSON.stringify(deliveryBody) });
    expect(retry.status, await retry.text()).toBe(202);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(1);
    expect(state.stage).toBe('delivering');
    const claimed = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state']).where('id', '=', taskId).executeTakeFirst(),
      publication: await trx.selectFrom('publications').select(['executor', 'executor_run', 'executor_finished_run'])
        .where('task_id', '=', taskId).executeTakeFirst(),
    }));
    expect(claimed.request).toMatchObject({ stage: 'delivering', rev: '4' });
    expect(claimed.task?.state).toBe('publishing');
    expect(claimed.publication).toMatchObject({ executor: 'restate', executor_run: 1, executor_finished_run: 0 });
    const delivery = state.delivery!.input;
    await expect(runDelivery({
      run: async () => { throw new Error('no prepare should run'); },
      send: async () => { throw new Error('no send should run'); },
      reportLifecycle: async () => { throw new Error('no report should run'); },
    }, deliveryCore, { ...delivery, chatId: '1234567' })).rejects.toThrow('INVALID_LIFECYCLE_DELIVERY_CLAIM');
    const invalidPrepare = await deliveryInternal.request(
      `/v1/internal/lifecycle/${requestId}/deliveries/${delivery.approvalId}/prepare`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, tenantId, deliveryId: delivery.deliveryId, run: 1 }),
      });
    expect(invalidPrepare.status).toBe(409);
    const sent: string[] = [];
    const delivered = await runDelivery({
      run: (_name, action) => action(),
      send: async (message) => { sent.push(message.kind); return { outcome: 'sent', messageId: String(sent.length) }; },
      reportLifecycle: async (_input, outcome) => recordDeliveryFinished(object, deliveryCore, {
        v: 1, eventId: `delivery:${delivery.deliveryId}`, requestId, taskId,
        approvalId: result.decisionId as string, deliveryId: delivery.deliveryId,
        run: 1, expectedRev: 4, outcome,
      }),
    }, deliveryCore, delivery);
    expect(delivered).toMatchObject({ outcome: 'delivered', archived: true, sheetsConfirmed: true, filesSent: 2 });
    expect(sent).toEqual(['document', 'document', 'text']);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const finishedEvent = { v: 1 as const, eventId: `delivery:${delivery.deliveryId}`,
      requestId, taskId, approvalId: result.decisionId as string, deliveryId: delivery.deliveryId,
      run: 1, expectedRev: 4, outcome: delivered };
    const finished = await recordDeliveryFinished(object, deliveryCore, finishedEvent);
    expect(finished).toMatchObject({ stage: 'delivered', taskState: 'complete', rev: 5 });
    expect(await recordDeliveryFinished(object, deliveryCore, finishedEvent)).toEqual(finished);
    await expect(recordDeliveryFinished(object, deliveryCore, { ...finishedEvent,
      outcome: { ...delivered, filesSent: 1 } })).rejects.toThrow(/different content/);
    const completed = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['stage', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      task: await trx.selectFrom('tasks').select(['state']).where('id', '=', taskId).executeTakeFirst(),
      publication: await trx.selectFrom('publications').select(['state', 'executor_finished_run'])
        .where('task_id', '=', taskId).executeTakeFirst(),
      revisions: await trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute(),
    }));
    expect(completed.request).toMatchObject({ stage: 'delivered', rev: '5' });
    expect(completed.task?.state).toBe('complete');
    expect(completed.publication).toMatchObject({ state: 'complete', executor_finished_run: 1 });
    expect(completed.revisions.map((row) => Number(row.rev)).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
