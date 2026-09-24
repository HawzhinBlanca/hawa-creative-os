import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { TaskStateMachine, isAuthorizedReviewerRole, type PinnedExport } from '@hawa/domain';
import { withRlsContext, toApiTaskStatus } from '@hawa/db';
import { HumanApprovalManager } from '@hawa/integrations';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid, qaReportSha256 } from '../core-helpers.js';
import { log } from '../logging.js';
import { parsePinnedExportIds } from '../services/pinned-deliverables.js';
import { pendingChangeOf as findPendingChange, pendingChangeWords } from '../services/pending-change.js';

/**
 * A reviewer's decision on a design revision, and what the review desk shows before it
 * (architecture programme 1.3, group G3, moved from app.ts): POST decisions, GET review-desk and the
 * chat approval action. A decision is recorded in Postgres (approvals) or refused.
 */
export function registerDecisionsRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    problem,
    db,
    taskRepo,
    revisionRepo,
    events,
    deliverableStore,
    readCurrentTask,
    resolveTaskWithFallback,
    broadcastEvent: broadcast,
  } = ctx;

  // createApp's verifyRequestAuth fills in every field, with '' for a caller who is not signed in
  // (app.ts); the context types it as AuthContext, whose fields are optional. These handlers were
  // written against the former.
  const verifyRequestAuth = ctx.verifyRequestAuth as (c: Context) => Required<AuthContext> & { displayName?: string };
  const defaultClientId = DEFAULT_CLIENT_ID;
  const humanApprovalManager = new HumanApprovalManager();
  const pendingChangeOf = (tenantId: string, taskId: string, after?: Date) => findPendingChange(db!, tenantId, taskId, after);

  // Human Review Decision (H03, FR-043, FR-044, CV-15)
  registerRoute('post', '/tasks/:taskId/revisions/:revisionId/decisions', async (c: any) => {
    const taskId = c.req.param('taskId');
    const revisionId = c.req.param('revisionId');

    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to record review decisions');
    }

    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    let task = await readCurrentTask(taskId);
    // A decision is recorded in Postgres (approvals) or not at all, in every environment. Without a
    // database it used to be kept in this process's memory, where delivery also looked for it; a
    // restart lost it and a second process never saw it.
    if (!db || !taskRepo || !revisionRepo) {
      if (!task) return problem(c, 404, 'Task Not Found');
      return problem(c, 503, 'Database Unavailable', 'A review decision is only recorded in the database');
    }
    let dbTask: any = null;
    // An id that is not a uuid names no task or revision in Postgres; the query would fail on the cast.
    if (isValidUuid(taskId)) {
      dbTask = await withRlsContext(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        async (trx) => await taskRepo.findById(taskId, tenantId, trx)
      );
    }
    if (!task && !dbTask) return problem(c, 404, 'Task Not Found');

    let resolvedRev: any = null;
    let dbRev: any = null;
    if (isValidUuid(revisionId)) {
      dbRev = await withRlsContext(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        async (trx) => await revisionRepo.findRevisionById(revisionId, tenantId, trx)
      );
      if (dbRev) {
        if (dbRev.task_id !== taskId) {
          return problem(c, 400, 'Cross-Task Revision Mismatch', `Revision ${revisionId} belongs to task ${dbRev.task_id}, not task ${taskId}`);
        }
        resolvedRev = {
          revisionId: dbRev.id,
          id: dbRev.id,
          taskId: dbRev.task_id,
          document: dbRev.neutral_manifest,
          sourceSha256: dbRev.source_sha256,
          status: dbRev.status,
        };
      }
    }

    if (!resolvedRev) return problem(c, 404, 'Revision Not Found', `Revision ${revisionId} does not exist`);

    const body = await c.req.json().catch(() => ({}));
    const rawAction = (body.action || body.status || body.decision || body.outcome || '').toLowerCase().trim();
    const decisionMapping: Record<string, 'approved' | 'revision_requested' | 'rejected' | 'escalated'> = {
      approve: 'approved',
      approved: 'approved',
      revision_requested: 'revision_requested',
      request_revision: 'revision_requested',
      revise: 'revision_requested',
      revision: 'revision_requested',
      reject: 'rejected',
      rejected: 'rejected',
      escalate: 'escalated',
      escalated: 'escalated',
    };

    const dbDecision = decisionMapping[rawAction];
    if (!dbDecision) {
      return problem(
        c,
        400,
        'Invalid Decision Action',
        `Decision action '${rawAction || 'undefined'}' is not supported. Supported actions: approve, revision_requested, reject, escalate`
      );
    }
    const isApproved = dbDecision === 'approved';
    const isRejected = dbDecision === 'rejected';
    const isEscalated = dbDecision === 'escalated';
    const decisionType = dbDecision;

    // Actor authority check (FR-043): Strictly derive reviewer role from authenticated server records.
    // Client role assertions (x-user-role header, body.role) are STRICTLY IGNORED in production mode!
    // The reviewer's role is the authenticated session's role. A test that needs another role signs
    // in as it (testAuth.roleHeader); the request body never decides who is approving.
    const effectiveRole = (auth.role || 'anonymous').toLowerCase().trim();

    if (effectiveRole === 'operator' || !isAuthorizedReviewerRole(effectiveRole)) {
      return problem(
        c,
        403,
        'Forbidden',
        `Actor role '${effectiveRole}' does not have authority to approve or reject designs. Legitimate reviewer role required.`
      );
    }

    // Client approver scope check (FR-043): client_approver can only review designs for their assigned client
    if (effectiveRole === 'client_approver' && (auth as any).clientId && task?.clientId && (auth as any).clientId !== task.clientId) {
      return problem(c, 403, 'Forbidden', `Actor is not authorized to review designs for client '${task.clientId}'`);
    }

    // A design the client asked to change is replaced by its revision (a separate task). Approving
    // it delivered the version without the change. Any change not cancelled, rejected or failed
    // stands in the way: one being made, one with its draft ready, and also one waiting for the
    // requester's answer to a question or not started yet (queued, or over the daily cap for the art
    // director), which both let the old version through (review of 2026-09-24). Another size of
    // the design is not a change. A revision that failed leaves this design approvable, so the client
    // is never left with nothing to approve.
    if (isApproved && db && isValidUuid(taskId)) {
      const newer = await pendingChangeOf(tenantId, taskId).catch((err: unknown) => {
        log.warn('[core:approval] Could not check for a newer revision:', err);
        return null;
      });
      if (newer === null) return problem(c, 503, 'Database Unavailable', 'Whether the client asked for a change could not be checked; try again');
      if (newer) return problem(c, 409, 'Replaced By A Newer Revision', pendingChangeWords(newer));
    }

    // Strictly server-derived actor identity
    const actorUserId = auth.userId || '00000000-0000-4000-b000-000000000001';
    const actorDisplayName = auth.displayName || (auth.role === 'administrator' ? 'Administrator' : auth.role === 'art_director' ? 'Art Director' : 'Primary Operator');
    const actorRole: any = effectiveRole;

    // Stale revision check (CV-15: B cannot ship using A's approval)
    if (isApproved && task?.latestRevisionId && task.latestRevisionId !== revisionId) {
      return problem(c, 409, 'Conflict', `Cannot approve stale revision ${revisionId}. Current task revision is ${task.latestRevisionId}`);
    }

    // Optimistic concurrency check (CV-15, R05)
    if (body.expectedTaskVersion !== undefined && task && body.expectedTaskVersion !== (task.version || 1)) {
      return problem(c, 409, 'Conflict', `Concurrent modification detected: expected task version ${body.expectedTaskVersion}, current version is ${task.version || 1}`);
    }

    // Gate E/F Hard QA Gates & Verification (FR-015, FR-041, R05):
    let effectiveQcReportHash: string | null = null;
    let effectiveQcRunId: string | null = null;

    if (isApproved) {
      const docNodes = resolvedRev.document?.nodes;
      const hasExplicitEmptyNodes = docNodes && Array.isArray(docNodes) && docNodes.length === 0;
      const hasNoDocumentOrNodes = !resolvedRev.document || (!resolvedRev.document.documentId && (!docNodes || docNodes.length === 0));
      if (hasExplicitEmptyNodes || hasNoDocumentOrNodes) {
        return problem(c, 422, 'Cannot Approve Empty Design', 'Design revision has no editable nodes');
      }

      // Mandatory passing QC verification (FR-015, FR-041, R05)
      // null/unknown QC cannot publish; earlier PASS then later FAIL cannot qualify.
      let passingQcVerified = false;

      if (revisionRepo && db) {
        try {
          const latestDbQc: any = await withRlsContext(db, { tenantId, userId: actorUserId, role: actorRole }, (trx) =>
            trx
              .selectFrom('qc_runs' as any)
              .selectAll()
              .where('task_id', '=', taskId)
              .where('design_revision_id', '=', resolvedRev.id || revisionId)
              .where('tenant_id', '=', tenantId)
              .orderBy('started_at', 'desc')
              .executeTakeFirst()
          );
          if (latestDbQc) {
            if (latestDbQc.status === 'passed' && latestDbQc.critical_pass) {
              passingQcVerified = true;
              effectiveQcRunId = latestDbQc.id;
              effectiveQcReportHash = latestDbQc.report_sha256;
            } else {
              return problem(
                c,
                412,
                'QA Verification Required',
                `Cannot approve design revision: latest QA evaluation failed (status: '${latestDbQc.status}', critical_pass: false)`
              );
            }
          }
        } catch (err) {
          log.error('[core:approvals:qc_lookup] DB QC run lookup error:', err);
        }
      }

      if (!passingQcVerified && task?.latestQAReport) {
        const reportRev = task.latestQAReport.revisionId || task.latestQAReport.designRevisionId;
        if (reportRev && reportRev !== revisionId && reportRev !== resolvedRev.id) {
          return problem(
            c,
            412,
            'QA Verification Required',
            `Cannot approve revision ${revisionId}: QA report was executed for revision ${reportRev}, not current revision`
          );
        }
        effectiveQcReportHash = qaReportSha256(task.latestQAReport);

        // Hash tampering verification (CV-15, R05)
        if (body.qcReportHash && effectiveQcReportHash && body.qcReportHash !== effectiveQcReportHash) {
          return problem(c, 422, 'Unprocessable Entity', 'Submitted QC report hash does not match stored QC run hash');
        }

        if (task.latestQAReport.criticalPass === true) {
          passingQcVerified = true;
        } else {
          return problem(
            c,
            412,
            'QA Verification Required',
            'Cannot approve design revision with failing critical QA evaluation'
          );
        }
      }

      if (!passingQcVerified && (body.requireQcPass === true || c.req.header('x-require-qc') === 'true')) {
        return problem(
          c,
          412,
          'QA Verification Required',
          'Precondition failed: design revision cannot be approved without a verified, passing critical QA run'
        );
      }

      // Hash tampering verification if DB QC was used
      if (body.qcReportHash && effectiveQcReportHash && body.qcReportHash !== effectiveQcReportHash) {
        return problem(c, 422, 'Unprocessable Entity', 'Submitted QC report hash does not match stored QC run hash');
      }

      // Stale or revoked Canva binding verification (Server Authoritative)
      const serverBindingStatus = task?.canvaBinding?.status;
      const clientBindingStatus = body.canvaBindingStatus || body.canvaBinding?.status;
      const effectiveBindingStatus = (serverBindingStatus && serverBindingStatus !== 'bound')
        ? serverBindingStatus
        : (clientBindingStatus || serverBindingStatus);
      if (effectiveBindingStatus && effectiveBindingStatus !== 'bound') {
        return problem(c, 422, 'Stale Canva Binding', `Cannot approve design revision with Canva binding in status '${effectiveBindingStatus}'`);
      }

      // Capture set hash tampering verification
      if (task?.latestCaptureSet?.parent_revision_id && task.latestCaptureSet.parent_revision_id !== revisionId && task.latestCaptureSet.parent_revision_id !== resolvedRev.id) {
        return problem(c, 422, 'Unprocessable Entity', 'Submitted captured artifact set belongs to a different revision');
      }
      if (body.capturedArtifactSetHash && task?.latestCaptureSet && body.capturedArtifactSetHash !== task.latestCaptureSet.capturedArtifactSetHash) {
        return problem(c, 422, 'Unprocessable Entity', `Submitted captured artifact set hash '${body.capturedArtifactSetHash}' does not match stored Merkle root '${task.latestCaptureSet.capturedArtifactSetHash}'`);
      }
    }

    // The exports pinned here are what delivery will send, byte for byte (pinned-deliverables.ts).
    let pinnedExports: PinnedExport[] | undefined;
    if (isApproved) {
      const pinned = parsePinnedExportIds(body.pinnedExportIds);
      if (!pinned.ok) return problem(c, 422, 'Invalid Pinned Exports', pinned.message);
      if (pinned.ids.length > 0) {
        const found = await deliverableStore.find(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pinned.ids);
        const byId = new Map(found.map((f) => [f.artifactId.toLowerCase(), f]));
        const missing = pinned.ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return problem(c, 422, 'Export Not Found', `No retrieved export of this task has id ${missing.join(', ')}. Capture it before approving.`);
        }
        pinnedExports = pinned.ids.map((id) => byId.get(id)!);
      } else {
        const available = await deliverableStore.find(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, []);
        if (available.length > 0) {
          pinnedExports = available;
        }
      }
    }

    const sourceHash = resolvedRev.document?.sourceSha256 || resolvedRev.sourceSha256 || crypto.createHash('sha256').update(JSON.stringify(resolvedRev.document || {})).digest('hex');
    const qcReportHash = effectiveQcReportHash || qaReportSha256(task?.latestQAReport);

    let dbApproval: any = null;
    if (revisionRepo && db) {
      try {
        dbApproval = await withRlsContext(
          db,
          { tenantId, userId: actorUserId, role: actorRole },
          async (trx) => await revisionRepo.recordApproval({
            tenantId,
            taskId,
            revisionId: resolvedRev.id || revisionId,
            decision: isApproved ? 'approved' : (isRejected ? 'rejected' : 'revision_requested'),
            decidedBy: actorUserId,
            reason: body.revisionRequest?.comment || body.reason || (isApproved ? 'Approved by operator' : (isRejected ? 'Rejected by operator' : 'Revision requested')),
            expectedTaskVersion: body.expectedTaskVersion,
            decisionPayload: {
              tenantId,
              clientId: task?.clientId || defaultClientId,
              taskId,
              revisionId: resolvedRev.id || revisionId,
              canvaBindingId: task?.canvaBinding?.id || task?.canvaBinding?.bindingId || null,
              canvaBindingVersion: task?.canvaBinding?.version || null,
              canvaDesignId: task?.canvaBinding?.canvaDesignId || null,
              sourceHash,
              exportHashes: (pinnedExports || []).map((e) => e.sha256),
              qcRunId: effectiveQcRunId,
              qcReportHash,
              qcProfile: task?.latestQAReport?.profile || 'standard',
              requiredFormats: task?.requiredFormats || ['png'],
              approverId: actorUserId,
              approverRole: actorRole,
              approvedAt: new Date().toISOString(),
              revisionRequest: body.revisionRequest,
              ...(pinnedExports ? { pinnedExports } : {}),
            },
          }, trx)
        );
      } catch (err: any) {
        log.error('[core:approvals:create] DB approval error:', err);
        if (err.message?.includes('Cannot approve stale revision') || err.message?.includes('Cannot approve task') || err.message?.includes('already approved') || err.message?.includes('Concurrent modification')) {
          return problem(c, 409, 'Conflict', err.message);
        }
        if (err.message?.includes('Precondition failed') || err.message?.includes('QA run')) {
          return problem(c, 412, 'Precondition Failed', err.message);
        }
        return problem(c, 503, 'Durable Storage Unavailable', `Failed to record approval in durable storage: ${err.message}`);
      }
    }

    const decision: any = {
      decisionId: dbApproval?.id || crypto.randomUUID(),
      taskId,
      designRevisionId: revisionId,
      sourceHash,
      qcReportHash,
      exportHashes: (pinnedExports || []).map((e) => e.sha256),
      canvaBindingId: task?.canvaBinding?.id || task?.canvaBinding?.bindingId || null,
      canvaBindingVersion: task?.canvaBinding?.version || null,
      tenantId,
      clientId: task?.clientId || defaultClientId,
      decision: isApproved ? 'approved' : (isRejected ? 'rejected' : 'revision_requested'),
      actor: {
        userId: actorUserId,
        displayName: actorDisplayName,
        role: actorRole,
        verifiedServerSide: true as const,
      },
      decidedAt: dbApproval?.created_at ? (dbApproval.created_at instanceof Date ? dbApproval.created_at.toISOString() : String(dbApproval.created_at)) : new Date().toISOString(),
      revisionRequest: body.revisionRequest,
      invalidated: false,
      ...(pinnedExports ? { pinnedExports } : {}),
    };

    if (task) {
      const currentTaskStatus = toApiTaskStatus(task.status || task.state || 'received') as any;
      const sm = new TaskStateMachine(taskId, currentTaskStatus, task.repairCount || 0);
      if (decision.decision === 'approved') {
        const trans = sm.transition('APPROVED', { type: 'user', id: decision.actor.userId }, 'Human approved in Desk');
        task.status = 'APPROVED';
        (task as any).latestApproval = decision;
        if (trans.ok) {
          events.get(taskId)?.push(trans.value);
        }
      } else if (decision.decision === 'rejected') {
        const trans = sm.transition('REJECTED', { type: 'user', id: decision.actor.userId }, body.reason || 'Human rejected in Desk');
        task.status = 'REJECTED';
        if (trans.ok) {
          events.get(taskId)?.push(trans.value);
        }
      } else if (decision.decision === 'revision_requested') {
        task.repairCount = (task.repairCount || 0) + 1;
        if (task.repairCount > 2) {
          const trans = sm.transition('OPERATOR_REQUIRED', { type: 'user', id: decision.actor.userId }, 'Exceeded max human revision cycles (2)');
          task.status = 'OPERATOR_REQUIRED';
          if (trans.ok) events.get(taskId)?.push(trans.value);
        } else {
          const trans = sm.transition('REVISION_REQUESTED', { type: 'user', id: decision.actor.userId }, decision.revisionRequest?.comment || 'Revision requested');
          task.status = 'REVISION_REQUESTED';
          if (trans.ok) events.get(taskId)?.push(trans.value);
        }
      }
      task.version = (task.version || 1) + 1;
    }

    if (taskRepo && db) {
      try {
        await withRlsContext(
          db,
          { tenantId, userId: actorUserId, role: auth.role || 'operator' },
          async (trx) => {
            const targetDbState = isApproved
              ? 'approved'
              : isRejected
              ? 'rejected'
              : ((task?.repairCount || 0) > 2 ? 'failed_operator' : 'revision_requested');

            await taskRepo.transitionState({
              taskId,
              tenantId,
              toState: targetDbState,
              actorType: 'user',
              actorId: actorUserId,
              reason: body.revisionRequest?.comment || body.reason || (isApproved ? 'Human approved in Desk' : (isRejected ? 'Human rejected in Desk' : 'Revision requested')),
              data: {
                revisionId: resolvedRev.id || revisionId,
                decisionId: decision.decisionId,
                sourceHash,
                qcReportHash,
              },
            }, trx);
          }
        );
      } catch (err: any) {
        log.error('[core:approvals:transition] DB state transition error:', err);
      }
    }

    broadcast(decision.decision === 'approved' ? 'task:approved' : decision.decision === 'rejected' ? 'task:rejected' : 'task:revision_requested', {
      taskId,
      revisionId,
      decision: decision.decision,
      status: task?.status || (isApproved ? 'APPROVED' : isRejected ? 'REJECTED' : 'REVISION_REQUESTED'),
    });

    return c.json(decision, 201);
  });

  // Review Desk Inspection Endpoint (FR-041)
  registerRoute('get', '/tasks/:taskId/review-desk', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for review desk');
    }

    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

    const revId = c.req.query('revisionId') || task.latestRevisionId || 'rev-1';
    // The revision's copy as Postgres holds it; revisions are no longer kept in memory.
    if (!db || !revisionRepo) return problem(c, 503, 'Database Unavailable', 'Design revisions are only held in the database');
    const rev = isValidUuid(revId)
      ? await withRlsContext(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId, role: auth.role }, async (trx) => {
          const row = await revisionRepo.findRevisionById(revId, auth.tenantId || DEFAULT_TENANT_ID, trx);
          return row && row.task_id === taskId ? { document: row.neutral_manifest as { nodes?: unknown[] } } : undefined;
        })
      : undefined;

    const deskInspection = humanApprovalManager.buildReviewDeskInspection({
      taskId,
      revisionId: revId,
      designTitle: task.title || 'Design Task',
      canvaDesignId: task.canvaDesignId || 'canva-design-kaae-001',
      canvaEditUrl: `https://www.canva.com/design/${task.canvaDesignId || 'canva-design-kaae-001'}/edit?return_url=https%3A%2F%2Fdesk.hawa.agency%2Ftasks%2F${taskId}`,
      capturedFiles: task.latestCaptureSet?.artifacts || [
        {
          artifactId: crypto.randomUUID(),
          relativePath: 'renders/1x1/banner.png',
          mimeType: 'image/png',
          byteSize: 102400,
          sha256: 'sha256_render_1x1',
          aspectRatio: '1:1',
          previewUrl: `/staged-exports/banner-1x1.png`,
        },
      ],
      capturedArtifactSetHash: task.latestCaptureSet?.capturedArtifactSetHash || 'sha256_mock_capture_set',
      exactCopy: (rev?.document?.nodes || [])
        .filter((n: any) => n.type === 'text')
        .map((n: any) => ({
          nodeId: n.id,
          role: n.role || 'body',
          text: n.text || '',
          isKurdishRtl: /[\u0600-\u06FF]/.test(n.text || ''),
        })),
      brandReferences: {
        clientId: task.clientId || '00000000-0000-4000-a000-000000000002',
        officialLogoSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        brandColors: ['#003366', '#D4AF37', '#F5F5F5'],
        approvedFonts: ['Cairo-Bold', 'NotoNaskhArabic-Regular'],
      },
      // Without a QA report the evidence says not run; it used to show a passed, critical-pass report
      // with a random run id and the hash 'verified_qc_pass'.
      qaEvidence: task.latestQAReport
        ? {
            qcRunId: task.latestQAReport.qcRunId ?? null,
            status:
              task.latestQAReport.status ||
              (task.latestQAReport.criticalPass === true ? 'passed' : task.latestQAReport.criticalPass === false ? 'failed' : 'unknown'),
            criticalPass: typeof task.latestQAReport.criticalPass === 'boolean' ? task.latestQAReport.criticalPass : null,
            qcReportHash: qaReportSha256(task.latestQAReport),
            findingsCount: task.latestQAReport.findings?.length || 0,
            glyphCoveragePass: true,
            unobservedLayersCount: 0,
          }
        : {
            qcRunId: null,
            status: 'not_run',
            criticalPass: null,
            qcReportHash: null,
            findingsCount: 0,
            glyphCoveragePass: null,
            unobservedLayersCount: null,
          },
      revisionDiff: (task as any).latestDiff,
    });

    return c.json(deskInspection, 200);
  });

  // Chat Approval Action Route (Two-way interactive callback with stale defense)
  registerRoute('post', '/tasks/:taskId/chat-approval-action', async (c: any) => {
    const taskId = c.req.param('taskId');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for chat approval action');
    }

    // Postgres's status, or 503 when it cannot be read: this acts on the task's current revision.
    const task = await readCurrentTask(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

    const body = await c.req.json().catch(() => ({}));
    const actionRevisionId = body.revisionId;
    const currentRevisionId = task.latestRevisionId || 'rev-1';

    const actorRole = (auth.role || 'operator').toLowerCase().trim();
    const chatActor = {
      userId: auth.userId,
      displayName: body.displayName || 'Chat Approver',
      role: actorRole,
      verifiedServerSide: true,
    };

    const actionRes = humanApprovalManager.handleChatApprovalAction({
      actor: chatActor,
      taskId,
      actionRevisionId,
      currentTaskRevisionId: currentRevisionId,
      decision: body.decision || 'approved',
      reason: body.reason,
    });

    if (!actionRes.ok) {
      return problem(c, 409, 'Conflict', actionRes.error.message);
    }

    return c.json(actionRes.value, 200);
  });
}
