import type { RouteContext } from './types.js';
import { log } from '../logging.js';
import crypto from 'node:crypto';
import { type StudioOperation } from '@hawa/contracts';
import { TaskStateMachine, extractProtectedTokens, type DesignBrief } from '@hawa/domain';
import { withRlsContext, toApiTaskStatus, sql } from '@hawa/db';
import { KAAE_CLIENT_ID } from '@hawa/integrations';
import { manifestFromOperations } from '../services/generated-manifest.js';
import { inlineTemplateCopyMissing, COPY_REQUIRED_DETAIL } from '../core-helpers.js';
import { DEFAULT_CLIENT_ID } from '../core-context.js';
import { readTaskBrief } from '../services/brief-reader.js';
import { rejectLegacyTaskDesignWrite } from './lifecycle-design-proof.js';

/**
 * Routing a task to a client, its brief and generating its design (architecture programme 1.3, G7).
 * Moved from createApp unchanged.
 */
export function registerTaskPipelineRoutes(ctx: RouteContext): void {
  const {
    briefs,
    broadcastTransition,
    creativeDirector,
    db,
    events,
    problem,
    qaEngine,
    readCurrentTask,
    registerRoute,
    resolveClientDna,
    revisionRepo,
    taskRepo,
    tasks,
    verifyRequestAuth,
    broadcastEvent: broadcast,
  } = ctx;
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Route Task (Lock Client Scope)
  registerRoute('post', '/tasks/:taskId/route', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to route task');
    }
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    const taskId = c.req.param('taskId');
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    let task = await readCurrentTask(taskId);
    let dbTask: any = null;
    if (taskRepo && db) {
      try {
        dbTask = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          return await taskRepo.findById(taskId, tenantId, trx);
        });
      } catch (err) {
        log.error('[core:route:lookup] DB task error:', err);
      }
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json().catch(() => ({}));
    if (!body.clientId) return problem(c, 400, 'Bad Request', 'clientId is required');

    let resolvedClientId = body.clientId;
    const clientMap: Record<string, string> = {
      'kaae': 'c1000000-0000-4000-8000-000000000002',
      'drustee': 'c1000000-0000-4000-8000-000000000003',
      'fastpay': 'c1000000-0000-4000-8000-000000000004',
      'hawa': 'c1000000-0000-4000-8000-000000000001',
    };
    if (clientMap[resolvedClientId]) resolvedClientId = clientMap[resolvedClientId];

    const currentStatus = task ? task.status : toApiTaskStatus(dbTask.state);
    const sm = new TaskStateMachine(taskId, currentStatus);
    if (currentStatus === 'RECEIVED') {
      const r = sm.transition('ROUTING', { type: 'system', id: 'router' }, 'Initiate routing');
      if (r.ok && events.has(taskId)) events.get(taskId)?.push(r.value);
    }
    const trans = sm.transition('BRIEFING', { type: 'user', id: auth.actorId || 'operator' }, body.reason || `Client locked to ${body.clientId}`);
    if (!trans.ok) return problem(c, 409, 'Conflict', trans.error.message);

    if (task) {
      task.clientId = body.clientId;
      task.clientScopeLocked = true;
      task.status = 'BRIEFING';
      task.updatedAt = new Date().toISOString();
      if (!events.has(taskId)) events.set(taskId, []);
      events.get(taskId)?.push(trans.value);
    }

    // Update database record if database is connected
    let routedVersion: number | null = null;
    if (db && taskRepo) {
      try {
        await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (uuidRegex.test(resolvedClientId)) {
            await trx.updateTable('tasks')
              .set({ client_id: resolvedClientId, updated_at: new Date() })
              .where('id', '=', taskId)
              .where('tenant_id', '=', tenantId)
              .execute();
          }

          routedVersion = Number((await taskRepo.transitionState({
            taskId,
            tenantId,
            toState: 'brief_draft',
            actorType: 'user',
            actorId: auth.actorId || auth.userId || 'operator',
            reason: body.reason || `Client locked to ${body.clientId}`,
            data: { clientId: resolvedClientId },
          }, trx))?.version) || null;
        });
      } catch (err) {
        log.error('[core:route] DB update error:', err);
      }
    }

    broadcastTransition(taskId, currentStatus, 'BRIEFING', routedVersion);

    return c.json({
      commandId: crypto.randomUUID(),
      taskId,
      workflowId: `wf_${taskId}`,
      acceptedAt: new Date().toISOString(),
    }, 202);
  });

  // Create or Approve Brief
  registerRoute('post', '/tasks/:taskId/briefs', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    let task = await readCurrentTask(taskId);
    let dbTask: any = null;
    if (taskRepo && db) {
      try {
        dbTask = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          return await taskRepo.findById(taskId, tenantId, trx);
        });
      } catch (err) {
        log.error('[core:briefs:lookup] DB task error:', err);
      }
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json();
    const tokens = extractProtectedTokens(body.rawRequestText || '');
    const briefId = crypto.randomUUID();

    const currentClientId = task?.clientId || dbTask?.client_id || defaultClientId;
    const brief: DesignBrief = {
      briefId,
      taskId,
      clientId: currentClientId,
      clientDnaVersion: 1,
      objective: body.objective || 'Design Campaign',
      taskRoute: 'creative_director',
      primaryLanguage: body.primaryLanguage || 'ckb',
      direction: body.direction || 'rtl',
      variants: body.variants || [
        { id: 'v1', name: 'Instagram Story', width: 1080, height: 1920, aspectRatio: '9:16', role: 'instagram_story' },
      ],
      exactCopy: (body.copyBlocks && body.copyBlocks.length > 0 ? body.copyBlocks : [{ role: 'headline', text: body.rawRequestText || '' }]).map((cb: any, i: number) => ({
        id: `copy_${i}`,
        role: cb.role || 'headline',
        text: cb.text || '',
        language: 'ckb',
        direction: 'rtl',
        approved: true,
        protectedTokens: tokens,
      })),
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    // Postgres keeps the brief (design_briefs, below); without a database, the no-database store does.
    if (!db) briefs.set(taskId, brief);

    const briefFromStatus = task ? task.status : toApiTaskStatus(dbTask.state);
    const sm = new TaskStateMachine(taskId, briefFromStatus);
    const trans = sm.transition('PLANNING', { type: 'workflow', id: 'brief_builder' }, 'Brief approved');
    if (task) {
      if (trans.ok) {
        task.status = 'PLANNING';
        if (!events.has(taskId)) events.set(taskId, []);
        events.get(taskId)?.push(trans.value);
      }
    }

    let briefVersion: number | null = null;
    if (db && taskRepo) {
      try {
        await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          briefVersion = Number((await taskRepo.transitionState({
            taskId,
            tenantId,
            toState: 'design_planning',
            actorType: 'workflow',
            actorId: 'brief_builder',
            reason: 'Brief approved',
            data: { briefId: brief.briefId, objective: brief.objective },
          }, trx))?.version) || null;

          const briefJson = JSON.stringify(brief);
          const briefHash = crypto.createHash('sha256').update(briefJson).digest('hex');
          await trx.insertInto('design_briefs' as any).values({
            id: briefId,
            tenant_id: tenantId,
            task_id: taskId,
            version: 1,
            brief: sql`${briefJson}::jsonb`,
            content_hash: briefHash,
            status: 'draft',
            created_by_type: 'workflow',
            created_by_id: 'brief_builder',
          }).onConflict((oc: any) => oc.columns(['task_id', 'version']).doUpdateSet({
            brief: sql`${briefJson}::jsonb`,
            content_hash: briefHash,
          })).execute();
        });
      } catch (err) {
        log.error('[core:briefs:db] DB transition error:', err);
      }
    }

    broadcastTransition(taskId, briefFromStatus, 'PLANNING', briefVersion);

    return c.json(brief, 201);
  });

  // Generate Design
  registerRoute('post', '/tasks/:taskId/generate', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    let task = await readCurrentTask(taskId);
    let dbTask: any = null;
    if (taskRepo && db) {
      try {
        dbTask = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          return await taskRepo.findById(taskId, tenantId, trx);
        });
      } catch (err) {
        log.error('[core:generate:lookup] DB task error:', err);
      }
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    const currentClientId = task?.clientId || dbTask?.client_id || defaultClientId;
    // The brief saved for the task: Postgres's, or without a database the no-database store's.
    const savedBrief = db ? await readTaskBrief(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, taskId) : briefs.get(taskId);
    const brief: DesignBrief = savedBrief || {
      briefId: crypto.randomUUID(),
      taskId,
      clientId: currentClientId,
      clientDnaVersion: 1,
      objective: (task || dbTask)?.title || 'Campaign Poster',
      taskRoute: 'creative_director',
      primaryLanguage: 'ckb',
      direction: 'rtl' as const,
      variants: [
        { id: 'v1', name: 'Poster', width: 1080, height: 1920, aspectRatio: '9:16', role: 'instagram_story' },
      ],
      exactCopy: [
        {
          id: 'copy_1',
          role: 'headline' as const,
          text: (task || dbTask)?.title || 'Offer',
          language: 'ckb',
          direction: 'rtl' as const,
          approved: true,
          protectedTokens: [],
        },
      ],
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    const isKaae = currentClientId === KAAE_CLIENT_ID || currentClientId === 'client-office-1' || currentClientId === 'client-kaae' || String(currentClientId).includes('kaae');
    const isBrandClient = currentClientId === 'client-fastpay' || currentClientId === 'client-aster' || currentClientId === 'client-drustee';
    const template = isKaae ? 'kaae' : isBrandClient ? 'brand' : null;
    if (template && inlineTemplateCopyMissing(template, task || dbTask || {})) {
      return problem(c, 422, 'COPY_REQUIRED', COPY_REQUIRED_DETAIL);
    }

    // KAAE's v1 templates are retired (ADR-127): KAAE's designs are made only in the design studio.
    // The generic legacy draft is not a substitute: it can pass QA, and would reach review and approval
    // as a KAAE design no one designed.
    if (isKaae) {
      return problem(c, 410, 'LEGACY_TEMPLATES_RETIRED', "KAAE's designs are made in the design studio; this legacy generator no longer drafts them.");
    }

    let designDna: Awaited<ReturnType<typeof resolveClientDna>>;
    try {
      designDna=await resolveClientDna(currentClientId,{tenantId,userId:auth.userId,role:auth.role,requireDatabase:true});
    } catch {
      return problem(c,503,'Client DNA Unavailable','The current client rules could not be read; no design was generated.');
    }
    if(db && !designDna) return problem(c,409,'Client DNA Required','Active DNA for this authorized client is required before generating.');
    const effectiveRules=designDna?.guidelines?.layoutRules ?? [];

    let ops: StudioOperation[] = [];
    if (isBrandClient) {
      ops = creativeDirector.generateCommercialBrandOperations(currentClientId.replace('client-', ''), brief, {
        headlineEn: (task || dbTask)?.headlineEn,
        headlineCkb: (task || dbTask)?.headlineCkb,
        copyEn: (task || dbTask)?.copyEn,
        copyCkb: (task || dbTask)?.copyCkb,
        learnedRules: effectiveRules,
      });
    } else {
      const plan = creativeDirector.createDesignPlan(brief, ['#0B0F19', '#38BDF8', '#FFFFFF']);
      ops = creativeDirector.generateStudioOperations(brief, plan, 'sha256_logo_verified_primary');
    }

    const revisionId = crypto.randomUUID();
    const sourceSha256 = crypto.createHash('sha256').update(JSON.stringify(ops)).digest('hex');
    const manifest = manifestFromOperations(
      ops,
      (brief.variants || []).map((v: any) => ({
        id: v.id,
        name: v.name,
        width: v.width,
        height: v.height,
        unit: 'px',
        language: brief.primaryLanguage,
        direction: brief.direction,
      }))
    );
    const nodes: any[] = manifest.nodes;

    const document: any = {
      documentId: `doc_${taskId.slice(0, 8)}`,
      sourceRevision: 1,
      sourceSha256,
      studio: 'Canva Native Studio',
      format: 'canva_native' as any,
      nodes,
    };

    // QA runs the deterministic engine on the design just generated, against the brief and the client's
    // DNA. It used to be a literal all-pass report (score 100, contrast 7.2) stored as a passing QC run.
    const qaRun = await qaEngine.run(
      {
        tenantId,
        taskId,
        actor: { type: 'workflow', id: 'qa_runner' },
        correlationId: crypto.randomUUID(),
        deadline: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: `qa_${revisionId}`,
      },
      {
        taskId,
        designRevisionId: revisionId,
        document,
        sourceHash: sourceSha256,
        manifest,
        renders: [],
        brief: brief as any,
        clientDna: (designDna as unknown as Parameters<typeof qaEngine.run>[1]['clientDna']) || { assets: [] },
        profile: { name: 'generation', version: '1.0', rules: {} },
        repairCycle: 0,
      }
    );
    const qaReport: any = qaRun.ok
      ? { ...qaRun.value, timestamp: new Date().toISOString() }
      : {
          status: 'error',
          criticalPass: false,
          checks: [],
          findings: [],
          error: qaRun.error.message,
          timestamp: new Date().toISOString(),
        };
    const qaSummary = qaReport.criticalPass
      ? 'Design generated; QA passed'
      : `Design generated; QA ${qaReport.status}: ${(qaReport.findings || []).filter((f: any) => f.hardFailure || f.severity === 'critical').map((f: any) => f.ruleId).join(', ') || qaReport.error || 'no finding reported'}`;

    const currentStatus = task ? task.status : toApiTaskStatus(dbTask.state);
    const sm = new TaskStateMachine(taskId, currentStatus);
    if (currentStatus === 'BRIEFING' || currentStatus === 'RECEIVED') {
      const t1 = sm.transition('PLANNING', { type: 'workflow', id: 'generator' }, 'Planning');
      if (t1.ok && events.has(taskId)) events.get(taskId)?.push(t1.value);
    }
    if (sm.getStatus() === 'PLANNING' || sm.getStatus() === 'REVISION_REQUESTED') {
      const t2 = sm.transition('COMPOSING', { type: 'workflow', id: 'generator' }, 'Composing');
      if (t2.ok && events.has(taskId)) events.get(taskId)?.push(t2.value);
      const t3 = sm.transition('QA', { type: 'workflow', id: 'generator' }, 'QA');
      if (t3.ok && events.has(taskId)) events.get(taskId)?.push(t3.value);
      const t4 = sm.transition('AWAITING_APPROVAL', { type: 'workflow', id: 'generator' }, qaSummary);
      if (t4.ok && events.has(taskId)) events.get(taskId)?.push(t4.value);
    }

    if (task) {
      task.status = sm.getStatus();
      task.latestRevisionId = revisionId;
      task.latestQAReport = qaReport;
      task.generatedOps = ops;
      task.updatedAt = new Date().toISOString();
    }

    let finalRevisionId: string = revisionId;
    let generatedVersion: number | null = null;
    if (db && taskRepo) {
      try {
        await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
          generatedVersion = Number((await taskRepo.transitionState({
            taskId,
            tenantId,
            toState: 'human_review',
            actorType: 'workflow',
            actorId: 'generator',
            reason: qaSummary,
            data: { revisionId, qaReport },
          }, trx))?.version) || null;

          if (revisionRepo) {
            const dbRev = await revisionRepo.createRevision({
              id: revisionId,
              tenantId,
              taskId,
              studio: 'canva',
              sourceStorageKey: `tasks/${taskId}/revisions/${revisionId}/source.json`,
              sourceSha256,
              neutralManifest: manifest as any,
              authorType: 'model',
              authorId: 'generator',
              status: 'review',
            }, trx);

            if (dbRev?.id) {
              finalRevisionId = dbRev.id;
            }

            // Persist the QC run as it came out: the approval gate requires a passing critical run.
            const profile = await trx.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
            const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
            await trx
              .insertInto('qc_runs')
              .values({
                tenant_id: tenantId as any,
                task_id: taskId as any,
                design_revision_id: finalRevisionId as any,
                qc_profile_id: profileId as any,
                status: qaReport.status === 'passed' ? 'passed' : qaReport.status === 'error' ? 'error' : 'failed',
                critical_pass: qaReport.criticalPass === true,
                report: qaReport as any,
                report_sha256: crypto.createHash('sha256').update(JSON.stringify(qaReport)).digest('hex'),
              })
              .execute();
          }
        });
      } catch (err) {
        log.error('[core:generate:db] DB transition error:', err);
      }
    }

    if (task) {
      task.latestRevisionId = finalRevisionId;
    }

    // The database moved the task to review (human_review) whatever the in-memory machine allowed.
    broadcastTransition(taskId, currentStatus, generatedVersion !== null ? 'AWAITING_APPROVAL' : sm.getStatus(), generatedVersion);
    broadcast('task:qa_completed', { taskId, revisionId: finalRevisionId, qaReport });

    return c.json({
      commandId: crypto.randomUUID(),
      taskId,
      workflowId: `wf_${taskId}`,
      revisionId: finalRevisionId,
      status: task ? task.status : 'AWAITING_APPROVAL',
    }, 202);
  });
}
