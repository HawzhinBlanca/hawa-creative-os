import crypto, { createHash } from 'node:crypto';
import { describe, expect, it, vi, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import { signActionLink } from '@hawa/integrations';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

/** A signed approve-and-publish, posted as the review link's confirmation page does (ADR-159). */
const signedPublish = (taskId: string) => {
  const claims = { taskId, action: 'approve' as const, publish: true, exp: Math.floor(Date.now() / 1000) + 3600 };
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...claims, sig: signActionLink(claims) }) };
};

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * Delivery sends exactly the Canva exports the reviewer pinned when approving (owner decision,
 * 2026-09-19). Both publish routes used to invent their files instead: twelve fixed names and sizes
 * whose "sha256" hashed a label, or a single `sha256_png_hash`. In production the publisher then
 * uploaded zero-filled placeholders into the client's Drive folder.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A QA engine whose every run passes, for tests about something other than QA. */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

/** passingQa: the task's own brief would fail the route's fixed QA manifest (a Telegram task's does). */
function setup(opts: { passingQa?: boolean } = {}) {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store,
    ...(opts.passingQa ? { qaEngine: passingQa as never } : {}) });

  /** withClient false: a task that carries no client yet (as a chat-ingested task did until it was routed). */
  async function taskAwaitingApproval(withClient = true) {
    const created = await (
      await app.request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withClient
          ? { title: 'KAAE accreditation announcement', clientId: KAAE }
          : { title: 'Campaign for Erbil Citadel Holdings' }),
      })
    ).json();
    const taskId: string = created.id;
    if (!withClient) expect(created.clientId).toBeNull();
    const rev = await (
      await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: {
            id: 'doc_kaae',
            pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
            nodes: [{ id: 'hero', type: 'text', text: 'KAAE accreditation' }],
          },
        }),
      })
    ).json();
    // Postgres approves only a revision with a passing critical QA run on record.
    const qa = await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/qa`, { method: 'POST' });
    expect(qa.status).toBe(200);
    return { taskId, revisionId: rev.revisionId as string };
  }

  function approve(taskId: string, revisionId: string, pinnedExportIds?: unknown) {
    return app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', role: 'art_director', ...(pinnedExportIds !== undefined ? { pinnedExportIds } : {}) }),
    });
  }

  const status = async (taskId: string) => (await (await app.request(`/tasks/${taskId}`)).json()).status;
  const publishOmnichannel = (taskId: string) =>
    app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });

  return { app, exports, taskAwaitingApproval, approve, status, publishOmnichannel };
}

describe('approval pins the exported files the reviewer saw', () => {
  it('records each pin with the export\'s own hash and size', async () => {
    const { exports, taskAwaitingApproval, approve } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const bytes = new TextEncoder().encode('reviewed KAAE export');
    const exportId = exports.add(taskId, 'png', bytes);

    const res = await approve(taskId, revisionId, [exportId]);
    expect(res.status).toBe(201);
    expect((await res.json()).pinnedExports).toEqual([
      { artifactId: exportId, format: 'png', sha256: sha256(bytes), byteSize: bytes.length },
    ]);
  });

  it('refuses an id that is not a retrieved export of this task, or a malformed list, and approves nothing', async () => {
    const { exports, taskAwaitingApproval, approve, status } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const other = await taskAwaitingApproval();
    const otherTasksExport = exports.add(other.taskId);

    const foreign = await approve(taskId, revisionId, [otherTasksExport]);
    expect(foreign.status).toBe(422);
    expect((await foreign.json()).title).toBe('Export Not Found');

    const malformed = await approve(taskId, revisionId, ['not-an-id']);
    expect(malformed.status).toBe(422);
    expect((await malformed.json()).title).toBe('Invalid Pinned Exports');

    expect(await status(taskId)).not.toBe('APPROVED');
  });

  it('refuses approval when stored bytes disagree with the export metadata', async () => {
    const { exports, taskAwaitingApproval, approve, status } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const id = exports.add(taskId, 'png', new TextEncoder().encode('recorded final export'));
    exports.store.read = async () => new TextEncoder().encode('different bytes');
    const res = await approve(taskId, revisionId, [id]);
    expect(res.status).toBe(422);
    expect((await res.json()).title).toBe('Export Changed');
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
  });
});

describe('publish-omnichannel delivers exactly the pinned exports', () => {
  it('sends the pinned bytes and records only what the (emulated) publisher confirmed', async () => {
    const { app, exports, taskAwaitingApproval, approve, publishOmnichannel } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const bytes = new TextEncoder().encode('the approved KAAE design, exported');
    const exportId = exports.add(taskId, 'png', bytes);
    expect((await approve(taskId, revisionId, [exportId])).status).toBe(201);

    const res = await publishOmnichannel(taskId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('COMPLETE');
    expect(body.filesCount).toBe(1);
    expect(body).not.toHaveProperty('vaultUri');
    expect(body.publicationReceipt.emulated).toBe(false);
    expect(body.publicationReceipt.driveFiles).toEqual([
      expect.objectContaining({ artifactId: exportId, expectedSha256: sha256(bytes), observedSize: bytes.length, verified: true }),
    ]);

    // The stored receipt the reconciliation audit reads holds the confirmed file and row, nothing invented.
    const stored = (await (await app.request(`/tasks/${taskId}/publication-receipt`)).json()).receipt;
    expect(stored.files).toEqual([
      expect.objectContaining({ taskId, fileId: expect.stringMatching(/^drive_file_/), sha256: sha256(bytes), byteSize: bytes.length }),
    ]);
    expect(stored.sheetRow.rowNumber).toBe(body.publicationReceipt.sheet.rowNumber);
    expect(stored.sheetRow.packageHash).toBe(sha256(new TextEncoder().encode(sha256(bytes))));
  });

  it('refuses approval with no explicit selection even when an export exists', async () => {
    const { app, exports, taskAwaitingApproval, approve, status, publishOmnichannel } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    exports.add(taskId);
    const decision = await approve(taskId, revisionId);
    expect(decision.status).toBe(422);
    expect((await decision.json()).title).toBe('Export Selection Required');

    const res = await publishOmnichannel(taskId);
    expect(res.status).toBe(409);
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
    expect((await app.request(`/tasks/${taskId}/publication-receipt`)).status).toBe(404);
  });

  it('refuses when the stored export changed after approval, or is gone', async () => {
    const { exports, taskAwaitingApproval, approve, status, publishOmnichannel } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const exportId = exports.add(taskId, 'png', new TextEncoder().encode('approved bytes'));
    expect((await approve(taskId, revisionId, [exportId])).status).toBe(201);

    exports.replaceBytes(exportId, new TextEncoder().encode('different bytes'));
    const changed = await publishOmnichannel(taskId);
    expect(changed.status).toBe(422);
    expect((await changed.json()).detail).toMatch(/no longer matches what was approved/);

    exports.remove(exportId);
    const gone = await publishOmnichannel(taskId);
    expect(gone.status).toBe(422);
    expect((await gone.json()).detail).toMatch(/is no longer stored/);
    expect(await status(taskId)).toBe('APPROVED');
  });

  it('never delivers a task without a client into another client\'s folder', async () => {
    const { exports, taskAwaitingApproval, approve, publishOmnichannel } = setup({ passingQa: true });
    const { taskId, revisionId } = await taskAwaitingApproval(false);
    const exportId = exports.add(taskId);
    expect((await approve(taskId, revisionId, [exportId])).status).toBe(201);

    const res = await publishOmnichannel(taskId);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/has no authorized Google Drive production destination folder/);
  });

  it('a signed WhatsApp approve-and-publish pins nothing, so it is refused before the task is approved', async () => {
    // Telegram approve commands and buttons never get this far: the webhook that read them was removed
    // by stage 2 of ADR-135, and a lifecycle request is approved in the Desk (ADR-022). The signed
    // WhatsApp action is the chat path that reaches delivery, and the pin check is what refuses it.
    const { app, taskAwaitingApproval, status } = setup();
    const { taskId } = await taskAwaitingApproval();

    const res = await app.request('/api/webhooks/whatsapp/actions', signedPublish(taskId));
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe('Nothing to deliver: the task has no approval. Approve in the Desk with the captured export selected.');
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
  });
});

describe('the Desk\'s Deliver route (/tasks/:id/publish) uses the same pins', () => {
  it('refuses without a pinned export before the task moves to PUBLISHING', async () => {
    const { app, taskAwaitingApproval, approve, status } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    expect((await approve(taskId, revisionId, [])).status).toBe(422);

    const res = await app.request(`/tasks/${taskId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
  });

  it('delivers the pinned export and reports no invented vault location', async () => {
    const { app, exports, taskAwaitingApproval, approve } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    const bytes = new TextEncoder().encode('approved export for the Deliver button');
    expect((await approve(taskId, revisionId, [exports.add(taskId, 'pdf', bytes)])).status).toBe(201);

    const res = await app.request(`/tasks/${taskId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).not.toHaveProperty('vaultUri');
    expect(body.receipt.driveFiles.map((f: any) => [f.mimeType, f.expectedSha256])).toEqual([['application/pdf', sha256(bytes)]]);
  });
});

describe('only the test suite emulates Google', () => {
  it('outside NODE_ENV=test, a delivery without Google credentials fails instead of reporting an emulated upload', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GOOGLE_OAUTH_TOKEN', '');
    try {
      const exports = memoryExportStore();
      const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store });
      const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' };
      const created = await (await app.request('/tasks', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Dev delivery', clientId: KAAE }) })).json();
      const taskId: string = created.id;
      const rev = await (
        await app.request(`/tasks/${taskId}/revisions`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Dev' }] } }),
        })
      ).json();
      expect((await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/qa`, { method: 'POST', headers: auth })).status).toBe(200);
      const approve = await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/decisions`, {
        method: 'POST',
        headers: { ...auth, Authorization: 'Bearer test_art_director_bearer' },
        body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
      });
      expect(approve.status).toBe(201);

      const res = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: auth });
      expect(res.status).toBe(422);
      expect((await res.json()).detail).toBe('Google Workspace credentials not configured; publication is unavailable and cannot complete');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
