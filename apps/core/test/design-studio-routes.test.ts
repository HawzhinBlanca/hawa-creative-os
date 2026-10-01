import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { CanvaFlowError } from '../src/services/canva-connect-service.js';
import type { DesignStudioService } from '../src/services/design-studio/index.js';
import { globalFeedbackMiner } from '@hawa/creative';

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('Design Studio HTTP Routes (T12)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const actorId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}`,
  };

  let app: any;
  let mockService: any;
  let taskId: string;
  let runId: string;
  let candidateId: string;
  let selectionState: 'laying_out' | 'awaiting_selection' = 'laying_out';
  const idemKey = `studio-route-${randomUUID()}`;

  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  const fakeSha = createHash('sha256').update(fakePng).digest('hex');

  // This suite intentionally has an incomplete historical budget. Importing old receipt
  // fixtures is an owner-only setup operation, not authorization for new provider dispatch.
  const historicalReceipt = (insert: (tx: Kysely<Database>) => Promise<unknown>) =>
    withRlsContext(db, { tenantId, userId: actorId }, async tx => {
      await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
      await insert(tx);
      await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
    });

  beforeAll(async () => {
    runId = randomUUID();
    candidateId = randomUUID();

    await sql`INSERT INTO hawa.users(id, email, display_name) 
      VALUES(${actorId}::uuid, 'isolated-operator@example.test', 'Test') 
      ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id, tenant_id, code, name) 
      VALUES(${clientId}::uuid, ${tenantId}::uuid, 'kaae', 'KAAE') 
      ON CONFLICT DO NOTHING`.execute(db);

    const intake = await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: `isolated-test-${randomUUID().slice(0, 8)}`,
      clientId,
      title: '[TEST] Studio Route Task',
      rawText: 'Keep title centered.\n---\n10th Anniversary Gala\n\nJoin us for an evening of celebration.',
      designInstructions: 'Keep title centered.',
      exactCopy: ['10th Anniversary Gala', 'Join us for an evening of celebration.'],
    });
    taskId = intake.task.id;

    // Seed database run and candidate rows for GET and image streaming tests
    await sql`INSERT INTO hawa.design_studio_runs (
      id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, budget, stages
    ) VALUES (
      ${runId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${actorId}::uuid,
      ${idemKey}, 'hash123', '{}', 'standard', 'briefing',
      '{"maxUsd":6.0,"maxCalls":40,"spentUsd":0.25,"calls":2}',
      '{}'
    )`.execute(db);

    await sql`INSERT INTO hawa.design_studio_candidates (
      id, run_id, tenant_id, ordinal, concept, status, score, preview_png, preview_sha256
    ) VALUES (
      ${candidateId}::uuid, ${runId}::uuid, ${tenantId}::uuid, 0,
      '{"name":"Editorial Classic","archetype":"editorial-centered"}',
      'draft', 8.9, ${fakePng}, ${fakeSha}
    )`.execute(db);

    mockService = {
      createOrGetRun: vi.fn(async (_scope, _tId, key, _params) => {
        if (key === idemKey) {
          return { run: { id: runId, status: 'briefing' }, created: true };
        }
        return { run: { id: runId, status: 'briefing' }, created: false };
      }),
      resume: vi.fn(async (_scope, _tId, _rId) => {
        return { runId, status: 'conceiving', stage: 'brief', spentUsd: 0.15 };
      }),
      selectCandidate: vi.fn(async (_scope, _tId, _rId, cId) => {
        if (selectionState !== 'awaiting_selection') {
          throw new CanvaFlowError(409, 'NOT_AWAITING_SELECTION', 'Run is not in awaiting_selection status');
        }
        return { runId, status: 'transferring', candidateId: cId };
      }),
      abandon: vi.fn(async (_scope, _tId, _rId, reason) => {
        const why = String(reason || '').trim();
        if (why.length < 3) {
          throw new CanvaFlowError(422, 'REASON_REQUIRED', 'Give a short reason');
        }
        return { runId, status: 'abandoned', message: 'Studio run abandoned' };
      }),
      runParityCheck: vi.fn(async (_scope, _rId) => {
        return {
          parity: 'match' as const,
          divergences: [],
          fontSubstituted: false,
          textReflowed: false,
          copyVisibleIdentical: true,
        };
      }),
    } as unknown as DesignStudioService;

    app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true }, 
      db,
      designStudioService: mockService,
    });
  });

  afterAll(async () => {
    await db.destroy().catch(() => {});
  });

  // 1. Authentication & Authorization Negative Controls
  describe('Authentication and Authorization', () => {
    it('finds the saved run for a task without admitting a new one', async () => {
    const res = await createApp({ db }).request(`/v1/tasks/${taskId}/canva/studio`, {
      headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, status: 'briefing' });
    const missing = await createApp({ db }).request(`/v1/tasks/${randomUUID()}/canva/studio`, {
      headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });

  it("starts a run for an API-key caller under the operator's uuid, not its label", async () => {
      // 81f4390 passed auth.actorId ('operator_1') as the actor; every studio start then failed in
      // Postgres with "invalid input syntax for type uuid" (task 8fb76534, 2026-09-19).
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': `uuid-actor-${randomUUID().slice(0, 8)}` },
        body: JSON.stringify({ width: 1080, height: 1350 }),
      });
      expect(res.status).toBe(202);
      const scope = mockService.createOrGetRun.mock.calls.at(-1)[0];
      expect(scope.actorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('maps intake tier and imagery names to the Studio\'s and refuses unknown ones (ADR-159)', async () => {
      const start = (body: Record<string, unknown>) => app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': `options-${randomUUID().slice(0, 8)}` },
        body: JSON.stringify({ width: 1080, height: 1350, ...body }) });
      expect((await start({ tier: 'fast', imagery: 'abstract' })).status).toBe(202);
      expect(mockService.createOrGetRun.mock.calls.at(-1)[3]).toMatchObject({ tier: 'standard', imagery: 'generated' });
      expect((await start({ tier: 'quality', imagery: 'none' })).status).toBe(202);
      expect(mockService.createOrGetRun.mock.calls.at(-1)[3]).toMatchObject({ tier: 'premium', imagery: 'none' });
      const calls = mockService.createOrGetRun.mock.calls.length;
      for (const bad of [{ tier: 'ultra' }, { imagery: 'painted' }, { tier: 7 }]) {
        const res = await start(bad);
        expect(res.status).toBe(422);
        expect((await res.json()).title).toBe('STUDIO_OPTIONS_INVALID');
      }
      expect(mockService.createOrGetRun.mock.calls.length).toBe(calls);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-enforce-auth': '1',
        },
        body: JSON.stringify({ width: 1080, height: 1350 }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when user has an unauthorized role', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-user-role': 'external_guest',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ width: 1080, height: 1350 }),
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.title).toBe('Design Studio Access Forbidden');
    });
  });

  // 2. Input Validation (UUIDs and required parameters)
  describe('Parameter Validation (422 and 400)', () => {
    it('returns 422 when taskId is not a valid UUID', async () => {
      const res = await app.request('/v1/tasks/invalid-uuid/canva/studio', {
        method: 'POST',
        headers: {
          ...headers,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.title).toBe('Invalid Identifier');
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: headers.Authorization,
        },
        body: JSON.stringify({ width: 1080, height: 1350 }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.title).toBe('Idempotency-Key Required');
    });

    it('returns 422 when selecting candidate with invalid UUID format', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${randomUUID()}/select`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ candidateId: 'not-a-valid-uuid' }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 when submitting design feedback with invalid verdict', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ verdict: 'unknown_action' }),
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.title).toBe('Invalid Verdict');
    });

    it('returns 422 when submitting design feedback with rating out of range', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ verdict: 'rating', rating: 15 }),
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.title).toBe('Invalid Rating');
    });
  });

  // 3. Studio Run Lifecycle End-to-End via HTTP
  describe('Studio Run Lifecycle', () => {
    it('POST /v1/tasks/:taskId/canva/studio creates a new run (202)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: {
          ...headers,
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify({
          width: 1080,
          height: 1350,
          tier: 'standard',
        }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.runId).toBe(runId);
      expect(body.status).toBe('briefing');
      expect(body.created).toBe(true);
    });

    it('POST /v1/tasks/:taskId/canva/studio is idempotent on repeated key', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio`, {
        method: 'POST',
        headers: {
          ...headers,
          'Idempotency-Key': 'repeated-key',
        },
        body: JSON.stringify({ width: 1080, height: 1350, tier: 'standard' }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.runId).toBe(runId);
      expect(body.created).toBe(false);
    });

    it('POST /v1/tasks/:taskId/canva/studio/:runId/resume advances stages', async () => {
      const resumeRes = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/resume`,
        {
          method: 'POST',
          headers,
        }
      );

      expect(resumeRes.status).toBe(200);
      const data = await resumeRes.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('conceiving');
      expect(data.stage).toBe('brief');
      expect(data.spentUsd).toBe(0.15);
    });

    it('GET /v1/tasks/:taskId/canva/studio/:runId returns full evidence without bytes', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}`, {
        headers,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.run).toBeDefined();
      expect(data.run.id).toBe(runId);
      expect(data.run.taskId).toBe(taskId);
      // The fixture's old spend has no matching ledger: it must remain visible and block admission.
      expect(data.run.budgetUsage).toMatchObject({ accountedUsd: 0.25, admittedCalls: 0,
        blocker: 'STUDIO_BUDGET_HISTORY_INCOMPLETE' });
      expect(data.candidates).toBeInstanceOf(Array);
      expect(data.candidates.length).toBe(1);

      // Verify URLs are provided without embedding raw image bytes
      const firstCandidate = data.candidates[0];
      // The address names the picture's hash, so it is immutable (ADR-035).
      expect(firstCandidate.previewUrl).toContain(`/candidates/${firstCandidate.id}/preview/${fakeSha}.png`);
      expect(data.totalUsdEstimate).toBeGreaterThanOrEqual(0);
    });

    it('reports unknown model spend without presenting it as zero dollars', async () => {
      await historicalReceipt(tx => sql`INSERT INTO hawa.design_studio_calls
        (id, run_id, tenant_id, stage, provider, model, requested_model, status, error_code, reservation)
        VALUES (${randomUUID()}::uuid, ${runId}::uuid, ${tenantId}::uuid,
          'laying_out', 'openai', 'gpt-6-astra', 'gpt-6-astra', 'uncertain', 'UNCERTAIN_ACCEPTANCE',
          ${JSON.stringify({ version: 1, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.1, inputTokens: 100, outputTokens: 100 })}::jsonb)`.execute(tx));
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.uncertainCallsCount).toBe(1);
      expect(data.totalUsdEstimate).toBeNull();
      expect(data.calls.find((call: any) => call.status === 'uncertain')).toMatchObject({
        usdEstimate: null, callOrdinal: null, logicalCallSha256: null,
        provider: 'openai', errorCode: 'UNCERTAIN_ACCEPTANCE',
      });
    });

    it('shows provider receipt metadata separately from the requested model without response content', async () => {
      const digest = 'a'.repeat(64);
      await historicalReceipt(tx => sql`INSERT INTO hawa.design_studio_calls
        (id, run_id, tenant_id, stage, provider, model, requested_model, status,
          response_id, served_model, provider_request_id, response_sha256, latency_ms, attempts, reservation)
        VALUES (${randomUUID()}::uuid, ${runId}::uuid, ${tenantId}::uuid,
          'briefing', 'openai', 'gpt-6-astra', 'gpt-6-astra', 'ok',
          'resp_route', 'gpt-6-astra-snapshot', 'req_route', ${digest}, 42, 1,
          ${JSON.stringify({ version: 1, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.1, inputTokens: 100, outputTokens: 100 })}::jsonb)`.execute(tx));
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      const call = data.calls.find((item: any) => item.responseId === 'resp_route');
      expect(call).toMatchObject({
        model: 'gpt-6-astra', servedModel: 'gpt-6-astra-snapshot',
        providerRequestId: 'req_route', responseSha256: digest,
        latencyMs: 42, attempts: 1,
      });
      expect(JSON.stringify(call)).not.toContain('EXACT TITLE');
    });

    it('GET /v1/tasks/:taskId/canva/studio/:runId returns 404 for unknown run', async () => {
      const unknownRunId = randomUUID();
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${unknownRunId}`, {
        headers,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/tasks/:taskId/canva/studio/:runId/select returns 409 Conflict when not in awaiting_selection', async () => {
      selectionState = 'laying_out';
      const res = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/select`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ candidateId }),
        }
      );
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.title).toBe('NOT_AWAITING_SELECTION');
    });

    it('POST /v1/tasks/:taskId/canva/studio/:runId/select succeeds (200) when run is awaiting_selection', async () => {
      selectionState = 'awaiting_selection';
      const res = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/select`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ candidateId }),
        }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('transferring');
    });

    it('POST /v1/tasks/:taskId/canva/studio/:runId/abandon transitions run to abandoned', async () => {
      const res = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/abandon`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason: 'Operator cancelled via desk' }),
        }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('abandoned');
    });

    it('refuses pending concepts, missing candidates and fractional ratings before recording learning evidence', async () => {
      const pendingId = randomUUID();
      await sql`INSERT INTO hawa.design_studio_candidates(id,run_id,tenant_id,ordinal,concept,status)
        VALUES(${pendingId}::uuid,${runId}::uuid,${tenantId}::uuid,99,'{}','draft')`.execute(db);
      for (const [payload, status] of [
        [{runId,candidateId:pendingId,verdict:'approve',rating:9},409],
        [{runId,verdict:'approve',rating:9},422],
        [{runId,candidateId,verdict:'approve',rating:9.5},422],
        [{runId,candidateId:randomUUID(),verdict:'approve',rating:9},409],
      ] as const) {
        const response = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
          method:'POST', headers, body:JSON.stringify(payload) });
        expect(response.status).toBe(status);
      }
      expect((await sql`SELECT id FROM hawa.design_feedback WHERE candidate_id=${pendingId}::uuid`.execute(db)).rows).toHaveLength(0);
    });

    it('POST /v1/tasks/:taskId/design-feedback records human feedback (201)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runId,
          candidateId,
          verdict: 'approve',
          rating: 9,
          notes: 'Excellent hierarchy and color harmony with deep navy',
          source: 'desk',
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.status).toBe('recorded');
      expect(data.verdict).toBe('approve');
      expect(data.rating).toBe(9);
      expect(data.rulesProposed).toBeGreaterThanOrEqual(1);
    });

    it('mines feedback only for the authorized task client, ignoring a spoofed body client', async () => {
      const otherClient = randomUUID(), otherRun = randomUUID(), otherCandidate = randomUUID();
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
        VALUES(${otherClient}::uuid,${tenantId}::uuid,${'isolated-'+otherClient},'Other Test Client')`.execute(db);
      const intake = await persistChatIntake(db, { platform:'telegram', sourceEventId:randomUUID(),
        sourceChannelId:`isolated-test-${randomUUID()}`, clientId:otherClient,
        title:'[TEST] Other Client',rawText:'Authorized other client copy',designInstructions:'',exactCopy:['Authorized other client copy'] });
      const otherTask = intake.task.id;
      await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status,budget,stages)
        VALUES(${otherRun}::uuid,${tenantId}::uuid,${otherTask}::uuid,${otherClient}::uuid,${actorId}::uuid,
        ${randomUUID()},'hash','{}','standard','briefing','{"maxUsd":6,"maxCalls":40,"spentUsd":0,"calls":0}','{}')`.execute(db);
      await sql`INSERT INTO hawa.design_studio_candidates(id,run_id,tenant_id,ordinal,concept,status,preview_png,preview_sha256)
        VALUES(${otherCandidate}::uuid,${otherRun}::uuid,${tenantId}::uuid,0,'{}','draft',${fakePng},${fakeSha})`.execute(db);
      const key = randomUUID();
      const payload = {runId:otherRun,candidateId:otherCandidate,clientId,verdict:'revise',notes:'Increase heading spacing for this client'};
      const response = await app.request(`/v1/tasks/${otherTask}/design-feedback`, {method:'POST',
        headers:{...headers,'Idempotency-Key':key,'x-user-role':'designer'},body:JSON.stringify(payload)});
      expect(response.status).toBe(201);
      const rules = globalFeedbackMiner.getCandidateRules(otherClient).filter(rule=>rule.provenance.feedbackId===key);
      expect(rules).toHaveLength(1);
      expect(rules[0].provenance).toMatchObject({clientId:otherClient,taskId:otherTask,actor:{role:'designer'}});
      expect(globalFeedbackMiner.getCandidateRules(clientId).some(rule=>rule.provenance.feedbackId===key)).toBe(false);
      const replay = await app.request(`/v1/tasks/${otherTask}/design-feedback`, {method:'POST',
        headers:{...headers,'Idempotency-Key':key,'x-user-role':'designer'},body:JSON.stringify(payload)});
      expect(replay.status).toBe(200);
      expect(rules[0].frequency).toBe(1);
    });

    it('does not mine feedback whose database commit fails', async () => {
      const key = randomUUID();
      await sql.raw(`CREATE FUNCTION hawa.test_feedback_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected feedback commit failure'; END $$`).execute(db);
      await sql.raw(`CREATE CONSTRAINT TRIGGER test_feedback_commit_failure AFTER INSERT ON hawa.design_feedback
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hawa.test_feedback_commit_failure()`).execute(db);
      try {
        const response = await app.request(`/v1/tasks/${taskId}/design-feedback`, {method:'POST',
          headers:{...headers,'Idempotency-Key':key},body:JSON.stringify({runId,candidateId,verdict:'revise',notes:'Spacing adjustment after review'})});
        expect(response.status).toBe(500);
        expect((await sql`SELECT id FROM hawa.design_feedback WHERE id=${key}::uuid`.execute(db)).rows).toHaveLength(0);
        expect(globalFeedbackMiner.getCandidateRules(clientId).some(rule=>rule.provenance.feedbackId===key)).toBe(false);
      } finally {
        await sql.raw('DROP FUNCTION hawa.test_feedback_commit_failure() CASCADE').execute(db);
      }
    });

    it('replays feedback once and refuses action reuse or a changed reviewed preview', async () => {
      const key=randomUUID();
      const payload={runId,candidateId,previewSha256:fakeSha,verdict:'revise',rating:8,notes:'Check spacing'};
      const post=(body:unknown, action=key)=>app.request(`/v1/tasks/${taskId}/design-feedback`,{
        method:'POST',headers:{...headers,'Idempotency-Key':action},body:JSON.stringify(body)});
      expect((await post(payload)).status).toBe(201);
      const replay=await post(payload);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({id:key,replayed:true});
      expect((await post({...payload,rating:10})).status).toBe(409);
      expect((await post({...payload,previewSha256:'b'.repeat(64)},randomUUID())).status).toBe(409);
      const rows=(await sql<{preview_sha256:string}>`SELECT * FROM hawa.design_feedback WHERE id=${key}::uuid`.execute(db)).rows;
      expect(rows).toHaveLength(1);expect(rows[0].preview_sha256).toBe(fakeSha);
    });

    it('GET /v1/tasks/:taskId/design-feedback returns list of recorded feedback (200)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
        method: 'GET',
        headers,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.feedback).toBeInstanceOf(Array);
      expect(data.count).toBeGreaterThanOrEqual(1);
      expect(data.feedback[0].taskId).toBe(taskId);
      expect(data.feedback.some((row:any)=>row.verdict==='approve')).toBe(true);
    });

    it('Candidate image streaming returns 404 if bytes not yet rendered', async () => {
      const nonExistentCandId = randomUUID();
      const res = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${nonExistentCandId}/preview.png`,
        { headers }
      );
      expect(res.status).toBe(404);
    });

    it('Candidate image streaming returns 200 with PNG bytes and sha256 header when rendered', async () => {
      const res = await app.request(
        `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview.png`,
        { headers }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('X-Content-SHA256')).toBe(fakeSha);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.equals(fakePng)).toBe(true);
    });

    it('POST /v1/tasks/:taskId/canva/parity-check executes P8 comparison (200)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/parity-check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.taskId).toBe(taskId);
      expect(data.runId).toBe(runId);
      expect(data.parity).toBe('match');
      expect(data.verdict.copyVisibleIdentical).toBe(true);
    });

    it('POST /v1/tasks/:taskId/canva/studio/:runId/parity executes P8 comparison (200)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}/parity`, {
        method: 'POST',
        headers,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.parity).toBe('match');
    });
  });
});
