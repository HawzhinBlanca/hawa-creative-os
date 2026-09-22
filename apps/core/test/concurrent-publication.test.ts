import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PackageFile, PublishRequest, RequestContext } from '@hawa/contracts';
import { createDb, withSessionAdvisoryLock } from '@hawa/db';
import { GooglePublisher } from '@hawa/integrations';
import { startFakeDrive, type FakeDrive } from '../../../packages/integrations/test/fake-drive.js';

/**
 * Two processes deliver the same task in the same instant. The Drive lookup alone cannot stop a
 * duplicate here: both look, both find an empty folder, both upload. The per-task session lock in
 * PostgreSQL lets one through; the other is refused, retries, and adopts the first one's file.
 *
 * Two database handles and two publishers stand in for two Core processes.
 */
let fake: FakeDrive;
const processA = createDb(process.env.TEST_DATABASE_URL!);
const processB = createDb(process.env.TEST_DATABASE_URL!);

beforeAll(async () => { fake = await startFakeDrive(); });
afterAll(async () => { await fake.close(); await processA.destroy(); await processB.destroy(); });
beforeEach(() => { fake.reset(); });

const content = new TextEncoder().encode('approved poster bytes');
const poster: PackageFile = {
  artifactId: 'art-poster', relativePath: 'poster.png', storageKey: 'memory:poster.png', filename: 'poster.png',
  mimeType: 'image/png', byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex'), content,
};
const ctx = (taskId: string): RequestContext => ({
  tenantId: 'tenant-default', taskId, actor: { type: 'workflow', id: 'publisher' }, correlationId: randomUUID(),
  deadline: new Date(Date.now() + 60000).toISOString(), idempotencyKey: `idem-${taskId}`,
});
const request = (taskId: string): PublishRequest => ({
  taskId, clientId: 'client-kaae', designRevisionId: 'rev-1', approvalId: 'approval-1', publicationKey: `pub-${taskId}`,
  packageHash: 'package-hash', files: [poster],
  destination: { sharedDriveId: '', productionRootFolderId: 'folder-kaae', relativeFolderParts: [], spreadsheetId: 'sheet-kaae', sheetId: 0 },
  sheetRow: { taskId },
});
const publisher = () => new GooglePublisher({ oauthToken: 'live-token', driveApiBaseUrl: fake.base, driveUploadBaseUrl: fake.base, sheetsApiBaseUrl: fake.base });

describe('two processes delivering one task at once', () => {
  it('without the lock, both upload: the race is real', async () => {
    const taskId = randomUUID();
    fake.fault.uploadDelayMs = 150;
    const [a, b] = await Promise.all([publisher().publish(ctx(taskId), request(taskId)), publisher().publish(ctx(taskId), request(taskId))]);
    expect(a.ok && b.ok).toBe(true);
    expect(fake.files).toHaveLength(2);
  });

  it('with the lock, one delivers, the other is refused, and its retry adopts the file', async () => {
    const taskId = randomUUID();
    fake.fault.uploadDelayMs = 150;
    const deliver = (db: typeof processA) =>
      withSessionAdvisoryLock(db, `publish:${taskId}`, () => publisher().publish(ctx(taskId), request(taskId)));

    const [a, b] = await Promise.all([deliver(processA), deliver(processB)]);
    expect([a.acquired, b.acquired].sort()).toEqual([false, true]);
    const winner = a.acquired ? a : b;
    expect(winner.acquired && winner.value.ok).toBe(true);
    expect(fake.files).toHaveLength(1);
    expect(fake.uploadsReceived).toBe(1);

    const retry = await deliver(a.acquired ? processB : processA);
    expect(retry.acquired).toBe(true);
    if (!retry.acquired || !retry.value.ok) throw new Error('retry did not deliver');
    expect(retry.value.value.driveFiles[0]).toMatchObject({ fileId: 'file_1', verified: true });
    expect(fake.files).toHaveLength(1);
    expect(fake.uploadsReceived).toBe(1);
  });

  it('different tasks still deliver at the same time', async () => {
    fake.fault.uploadDelayMs = 100;
    const [t1, t2] = [randomUUID(), randomUUID()];
    const started = Date.now();
    const [a, b] = await Promise.all([
      withSessionAdvisoryLock(processA, `publish:${t1}`, () => publisher().publish(ctx(t1), request(t1))),
      withSessionAdvisoryLock(processB, `publish:${t2}`, () => publisher().publish(ctx(t2), request(t2))),
    ]);
    expect(a.acquired && b.acquired).toBe(true);
    expect(fake.files).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
