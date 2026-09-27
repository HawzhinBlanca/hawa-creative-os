import {runReceiptAudit} from './fixtures/run-receipt-audit.js';
import { describe, expect, it, afterAll, vi } from 'vitest';
import { FakePublisher } from '@hawa/testkit';
import { SYSTEM_AUTOMATION_USER_ID, type Publisher, type PublicationExpectation } from '@hawa/contracts';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { randomUUID } from 'node:crypto';
import { GooglePublisher } from '@hawa/integrations';
import { startFakeDriveServer } from '../../../packages/integrations/test/fake-drive-server.js';
import { sheetRowIdentity } from '../../../packages/integrations/src/google-sheet-row.js';
import { PublicationExpectations, PostgresSheetExpectationStore } from '../src/services/publication-expectations.js';
import { PostgresDriveUploadIdentityStore } from '../src/services/drive-upload-reservation.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => { await testDb.destroy(); await owner.destroy(); });
const tenantId = '00000000-0000-4000-a000-000000000001';
const automation = { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };

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

async function setup(publisher?: Publisher) {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true }, deliverableStore: exports.store, publisher });

  // A client whose DNA names a Drive folder but no spreadsheet, so Sheets can never confirm a row.
  const kaaeDna = await (await app.request(`/clients/${KAAE}/dna`)).json();
  const saveDna = async (spreadsheetId: string, sheetId = 0, folderId = kaaeDna.destinations.productionFolderId, name = 'No Sheet Client') => {
    const res = await app.request(`/clients/${NO_SHEET_CLIENT}/dna`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...kaaeDna, clientId: NO_SHEET_CLIENT, code: 'NOSHEET', name, destinations: { ...kaaeDna.destinations, productionFolderId: folderId, spreadsheetId, sheetId } }),
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
   * Waiting for the Sheets row. The database task stays publishing, while the durable publication
   * error makes the API and Desk show the staffed reconciliation status after a restart.
   */
  const reconciling = async (taskId: string) => {
    expect(await status(taskId)).toBe('PUBLISH_RECONCILIATION');
    expect((await (await app.request(`/tasks/${taskId}/publication-state`, { headers: auth })).json()).state).toBe('publish_reconciliation');
    expect((await (await app.request('/tasks?statuses=PUBLISH_RECONCILIATION', { headers: auth })).json()).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId, status: 'PUBLISH_RECONCILIATION' })]));
    expect((await (await app.request('/tasks?statuses=PUBLISHING', { headers: auth })).json()).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId })]));
  };

  return { app, saveDna, approvedTask, status, reconciling, exports };
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
    const audit = await (await runReceiptAudit(app,json)).json();
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


describe('configured reporting tab propagation', () => {
  it('uses the DNA tab in the provider request, receipt and staff link', async () => {
    const { app, saveDna, approvedTask } = await setup();
    await saveDna('sheet-for-no-sheet-client', 2);
    const taskId = await approvedTask();
    const response = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.publicationReceipt.sheet).toMatchObject({ sheetId: 2, synced: true });
    expect(result.sheetRowUrl).toContain('#gid=2&range=');
  });
});

