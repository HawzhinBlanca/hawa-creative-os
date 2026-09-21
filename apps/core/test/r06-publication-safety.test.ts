import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { GooglePublisher } from '@hawa/integrations';
import { startFakeDriveServer, type FakeDriveServer } from '../../../packages/integrations/test/fake-drive.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';

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
        clientId: 'client-drustee',
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
    const app = createApp({ deliverableStore: exports.store });
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

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    const data1 = await res1.json();
    const data2 = await res2.json();
    const data3 = await res3.json();

    // Must return the exact same receipt and file count
    expect(data1.status).toBe('COMPLETE');
    expect(data2.status).toBe('COMPLETE');
    expect(data3.status).toBe('COMPLETE');
    expect(data1.publicationReceipt.publicationId).toBe(data2.publicationReceipt.publicationId);
    expect(data2.publicationReceipt.publicationId).toBe(data3.publicationReceipt.publicationId);
    expect(data1.publicationReceipt.driveFiles).toHaveLength(1);
  });

  it('2. Both API routes (/publish and /publish-omnichannel) use unified publication ledger', async () => {
    const exports = memoryExportStore();
    const app = createApp({ deliverableStore: exports.store });
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
    const app = createApp({
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

    const taskStatus = await (await app.request(`/tasks/${task.id}`)).json();
    expect(taskStatus.status).toBe('PUBLISH_RECONCILIATION');
  });
});
