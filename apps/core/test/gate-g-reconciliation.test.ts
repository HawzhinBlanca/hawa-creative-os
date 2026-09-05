import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Gate G: Google Drive & Sheets Self-Healing Reconciliation Daemon (FR-048, FR-049, FR-050, Invariant #12)', () => {
  const app = createApp();

  async function createPublishedTask(clientName: string = 'Aster Hotel') {
    // 1. Ingest via webhook
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 100000),
        message: { text: `Campaign for ${clientName}`, chat: { id: 777 } },
      }),
    });
    const json = await res.json();
    const taskId = json.task.id;

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

    // 3. Human Approval
    await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test_art_director_token',
      },
      body: JSON.stringify({
        decision: 'approved',
        role: 'art_director',
      }),
    });

    // 4. Omnichannel Publish
    const pubRes = await app.request(`/tasks/${taskId}/publish-omnichannel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(pubRes.status).toBe(200);

    return taskId;
  }

  it('runs baseline reconciliation and reports in-sync status when storage matches authoritative PostgreSQL state', async () => {
    const taskId = await createPublishedTask('Erbil Citadel Holdings');

    const res = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRepair: true }),
    });

    expect(res.status).toBe(201);
    const report = await res.json();
    expect(report.auditId).toBeDefined();
    expect(report.totalTasksAudited).toBeGreaterThan(0);
    expect(report.driftCount).toBe(0);
    expect(report.status).toBe('clean');

    // GET /operations/reconciliation retrieves the latest report
    const getRes = await app.request('/operations/reconciliation');
    expect(getRes.status).toBe(200);
    const latest = await getRes.json();
    expect(latest.auditId).toBe(report.auditId);
    expect(latest.status).toBe('clean');
  });

  it('detects MISSING_DRIVE_ASSET anomaly and self-heals by idempotently uploading package to Drive destination', async () => {
    const taskId = await createPublishedTask('Cihan Bank Erbil');

    // 1. Audit with simulateDrift (missing Google Drive deliverable) and autoRepair = false
    const auditRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: false,
        simulateDrift: {
          missingDriveTaskId: taskId,
        },
      }),
    });

    expect(auditRes.status).toBe(201);
    const auditReport = await auditRes.json();
    expect(auditReport.status).toBe('divergent');
    expect(auditReport.driftCount).toBeGreaterThanOrEqual(1);

    const driveAnomaly = auditReport.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'MISSING_DRIVE_ASSET');
    expect(driveAnomaly).toBeDefined();
    expect(driveAnomaly.severity).toBe('high');
    expect(driveAnomaly.repaired).toBe(false);

    // 2. Audit with autoRepair = true to self-heal
    const repairRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: true,
        simulateDrift: {
          missingDriveTaskId: taskId,
        },
      }),
    });

    expect(repairRes.status).toBe(201);
    const repairReport = await repairRes.json();
    expect(repairReport.status).toBe('repaired');
    expect(repairReport.repairedCount).toBeGreaterThanOrEqual(1);

    const repairedAnomaly = repairReport.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'MISSING_DRIVE_ASSET');
    expect(repairedAnomaly).toBeDefined();
    expect(repairedAnomaly.repaired).toBe(true);
    expect(repairedAnomaly.repairAction).toContain('Drive destination');

    // 3. Subsequent audit confirms system is cleanly back in sync
    const cleanRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRepair: true }),
    });
    const cleanReport = await cleanRes.json();
    expect(cleanReport.status).toBe('clean');
    expect(cleanReport.driftCount).toBe(0);
  });

  it('detects MISSING_SHEET_ROW anomaly and auto-heals by appending reporting row keyed by immutable taskId', async () => {
    const taskId = await createPublishedTask('Korek Telecom');

    // 1. Audit with missing Google Sheets ledger row
    const auditRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: false,
        simulateDrift: {
          missingSheetTaskId: taskId,
        },
      }),
    });

    const report = await auditRes.json();
    const sheetAnomaly = report.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'MISSING_SHEET_ROW');
    expect(sheetAnomaly).toBeDefined();
    expect(sheetAnomaly.severity).toBe('medium');
    expect(sheetAnomaly.repaired).toBe(false);

    // 2. Self-heal
    const repairRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: true,
        simulateDrift: {
          missingSheetTaskId: taskId,
        },
      }),
    });

    const repairReport = await repairRes.json();
    const fixedAnomaly = repairReport.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'MISSING_SHEET_ROW');
    expect(fixedAnomaly.repaired).toBe(true);
    expect(fixedAnomaly.repairAction).toContain(taskId);
  });

  it('detects STATUS_DIVERGENCE and restores PostgreSQL authoritative state to mirror spreadsheet', async () => {
    const taskId = await createPublishedTask('FastPay Kurdistan');

    // 1. Simulate desynchronized status in Sheet ('IN_PROGRESS' vs PostgreSQL authoritative 'COMPLETE')
    const auditRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: false,
        simulateDrift: {
          divergentTaskId: taskId,
          divergentStatus: 'IN_PROGRESS',
        },
      }),
    });

    const report = await auditRes.json();
    const divAnomaly = report.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'STATUS_DIVERGENCE');
    expect(divAnomaly).toBeDefined();
    expect(divAnomaly.description).toContain('PostgreSQL status (COMPLETE) disagrees with Google Sheets mirror (IN_PROGRESS)');
    expect(divAnomaly.repaired).toBe(false);

    // 2. Auto-heal restores authority
    const repairRes = await app.request('/operations/reconciliation/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoRepair: true,
        simulateDrift: {
          divergentTaskId: taskId,
          divergentStatus: 'IN_PROGRESS',
        },
      }),
    });

    const repairReport = await repairRes.json();
    const fixedDiv = repairReport.anomalies.find((a: any) => a.taskId === taskId && a.kind === 'STATUS_DIVERGENCE');
    expect(fixedDiv.repaired).toBe(true);
    expect(fixedDiv.repairAction).toContain('PostgreSQL authoritative status COMPLETE');
  });
});
