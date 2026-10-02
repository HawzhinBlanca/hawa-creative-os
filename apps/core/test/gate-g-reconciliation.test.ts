import {beforeAll as prepareDna} from 'vitest';
import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import {createApp as dnaFixtureCore} from '../src/app.js';
import {runReceiptAudit} from './fixtures/run-receipt-audit.js';
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createDb } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/** A QA engine whose every run passes: Postgres approves only a revision with a passing QA run. */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

describe('Gate G: reconciliation audit of recorded Drive & Sheets deliveries (FR-048, FR-049, FR-050, Invariant #12)', () => {
  const exports = memoryExportStore();
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true },  deliverableStore: exports.store, qaEngine: passingQa as never });

  async function createPublishedTask(title: string = 'Aster Hotel') {
    // 1. A task for a client whose DNA names a Drive destination (a task without a client is never delivered)
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c1000000-0000-4000-8000-000000000002', title: `Campaign for ${title}` }),
    });
    const json = await res.json();
    const taskId = json.id || json.task?.id;
    expect(taskId).toBeDefined();

    // 2. Register revision
    const revRes = await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: {
          id: 'doc_prod',
          pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }],
          nodes: [{ id: 'hero', type: 'text', text: 'Official Brand Asset' }],
        },
      }),
    });
    const { revisionId } = await revRes.json();

    expect((await app.request(`/tasks/${taskId}/revisions/${revisionId}/qa`, { method: 'POST' })).status).toBe(200);

    // 3. Human Approval, pinning the export the reviewer saw
    const exportId = exports.add(taskId);
    const approved = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer test_art_director_bearer`,
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
        pinnedExportIds: [exportId],
      }),
    });
    expect(approved.status).toBe(201);

    // 4. Omnichannel Publish
    const pubRes = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(pubRes.status).toBe(200);

    return taskId;
  }

  async function runAudit(body: Record<string, unknown> = {}) {
    return runReceiptAudit(app,{},body);
  }

  async function storedReceipt(taskId: string) {
    const res = await app.request(`/tasks/${taskId}/publication-receipt`);
    expect(res.status).toBe(200);
    return (await res.json()).receipt;
  }

  it('reports in-sync status when every published task has its recorded deliveries', async () => {
    await createPublishedTask('Erbil Citadel Holdings');

    const res = await runAudit();
    expect(res.status).toBe(201);
    const report = await res.json();
    expect(report.auditId).toBeDefined();
    expect(report.totalTasksAudited).toBeGreaterThan(0);
    expect(report.driftCount).toBe(0);
    expect(report.status).toBe('clean');
    expect(report.simulated).toBe(false);
    expect(report.basis).toContain('Google Drive and Google Sheets were not read, and nothing was repaired');

    // GET /operations/reconciliation retrieves the latest report
    const getRes = await app.request('/operations/reconciliation');
    expect(getRes.status).toBe(200);
    const latest = await getRes.json();
    expect(latest.latest.auditId).toBe(report.auditId);
    expect(latest.latest.status).toBe('clean');
  });

  it('reports a missing Drive delivery, refuses auto-repair, and invents no receipt', async () => {
    const taskId = await createPublishedTask('Cihan Bank Erbil');
    const baseline = await (await runAudit()).json();
    const filesBefore = (await storedReceipt(taskId)).files;

    // 1. Simulated drift is reported
    const auditRes = await runAudit({ simulateDrift: { missingDriveTaskId: taskId } });
    expect(auditRes.status).toBe(422);
    expect((await auditRes.json()).title).toBe('Receipt Simulation Retired');

    // 2. A simulation is never kept as the latest audit the Desk shows
    const latest = await (await app.request('/operations/reconciliation')).json();
    expect(latest.latest.auditId).toBe(baseline.auditId);

    // 3. Auto-repair is refused, and the stored receipt is untouched (it used to gain drive_repaired_* rows)
    const repairRes = await runAudit({ autoRepair: true, simulateDrift: { missingDriveTaskId: taskId } });
    expect(repairRes.status).toBe(422);
    expect((await repairRes.json()).title).toBe('Auto-Repair Not Available');
    const filesAfter = (await storedReceipt(taskId)).files;
    expect(filesAfter).toEqual(filesBefore);
    expect(JSON.stringify(filesAfter)).not.toMatch(/drive_repaired|sha256_auto_reconciled/);

    // 4. The real state was never missing the delivery
    expect((await (await runAudit()).json()).status).toBe('clean');
  });

  it('reports a missing Sheets row and refuses to invent one', async () => {
    const taskId = await createPublishedTask('Korek Telecom');

    const simulated = await runAudit({ simulateDrift: { missingSheetTaskId: taskId } });
    expect(simulated.status).toBe(422);

    const repairRes = await runAudit({ autoRepair: true, simulateDrift: { missingSheetTaskId: taskId } });
    expect(repairRes.status).toBe(422);
  });

  it('reports a status divergence without changing the recorded Sheets row', async () => {
    const taskId = await createPublishedTask('FastPay Kurdistan');

    const simulated = await runAudit({ simulateDrift: { divergentTaskId: taskId, divergentStatus: 'IN_PROGRESS' } });
    expect(simulated.status).toBe(422);

    // The simulation used to overwrite the stored receipt's row status in place.
    expect((await storedReceipt(taskId)).sheetRow.status).toBe('COMPLETE');
    expect((await (await runAudit()).json()).status).toBe('clean');

    const repairRes = await runAudit({ autoRepair: true, simulateDrift: { divergentTaskId: taskId, divergentStatus: 'IN_PROGRESS' } });
    expect(repairRes.status).toBe(422);
  });
});

prepareDna(async()=>{await persistClientDnaFixture(dnaFixtureCore({db:testDb}), 'c1000000-0000-4000-8000-000000000002',{Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`});});
