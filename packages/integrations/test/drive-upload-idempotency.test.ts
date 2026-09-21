import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PackageFile, PublishRequest, RequestContext } from '@hawa/contracts';
import { GooglePublisher } from '../src/google-publisher.js';
import { startFakeDrive, type FakeDrive } from './fake-drive.js';

/**
 * One logical delivery, one file in the client's folder.
 *
 * The publisher remembered what it had uploaded in a process-memory Map. An upload whose reply was
 * lost, or a process killed between the upload and the database record, left a file nothing
 * remembered, and the next process uploaded a second copy. A Drive lookup existed but ran only for
 * requests flagged isRetry or reconcileFirst, which no caller set, or for ids starting "synthetic".
 *
 * Every test here uses a NEW GooglePublisher for the second attempt, which is what a restart is, and
 * a local HTTP server that behaves like Drive: it parses the multipart upload, keeps the file's
 * properties and real SHA-256, and answers the properties query.
 */

let fake: FakeDrive;
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => { fake = await startFakeDrive(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.reset(); });

const ctx: RequestContext = {
  tenantId: 'tenant-default', taskId: 'task-idem', actor: { type: 'workflow', id: 'publisher' },
  correlationId: 'corr-idem', deadline: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'idem-drive',
};

function file(text: string, overrides: Partial<PackageFile> = {}): PackageFile {
  const content = new TextEncoder().encode(text);
  return {
    artifactId: 'art-poster', relativePath: 'poster.png', storageKey: 'memory:poster.png', filename: 'poster.png',
    mimeType: 'image/png', byteSize: content.length, sha256: sha(content), content, ...overrides,
  };
}

const request = (files: PackageFile[], key = 'pub-idem'): PublishRequest => ({
  taskId: 'task-idem', clientId: 'client-kaae', designRevisionId: 'rev-1', approvalId: 'approval-1',
  publicationKey: key, packageHash: 'package-hash', files,
  destination: { sharedDriveId: '', productionRootFolderId: 'folder-kaae', relativeFolderParts: [], spreadsheetId: 'sheet-kaae', sheetId: 0 },
  sheetRow: { taskId: 'task-idem' },
});

/** A process that has just started: no memory of anything. */
const freshProcess = () => new GooglePublisher({ oauthToken: 'live-token', driveApiBaseUrl: fake.base, driveUploadBaseUrl: fake.base, sheetsApiBaseUrl: fake.base });

describe('Drive delivery: one logical delivery, one file', () => {
  it('a restart after a successful delivery adopts the file instead of uploading it again', async () => {
    const f = file('approved poster bytes');
    const first = await freshProcess().publish(ctx, request([f]));
    expect(first.ok).toBe(true);
    const second = await freshProcess().publish(ctx, request([f]));
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(fake.files).toHaveLength(1);
    expect(fake.uploadsReceived).toBe(1);
    expect(second.value.driveFiles[0].fileId).toBe(first.value.driveFiles[0].fileId);
    expect(second.value.driveFiles[0].verified).toBe(true);
  });

  it('an upload whose reply was lost is found by the next process, not repeated', async () => {
    const f = file('approved poster bytes');
    fake.fault.dropUploadReply = 1;
    let firstOutcome: 'threw' | 'failed' | 'ok' = 'ok';
    try {
      const first = await freshProcess().publish(ctx, request([f]));
      firstOutcome = first.ok ? 'ok' : 'failed';
    } catch {
      firstOutcome = 'threw';
    }
    expect(firstOutcome).not.toBe('ok');
    expect(fake.files).toHaveLength(1); // Drive kept the file although nobody was told

    const second = await freshProcess().publish(ctx, request([f]));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fake.files).toHaveLength(1);
    expect(fake.uploadsReceived).toBe(1);
    expect(second.value.driveFiles[0]).toMatchObject({ fileId: 'file_1', verified: true });
  });

  it('uploads nothing when Drive cannot say whether the file is already there', async () => {
    for (const status of [500, 503, 429, 403]) {
      fake.fault.searchStatus = status;
      const res = await freshProcess().publish(ctx, request([file('approved poster bytes')], `pub-${status}`));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect((res.error as any).code).toBe('DRIVE_LOOKUP_FAILED');
      expect((res.error as any).retryable).toBe(true);
    }
    expect(fake.uploadsReceived).toBe(0);
    expect(fake.files).toHaveLength(0);
  });

  it('treats an answer without a file list as no answer', async () => {
    for (const body of ['{}', '{"files":null}', '[]', 'not json']) {
      fake.fault.searchBody = body;
      const res = await freshProcess().publish(ctx, request([file('approved poster bytes')], `pub-${body.length}`));
      expect(res.ok).toBe(false);
    }
    expect(fake.uploadsReceived).toBe(0);
  });

  it('uploads a changed revision of the same artifact beside the old one, and adopts neither wrongly', async () => {
    await freshProcess().publish(ctx, request([file('revision one')], 'pub-rev-1'));
    const second = await freshProcess().publish(ctx, request([file('revision two, edited in Canva')], 'pub-rev-2'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fake.files).toHaveLength(2);
    expect(second.value.driveFiles[0].fileId).toBe('file_2');
    expect(second.value.driveFiles[0].verified).toBe(true);
  });

  it("does not adopt a stranger's file that merely has the same name and size", async () => {
    const f = file('approved poster bytes');
    fake.files.push({
      id: 'someone_elses_file', name: f.filename, mimeType: f.mimeType, parents: ['folder-kaae'], properties: {},
      bytes: Buffer.from('x'.repeat(f.byteSize)), createdTime: new Date(Date.UTC(2026, 8, 1)).toISOString(),
    });
    const res = await freshProcess().publish(ctx, request([f]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.driveFiles[0].fileId).not.toBe('someone_elses_file');
    expect(fake.uploadsReceived).toBe(1);
    expect(fake.files).toHaveLength(2);
  });

  it('decides each file of a package on its own: one already delivered, one not', async () => {
    const poster = file('approved poster bytes');
    const story = file('approved story bytes', { artifactId: 'art-story', filename: 'story.png', relativePath: 'story.png', storageKey: 'memory:story.png' });
    await freshProcess().publish(ctx, request([poster], 'pub-multi'));
    expect(fake.files).toHaveLength(1);

    const res = await freshProcess().publish(ctx, request([poster, story], 'pub-multi'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fake.files).toHaveLength(2);
    expect(fake.uploadsReceived).toBe(2);
    expect(res.value.driveFiles.map((d) => d.fileId)).toEqual(['file_1', 'file_2']);
    expect(res.value.driveFiles.every((d) => d.verified)).toBe(true);
  });
});
