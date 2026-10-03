import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, type RequestContext, type NeutralManifest } from '@hawa/contracts';
import type { DesignBrief, FeedbackEvent } from '@hawa/domain';
import { withRlsContext, sql, FeedbackRepository, type RevisionRepository } from '@hawa/db';
import { diffDocumentManifests } from '@hawa/creative';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import { askLedger } from '../services/ask-ledger.js';
import { readTaskBrief } from '../services/brief-reader.js';
import { rejectLegacyTaskDesignWrite } from './lifecycle-design-proof.js';

class LifecycleOwnedRevisionConflict extends Error {}
class RevisionQaWriteDenied extends Error {}

/** A hawa.design_revisions row. */
type RevisionRow = NonNullable<Awaited<ReturnType<RevisionRepository['findRevisionById']>>>;

/** A hawa.review_comments row (migration 021), as the comment routes read it. */
interface CommentRow {
  id: string;
  task_id: string;
  design_revision_id: string | null;
  node_id: string | null;
  author_role: string;
  author_user_id: string;
  author_display_name: string;
  body: string;
  category: string;
  priority: string;
  created_at: Date | string;
}
const COMMENT_COLUMNS = 'id, task_id, design_revision_id, node_id, author_role, author_user_id, author_display_name, body, category, priority, created_at';

/** A comment in the shape the comment routes have always answered with. */
const commentFromRow = (row: CommentRow) => ({
  commentId: row.id,
  taskId: row.task_id,
  revisionId: row.design_revision_id,
  nodeId: row.node_id,
  author: { userId: row.author_user_id, role: row.author_role, displayName: row.author_display_name },
  comment: row.body,
  category: row.category,
  priority: row.priority,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
});

/**
 * Design revisions and what reviewers say about them (architecture programme 1.3, group G3, moved
 * from app.ts): revisions and their QA, reviewer comments, the structural diff, operator feedback
 * and the requester's asks, all read from and written to Postgres.
 * GET /tasks/:taskId/revisions/diff is registered before GET /tasks/:taskId/revisions/:revisionId,
 * which would otherwise take "diff" for a revision id.
 */
const FEEDBACK_POLARITIES = ['positive', 'negative', 'neutral'] as const;
const FEEDBACK_CATEGORIES = ['typography', 'color', 'layout', 'brand_voice', 'cultural', 'image_subject', 'other'] as const;

