import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { computeActionSignature } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

/**
 * Delivery sends exactly the Canva exports the reviewer pinned when approving (owner decision,
 * 2026-09-19). Both publish routes used to invent their files instead: twelve fixed names and sizes
 * whose "sha256" hashed a label, or a single `sha256_png_hash`. In production the publisher then
 * uploaded zero-filled placeholders into the client's Drive folder.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function setup() {
  const exports = memoryExportStore();
  const app = createApp({ deliverableStore: exports.store });

  /** withClient false: a Telegram-ingested task, which carries no client until one is routed. */
  async function taskAwaitingApproval(withClient = true) {
    const created = withClient
      ? await (
          await app.request('/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'KAAE accreditation announcement', clientId: KAAE }),
          })
        ).json()
      : await (
          await app.request('/api/webhooks/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'expected_office_secret', 'Content-Type': 'application/json' },
            body: JSON.stringify({ update_id: 4242, message: { text: 'Campaign for Erbil Citadel Holdings', chat: { id: 777 } } }),
          })
        ).json();
    const taskId: string = created.id || created.task?.id;
    if (!withClient) expect(created.task.clientId).toBeNull();
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
    return { taskId, revisionId: rev.revisionId as string };
  }

  function approve(taskId: string, revisionId: string, pinnedExportIds?: unknown) {
    return app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' },
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
    expect(body.publicationReceipt.emulated).toBe(true);
    expect(body.publicationReceipt.driveFiles).toEqual([
      expect.objectContaining({ artifactId: exportId, expectedSha256: sha256(bytes), observedSize: bytes.length, verified: true }),
    ]);

    // The stored receipt the reconciliation audit reads holds the confirmed file and row, nothing invented.
    const stored = (await (await app.request(`/tasks/${taskId}/publication-receipt`)).json()).receipt;
    expect(stored.files).toEqual([
      expect.objectContaining({ taskId, fileId: `emulated_file_${exportId}`, sha256: sha256(bytes), byteSize: bytes.length }),
    ]);
    expect(stored.sheetRow.rowNumber).toBe(body.publicationReceipt.sheet.rowNumber);
    expect(stored.sheetRow.packageHash).toBe(sha256(new TextEncoder().encode(sha256(bytes))));
  });

  it('refuses when the approval pins nothing, and leaves the task approved', async () => {
    const { app, taskAwaitingApproval, approve, status, publishOmnichannel } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    expect((await approve(taskId, revisionId)).status).toBe(201);

    const res = await publishOmnichannel(taskId);
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe(
      'Nothing to deliver: the approval pins no exported file. Approve in the Desk with the captured export selected.'
    );
    expect(await status(taskId)).toBe('APPROVED');
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
    const { exports, taskAwaitingApproval, approve, publishOmnichannel } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval(false);
    const exportId = exports.add(taskId);
    expect((await approve(taskId, revisionId, [exportId])).status).toBe(201);

    const res = await publishOmnichannel(taskId);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/has no authorized Google Drive production destination folder/);
  });

  it('a signed WhatsApp approve-and-publish pins nothing, so it is refused before the task is approved', async () => {
    // Telegram approve commands and buttons never get this far: the webhook refuses them up front
    // (ADR-022, see telegram-unknown-task.test.ts). The signed WhatsApp action is the chat path that
    // reaches delivery, and the pin check is what refuses it.
    const { app, taskAwaitingApproval, status } = setup();
    const { taskId } = await taskAwaitingApproval();
    const sig = computeActionSignature(taskId, 'approve');

    const res = await app.request(`/api/webhooks/whatsapp/actions?taskId=${taskId}&action=approve&sig=${sig}&publish=true`);
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe('Nothing to deliver: the task has no approval. Approve in the Desk with the captured export selected.');
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
  });
});

describe('the Desk\'s Deliver route (/tasks/:id/publish) uses the same pins', () => {
  it('refuses without a pinned export before the task moves to PUBLISHING', async () => {
    const { app, taskAwaitingApproval, approve, status } = setup();
    const { taskId, revisionId } = await taskAwaitingApproval();
    expect((await approve(taskId, revisionId)).status).toBe(201);

    const res = await app.request(`/tasks/${taskId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).title).toBe('Nothing Approved To Deliver');
    expect(await status(taskId)).toBe('APPROVED');
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
    try {
      const exports = memoryExportStore();
      const app = createApp({ deliverableStore: exports.store });
      const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' };
      const created = await (await app.request('/tasks', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Dev delivery', clientId: KAAE }) })).json();
      const taskId: string = created.id || created.task?.id;
      const rev = await (
        await app.request(`/tasks/${taskId}/revisions`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Dev' }] } }),
        })
      ).json();
      const approve = await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/decisions`, {
        method: 'POST',
        headers: auth,
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
