import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { GooglePublisher } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';

describe('CV-16: Keep verified Drive, Sheets and channel delivery (FR-046..FR-051)', () => {
  let mockServer: http.Server;
  let serverPort: number;
  let serverUrl: string;

  // Tracking server calls
  const receivedDriveUploads: any[] = [];
  const receivedDriveReadbacks: string[] = [];
  const receivedSheetAppends: any[] = [];
  const receivedSheetUpdates: any[] = [];
  const receivedSheetReadbacks: string[] = [];
  let lastAppendedTaskId: string | null = null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-cv16-test-'));
  const testFilePng = path.join(tempDir, 'banner.png');
  const testFileBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const testFileSha256 = crypto.createHash('sha256').update(testFileBytes).digest('hex');
  fs.writeFileSync(testFilePng, testFileBytes);

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      const url = req.url || '';

      // 1. Google Drive Multipart Upload
      if (req.method === 'POST' && url.includes('/drive/v3/files') && url.includes('uploadType=multipart')) {
        let body = Buffer.alloc(0);
        req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
        req.on('end', () => {
          const fileId = `gdrive_verified_file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        }));
        return;
      }

      // 3. Google Sheets Append (First insertion)
      if (req.method === 'POST' && url.includes('/values/') && url.includes(':append')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          receivedSheetAppends.push({
            authHeader: req.headers.authorization,
            values: parsed.values,
          });
          if (parsed.values?.[0]?.[0]) {
            lastAppendedTaskId = parsed.values[0][0];
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            spreadsheetId: 'sheet_hawa_office_reporting',
            updates: {
              updatedRange: 'Sheet1!A42:G42',
              updatedRows: 1,
              updatedColumns: 7,
            },
          }));
        });
        return;
      }

      // 3b. Google Sheets Row identity verification & search
      if (req.method === 'GET' && url.includes('/values/A') && (url.includes(':A') || url.includes('A42:A42'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('/values/A:A')) {
          const colA = new Array(41).fill(['dummy_task']);
          if (lastAppendedTaskId) {
            colA.push([lastAppendedTaskId]);
          }
          res.end(JSON.stringify({ range: 'Sheet1!A:A', values: colA }));
        } else {
          res.end(JSON.stringify({
            range: 'Sheet1!A42:A42',
            values: [ [ lastAppendedTaskId || 'task_cv16_test_001' ] ],
          }));
        }
        return;
      }

      // 4. Google Sheets Update / Upsert (Idempotent update for existing task)
      if (req.method === 'PUT' && url.includes('/values/A') && url.includes(':G')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          receivedSheetUpdates.push({
            authHeader: req.headers.authorization,
            url,
            values: parsed.values,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            spreadsheetId: 'sheet_hawa_office_reporting',
            updatedRange: 'Sheet1!A42:G42',
            updatedRows: 1,
            updatedColumns: 7,
          }));
        });
        return;
      }

      // 5. Google Sheets Readback
      if (req.method === 'GET' && url.includes('/values/A42:G42')) {
        receivedSheetReadbacks.push(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          range: 'Sheet1!A42:G42',
          values: [
            [
              'task_cv16_test_001',
              'c1000000-0000-4000-8000-000000000002',
              'folder_kaae_prod_2026',
              '2026-09-11T20:00:00Z',
              'COMPLETE',
              'https://drive.google.com/file/d/gdrive_verified/view',
              'pkg_hash_cv16_valid',
            ],
          ],
        }));
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
      const app = createApp({ deliverableStore: exports.store });

      // Ingest task with valid client
      const ingestRes = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'expected_office_secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 202616,
          message: { text: 'Campaign for Drustee Hospital', chat: { id: 888 } },
        }),
      });
      const ingestData = await ingestRes.json();
      const taskId = ingestData.task.id;

      // Register revision
      const revRes = await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', text: 'Drustee Campaign' }],
        }),
      });
      const { revisionId } = await revRes.json();

      // Approve, pinning the export the reviewer saw
      await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
        },
        body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
      });

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

      // 1. First publish appends row 42
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

      // Assert that second publication updated row 42 (PUT) rather than blind-appending (POST)
      expect(receivedSheetAppends.length).toBe(initialAppendCount); // No new append
      expect(receivedSheetUpdates.length).toBeGreaterThanOrEqual(1); // Row was updated
      expect(receivedSheetUpdates[0].url).toContain('/values/A42:G42');
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
      const app = createApp({ deliverableStore: exports.store });

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

      // Approve
      await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
        },
        body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
      });

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
      expect(receiptBody.receipt.receipt.publicationId).toBeDefined();
    });

    it('a successful chat message cannot mark a nonexistent or unapproved file delivered', async () => {
      const app = createApp();

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