export function registerRevisionsRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    problem,
    db,
    taskRepo,
    revisionRepo,
    qaEngine,
    readCurrentTask,
    broadcastEvent: broadcast,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Revisions, comments and feedback are only held in Postgres. They used to live in maps in this
  // process as well, which were read first: a restart lost them, a second Core process never saw
  // them, and a revision Postgres refused was still answered (architecture programme 1.3, group G3).
  // Without a database these routes answer 503 rather than keep anything in memory.
  const noDatabase = (c: Context, what: string) => problem(c, 503, 'Database Unavailable', `${what} are only held in the database`);
  const scopeOf = (auth: { tenantId?: string; userId?: string; role?: string }) => ({
    tenantId: auth.tenantId || DEFAULT_TENANT_ID,
    userId: auth.userId || SYSTEM_AUTOMATION_USER_ID,
    role: auth.role || 'operator',
  });

  /** A design_revisions row in the shape these routes have always answered with. */
  const revisionFromRow = (row: RevisionRow) => ({
    id: row.id,
    revisionId: row.id,
    taskId: row.task_id,
    revisionNumber: Number(row.revision),
    sourceSha256: row.source_sha256 || '',
    manifestSha256: row.neutral_manifest_sha256 || '',
    status: row.status || 'draft',
    document: (row.neutral_manifest as any) || {
      documentId: `doc_${row.id}`,
      sourceRevision: Number(row.revision),
      sourceSha256: row.source_sha256,
      format: 'historical_manifest',
      nodes: [],
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  });

  /** The caller's tenant's revisions with these ids; an id that is not a uuid names none. */
  const readRevisions = async (auth: { tenantId?: string; userId?: string; role?: string }, ids: string[]) => {
    const wanted = [...new Set(ids.filter((id) => isValidUuid(id)))];
    const found = new Map<string, ReturnType<typeof revisionFromRow>>();
    if (!db || wanted.length === 0) return found;
    const scope = scopeOf(auth);
    const rows = await withRlsContext(db, scope, (trx) =>
      trx.selectFrom('design_revisions').selectAll().where('tenant_id', '=', scope.tenantId).where('id', 'in', wanted).execute()
    );
    for (const row of rows) found.set(row.id, revisionFromRow(row));
    return found;
  };

  // Design Revisions
  registerRoute('get', '/designs/:designId/revisions', async (c: any) => {
    const designId = c.req.param('designId');
    if (!db) return noDatabase(c, 'Design revisions');
    // The design is a task (its revisions) or one revision; an id that is not a uuid is neither.
    if (!isValidUuid(designId)) return c.json({ items: [] });
    const scope = scopeOf(verifyRequestAuth(c));
    const rows = await withRlsContext(db, scope, (trx) =>
      trx
        .selectFrom('design_revisions')
        .selectAll()
        .where('tenant_id', '=', scope.tenantId)
        .where((eb) => eb.or([eb('task_id', '=', designId), eb('id', '=', designId)]))
        .orderBy('revision', 'asc')
        .execute()
    );
    return c.json({ items: rows.map(revisionFromRow) });
  });

  // Run Revision QA
  registerRoute('post', '/tasks/:taskId/revisions/:revisionId/qa', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');
    if (!db) return noDatabase(c, 'Design revisions');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
    const rev = (await readRevisions(auth, [revisionId])).get(revisionId);
    // Another task's revision is not found here: its QA run would be recorded against this task.
    if (!rev || rev.taskId !== taskId) return problem(c, 404, 'Revision Not Found');

    const ctx: RequestContext = {
      tenantId,
      taskId,
      actor: { type: 'workflow', id: 'qa_runner' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: `qa_${revisionId}`,
    };

    const revText = rev.document?.nodes?.find((n: any) => n.text)?.text || 'Campaign Text';
    // The brief saved for the task, as Postgres has it; a brief made from the revision's text otherwise.
    const brief: DesignBrief = (await readTaskBrief(db, { tenantId, userId: auth.userId, role: auth.role }, taskId)) || {
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
      sourceHash: rev.document?.sourceSha256 ?? rev.sourceSha256,
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
    if (db) {
      try {
        await withRlsContext(db, scopeOf(auth), async (trx) => {
          // Serialize attempt allocation on the revision under the caller's write authority.
          const writableRevision = await trx.selectFrom('design_revisions')
            .select('id').where('id', '=', revisionId).where('task_id', '=', taskId)
            .where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
          if (!writableRevision) throw new RevisionQaWriteDenied();
          const profile = await trx.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
          const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
          const previousAttempt = await trx.selectFrom('qc_runs').select('attempt')
            .where('design_revision_id', '=', revisionId).where('qc_profile_id', '=', profileId)
            .orderBy('attempt', 'desc').limit(1).executeTakeFirst();
          await trx
            .insertInto('qc_runs')
            .values({
              tenant_id: tenantId as any,
              task_id: taskId as any,
              design_revision_id: revisionId as any,
              qc_profile_id: profileId as any,
              attempt: (previousAttempt?.attempt ?? 0) + 1,
              status: qaRes.value.status === 'passed' ? 'passed' : qaRes.value.status === 'error' ? 'error' : 'failed',
              critical_pass: qaRes.value.criticalPass === true,
              report: qaRes.value as any,
              report_sha256: crypto.createHash('sha256').update(JSON.stringify(qaRes.value)).digest('hex'),
            })
            .execute();
        });
      } catch (err) {
        log.error('[core:qa:db] Failed to persist qc_run:', err);
        if (err instanceof RevisionQaWriteDenied || (typeof err === 'object' && err !== null && 'code' in err && err.code === '42501')) {
          return problem(c, 403, 'Forbidden', 'Your current permissions do not allow recording QA for this task');
        }
        return problem(c, 503, 'QA Evidence Unavailable', 'The QA result was not recorded; try again when evidence storage is available');
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
    const lifecycleRefusal = await rejectLegacyTaskDesignWrite(ctx, c, auth, true);
    if (lifecycleRefusal) return lifecycleRefusal;

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
    if (!revisionRepo || !db) return noDatabase(c, 'Design revisions');

    const body = await c.req.json().catch(() => ({}));

    // Invariant 2: Design must contain editable nodes; empty designs or non-array nodes are strictly rejected
    const candidateNodes = body.nodes || body.document?.nodes;
    if (!candidateNodes || !Array.isArray(candidateNodes) || candidateNodes.length === 0) {
      return problem(c, 400, 'Invalid Design Nodes', 'A design revision must contain an array of at least one editable canvas node');
    }

    const now = new Date().toISOString();
    const wasApproved = task ? task.status === 'APPROVED' : dbTask?.state === 'approved';
    // The approval this revision invalidates, as Postgres records it (services/task-reader.ts).
    const previousApprovalId: string | undefined = task?.latestApproval?.decisionId;

    // Postgres names a revision by uuid. A caller's own id that is not one used to be kept in memory
    // only; now it would fail the insert, so it is refused before anything is written.
    if (body.revisionId !== undefined && !isValidUuid(body.revisionId)) {
      return problem(c, 400, 'Invalid Revision Id', 'revisionId must be a uuid; leave it out to have one assigned');
    }
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
          async (trx) => {
            const owner = await trx.selectFrom('tasks').select('request_id')
              .where('tenant_id', '=', tenantId).where('id', '=', taskId).executeTakeFirst();
            if (owner?.request_id) {
              const request = await trx.selectFrom('requests').select(['owner', 'stage', 'current_task_id'])
                .where('tenant_id', '=', tenantId).where('request_id', '=', owner.request_id)
                .forUpdate().executeTakeFirst();
              if (request?.owner !== 'restate' || request.stage !== 'manual' ||
                  request.current_task_id !== taskId) throw new LifecycleOwnedRevisionConflict();
            }
            return revisionRepo.createRevision({
              id: revisionId,
              tenantId,
              taskId,
              neutralManifest: manifest,
              authorType: (auth.role === 'adapter' ? 'workflow' : 'user') as any,
              authorId: auth.actorId || auth.userId,
              status: 'review',
            }, trx);
          }
        );
      } catch (err: any) {
        if (err instanceof LifecycleOwnedRevisionConflict) return problem(c, 409, 'LIFECYCLE_OWNED');
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
      version: Number(dbRevision.revision),
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

    // The new revision, the task's move to review and the approval's invalidation are Postgres's
    // (createRevision). They were also written onto this process's copy of the task, with a QA report
    // and a capture set the caller sent, which approval then trusted and a restart lost.

    // Gate F & Invariant #11: Post-approval edits strictly invalidate approval
    let approvalInvalidated = false;
    if (wasApproved) {
      approvalInvalidated = true;
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
    }

    broadcast('task:revision_created', { taskId, revisionId: finalRevisionId, approvalInvalidated });

    return c.json({
      ok: true,
      status: 'AWAITING_APPROVAL',
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
  // A comment is a row of hawa.review_comments (migration 021): append-only, scoped to the task by
  // row-level security. It used to be kept only in this process's memory, so a restart lost every
  // comment and a second process never saw one.
  registerRoute('post', '/tasks/:taskId/comments', async (c: any) => {
    const taskId = c.req.param('taskId');
    // Postgres's copy, or 503 when it cannot be read: the comment names the task's current revision.
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    if (!db) return noDatabase(c, 'Review comments');
    // A task Postgres does not hold (only this process's copy has an id that is not a uuid) has no
    // row for the comment to belong to.
    if (!isValidUuid(taskId)) return problem(c, 404, 'Task Not Found');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.userId) return problem(c, 401, 'Authentication Required');

    const body = await c.req.json().catch(() => ({}));
    const allowedRoles = ['art_director', 'creative_director', 'client_reviewer', 'operator'];
    // The role is the signed-in caller's. It used to come from the body, defaulting to art_director,
    // so anyone signed in could file a comment as an art director, now kept for good.
    const actorRole = auth.role;

    if (!allowedRoles.includes(actorRole)) {
      return problem(c, 403, 'Forbidden', `Role ${actorRole} is not permitted to submit review comments`);
    }

    // The body is stored as it came, so each field is a bounded string (the table checks the same limits).
    const field = (value: unknown, fallback: string | null, max: number): string | null | undefined => {
      if (value === undefined || value === null || value === '') return fallback;
      return typeof value === 'string' && value.length <= max ? value : undefined;
    };
    const text = field(body.comment, '', 10000);
    const nodeId = field(body.nodeId, null, 200);
    const category = field(body.category, 'copy_change', 100);
    const priority = field(body.priority, 'medium', 50);
    const displayName = field(body.author?.displayName, auth.displayName || 'Reviewer', 200);
    if (text === undefined || text === null || nodeId === undefined || !category || !priority || !displayName) {
      return problem(c, 400, 'Invalid Comment', 'comment, nodeId, category, priority and author.displayName must be strings of a reasonable length');
    }

    // The revision the comment is on: the one the body names, which must be this task's, or else the
    // task's current revision when Postgres holds it.
    const named = body.revisionId ?? task.latestRevisionId ?? null;
    let revisionId: string | null = null;
    if (named) {
      const found = isValidUuid(named) ? (await readRevisions(auth, [named])).get(named) : undefined;
      if (found && found.taskId === taskId) revisionId = named;
      else if (body.revisionId !== undefined) return problem(c, 404, 'Revision Not Found', `Revision ${named} is not a revision of task ${taskId}`);
    }

    const scope = scopeOf(auth);
    let row: CommentRow;
    try {
      row = await withRlsContext(db, scope, async (trx) => (await sql<CommentRow>`
        INSERT INTO hawa.review_comments
          (tenant_id, task_id, design_revision_id, node_id, author_role, author_user_id, author_display_name, body, category, priority)
        VALUES (${scope.tenantId}::uuid, ${taskId}::uuid, ${revisionId}::uuid, ${nodeId}, ${actorRole}, ${auth.userId}, ${displayName},
          ${text}, ${category}, ${priority})
        RETURNING ${sql.raw(COMMENT_COLUMNS)}`.execute(trx)).rows[0]);
    } catch (err) {
      log.error('[core:comments:create] DB error:', err);
      return problem(c, 503, 'Durable Storage Unavailable', 'The comment could not be recorded; try again');
    }
    const commentRecord = commentFromRow(row);

    broadcast('task:comment_added', { taskId, comment: commentRecord });

    return c.json({ ok: true, comment: commentRecord }, 201);
  });

  registerRoute('get', '/tasks/:taskId/comments', async (c: any) => {
    const taskId = c.req.param('taskId');
    if (!db) return noDatabase(c, 'Review comments');
    if (!isValidUuid(taskId)) return c.json({ ok: true, taskId, comments: [] });
    const scope = scopeOf(verifyRequestAuth(c));
    const rows = await withRlsContext(db, scope, async (trx) => (await sql<CommentRow>`
      SELECT ${sql.raw(COMMENT_COLUMNS)} FROM hawa.review_comments
      WHERE tenant_id = ${scope.tenantId}::uuid AND task_id = ${taskId}::uuid
      ORDER BY created_at, id`.execute(trx)).rows);
    return c.json({ ok: true, taskId, comments: rows.map(commentFromRow) });
  });

  // Semantic Document Revision Diff (Gate F: Structural Diffs)
  registerRoute('get', '/tasks/:taskId/revisions/diff', async (c: any) => {
    const taskId = c.req.param('taskId');
    const fromRevId = c.req.query('fromRevisionId');
    const toRevId = c.req.query('toRevisionId');

    if (!fromRevId || !toRevId) {
      return problem(c, 400, 'Bad Request', 'fromRevisionId and toRevisionId query params are required');
    }

    if (!db) return noDatabase(c, 'Design revisions');
    const found = await readRevisions(verifyRequestAuth(c), [fromRevId, toRevId]);
    const fromRev = found.get(fromRevId);
    const toRev = found.get(toRevId);
    if (!fromRev || !toRev || fromRev.taskId !== taskId || toRev.taskId !== taskId) {
      return problem(c, 404, 'Revision Not Found', 'One or both revisions were not found for this task');
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

    if (!db) return noDatabase(c, 'Design revisions');
    let rev: ReturnType<typeof revisionFromRow> | undefined;
    try {
      rev = (await readRevisions({ tenantId, userId: auth.userId, role: auth.role || 'operator' }, [revisionId])).get(revisionId);
    } catch (err) {
      log.error('[core:revisions:get] DB fetch error:', err);
      return problem(c, 503, 'Database Unavailable', 'The revision could not be read; try again');
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
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');
    if (!db || !taskRepo) return noDatabase(c, 'Feedback events');
    if (!isValidUuid(taskId)) return problem(c, 404, 'Task Not Found');
    const body = await c.req.json().catch(() => ({}));
    const auth = verifyRequestAuth(c);
    const scope = scopeOf(auth);

    // A feedback event (hawa.feedback_events) belongs to the task's client as Postgres records it. It
    // used to take any client id the body named, or a fixture client's, and was kept only in memory.
    const stored = await withRlsContext(db, scope, (trx) => taskRepo.findById(taskId, scope.tenantId, trx));
    if (!stored) return problem(c, 404, 'Task Not Found');
    if (!stored.client_id) return problem(c, 422, 'Client Required', 'Feedback is recorded against the task\'s client, and this task has none');
    // hawa.feedback_events is what client learning reads, so only the feedback categories are taken: the
    // learning-source categories (client_rule_instruction, design_refinement, ...) are written by their own
    // services with their own evidence, never named by a caller here.
    const polarity = body.polarity ?? 'neutral';
    const category = body.category ?? 'layout';
    const rawFeedbackText = body.rawFeedbackText ?? body.comment ?? '';
    if (!(FEEDBACK_POLARITIES as readonly unknown[]).includes(polarity) || !(FEEDBACK_CATEGORIES as readonly unknown[]).includes(category) ||
        typeof rawFeedbackText !== 'string' || rawFeedbackText.length > 4000) {
      return problem(c, 422, 'Invalid Feedback', `polarity is one of ${FEEDBACK_POLARITIES.join(', ')}; category one of ${FEEDBACK_CATEGORIES.join(', ')}; the comment at most 4000 characters`);
    }
    // The revision named must be this task's (as for a review comment); otherwise the task's current one.
    let revisionId: string | null = isValidUuid(stored.current_design_revision_id) ? stored.current_design_revision_id : null;
    if (body.revisionId !== undefined && body.revisionId !== null) {
      const found = isValidUuid(body.revisionId) ? (await readRevisions(auth, [body.revisionId])).get(body.revisionId) : undefined;
      if (!found || found.taskId !== taskId) return problem(c, 404, 'Revision Not Found', 'That revision is not a revision of this task');
      revisionId = body.revisionId;
    }
    // Who gave it is the signed-in caller; the body names neither the user nor their name.
    const attributedActor = { userId: auth.userId, displayName: auth.displayName || 'Operator' };

    let row: Awaited<ReturnType<FeedbackRepository['recordFeedback']>>;
    try {
      row = await withRlsContext(db, scope, (trx) => new FeedbackRepository(trx).recordFeedback({
        tenantId: scope.tenantId,
        clientId: stored.client_id!,
        taskId,
        beforeRevisionId: revisionId,
        category,
        explicitness: 'direct_instruction',
        target: { polarity, attributedActor },
        comment: rawFeedbackText,
        actorId: isValidUuid(auth.userId) ? auth.userId : null,
      }, trx));
    } catch (err) {
      log.error('[core:feedback:create] DB error:', err);
      return problem(c, 503, 'Durable Storage Unavailable', 'The feedback could not be recorded; try again');
    }

    const feedback: FeedbackEvent = {
      feedbackId: row.id,
      taskId,
      clientId: row.client_id,
      designRevisionId: revisionId ?? '',
      polarity,
      category,
      rawFeedbackText,
      attributedActor,
      governance: {
        status: 'received',
      },
      occurredAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };

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
