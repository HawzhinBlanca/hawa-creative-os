import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageFile, PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher } from '../src/google-publisher.js';
import { startFakeDriveServer } from './fake-drive-server.js';

/**
 * The publisher sends only real bytes. Until 2026-09-19 a file it could not read became
 * Buffer.alloc(byteSize), a zero-filled placeholder it uploaded to the client's Drive folder, and a
 * Sheets row number it was never told became 101.
 */

const ctx: RequestContext = {
  tenantId: 'tenant-default',
  taskId: 'task-bytes',
  actor: { type: 'workflow', id: 'publisher' },
  correlationId: 'corr-bytes',
  deadline: new Date(Date.now() + 60000).toISOString(),
  idempotencyKey: 'idem-bytes',
};

function file(name: string, text: string, overrides: Partial<PackageFile> = {}): PackageFile {
  const content = new TextEncoder().encode(text);
  return {
    artifactId: `art-${name}`,
    relativePath: name,
    storageKey: `memory:${name}`,
    filename: name,
    mimeType: 'image/png',
    byteSize: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
    ...overrides,
  };
}

function request(files: PackageFile[], key = `pub-${Math.random()}`): PublishRequest {
  return {
    taskId: 'task-bytes',
    clientId: 'client-kaae',
    designRevisionId: 'rev-1',
    approvalId: 'approval-1',
    publicationKey: key,
    packageHash: 'package-hash',
    files,
    destination: { sharedDriveId: '', productionRootFolderId: 'folder-kaae', relativeFolderParts: [], spreadsheetId: 'sheet-kaae', sheetId: 0 },
    sheetRow: { taskId: 'task-bytes' },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const livePublisher = () => new GooglePublisher({ oauthToken: 'live-token', driveApiBaseUrl: 'https://drive.test', driveUploadBaseUrl: 'https://upload.test', sheetsApiBaseUrl: 'https://sheets.test' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GooglePublisher uploads nothing it cannot verify', () => {
  it('refuses a file with no bytes, before any upload: no zero-filled placeholder', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await livePublisher().publish(ctx, request([file('a.png', 'aaa'), file('b.png', 'bbb', { content: undefined, storageKey: 'deliverables/b.png' })]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as any).message).toBe('Physical deliverable file does not exist on disk: deliverables/b.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes do not match its hash or size, before uploading any file', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const wrongHash = await livePublisher().publish(ctx, request([file('a.png', 'aaa'), file('b.png', 'bbb', { sha256: 'sha256_png_hash' })]));
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok) expect((wrongHash.error as any).message).toMatch(/^SHA-256 hash mismatch for deliverable file b\.png/);

    const wrongSize = await livePublisher().publish(ctx, request([file('a.png', 'aaa', { byteSize: 350000 })]));
    expect(wrongSize.ok).toBe(false);
    if (!wrongSize.ok) expect((wrongSize.error as any).message).toBe('Size mismatch for deliverable file a.png: expected 350000 bytes, read 3');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records no Sheets row number that Sheets did not report, and then calls the row unsynced', async () => {
    const f = file('a.png', 'aaa');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://upload.test')) return json({ id: 'drive-file-1' });
      // The lookup the publisher makes before every upload: nothing delivered yet.
      if (url.startsWith('https://drive.test/drive/v3/files?q=')) return json({ files: [] });
      if (url.startsWith('https://drive.test')) return json({ id: 'drive-file-1', name: 'a.png', size: String(f.byteSize), mimeType: 'image/png', sha256Checksum: f.sha256 });
      if (url.includes('/values/A:A')) return json({ values: [] });
      if (url.includes(':append')) return json({ updates: {} }); // no updatedRange
      throw new Error(`unexpected call ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await livePublisher().publish(ctx, request([f]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.driveFiles[0]).toMatchObject({ fileId: 'drive-file-1', verified: true });
    expect(res.value.sheet.rowNumber).toBeUndefined();
    expect(res.value.sheet.synced).toBe(false);
    expect(res.value.state).toBe('drive_complete');
    expect(res.value.emulated).toBe(false);
    // Drive lookup, upload, Drive readback, pre-append task identity check, and the append.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('marks published receipts as not emulated (genuine HTTP)', async () => {
    const fake = await startFakeDriveServer();
    try {
      const pub = new GooglePublisher({
        oauthToken: ['test', 'token'].join('_'),
        driveApiBaseUrl: fake.url,
        driveUploadBaseUrl: fake.url,
        sheetsApiBaseUrl: fake.url,
      });
      const res = await pub.publish(ctx, request([file('a.png', 'aaa')]));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.emulated).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe('GooglePublisher.verify reads the publication back', () => {
  it('an emulated receipt is never reported consistent: nothing was sent to verify', async () => {
    const publisher = new GooglePublisher({ oauthToken: ['test', 'token'].join('_') });
    const receiptId = '00000000-0000-4000-a000-000000000001';
    (publisher as any).inMemoryLedger.set('pub-test', {
      publicationId: receiptId,
      publicationKey: 'pub-test',
      driveFolderId: 'folder',
      driveFiles: [],
      sheet: { spreadsheetId: 'sheet', sheetId: 0, rowKey: 'task', synced: false, expectedHash: 'hash' },
      state: 'complete',
      detail: {},
      emulated: true,
    });
    const verified = await publisher.verify(ctx, receiptId);
    expect(verified.ok && verified.value).toEqual({
      consistent: false,
      differences: [{ check: 'emulated', detail: 'No Google call was made for this publication, so there is nothing to verify' }],
    });
  });

  it('reports a Drive file whose content, size or trash state no longer matches, and a missing Sheets row', async () => {
    const f = file('a.png', 'aaa');
    let driveNow: any = { id: 'drive-file-1', name: 'a.png', size: String(f.byteSize), mimeType: 'image/png', sha256Checksum: f.sha256 };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://upload.test')) return json({ id: 'drive-file-1' });
      // The lookup the publisher makes before every upload: nothing delivered yet.
      if (url.startsWith('https://drive.test/drive/v3/files?q=')) return json({ files: [] });
      if (url.startsWith('https://drive.test')) return json(driveNow);
      if (url.includes(':append')) return json({ updates: {} }); // Sheets reports no row
      throw new Error(`unexpected call ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const publisher = livePublisher();
    const res = await publisher.publish(ctx, request([f]));
    if (!res.ok) throw new Error('publish failed');

    driveNow = { ...driveNow, size: '999', sha256Checksum: 'f'.repeat(64), trashed: true };
    const verified = await publisher.verify(ctx, res.value.publicationId);
    expect(verified.ok && verified.value).toEqual({
      consistent: false,
      differences: [
        { check: 'drive', fileId: 'drive-file-1', detail: 'The file is in the Drive trash' },
        { check: 'drive', fileId: 'drive-file-1', field: 'size', expected: f.byteSize, observed: '999' },
        { check: 'drive', fileId: 'drive-file-1', field: 'sha256', expected: f.sha256, observed: 'f'.repeat(64) },
        { check: 'sheets', detail: 'No Sheets row was recorded for this publication' },
      ],
    });
  });
});

describe('a publication whose Sheets row was not confirmed', () => {
  it('records why, and a replay retries only the row: nothing is uploaded again', async () => {
    const f = file('a.png', 'aaa');
    const req = request([f], 'pub-sheet-retry');
    let appendFails = true;
    let storedRow: string[] | undefined;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${url.split('?')[0]}`);
      if (url.startsWith('https://upload.test')) return json({ id: 'drive-file-1' });
      // The lookup the publisher makes before every upload: nothing delivered yet.
      if (url.startsWith('https://drive.test/drive/v3/files?q=')) return json({ files: [] });
      if (url.startsWith('https://drive.test')) return json({ id: 'drive-file-1', name: 'a.png', size: String(f.byteSize), mimeType: 'image/png', sha256Checksum: f.sha256 });
      if (url.includes('/values/A:A')) return json({ values: [] });
      if (url.includes(':append')) {
        if (appendFails) return new Response('backend error', { status: 500 });
        storedRow = JSON.parse(String(init?.body)).values[0];
        return json({ updates: { updatedRange: 'Sheet1!A7:G7' } });
      }
      if (url.includes('/values/A7:G7')) return json({ values: storedRow ? [storedRow] : [] });
      throw new Error(`unexpected call ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const publisher = livePublisher();

    const first = await publisher.publish(ctx, req);
    if (!first.ok) throw new Error('publish failed');
    expect(first.value.state).toBe('drive_complete');
    expect(first.value.sheet).toMatchObject({ synced: false, rowNumber: undefined });
    expect(first.value.detail).toMatchObject({ verified: true, sheetProblem: 'Sheets write failed: HTTP 500' });

    appendFails = false;
    calls.length = 0;
    const retry = await publisher.publish(ctx, req);
    if (!retry.ok) throw new Error('retry failed');
    expect(retry.value.publicationId).toBe(first.value.publicationId);
    expect(retry.value.state).toBe('complete');
    expect(retry.value.sheet).toMatchObject({ synced: true, rowNumber: 7 });
    expect(retry.value.detail).not.toHaveProperty('sheetProblem');
    expect(calls).toEqual([
      'GET https://sheets.test/v4/spreadsheets/sheet-kaae/values/A:A',
      'POST https://sheets.test/v4/spreadsheets/sheet-kaae/values/A1:append',
      'GET https://sheets.test/v4/spreadsheets/sheet-kaae/values/A7:G7',
    ]);
  });
});
