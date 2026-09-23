import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { revisionMetrics } from '../src/services/revision-metrics.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/** The revision loop's numbers move with what the pipeline records, and only with it. */
describe.skipIf(!url)('revision metrics (PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const userId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId, role: 'operator' as const };
  afterAll(() => db.destroy());

  it('counts asks by outcome, the ones not possible by name, and cut-outs made and passed', async () => {
    const before = await revisionMetrics(db, { tenantId, userId }, 1);
    const taskId = randomUUID();
    const marker = `ask-${randomUUID().slice(0, 8)}`;
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Metrics check', 'human_review')`.execute(trx);
      const stages = { directed: { asks: [{ ask: 'move the logo', status: 'done' }, { ask: marker, status: 'not_possible', reason: 'x' }, { ask: 'spread the text', status: 'not_done' }] } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${userId}, ${'metrics_' + randomUUID()}, 'h', '{}'::jsonb, 'standard', 'transferred', ${JSON.stringify(stages)}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.photo_cutouts (tenant_id, source_sha256, model, model_sha256, passed, png, width, height, report)
        VALUES (${tenantId}::uuid, ${randomUUID().replace(/-/g, '').padEnd(64, '0')}, 'm', ${'2'.repeat(64)}, false, '\\x00'::bytea, 1, 1, '{}'::jsonb)`.execute(trx);
    });
    const after = await revisionMetrics(db, { tenantId, userId }, 1);
    expect(after.asks.done - before.asks.done).toBe(1);
    expect(after.asks.notPossible - before.asks.notPossible).toBe(1);
    expect(after.asks.notDone - before.asks.notDone).toBe(1);
    expect(after.notPossibleTop.some((a) => a.ask === marker && a.count === 1)).toBe(true);
    expect(after.cutouts.made - before.cutouts.made).toBe(1);
    expect(after.cutouts.passed - before.cutouts.passed).toBe(0);
    expect(after.days).toBe(1);
  });
});
