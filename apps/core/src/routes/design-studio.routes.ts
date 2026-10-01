import { createHash, randomUUID } from 'node:crypto';
import type { RouteContext } from './types.js';
import {
  DesignStudioService,
  type DesignStudioServiceOptions,
} from '../services/design-studio/index.js';
import { CanvaConnectService, CanvaFlowError } from '../services/canva-connect-service.js';
import { DesignStudioRepository, sql, withRlsContext, type CandidateImageKind } from '@hawa/db';
import { isSha256Hex } from '@hawa/contracts';
import { isRenderedStudioCandidate, parseStudioImagery, parseStudioTier, StudioBudgetEvidenceError, StudioBudgetExhaustedError } from '@hawa/domain';
import { globalFeedbackMiner, type DesignFeedbackRecord } from '@hawa/creative';
import { blobStoreFor, storedFileLost } from '../services/blob-store-context.js';
import { blobResponse, IMMUTABLE_CACHE_CONTROL } from '../services/blob-response.js';
import { rejectUnownedLifecycleDesignWrite } from './lifecycle-design-proof.js';

/**
 * A candidate picture's address. With its hash in the path it is immutable (a revision renders a new
 * picture with a new hash), so the browser and nginx may keep it for a year; without one (a row from
 * before the hashes were kept) it is the old path, served no-store.
 */
export function candidateImageUrl(taskId: string, runId: string, candidateId: string, kind: CandidateImageKind, sha256: string | null | undefined): string {
  const base = `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}`;
  return isSha256Hex(sha256) ? `${base}/${kind}/${sha256}.png` : `${base}/${kind}.png`;
}

