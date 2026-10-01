import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository, ModelCallFinalizationConflictError } from '../src/repositories/design-studio.repository.js';
import { sql } from 'kysely';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) {
  throw new Error('Isolated hawa_repair database required');
}

describe.skipIf(!url)('real PostgreSQL Design Studio v2 DB qualification', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const clientA = randomUUID();
  const clientB = randomUUID();

  const createTask = async (tenantId: string, clientId: string, title = 'Studio Task') => {
    const taskId = randomUUID();
    await withRlsContext(db, { tenantId }, async (trx) => {
      await sql`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, ${title})`.execute(trx);
    });
    return taskId;
  };

  beforeAll(async () => {
    // Insert tenant records using root scope
    await sql`INSERT INTO hawa.tenants(id, name, slug) VALUES (${tenantA}::uuid, 'Studio tenant A', ${tenantA})`.execute(db);
    await sql`INSERT INTO hawa.tenants(id, name, slug) VALUES (${tenantB}::uuid, 'Studio tenant B', ${tenantB})`.execute(db);

    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      await sql`INSERT INTO hawa.clients(id, tenant_id, code, name) VALUES (${clientA}::uuid, ${tenantA}::uuid, 'client_a', 'Client A')`.execute(trx);
    });
    await withRlsContext(db, { tenantId: tenantB }, async (trx) => {
      await sql`INSERT INTO hawa.clients(id, tenant_id, code, name) VALUES (${clientB}::uuid, ${tenantB}::uuid, 'client_b', 'Client B')`.execute(trx);
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('enforces RLS isolation across all 5 design studio tables for tenant_id', async () => {
    const reader=randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${reader}::uuid,${reader+'@test.invalid'},'Scoped Studio reader')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
      VALUES(${tenantA}::uuid,${reader}::uuid,'designer',true)`.execute(db);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES(${tenantA}::uuid,${clientA}::uuid,${reader}::uuid,'designer',true)`.execute(db);
    const taskA = await createTask(tenantA, clientA);
    const runIdA = randomUUID();
    const candIdA = randomUUID();
    const judgIdA = randomUUID();
    const callIdA = randomUUID();
    const fbIdA = randomUUID();

    // 1. Insert under Tenant A
    await withRlsContext(db, { tenantId: tenantA,userId:reader }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.createRun({
        id: runIdA,
        tenantId: tenantA,
        taskId: taskA,
        clientId: clientA,
        actorId: 'test_user_a',
        requestKey: 'req_key_1',
        requestHash: 'hash_1'.repeat(16),
        request: { topic: 'Luxury watch showcase' },
        tier: 'premium',
      });

      await repoTrx.insertCandidate({
        id: candIdA,
        runId: runIdA,
        tenantId: tenantA,
        ordinal: 0,
        concept: { headline: 'Timeless Elegance' },
      });

      await repoTrx.insertJudgment({
        id: judgIdA,
        runId: runIdA,
        tenantId: tenantA,
        kind: 'critique',
        candidateA: candIdA,
        verdict: { score: 9.2, passed: true },
      });

      await repoTrx.recordCallStart({
        id: callIdA,
        runId: runIdA,
        tenantId: tenantA,
        stage: 'critique',
        provider: 'anthropic',
        model: 'claude-fable-5-1',
        reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'claude-fable-5-1',
        callOrdinal: 1,
        logicalCallSha256: createHash('sha256').update(callIdA).digest('hex'),
      });

      await repoTrx.recordFeedback({
        id: fbIdA,
        tenantId: tenantA,
        taskId: taskA,
        runId: runIdA,
        candidateId: candIdA,
        actorId: 'test_user_a',
        source: 'desk',
        verdict: 'approve',
        rating: 9,
      });
    });

    // 2. Query as hawa_app under Tenant A scope -> should see all records
    await withRlsContext(db, { tenantId: tenantA,userId:reader }, async (trx) => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);

      const run = await trx.selectFrom('design_studio_runs').selectAll().where('id', '=', runIdA).executeTakeFirst();
      expect(run).toBeDefined();
      expect(run?.id).toBe(runIdA);

      const candidates = await trx.selectFrom('design_studio_candidates').selectAll().where('run_id', '=', runIdA).execute();
      expect(candidates).toHaveLength(1);

      const judgments = await trx.selectFrom('design_studio_judgments').selectAll().where('run_id', '=', runIdA).execute();
      expect(judgments).toHaveLength(1);

      const calls = await trx.selectFrom('design_studio_calls').selectAll().where('run_id', '=', runIdA).execute();
      expect(calls).toHaveLength(1);

      const feedback = await trx.selectFrom('design_feedback').selectAll().where('task_id', '=', taskA).execute();
      expect(feedback).toHaveLength(1);
    });

    // 3. Query as hawa_app under Tenant B scope -> must see 0 records across all tables!
    await withRlsContext(db, { tenantId: tenantB,userId:reader }, async (trx) => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);

      const run = await trx.selectFrom('design_studio_runs').selectAll().where('id', '=', runIdA).executeTakeFirst();
      expect(run).toBeUndefined();

      const candidates = await trx.selectFrom('design_studio_candidates').selectAll().where('run_id', '=', runIdA).execute();
      expect(candidates).toHaveLength(0);

      const judgments = await trx.selectFrom('design_studio_judgments').selectAll().where('run_id', '=', runIdA).execute();
      expect(judgments).toHaveLength(0);

      const calls = await trx.selectFrom('design_studio_calls').selectAll().where('run_id', '=', runIdA).execute();
      expect(calls).toHaveLength(0);

      const feedback = await trx.selectFrom('design_feedback').selectAll().where('task_id', '=', taskA).execute();
      expect(feedback).toHaveLength(0);
    });
  });

  it('admits only one cross-Core reservation for the same next paid call', async () => {
    const taskId = await createTask(tenantA, clientA);
    const runId = randomUUID();
    await repo.createRun({ id: runId, tenantId: tenantA, taskId, clientId: clientA,
      actorId: 'test_user', requestKey: `admission-${runId}`,
      requestHash: createHash('sha256').update(runId).digest('hex'),
      request: { prompt: 'admission race' }, tier: 'premium' });
    const peerDb = createDb(url!);
    const peer = new DesignStudioRepository(peerDb);
    const call = (id: string, digest: string) => ({ id, runId, tenantId: tenantA,
      stage: 'briefing', provider: 'openai', model: 'model-test', reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'model-test',
      callOrdinal: 1, logicalCallSha256: digest });
    try {
      const results = await Promise.allSettled([
        repo.recordCallStart(call(randomUUID(), 'a'.repeat(64))),
        peer.recordCallStart(call(randomUUID(), 'b'.repeat(64))),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await repo.getCallsForRun(runId, tenantA)).toHaveLength(1);
    } finally {
      await peerDb.destroy();
    }
  });

  it('enforces task admission under the restricted runtime database role', async () => {
    const taskId = await createTask(tenantA, clientA), runId = randomUUID(), actorId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId + '@example.test'},'Synthetic runtime operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantA}::uuid,${actorId}::uuid,'operator')`.execute(db);
    await repo.createRun({ id: runId, tenantId: tenantA, taskId, clientId: clientA,
      actorId: 'test_user', requestKey: `runtime-${runId}`, requestHash: 'b'.repeat(64), request: {}, tier: 'premium' });
    const admit = () => withRlsContext(db, { tenantId: tenantA, clientId: clientA, role: 'operator' }, async trx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);
      return repo.recordCallStart({ id: randomUUID(), runId, tenantId: tenantA, actorId, stage: 'parity',
        provider: 'openai', model: 'test', reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'test', callOrdinal: null,
        logicalCallSha256: createHash('sha256').update(randomUUID()).digest('hex') }, trx);
    });
    await expect(admit()).resolves.toMatchObject({ status: 'uncertain' });
    await sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${tenantA}::uuid AND user_id=${actorId}::uuid`.execute(db);
    await expect(admit()).rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED' });
    await sql`UPDATE hawa.tenant_memberships SET active=true WHERE tenant_id=${tenantA}::uuid AND user_id=${actorId}::uuid`.execute(db);
    await sql`UPDATE hawa.tasks SET state='complete' WHERE id=${taskId}::uuid`.execute(db);
    await expect(admit()).rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED' });
    expect(await repo.getCallsForRun(runId, tenantA)).toHaveLength(1);
  });

  it.each(['cancellation', 'abandonment', 'pause'])('serializes call admission behind %s and still finalizes an earlier admitted call', async closure => {
    const taskId = await createTask(tenantA, clientA);
    const runId = randomUUID();
    await repo.createRun({ id: runId, tenantId: tenantA, taskId, clientId: clientA,
      actorId: 'test_user', requestKey: `cancel-${runId}`, requestHash: 'a'.repeat(64), request: {}, tier: 'premium' });
    const admittedId = randomUUID();
    const call = (id: string, ordinal: number) => ({ id, runId, tenantId: tenantA, stage: 'briefing',
      provider: 'openai', model: 'test', reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'test', callOrdinal: ordinal,
      logicalCallSha256: createHash('sha256').update(id).digest('hex') });
    await repo.recordCallStart(call(admittedId, 1));
    const peer = createDb(url!);
    try {
      let pending!: Promise<unknown>;
      await withRlsContext(db, { tenantId: tenantA }, async trx => {
        await sql`SELECT id FROM hawa.tasks WHERE id=${taskId}::uuid FOR UPDATE`.execute(trx);
        if (closure === 'cancellation') await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(trx);
        else if (closure === 'pause') await sql`UPDATE hawa.tasks SET state='paused' WHERE id=${taskId}::uuid`.execute(trx);
        else await repo.updateRunStatus(runId, tenantA, 'abandoned', {}, trx);
        pending = new DesignStudioRepository(peer).recordCallStart(call(randomUUID(), 2)).catch(error => error);
        // Confirm the peer actually reached the task lock before releasing cancellation.
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          await sql`SELECT pg_stat_clear_snapshot()`.execute(trx);
          const locks = await sql<{blocked:boolean}>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND pid<>pg_backend_pid() AND pg_backend_pid()=ANY(pg_blocking_pids(pid))
          ) AS blocked`.execute(trx);
          if (locks.rows[0].blocked) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      });
      expect(await pending).toMatchObject({ code: closure==='pause'?'TASK_PAUSED':'TASK_GENERATION_BLOCKED' });
      await repo.finalizeCall({ id: admittedId, tenantId: tenantA, status: 'ok',
        inputTokens: 100, outputTokens: 10, usdEstimate: 0.01, responseId: 'synthetic-paid-reply' });
      expect(await repo.getCallsForRun(runId, tenantA)).toMatchObject([{ id: admittedId, status: 'ok', response_id: 'synthetic-paid-reply' }]);
    } finally { await peer.destroy(); }
  });

  it('holds new ordinals after a finished uncertain call without affecting a different task', async () => {
    const taskId = await createTask(tenantA, clientA), runId = randomUUID();
    await repo.createRun({ id: runId, tenantId: tenantA, taskId, clientId: clientA, actorId: 'test_user',
      requestKey: `uncertain-${runId}`, requestHash: 'c'.repeat(64), request: {}, tier: 'premium' });
    const id = randomUUID();
    const call = { id, runId, tenantId: tenantA, stage: 'briefing', provider: 'openai', model: 'test',
      reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'test', callOrdinal: 1, logicalCallSha256: 'c'.repeat(64) };
    await repo.recordCallStart(call);
    await repo.finalizeCall({ id, tenantId: tenantA, status: 'uncertain', inputTokens: 0, outputTokens: 0, usdEstimate: 0 });
    await expect(repo.recordCallStart({ ...call, id: randomUUID(), callOrdinal: 2, logicalCallSha256: 'd'.repeat(64) }))
      .rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
    const otherTask = await createTask(tenantA, clientA), otherRun = randomUUID();
    await repo.createRun({ id: otherRun, tenantId: tenantA, taskId: otherTask, clientId: clientA, actorId: 'test_user',
      requestKey: `other-${otherRun}`, requestHash: 'd'.repeat(64), request: {}, tier: 'premium' });
    await expect(repo.recordCallStart({ ...call, id: randomUUID(), runId: otherRun }))
      .resolves.toMatchObject({ status: 'uncertain' });
  });

  it('rejects deletion or mutation of completed run via immutability trigger', async () => {
    const taskA = await createTask(tenantA, clientA);
    const runId = randomUUID();

    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.createRun({
        id: runId,
        tenantId: tenantA,
        taskId: taskA,
        clientId: clientA,
        actorId: 'test_user',
        requestKey: 'req_key_immutable',
        requestHash: 'hash_immutable'.repeat(4),
        request: { prompt: 'Immutable test' },
        tier: 'standard',
      });

      // Valid update while active
      await repoTrx.updateRunStatus(runId, tenantA, 'conceiving');
      const updated = await repoTrx.getRunById(runId, tenantA);
      expect(updated?.status).toBe('conceiving');

      // Move to terminal status 'transferred'
      await repoTrx.updateRunStatus(runId, tenantA, 'transferred');
    });

    // In a new transaction, reject mutation of core identity
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      await expect(
        sql`UPDATE hawa.design_studio_runs SET actor_id = 'intruder' WHERE id = ${runId}::uuid`.execute(trx)
      ).rejects.toThrow('Design studio run core identification is immutable');
    });

    // In a new transaction, reject update of completed run
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await expect(
        repoTrx.updateRunStatus(runId, tenantA, 'briefing')
      ).rejects.toThrow('Completed design studio run is immutable (status: transferred)');
    });

    // In a new transaction, reject delete of run
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      await expect(
        sql`DELETE FROM hawa.design_studio_runs WHERE id = ${runId}::uuid`.execute(trx)
      ).rejects.toThrow('Design studio runs are append-only');
    });
  });

  it('enforces append-only call ledger and rejects update/deletion of finalized call', async () => {
    const taskA = await createTask(tenantA, clientA);
    const runId = randomUUID();
    const callId = randomUUID();

    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.createRun({
        id: runId,
        tenantId: tenantA,
        taskId: taskA,
        clientId: clientA,
        actorId: 'test_user',
        requestKey: 'req_key_calls',
        requestHash: 'hash_calls'.repeat(6),
        request: { prompt: 'Ledger test' },
        tier: 'premium',
      });

      // 1. Ledger start (inserted BEFORE network call)
      await repoTrx.recordCallStart({
        id: callId,
        runId,
        tenantId: tenantA,
        stage: 'render',
        provider: 'anthropic',
        model: 'claude-fable-5-1',
        reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'claude-fable-5-1',
        callOrdinal: 1,
        logicalCallSha256: createHash('sha256').update(callId).digest('hex'),
      });

      const pendingCall = (await repoTrx.getCallsForRun(runId, tenantA))[0];
      expect(pendingCall.status).toBe('uncertain');
      expect(pendingCall.input_tokens).toBe(0);
      expect(pendingCall.served_model).toBeNull();

      // 2. Finalize call after network response
      await repoTrx.finalizeCall({
        id: callId,
        tenantId: tenantA,
        responseId: 'msg_12345',
        servedModel: 'claude-fable-5-1-snapshot',
        providerRequestId: 'provider_req_12345',
        responseSha256: 'b'.repeat(64),
        latencyMs: 42,
        attempts: 1,
        inputTokens: 1500,
        cachedInputTokens: 1200,
        outputTokens: 450,
        images: 0,
        usdEstimate: 0.0125,
        status: 'ok',
      });

      const completedCall = (await repoTrx.getCallsForRun(runId, tenantA))[0];
      expect(completedCall.status).toBe('ok');
      expect(Number(completedCall.usd_estimate)).toBeCloseTo(0.0125, 4);
      expect(completedCall).toMatchObject({
        model: 'claude-fable-5-1', served_model: 'claude-fable-5-1-snapshot',
        provider_request_id: 'provider_req_12345', response_sha256: 'b'.repeat(64),
        latency_ms: 42, attempts: 1,
      });
    });

    // 3. Immutability: completed call cannot be updated again!
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      await expect(
        sql`UPDATE hawa.design_studio_calls SET output_tokens = 9999 WHERE id = ${callId}::uuid`.execute(trx)
      ).rejects.toThrow('Completed design studio call is immutable');
    });

    // 4. Immutability: call cannot be deleted!
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      await expect(
        sql`DELETE FROM hawa.design_studio_calls WHERE id = ${callId}::uuid`.execute(trx)
      ).rejects.toThrow('Design studio calls ledger is append-only');
    });
  });

  it('preserves a pending call identity and seals the first uncertain receipt', async () => {
    const taskId = await createTask(tenantA, clientA);
    const runId = randomUUID();
    const callId = randomUUID();
    await repo.createRun({ id: runId, tenantId: tenantA, taskId, clientId: clientA,
      actorId: 'test_user', requestKey: `sealed-call-${runId}`,
      requestHash: createHash('sha256').update(runId).digest('hex'),
      request: { prompt: 'seal the call identity' }, tier: 'premium' });
    await repo.recordCallStart({ id: callId, runId, tenantId: tenantA,
      stage: 'briefing', provider: 'openai', model: 'requested-model',
      reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel: 'requested-model', callOrdinal: 1,
      logicalCallSha256: createHash('sha256').update(callId).digest('hex') });

    for (const change of [
      sql`UPDATE hawa.design_studio_calls SET stage = 'judging' WHERE id = ${callId}::uuid`,
      sql`UPDATE hawa.design_studio_calls SET model = 'other-model' WHERE id = ${callId}::uuid`,
      sql`UPDATE hawa.design_studio_calls SET call_ordinal = 2 WHERE id = ${callId}::uuid`,
    ]) {
      await expect(withRlsContext(db, { tenantId: tenantA }, (trx) => change.execute(trx)))
        .rejects.toThrow('Design studio call identity is immutable');
    }
    await expect(withRlsContext(db, { tenantId: tenantA }, (trx) =>
      sql`UPDATE hawa.design_studio_calls SET usd_estimate = 0.03 WHERE id = ${callId}::uuid`.execute(trx)))
      .rejects.toThrow('Design studio call update must record its first outcome');

    await repo.finalizeCall({ id: callId, tenantId: tenantA, inputTokens: 0,
      outputTokens: 0, usdEstimate: 0, status: 'uncertain', errorCode: 'ACCEPTANCE_UNKNOWN' });
    const sealed = (await repo.getCallsForRun(runId, tenantA))[0];
    expect(sealed).toMatchObject({ stage: 'briefing', model: 'requested-model',
      status: 'uncertain', error_code: 'ACCEPTANCE_UNKNOWN' });
    expect(sealed.finished_at).not.toBeNull();
    await expect(repo.finalizeCall({ id: callId, tenantId: tenantA, inputTokens: 10,
      outputTokens: 10, usdEstimate: 0.03, status: 'ok' }))
      .rejects.toBeInstanceOf(ModelCallFinalizationConflictError);
    await expect(withRlsContext(db, { tenantId: tenantA }, (trx) =>
      sql`UPDATE hawa.design_studio_calls SET status = 'ok', usd_estimate = 0.03 WHERE id = ${callId}::uuid`.execute(trx)))
      .rejects.toThrow('Completed design studio call is immutable');
    expect((await repo.getCallsForRun(runId, tenantA))[0]).toMatchObject({
      status: 'uncertain', error_code: 'ACCEPTANCE_UNKNOWN',
    });
  });

  it('enforces one active run per task index constraint', async () => {
    const taskShared = await createTask(tenantA, clientA);
    const run1 = randomUUID();
    const run2 = randomUUID();

    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.createRun({
        id: run1,
        tenantId: tenantA,
        taskId: taskShared,
        clientId: clientA,
        actorId: 'test_user',
        requestKey: 'req_1',
        requestHash: 'hash_1'.repeat(16),
        request: { prompt: 'Active run 1' },
        tier: 'standard',
      });
    });

    // Second active run for same task must fail
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await expect(
        repoTrx.createRun({
          id: run2,
          tenantId: tenantA,
          taskId: taskShared,
          clientId: clientA,
          actorId: 'test_user',
          requestKey: 'req_2',
          requestHash: 'hash_2'.repeat(16),
          request: { prompt: 'Active run 2' },
          tier: 'standard',
        })
      ).rejects.toThrow();
    });

    // Mark run1 transferred (terminal status)
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.updateRunStatus(run1, tenantA, 'transferred');
    });

    // Now run2 can be created because run1 is no longer active!
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      const createdRun2 = await repoTrx.createRun({
        id: run2,
        tenantId: tenantA,
        taskId: taskShared,
        clientId: clientA,
        actorId: 'test_user',
        requestKey: 'req_2',
        requestHash: 'hash_2'.repeat(16),
        request: { prompt: 'Active run 2' },
        tier: 'standard',
      });
      expect(createdRun2.id).toBe(run2);
    });
  });

  it('enforces SHA256 integrity checks on candidate preview and art bytea', async () => {
    const taskA = await createTask(tenantA, clientA);
    const runId = randomUUID();

    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await repoTrx.createRun({
        id: runId,
        tenantId: tenantA,
        taskId: taskA,
        clientId: clientA,
        actorId: 'test_user',
        requestKey: 'req_hash_check',
        requestHash: 'hash_chk'.repeat(10),
        request: { prompt: 'Hash check' },
        tier: 'standard',
      });
    });

    const validBytes = Buffer.from('fake-png-data-12345');
    const validSha256 = createHash('sha256').update(validBytes).digest('hex');
    const invalidSha256 = '00'.repeat(32);

    // Mismatched preview_sha256 must fail CHECK constraint
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      await expect(
        repoTrx.insertCandidate({
          id: randomUUID(),
          runId,
          tenantId: tenantA,
          ordinal: 0,
          concept: {},
          previewPng: validBytes,
          previewSha256: invalidSha256,
        })
      ).rejects.toThrow();
    });

    // Matched preview_sha256 must succeed
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
      const repoTrx = new DesignStudioRepository(trx);
      const validCand = await repoTrx.insertCandidate({
        id: randomUUID(),
        runId,
        tenantId: tenantA,
        ordinal: 0,
        concept: {},
        previewPng: validBytes,
        previewSha256: validSha256,
      });
      expect(validCand.preview_sha256).toBe(validSha256);
    });
  });
});
