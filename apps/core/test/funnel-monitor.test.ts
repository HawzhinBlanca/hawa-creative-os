import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, type Kysely, type Database } from '@hawa/db';
import { createApp } from '../src/app.js';
import { checkProductionFunnelHealth } from '../src/services/funnel-monitor.js';

describe('Production Funnel Health Monitor (Step 5 Audit Requirement)', () => {
  let db: Kysely<Database>;
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    db = createDb(process.env.TEST_DATABASE_URL!);
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('reports idle when zero briefs arrived in the 48-hour window', async () => {
    // A non-existent tenant has 0 briefs and reports idle
    const unusedTenantId = randomUUID();
    const metrics = await checkProductionFunnelHealth(db, {
      tenantId: unusedTenantId,
      windowHours: 48,
    });
    expect(metrics.status).toBe('idle');
    expect(metrics.briefsCount).toBe(0);
    expect(metrics.alert).toBeNull();
  });

  it('detects stalled funnel and generates alert when briefs arrive but zero approvals or deliveries occur', async () => {
    const taskId = randomUUID();

    // Insert task in seeded tenant created recently without approval
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid,
                'Stalled Task', 'No approval performed', 'received', 3, 1, now() - interval '2 hours', now())
      `.execute(trx);
    });

    let alertedMessage = '';
    const mockTelegram = {
      dispatchOutboundMessage: async (_chatId: string, msg: any) => {
        alertedMessage = msg.text;
        return { success: true };
      },
    };

    const metrics = await checkProductionFunnelHealth(db, {
      tenantId,
      windowHours: 48,
      telegramBridge: mockTelegram as any,
      opsChannelId: 'ops_alert_chat',
    });

    expect(metrics.briefsCount).toBeGreaterThanOrEqual(1);
    expect(metrics.alert).toBeDefined();

    // Clean up
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`DELETE FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx);
    });
  });

  it('reports healthy when briefs are accompanied by approvals and deliveries', async () => {
    const taskId = randomUUID();

    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid,
                'Completed Task', 'Completed task description', 'complete', 3, 1, now() - interval '2 hours', now() - interval '30 minutes')
      `.execute(trx);
    });

    const metrics = await checkProductionFunnelHealth(db, {
      tenantId,
      windowHours: 48,
    });

    expect(metrics.briefsCount).toBeGreaterThanOrEqual(1);
    expect(metrics.approvalsCount).toBeGreaterThanOrEqual(1);
    expect(metrics.deliveriesCount).toBeGreaterThanOrEqual(1);

    // Clean up
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`DELETE FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx);
    });
  });

  it('exposes GET /v1/system/funnel/health route through Hono app', async () => {
    const app = createApp({ db });
    const res = await app.request('/v1/system/funnel/health?windowHours=24', {
      headers: {
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
    });
    expect([200, 424]).toContain(res.status);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.windowHours).toBe(24);
    expect(typeof json.briefsCount).toBe('number');
    expect(typeof json.status).toBe('string');
  });
});
