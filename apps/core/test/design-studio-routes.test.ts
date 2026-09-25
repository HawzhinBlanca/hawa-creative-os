import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { CanvaFlowError } from '../src/services/canva-connect-service.js';
import type { DesignStudioService } from '../src/services/design-studio/index.js';

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
      expect(data.candidates).toBeInstanceOf(Array);
      expect(data.candidates.length).toBe(1);

      // Verify URLs are provided without embedding raw image bytes
      const firstCandidate = data.candidates[0];
      // The address names the picture's hash, so it is immutable (ADR-035).
      expect(firstCandidate.previewUrl).toContain(`/candidates/${firstCandidate.id}/preview/${fakeSha}.png`);
      expect(data.totalUsdEstimate).toBeGreaterThanOrEqual(0);
    });

    it('reports unknown model spend without presenting it as zero dollars', async () => {
      await sql`INSERT INTO hawa.design_studio_calls
        (id, run_id, tenant_id, stage, provider, model, requested_model, status, error_code)
        VALUES (${randomUUID()}::uuid, ${runId}::uuid, ${tenantId}::uuid,
          'laying_out', 'openai', 'gpt-6-astra', 'gpt-6-astra', 'uncertain', 'UNCERTAIN_ACCEPTANCE')`.execute(db);
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

    it('POST /v1/tasks/:taskId/design-feedback records human feedback (201)', async () => {
      const res = await app.request(`/v1/tasks/${taskId}/design-feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runId,
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
      expect(data.feedback[0].verdict).toBe('approve');
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