describe('durable publication expectation', () => {
  async function frozen() {
    const publisher = new FakePublisher(); publisher.setFailureMode('sheet_fail');
    const calls = vi.spyOn(publisher, 'publish');
    const f = await setup(publisher); await f.saveDna('frozen-sheet');
    const taskId = await f.approvedTask();
    expect((await f.app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json })).status).toBe(202);
    const row = (await sql<{ publication_id: string; payload: PublicationExpectation }>`SELECT publication_id,payload FROM hawa.publication_expectations WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0];
    return { ...f, taskId, request: calls.mock.calls[0][1], ...row };
  }

  it('keeps the original destination, filenames and timestamp after DNA changes and Core restart', async () => {
    const firstProvider = new FakePublisher(); firstProvider.setFailureMode('sheet_fail');
    const firstCall = vi.spyOn(firstProvider, 'publish');
    const { app, saveDna, approvedTask, exports } = await setup(firstProvider);
    await saveDna('original-sheet', 2, 'original-folder', 'Original Client');
    const taskId = await approvedTask();
    const first = await app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(first.status).toBe(202);
    const original = firstCall.mock.calls[0][1];
    await saveDna('changed-sheet', 1, 'changed-folder', 'Renamed Client');
    const restartedProvider = new FakePublisher(); const secondCall = vi.spyOn(restartedProvider, 'publish');
    const restarted = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true }, deliverableStore: exports.store, publisher: restartedProvider });
    const second = await restarted.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    const retried = secondCall.mock.calls[0][1];
    expect(retried.destination).toEqual(original.destination);
    expect(retried.files.map(f => f.filename)).toEqual(original.files.map(f => f.filename));
    expect(retried.sheetRow.publishedAt).toBe(original.sheetRow.publishedAt);
    expect(second.status).toBe(200);
  });

  it('binds a newly configured Sheet durably before mutation and recovers it with original Drive and timestamp', async () => {
    const server = await startFakeDriveServer();
    try {
      const store = new PostgresSheetExpectationStore(testDb);
      const provider = (failAfterSave: boolean) => new GooglePublisher({ oauthToken: 'synthetic', driveApiBaseUrl: server.url,
        driveUploadBaseUrl: server.url, sheetsApiBaseUrl: server.url,
        uploadIdentityStore: new PostgresDriveUploadIdentityStore(testDb), sheetExpectationStore: { prepare: async input => {
          await store.prepare(input); if (failAfterSave) throw new Error('Synthetic interruption after durable binding');
        } } });
      const f = await setup(provider(true)); const taskId = await f.approvedTask();
      const publish = (app = f.app) => app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
      expect((await publish()).status).toBe(202);
      const original = (await sql<{ payload: PublicationExpectation }>`SELECT payload FROM hawa.publication_expectations WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0].payload;
      expect(original.destination.spreadsheetId).toBe('');
      await f.saveDna('first-configured-sheet', 0, 'changed-folder');
      expect((await publish()).status).toBe(202);
      expect(server.getSheetRows('first-configured-sheet').some(r => r[0] === taskId)).toBe(false);
      const saved = (await sql<{ payload: { expectedValues: string[]; metadataId: number }; hash_valid: boolean }>`SELECT payload,
        payload_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS hash_valid
        FROM hawa.publication_sheet_expectations WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0];
      expect(saved.hash_valid).toBe(true); expect(saved.payload.expectedValues[3]).toBe(original.publishedAt);
      await f.saveDna('later-sheet', 2, 'another-folder', 'Another client name');
      const restarted = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true }, deliverableStore: f.exports.store, publisher: provider(false) });
      const done = await publish(restarted); expect(done.status).toBe(200);
      expect(server.getUploadedFiles()).toHaveLength(1);
      expect(server.getSheetRows('first-configured-sheet').filter(r => r[0] === taskId)).toEqual([saved.payload.expectedValues]);
      expect(server.getSheetRows('later-sheet').some(r => r[0] === taskId)).toBe(false);
      const receipt = (await sql<{ metadata_id: number; expected_values: string[]; expected_row_hash: string; observed_row_hash: string }>`SELECT * FROM hawa.sheet_syncs WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0];
      expect(receipt.metadata_id).toBe(saved.payload.metadataId);
      expect(receipt.expected_values).toEqual(saved.payload.expectedValues);
      expect(receipt.expected_row_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.observed_row_hash).toBe(receipt.expected_row_hash);
      await expect(sql`UPDATE hawa.sheet_syncs SET observed_row_hash=repeat('0',64) WHERE task_id=${taskId}::uuid`.execute(owner)).rejects.toThrow('SHEET_RECEIPT_EXPECTATION_CONFLICT');
      await expect(sql`UPDATE hawa.publication_sheet_expectations SET payload=payload WHERE task_id=${taskId}::uuid`.execute(owner)).rejects.toThrow('immutable');
    } finally { await server.close(); }
  });

  it('serializes competing first freezes and refuses changed approval, bytes and scope', async () => {
    const publisher = new FakePublisher(); const publishSpy = vi.spyOn(publisher, 'publish');
    const f = await setup(publisher); await f.saveDna('initial-sheet'); const taskId = await f.approvedTask();
    const stop = vi.spyOn(PublicationExpectations.prototype, 'freeze').mockRejectedValueOnce(new Error('Synthetic stop before expectation insert'));
    let args: Parameters<PublicationExpectations['freeze']>;
    try {
      expect((await f.app.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json })).status).toBe(503);
      args = stop.mock.calls[0]; expect(publishSpy).not.toHaveBeenCalled();
    } finally { stop.mockRestore(); }
    const service = new PublicationExpectations(testDb);
    const proposed = args![2];
    const [a, b] = await Promise.all([service.freeze(...args!), service.freeze(args![0], args![1], { ...proposed, destination: { ...proposed.destination, productionRootFolderId: 'competing-folder' } })]);
    expect(a.destination).toEqual(b.destination);
    const count = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.publication_expectations WHERE task_id=${taskId}::uuid`.execute(owner)).rows[0].n;
    expect(count).toBe(1);
    for (const changed of [{ ...proposed, approvalId: randomUUID() }, { ...proposed, clientId: randomUUID() },
      { ...proposed, files: proposed.files.map(file => ({ ...file, sha256: '0'.repeat(64) })) }]) {
      await expect(service.freeze(args![0], args![1], changed)).rejects.toThrow('PUBLICATION_EXPECTATION_CONFLICT');
    }
  });

  it('protects original inputs from owner mutation and revokes readers with current client membership', async () => {
    const f = await frozen();
    const hash = (await sql<{ valid: boolean }>`SELECT payload_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS valid FROM hawa.publication_expectations WHERE publication_id=${f.publication_id}::uuid`.execute(owner)).rows[0];
    expect(hash.valid).toBe(true); expect(f.payload.files.every(file => !('content' in file))).toBe(true);
    await expect(sql`UPDATE hawa.publication_expectations SET payload=payload WHERE publication_id=${f.publication_id}::uuid`.execute(owner)).rejects.toThrow('immutable');
    await expect(sql`DELETE FROM hawa.publication_expectations WHERE publication_id=${f.publication_id}::uuid`.execute(owner)).rejects.toThrow('immutable');
    await expect(sql`TRUNCATE hawa.publication_expectations CASCADE`.execute(owner)).rejects.toThrow('immutable');
    await expect(sql`UPDATE hawa.publications SET package_sha256=repeat('0',64) WHERE id=${f.publication_id}::uuid`.execute(owner)).rejects.toThrow('frozen');
    await expect(sql`UPDATE hawa.publications SET input_protocol=0 WHERE id=${f.publication_id}::uuid`.execute(owner)).rejects.toThrow('immutable');
    const userId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic reader')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${NO_SHEET_CLIENT}::uuid,${userId}::uuid,'designer')`.execute(owner);
    const scope = { tenantId, userId, role: 'designer' as const };
    const read = () => withRlsContext(testDb, scope, trx => sql`SELECT * FROM hawa.publication_expectations WHERE publication_id=${f.publication_id}::uuid`.execute(trx));
    expect((await read()).rows).toHaveLength(1);
    await sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${userId}::uuid`.execute(owner);
    expect((await read()).rows).toHaveLength(0);
    await expect(withRlsContext(testDb, scope, trx => sql`INSERT INTO hawa.publication_expectations(tenant_id,publication_id,task_id,client_id,payload)
      VALUES(${tenantId}::uuid,${randomUUID()}::uuid,${f.taskId}::uuid,${NO_SHEET_CLIENT}::uuid,${JSON.stringify(f.payload)}::jsonb)`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    expect((await withRlsContext(testDb, { ...automation, tenantId: randomUUID() }, trx => sql`SELECT * FROM hawa.publication_expectations WHERE publication_id=${f.publication_id}::uuid`.execute(trx))).rows).toHaveLength(0);
  });

  it('refuses to invent original inputs for an unfinished protocol-0 publication', async () => {
    const f = await frozen(), legacyId = randomUUID(), key = `legacy-${randomUUID()}`;
    // An explicit historical-format fixture; this is not a claim of upgrading a live database.
    await sql`INSERT INTO hawa.publications(id,tenant_id,task_id,design_revision_id,approval_id,publication_key,package_manifest,package_sha256,state,input_protocol)
      SELECT ${legacyId}::uuid,tenant_id,task_id,design_revision_id,approval_id,${key},package_manifest,package_sha256,'drive_pending',0
      FROM hawa.publications WHERE id=${f.publication_id}::uuid`.execute(owner);
    await expect(new PublicationExpectations(testDb).freeze(tenantId, legacyId, { ...f.request, publicationKey: key })).rejects.toThrow('LEGACY_PUBLICATION_EXPECTATION_UNAVAILABLE');
    expect((await sql`SELECT * FROM hawa.publication_expectations WHERE publication_id=${legacyId}::uuid`.execute(owner)).rows).toHaveLength(0);
  });

  it('rejects an altered link, metadata identity or timestamp before binding a Sheet', async () => {
    const f = await frozen(), file = f.request.files[0];
    const fileId = await new PostgresDriveUploadIdentityStore(testDb).reserve({ tenantId, publicationKey: f.request.publicationKey,
      taskId: f.taskId, artifactId: file.artifactId, packageHash: f.request.packageHash,
      folderId: f.request.destination.productionRootFolderId, filename: file.filename, mimeType: file.mimeType, sha256: file.sha256 }, async () => `reserved-${randomUUID()}`);
    const destination = { tenantId, taskId: f.taskId, spreadsheetId: f.request.destination.spreadsheetId, sheetId: f.request.destination.sheetId };
    const identity = sheetRowIdentity(destination);
    const input = { ...destination, clientId: NO_SHEET_CLIENT, publicationKey: f.request.publicationKey, metadataId: identity.id, metadataValue: identity.value,
      expectedValues: [f.taskId, NO_SHEET_CLIENT, f.request.destination.productionRootFolderId, f.payload.publishedAt, 'COMPLETE', `https://drive.google.com/file/d/${fileId}/view`, f.request.packageHash] };
    const store = new PostgresSheetExpectationStore(testDb);
    await expect(store.prepare({ ...input, expectedValues: input.expectedValues.map((v, i) => i === 5 ? 'https://wrong.example/file' : v) })).rejects.toThrow('SHEET_EXPECTATION_CONFLICT');
    await expect(store.prepare({ ...input, expectedValues: input.expectedValues.map((v, i) => i === 3 ? '2026-01-01T00:00:00.000Z' : v) })).rejects.toThrow('SHEET_EXPECTATION_CONFLICT');
    await expect(store.prepare({ ...input, metadataId: input.metadataId + 1 })).rejects.toThrow('SHEET_EXPECTATION_IDENTITY_INVALID');
    await store.prepare(input); await store.prepare(input);
    await expect(store.prepare({ ...input, spreadsheetId: 'replacement' })).rejects.toThrow('SHEET_EXPECTATION_CONFLICT');
    expect((await sql`SELECT * FROM hawa.publication_sheet_expectations WHERE publication_id=${f.publication_id}::uuid`.execute(owner)).rows).toHaveLength(1);
  });
});
