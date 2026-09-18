import { randomUUID } from 'node:crypto';
import type { RouteContext } from './types.js';
import {
  DesignStudioService,
  type DesignStudioServiceOptions,
} from '../services/design-studio/index.js';
import { CanvaConnectService, CanvaFlowError } from '../services/canva-connect-service.js';
import { DesignStudioRepository } from '@hawa/db';
import { globalFeedbackMiner } from '@hawa/creative';

export function registerDesignStudioRoutes(
  ctx: RouteContext,
  options?: DesignStudioServiceOptions,
  serviceOverride?: DesignStudioService
) {
  const canvaService = ctx.db ? new CanvaConnectService(ctx.db) : undefined;
  const service =
    serviceOverride ||
    (ctx.db ? new DesignStudioService(ctx.db, canvaService, options) : null);
  const repo = ctx.db ? new DesignStudioRepository(ctx.db) : null;

  const protect = (
    fn: (
      c: any,
      s: { tenantId: string; actorId: string },
      svc: DesignStudioService,
      r: DesignStudioRepository
    ) => Promise<Response>
  ) => async (c: any) => {
    c.header('Cache-Control', 'no-store');
    const auth = ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) {
      return ctx.problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
    }
    const role = (
      (process.env.NODE_ENV === 'test' && c.req.header('x-user-role')) ||
      auth.role ||
      ''
    ).toLowerCase().trim();
    if (
      !['administrator', 'art_director', 'creative_director', 'operator', 'designer'].includes(
        role
      )
    ) {
      return ctx.problem(
        c,
        403,
        'Design Studio Access Forbidden',
        'This role cannot operate Design Studio v2'
      );
    }
    if (!service || !repo) {
      return ctx.problem(c, 503, 'Database Required', 'Design Studio requires durable storage');
    }

    for (const name of ['taskId', 'runId', 'candidateId']) {
      const value = c.req.param(name);
      if (
        value &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ) {
        return ctx.problem(c, 422, 'Invalid Identifier', `Use a valid ${name} identifier`);
      }
    }

    try {
      return await fn(c, { tenantId: auth.tenantId, actorId: auth.userId }, service, repo);
    } catch (error: any) {
      if (error instanceof CanvaFlowError) {
        return ctx.problem(c, error.status, error.code, error.message);
      }
      return ctx.problem(
        c,
        500,
        'Studio Operation Failed',
        error.message || 'Design Studio encountered an unexpected failure'
      );
    }
  };

  // 1. POST /tasks/:taskId/canva/studio — start studio run
  ctx.registerRoute(
    'post',
    '/tasks/:taskId/canva/studio',
    protect(async (c, s, svc) => {
      const key = c.req.header('Idempotency-Key');
      if (!key) {
        return ctx.problem(c, 400, 'Idempotency-Key Required', 'Pass an Idempotency-Key header');
      }

      const body = await c.req.json().catch(() => ({}));
      const taskId = c.req.param('taskId');

      const width = Number(body.width || 1080);
      const height = Number(body.height || 1350);

      const result = await svc.createOrGetRun(s, taskId, key, {
        width,
        height,
        tier: body.tier,
        imagery: body.imagery,
        previews: body.previews,
        holdForSelection: body.holdForSelection,
      });

      return c.json(
        {
          runId: result.run.id,
          status: result.run.status,
          created: result.created,
        },
        202
      );
    })
  );

  // 2. POST /tasks/:taskId/canva/studio/:runId/resume — advance one stage
  ctx.registerRoute(
    'post',
    '/tasks/:taskId/canva/studio/:runId/resume',
    protect(async (c, s, svc) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');
      const result = await svc.resume(s, taskId, runId);
      return c.json(result);
    })
  );

  // 3. GET /tasks/:taskId/canva/studio/:runId — full evidence without bytes
  ctx.registerRoute(
    'get',
    '/tasks/:taskId/canva/studio/:runId',
    protect(async (c, s, _svc, r) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');

      const run = await r.getRunById(runId, s.tenantId);
      if (!run || run.task_id !== taskId) {
        return ctx.problem(c, 404, 'Run Not Found', 'Studio run not found for this task');
      }

      const candidateRows = await r.getCandidatesForRun(runId, s.tenantId);
      const judgments = await r.getJudgmentsForRun(runId, s.tenantId);
      const calls = await r.getCallsForRun(runId, s.tenantId);

      const candidates = candidateRows.map((row) => ({
        id: row.id,
        ordinal: row.ordinal,
        concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
        layouts: (row.layouts as any[] || []).map((l) => (typeof l === 'string' ? JSON.parse(l) : l)),
        status: row.status,
        rank: row.rank,
        score: row.score ? parseFloat(row.score.toString()) : null,
        metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
        critiques: (row.critiques as any[] || []).map((cr) => (typeof cr === 'string' ? JSON.parse(cr) : cr)),
        artSha256: row.art_sha256,
        previewSha256: row.preview_sha256,
        previewUrl: `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${row.id}/preview.png`,
        artUrl: row.art_sha256
          ? `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${row.id}/art.png`
          : null,
        compositeUrl: row.composite_png
          ? `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${row.id}/composite.png`
          : null,
      }));

      return c.json({
        run: {
          id: run.id,
          taskId: run.task_id,
          clientId: run.client_id,
          tier: run.tier,
          status: run.status,
          planId: run.plan_id,
          winnerCandidateId: run.winner_candidate_id,
          judgeStatus: run.judge_status,
          budget: typeof run.budget === 'string' ? JSON.parse(run.budget) : run.budget,
          stages: typeof run.stages === 'string' ? JSON.parse(run.stages || '{}') : run.stages,
          diagnostic: run.diagnostic,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
        },
        candidates,
        judgments: judgments.map((j) => ({
          id: j.id,
          kind: j.kind,
          candidateA: j.candidate_a,
          candidateB: j.candidate_b,
          orderSwapped: j.order_swapped,
          verdict: typeof j.verdict === 'string' ? JSON.parse(j.verdict) : j.verdict,
          createdAt: j.created_at,
        })),
        callsCount: calls.length,
        totalUsdEstimate: calls.reduce((acc, call) => acc + Number(call.usd_estimate ?? 0), 0),
        // Which model answered each call, as the provider reported it (the ledger's `model`).
        calls: calls.map((call) => ({
          stage: call.stage,
          model: call.model,
          status: call.status,
          usdEstimate: Number(call.usd_estimate ?? 0),
        })),
      });
    })
  );

  // 4. Candidate image streams (preview.png, art.png, composite.png)
  const imageHandler = (kind: 'preview' | 'art' | 'composite') =>
    protect(async (c, s, _svc, r) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');
      const candidateId = c.req.param('candidateId');

      const run = await r.getRunById(runId, s.tenantId);
      if (!run || run.task_id !== taskId) {
        return ctx.problem(c, 404, 'Run Not Found', 'Studio run not found');
      }

      const candidateRows = await r.getCandidatesForRun(runId, s.tenantId);
      const cand = candidateRows.find((row) => row.id === candidateId);
      if (!cand) {
        return ctx.problem(c, 404, 'Candidate Not Found', 'Candidate not found');
      }

      let buffer: Buffer | null = null;
      let sha256: string | null = null;

      if (kind === 'preview') {
        buffer = cand.preview_png ? Buffer.from(cand.preview_png) : null;
        sha256 = cand.preview_sha256;
      } else if (kind === 'art') {
        buffer = cand.art_png ? Buffer.from(cand.art_png) : null;
        sha256 = cand.art_sha256;
      } else if (kind === 'composite') {
        buffer = cand.composite_png ? Buffer.from(cand.composite_png) : null;
        sha256 = cand.preview_sha256;
      }

      if (!buffer) {
        return ctx.problem(
          c,
          404,
          'Image Not Available',
          `No ${kind} image currently rendered for this candidate`
        );
      }

      c.header('Content-Type', 'image/png');
      c.header('Cache-Control', 'no-store');
      if (sha256) {
        c.header('X-Content-SHA256', sha256);
      }
      return c.body(new Uint8Array(buffer));
    });

  ctx.registerRoute(
    'get',
    '/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/preview.png',
    imageHandler('preview')
  );
  ctx.registerRoute(
    'get',
    '/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/art.png',
    imageHandler('art')
  );
  ctx.registerRoute(
    'get',
    '/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/composite.png',
    imageHandler('composite')
  );

  // 5. POST /tasks/:taskId/canva/studio/:runId/select — select candidate in awaiting_selection
  ctx.registerRoute(
    'post',
    '/tasks/:taskId/canva/studio/:runId/select',
    protect(async (c, s, svc) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');
      const body = await c.req.json().catch(() => ({}));

      if (
        !body.candidateId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.candidateId)
      ) {
        return ctx.problem(c, 422, 'Invalid Candidate', 'Provide a valid candidateId UUID');
      }

      const result = await svc.selectCandidate(s, taskId, runId, body.candidateId);
      return c.json(result);
    })
  );

  // 6. POST /tasks/:taskId/canva/studio/:runId/abandon — abandon run
  ctx.registerRoute(
    'post',
    '/tasks/:taskId/canva/studio/:runId/abandon',
    protect(async (c, s, svc) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');
      const body = await c.req.json().catch(() => ({}));

      const result = await svc.abandon(s, taskId, runId, body?.reason);
      return c.json(result);
    })
  );

  // 7. POST /tasks/:taskId/design-feedback — submit human feedback
  ctx.registerRoute(
    'post',
    '/tasks/:taskId/design-feedback',
    protect(async (c, s, _svc, r) => {
      const taskId = c.req.param('taskId');
      const body = await c.req.json().catch(() => ({}));

      const validVerdicts = ['approve', 'reject', 'revise', 'rating'];
      if (!body.verdict || !validVerdicts.includes(body.verdict)) {
        return ctx.problem(
          c,
          422,
          'Invalid Verdict',
          `Verdict must be one of: ${validVerdicts.join(', ')}`
        );
      }

      let rating = body.rating !== undefined ? Number(body.rating) : null;
      if (rating !== null && (isNaN(rating) || rating < 1 || rating > 10)) {
        return ctx.problem(c, 422, 'Invalid Rating', 'Rating must be an integer between 1 and 10');
      }

      const feedbackId = randomUUID();
      const feedbackRow = await r.recordFeedback({
        id: feedbackId,
        tenantId: s.tenantId,
        taskId,
        runId: body.runId || null,
        candidateId: body.candidateId || null,
        actorId: s.actorId,
        source: body.source || 'desk',
        verdict: body.verdict,
        rating,
        notes: body.notes || null,
      });

      // Feed verdict into globalFeedbackMiner (governed learning loop)
      const proposedRules = globalFeedbackMiner.ingestDesignFeedback({
        id: feedbackRow.id,
        tenantId: feedbackRow.tenant_id,
        taskId: feedbackRow.task_id,
        runId: feedbackRow.run_id,
        candidateId: feedbackRow.candidate_id,
        actorId: feedbackRow.actor_id,
        source: feedbackRow.source as any,
        verdict: feedbackRow.verdict as any,
        rating: feedbackRow.rating !== null ? Number(feedbackRow.rating) : null,
        notes: feedbackRow.notes,
        createdAt: feedbackRow.created_at ? new Date(feedbackRow.created_at).toISOString() : undefined,
      });

      return c.json(
        {
          id: feedbackRow.id,
          status: 'recorded',
          verdict: feedbackRow.verdict,
          rating: feedbackRow.rating !== null ? Number(feedbackRow.rating) : null,
          rulesProposed: proposedRules.length,
        },
        201
      );
    })
  );

  // 7b. GET /tasks/:taskId/design-feedback — list recorded human feedback for a task
  ctx.registerRoute(
    'get',
    '/tasks/:taskId/design-feedback',
    protect(async (c, s, _svc, r) => {
      const taskId = c.req.param('taskId');
      const rows = await r.listFeedbackForTask(taskId, s.tenantId);
      return c.json({
        feedback: rows.map((row) => ({
          id: row.id,
          taskId: row.task_id,
          runId: row.run_id,
          candidateId: row.candidate_id,
          actorId: row.actor_id,
          source: row.source,
          verdict: row.verdict,
          rating: row.rating ? parseFloat(row.rating.toString()) : null,
          notes: row.notes,
          createdAt: row.created_at,
        })),
        count: rows.length,
      });
    })
  );

  // 8. Canva Parity Check (P8)
  const handleParityCheck = async (
    c: any,
    s: { tenantId: string; actorId: string },
    svc: DesignStudioService,
    r: DesignStudioRepository
  ) => {
    const taskId = c.req.param('taskId');
    let runId = c.req.param('runId');
    if (!runId) {
      const body = await c.req.json().catch(() => ({}));
      runId = body?.runId;
    }
    if (!runId) {
      const latest = await r.getLatestRunForTask(taskId, s.tenantId);
      if (!latest) {
        return ctx.problem(c, 404, 'Run Not Found', 'No studio run found for this task');
      }
      runId = latest.id;
    }

    try {
      const verdict = await svc.runParityCheck(s, runId);
      return c.json({
        ok: true,
        taskId,
        runId,
        parity: verdict.parity,
        verdict,
      });
    } catch (err: any) {
      if (err instanceof CanvaFlowError) {
        return ctx.problem(c, err.status, err.code, err.message);
      }
      throw err;
    }
  };

  ctx.registerRoute('post', '/tasks/:taskId/canva/parity-check', protect(handleParityCheck));
  ctx.registerRoute('post', '/tasks/:taskId/canva/studio/:runId/parity', protect(handleParityCheck));
}

