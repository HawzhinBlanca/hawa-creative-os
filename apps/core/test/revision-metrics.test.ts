import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { revisionMetrics } from '../src/services/revision-metrics.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * The revision loop's numbers move with what the pipeline records. Other test files write runs to the
 * same database while this one runs, so tenant-wide counts are checked to have grown by at least this
 * test's rows; the rows only this test writes (a unique ask, the photo_retouch op) are checked exactly.
 */
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
      const stages = {
        directed: {
          asks: [
            { ask: 'move the logo', op: 'logo_move_or_scale', status: 'done', by: 'rule', seen: { made: false, why: 'still right' } },
            { ask: marker, op: 'photo_retouch', status: 'not_possible', reason: 'x' },
            { ask: 'spread the text', op: 'align_or_spacing', status: 'not_done', seen: { made: false, why: 'same' } },
          ],
          sideEffects: ['the date'],
          frustrated: true,
        },
      };
      const asked = { directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { ask: 'less empty space', question: 'q', options: ['a', 'b'] } } };
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${userId}, ${'metrics_' + randomUUID()}, 'h', '{}'::jsonb, 'standard', 'failed', ${JSON.stringify(asked)}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${userId}, ${'metrics_' + randomUUID()}, 'h', '{}'::jsonb, 'standard', 'transferred', ${JSON.stringify(stages)}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.photo_cutouts (tenant_id, source_sha256, model, model_sha256, passed, png, width, height, report)
        VALUES (${tenantId}::uuid, ${randomUUID().replace(/-/g, '').padEnd(64, '0')}, 'm', ${'2'.repeat(64)}, false, '\\x00'::bytea, 1, 1, '{}'::jsonb)`.execute(trx);
    });
    const after = await revisionMetrics(db, { tenantId, userId }, 1);
    expect(after.asks.done - before.asks.done).toBeGreaterThanOrEqual(1);
    expect(after.asks.notPossible - before.asks.notPossible).toBeGreaterThanOrEqual(1);
    expect(after.asks.notDone - before.asks.notDone).toBeGreaterThanOrEqual(1);
    expect(after.notPossibleTop.some((a) => a.ask === marker && a.count === 1)).toBe(true);
    expect(after.cutouts.made - before.cutouts.made).toBeGreaterThanOrEqual(1);
    expect(after.cutouts.passed - before.cutouts.passed).toBeGreaterThanOrEqual(0);
    expect(after.days).toBe(1);
    const op = (list: typeof after.byOp, name: string) => list.find((o) => o.op === name) ?? { asks: 0, notPossible: 0 };
    expect(op(after.byOp, 'photo_retouch').notPossible - op(before.byOp, 'photo_retouch').notPossible).toBe(1);
    expect(after.questions.asked - before.questions.asked).toBeGreaterThanOrEqual(1);
    expect(after.editsWithSideEffects - before.editsWithSideEffects).toBeGreaterThanOrEqual(1);
    // Two asks checked: the logo recorded done and not seen made (a disagreement), the text not done and not seen (agreement).
    expect(after.visualCheck.checked - before.visualCheck.checked).toBeGreaterThanOrEqual(2);
    expect(after.visualCheck.agreed - before.visualCheck.agreed).toBeGreaterThanOrEqual(1);
    expect(after.visualCheck.doneButNotSeen - before.visualCheck.doneButNotSeen).toBeGreaterThanOrEqual(1);
    expect(after.frustrated - before.frustrated).toBeGreaterThanOrEqual(1);
    expect(after.madeBy.rule - before.madeBy.rule).toBeGreaterThanOrEqual(1);
  });
});
