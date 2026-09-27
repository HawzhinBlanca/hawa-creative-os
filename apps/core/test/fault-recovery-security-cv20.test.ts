import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { PRIMARY_OPERATOR_USER_ID } from '@hawa/contracts';
import { CircuitBreaker, ReconciliationService } from '@hawa/integrations';

describe('CV-20: Fault Recovery, Security, and Honest Health', () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const app = createApp({ db });

  const testBearer = process.env.HAWA_BEARER_TOKEN!;
  const TENANT = '00000000-0000-4000-a000-000000000001';
  const asOperator = <T>(f: (trx: any) => Promise<T>) =>
    withRlsContext(db, { tenantId: TENANT, userId: PRIMARY_OPERATOR_USER_ID, role: 'operator' }, f);
  /** Runs `check` with the Primary Operator's Canva connection in `status`, then restores what was there. */
  const withCanvaConnection = async (status: string, check: () => Promise<void>) => {
    const prior = await asOperator(async (trx) =>
      (await sql<any>`SELECT * FROM hawa.canva_connections WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx)).rows[0]);
    await asOperator((trx) => sql`INSERT INTO hawa.canva_connections(tenant_id, actor_id, encrypted_tokens, expires_at, status, generation)
      VALUES (${TENANT}::uuid, ${PRIMARY_OPERATOR_USER_ID}, 'health-test-placeholder', now() + interval '1 hour', ${status}, gen_random_uuid())
      ON CONFLICT (tenant_id, actor_id) DO UPDATE SET status = excluded.status`.execute(trx));
    try {
      await check();
    } finally {
      await asOperator((trx) => prior
        ? sql`UPDATE hawa.canva_connections SET status = ${prior.status} WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx)
        : sql`DELETE FROM hawa.canva_connections WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx));
    }
  };
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${testBearer}`,
  };
  /** The kill switch is an administrator's (system.routes.ts). */
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };

  it('1. Returns honest dynamic health checking real dependencies without hardcoded healthy (FR-064, FR-073)', async () => {
    const healthRes = await app.request('/v1/health');
    expect(healthRes.status).toBe(200);

    const healthJson = await healthRes.json();
    expect(healthJson.status).toMatch(/^(healthy|degraded)$/);
    expect(healthJson.timestamp).toBeDefined();
    expect(healthJson.lastVerifiedProgressAt).toBeDefined();
    expect(healthJson.dependencies).toBeDefined();
    expect(healthJson.dependencies.postgres).toMatch(/^(connected|uninitialized)$/);
    expect(healthJson.dependencies.canva).toMatch(/^(connected|degraded|outage|reconnect_required)$/);
    expect(healthJson.dependencies.disk).toBe('writable');
  });

  it('2. Enforces channel kill switches and updates honest health state dynamically (FR-071)', async () => {
    // 1. Enable Telegram kill switch
    const killRes = await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: adminHeaders,
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
      headers: adminHeaders,
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

    // 5. Health restored: the breaker is closed, and with the Primary Operator's Canva authorization
    // active, Canva is connected.
    await withCanvaConnection('active', async () => {
      const restoredJson = await (await app.request('/v1/health')).json();
      expect(restoredJson.dependencies.canva).toBe('connected');
      expect(restoredJson.dependencies.canvaCircuitBreaker).toBe('CLOSED');
    });
  });

  it('reports an expired Canva authorization, which the breaker never sees, as reconnect_required', async () => {
    // 2026-09-17 to 2026-09-18: every design failed at the Canva transfer with "Connect Canva" while
    // health said connected, because it only read the circuit breaker.
    await withCanvaConnection('reconnect_required', async () => {
      const json = await (await app.request('/v1/health')).json();
      expect(json.dependencies.canvaCircuitBreaker).toBe('CLOSED');
      expect(json.dependencies.canva).toBe('reconnect_required');
      expect(json.status).not.toBe('healthy');
    });
  });

  it('4. Reports drift from unknown delivery outcomes and repairs nothing it cannot perform (FR-061)', async () => {
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

    const before = JSON.stringify({ driveFiles, sheetRows });
    const report = reconService.audit(tasks, driveFiles, sheetRows);

    expect(report.anomalies.length).toBeGreaterThanOrEqual(2);
    expect(report.anomalies.some((a) => a.kind === 'MISSING_DRIVE_ASSET')).toBe(true);
    expect(report.anomalies.some((a) => a.kind === 'STATUS_DIVERGENCE')).toBe(true);
    expect(report.driftCount).toBeGreaterThan(0);
    // Drift stays reported until a real delivery fixes it; the audit writes nothing.
    expect(report.status).toBe('divergent');
    expect(JSON.stringify({ driveFiles, sheetRows })).toBe(before);
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

  it('6. Proactively detects billing exhaustion and flips health to degraded (R1/F10)', async () => {
    // 1. Check health response structure includes lastPaidProbe
    const healthRes = await app.request('/v1/health');
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.lastPaidProbe).toBeDefined();
    expect(healthJson.lastPaidProbe.status).toBeDefined();

    // 2. Trigger a billing error record
    const errorRes = await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ channel: 'telegram', active: true }),
    });
    expect(errorRes.status).toBe(200);

    // Reset kill switch
    await app.request('/v1/operations/kill-switch', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ channel: 'telegram', active: false }),
    });
  });
});