export function registerDesignStudioRoutes(
  ctx: RouteContext,
  options?: DesignStudioServiceOptions,
  serviceOverride?: DesignStudioService
) {
  // The file store candidate pictures are written to and served from (ADR-035).
  const blobStore = blobStoreFor(ctx.db, options?.blobStore ?? ctx.options?.blobStore);
  const canvaService = ctx.db ? new CanvaConnectService(ctx.db, { blobStore }) : undefined;
  const service =
    serviceOverride ||
    (ctx.db ? new DesignStudioService(ctx.db, canvaService, { ...options, blobStore }) : null);
  const repo = ctx.db ? new DesignStudioRepository(ctx.db, blobStore) : null;

  const protect = (
    fn: (
      c: any,
      s: { tenantId: string; actorId: string; role?: string },
      svc: DesignStudioService,
      r: DesignStudioRepository
    ) => Promise<Response>
  ) => async (c: any) => {
    c.header('Cache-Control', 'no-store');
    const auth = ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) {
      return ctx.problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
    }
    const role = (auth.role || '').toLowerCase().trim();
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

    const lifecycleRefusal = await rejectUnownedLifecycleDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;

    try {
      // The actor is the user's id, a uuid: studio runs, calls and Canva connections are keyed by it.
      // auth.actorId is a label ('operator_1' for API-key callers such as the worker); passing it
      // failed every studio start with "invalid input syntax for type uuid" (81f4390, 2026-09-19).
      return await fn(c, { tenantId: auth.tenantId, actorId: String(auth.userId || auth.actorId || ""), role: auth.role }, service, repo);
    } catch (error: any) {
      if (error instanceof CanvaFlowError) {
        // A busy refusal (Canva's rate limit on a transfer) names the wait the worker keeps.
        if (error.retryAfterMs !== undefined) c.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        return ctx.problem(c, error.status, error.code, error.message);
      }
      if (error instanceof StudioBudgetEvidenceError || error instanceof StudioBudgetExhaustedError) {
        return ctx.problem(c, 409, error.code, error.message);
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
  ctx.registerRoute('get', '/tasks/:taskId/canva/studio', protect(async (c, s, _svc, repo) => {
    const taskId = c.req.param('taskId');
    return withRlsContext(ctx.db!, { tenantId: s.tenantId, userId: s.actorId, role: s.role }, async db => {
      const task = await db.selectFrom('tasks').select('id').where('id', '=', taskId)
        .where('tenant_id', '=', s.tenantId).executeTakeFirst();
      if (!task) return ctx.problem(c, 404, 'Task Not Found');
      const run = await repo.getLatestRunForTask(taskId, s.tenantId, db);
      return c.json({ runId: run?.id ?? null, status: run?.status ?? null });
    });
  }));
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
      // One vocabulary with intake (ADR-159): an unknown tier or imagery is refused, not stored.
      const tier = parseStudioTier(body.tier), imagery = parseStudioImagery(body.imagery);
      if (tier === null || imagery === null) {
        return ctx.problem(c, 422, 'STUDIO_OPTIONS_INVALID', 'tier is standard or premium; imagery is auto, none or generated');
      }

      const result = await svc.createOrGetRun(s, taskId, key, {
        width,
        height,
        tier,
        imagery,
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

      // Evidence without bytes: the rows as stored, not their pictures read from the file store.
      const candidateRows = await r.getCandidatesForRun(runId, s.tenantId, undefined, { images: false });
      const judgments = await r.getJudgmentsForRun(runId, s.tenantId);
      const calls = await r.getCallsForRun(runId, s.tenantId);
      const budgetUsage = await r.getBudgetUsage(runId, s.tenantId, s.actorId);

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
        previewUrl: candidateImageUrl(taskId, runId, row.id, 'preview', row.preview_sha256),
        artUrl: row.art_sha256 ? candidateImageUrl(taskId, runId, row.id, 'art', row.art_sha256) : null,
        compositeUrl: row.composite_sha256 || row.composite_png
          ? candidateImageUrl(taskId, runId, row.id, 'composite', row.composite_sha256)
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
          budgetUsage,
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
        // An unresolved provider acceptance may have been billed. Never show its stored zero
        // placeholder as a complete estimate for the run.
        uncertainCallsCount: calls.filter((call) => call.status === 'uncertain').length,
        totalUsdEstimate: calls.some((call) => call.status === 'uncertain')
          ? null : calls.reduce((acc, call) => acc + Number(call.usd_estimate ?? 0), 0),
        knownUsdEstimate: calls.filter((call) => call.status !== 'uncertain')
          .reduce((acc, call) => acc + Number(call.usd_estimate ?? 0), 0),
        // `model` is the requested deployment; `servedModel` is provider-reported when known.
        calls: calls.map((call) => ({
          id: call.id,
          callOrdinal: call.call_ordinal,
          logicalCallSha256: call.logical_call_sha256,
          stage: call.stage,
          provider: call.provider,
          model: call.model,
          servedModel: call.served_model,
          responseId: call.response_id,
          providerRequestId: call.provider_request_id,
          responseSha256: call.response_sha256,
          latencyMs: call.latency_ms,
          attempts: call.attempts,
          status: call.status,
          errorCode: call.error_code,
          startedAt: call.started_at,
          finishedAt: call.finished_at,
          usdEstimate: call.status === 'uncertain' ? null : Number(call.usd_estimate ?? 0),
        })),
      });
    })
  );

  // 4. Candidate pictures (preview, art, composite). Authorised on the candidate row, read under
  //    row-level security (ADR-035 section 2.4): one row, not every candidate of the run with its bytes.
  //    `/:kind/<sha256>.png` is the immutable address; the old `/<kind>.png` stays one release, no-store.
  const imageHandler = (kind: CandidateImageKind, pinned: boolean) =>
    protect(async (c, s, _svc, r) => {
      const taskId = c.req.param('taskId');
      const runId = c.req.param('runId');
      const candidateId = c.req.param('candidateId');
      let wanted: string | undefined;
      if (pinned) {
        const file = /^([0-9a-f]{64})\.png$/.exec(c.req.param('file') || '');
        if (!file) return ctx.problem(c, 404, 'Image Not Available', 'No such picture');
        wanted = file[1];
      }

      let source = await r.getCandidateImageSource(candidateId, s.tenantId, kind);
      if (!source || source.runId !== runId || source.taskId !== taskId) {
        return ctx.problem(c, 404, 'Candidate Not Found', 'Candidate not found');
      }
      // A stale address (the picture was rendered again since) names nothing any more.
      if (wanted && source.sha256 !== wanted) {
        return ctx.problem(c, 404, 'Image Not Available', `This ${kind} picture has been replaced`);
      }
      const cacheControl = pinned ? IMMUTABLE_CACHE_CONTROL : 'no-store';
      // protect() set no-store on the context, and Hono copies the context's headers onto a returned
      // Response: the picture's own caching is set there too, or it would be overwritten.
      c.header('Cache-Control', cacheControl);
      if (source.ref && blobStore && source.ref.mediaType.startsWith('image/')) {
        try {
          return await blobResponse(c, blobStore, source.ref, { cacheControl });
        } catch (err) {
          if (!storedFileLost(err, `candidate ${candidateId} ${kind}`)) throw err;
          source = (await r.getCandidateImageSource(candidateId, s.tenantId, kind, undefined, { withBytes: true })) ?? source;
        }
      }
      // A row from before the store, or whose file is lost: its bytes, served as the old route served
      // them. At the pinned address only when they are the bytes the hash names.
      const buffer = source.bytes;
      if (!buffer || (wanted && createHash('sha256').update(buffer).digest('hex') !== wanted)) {
        return ctx.problem(c, 404, 'Image Not Available', `No ${kind} image currently rendered for this candidate`);
      }
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
          ...(source.sha256 && kind !== 'composite' ? { 'X-Content-SHA256': source.sha256 } : {}),
          ...(wanted ? { 'X-Content-SHA256': wanted } : {}),
        },
      });
    });

  for (const kind of ['preview', 'art', 'composite'] as const) {
    ctx.registerRoute('get', `/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/${kind}.png`, imageHandler(kind, false));
    ctx.registerRoute('get', `/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/${kind}/:file`, imageHandler(kind, true));
  }

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
      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
        return ctx.problem(c, 422, 'Invalid Rating', 'Rating must be an integer between 1 and 10');
      }

      if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 4000)) {
        return ctx.problem(c,422,'Invalid Notes','Feedback notes must be text, up to 4000 characters.');
      }
      const actionId = c.req.header('Idempotency-Key') || randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId)) {
        return ctx.problem(c, 422, 'Invalid Action', 'Use a UUID feedback action.');
      }
      if (body.previewSha256 !== undefined && !isSha256Hex(body.previewSha256)) {
        return ctx.problem(c, 422, 'Invalid Preview', 'Use the saved preview hash.');
      }
      // Bind the reviewed picture to this authorized task before admitting learning evidence.
      // RLS and the transaction prevent a cross-client id or concurrent candidate update slipping in.
      if (!body.runId || !body.candidateId || ![body.runId, body.candidateId].every(id =>
        typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
        return ctx.problem(c, 422, 'Review Candidate Required', 'Choose a rendered candidate from this task before submitting feedback.');
      }

      const result = await withRlsContext(ctx.db!, { tenantId: s.tenantId, userId: s.actorId, role: s.role }, async trx => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId},0))`.execute(trx);
        const existing = await trx.selectFrom('design_feedback').selectAll()
          .where('id','=',actionId).where('tenant_id','=',s.tenantId).executeTakeFirst();
        if (existing) {
          if (existing.task_id !== taskId || existing.run_id !== body.runId || existing.candidate_id !== body.candidateId ||
            existing.actor_id !== s.actorId || existing.source !== (body.source || 'desk') || existing.verdict !== body.verdict || Number(existing.rating) !== Number(rating) ||
            (existing.notes || '') !== (body.notes || '') || (existing.preview_sha256 || '') !== (body.previewSha256 || '')) {
            return ctx.problem(c,409,'Feedback Action Conflict','This action already records different feedback.');
          }
          return c.json({id:existing.id,status:'recorded',verdict:existing.verdict,rating:existing.rating,replayed:true},200);
        }
        const candidate = await trx.selectFrom('design_studio_candidates as candidate')
          .innerJoin('design_studio_runs as run', 'run.id', 'candidate.run_id')
          .innerJoin('tasks as task', 'task.id', 'run.task_id')
          .select(['candidate.preview_sha256', 'candidate.preview_png', 'task.client_id', 'run.client_id as run_client_id'])
          .where('candidate.tenant_id', '=', s.tenantId).where('run.tenant_id', '=', s.tenantId)
          .where('task.tenant_id', '=', s.tenantId).where('task.id', '=', taskId)
          .where('run.id', '=', body.runId).where('candidate.id', '=', body.candidateId)
          .forShare(['candidate', 'task', 'run']).executeTakeFirst();
        if (!isRenderedStudioCandidate(candidate && { previewSha256: candidate.preview_sha256,
          hasPreviewBytes: Boolean(candidate.preview_png?.length) })) {
          return ctx.problem(c, 409, 'Candidate Not Ready', 'No rendered candidate is available to review. Wait for a preview or recover the failed design first.');
        }

        if (body.previewSha256 && body.previewSha256 !== candidate?.preview_sha256) {
          return ctx.problem(c,409,'Preview Changed','The candidate preview changed. Inspect the current preview before submitting new feedback.');
        }
        if (!candidate?.client_id || candidate.run_client_id !== candidate.client_id) {
          return ctx.problem(c,409,'Feedback Scope Conflict','The reviewed candidate must belong to the task client.');
        }
      const feedbackId = actionId;
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
        previewSha256: body.previewSha256 || null,
      }, trx);

      const feedback: DesignFeedbackRecord = {
        id: feedbackRow.id,
        tenantId: feedbackRow.tenant_id,
        clientId: candidate.client_id,
        taskId: feedbackRow.task_id,
        runId: feedbackRow.run_id,
        candidateId: feedbackRow.candidate_id,
        actorId: feedbackRow.actor_id,
        actorRole: s.role,
        source: feedbackRow.source as any,
        verdict: feedbackRow.verdict as any,
        rating: feedbackRow.rating !== null ? Number(feedbackRow.rating) : null,
        notes: feedbackRow.notes,
        createdAt: feedbackRow.created_at ? new Date(feedbackRow.created_at).toISOString() : undefined,
      };
      return { feedback };
      });

      if (result instanceof Response) return result;
      // Only committed rows may enter the process-local learning projection.
      const proposedRules = globalFeedbackMiner.ingestDesignFeedback(result.feedback);
      const feedback = result.feedback;

      return c.json(
        {
          id: feedback.id,
          status: 'recorded',
          verdict: feedback.verdict,
          rating: feedback.rating,
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
