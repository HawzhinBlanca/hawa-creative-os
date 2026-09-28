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

  it('reports unavailable data as unknown rather than zero activity', async () => {
    const metrics = await checkProductionFunnelHealth(null);
    expect(metrics.status).toBe('unknown');
    expect(metrics.briefsCount).toBeNull();
    expect(metrics.draftsCount).toBeNull();
    expect(metrics.stageDurations).toBeNull();
    expect(metrics.alert).toContain('PostgreSQL');
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
    expect(metrics.stageDurations?.briefToDraft.samples).toBe(0);
    expect(metrics.stageDurations?.briefToDraft.p50Hours).toBeNull();
  });

  it('does not page for a manual-only task merely because no draft exists', async () => {
    const taskId = randomUUID();

    // Insert task in seeded tenant created recently without approval
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid,
                'Stalled Task', 'No approval performed', 'received', 3, 1, now() - interval '2 hours', now())
      `.execute(trx);
    });

    const metrics = await checkProductionFunnelHealth(db, {
      tenantId,
      windowHours: 48,
    });

    expect(metrics.briefsCount).toBeGreaterThanOrEqual(1);
    expect(metrics.status).toBe('in_progress');
    expect(metrics.alert).toBeNull();

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

  it('flags one stuck automatic task even while another task has a Canva draft', async () => {
    const stuckId = randomUUID();
    const draftedId = randomUUID();
    const scope = { tenantId, userId: operatorUserId, role: 'operator' };
    await withRlsContext(db, scope, async (trx) => {
      for (const id of [stuckId, draftedId]) {
        await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Automatic poster', 'Approved exact copy',
            'received', 3, 1, now() - interval '3 hours', now() - interval '3 hours')`.execute(trx);
      }
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
        VALUES (${tenantId}::uuid, 'task', ${stuckId}::uuid, 'task.created', ${`test-stuck:${stuckId}`}, '{"autoGenerate":true}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (tenant_id, task_id, client_id, canva_design_id, edit_url)
        VALUES (${tenantId}::uuid, ${draftedId}::uuid, ${clientId}::uuid, ${`design-${draftedId}`}, 'https://www.canva.com/design/test/edit')`.execute(trx);
    });

    try {
      const metrics = await checkProductionFunnelHealth(db, { tenantId, windowHours: 48 });
      expect(metrics.draftsCount).toBeGreaterThanOrEqual(1);
      expect(metrics.status).toBe('stalled');
      expect(metrics.stalledTaskCount).toBeGreaterThanOrEqual(1);
      expect(metrics.oldestStalledTaskId).toBe(stuckId);
      expect(metrics.nextAction).toContain('Inspect');
      expect(metrics.stageDurations?.briefToDraft.samples).toBeGreaterThanOrEqual(1);
      expect(metrics.stageDurations?.briefToDraft.p95Hours).not.toBeNull();
    } finally {
      await withRlsContext(db, scope, async (trx) => {
        await sql`DELETE FROM hawa.outbox_commands WHERE aggregate_id = ${stuckId}::uuid`.execute(trx);
        await sql`DELETE FROM hawa.tasks WHERE id IN (${stuckId}::uuid, ${draftedId}::uuid)`.execute(trx);
      });
    }
  });

  it('exposes GET /v1/system/funnel/health route through Hono app', async () => {
    const app = createApp({ db });
    const res = await app.request('/v1/system/funnel/health?windowHours=24', {
      headers: {
        Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.windowHours).toBe(24);
    expect(typeof json.briefsCount).toBe('number');
    expect(typeof json.status).toBe('string');
  });
});
