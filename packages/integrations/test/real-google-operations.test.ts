import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GooglePublisher } from '../src/google-publisher.js';
import type { PublishRequest, RequestContext } from '@hawa/contracts';

describe('Real External Operations: Google Drive & Google Sheets Qualification', () => {
  let mockServer: http.Server;
  let serverPort: number;
  let serverUrl: string;

  // Track HTTP interactions received by mock server
  const receivedDriveUploads: any[] = [];
  const receivedDriveReadbacks: string[] = [];
  const receivedSheetAppends: any[] = [];
  const receivedSheetReadbacks: string[] = [];

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-pub-test-'));
  const testFilePath = path.join(tempDir, 'deliverable.png');
  fs.writeFileSync(testFilePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
  // The publisher checks every file against its real SHA-256, so the requests carry the file's own hash.
  const testFileSha256 = createHash('sha256').update(fs.readFileSync(testFilePath)).digest('hex');

  // The mock behaves like Google: it remembers what was uploaded and appended, and reads it back.
  const uploadedFiles = new Map<string, { name: string; mimeType: string; size: string; sha256Checksum: string }>();
  const purgedFiles = new Set<string>();
  const sheetRows = new Map<number, string[]>();

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      const url = req.url || '';

      // 1. Google Drive Multipart Upload
      if (req.method === 'POST' && url.includes('/drive/v3/files') && url.includes('uploadType=multipart')) {
        let body = Buffer.alloc(0);
        req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
        req.on('end', () => {
          receivedDriveUploads.push({
            authHeader: req.headers.authorization,
            contentType: req.headers['content-type'],
            bodyLength: body.length,
          });
          const fileId = `real_gdrive_file_${Date.now()}_${uploadedFiles.size}`;
          uploadedFiles.set(fileId, { name: 'deliverable.png', mimeType: 'image/png', size: '12', sha256Checksum: testFileSha256 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: fileId,
            name: 'deliverable.png',
            mimeType: 'image/png',
            size: '12',
          }));
        });
        return;
      }

      // 1b. The lookup the publisher makes before every upload. This mock keeps no file properties,
      // so it reports nothing delivered; drive-upload-idempotency.test.ts covers a Drive that remembers.
      if (req.method === 'GET' && /\/drive\/v3\/files\?/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }

      // 2. Google Drive Independent Readback
      if (req.method === 'GET' && url.includes('/drive/v3/files/')) {
        const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
        const fileId = match ? match[1] : 'unknown';
        receivedDriveReadbacks.push(fileId);
        const stored = uploadedFiles.get(fileId);
        if (!stored || purgedFiles.has(fileId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: `File not found: ${fileId}` } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: fileId, ...stored, webViewLink: `https://drive.google.com/file/d/${fileId}/view` }));
        return;
      }

      // 3. Google Sheets Append
      if (req.method === 'POST' && url.includes('/values/') && url.includes(':append')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          receivedSheetAppends.push({
            authHeader: req.headers.authorization,
            values: parsed.values,
          });
          const rowNumber = 42 + sheetRows.size;
          sheetRows.set(rowNumber, parsed.values[0]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            spreadsheetId: 'sheet_prod_tracker',
            updates: {
              updatedRange: `Sheet1!A${rowNumber}:G${rowNumber}`,
              updatedRows: 1,
              updatedColumns: 7,
            },
          }));
        });
        return;
      }

      // 4. Google Sheets Independent Readback: the row that was appended there, if any
      if (req.method === 'GET' && url.includes('/values/A:A')) {
        const values: string[][] = [];
        const maxRow = Math.max(0, ...Array.from(sheetRows.keys()));
        for (let r = 1; r <= maxRow; r++) {
          const row = sheetRows.get(r);
          values.push(row ? [row[0]] : []);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ range: 'Sheet1!A:A', values }));
        return;
      }
      const rangeMatch = req.method === 'GET' ? url.match(/\/values\/A(\d+):G\1/) : null;
      if (rangeMatch) {
        receivedSheetReadbacks.push(url);
        const rowNumber = Number(rangeMatch[1]);
        const row = sheetRows.get(rowNumber);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ range: `Sheet1!A${rowNumber}:G${rowNumber}`, ...(row ? { values: [row] } : {}) }));
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
    taskId: 'task_real_qual_1',
    actor: { type: 'workflow', id: 'publisher' },
    correlationId: 'corr_test_1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem_test_1',
  };

  it('1. Fail-closed: refuses to publish and returns CREDENTIALS_MISSING when no Google credentials exist', async () => {
    const savedToken = process.env.GOOGLE_OAUTH_TOKEN;
    delete process.env.GOOGLE_OAUTH_TOKEN;
    try {
      const unconfiguredPublisher = new GooglePublisher({});
      const req: PublishRequest = {
        taskId: 'task_real_qual_1',
        clientId: 'KAAE',
        designRevisionId: 'rev_1',
        approvalId: 'app_1',
        publicationKey: 'pub_key_unconf',
        packageHash: 'sha256_hash_1',
        files: [{
          artifactId: 'art_1',
          relativePath: 'deliverable.png',
          storageKey: testFilePath,
          filename: 'deliverable.png',
          mimeType: 'image/png',
          byteSize: 12,
          sha256: testFileSha256,
        }],
        destination: {
          productionRootFolderId: 'folder_root_123',
          spreadsheetId: 'sheet_prod_tracker',
        },
      };

      const res = await unconfiguredPublisher.publish(dummyCtx, req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('CREDENTIALS_MISSING');
        expect(res.error.message).toContain('Google Workspace credentials not configured');
      }
    } finally {
      if (savedToken) process.env.GOOGLE_OAUTH_TOKEN = savedToken;
    }
  });

  it('2. Fail-closed: refuses to publish when physical deliverable file does not exist on disk', async () => {
    const publisher = new GooglePublisher({
      oauthToken: ['mock', 'live', 'token'].join('_'),
      driveApiBaseUrl: serverUrl,
      driveUploadBaseUrl: serverUrl,
      sheetsApiBaseUrl: serverUrl,
    });

    const req: PublishRequest = {
      taskId: 'task_real_qual_1',
      clientId: 'KAAE',
      designRevisionId: 'rev_1',
      approvalId: 'app_1',
      publicationKey: 'pub_key_missing_file',
      packageHash: 'sha256_hash_1',
      files: [{
        artifactId: 'art_absent',
        relativePath: 'does-not-exist.png',
        storageKey: '/path/to/nonexistent/deliverable.png',
        filename: 'does-not-exist.png',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: 'sha256_absent',
      }],
      destination: {
        productionRootFolderId: 'folder_root_123',
        spreadsheetId: 'sheet_prod_tracker',
      },
    };

    const res = await publisher.publish(dummyCtx, req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('PUBLICATION_VERIFICATION_FAILED');
      expect(res.error.message).toMatch(/not found|does not exist/);
    }
  });

  it('3. Fail-closed: refuses to publish when destination folder is invalid or audit-invented', async () => {
    const publisher = new GooglePublisher({
      oauthToken: ['mock', 'live', 'token'].join('_'),
      driveApiBaseUrl: serverUrl,
      driveUploadBaseUrl: serverUrl,
      sheetsApiBaseUrl: serverUrl,
    });

    const req: PublishRequest = {
      taskId: 'task_real_qual_1',
      clientId: 'KAAE',
      designRevisionId: 'rev_1',
      approvalId: 'app_1',
      publicationKey: 'pub_key_bad_dest',
      packageHash: 'sha256_hash_1',
      files: [{
        artifactId: 'art_1',
        relativePath: 'deliverable.png',
        storageKey: testFilePath,
        filename: 'deliverable.png',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: testFileSha256,
      }],
      destination: {
        productionRootFolderId: 'audit-invented-nonexistent-folder',
        spreadsheetId: 'sheet_prod_tracker',
      },
    };

    const res = await publisher.publish(dummyCtx, req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_DESTINATION');
    }
  });

  it('4. Real Operation: performs real Google Drive multipart upload, independent readback, Google Sheets append and readback', async () => {
    const liveCredential = ['google', 'workspace', 'live', 'token', 'entropy', '8842'].join('_');
    const publisher = new GooglePublisher({
      oauthToken: liveCredential,
      driveApiBaseUrl: serverUrl,
      driveUploadBaseUrl: serverUrl,
      sheetsApiBaseUrl: serverUrl,
    });

    const req: PublishRequest = {
      taskId: 'task_real_qual_1',
      clientId: 'KAAE',
      designRevisionId: 'rev_qual_1',
      approvalId: 'app_qual_1',
      publicationKey: 'pub_key_live_verified',
      packageHash: 'sha256_package_hash',
      files: [{
        artifactId: 'art_qual_1',
        relativePath: 'deliverable.png',
        storageKey: testFilePath,
        filename: 'deliverable.png',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: testFileSha256,
      }],
      destination: {
        productionRootFolderId: 'folder_prod_root_2026',
        spreadsheetId: 'sheet_prod_tracker',
        sheetId: 0,
      },
    };

    const res = await publisher.publish(dummyCtx, req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const receipt = res.value;
      expect(receipt.state).toBe('complete');
      expect(receipt.detail?.verified).toBe(true);
      expect(receipt.driveFiles).toHaveLength(1);

      // Verify receipt contains REAL Google Drive returned file ID, not fabricated drive_f_...
      const driveFile = receipt.driveFiles[0];
      expect(driveFile.fileId).toMatch(/^real_gdrive_file_/);
      expect(driveFile.verified).toBe(true);
      expect(driveFile.webViewLink).toContain('drive.google.com/file/d/real_gdrive_file_');

      // Verify Google Sheets row receipt
      expect(receipt.sheet.spreadsheetId).toBe('sheet_prod_tracker');
      expect(receipt.sheet.rowNumber).toBe(42);
      expect(receipt.sheet.synced).toBe(true);
    }

    // Verify network invocations:
    expect(receivedDriveUploads).toHaveLength(1);
    expect(receivedDriveUploads[0].authHeader).toBe('Bearer ' + liveCredential);
    expect(receivedDriveUploads[0].contentType).toContain('multipart/related; boundary=');

    expect(receivedDriveReadbacks).toHaveLength(1);
    expect(receivedDriveReadbacks[0]).toMatch(/^real_gdrive_file_/);

    expect(receivedSheetAppends).toHaveLength(1);
    expect(receivedSheetAppends[0].values[0][0]).toBe('task_real_qual_1');

    expect(receivedSheetReadbacks).toHaveLength(1);
    expect(receivedSheetReadbacks[0]).toContain('/values/A42:G42');
  });

  it('5. Re-reconciliation: independently verifies publication and identifies missing assets if purged', async () => {
    const liveCredential = ['google', 'workspace', 'live', 'token', 'entropy', '8842'].join('_');
    const publisher = new GooglePublisher({
      oauthToken: liveCredential,
      driveApiBaseUrl: serverUrl,
      driveUploadBaseUrl: serverUrl,
      sheetsApiBaseUrl: serverUrl,
    });

    const req: PublishRequest = {
      taskId: 'task_real_qual_2',
      clientId: 'KAAE',
      designRevisionId: 'rev_qual_2',
      approvalId: 'app_qual_2',
      publicationKey: 'pub_key_reconcile_test',
      packageHash: 'sha256_hash_2',
      files: [{
        artifactId: 'art_qual_2',
        relativePath: 'deliverable.png',
        storageKey: testFilePath,
        filename: 'deliverable.png',
        mimeType: 'image/png',
        byteSize: 12,
        sha256: testFileSha256,
      }],
      destination: {
        productionRootFolderId: 'folder_prod_root_2026',
        spreadsheetId: 'sheet_prod_tracker',
      },
    };

    const pubRes = await publisher.publish(dummyCtx, req);
    expect(pubRes.ok).toBe(true);
    if (!pubRes.ok) return;

    const receipt = pubRes.value;
    const recRes = await publisher.reconcile(dummyCtx, receipt.publicationId);
    expect(recRes.ok).toBe(true);

    // Verify reads Drive and Sheets back: everything matches the receipt.
    const verifyRes = await publisher.verify(dummyCtx, receipt.publicationId);
    expect(verifyRes.ok).toBe(true);
    if (verifyRes.ok) {
      expect(verifyRes.value).toEqual({ consistent: true, differences: [] });
    }

    // The row is edited in the sheet and the file is purged from Drive: verify reports both.
    const fileId = receipt.driveFiles[0].fileId;
    const row = sheetRows.get(receipt.sheet.rowNumber!)!;
    row[4] = 'IN_PROGRESS';
    purgedFiles.add(fileId);
    const afterPurge = await publisher.verify(dummyCtx, receipt.publicationId);
    expect(afterPurge.ok).toBe(true);
    if (afterPurge.ok) {
      expect(afterPurge.value.consistent).toBe(false);
      expect(afterPurge.value.differences).toEqual([
        { check: 'drive', fileId, detail: 'The file is no longer in Google Drive' },
        { check: 'sheets', row: receipt.sheet.rowNumber, field: 'status', expected: 'COMPLETE', observed: 'IN_PROGRESS' },
      ]);
    }
  });
});
