import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageFile, PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher } from '../src/google-publisher.js';

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
      if (url.startsWith('https://drive.test')) return json({ id: 'drive-file-1', name: 'a.png', size: String(f.byteSize), mimeType: 'image/png' });
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
    // Upload, Drive readback and the append; no Sheets readback of an unknown row.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('marks an emulated receipt as emulated', async () => {
    const res = await new GooglePublisher({ emulateNetworkForTesting: true, oauthToken: 'test' }).publish(ctx, request([file('a.png', 'aaa')]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.emulated).toBe(true);
  });
});
