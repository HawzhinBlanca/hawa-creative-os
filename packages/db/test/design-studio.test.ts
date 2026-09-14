import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';
import { sql } from 'kysely';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') {
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
    const taskA = await createTask(tenantA, clientA);
    const runIdA = randomUUID();
    const candIdA = randomUUID();
    const judgIdA = randomUUID();
    const callIdA = randomUUID();
    const fbIdA = randomUUID();

    // 1. Insert under Tenant A
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
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
        requestedModel: 'claude-fable-5-1',
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
    await withRlsContext(db, { tenantId: tenantA }, async (trx) => {
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
    await withRlsContext(db, { tenantId: tenantB }, async (trx) => {
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
        requestedModel: 'claude-fable-5-1',
      });

      const pendingCall = (await repoTrx.getCallsForRun(runId, tenantA))[0];
      expect(pendingCall.status).toBe('uncertain');
      expect(pendingCall.input_tokens).toBe(0);

      // 2. Finalize call after network response
      await repoTrx.finalizeCall({
        id: callId,
        tenantId: tenantA,
        responseId: 'msg_12345',
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
