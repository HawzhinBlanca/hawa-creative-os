import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('durable Studio budget admission', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  const tenantId = randomUUID(), clientId = randomUUID();
  beforeAll(async () => {
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Budget fixture',${tenantId})`.execute(db);
    await withRlsContext(db, { tenantId }, trx => sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
      VALUES(${clientId}::uuid,${tenantId}::uuid,'budget','Budget fixture')`.execute(trx));
  });
  afterAll(() => db.destroy());
  async function run(budget: Record<string, unknown>, transferred = true) {
    const taskId = randomUUID(), id = randomUUID();
    await withRlsContext(db, { tenantId }, trx => sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title)
      VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Budget fixture')`.execute(trx));
    await repo.createRun({ id, taskId, tenantId, clientId, actorId: 'fixture', requestKey: id,
      requestHash: 'a'.repeat(64), request: {}, tier: 'premium', budget });
    if (transferred) await repo.updateRunStatus(id, tenantId, 'transferred');
    return id;
  }
  const call = (runId: string) => {
    const id = randomUUID();
    return { id, runId, tenantId, stage: 'parity', provider: 'openai', model: 'synthetic',
      requestedModel: 'synthetic', callOrdinal: null,
      logicalCallSha256: createHash('sha256').update(id).digest('hex') };
  };
  async function finish(id: string, usdEstimate: number) {
    await repo.finalizeCall({ id, tenantId, inputTokens: 1, outputTokens: 1, usdEstimate, status: 'ok' });
  }

  it('counts distinct parity checks after the run snapshot is immutable', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 2, spentUsd: 0, calls: 0 });
    for (let i = 0; i < 2; i++) {
      const admitted = call(runId); await repo.recordCallStart(admitted); await finish(admitted.id, 0.01);
    }
    await expect(repo.recordCallStart(call(runId))).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect((await repo.getRunById(runId, tenantId))?.budget).toMatchObject({ spentUsd: 0, calls: 0 });
    expect(await repo.getCallsForRun(runId, tenantId)).toHaveLength(2);
  });

  it('retains completed spend when the run snapshot was never saved', async () => {
    const runId = await run({ maxUsd: 0.5, maxCalls: 20, spentUsd: 0, calls: 0 }, false);
    const admitted = call(runId); await repo.recordCallStart(admitted); await finish(admitted.id, 0.5);
    const peerDb = createDb(url!);
    try {
      await expect(new DesignStudioRepository(peerDb).recordCallStart(call(runId)))
        .rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    } finally { await peerDb.destroy(); }
  });

  it('lets only one process take the last call slot even with different parity inputs', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 1, spentUsd: 0, calls: 0 });
    const peerDb = createDb(url!);
    try {
      const results = await Promise.allSettled([
        repo.recordCallStart(call(runId)), new DesignStudioRepository(peerDb).recordCallStart(call(runId)),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toMatchObject([
        { reason: { code: 'BUDGET_EXHAUSTED' } },
      ]);
      expect(await repo.getCallsForRun(runId, tenantId)).toHaveLength(1);
    } finally { await peerDb.destroy(); }
  });

  it('refuses an incomplete historical ledger instead of treating unaccounted spend as free', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 20, spentUsd: 0.1, calls: 1 });
    await expect(repo.recordCallStart(call(runId))).rejects.toMatchObject({ code: 'STUDIO_BUDGET_HISTORY_INCOMPLETE' });
    expect(await repo.getCallsForRun(runId, tenantId)).toHaveLength(0);
  });

  it('enforces the same limit under the runtime role and isolates the displayed accounting', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 1, spentUsd: 0, calls: 0 }), actorId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId+'@example.test'},'Synthetic operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    const admit = () => withRlsContext(db, { tenantId, userId: actorId }, async trx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);
      return repo.recordCallStart({ ...call(runId), actorId }, trx);
    });
    await expect(admit()).resolves.toMatchObject({ status: 'uncertain' });
    await expect(admit()).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(await repo.getBudgetUsage(runId, tenantId, actorId))
      .toMatchObject({ admittedCalls: 1, unresolvedCalls: 1, blocker: 'BUDGET_EXHAUSTED' });
    expect(await repo.getBudgetUsage(runId, randomUUID(), actorId)).toBeNull();
  });

  it('refuses malformed persisted caps and nonfinite final costs', async () => {
    const runId = await run({ maxUsd: null, maxCalls: 10, spentUsd: 0, calls: 0 });
    await expect(repo.recordCallStart(call(runId))).rejects.toMatchObject({ code: 'STUDIO_BUDGET_INVALID' });
    const valid = await run({ maxUsd: 2, maxCalls: 10, spentUsd: 0, calls: 0 });
    const admitted = call(valid); await repo.recordCallStart(admitted);
    await expect(finish(admitted.id, Infinity)).rejects.toThrow(/finite nonnegative/);
    expect(await repo.getCallsForRun(valid, tenantId)).toMatchObject([{ finished_at: null, status: 'uncertain' }]);
  });
});
