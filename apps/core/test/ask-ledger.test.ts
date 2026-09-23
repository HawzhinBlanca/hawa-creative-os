import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { askLedger } from '../src/services/ask-ledger.js';

const url = process.env.HAWA_ISOLATED_RUNTIME_DB;

/** The ledger reads each round of a design's revision chain from the runs' own records, oldest first. */
describe.skipIf(!url)('the ask ledger (PostgreSQL, application role)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const userId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId, role: 'operator' as const };
  afterAll(() => db.destroy());

  const task = async (trx: any, id: string, state: string, options: Record<string, unknown>, stages?: Record<string, unknown>) => {
    await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state) VALUES (${id}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Ledger check', ${state}::hawa.task_state)`.execute(trx);
    await sql`INSERT INTO hawa.outbox_commands (id, tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, 'task', ${id}::uuid, 'task.created', ${'ledger:' + id}, ${JSON.stringify({ studioOptions: options })}::jsonb)`.execute(trx);
    if (stages) {
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${id}::uuid, ${kaae}::uuid, ${userId}, ${'ledger_' + id}, 'h', '{}'::jsonb, 'standard', 'transferred', ${JSON.stringify(stages)}::jsonb)`.execute(trx);
    }
  };

  it('gives the first design, then each change with its asks and what became of them', async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    await withRlsContext(db, scope, async (trx) => {
      await task(trx, first, 'human_review', {}, { brief: {} });
      await task(trx, second, 'human_review', { parentTaskId: first, revisionDirective: 'move the logo left', revisionRound: 1 }, {
        directed: { asks: [{ ask: 'move the logo left', op: 'logo_move_or_scale', status: 'done', seen: { made: true, why: 'logo left' } }], sideEffects: ['the date'] },
      });
      await task(trx, third, 'paused', { parentTaskId: second, revisionDirective: 'less empty space', revisionRound: 2 }, {
        directed: { refused: 'NEEDS_CLARIFICATION', asks: [{ ask: 'less empty space', status: 'asked' }], clarify: { question: 'With what?', options: ['bigger photos', 'bigger text'] }, frustrated: true },
      });
    });
    const rounds = await askLedger(db, scope, third);
    expect(rounds.map((r) => [r.taskId, r.round])).toEqual([[first, 0], [second, 1], [third, 2]]);
    expect(rounds[0]).toMatchObject({ asks: [], sideEffects: [] });
    expect(rounds[0].directive).toBeUndefined();
    expect(rounds[1]).toMatchObject({ directive: 'move the logo left', asks: [{ ask: 'move the logo left', op: 'logo_move_or_scale', status: 'done', seen: { made: true } }], sideEffects: ['the date'] });
    expect(rounds[2]).toMatchObject({ question: { question: 'With what?', options: ['bigger photos', 'bigger text'], answered: false }, frustrated: true, taskState: 'paused' });
    // Another tenant reads nothing of it.
    const other = await askLedger(db, { tenantId: '00000000-0000-4000-a000-000000000002', userId, role: 'operator' }, third);
    expect(other).toEqual([]);
  });
});
