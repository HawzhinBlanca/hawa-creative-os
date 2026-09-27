import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('Studio daily scope admission in PostgreSQL', () => {
  const db = createDb(url), repo = new DesignStudioRepository(db);
  afterAll(() => db.destroy());
  const defaults = { officeUsd: 30, clientUsd: 30, roleUsd: 30, clients: {}, roles: {} };
  async function fixture(limits: Partial<typeof defaults> = {}) {
    const tenantId = randomUUID(), actorId = randomUUID(), clientId = randomUUID(), otherClient = randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Daily budget fixture',${tenantId})`.execute(db);
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId+'@example.test'},'Synthetic operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    const scope = { tenantId, userId: actorId };
    await withRlsContext(db, scope, async tx => {
      for (const id of [clientId, otherClient]) await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
        VALUES(${id}::uuid,${tenantId}::uuid,${id},'Daily fixture')`.execute(tx);
      await sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
        VALUES(${tenantId}::uuid,2,'Synthetic test limits',${JSON.stringify({ ...defaults, ...limits })}::jsonb)`.execute(tx);
    });
    const run = async (cid = clientId) => {
      const taskId = randomUUID(), id = randomUUID();
      await withRlsContext(db, scope, tx => sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title)
        VALUES(${taskId}::uuid,${tenantId}::uuid,${cid}::uuid,'Daily budget fixture')`.execute(tx));
      await repo.createRun({ id, taskId, tenantId, clientId: cid, actorId, requestKey: id,
        requestHash: 'a'.repeat(64), request: {}, tier: 'premium', budget: { maxUsd: 20, maxCalls: 100, spentUsd: 0, calls: 0 } });
      return id;
    };
    const call = (runId: string, usd: number, stage = 'parity') => {
      const id = randomUUID();
      return { id, runId, tenantId, actorId, stage, provider: 'openai', model: 'synthetic', requestedModel: 'synthetic',
        callOrdinal: null, logicalCallSha256: createHash('sha256').update(id).digest('hex'),
        reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd, inputTokens: 100, outputTokens: 100 } };
    };
    const finish = (id: string, usdEstimate: number, basis: 'usage' | 'estimate' = 'usage') => repo.finalizeCall({
      id, tenantId, inputTokens: 1, outputTokens: 1, usdEstimate, status: 'ok', costBasis: basis });
    const daily = async (runId: string) => (await repo.getBudgetUsage(runId, tenantId, actorId))!.daily!;
    return { tenantId, actorId, clientId, otherClient, scope, run, call, finish, daily };
  }
  // Owner-only historical fixture, isolated per-file database. Runtime cannot change admission time.
  async function historical(id: string, missingQuote = false) {
    await db.transaction().execute(async tx => {
      await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER immutable_design_studio_call`.execute(tx);
      await sql`UPDATE hawa.design_studio_calls SET started_at=now()-interval '2 days',
        reservation=CASE WHEN ${missingQuote} THEN NULL ELSE reservation END WHERE id=${id}::uuid`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER immutable_design_studio_call`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
    });
  }

  it('allows only one of two clients/connections to reserve the last office dollars', async () => {
    const f = await fixture({ officeUsd: 0.5 }), a = await f.run(), b = await f.run(f.otherClient);
    const peer = createDb(url!);
    try {
      const results = await Promise.allSettled([repo.recordCallStart(f.call(a, 0.3)),
        new DesignStudioRepository(peer).recordCallStart(f.call(b, 0.3))]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'BUDGET_EXHAUSTED' } }]);
      expect((await f.daily(a)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', heldUsd: 0.3, remainingUsd: 0.2 }));
    } finally { await peer.destroy(); }
  });

  it('retains reservations across new runs, abandonment, process recreation and midnight', async () => {
    const f = await fixture({ officeUsd: 0.5 }), old = await f.run(), c = f.call(old, 0.4);
    await repo.recordCallStart(c); await repo.updateRunStatus(old, f.tenantId, 'abandoned');
    await historical(c.id);
    const next = await f.run(f.otherClient), peer = createDb(url!);
    try {
      await expect(new DesignStudioRepository(peer).recordCallStart(f.call(next, 0.2)))
        .rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
      expect((await f.daily(next)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', spentUsd: 0, heldUsd: 0.4, remainingUsd: 0.1 }));
    } finally { await peer.destroy(); }
  });

  it('releases confirmed unused funds; prior-day final usage does not consume today', async () => {
    const f = await fixture({ officeUsd: 0.5 }), a = await f.run(), c = f.call(a, 0.4);
    await repo.recordCallStart(c); await f.finish(c.id, 0.1);
    expect((await f.daily(a)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', spentUsd: 0.1, heldUsd: 0, remainingUsd: 0.4 }));
    await historical(c.id);
    expect((await f.daily(a)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', spentUsd: 0, heldUsd: 0, remainingUsd: 0.5 }));
    await expect(repo.recordCallStart(f.call(await f.run(), 0.5))).resolves.toMatchObject({ spending_policy_version: 2 });
  });

  it('holds estimated successful charges from earlier days until exact evidence exists', async () => {
    const f = await fixture({ officeUsd: 0.5 }), a = await f.run(), c = f.call(a, 0.4);
    await repo.recordCallStart(c); await f.finish(c.id, 0.1, 'estimate'); await historical(c.id);
    await expect(repo.recordCallStart(f.call(await f.run(), 0.2))).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('enforces client and role limits across runs without exhausting unrelated scopes', async () => {
    const f = await fixture({ clientUsd: 0.5, roleUsd: 0.6 }), a = await f.run();
    await repo.recordCallStart(f.call(a, 0.4, 'art'));
    await expect(repo.recordCallStart(f.call(await f.run(), 0.2, 'parity'))).rejects.toThrow(/client/);
    const b = await f.run(f.otherClient);
    await expect(repo.recordCallStart(f.call(b, 0.3, 'art'))).rejects.toThrow(/asset_photoreal/);
    await expect(repo.recordCallStart(f.call(b, 0.3, 'parity'))).resolves.toMatchObject({ status: 'uncertain' });
  });

  it('applies explicit client/role overrides and treats zero as a stop', async () => {
    const f = await fixture(), a = await f.run();
    await withRlsContext(db, f.scope, tx => sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
      VALUES(${f.tenantId}::uuid,3,'Synthetic override',${JSON.stringify({ ...defaults, clients: { [f.clientId]: 0.2 }, roles: { visual_judge: 0 } })}::jsonb)`.execute(tx));
    await expect(repo.recordCallStart(f.call(a, 0.3, 'invented-stage'))).rejects.toThrow(/client/);
    await expect(repo.recordCallStart(f.call(a, 0.1, 'parity'))).rejects.toThrow(/visual_judge/);
    await expect(repo.recordCallStart(f.call(a, 0.2, 'invented-stage')))
      .resolves.toMatchObject({ spending_policy_version: 3, budget_role: 'creative_director' });
  });

  it('records an overrun and blocks new work in a different task once the office cap is spent', async () => {
    const f = await fixture({ officeUsd: 0.5 }), a = await f.run(), c = f.call(a, 0.4);
    await repo.recordCallStart(c); await f.finish(c.id, 0.7);
    await expect(repo.recordCallStart(f.call(await f.run(f.otherClient), 0.01))).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect((await f.daily(a)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', spentUsd: 0.7, remainingUsd: 0 }));
  });

  it('holds unknown historical spending without inventing a quote', async () => {
    const f = await fixture(), a = await f.run(), c = f.call(a, 0.4);
    await repo.recordCallStart(c); await historical(c.id, true);
    await expect(repo.recordCallStart(f.call(await f.run(), 0.01))).rejects.toMatchObject({ code: 'STUDIO_BUDGET_HISTORY_INCOMPLETE' });
  });

  it('refuses a new task when a prior run records missing spend or call history', async () => {
    const f = await fixture(), old = await f.run();
    await repo.updateRunStatus(old, f.tenantId, 'abandoned', { budget: { maxUsd: 20, maxCalls: 100, spentUsd: 0.2, calls: 1 } });
    await expect(repo.recordCallStart(f.call(await f.run(f.otherClient), 0.1)))
      .rejects.toMatchObject({ code: 'STUDIO_BUDGET_HISTORY_INCOMPLETE' });
    expect((await f.daily(old)).scopes).toContainEqual(expect.objectContaining({ scope: 'office', spentUsd: 0.2, historyIncomplete: true }));
  });

  it('does not turn floating-point snapshot rounding into a history hold', async () => {
    const f = await fixture(), old = await f.run();
    for (const usd of [0.1, 0.2]) { const c = f.call(old, usd); await repo.recordCallStart(c); await f.finish(c.id, usd); }
    await repo.updateRunStatus(old, f.tenantId, 'abandoned', { budget: { maxUsd: 20, maxCalls: 100, spentUsd: 0.1 + 0.2, calls: 2 } });
    await expect(repo.recordCallStart(f.call(await f.run(), 0.1))).resolves.toMatchObject({ status: 'uncertain' });
  });

  it('guards raw runtime inserts and cannot backdate admissions', async () => {
    const f = await fixture(), a = await f.run();
    const insert = (quoted: boolean) => withRlsContext(db, f.scope, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      return sql<{ started_at: Date }>`INSERT INTO hawa.design_studio_calls(id,tenant_id,run_id,stage,provider,model,requested_model,status,reservation,started_at)
        VALUES(${randomUUID()}::uuid,${f.tenantId}::uuid,${a}::uuid,'parity','openai','synthetic','synthetic','uncertain',
          ${quoted ? JSON.stringify(f.call(a, 0.1).reservation) : null}::jsonb,'2000-01-01') RETURNING started_at`.execute(tx);
    });
    await expect(insert(false)).rejects.toThrow(/require a reservation/);
    expect((await insert(true)).rows[0].started_at.getFullYear()).toBe(new Date().getFullYear());
    await expect(withRlsContext(db, f.scope, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      return sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
        VALUES(${f.tenantId}::uuid,3,'Forged allocation',${JSON.stringify(defaults)}::jsonb)`.execute(tx);
    })).rejects.toThrow(/permission|row-level security/);
  });

  it('keeps policy history immutable and accepts one concurrent expected version', async () => {
    const f = await fixture(), peer = createDb(url!);
    try {
      const append = (handle: typeof db) => withRlsContext(handle, f.scope, tx => sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
        VALUES(${f.tenantId}::uuid,3,'Concurrent edit',${JSON.stringify(defaults)}::jsonb)`.execute(tx));
      const results = await Promise.allSettled([append(db), append(peer)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      await expect(sql`DELETE FROM hawa.studio_spending_policies WHERE tenant_id=${f.tenantId}::uuid`.execute(db)).rejects.toThrow(/immutable/);
    } finally { await peer.destroy(); }
  });

  it('rejects malformed allocations, foreign clients, and rewriting an admitted policy identity', async () => {
    const f = await fixture(), other = await fixture();
    for (const limits of [
      { ...defaults, officeUsd: -1 }, { ...defaults, officeUsd: null },
      { ...defaults, roleUsd: 0.0000001 }, { ...defaults, roles: { invented: 1 } },
      { ...defaults, clients: { [other.clientId]: 1 } }, { ...defaults, extra: true },
    ]) {
      await expect(withRlsContext(db, f.scope, tx => sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
        VALUES(${f.tenantId}::uuid,3,'Invalid fixture',${JSON.stringify(limits)}::jsonb)`.execute(tx))).rejects.toThrow();
    }
    const c = f.call(await f.run(), 0.1); await repo.recordCallStart(c);
    await expect(sql`UPDATE hawa.design_studio_calls SET budget_role='asset_photoreal',finished_at=now() WHERE id=${c.id}::uuid`.execute(db))
      .rejects.toThrow(/policy identity is immutable/);
    await expect(sql`UPDATE hawa.design_studio_calls SET spending_policy_version=1,finished_at=now() WHERE id=${c.id}::uuid`.execute(db))
      .rejects.toThrow(/policy identity is immutable/);
    await expect(sql`UPDATE hawa.design_studio_calls SET usd_estimate='NaN'::numeric,finished_at=now() WHERE id=${c.id}::uuid`.execute(db))
      .rejects.toThrow(/studio_recorded_cost_finite/);
  });

  it('refuses a stale transaction snapshot and isolates financial summaries by tenant', async () => {
    const f = await fixture(), a = await f.run(), other = await fixture();
    await expect(db.transaction().setIsolationLevel('repeatable read').execute(tx => repo.recordCallStart(f.call(a, 0.1), tx)))
      .rejects.toMatchObject({ code: 'STUDIO_BUDGET_INVALID' });
    const result = await withRlsContext(db, other.scope, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      return sql<{ budget: unknown }>`SELECT hawa.studio_scope_budget(${f.clientId}::uuid) AS budget`.execute(tx);
    });
    expect(result.rows[0].budget).toBeNull();
    await expect(withRlsContext(db, other.scope, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      return sql`SELECT hawa.studio_scope_budget_internal(${f.tenantId}::uuid,${f.clientId}::uuid)`.execute(tx);
    })).rejects.toThrow(/permission/);
  });
});
