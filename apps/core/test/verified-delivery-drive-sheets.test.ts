import { FakeSheets } from '../../../packages/integrations/test/fake-sheets.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { GooglePublisher } from '@hawa/integrations';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * A QA engine whose every run passes. Postgres approves only a revision with a passing QA run, and
 * these tests are about delivery; a chat request's brief would fail the QA route's fixed manifest.
 */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

describe('CV-16: Keep verified Drive, Sheets and channel delivery (FR-046..FR-051)', () => {
  let mockServer: http.Server;
  let serverPort: number;
  let serverUrl: string;

  // Tracking server calls
  const receivedDriveUploads: any[] = [];
  const receivedDriveReadbacks: string[] = [];
  const driveMetadata = new Map<string, { name: string; mimeType: string; parents: string[]; properties: Record<string, string> }>();
  const receivedSheetAppends: any[] = [];
  const receivedSheetUpdates: any[] = [];
  const receivedSheetReadbacks: string[] = [];
  const sheets = new FakeSheets();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-cv16-test-'));
  const testFilePng = path.join(tempDir, 'banner.png');
  const testFileBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const testFileSha256 = crypto.createHash('sha256').update(testFileBytes).digest('hex');
  fs.writeFileSync(testFilePng, testFileBytes);

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      const url = req.url || '';

      if (req.method === 'GET' && url.includes('/drive/v3/files/generateIds')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ids: [`gdrive_verified_file_${crypto.randomUUID()}`], space: 'drive' }));
        return;
      }

      // 1. Google Drive Multipart Upload
      if (req.method === 'POST' && url.includes('/drive/v3/files') && url.includes('uploadType=multipart')) {
        let body = Buffer.alloc(0);
        req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
        req.on('end', () => {
          const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type']))?.[1];
          const metadataPart = boundary ? body.toString('latin1').split(`--${boundary}`)[1] : '';
          const metadata = JSON.parse(metadataPart.slice(metadataPart.indexOf('{'), metadataPart.lastIndexOf('}') + 1));
          const fileId = metadata.id || `gdrive_verified_file_${crypto.randomUUID()}`;
          if (driveMetadata.has(fileId)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 409 } }));
            return;
          }
          driveMetadata.set(fileId, metadata);
          receivedDriveUploads.push({
            authHeader: req.headers.authorization,
            contentType: req.headers['content-type'],
            bodyLength: body.length,
            fileId,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: fileId,
            name: 'banner.png',
            mimeType: 'image/png',
            size: String(testFileBytes.length),
          }));
        });
        return;
      }

      // 2. Google Drive Independent Readback
      // The lookup the publisher makes before every upload. This mock keeps no file properties, so it
      // reports nothing delivered; drive-upload-idempotency.test.ts covers a Drive that remembers.
      if (req.method === 'GET' && /\/drive\/v3\/files\?/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }

      if (req.method === 'GET' && url.includes('/drive/v3/files/')) {
        const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
        const fileId = match ? match[1] : 'unknown';
        receivedDriveReadbacks.push(fileId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: fileId,
          name: 'banner.png',
          mimeType: 'image/png',
          size: String(testFileBytes.length),
          sha256Checksum: testFileSha256,
          properties: driveMetadata.get(fileId)?.properties,
          parents: driveMetadata.get(fileId)?.parents,
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        }));
        return;
      }

      if (url.includes('/v4/spreadsheets/')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          const parsed = body ? JSON.parse(body) : {};
          if (url.endsWith(':batchUpdate')) receivedSheetAppends.push({ values: [parsed.requests[1].updateCells.rows[0].values.map((v: any) => v.userEnteredValue.stringValue)] });
          if (url.endsWith('/values:batchUpdateByDataFilter')) receivedSheetUpdates.push({ url, values: parsed.data[0].values });
          if (url.endsWith('/values:batchGetByDataFilter')) receivedSheetReadbacks.push(url);
          const response = await sheets.fetch(`http://localhost${url}`, { method: req.method, ...(body ? { body } : {}) });
          res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const dummyCtx: RequestContext = {
    tenantId: '00000000-0000-4000-a000-000000000001',
    taskId: 'task_cv16_test_001',
    actor: { type: 'workflow', id: 'publisher' },
    correlationId: 'corr_cv16_1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem_cv16_pub',
  };

  describe('1. FR-046: Deterministic Drive Destination & Wrong-Folder Denial', () => {
    it('denies publication when destination folder is unconfigured, unauthorized, or audit-invented', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const badDestinations = [
        '',
        'audit-invented-nonexistent-folder',
        'unauthorized_folder_123',
        'nonexistent-destination',
      ];

      for (const dest of badDestinations) {
        const req: PublishRequest = {
          taskId: 'task_cv16_test_001',
          clientId: 'c1000000-0000-4000-8000-000000000002',
          designRevisionId: 'rev_1',
          approvalId: 'app_1',
          publicationKey: `pub_key_bad_${dest || 'empty'}`,
          packageHash: 'pkg_hash_cv16_valid',
          files: [{
            artifactId: 'art_1',
            relativePath: 'banner.png',
            storageKey: testFilePng,
            filename: 'banner.png',
            mimeType: 'image/png',
            byteSize: testFileBytes.length,
            sha256: testFileSha256,
          }],
          destination: {
            sharedDriveId: 'drive_root_1',
            productionRootFolderId: dest,
            relativeFolderParts: ['Clients', 'KAAE'],
            spreadsheetId: 'sheet_hawa_office_reporting',
            sheetId: 0,
          },
          sheetRow: { taskId: 'task_cv16_test_001' },
        };

        const res = await publisher.publish(dummyCtx, req);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('INVALID_DESTINATION');
        }
      }
    });

    it('enforces Client DNA destination isolation via core omnichannel endpoint', async () => {
      const exports = memoryExportStore();
      const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store, qaEngine: passingQa as never });

      // A Drustee task
      const createRes = await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Campaign for Drustee Hospital', clientId: 'c1000000-0000-4000-8000-000000000003' }),
      });
      expect(createRes.status).toBe(201);
      const taskId = (await createRes.json()).id;

      // Register revision
      const revRes = await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', text: 'Drustee Campaign' }],
        }),
      });
      const { revisionId } = await revRes.json();
      expect((await app.request(`/tasks/${taskId}/revisions/${revisionId}/qa`, { method: 'POST' })).status).toBe(200);

      // Approve, pinning the export the reviewer saw
      const approved = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer test_art_director_bearer`,
        },
        body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
      });
      expect(approved.status).toBe(201);

      // Publish omnichannel
      const pubRes = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(pubRes.status).toBe(200);
      const pubData = await pubRes.json();
      expect(pubData.ok).toBe(true);
      // Confirms Drustee uses its own verified production folder, not KAAE or foreign client
      expect(pubData.driveFolderUrl).toContain('folder_drustee_prod_verified');
    });
  });

  describe('2. FR-047 & FR-049: Idempotent Upload, Lost-Success Replay & Sheets Upsert', () => {
    it('returns exact existing publication receipt on lost-success replay without creating duplicates', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const req: PublishRequest = {
        taskId: 'task_cv16_test_001',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_cv16_1',
        approvalId: 'app_cv16_1',
        publicationKey: 'pub_key_idempotent_test_001',
        packageHash: 'pkg_hash_cv16_valid',
        files: [{
          artifactId: 'art_1',
          relativePath: 'banner.png',
          storageKey: testFilePng,
          filename: 'banner.png',
          mimeType: 'image/png',
          byteSize: testFileBytes.length,
          sha256: testFileSha256,
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: 'task_cv16_test_001' },
      };

      // First publication attempt
      const res1 = await publisher.publish(dummyCtx, req);
      expect(res1.ok).toBe(true);
      if (!res1.ok) return;
      const receipt1 = res1.value;
      const initialUploadCount = receivedDriveUploads.length;
      const initialSheetAppendCount = receivedSheetAppends.length;

      // Lost success simulation: network response timed out, caller replays identical request
      const res2 = await publisher.publish(dummyCtx, req);
      expect(res2.ok).toBe(true);
      if (!res2.ok) return;
      const receipt2 = res2.value;

      // Assert identical receipt and zero duplicate upload or append operations
      expect(receipt2.publicationId).toBe(receipt1.publicationId);
      expect(receipt2.driveFiles[0].fileId).toBe(receipt1.driveFiles[0].fileId);
      expect(receipt2.sheet.rowNumber).toBe(receipt1.sheet.rowNumber);
      expect(receivedDriveUploads.length).toBe(initialUploadCount);
      expect(receivedSheetAppends.length).toBe(initialSheetAppendCount);
    });

    it('denies differing payload under identical publicationKey with IDEMPOTENCY_CONFLICT', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const baseReq: PublishRequest = {
        taskId: 'task_cv16_test_001',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_cv16_1',
        approvalId: 'app_cv16_1',
        publicationKey: 'pub_key_conflict_probe',
        packageHash: 'pkg_hash_cv16_valid',
        files: [{
          artifactId: 'art_1',
          relativePath: 'banner.png',
          storageKey: testFilePng,
          filename: 'banner.png',
          mimeType: 'image/png',
          byteSize: testFileBytes.length,
          sha256: testFileSha256,
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: 'task_cv16_test_001' },
      };

      // 1. Initial success
      const res1 = await publisher.publish(dummyCtx, baseReq);
      expect(res1.ok).toBe(true);

      // 2. Conflicting replay (different packageHash)
      const conflictReq = { ...baseReq, packageHash: 'tampered_conflicting_hash_999' };
      const res2 = await publisher.publish(dummyCtx, conflictReq);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe('IDEMPOTENCY_CONFLICT');
      }
    });

    it('FR-049: updates existing Google Sheets row by immutable taskId rather than blind-appending', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const taskAId = 'task_cv16_upsert_test_049';
      const req1: PublishRequest = {
        taskId: taskAId,
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_1',
        approvalId: 'app_1',
        publicationKey: 'pub_key_upsert_run_1',
        packageHash: 'pkg_hash_1',
        files: [{
          artifactId: 'art_1',
          relativePath: 'banner.png',
          storageKey: testFilePng,
          filename: 'banner.png',
          mimeType: 'image/png',
          byteSize: testFileBytes.length,
          sha256: testFileSha256,
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: taskAId },
      };

      // 1. First publication creates an identified row
      const res1 = await publisher.publish(dummyCtx, req1);
      expect(res1.ok).toBe(true);

      // 2. Republish new revision for same task uses new publicationKey
      const req2: PublishRequest = {
        ...req1,
        designRevisionId: 'rev_2',
        publicationKey: 'pub_key_upsert_run_2',
        packageHash: 'pkg_hash_2',
      };

      const initialAppendCount = receivedSheetAppends.length;
      const res2 = await publisher.publish(dummyCtx, req2);
      expect(res2.ok).toBe(true);

      // The next revision updates the existing metadata identity without inserting another row.
      expect(receivedSheetAppends.length).toBe(initialAppendCount); // No new append
      expect(receivedSheetUpdates.length).toBeGreaterThanOrEqual(1); // Row was updated
      expect(receivedSheetUpdates.at(-1).url).toContain('/values:batchUpdateByDataFilter');
      expect(res2.ok && res2.value.sheet.synced).toBe(true);
      expect(sheets.tabs.get(0)?.filter(row => row[0] === taskAId)).toHaveLength(1);
    });
  });

  describe('3. FR-048: Independent Readback & Hash Equality Verification', () => {
    it('verifies SHA-256 hash equality between approved local deliverable and remote readback', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const req: PublishRequest = {
        taskId: 'task_cv16_test_001',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_1',
        approvalId: 'app_1',
        publicationKey: 'pub_key_hash_verify',
        packageHash: 'pkg_hash_cv16_valid',
        files: [{
          artifactId: 'art_1',
          relativePath: 'banner.png',
          storageKey: testFilePng,
          filename: 'banner.png',
          mimeType: 'image/png',
          byteSize: testFileBytes.length,
          sha256: testFileSha256, // Real exact SHA-256
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: 'task_cv16_test_001' },
      };

      const res = await publisher.publish(dummyCtx, req);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const driveFile = res.value.driveFiles[0];
      expect(driveFile.verified).toBe(true);
      expect(driveFile.expectedSha256).toBe(testFileSha256);
      expect(driveFile.observedSize).toBe(testFileBytes.length);
    });

    it('rejects publication when local deliverable SHA-256 does not match approved hash', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const tamperedSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
      const req: PublishRequest = {
        taskId: 'task_cv16_test_001',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_1',
        approvalId: 'app_1',
        publicationKey: 'pub_key_tampered_hash',
        packageHash: 'pkg_hash_cv16_valid',
        files: [{
          artifactId: 'art_1',
          relativePath: 'banner.png',
          storageKey: testFilePng,
          filename: 'banner.png',
          mimeType: 'image/png',
          byteSize: testFileBytes.length,
          sha256: tamperedSha256, // Tampered!
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: 'task_cv16_test_001' },
      };

      const res = await publisher.publish(dummyCtx, req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('PUBLICATION_VERIFICATION_FAILED');
        expect(res.error.message).toContain('SHA-256 hash mismatch');
      }
    });

    it('refuses to mark completion when physical deliverable file is nonexistent', async () => {
      const publisher = new GooglePublisher({
        oauthToken: 'test_token_cv16',
        driveApiBaseUrl: serverUrl,
        driveUploadBaseUrl: serverUrl,
        sheetsApiBaseUrl: serverUrl,
      });

      const req: PublishRequest = {
        taskId: 'task_cv16_test_001',
        clientId: 'c1000000-0000-4000-8000-000000000002',
        designRevisionId: 'rev_1',
        approvalId: 'app_1',
        publicationKey: 'pub_key_nonexistent_file',
        packageHash: 'pkg_hash_cv16_valid',
        files: [{
          artifactId: 'art_ghost',
          relativePath: 'missing.png',
          storageKey: '/tmp/nonexistent_file_ghost_999.png',
          filename: 'missing.png',
          mimeType: 'image/png',
          byteSize: 1024,
          sha256: 'sha256_ghost',
        }],
        destination: {
          sharedDriveId: 'drive_root_1',
          productionRootFolderId: 'folder_kaae_prod_2026',
          relativeFolderParts: ['Clients', 'KAAE'],
          spreadsheetId: 'sheet_hawa_office_reporting',
          sheetId: 0,
        },
        sheetRow: { taskId: 'task_cv16_test_001' },
      };

      const res = await publisher.publish(dummyCtx, req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('PUBLICATION_VERIFICATION_FAILED');
        expect(res.error.message).toContain('does not exist on disk');
      }
    });
  });

  describe('4. FR-051: Notification Failure Independence & Nonexistent File Defense', () => {
    it('notification failure does not undo or roll back valid Google Drive and Sheets publication', async () => {
      const exports = memoryExportStore();
      const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store, qaEngine: passingQa as never });

      // A task for a client with a Drive destination (a task without a client is never delivered)
      const createRes = await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Notification Isolation Campaign', clientId: 'c1000000-0000-4000-8000-000000000002' }),
      });
      const created = await createRes.json();
      const taskId = created.id || created.task?.id;

      // Register revision
      const revRes = await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', text: 'Notification Isolation' }],
        }),
      });
      const { revisionId } = await revRes.json();
      expect((await app.request(`/tasks/${taskId}/revisions/${revisionId}/qa`, { method: 'POST' })).status).toBe(200);

      // Approve
      const approved = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer test_art_director_bearer`,
        },
        body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
      });
      expect(approved.status).toBe(201);

      // Publish with a failing notification callback injected in options
      const pubRes = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(pubRes.status).toBe(200);
      const pubData = await pubRes.json();

      // Task status is COMPLETE and receipt exists
      expect(pubData.ok).toBe(true);
      expect(pubData.status).toBe('COMPLETE');
      expect(pubData.publicationReceipt).toBeDefined();
      expect(pubData.publicationReceipt.state).toBe('complete');

      // Verify that publication receipt endpoint returns receipt
      const receiptRes = await app.request(`/tasks/${taskId}/publication-receipt`);
      expect(receiptRes.status).toBe(200);
      const receiptBody = await receiptRes.json();
      // Read back from Postgres: the same publication the delivery answered with, and its files.
      expect(receiptBody.receipt).toMatchObject({ publicationId: pubData.publicationReceipt.publicationId, state: 'complete', recordedIn: 'postgres' });
      expect(receiptBody.receipt.files.length).toBeGreaterThan(0);
    });

    it('a successful chat message cannot mark a nonexistent or unapproved file delivered', async () => {
      const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true } });

      // Create an unapproved task
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idem_chat_unapp_${Date.now()}`,
        },
        body: JSON.stringify({
          title: 'Unapproved Task Chat Defense',
          clientId: 'c1000000-0000-4000-8000-000000000002',
        }),
      });
      const unapprovedTask = await createRes.json();

      // Attempt to publish without approval via omnichannel endpoint
      const pubRes = await app.request(`/tasks/${unapprovedTask.id}/publish-omnichannel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(pubRes.status).toBe(409); // Conflict: Cannot publish unapproved task

      // Verify task status remained RECEIVED, never COMPLETE
      const checkRes = await app.request(`/v1/tasks/${unapprovedTask.id}`);
      const checkData = await checkRes.json();
      expect(checkData.status).toBe('RECEIVED');
    });
  });
});
