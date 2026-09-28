import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('durable Studio budget admission', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  let tenantId: string, clientId: string;
  beforeEach(async () => {
    tenantId = randomUUID(); clientId = randomUUID();
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
  const call = (runId: string, usd = 0.5) => {
    const id = randomUUID();
    return { id, runId, tenantId, stage: 'parity', provider: 'openai', model: 'synthetic',
      requestedModel: 'synthetic', callOrdinal: null,
      logicalCallSha256: createHash('sha256').update(id).digest('hex'),
      reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd,
        inputTokens: 100, outputTokens: 100 } };
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

  it('reserves the last dollars atomically across two database connections', async () => {
    const runId = await run({ maxUsd: 0.5, maxCalls: 10, spentUsd: 0, calls: 0 });
    const peer = createDb(url!);
    try {
      const results = await Promise.allSettled([repo.recordCallStart(call(runId, 0.3)),
        new DesignStudioRepository(peer).recordCallStart(call(runId, 0.3))]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'BUDGET_EXHAUSTED' } }]);
      expect(await new DesignStudioRepository(peer).getBudgetUsage(runId, tenantId))
        .toMatchObject({ reservedAdditionalUsd: 0.3, remainingUsd: 0.2 });
    } finally { await peer.destroy(); }
  });

  it('retains a successful estimate reservation across restart', async () => {
    const runId = await run({ maxUsd: 0.5, maxCalls: 10, spentUsd: 0, calls: 0 });
    const c = call(runId, 0.4); await repo.recordCallStart(c); await finish(c.id, 0.01);
    const peer = createDb(url!);
    try {
      await expect(new DesignStudioRepository(peer).recordCallStart(call(runId, 0.2)))
        .rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
      expect(await repo.getBudgetUsage(runId, tenantId))
        .toMatchObject({ accountedUsd: 0.01, reservedAdditionalUsd: 0.39, committedUsd: 0.4 });
    } finally { await peer.destroy(); }
  });

  it('refuses a missing or invalid reservation before admitting work', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 10, spentUsd: 0, calls: 0 });
    for (const usd of [NaN, Infinity, 0, -1]) {
      await expect(repo.recordCallStart(call(runId, usd))).rejects.toMatchObject({ code: 'STUDIO_BUDGET_INVALID' });
    }
    expect(await repo.getCallsForRun(runId, tenantId)).toHaveLength(0);
  });

  it('releases unused funds with complete usage and keeps its quote immutable', async () => {
    const runId = await run({ maxUsd: 0.5, maxCalls: 10, spentUsd: 0, calls: 0 });
    const c = call(runId, 0.4); await repo.recordCallStart(c);
    await expect(withRlsContext(db, { tenantId }, trx => sql`UPDATE hawa.design_studio_calls
      SET reservation=jsonb_set(reservation,'{usd}','0.01'), finished_at=now()
      WHERE id=${c.id}::uuid`.execute(trx))).rejects.toThrow(/identity is immutable/);
    await repo.finalizeCall({ id: c.id, tenantId, inputTokens: 1, outputTokens: 1,
      usdEstimate: 0.1, status: 'ok', costBasis: 'usage' });
    expect(await repo.getBudgetUsage(runId, tenantId)).toMatchObject({ reservedAdditionalUsd: 0, remainingUsd: 0.4 });
    await expect(repo.recordCallStart(call(runId, 0.4))).resolves.toMatchObject({ status: 'uncertain' });
  });

  it('preserves an overrun as evidence and blocks another call before the overall cap', async () => {
    const runId = await run({ maxUsd: 2, maxCalls: 10, spentUsd: 0, calls: 0 });
    const c = call(runId, 0.2); await repo.recordCallStart(c);
    await repo.finalizeCall({ id: c.id, tenantId, inputTokens: 1, outputTokens: 1,
      usdEstimate: 0.3, status: 'ok', costBasis: 'usage' });
    await expect(repo.recordCallStart(call(runId, 0.1)))
      .rejects.toMatchObject({ code: 'STUDIO_BUDGET_RESERVATION_EXCEEDED' });
    expect(await repo.getBudgetUsage(runId, tenantId)).toMatchObject({ accountedUsd: 0.3 });
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
