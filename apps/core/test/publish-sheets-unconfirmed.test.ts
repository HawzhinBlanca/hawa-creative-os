import { describe, expect, it, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * A publication is COMPLETE only when the Drive files and the Sheets row are both confirmed. Until
 * 2026-09-19 publish-omnichannel marked the task COMPLETE whatever the Sheets outcome (and forced it
 * even when the transition was refused), while the Desk's Deliver route answered "unverified files or
 * missing credentials", left the task PUBLISHING and recorded nothing though the files were in Drive.
 * Now the task waits in PUBLISH_RECONCILIATION with the reason, and publishing again retries only the
 * Sheets row: the files are not uploaded twice. Postgres, where the task is read from, keeps it
 * PUBLISHING meanwhile; the publication-state route reports the row as owed.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
// FastPay's seeded client row, given KAAE's DNA without a spreadsheet: Postgres keeps DNA only
// for a client it holds.
const NO_SHEET_CLIENT = 'c1000000-0000-4000-8000-000000000004';
const json = { 'Content-Type': 'application/json' };
const auth = { ...json, Authorization: 'Bearer test_bearer' };

async function setup() {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store });

  // A client whose DNA names a Drive folder but no spreadsheet, so Sheets can never confirm a row.
  const kaaeDna = await (await app.request(`/clients/${KAAE}/dna`)).json();
  const saveDna = async (spreadsheetId: string) => {
    const res = await app.request(`/clients/${NO_SHEET_CLIENT}/dna`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...kaaeDna, clientId: NO_SHEET_CLIENT, code: 'NOSHEET', name: 'No Sheet Client', destinations: { ...kaaeDna.destinations, spreadsheetId } }),
    });
    expect(res.status).toBe(201);
  };
  await saveDna('');

  async function approvedTask() {
    const created = await (await app.request('/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'No sheet delivery', clientId: NO_SHEET_CLIENT }) })).json();
    const taskId: string = created.id || created.task?.id;
    const rev = await (
      await app.request(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Delivery' }] } }),
      })
    ).json();
    // Postgres approves only a revision with a passing critical QA run on record.
    expect((await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/qa`, { method: 'POST' })).status).toBe(200);
    const approve = await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/decisions`, {
      method: 'POST',
      headers: { ...auth, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
    });
    expect(approve.status).toBe(201);
    return taskId;
  }
  const status = async (taskId: string) => (await (await app.request(`/tasks/${taskId}`)).json()).status;
  /**
   * Waiting for the Sheets row. Postgres has no PUBLISH_RECONCILIATION task state, so the stored task
   * stays PUBLISHING; its publication (Drive done, no synced row) is what says the row is owed.
   */
  const reconciling = async (taskId: string) => {
    expect(await status(taskId)).toBe('PUBLISHING');
    expect((await (await app.request(`/tasks/${taskId}/publication-state`, { headers: auth })).json()).state).toBe('publish_reconciliation');
  };

  return { app, saveDna, approvedTask, status, reconciling };
}

describe('publish-omnichannel with the Sheets row unconfirmed', () => {
  it('delivers the files but does not mark the task COMPLETE, and says why', async () => {
    const { app, approvedTask, reconciling } = await setup();
    const taskId = await approvedTask();

    const res = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      status: 'PUBLISH_RECONCILIATION',
      complete: false,
      sheetProblem: 'No spreadsheet is configured for this client',
      sheetRowUrl: null,
      filesCount: 1,
    });
    expect(body.publicationReceipt.state).toBe('drive_complete');
    await reconciling(taskId);

    // The recorded receipt holds the delivered file and no Sheets row, so the audit reports the gap.
    const stored = (await (await app.request(`/tasks/${taskId}/publication-receipt`)).json()).receipt;
    expect(stored.files).toHaveLength(1);
    expect(stored.sheetRow).toBeUndefined();
    const audit = await (await app.request('/operations/reconciliation/run', { method: 'POST', headers: json, body: '{}' })).json();
    expect(audit.anomalies).toContainEqual(expect.objectContaining({ taskId, kind: 'MISSING_SHEET_ROW' }));
  });

  it('publishing again retries only the Sheets row, and completes once Sheets confirms it', async () => {
    const { app, saveDna, approvedTask, status, reconciling } = await setup();
    const taskId = await approvedTask();
    const first = await (await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json })).json();
    expect(first.status).toBe('PUBLISH_RECONCILIATION');

    // Still no spreadsheet: the retry stays in reconciliation.
    const stillMissing = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(stillMissing.status).toBe(202);
    await reconciling(taskId);

    await saveDna('sheet-for-no-sheet-client');
    const retry = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(retry.status).toBe(200);
    const done = await retry.json();
    expect(done).toMatchObject({ ok: true, status: 'COMPLETE', complete: true });
    expect(done.publicationReceipt.state).toBe('complete');
    expect(done.publicationReceipt.sheet).toMatchObject({ spreadsheetId: 'sheet-for-no-sheet-client', synced: true });
    expect(done.publicationReceipt.detail).not.toHaveProperty('sheetProblem');
    // Same publication, same Drive files: nothing was uploaded again.
    expect(done.publicationReceipt.publicationId).toBe(first.publicationReceipt.publicationId);
    expect(done.publicationReceipt.driveFiles).toEqual(first.publicationReceipt.driveFiles);
    expect(await status(taskId)).toBe('COMPLETE');
  });
});

describe('the Desk\'s Deliver route with the Sheets row unconfirmed', () => {
  it('reports the partial delivery with its reason instead of "unverified files", then completes on retry', async () => {
    const { app, saveDna, approvedTask, status, reconciling } = await setup();
    const taskId = await approvedTask();
    const deliver = () => app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers: auth, body: '{}' });

    const first = await deliver();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'PUBLISH_RECONCILIATION', sheetProblem: 'No spreadsheet is configured for this client' });
    await reconciling(taskId);

    await saveDna('sheet-for-no-sheet-client');
    const retry = await deliver();
    expect(retry.status).toBe(202);
    const done = await retry.json();
    expect(done.status).toBe('COMPLETE');
    expect(done).not.toHaveProperty('sheetProblem');
    expect(await status(taskId)).toBe('COMPLETE');
  });
});
