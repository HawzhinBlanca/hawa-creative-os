import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createDb, PublicationRepository, TaskRepository, sql, withRlsContext } from '@hawa/db';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { GooglePublisher } from '@hawa/integrations';
import { startFakeDriveServer, type FakeDriveServer } from '../../../packages/integrations/test/fake-drive-server.js';
import { startFakeDrive } from '../../../packages/integrations/test/fake-drive.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

describe('R06: Publication Restart-Safety, Concurrency & Row Safety (FR-045–050, FR-059–060, NFR-001, NFR-014, NFR-020)', () => {
  const originalEnv = { ...process.env };
  let fakeServer: FakeDriveServer;
  const operatorHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test_bearer',
  };
  const reviewerHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test_bearer',
    'x-user-role': 'art_director',
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-r06-test-'));
  const testFilePng = path.join(tempDir, 'story.png');
  const testFileBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const testFileSha256 = crypto.createHash('sha256').update(testFileBytes).digest('hex');
  fs.writeFileSync(testFilePng, testFileBytes);

  beforeAll(async () => {
    fakeServer = await startFakeDriveServer();
    process.env.GOOGLE_DRIVE_API_BASE_URL = fakeServer.url;
    process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL = fakeServer.url;
    process.env.GOOGLE_SHEETS_API_BASE_URL = fakeServer.url;
    process.env.GOOGLE_OAUTH_TOKEN = ['test', 'local', 'token'].join('_');
  });

  afterAll(async () => {
    if (fakeServer) await fakeServer.close();
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createApprovedTaskWithExport(app: ReturnType<typeof createApp>, exports: ReturnType<typeof memoryExportStore>) {
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...operatorHeaders, 'Idempotency-Key': `r06-task-${Date.now()}-${crypto.randomUUID()}` },
      body: JSON.stringify({
        title: 'Safe Publication Task',
        clientId: 'c1000000-0000-4000-8000-000000000003',
      }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json();

    const revRes = await app.request(`/v1/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Verified Deliverable' }],
      }),
    });
    expect(revRes.status).toBe(201);
    const rev = await revRes.json();

    // Passing QA
    const qaRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/qa`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    expect(qaRes.status).toBe(200);

    // Pinned export
    const exportId = exports.add(task.id, 'png', testFileBytes);

    // Approve
    const approveRes = await app.request(`/v1/tasks/${task.id}/revisions/${rev.id}/decisions`, {
      method: 'POST',
      headers: reviewerHeaders,
      body: JSON.stringify({
        action: 'approve',
        pinnedExportIds: [exportId],
      }),
    });
    expect(approveRes.status).toBe(201);
    const approval = await approveRes.json();

    return { task, rev, approval, exportId };
  }

  it('1. Concurrent same-key publication calls return identical receipt with zero duplicate side-effects', async () => {
    const exports = memoryExportStore();
    const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true },  deliverableStore: exports.store });
    const { task, rev, approval } = await createApprovedTaskWithExport(app, exports);

    // Fire 3 simultaneous publish requests with identical publication intent
    const payload = JSON.stringify({
      designRevisionId: rev.id,
      approvalId: approval.decisionId,
    });

    const [res1, res2, res3] = await Promise.all([
      app.request(`/v1/tasks/${task.id}/publish-omnichannel`, { method: 'POST', headers: operatorHeaders, body: payload }),
      app.request(`/v1/tasks/${task.id}/publish-omnichannel`, { method: 'POST', headers: operatorHeaders, body: payload }),
      app.request(`/v1/tasks/${task.id}/publish-omnichannel`, { method: 'POST', headers: operatorHeaders, body: payload }),
    ]);

    // One press delivers. A press that arrives while it runs is refused and told to retry, by the
    // publish advisory lock (Postgres), which holds across processes; a press that arrives after it
    // is answered from the stored publication. None of them uploads again. Presses in one process
    // used to join the first through a map in memory, which a second process never saw.
    const answers = await Promise.all([res1, res2, res3].map(async (res) => ({ status: res.status, body: await res.json() })));
    const delivered = answers.filter((a) => a.status === 200);
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    for (const refused of answers.filter((a) => a.status !== 200)) {
      expect(refused.status).toBe(409);
      expect(refused.body.detail).toMatch(/delivery of this task is running right now/);
    }
    const fresh = delivered.find((a) => a.body.alreadyCompleted !== true && a.body.publicationReceipt.driveFiles.length > 0)!;
    expect(fresh.body.status).toBe('COMPLETE');
    expect(fresh.body.publicationReceipt.driveFiles).toHaveLength(1);

    // Pressing again returns the same receipt, read back from Postgres, with the same one file.
    const again = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, { method: 'POST', headers: operatorHeaders, body: payload });
    expect(again.status).toBe(200);
    const againBody = await again.json();
    expect(againBody.status).toBe('COMPLETE');
    expect(againBody.publicationReceipt.publicationId).toBe(fresh.body.publicationReceipt.publicationId);
    expect(againBody.publicationReceipt.driveFiles.map((f: { fileId: string }) => f.fileId))
      .toEqual(fresh.body.publicationReceipt.driveFiles.map((f: { fileId: string }) => f.fileId));
    for (const other of delivered) expect(other.body.publicationReceipt.publicationId).toBe(fresh.body.publicationReceipt.publicationId);

    // A repeated repository completion is also idempotent, including its task event/version.
    await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, async (trx) => {
      const publicationId = String(fresh.body.publicationReceipt.publicationId);
      const before = (await sql<{ version: number }>`SELECT version FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].version;
      await new PublicationRepository(testDb).markComplete({ tenantId: task.tenantId, taskId: task.id, publicationId }, trx);
      const after = (await sql<{ version: number }>`SELECT version FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].version;
      expect(after).toBe(before);
      await expect(new PublicationRepository(testDb).markComplete({ tenantId: task.tenantId,
        taskId: crypto.randomUUID(), publicationId }, trx)).rejects.toThrow();
    });
  });

  it('does not complete a task cancelled after the Drive upload but before receipt commit', async () => {
    const exports = memoryExportStore();
    const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true }, deliverableStore: exports.store });
    const { task, rev, approval } = await createApprovedTaskWithExport(app, exports);
    const original = PublicationRepository.prototype.recordDriveRef;
    const record = vi.spyOn(PublicationRepository.prototype, 'recordDriveRef').mockImplementationOnce(async (params, trx) => {
      await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (cancelTrx) =>
        new TaskRepository(testDb).transitionState({ taskId: task.id, tenantId: task.tenantId,
          fromState: 'publishing', toState: 'cancelled', actorType: 'user', actorId: '00000000-0000-4000-b000-000000000001',
          reason: 'Requester cancelled while Drive was finishing' }, cancelTrx));
      return original.call(new PublicationRepository(testDb), params, trx);
    });
    try {
      const response = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
        method: 'POST', headers: operatorHeaders,
        body: JSON.stringify({ designRevisionId: rev.id, approvalId: approval.decisionId }),
      });
      expect(response.status).toBe(503);
      const state = await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, async (trx) => ({
        task: (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].state,
        publication: (await sql<{ state: string; error_class: string }>`SELECT state, error_class FROM hawa.publications WHERE task_id = ${task.id}::uuid`.execute(trx)).rows[0],
        driveRefs: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.drive_refs WHERE publication_id IN
          (SELECT id FROM hawa.publications WHERE task_id = ${task.id}::uuid)`.execute(trx)).rows[0].n,
        notifications: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands
          WHERE aggregate_id = ${task.id}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].n,
      }));
      expect(state).toEqual({ task: 'cancelled', publication: { state: 'pending', error_class: 'ARCHIVE_UNCONFIRMED' }, driveRefs: 0, notifications: 0 });
      const publicationState = await (await app.request(`/v1/tasks/${task.id}/publication-state`, { headers: operatorHeaders })).json();
      expect(publicationState).toMatchObject({ status: 'CANCELLED', state: 'archive_reconciliation',
        notification: { status: 'not_enqueued' } });
      expect(publicationState.actionableRecovery).toMatch(/do not retry requester delivery/i);
      const audit = await (await app.request('/v1/operations/reconciliation/run', {
        method: 'POST', headers: operatorHeaders, body: '{}',
      })).json();
      expect(audit.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({
        taskId: task.id, kind: 'ARCHIVE_OUTCOME_UNCONFIRMED', severity: 'high',
      })]));
      const repeated = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
        method: 'POST', headers: operatorHeaders,
        body: JSON.stringify({ designRevisionId: rev.id, approvalId: approval.decisionId }),
      });
      expect(repeated.status).toBe(409);
    } finally {
      record.mockRestore();
    }
  });

  it.each([
    ['empty Drive receipt', (receipt: any) => { receipt.driveFiles = []; }],
    ['changed Drive checksum', (receipt: any) => { receipt.driveFiles[0].expectedSha256 = '0'.repeat(64); }],
    ['extra Drive receipt', (receipt: any) => { receipt.driveFiles.push({ ...receipt.driveFiles[0], artifactId: crypto.randomUUID() }); }],
    ['wrong Sheet task identity', (receipt: any) => { receipt.sheet.rowKey = crypto.randomUUID(); }],
    ['Sheet without row identity', (receipt: any) => { delete receipt.sheet.rowNumber; }],
    ['non-boolean Sheet sync', (receipt: any) => { receipt.sheet.synced = 'true'; }],
    ['emulated success', (receipt: any) => { receipt.emulated = true; }],
  ])('refuses a publisher claiming completion with %s', async (_case, alter) => {
    const exports = memoryExportStore();
    const publisher = { publish: vi.fn(async (_ctx: unknown, request: any) => {
      const receipt: any = {
        publicationId: crypto.randomUUID(), publicationKey: request.publicationKey,
        driveFolderId: request.destination.productionRootFolderId, state: 'complete',
        driveFiles: request.files.map((file: any) => ({ artifactId: file.artifactId,
          fileId: `fake_${file.artifactId}`, folderId: request.destination.productionRootFolderId,
          name: file.filename, mimeType: file.mimeType, expectedSha256: file.sha256,
          observedSize: file.byteSize, verified: true })),
        sheet: { spreadsheetId: request.destination.spreadsheetId, sheetId: 0, rowKey: request.taskId,
          rowNumber: 7, expectedHash: request.packageHash, observedHash: request.packageHash, synced: true },
        detail: { verified: true, filesUploaded: request.files.length },
      };
      alter(receipt);
      return { ok: true, value: receipt };
    }) };
    const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true },
      deliverableStore: exports.store, publisher: publisher as any });
    const { task, rev, approval } = await createApprovedTaskWithExport(app, exports);
    const response = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ designRevisionId: rev.id, approvalId: approval.decisionId }),
    });
    expect(response.status).toBe(409);
    const stored = await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, async (trx) => ({
      task: (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].state,
      pub: (await sql<{ state: string; error_class: string }>`SELECT state, error_class FROM hawa.publications WHERE task_id = ${task.id}::uuid`.execute(trx)).rows[0],
      refs: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.drive_refs WHERE publication_id IN
        (SELECT id FROM hawa.publications WHERE task_id = ${task.id}::uuid)`.execute(trx)).rows[0].n,
      notifications: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands
        WHERE aggregate_id = ${task.id}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].n,
    }));
    expect(stored).toEqual({ task: 'publishing', pub: { state: 'pending', error_class: 'ARCHIVE_UNCONFIRMED' }, refs: 0, notifications: 0 });
  });

  it('holds requester delivery after a lost Drive reply, then reconciles the same reserved file', async () => {
    const drive = await startFakeDrive();
    const previous = {
      api: process.env.GOOGLE_DRIVE_API_BASE_URL,
      upload: process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL,
      sheets: process.env.GOOGLE_SHEETS_API_BASE_URL,
      oauth: process.env.GOOGLE_OAUTH_TOKEN,
      serviceKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      gcpKey: process.env.GCP_PRIVATE_KEY,
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    };
    try {
      process.env.GOOGLE_DRIVE_API_BASE_URL = drive.base;
      process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL = drive.base;
      process.env.GOOGLE_SHEETS_API_BASE_URL = drive.base;
      const exports = memoryExportStore();
      const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true }, deliverableStore: exports.store });
      const { task, rev, approval } = await createApprovedTaskWithExport(app, exports);
      const payload = JSON.stringify({ designRevisionId: rev.id, approvalId: approval.decisionId });
      const deliver = () => app.request(`/v1/tasks/${task.id}/publish-omnichannel`,
        { method: 'POST', headers: operatorHeaders, body: payload });

      drive.fault.dropUploadReply = 1;
      const uncertain = await deliver();
      expect(uncertain.status).toBe(503);
      expect(await uncertain.json()).toMatchObject({ title: 'Publish Error' });
      expect(drive.files).toHaveLength(1);

      const before = await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
        async (trx) => ({
          state: (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].state,
          notifications: (await sql<{ count: number }>`SELECT count(*)::int AS count FROM hawa.outbox_commands WHERE aggregate_id = ${task.id}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].count,
        }));
      expect(before).toEqual({ state: 'publishing', notifications: 0 });
      const unresolved = await (await app.request(`/v1/tasks/${task.id}/publication-state`, { headers: operatorHeaders })).json();
      expect(unresolved).toMatchObject({ status: 'ARCHIVE_RECONCILIATION', state: 'archive_reconciliation',
        driveFiles: { verified: false, count: 0 }, notification: { status: 'not_enqueued' } });
      const archiveQueue = await (await app.request('/v1/tasks?statuses=ARCHIVE_RECONCILIATION', { headers: operatorHeaders })).json();
      expect(archiveQueue.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, status: 'ARCHIVE_RECONCILIATION' })]));
      expect((await (await app.request('/v1/tasks?statuses=PUBLISHING', { headers: operatorHeaders })).json()).items)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id })]));
      const audit = await (await app.request('/v1/operations/reconciliation/run', {
        method: 'POST', headers: operatorHeaders, body: '{}',
      })).json();
      expect(audit.totalTasksAudited).toBeGreaterThan(0);
      expect(audit.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({
        taskId: task.id, kind: 'ARCHIVE_OUTCOME_UNCONFIRMED', severity: 'high',
      })]));

      // The first upload may have committed. Losing the office credential before the next press
      // must not turn that unresolved archive into a claim that Drive has no file.
      delete process.env.GOOGLE_OAUTH_TOKEN;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      delete process.env.GCP_PRIVATE_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const disconnected = await deliver();
      expect(disconnected.status).toBe(503);
      expect((await disconnected.json()).detail).toMatch(/archive may already exist/i);
      const afterDisconnect = await withRlsContext(testDb, { tenantId: task.tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
        async (trx) => ({
          state: (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${task.id}::uuid`.execute(trx)).rows[0].state,
          notifications: (await sql<{ count: number }>`SELECT count(*)::int AS count FROM hawa.outbox_commands WHERE aggregate_id = ${task.id}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].count,
        }));
      expect(afterDisconnect).toEqual({ state: 'publishing', notifications: 0 });
      expect((await (await app.request(`/v1/tasks/${task.id}`, { headers: operatorHeaders })).json()).status)
        .toBe('ARCHIVE_RECONCILIATION');
      if (previous.oauth === undefined) delete process.env.GOOGLE_OAUTH_TOKEN;
      else process.env.GOOGLE_OAUTH_TOKEN = previous.oauth;

      drive.fault.hideSearches = 1;
      const retried = await deliver();
      expect(retried.status).toBe(202);
      const body = await retried.json();
      expect(body.status).toBe('PUBLISH_RECONCILIATION'); // fake Drive cannot confirm a Sheet row
      expect(body.publicationReceipt.driveFiles[0]).toMatchObject({ fileId: drive.files[0].id, verified: true });
      expect(drive.generatedIdsIssued).toBe(1);
      expect(drive.files).toHaveLength(1);
      expect((await (await app.request(`/v1/tasks/${task.id}`, { headers: operatorHeaders })).json()).status)
        .toBe('PUBLISH_RECONCILIATION');
      expect((await (await app.request('/v1/tasks?statuses=ARCHIVE_RECONCILIATION', { headers: operatorHeaders })).json()).items)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id })]));
    } finally {
      if (previous.api === undefined) delete process.env.GOOGLE_DRIVE_API_BASE_URL;
      else process.env.GOOGLE_DRIVE_API_BASE_URL = previous.api;
      if (previous.upload === undefined) delete process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL;
      else process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL = previous.upload;
      if (previous.sheets === undefined) delete process.env.GOOGLE_SHEETS_API_BASE_URL;
      else process.env.GOOGLE_SHEETS_API_BASE_URL = previous.sheets;
      if (previous.oauth === undefined) delete process.env.GOOGLE_OAUTH_TOKEN;
      else process.env.GOOGLE_OAUTH_TOKEN = previous.oauth;
      if (previous.serviceKey === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = previous.serviceKey;
      if (previous.gcpKey === undefined) delete process.env.GCP_PRIVATE_KEY;
      else process.env.GCP_PRIVATE_KEY = previous.gcpKey;
      if (previous.keyFile === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous.keyFile;
      await drive.close();
    }
  });

  it('2. Both API routes (/publish and /publish-omnichannel) use unified publication ledger', async () => {
    const exports = memoryExportStore();
    const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true },  deliverableStore: exports.store });
    const { task, rev, approval, exportId } = await createApprovedTaskWithExport(app, exports);

    // Call desk /publish route
    const publishRes = await app.request(`/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({}),
    });
    expect(publishRes.status).toBe(202);
    const pubData = await publishRes.json();
    expect(pubData.receipt.driveFiles).toHaveLength(1);
    expect(pubData.receipt.driveFiles[0].artifactId).toBe(exportId);

    // Call omnichannel publish route on same task & approval: returns idempotent receipt
    const omniRes = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        designRevisionId: rev.id,
        approvalId: approval.decisionId,
      }),
    });
    expect(omniRes.status).toBe(200);
    const omniData = await omniRes.json();
    expect(omniData.ok).toBe(true);
    expect(omniData.status).toBe('COMPLETE');
  });

  it('3. Sheets row updates verify immutable task identity and never overwrite shifted/moved/inserted rows', async () => {
    const publisher = new GooglePublisher();
    const spreadsheetId = 'sheet_test_row_identity';
    fakeServer.setSheetRows(spreadsheetId, [
      ['Task ID', 'Client ID', 'Folder ID', 'Date', 'Status', 'Link', 'Hash'],
    ]);
    const ctx: RequestContext = {
      tenantId: 'tenant-default',
      taskId: 'task-a',
      actor: { type: 'workflow', id: 'test' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 60000).toISOString(),
    };

    // 1. Initial publication of Task A
    const reqA: PublishRequest = {
      taskId: 'task-a',
      clientId: 'client-1',
      designRevisionId: 'rev-a',
      approvalId: 'app-a',
      publicationKey: 'pub_a',
      packageHash: 'hash-a',
      files: [{
        artifactId: 'art-a',
        filename: 'a.png',
        mimeType: 'image/png',
        byteSize: testFileBytes.length,
        sha256: testFileSha256,
        content: testFileBytes,
      }],
      destination: {
        sharedDriveId: 'drive-1',
        productionRootFolderId: 'folder-1',
        spreadsheetId,
      },
    };
    const resA = await publisher.publish(ctx, reqA);
    expect(resA.ok).toBe(true);
    if (!resA.ok) return;
    expect(resA.value.sheet.rowNumber).toBe(2);

    // 2. Publication of Task B
    const reqB: PublishRequest = {
      ...reqA,
      taskId: 'task-b',
      publicationKey: 'pub_b',
      packageHash: 'hash-b',
    };
    const resB = await publisher.publish(ctx, reqB);
    expect(resB.ok).toBe(true);
    if (!resB.ok) return;
    expect(resB.value.sheet.rowNumber).toBe(3);

    // Inspect sheet: row 2 is Task A, row 3 is Task B
    let sheetRows = fakeServer.getSheetRows(spreadsheetId);
    expect(sheetRows).toHaveLength(3);
    expect(sheetRows[1][0]).toBe('task-a');
    expect(sheetRows[2][0]).toBe('task-b');

    // 3. Simulate an external user inserting an unrelated task or shifting rows in the Sheet!
    // Row 2 is now an unrelated task! Task A was shifted down to row 3, Task B to row 4!
    fakeServer.setSheetRows(spreadsheetId, [
      ['Task ID', 'Client ID', 'Folder ID', 'Date', 'Status', 'Link', 'Hash'],
      ['task-unrelated-external', 'client-x', 'folder-x', 'date', 'COMPLETE', 'link', 'hash-x'],
      sheetRows[1], // task-a moved to row 3
      sheetRows[2], // task-b moved to row 4
    ]);

    // 4. Update/re-publish Task A with a new package hash
    const reqA2: PublishRequest = {
      ...reqA,
      packageHash: 'hash-a-updated',
      publicationKey: 'pub_a_updated',
    };
    const resA2 = await publisher.publish(ctx, reqA2);
    expect(resA2.ok).toBe(true);
    if (!resA2.ok) return;

    // Verify: Task A was updated at its actual row (row 3) by immutable task identity!
    // Row 2 (task-unrelated-external) was NOT overwritten!
    sheetRows = fakeServer.getSheetRows(spreadsheetId);
    expect(sheetRows[1][0]).toBe('task-unrelated-external');
    expect(sheetRows[1][6]).toBe('hash-x'); // Unrelated row untouched!
    expect(sheetRows[2][0]).toBe('task-a');
    expect(sheetRows[2][6]).toBe('hash-a-updated'); // Task A updated!
    expect(sheetRows[3][0]).toBe('task-b'); // Task B untouched!

    // The cached Task A row can become blank after a user inserts or clears a row. Blank is
    // not proof of task identity: find Task A again instead of overwriting the blank row.
    fakeServer.setSheetRows(spreadsheetId, [sheetRows[0], sheetRows[1], ['', '', '', '', '', '', ''],
      sheetRows[2], sheetRows[3]]);
    const resA3 = await publisher.publish(ctx, { ...reqA, packageHash: 'hash-a-third', publicationKey: 'pub_a_third' });
    expect(resA3.ok).toBe(true);
    if (!resA3.ok) return;
    expect(resA3.value.sheet.rowNumber).toBe(4);
    sheetRows = fakeServer.getSheetRows(spreadsheetId);
    expect(sheetRows[2][0]).toBe('');
    expect(sheetRows[3][0]).toBe('task-a');
    expect(sheetRows[3][6]).toBe('hash-a-third');
    expect(sheetRows[4][0]).toBe('task-b');
  });

  it('4. Deliverable checksum mismatch strictly halts publication with PUBLICATION_VERIFICATION_FAILED', async () => {
    const publisher = new GooglePublisher();
    const ctx: RequestContext = {
      tenantId: 'tenant-default',
      taskId: 'task-tampered',
      actor: { type: 'workflow', id: 'test' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 60000).toISOString(),
    };

    const req: PublishRequest = {
      taskId: 'task-tampered',
      clientId: 'client-1',
      designRevisionId: 'rev-tampered',
      approvalId: 'app-tampered',
      publicationKey: 'pub_tampered',
      packageHash: 'package-hash',
      files: [{
        artifactId: 'art-1',
        filename: 'banner.png',
        mimeType: 'image/png',
        byteSize: testFileBytes.length,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000', // Forged hash
        content: testFileBytes,
      }],
      destination: {
        sharedDriveId: 'drive-1',
        productionRootFolderId: 'folder-1',
        spreadsheetId: 'sheet-1',
      },
    };

    const res = await publisher.publish(ctx, req);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('PUBLICATION_VERIFICATION_FAILED');
  });

  it('5. Unconfirmed Sheets write leaves task in PUBLISH_RECONCILIATION; retry completes without re-upload', async () => {
    const exports = memoryExportStore();
    const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true },
      deliverableStore: exports.store,
      publisher: new GooglePublisher({
        sheetsApiBaseUrl: 'http://127.0.0.1:1', // Simulated unreachable Sheets server
      }),
    });

    const { task, rev, approval } = await createApprovedTaskWithExport(app, exports);

    // In a test with simulated sheets failure or unconfigured sheet:
    // Publish omnichannel when client has no spreadsheet configured
    const clientRes = await app.request(`/v1/clients/${task.clientId}/dna`, { headers: operatorHeaders });
    const clientDna = await clientRes.json();
    delete clientDna.destinations.spreadsheetId;
    await app.request(`/v1/clients/${task.clientId}/dna`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify(clientDna),
    });

    const pubRes = await app.request(`/v1/tasks/${task.id}/publish-omnichannel`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        designRevisionId: rev.id,
        approvalId: approval.decisionId,
      }),
    });
    // Partial delivery: 202 status and state PUBLISH_RECONCILIATION
    expect(pubRes.status).toBe(202);
    const pubData = await pubRes.json();
    expect(pubData.complete).toBe(false);
    expect(pubData.publicationReceipt.state).toBe('drive_complete');

    // Postgres has no PUBLISH_RECONCILIATION task state: the task stays 'publishing' there, and the
    // publication (drive_complete, no synced row) is what says the Sheets row is still owed.
    const pubState = await (await app.request(`/tasks/${task.id}/publication-state`, { headers: operatorHeaders })).json();
    expect(pubState.state).toBe('publish_reconciliation');
    expect(pubState.driveFiles).toMatchObject({ verified: true, count: 1 });
    expect(pubState.sheetSync.synced).toBe(false);
  });
});
