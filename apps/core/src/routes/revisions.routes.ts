import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, type RequestContext, type NeutralManifest } from '@hawa/contracts';
import type { DesignBrief, FeedbackEvent } from '@hawa/domain';
import { withRlsContext } from '@hawa/db';
import { diffDocumentManifests } from '@hawa/creative';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import { askLedger } from '../services/ask-ledger.js';

/**
 * Design revisions and what reviewers say about them (architecture programme 1.3, group G3, moved
 * from app.ts unchanged): revisions and their QA, reviewer comments, the structural diff, operator
 * feedback and the requester's asks. GET /tasks/:taskId/revisions/diff is registered before
 * GET /tasks/:taskId/revisions/:revisionId, which would otherwise take "diff" for a revision id.
 */
export function registerRevisionsRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    problem,
    db,
    taskRepo,
    revisionRepo,
    tasks,
    briefs,
    revisions,
    feedbacks,
    taskComments,
    qaEngine,
    readCurrentTask,
    broadcastEvent: broadcast,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Design Revisions
  registerRoute('get', '/designs/:designId/revisions', (c: any) => {
    const designId = c.req.param('designId');
    const list = Array.from(revisions.values()).filter((r) => r.taskId === designId || r.revisionId === designId);
    return c.json({ items: list });
  });

  // Run Revision QA
  registerRoute('post', '/tasks/:taskId/revisions/:revisionId/qa', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');
    const rev = revisions.get(revisionId);
    if (!rev) return problem(c, 404, 'Revision Not Found');

    const ctx: RequestContext = {
      tenantId: 'tenant-default',
      taskId,
      actor: { type: 'workflow', id: 'qa_runner' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: `qa_${revisionId}`,
    };

    const revText = rev.document?.nodes?.find((n: any) => n.text)?.text || 'Campaign Text';
    const brief: DesignBrief = briefs.get(taskId) || {
      briefId: crypto.randomUUID(),
      taskId,
      clientId: defaultClientId,
      clientDnaVersion: 1,
      objective: 'Campaign',
      taskRoute: 'creative_director',
      primaryLanguage: 'ckb',
      direction: 'rtl' as const,
      variants: [{ id: 'v1', name: 'Poster', width: 1080, height: 1920, aspectRatio: '9:16', role: 'instagram_story' }],
      exactCopy: [
        {
          id: 'b1',
          role: 'headline' as const,
          text: revText,
          language: 'ckb' as const,
          direction: 'rtl' as const,
          approved: true,
          protectedTokens: [],
        },
      ],
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    const manifest: NeutralManifest = {
      pages: [{ id: 'v1', name: 'Poster', width: 1080, height: 1920, unit: 'px', language: 'ckb', direction: 'rtl' }],
      nodes: [
        { id: 'node_1', pageId: 'v1', type: 'text', role: 'headline', text: revText, locked: false, zIndex: 1 },
        { id: 'node_logo', pageId: 'v1', type: 'image', role: 'logo', assetSha256: 'sha256_logo_verified_primary', locked: false, zIndex: 2 },
      ],
      fonts: [{ family: 'Noto Sans Arabic', style: 'Regular' }],
      assets: [{ sha256: 'sha256_logo_verified_primary', mimeType: 'image/png' }],
      warnings: [],
    };

    const qaRes = await qaEngine.run(ctx, {
      taskId,
      designRevisionId: revisionId,
      document: rev.document,
      sourceHash: rev.document.sourceSha256,
      manifest,
      renders: [
        {
          format: 'png',
          width: 1080,
          height: 1920,
          storageKey: `deliverables/${taskId}/story.png`,
          byteSize: 12,
          warnings: [],
          sha256: 'sha256_render_story_png',
        },
      ],
      brief: brief as any,
      clientDna: { assets: [{ role: 'logo_primary', sha256: 'sha256_logo_verified_primary' }] },
      profile: { name: 'strict', version: '1.0', rules: {} },
      repairCycle: 0,
    });

    if (!qaRes.ok) return problem(c, 500, 'QA Failed', qaRes.error.message);
    const task = tasks.get(taskId);
    if (task) {
      task.latestQAReport = { ...qaRes.value, revisionId, designRevisionId: revisionId };
    }
    if (db) {
      try {
        const tenantId = (task as any)?.tenantId || '00000000-0000-4000-a000-000000000001';
        await withRlsContext(db, { tenantId, userId: '00000000-0000-4000-a000-000000000002', role: 'operator' }, async (trx) => {
          const profile = await trx.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
          const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
          await trx
            .insertInto('qc_runs')
            .values({
              tenant_id: tenantId as any,
              task_id: taskId as any,
              design_revision_id: revisionId as any,
              qc_profile_id: profileId as any,
              status: qaRes.value.status === 'passed' ? 'passed' : qaRes.value.status === 'error' ? 'error' : 'failed',
              critical_pass: qaRes.value.criticalPass === true,
              report: qaRes.value as any,
              report_sha256: crypto.createHash('sha256').update(JSON.stringify(qaRes.value)).digest('hex'),
            })
            .execute();
        });
      } catch (err) {
        log.error('[core:qa:db] Failed to persist qc_run:', err);
      }
    }
    return c.json(qaRes.value, 200);
  });

  // Register Task Revision (Gate F: Post-Approval Invalidation & Diff Engine)
  registerRoute('post', '/tasks/:taskId/revisions', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to create a design revision');
    }

    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    let task = await readCurrentTask(taskId);
    let dbTask: any = null;
    // An id that is not a uuid names no task in Postgres, and the query would fail on the cast (a
    // 500) rather than find nothing; the :control catch-all used to answer 404 before it got here.
    if (taskRepo && db && isValidUuid(taskId)) {
      dbTask = await withRlsContext(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        async (trx) => await taskRepo.findById(taskId, tenantId, trx)
      );
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json().catch(() => ({}));

    // Invariant 2: Design must contain editable nodes; empty designs or non-array nodes are strictly rejected
    const candidateNodes = body.nodes || body.document?.nodes;
    if (!candidateNodes || !Array.isArray(candidateNodes) || candidateNodes.length === 0) {
      return problem(c, 400, 'Invalid Design Nodes', 'A design revision must contain an array of at least one editable canvas node');
    }

    const now = new Date().toISOString();
    const wasApproved = task ? task.status === 'APPROVED' : dbTask?.state === 'approved';
    const previousApprovalId = (task as any)?.latestApproval?.decisionId;

    let dbRevision: any = null;
    const revisionId = body.revisionId || crypto.randomUUID();

    if (revisionRepo && db) {
      try {
        const manifest = {
          nodes: candidateNodes,
          pages: body.pages || body.document?.pages || [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px', language: 'ckb', direction: 'rtl' }],
          title: body.title || body.document?.title || `${(dbTask || task)?.title || 'Task'} Revision`,
        };

        dbRevision = await withRlsContext(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (trx) => await revisionRepo.createRevision({
            id: revisionId,
            tenantId,
            taskId,
            neutralManifest: manifest,
            authorType: (auth.role === 'adapter' ? 'workflow' : 'user') as any,
            authorId: auth.actorId || auth.userId,
            status: 'review',
          }, trx)
        );
      } catch (err: any) {
        log.error('[core:revisions:create] DB revision error:', err);
        return problem(c, 503, 'Durable Storage Unavailable', `Failed to persist revision: ${err.message}`);
      }
    }

    const finalRevisionId = dbRevision ? dbRevision.id : revisionId;
    const newDoc: any = body.document || {
      id: crypto.randomUUID(),
      title: body.title || `${(dbTask || task)?.title || 'Task'} Revision`,
      pages: body.pages || [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px', language: 'ckb', direction: 'rtl' }],
      nodes: candidateNodes,
      sourceSha256: dbRevision ? dbRevision.source_sha256 : crypto.createHash('sha256').update(JSON.stringify(candidateNodes)).digest('hex'),
      version: dbRevision ? Number(dbRevision.revision) : ((revisions.get(task?.latestRevisionId)?.document?.version || 1) + 1),
    };

    const newRev = {
      revisionId: finalRevisionId,
      id: finalRevisionId,
      taskId,
      document: newDoc,
      plan: body.plan || null,
      author: { userId: auth.userId, role: auth.role },
      createdAt: dbRevision ? (dbRevision.created_at instanceof Date ? dbRevision.created_at.toISOString() : String(dbRevision.created_at)) : now,
      metadata: body.metadata || {},
    };

    revisions.set(finalRevisionId, newRev);
    const previousRevId = task?.latestRevisionId;
    if (task) {
      task.latestRevisionId = finalRevisionId;
      task.updatedAt = now;
      task.latestQAReport = body.qaReport ? { ...body.qaReport, revisionId: finalRevisionId } : null;
      task.latestCaptureSet = body.captureSet || null;
      if ((task as any).latestApproval) {
        (task as any).latestApproval = {
          ...((task as any).latestApproval || {}),
          invalidated: true,
          invalidationReason: 'new_revision_created',
        };
      }
      task.status = 'AWAITING_APPROVAL';
    }

    // Gate F & Invariant #11: Post-approval edits strictly invalidate approval
    let approvalInvalidated = false;
    if (wasApproved) {
      approvalInvalidated = true;
      if (task) {
        task.status = 'AWAITING_APPROVAL';
        const invalidationRecord = {
          invalidatedAt: now,
          reason: 'post_approval_edit',
          previousApprovalId,
          previousRevisionId: previousRevId,
          newRevisionId: finalRevisionId,
          actor: body.author || { userId: auth.userId, role: auth.role },
        };
        (task as any).invalidationHistory = (task as any).invalidationHistory || [];
        (task as any).invalidationHistory.push(invalidationRecord);
        (task as any).latestApproval = { ...((task as any).latestApproval || {}), invalidated: true, invalidationRecord };
      }
      if (taskRepo && db) {
        try {
          await withRlsContext(
            db,
            { tenantId, userId: auth.userId, role: auth.role },
            async (trx) => {
              await taskRepo.transitionState({
                taskId,
                tenantId,
                toState: 'human_review',
                actorType: 'user',
                actorId: auth.userId,
                reason: 'Post-approval edit invalidated previous approval',
                data: {
                  invalidatedApprovalId: previousApprovalId,
                  newRevisionId: finalRevisionId,
                },
              }, trx);
            }
          );
        } catch (err) {
          log.error('[core:revisions:invalidate] DB approval invalidation error:', err);
        }
      }
    } else {
      if (task) task.status = 'AWAITING_APPROVAL';
    }

    broadcast('task:revision_created', { taskId, revisionId: finalRevisionId, approvalInvalidated });

    return c.json({
      ok: true,
      status: task ? task.status : 'AWAITING_APPROVAL',
      revisionId: finalRevisionId,
      id: finalRevisionId,
      revisionNumber: dbRevision ? dbRevision.revision : 1,
      sourceSha256: newDoc.sourceSha256,
      approvalInvalidated,
      document: newDoc,
      revision: newRev,
      createdAt: now,
    }, 201);
  });

  // Register Task Node Reviewer Comment (Gate F: Reviewer comments with role policy)
  registerRoute('post', '/tasks/:taskId/comments', async (c: any) => {
    const taskId = c.req.param('taskId');
    // Postgres's copy, or 503 when it cannot be read: the comment names the task's current revision.
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json().catch(() => ({}));
    const allowedRoles = ['art_director', 'creative_director', 'client_reviewer', 'operator'];
    const actorRole = body.author?.role || 'art_director';

    if (!allowedRoles.includes(actorRole)) {
      return problem(c, 403, 'Forbidden', `Role ${actorRole} is not permitted to submit review comments`);
    }

    const commentId = crypto.randomUUID();
    const commentRecord = {
      commentId,
      taskId,
      revisionId: body.revisionId || task.latestRevisionId,
      nodeId: body.nodeId || null,
      author: {
        userId: body.author?.userId || 'reviewer_1',
        role: actorRole,
        displayName: body.author?.displayName || 'Reviewer',
      },
      comment: body.comment || '',
      category: body.category || 'copy_change',
      priority: body.priority || 'medium',
      createdAt: new Date().toISOString(),
    };

    if (!taskComments.has(taskId)) taskComments.set(taskId, []);
    taskComments.get(taskId)!.push(commentRecord);

    broadcast('task:comment_added', { taskId, comment: commentRecord });

    return c.json({ ok: true, comment: commentRecord }, 201);
  });

  registerRoute('get', '/tasks/:taskId/comments', (c: any) => {
    const taskId = c.req.param('taskId');
    const comments = taskComments.get(taskId) || [];
    return c.json({ ok: true, taskId, comments });
  });

  // Semantic Document Revision Diff (Gate F: Structural Diffs)
  registerRoute('get', '/tasks/:taskId/revisions/diff', (c: any) => {
    const taskId = c.req.param('taskId');
    const fromRevId = c.req.query('fromRevisionId');
    const toRevId = c.req.query('toRevisionId');

    if (!fromRevId || !toRevId) {
      return problem(c, 400, 'Bad Request', 'fromRevisionId and toRevisionId query params are required');
    }

    const fromRev = revisions.get(fromRevId);
    const toRev = revisions.get(toRevId);
    if (!fromRev || !toRev) {
      return problem(c, 404, 'Revision Not Found', 'One or both revisions were not found');
    }

    const baseManifest: any = {
      pages: fromRev.document?.pages || [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px' }],
      nodes: fromRev.document?.nodes || [],
    };
    const targetManifest: any = {
      pages: toRev.document?.pages || [{ id: 'p1', name: 'main', width: 1080, height: 1920, unit: 'px' }],
      nodes: toRev.document?.nodes || [],
    };

    const diff = diffDocumentManifests(baseManifest, targetManifest);
    return c.json({
      ok: true,
      taskId,
      fromRevisionId: fromRevId,
      toRevisionId: toRevId,
      diff,
    });
  });

  registerRoute('get', '/tasks/:taskId/revisions/:revisionId', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';

    let rev = revisions.get(revisionId);

    // If not in memory, query PostgreSQL database
    if (!rev && db) {
      try {
        const dbRev = await withRlsContext(
          db,
          { tenantId, userId: auth.userId, role: auth.role || 'operator' },
          async (trx) => {
            return await trx
              .selectFrom('design_revisions')
              .selectAll()
              .where('id', '=', revisionId)
              .where('tenant_id', '=', tenantId)
              .executeTakeFirst();
          }
        );
        if (dbRev) {
          rev = {
            id: dbRev.id,
            revisionId: dbRev.id,
            taskId: dbRev.task_id,
            revisionNumber: Number(dbRev.revision),
            sourceSha256: dbRev.source_sha256 || '',
            manifestSha256: dbRev.neutral_manifest_sha256 || '',
            status: (dbRev.status || 'draft') as any,
            document: (dbRev.neutral_manifest as any) || {
              documentId: `doc_${dbRev.id}`,
              sourceRevision: Number(dbRev.revision),
              sourceSha256: dbRev.source_sha256,
              format: 'historical_manifest',
              nodes: [],
            },
            createdAt: dbRev.created_at instanceof Date ? dbRev.created_at.toISOString() : String(dbRev.created_at),
          };
          revisions.set(revisionId, rev);
        }
      } catch (err) {
        log.error('[core:revisions:get] DB fetch error:', err);
      }
    }

    if (!rev) return problem(c, 404, 'Revision Not Found', `Revision ${revisionId} does not exist`);
    // Enforce task ownership: revision must belong to this specific task
    if (rev.taskId !== taskId) {
      return problem(c, 404, 'Revision Not Found for this Task', `Revision ${revisionId} belongs to task ${rev.taskId}, not task ${taskId}`);
    }
    return c.json({ ok: true, revision: rev });
  });

  // Record Operator Feedback
  registerRoute('post', '/tasks/:taskId/feedback', async (c: any) => {
    const taskId = c.req.param('taskId');
    // Feedback on a task nobody knows is refused (the `:control` catch-all used to answer this 404).
    if (!(await readCurrentTask(taskId))) return problem(c, 404, 'Task Not Found');
    const body = await c.req.json();

    const feedback: FeedbackEvent = {
      feedbackId: crypto.randomUUID(),
      taskId,
      clientId: body.clientId || defaultClientId,
      designRevisionId: body.revisionId || crypto.randomUUID(),
      polarity: body.polarity || 'neutral',
      category: body.category || 'layout',
      rawFeedbackText: body.rawFeedbackText || body.comment || '',
      attributedActor: {
        userId: body.userId || crypto.randomUUID(),
        displayName: body.displayName || 'Operator',
      },
      governance: {
        status: 'received',
      },
      occurredAt: new Date().toISOString(),
    };

    if (!feedbacks.has(taskId)) feedbacks.set(taskId, []);
    feedbacks.get(taskId)!.push(feedback);

    return c.json({ feedback }, 201);
  });

  // What the requester asked of a design, round by round, and what became of it (services/ask-ledger.ts):
  // what the art director reads in Hawa Desk before approving a design or taking it over.
  registerRoute('get', '/tasks/:taskId/asks', async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || auth.role === 'adapter') return problem(c, 401, 'Authentication Required');
    const taskId = c.req.param('taskId') || '';
    if (!isValidUuid(taskId)) return problem(c, 400, 'Invalid task id');
    if (!db) return problem(c, 503, 'Database Unavailable');
    const rounds = await askLedger(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId || SYSTEM_AUTOMATION_USER_ID, role: String(auth.role) }, taskId);
    return c.json({ taskId, rounds });
  });
}
