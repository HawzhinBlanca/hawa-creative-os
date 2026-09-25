import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { isAuthorizedReviewerRole, parseCompleteRevisionRequest, parseOfficeApprovalProof, type OfficeApprovalProof, type PinnedExport } from '@hawa/domain';
import { withRlsContext, sql } from '@hawa/db';
import { HumanApprovalManager, signLifecycleOfficeEvent } from '@hawa/integrations';
import type { Context } from 'hono';
import type { AuthContext, RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID, DEFAULT_TENANT_ID } from '../core-context.js';
import { isValidUuid } from '../core-helpers.js';
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
    if (dbTask?.request_id) {
      // A signed-in Desk reviewer sends the first review decision through the public signed gateway.
      // The private RequestLifecycle object owns the state; Core never writes an owned decision here.
      const actionId = c.req.header('Idempotency-Key');
      if (!actionId || !isValidUuid(actionId)) return problem(c, 422, 'Action Key Required',
        'A request-owned office decision needs a UUID Idempotency-Key for safe retry');
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      const isOwnedApproval = body?.action === 'approve';
      const revisionRequest = isOwnedApproval ? null : parseCompleteRevisionRequest(body?.revisionRequest);
      const parsedPins = isOwnedApproval ? parsePinnedExportIds(body?.pinnedExportIds) : null;
      if (!body || Array.isArray(body) || !['revision_requested', 'approve'].includes(String(body.action)) ||
          (isOwnedApproval && (Object.keys(body).some((key) => !['action', 'reason', 'pinnedExportIds', 'rtlVisualReview'].includes(key)) ||
            typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000 || !parsedPins?.ok || parsedPins.ids.length === 0)) ||
          (!isOwnedApproval && (Object.keys(body).some((key) => key !== 'action' && key !== 'revisionRequest') || !revisionRequest))) {
        return problem(c, 422, 'Unsupported Lifecycle Decision',
          'Use a complete structured revision request, or approve with a reason and selected stored exports');
      }
      const pinIds = parsedPins?.ok ? parsedPins.ids : [];
      const officeRole = (auth.role || '').toLowerCase().trim();
      if (!['art_director', 'creative_director', 'office_admin', 'administrator'].includes(officeRole)) {
        return problem(c, 403, 'Forbidden', 'This lifecycle revision needs an authorized office reviewer');
      }
      const requestId = dbTask.request_id as string;
      const current = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, async (trx) =>
        trx.selectFrom('requests').select(['owner'])
          .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).executeTakeFirst());
      if (!current || current.owner !== 'restate') {
        return problem(c, 409, 'Lifecycle Owner Mismatch',
          'This task does not have an active request owner');
      }
      const deskRequestFingerprint = crypto.createHash('sha256')
        .update(JSON.stringify({ taskId, revisionId, actorUserId: auth.userId, body })).digest('hex');
      let approvalProof: OfficeApprovalProof | null = null;
      let eventRole = officeRole;
      let eventReason = isOwnedApproval ? (body.reason as string).trim() : revisionRequest!.comment;
      if (isOwnedApproval) {
        const prior = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, (trx) =>
          trx.selectFrom('approvals').selectAll().where('tenant_id', '=', tenantId)
            .where('task_id', '=', taskId).where('nonce', '=', `desk:${actionId}`).executeTakeFirst());
        if (prior) {
          const saved = prior.decision_payload as Record<string, unknown>;
          if (prior.decision !== 'approved' || prior.design_revision_id !== revisionId ||
              prior.decided_by !== auth.userId || saved.deskRequestFingerprint !== deskRequestFingerprint) {
            return problem(c, 409, 'Action Key Conflict', 'Idempotency-Key was already used for a different decision');
          }
          approvalProof = parseOfficeApprovalProof(saved.officeApprovalProof);
          if (!approvalProof || typeof saved.approverRole !== 'string' || typeof prior.reason !== 'string') {
            return problem(c, 503, 'Decision Receipt Incomplete', 'The committed decision lacks its replay proof; reconcile it before retrying');
          }
          eventRole = saved.approverRole;
          eventReason = prior.reason;
        } else {
          const rev = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, (trx) =>
            trx.selectFrom('design_revisions').select(['task_id', 'neutral_manifest'])
              .where('tenant_id', '=', tenantId).where('id', '=', revisionId).executeTakeFirst());
          const manifest = rev?.neutral_manifest as Record<string, unknown> | null;
          if (!rev || rev.task_id !== taskId || !Array.isArray(manifest?.nodes) || manifest.nodes.length === 0) {
            return problem(c, 422, 'Cannot Approve Empty Design', 'The current revision has no editable design nodes');
          }
          const latestQc = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, (trx) =>
            trx.selectFrom('qc_runs').selectAll().where('tenant_id', '=', tenantId)
              .where('task_id', '=', taskId).where('design_revision_id', '=', revisionId)
              .orderBy('started_at', 'desc').executeTakeFirst());
          if (!latestQc || latestQc.status !== 'passed' || !latestQc.critical_pass) {
            return problem(c, 412, 'QA Verification Required', 'The latest critical QA run must pass before approval');
          }
          let pins: PinnedExport[];
          try {
            const found = await deliverableStore.find(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pinIds);
            const byId = new Map(found.map((item) => [item.artifactId.toLowerCase(), item]));
            if (pinIds.some((id) => !byId.has(id))) {
              return problem(c, 422, 'Export Not Found', 'Every selected export must be stored for this task');
            }
            pins = pinIds.map((id) => byId.get(id)!);
            for (const pin of pins) {
              const bytes = await deliverableStore.read(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pin.artifactId);
              if (!bytes || bytes.length !== pin.byteSize ||
                  crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
                return problem(c, 422, 'Export Changed', 'A selected export no longer matches its stored bytes');
              }
            }
          } catch (error) {
            log.warn('[core:approval] Could not read stored exports for lifecycle approval:', error);
            return problem(c, 503, 'Export Store Unavailable', 'Selected export bytes could not be verified; retry the same action');
          }
          const report = latestQc.report as Record<string, unknown> | null;
          let rtlVisualReview: OfficeApprovalProof['rtlVisualReview'];
          if (report?.rtlVisualReviewRequired === true) {
            const visual = body.rtlVisualReview as Record<string, unknown> | undefined;
            if (visual?.confirmed !== true || visual.exportSha256 !== report.exportSha256 ||
                !pins.some((pin) => pin.format === 'png')) {
              return problem(c, 412, 'RTL Visual Review Required',
                'Inspect and select the final PNG, then confirm visual review of the checked export');
            }
            rtlVisualReview = { confirmed: true, exportSha256: String(visual.exportSha256) };
          } else if (body.rtlVisualReview !== undefined) {
            return problem(c, 422, 'Unexpected Visual Review', 'This QA run does not require an RTL visual sign-off');
          }
          approvalProof = parseOfficeApprovalProof({ qcRunId: latestQc.id,
            qcReportHash: latestQc.report_sha256, pinnedExports: pins,
            ...(rtlVisualReview ? { rtlVisualReview } : {}) });
          if (!approvalProof) return problem(c, 422, 'Invalid Approval Proof', 'Stored QA or export evidence is malformed');
        }
      }
      // Do not pre-reject rev 3 or a later draft: a response lost after the original commit must
      // still reach RequestLifecycle, whose stored event hash decides whether this is an exact replay.
      const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
      const secret = (process.env.HAWA_WORKER_TOKEN || '').trim();
      if (!ingress || !secret) return problem(c, 503, 'Lifecycle Decision Unavailable',
        'The decision gateway is not configured; retry this action later');
      const event = { v: 1 as const, eventId: `desk:${actionId}`, requestId, taskId, revisionId,
        actionId, expectedRev: 2 as const, kind: isOwnedApproval ? 'approve' as const : 'revise' as const,
        actor: { userId: auth.userId, role: eventRole }, reason: eventReason,
        ...(isOwnedApproval ? { approvalProof: approvalProof!, deskRequestFingerprint } : { revisionRequest: revisionRequest! }) };
      const signature = signLifecycleOfficeEvent(secret, event);
      try {
        const response = await fetch(`${ingress}/OfficeDecisionGateway/decide`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (response.ok && result?.accepted === true && result.requestId === requestId &&
            result.taskId === taskId && result.revisionId === revisionId && result.actionId === actionId &&
            isValidUuid(result.approvalId as string) && result.rev === 3 &&
            result.stage === (isOwnedApproval ? 'approved' : 'manual')) {
          return c.json({ decisionId: result.approvalId, taskId, designRevisionId: revisionId,
            decision: isOwnedApproval ? 'approved' : 'revision_requested',
            actor: { userId: auth.userId, role: eventRole, verifiedServerSide: true },
            requestId, requestRev: 3 }, 201);
        }
        if (response.ok && result?.accepted === false) return problem(c, 409, 'Stale Lifecycle Decision',
          'The request is no longer reviewing this draft; refresh the task');
        if (response.status === 400 || response.status === 409) return problem(c, 409, 'Lifecycle Action Conflict',
          'This action key or draft no longer matches; refresh the task');
        log.warn(`[core:approval] Lifecycle gateway HTTP ${response.status} for request ${requestId}`);
      } catch (error) {
        log.warn(`[core:approval] Lifecycle gateway did not answer for request ${requestId}:`, error);
      }
      return problem(c, 503, 'Lifecycle Decision Uncertain',
        'The decision may have committed. Retry with the same action key; no second decision will be created');
    }

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
          studio: dbRev.studio,
          status: dbRev.status,
        };
      }
    }

    if (!resolvedRev) return problem(c, 404, 'Revision Not Found', `Revision ${revisionId} does not exist`);

    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return problem(c, 400, 'Invalid Decision Body', 'Review decision must be a JSON object');
    }
    const actionId = c.req.header('Idempotency-Key');
    if (actionId && !isValidUuid(actionId)) {
      return problem(c, 422, 'Invalid Action Identifier', 'Idempotency-Key must be a UUID for a review decision');
    }
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
    const storedDecision = isApproved ? 'approved' : isRejected ? 'rejected' : 'revision_requested';

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
    const targetClientId = task?.clientId || dbTask?.client_id;
    if (effectiveRole === 'client_approver' && (!(auth as any).clientId || !targetClientId || (auth as any).clientId !== targetClientId)) {
      return problem(c, 403, 'Forbidden', `Actor is not authorized to review designs for client '${targetClientId || 'unresolved'}'`);
    }

    const actorUserId = auth.userId || '00000000-0000-4000-b000-000000000001';
    const nonce = actionId ? `desk:${actionId}` : undefined;
    const requestFingerprint = nonce
      ? crypto.createHash('sha256').update(JSON.stringify({ taskId, revisionId, actorUserId, body })).digest('hex')
      : undefined;
    const replay = (row: any) => {
      const saved = row.decision_payload && typeof row.decision_payload === 'object' ? row.decision_payload : {};
      return c.json({
        decisionId: row.id,
        taskId,
        designRevisionId: row.design_revision_id,
        decision: row.decision,
        sourceHash: saved.sourceHash ?? null,
        qcReportHash: saved.qcReportHash ?? null,
        exportHashes: saved.exportHashes ?? [],
        pinnedExports: saved.pinnedExports ?? [],
        actor: { userId: row.decided_by, role: saved.approverRole, verifiedServerSide: true },
        decidedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        replayed: true,
      }, 200);
    };
    if (nonce) {
      // The fast path handles a response lost after commit, even when the task has since advanced.
      // The repository repeats this check under the task lock for concurrent attempts.
      const prior = await withRlsContext(db, { tenantId, userId: actorUserId, role: auth.role },
        (trx) => trx.selectFrom('approvals').selectAll()
          .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).where('nonce', '=', nonce)
          .executeTakeFirst());
      if (prior) {
        const saved = prior.decision_payload as Record<string, unknown>;
        if (prior.design_revision_id !== revisionId || prior.decision !== storedDecision || prior.decided_by !== actorUserId
          || saved?.requestFingerprint !== requestFingerprint) {
          return problem(c, 409, 'Action Key Conflict', 'Idempotency-Key was already used for a different decision');
        }
        return replay(prior);
      }
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
    let rtlVisualReviewHash: string | null = null;
    let verifiedCanvaBinding: { id: string; version: number; canva_design_id: string; status: string } | null = null;

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
            effectiveQcRunId = latestDbQc.id;
            effectiveQcReportHash = latestDbQc.report_sha256;
            // Hash tampering verification (CV-15, R05): the hash a reviewer echoes is the stored run's.
            if (body.qcReportHash && body.qcReportHash !== effectiveQcReportHash) {
              return problem(c, 422, 'Unprocessable Entity', 'Submitted QC report hash does not match stored QC run hash');
            }
            if (latestDbQc.status === 'passed' && latestDbQc.critical_pass) {
              passingQcVerified = true;
              if (latestDbQc.report?.rtlVisualReviewRequired === true) {
                rtlVisualReviewHash = typeof latestDbQc.report.exportSha256 === 'string'
                  ? latestDbQc.report.exportSha256 : '';
              }
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

      // The QC evidence is the run Postgres holds (above). A QA report kept on this process's copy of
      // the task, or sent by the caller with a revision, was trusted here and lost at a restart.
      if (!passingQcVerified) {
        return problem(
          c,
          412,
          'QA Verification Required',
          'Precondition failed: design revision cannot be approved without a verified, passing critical QA run'
        );
      }

      // The task reader does not include the binding. The old payload therefore recorded null IDs
      // even though the approval repository checked a real Canva binding under its task lock.
      // Read the server row here; a caller-supplied binding status cannot certify this evidence.
      if (db && resolvedRev.studio === 'canva') {
        try {
          verifiedCanvaBinding = await withRlsContext(db, { tenantId, userId: actorUserId, role: actorRole }, async trx =>
            (await sql<{ id: string; version: number; canva_design_id: string; status: string }>`
              SELECT id, version, canva_design_id, status FROM hawa.canva_bindings
              WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid`.execute(trx)).rows[0] ?? null);
        } catch (err) {
          log.error('[core:approvals:binding_lookup] DB binding lookup error:', err);
          return problem(c, 503, 'Database Unavailable', 'Canva binding could not be verified before approval');
        }
        if ((verifiedCanvaBinding && verifiedCanvaBinding.status !== 'bound') ||
            (!verifiedCanvaBinding && deliverableStore.captureEvidenceRequired === true)) {
          return problem(c, 422, 'Stale Canva Binding', 'Capture the current bound Canva design before approval');
        }
      } else if (!db && task?.canvaBinding?.status && task.canvaBinding.status !== 'bound') {
        return problem(c, 422, 'Stale Canva Binding', 'Capture the current bound Canva design before approval');
      }

      // What an approval ships is the exports pinned below, checked against the store. A capture set
      // sent with a revision was kept only on this process's copy of the task, and checked from there.
    }

    // The exports pinned here are what delivery will send, byte for byte (pinned-deliverables.ts).
    let pinnedExports: PinnedExport[] | undefined;
    if (isApproved) {
      const pinned = parsePinnedExportIds(body.pinnedExportIds);
      if (!pinned.ok) return problem(c, 422, 'Invalid Pinned Exports', pinned.message);
      if (pinned.ids.length === 0) {
        return problem(c, 422, 'Export Selection Required', 'Select at least one stored final export before approving this revision.');
      }
      const found = await deliverableStore.find(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pinned.ids);
      const byId = new Map(found.map((f) => [f.artifactId.toLowerCase(), f]));
      const missing = pinned.ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return problem(c, 422, 'Export Not Found', `No retrieved export of this task has id ${missing.join(', ')}. Capture it before approving.`);
      }
      pinnedExports = pinned.ids.map((id) => byId.get(id)!);
      for (const pin of pinnedExports) {
        const bytes = await deliverableStore.read(tenantId, SYSTEM_AUTOMATION_USER_ID, taskId, pin.artifactId);
        if (!bytes || bytes.length !== pin.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
          return problem(c, 422, 'Export Changed', `The stored export ${pin.artifactId} does not match its recorded bytes. Capture it again before approval.`);
        }
      }
      if (rtlVisualReviewHash !== null) {
        if (!rtlVisualReviewHash || !pinnedExports.some((pin) => pin.format === 'png') ||
            body.rtlVisualReview?.confirmed !== true ||
            body.rtlVisualReview?.exportSha256 !== rtlVisualReviewHash) {
          return problem(c, 412, 'RTL Visual Review Required',
            'Inspect a selected final PNG for Kurdish/Arabic reading direction and glyphs, then confirm visual review of the checked export.');
        }
      }
    }

    const sourceHash = resolvedRev.document?.sourceSha256 || resolvedRev.sourceSha256 || crypto.createHash('sha256').update(JSON.stringify(resolvedRev.document || {})).digest('hex');
    const qcReportHash = effectiveQcReportHash;

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
            decision: storedDecision,
            decidedBy: actorUserId,
            reason: body.revisionRequest?.comment || body.reason || (isApproved ? 'Approved by operator' : (isRejected ? 'Rejected by operator' : 'Revision requested')),
            expectedTaskVersion: body.expectedTaskVersion,
            nonce,
            decisionPayload: {
              tenantId,
              clientId: task?.clientId || defaultClientId,
              taskId,
              revisionId: resolvedRev.id || revisionId,
              canvaBindingId: verifiedCanvaBinding?.id || task?.canvaBinding?.id || task?.canvaBinding?.bindingId || null,
              canvaBindingVersion: verifiedCanvaBinding?.version || task?.canvaBinding?.version || null,
              canvaDesignId: verifiedCanvaBinding?.canva_design_id || task?.canvaBinding?.canvaDesignId || null,
              sourceHash,
              exportHashes: (pinnedExports || []).map((e) => e.sha256),
              captureEvidenceRequired: deliverableStore.captureEvidenceRequired === true,
              qcRunId: effectiveQcRunId,
              qcReportHash,
              qcProfile: task?.latestQAReport?.profile || 'standard',
              requiredFormats: task?.requiredFormats || ['png'],
              approverId: actorUserId,
              approverRole: actorRole,
              ...(requestFingerprint ? { requestFingerprint } : {}),
              approvedAt: new Date().toISOString(),
              ...(rtlVisualReviewHash !== null ? { rtlVisualReview: {
                confirmed: true, reviewerId: actorUserId, qcRunId: effectiveQcRunId,
                exportSha256: rtlVisualReviewHash, confirmedAt: new Date().toISOString(),
              } } : {}),
              revisionRequest: body.revisionRequest,
              ...(pinnedExports ? { pinnedExports } : {}),
            },
          }, trx)
        );
      } catch (err: any) {
        log.error('[core:approvals:create] DB approval error:', err);
        if (err.message?.includes('Cannot approve stale revision') || err.message?.includes('Cannot approve task') || err.message?.includes('already approved') || err.message?.includes('Concurrent modification') || err.message?.includes('Idempotency key')) {
          return problem(c, 409, 'Conflict', err.message);
        }
        if (err.message?.includes('Canva approval') || err.message?.includes('Canva QA')) {
          return problem(c, 422, 'Capture Does Not Match Review', err.message);
        }
        if (err.message?.includes('Precondition failed') || err.message?.includes('QA run')) {
          return problem(c, 412, 'Precondition Failed', err.message);
        }
        return problem(c, 503, 'Durable Storage Unavailable', `Failed to record approval in durable storage: ${err.message}`);
      }
    }

    if (dbApproval?.replayed) return replay(dbApproval);

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

    // The repair budget: a task sent back for changes more than twice goes to an operator. The count
    // is the revision requests Postgres records before this one (services/task-reader.ts); it was
    // kept on this process's copy of the task and started again from zero after a restart.
    if (task) {
      if (decision.decision === 'approved') task.status = 'APPROVED';
      else if (decision.decision === 'rejected') task.status = 'REJECTED';
      else if (decision.decision === 'revision_requested') {
        task.repairCount = (task.repairCount || 0) + 1;
        task.status = task.repairCount > 2 ? 'OPERATOR_REQUIRED' : 'REVISION_REQUESTED';
      }
    }

    // recordApproval commits the approval, task state/version, revision status and immutable event in
    // one transaction. A second transition here used to advance the version twice and append a
    // duplicate state event; its failure was then silently swallowed after returning success.

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

    const requestedRevisionId = c.req.query('revisionId');
    if (requestedRevisionId && !isValidUuid(requestedRevisionId)) {
      return problem(c, 422, 'Invalid Revision Identifier', 'Use a recorded revision ID');
    }
    const revId = requestedRevisionId || task.latestRevisionId || null;
    // The revision's copy as Postgres holds it; revisions are no longer kept in memory.
    if (!db || !revisionRepo) return problem(c, 503, 'Database Unavailable', 'Design revisions are only held in the database');
    const rev = revId && isValidUuid(revId)
      ? await withRlsContext(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId, role: auth.role }, async (trx) => {
          const row = await revisionRepo.findRevisionById(revId, auth.tenantId || DEFAULT_TENANT_ID, trx);
          return row && row.task_id === taskId ? { document: row.neutral_manifest as { nodes?: unknown[] } } : undefined;
        })
      : undefined;
    if (revId && !rev) return problem(c, 404, 'Revision Not Found', 'This task has no such recorded revision');
    // The QA evidence is the revision's newest QC run as Postgres holds it, with the hash it stored.
    // It was the report kept on this process's copy of the task: another Core showed "not run".
    const qcRun = revId && isValidUuid(revId) && isValidUuid(taskId)
      ? await withRlsContext(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId, role: auth.role }, async (trx) =>
          (await sql<{ id: string; status: string; critical_pass: boolean | null; report: { findings?: unknown[]; glyphCoveragePass?: unknown; unobservedLayersCount?: unknown } | null; report_sha256: string | null }>`
            SELECT id, status, critical_pass, report, report_sha256 FROM hawa.qc_runs
            WHERE tenant_id = ${auth.tenantId || DEFAULT_TENANT_ID}::uuid AND task_id = ${taskId}::uuid AND design_revision_id = ${revId}::uuid
            ORDER BY started_at DESC LIMIT 1`.execute(trx)).rows[0])
      : undefined;

    const binding = isValidUuid(taskId)
      ? await withRlsContext(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId, role: auth.role }, async (trx) =>
          (await sql<{ canva_design_id: string; edit_url: string | null }>`SELECT canva_design_id, edit_url FROM hawa.canva_bindings
            WHERE tenant_id = ${auth.tenantId || DEFAULT_TENANT_ID}::uuid AND task_id = ${taskId}::uuid AND status = 'bound'
            ORDER BY updated_at DESC LIMIT 1`.execute(trx)).rows[0])
      : undefined;
    const canvaDesignId = typeof binding?.canva_design_id === 'string' && binding.canva_design_id.trim()
      ? binding.canva_design_id.trim() : null;
    let canvaEditUrl: string | null = null;
    if (canvaDesignId && binding?.edit_url) {
      try {
        const recorded = new URL(binding.edit_url);
        if (recorded.origin === 'https://www.canva.com' && (recorded.pathname.startsWith('/design/') || recorded.pathname.startsWith('/d/'))) {
          canvaEditUrl = recorded.toString();
        }
      } catch { /* An invalid stored link is missing evidence, not a link to invent. */ }
    }
    // Capture rows have source hashes but not the pinned export IDs/preview URLs this inspection
    // contract needs. Show their existence and count, while withholding a fake reviewable file.
    const capture = isValidUuid(taskId) && revId && isValidUuid(revId)
      ? await withRlsContext(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId, role: auth.role }, async (trx) =>
          (await sql<{ captured_artifact_set_hash: string; artifacts: unknown }>`
            SELECT captured_artifact_set_hash, artifacts FROM hawa.canva_capture_sets
            WHERE tenant_id = ${auth.tenantId || DEFAULT_TENANT_ID}::uuid AND task_id = ${taskId}::uuid
              AND parent_revision_id = ${revId}::uuid
            ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0])
      : undefined;
    let capturedArtifacts: unknown = capture?.artifacts;
    if (typeof capturedArtifacts === 'string') {
      try { capturedArtifacts = JSON.parse(capturedArtifacts); }
      catch { capturedArtifacts = null; }
    }
    const captureArtifactCount = Array.isArray(capturedArtifacts) ? capturedArtifacts.length : 0;
    const hasCaptureRecord = Boolean(capture && /^[0-9a-f]{64}$/i.test(capture.captured_artifact_set_hash) &&
      captureArtifactCount > 0);
    const deskInspection = humanApprovalManager.buildReviewDeskInspection({
      taskId,
      revisionId: revId,
      designTitle: task.title || 'Design Task',
      canvaStatus: canvaDesignId ? 'recorded' : 'not_configured',
      canvaDesignId,
      canvaEditUrl,
      captureStatus: hasCaptureRecord ? 'recorded_metadata_only' : 'not_captured',
      captureArtifactCount: hasCaptureRecord ? captureArtifactCount : 0,
      capturedFiles: [],
      capturedArtifactSetHash: hasCaptureRecord ? capture!.captured_artifact_set_hash : null,
      exactCopy: (rev?.document?.nodes || [])
        .filter((n: any) => n.type === 'text')
        .map((n: any) => ({
          nodeId: n.id,
          role: n.role || 'body',
          text: n.text || '',
          isKurdishRtl: /[\u0600-\u06FF]/.test(n.text || ''),
        })),
      brandReferences: {
        // This endpoint has no revision-bound, approved BrandKit record to read yet. The client ID
        // identifies scope; it is not evidence for an official logo, palette or font approval.
        status: 'not_configured',
        clientId: task.clientId || null,
        officialLogoSha256: null,
        brandColors: [],
        approvedFonts: [],
      },
      // Without a QA report the evidence says not run; it used to show a passed, critical-pass report
      // with a random run id and the hash 'verified_qc_pass'.
      qaEvidence: qcRun
        ? {
            qcRunId: qcRun.id,
            status: qcRun.status === 'passed' || qcRun.status === 'failed' || qcRun.status === 'blocked' ? qcRun.status : 'unknown',
            criticalPass: typeof qcRun.critical_pass === 'boolean' ? qcRun.critical_pass : null,
            qcReportHash: qcRun.report_sha256,
            findingsCount: Array.isArray(qcRun.report?.findings) ? qcRun.report.findings.length : 0,
            glyphCoveragePass: typeof qcRun.report?.glyphCoveragePass === 'boolean' ? qcRun.report.glyphCoveragePass : null,
            unobservedLayersCount: Number.isSafeInteger(qcRun.report?.unobservedLayersCount) && Number(qcRun.report?.unobservedLayersCount) >= 0
              ? Number(qcRun.report?.unobservedLayersCount) : null,
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
      revisionDiff: revId ? (task as any).latestDiff : undefined,
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
    const currentRevisionId = task.latestRevisionId;
    if (!currentRevisionId || !isValidUuid(currentRevisionId)) {
      return problem(c, 412, 'Recorded Revision Required', 'Chat review requires a recorded revision before any action can be accepted');
    }
    if (!isValidUuid(actionRevisionId)) {
      return problem(c, 422, 'Invalid Revision Identifier', 'Chat action must name a recorded revision ID');
    }

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

    // This check does not write a decision to PostgreSQL or signal the durable review workflow.
    // Do not acknowledge it as an approval until the chat action is connected to that transaction.
    return problem(c, 501, 'Chat Decision Unavailable',
      'Chat action was validated but approval was not recorded; use the Desk decision endpoint');
  });
}
