import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '@hawa/db';
import { CircuitBreaker, ReconciliationService } from '@hawa/integrations';

describe('CV-20: Fault Recovery, Security, and Honest Health', () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const app = createApp({ db });

  const testBearer = process.env.HAWA_BEARER_TOKEN!;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${testBearer}`,
  };

  it('1. Returns honest dynamic health checking real dependencies without hardcoded healthy (FR-064, FR-073)', async () => {
    const healthRes = await app.request('/v1/health');
    expect(healthRes.status).toBe(200);

    const healthJson = await healthRes.json();
    expect(healthJson.status).toMatch(/^(healthy|degraded)$/);
    expect(healthJson.timestamp).toBeDefined();
    expect(healthJson.lastVerifiedProgressAt).toBeDefined();
    expect(healthJson.dependencies).toBeDefined();
    expect(healthJson.dependencies.postgres).toMatch(/^(connected|uninitialized)$/);
    expect(healthJson.dependencies.canva).toMatch(/^(connected|degraded|outage)$/);
    expect(healthJson.dependencies.disk).toBe('writable');
  });

  it('2. Enforces channel kill switches and updates honest health state dynamically (FR-071)', async () => {
    // 1. Enable Telegram kill switch
    const killRes = await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ channel: 'telegram', active: true }),
    });
    expect(killRes.status).toBe(200);
    const killJson = await killRes.json();
    expect(killJson.active).toBe(true);

    // 2. Verify health degrades honestly
    const healthRes = await app.request('/v1/health');
    const healthJson = await healthRes.json();
    expect(healthJson.status).toBe('degraded');
    expect(healthJson.dependencies.telegram).toBe('kill_switch_active');

    // 3. Disable kill switch
    await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ channel: 'telegram', active: false }),
    });
  });

  it('3. Circuit breaker trips on simulated Canva outage and recovers cleanly (FR-065, FR-070)', async () => {
    // 1. Simulate Canva outage
    const outageRes = await app.request('/v1/operations/canva/simulate-outage', {
      method: 'POST',
      headers: authHeaders,
    });
    expect(outageRes.status).toBe(200);
    const outageJson = await outageRes.json();
    expect(outageJson.circuitBreaker.state).toBe('OPEN');

    // 2. Health must now reflect degraded or outage
    const healthRes = await app.request('/v1/health');
    const healthJson = await healthRes.json();
    expect(healthJson.dependencies.canva).toBe('outage');
    expect(healthJson.dependencies.canvaCircuitBreaker).toBe('OPEN');

    // 3. Inbound intake & task inspection remain available during Canva outage
    const getTasksRes = await app.request('/v1/tasks', { headers: authHeaders });
    expect(getTasksRes.status).toBe(200);

    // 4. Simulate Canva recovery
    const recoveryRes = await app.request('/v1/operations/canva/simulate-recovery', {
      method: 'POST',
      headers: authHeaders,
    });
    expect(recoveryRes.status).toBe(200);
    const recoveryJson = await recoveryRes.json();
    expect(recoveryJson.circuitBreaker.state).toBe('CLOSED');

    // 5. Health restored
    const restoredRes = await app.request('/v1/health');
    const restoredJson = await restoredRes.json();
    expect(restoredJson.dependencies.canva).toBe('connected');
    expect(restoredJson.dependencies.canvaCircuitBreaker).toBe('CLOSED');
  });

  it('4. Reconciles unknown delivery outcomes and repairs drift automatically (FR-061)', async () => {
    const reconService = new ReconciliationService();

    const tasks = [
      { id: 't_recon_1', status: 'COMPLETE', clientId: 'c1', latestRevisionId: 'rev_1', packageHash: 'h1', updatedAt: new Date().toISOString() },
      { id: 't_recon_2', status: 'COMPLETE', clientId: 'c1', latestRevisionId: 'rev_2', packageHash: 'h2', updatedAt: new Date().toISOString() },
    ];

    const driveFiles = [
      { taskId: 't_recon_1', fileId: 'f1', folderId: 'fld1', sha256: 'h1', byteSize: 1024 },
      // t_recon_2 is missing from Drive (simulated dropped write)
    ];

    const sheetRows = [
      { taskId: 't_recon_1', rowNumber: 2, status: 'COMPLETE', packageHash: 'h1', syncedAt: new Date().toISOString() },
      { taskId: 't_recon_2', rowNumber: 3, status: 'IN_PROGRESS', packageHash: 'h2', syncedAt: new Date().toISOString() }, // status divergence
    ];

    const report = reconService.auditAndReconcile(tasks, driveFiles, sheetRows, true);

    expect(report.anomalies.length).toBeGreaterThanOrEqual(2);
    expect(report.anomalies.some((a) => a.kind === 'MISSING_DRIVE_ASSET')).toBe(true);
    expect(report.anomalies.some((a) => a.kind === 'STATUS_DIVERGENCE')).toBe(true);
    expect(report.driftCount).toBeGreaterThan(0);
    expect(report.repairedCount).toBeGreaterThan(0);
  });

  it('5. Proves acknowledged tasks survive application reload (RPO = 0s, RTO < 5s) (FR-059, FR-060)', async () => {
    // 1. Ingest task in first instance
    const taskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientId: 'c1000000-0000-4000-8000-000000000002',
        title: 'Crash Recovery Test Task',
        brief: {
          description: 'Testing task survival across simulated worker loss',
          targetAudience: 'University Leadership',
          exactCopy: [{ role: 'headline', text: 'کۆنفرانسی فەرمی' }],
        },
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskJson = await taskRes.json();
    const taskId = taskJson.task?.id || taskJson.id;
    expect(taskId).toBeDefined();

    // 2. Simulate complete app restart by creating a new app instance
    const restartStart = Date.now();
    const restartedApp = createApp({ db });
    const restartDuration = Date.now() - restartStart;

    // RTO must be well under 5 seconds (5000ms)
    expect(restartDuration).toBeLessThan(5000);

    // 3. Verify task exists in restarted app
    const fetchRes = await restartedApp.request(`/v1/tasks/${taskId}`, { headers: authHeaders });
    expect(fetchRes.status).toBe(200);
    const fetchJson = await fetchRes.json();
    expect(fetchJson.task?.id || fetchJson.id).toBe(taskId);
  });
});
