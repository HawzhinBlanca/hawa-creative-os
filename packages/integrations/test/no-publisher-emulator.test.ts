import { assert, describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GooglePublisher } from '../src/google-publisher.js';
import { startFakeDriveServer } from './fake-drive-server.js';
import type { RequestContext, PublishRequest } from '@hawa/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Task 2: Elimination of emulateNetworkForTesting and Verification of fake-drive over HTTP', () => {
  it('proves emulateNetworkForTesting is completely removed from GooglePublisher source', () => {
    const publisherSource = fs.readFileSync(
      path.resolve(__dirname, '../src/google-publisher.ts'),
      'utf8'
    );
    expect(publisherSource).not.toContain('emulateNetworkForTesting');
    expect(publisherSource).not.toContain('emulatedSheets');
    expect(publisherSource).not.toContain('emulated_file_');
  });

  describe('fake-drive HTTP integration', () => {
    let fakeServer: any;
    let ctx: RequestContext;

    beforeAll(async () => {
      fakeServer = await startFakeDriveServer();
      ctx = {
        tenantId: '00000000-0000-4000-a000-000000000001',
        taskId: 'task-fake-drive-test-1',
        actor: { type: 'workflow', id: 'test' },
        correlationId: 'corr-fake-1', idempotencyKey: 'fake-drive-fixture',
        deadline: new Date(Date.now() + 60000).toISOString(),
      };
    });

    afterAll(async () => {
      if (fakeServer) await fakeServer.close();
    });

    it('publishes deliverable via real HTTP to fake-drive without in-memory short-circuits', async () => {
      const publisher = new GooglePublisher({
        driveApiBaseUrl: fakeServer.url,
        driveUploadBaseUrl: fakeServer.url,
        sheetsApiBaseUrl: fakeServer.url,
        oauthToken: 'fake_http_token',
      });

      const fileContent = 'FAKEDRIVE_TEST_FILE_CONTENT';
      const fileBuffer = Buffer.from(fileContent);
      const sha256 = (await import('node:crypto')).createHash('sha256').update(fileBuffer).digest('hex');

      const request: PublishRequest = {
        taskId: 'task-fake-drive-test-1',
        clientId: 'client-1',
        designRevisionId: 'rev-1',
        approvalId: 'app-1',
        publicationKey: 'pub-key-1',
        packageHash: 'pkg-hash-1',
        sheetRow: {}, destination: { sheetId: 0, sharedDriveId: 'fixture-shared-drive', relativeFolderParts: [],
          productionRootFolderId: 'fake-folder-root',
          spreadsheetId: 'fake-spreadsheet-1',
        },
        files: [
          {
            artifactId: 'art-1',
            filename: 'test-delivery.png',
            byteSize: fileBuffer.length,
            sha256,
            mimeType: 'image/png',
            relativePath: 'test-delivery.png', storageKey: 'fixture-inline-content', content: fileBuffer,
          },
        ],
      };

      const res = await publisher.publish(ctx, request);
      expect(res.ok).toBe(true); assert(res.ok);
      if (!res.ok) return;

      expect(res.value.state).toBe('complete');
      expect(res.value.emulated).toBe(false);
      expect(res.value.driveFiles).toHaveLength(1);
      expect(res.value.driveFiles[0].verified).toBe(true);
      expect(res.value.sheet.synced).toBe(true);

      // Verify fakeServer actually received and stored the file and sheet row over HTTP
      expect(fakeServer.getUploadedFiles().length).toBeGreaterThan(0);
      const sheetRows = fakeServer.getSheetRows('fake-spreadsheet-1');
      expect(sheetRows).toHaveLength(2);
      expect(sheetRows[1][0]).toBe('task-fake-drive-test-1');
    });
  });
});
