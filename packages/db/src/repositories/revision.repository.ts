import { Kysely, sql } from 'kysely';
import crypto from 'node:crypto';
import type { Database } from '../types.js';
import { currentTraceId } from '../trace-context.js';
import { FeedbackRepository } from './feedback.repository.js';

export interface CreateRevisionParams {
  id?: string;
  tenantId: string;
  taskId: string;
  revisionNumber?: number;
  studio?: string;
  studioVersion?: string;
  studioSchemaVersion?: string;
  sourceStorageKey?: string;
  sourceSha256?: string;
  neutralManifest: Record<string, unknown>;
  authorType?: 'user' | 'model' | 'workflow' | 'import';
  authorId?: string | null;
  status?: 'draft' | 'review' | 'approved' | 'rejected' | 'superseded';
  previewSha256?: string | null;
  correlationId?: string;
}

export interface RecordApprovalParams {
  tenantId: string;
  taskId: string;
  revisionId: string;
  decision: 'approved' | 'revision_requested' | 'rejected' | 'escalated';
  decidedBy: string;
  reason?: string | null;
  decisionPayload?: Record<string, unknown>;
  nonce?: string;
  correlationId?: string;
  expectedTaskVersion?: number;
  /** An approval from a signed lifecycle action must use the QA the reviewer actually saw. */
  expectedQcRunId?: string;
  expectedQcReportHash?: string;
  /** Internal RequestLifecycle projection only; ordinary Desk decisions must leave this unset. */
  lifecycleRequestId?: string;
  /** Optional caller-supplied authority check executed under the task lock before a new decision. */
  authorizeDecision?: (trx: Kysely<Database>, scope: { clientId: string | null; projectId: string | null }) => Promise<Record<string, unknown>>;
}

/** Why a task in this state cannot be approved, or undefined when it can (received, human_review, …). */
export function unapprovableTaskReason(taskId: string, revisionId: string, state: string): string | undefined {
  switch (state) {
    // Changes were asked for on this revision (in the Desk, or by the requester in Telegram). No newer
    // revision need exist: the message said "replaced by a newer revision", which after a Desk
    // request sent the art director looking for one that was never made (2026-09-24). A capture of
    // the changed design is not a revision; it must be recorded as one, with its own QC, first.
    case 'revision_requested':
      return `Cannot approve task ${taskId}: changes were requested on revision ${revisionId}, so it can no longer be approved; approve the revision made with the changes once it is recorded`;
    case 'publishing':
      return `Task ${taskId} is already approved and being delivered; it cannot be approved again`;
    case 'complete':
      return `Task ${taskId} is already approved and delivered; it cannot be approved again`;
    case 'cancelled':
    case 'rejected':
      return `Cannot approve task ${taskId}: it was ${state}`;
    default:
      return undefined;
  }
}

export class RevisionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  private computeSha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async findRevisionById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db).selectFrom('design_revisions').selectAll().where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async listRevisionsForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_revisions')
      .selectAll()
      .where('task_id', '=', taskId);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.orderBy('revision', 'asc').execute();
  }

  async createRevision(params: CreateRevisionParams, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      // 1. Verify task exists
      const task = await dbClient
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();

      if (!task) {
        throw new Error(`Task ${params.taskId} not found for tenant ${params.tenantId}`);
      }

      // 2. Ensure design_document exists for (task_id, 'primary')
      let doc = await dbClient
        .selectFrom('design_documents')
        .selectAll()
        .where('task_id', '=', params.taskId)
        .where('direction_name', '=', 'primary')
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();

      if (!doc) {
        doc = await dbClient
          .insertInto('design_documents')
          .values({
            tenant_id: params.tenantId,
            task_id: params.taskId,
            direction_name: 'primary',
            studio: params.studio || 'canva',
            studio_document_id: crypto.randomUUID(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      // 3. Determine revision number
      let nextRevisionNumber = params.revisionNumber;
      if (!nextRevisionNumber) {
        const latestRev = await dbClient
          .selectFrom('design_revisions')
          .select('revision')
          .where('design_document_id', '=', doc.id)
          .where('tenant_id', '=', params.tenantId)
          .orderBy('revision', 'desc')
          .limit(1)
          .executeTakeFirst();
        nextRevisionNumber = latestRev ? latestRev.revision + 1 : 1;
      }

      const manifestStr = JSON.stringify(params.neutralManifest);
      const manifestSha256 = this.computeSha256(manifestStr);
      const sourceSha = params.sourceSha256 || manifestSha256;
      const semanticHash = this.computeSha256(
        JSON.stringify({
          nodes: (params.neutralManifest as any)?.nodes || [],
          revision: nextRevisionNumber,
        })
      );

      // 4. Insert design revision
      const revision = await dbClient
        .insertInto('design_revisions')
        .values({
          ...(params.id ? { id: params.id } : {}),
          tenant_id: params.tenantId,
          task_id: params.taskId,
          design_document_id: doc.id,
          revision: nextRevisionNumber,
          studio: params.studio || 'canva',
          studio_version: params.studioVersion || '1.0.0',
          studio_schema_version: params.studioSchemaVersion || '1.0.0',
          source_storage_key: params.sourceStorageKey || `tasks/${params.taskId}/revisions/${nextRevisionNumber}.json`,
          source_sha256: sourceSha,
          neutral_manifest: params.neutralManifest,
          neutral_manifest_sha256: manifestSha256,
          semantic_hash: semanticHash,
          preview_sha256: params.previewSha256 || null,
          author_type: params.authorType || 'user',
          author_id: params.authorId || null,
          status: params.status || 'review',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Invalidate downstream permission on edits (FR-043, R05)
      // hawa.approvals is append-only by trigger forbid_update_delete();
      // invalidation of prior approval must be recorded by appending to task_events rather than mutating approvals.
      const priorApproval = await dbClient
        .selectFrom('approvals')
        .select(['id', 'design_revision_id'])
        .where('task_id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .where('decision', '=', 'approved')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

      // 5. Update task with current_design_revision_id, reset state to in_review, and advance its
      // version past every event appended below. Each event takes its own aggregate version: the
      // invalidation and the new revision used to share one, which the unique key (task_id,
      // aggregate_version) refused, so no revision could follow an approval (2026-09-24).
      const invalidationVersion = Number(task.version) + 1;
      const nextTaskVersion = Number(task.version) + (priorApproval ? 2 : 1);
      await dbClient
        .updateTable('tasks')
        .set({
          current_design_revision_id: revision.id,
          state: 'human_review',
          version: nextTaskVersion,
          updated_at: new Date(),
        })
        .where('id', '=', task.id)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      if (priorApproval) {
        await dbClient
          .insertInto('task_events')
          .values({
            tenant_id: params.tenantId,
            task_id: params.taskId,
            event_type: 'approval.invalidated',
            schema_version: 1,
            aggregate_version: invalidationVersion,
            actor_type: params.authorType === 'workflow' ? 'workflow' : 'user',
            actor_id: params.authorId || null,
            correlation_id: params.correlationId || crypto.randomUUID(),
            causation_id: null,
            trace_id: currentTraceId(),
            data: {
              invalidatedApprovalId: priorApproval.id,
              priorRevisionId: priorApproval.design_revision_id,
              newRevisionId: revision.id,
              reason: 'New design revision created',
            },
          })
          .execute();
      }

      // 6. Append task event
      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: 'design.revision_created',
          schema_version: 1,
          aggregate_version: nextTaskVersion,
          actor_type: params.authorType === 'workflow' ? 'workflow' : 'user',
          actor_id: params.authorId || null,
          correlation_id: params.correlationId || crypto.randomUUID(),
          causation_id: null,
          trace_id: currentTraceId(),
          data: {
            revisionId: revision.id,
            revisionNumber: revision.revision,
            sourceSha256: revision.source_sha256,
            semanticHash: revision.semantic_hash,
          },
        })
        .execute();

      return revision;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }

  async recordApproval(params: RecordApprovalParams, trx?: Kysely<Database>) {
    const runner = async (dbClient: Kysely<Database>) => {
      // 1. Verify revision exists and belongs to task and tenant
      const revision = await dbClient
        .selectFrom('design_revisions')
        .selectAll()
        .where('id', '=', params.revisionId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();

      if (!revision) {
        throw new Error(`Revision ${params.revisionId} not found for tenant ${params.tenantId}`);
      }

      if (revision.task_id !== params.taskId) {
        throw new Error(
          `Revision ${params.revisionId} belongs to task ${revision.task_id}, not task ${params.taskId}`
        );
      }

      const task = await dbClient
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .forUpdate()
        .executeTakeFirst();

      if (!task) {
        throw new Error(`Task ${params.taskId} not found`);
      }
      // RequestLifecycle owns this task's decisions. Check under the task lock so a direct
      // repository caller cannot append a legacy approval or replay one after ownership is pinned.
      if (task.request_id && task.request_id !== params.lifecycleRequestId) {
        throw new Error('LIFECYCLE_OWNED: Review this task through RequestLifecycle');
      }
      if (!task.request_id && params.lifecycleRequestId) {
        throw new Error('LIFECYCLE_OWNER_MISMATCH: This task has no matching request owner');
      }

      // A retry may arrive after the first decision committed but before the Desk got its answer.
      // Check under the task lock: concurrent attempts with the same action key then serialize here.
      if (params.nonce) {
        const fingerprint = params.decisionPayload?.requestFingerprint;
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
          throw new Error('A keyed approval requires a request fingerprint');
        }
        const prior = await dbClient.selectFrom('approvals').selectAll()
          .where('tenant_id', '=', params.tenantId)
          .where('task_id', '=', params.taskId)
          .where('nonce', '=', params.nonce)
          .executeTakeFirst();
        if (prior) {
          const priorFingerprint = (prior.decision_payload as Record<string, unknown>)?.requestFingerprint;
          if (prior.design_revision_id !== params.revisionId || prior.decision !== params.decision
            || prior.decided_by !== params.decidedBy || priorFingerprint !== fingerprint) {
            throw new Error('Idempotency key was already used for a different decision');
          }
          return { ...prior, replayed: true as const };
        }
      }

      // Scope can change after the HTTP handler looked at the task. A named reviewer's current
      // session and assignment must be checked on the locked task row in this transaction.
      const authorityPayload = params.authorizeDecision
        ? await params.authorizeDecision(dbClient, { clientId: task.client_id, projectId: task.project_id })
        : {};

      // Optimistic concurrency fencing (CV-15, R05)
      if (params.expectedTaskVersion !== undefined && Number(task.version) !== Number(params.expectedTaskVersion)) {
        throw new Error(
          `Concurrent modification detected: expected task version ${params.expectedTaskVersion}, current version is ${task.version}`
        );
      }

      // Check for stale revision approval
      if (task.current_design_revision_id && task.current_design_revision_id !== params.revisionId) {
        throw new Error(
          `Cannot approve stale revision ${params.revisionId}. Current revision is ${task.current_design_revision_id}`
        );
      }

      // Prevent duplicate approval if already approved
      if (task.state === 'approved' && params.decision === 'approved') {
        throw new Error(`Task ${params.taskId} is already approved on revision ${params.revisionId}`);
      }

      // A task a Telegram change replaced, or one already past approval, is not approved again: the
      // Desk still listed it, and approving it would deliver the design the office had asked to
      // change (2026-09-23). The first three messages keep the phrases Core maps to 409 Conflict.
      if (params.decision === 'approved') {
        const refusal = unapprovableTaskReason(params.taskId, params.revisionId, task.state);
        if (refusal) throw new Error(refusal);
      }

      // 2. Approval requires a real passing QA run; other decisions may honestly have no run.
      // Earlier PASS then later FAIL cannot qualify: order by created_at desc to inspect the latest run
      let qcRun = await dbClient
        .selectFrom('qc_runs')
        .selectAll()
        .where('task_id', '=', params.taskId)
        .where('design_revision_id', '=', params.revisionId)
        .where('tenant_id', '=', params.tenantId)
        .orderBy('started_at', 'desc')
        .executeTakeFirst();
      let approvedCanvaBinding: { id: string; canva_design_id: string; version: number } | null = null;

      if (params.decision === 'approved') {
        if (!qcRun || qcRun.status !== 'passed' || !qcRun.critical_pass) {
          throw new Error(
            `Precondition failed: Revision ${params.revisionId} cannot be approved without a verified, passing critical QA run`
          );
        }
        if (params.lifecycleRequestId && (!params.expectedQcRunId || !params.expectedQcReportHash)) {
          throw new Error('Request-owned approval requires the exact QA run and report hash');
        }
        if ((params.expectedQcRunId && qcRun.id !== params.expectedQcRunId) ||
            (params.expectedQcReportHash && qcRun.report_sha256 !== params.expectedQcReportHash)) {
          throw new Error('QA evidence changed after the reviewer inspected this revision');
        }
        const report = qcRun.report as Record<string, unknown> | null;
        if (report?.rtlVisualReviewRequired === true) {
          const visual = params.decisionPayload?.rtlVisualReview as Record<string, unknown> | undefined;
          const pins = params.decisionPayload?.pinnedExports;
          if (visual?.confirmed !== true || visual.qcRunId !== qcRun.id ||
              visual.exportSha256 !== report.exportSha256 ||
              !Array.isArray(pins) || !pins.some((pin) =>
                pin && typeof pin === 'object' && pin.format === 'png')) {
            throw new Error('RTL visual review of the checked export is required before approval');
          }
        }
        if (revision.studio === 'canva' && (report?.exportArtifactId || params.decisionPayload?.captureEvidenceRequired === true)) {
          // The approval and its evidence are checked while the task row is locked. A pin from an
          // older export of this same design and binding is not evidence for the latest QC run.
          const checkedId = report?.exportArtifactId;
          const checkedHash = report?.exportSha256;
          const captureVersion = report?.captureVersion;
          const pins = params.decisionPayload?.pinnedExports;
          if (typeof checkedId !== 'string' || typeof checkedHash !== 'string'
            || (typeof captureVersion !== 'string' && typeof captureVersion !== 'number')
            || String(captureVersion).trim() === ''
            || !Array.isArray(pins) || pins.length === 0) {
            throw new Error('Canva approval requires a QC-linked capture and explicit stored exports');
          }
          const pinned = pins as Array<{ artifactId?: unknown; sha256?: unknown; byteSize?: unknown }>;
          const ids = pinned.map((pin) => pin.artifactId);
          if (ids.some((id) => typeof id !== 'string') || !ids.includes(checkedId)) {
            throw new Error('Canva approval pins must include the export checked by the latest QA run');
          }
          const rows = (await sql<{
            id: string; sha256: string; byte_size: number; format: string;
            design_id: string; binding_version: number; capture_version: string | null;
          }>`SELECT b.id, b.sha256, octet_length(b.content) AS byte_size, b.format,
                o.design_id, o.binding_version, o.metadata->>'designUpdatedAt' AS capture_version
              FROM hawa.canva_export_bytes b
              JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
              WHERE b.tenant_id = ${params.tenantId}::uuid AND b.task_id = ${params.taskId}::uuid
                AND b.id = ANY(${ids}::uuid[])`.execute(dbClient)).rows;
          const byId = new Map(rows.map((row) => [row.id, row]));
          const checked = byId.get(checkedId);
          if (!checked || checked.format !== 'pptx' || checked.sha256 !== checkedHash
            || checked.capture_version !== String(captureVersion)
            || (revision.source_sha256 && revision.source_sha256 !== checkedHash && Number(qcRun.attempt) === 1)) {
            throw new Error('Canva QA evidence does not match the checked export of this revision');
          }
          const binding = (await sql<{ id: string; canva_design_id: string; version: number }>`SELECT id, canva_design_id, version FROM hawa.canva_bindings
            WHERE tenant_id = ${params.tenantId}::uuid AND task_id = ${params.taskId}::uuid AND status = 'bound'`.execute(dbClient)).rows[0];
          if (!binding || pinned.some((pin) => {
            const row = byId.get(String(pin.artifactId));
            return !row || row.sha256 !== pin.sha256 || Number(row.byte_size) !== Number(pin.byteSize)
              || row.design_id !== binding.canva_design_id || Number(row.binding_version) !== Number(binding.version)
              || row.capture_version !== String(captureVersion);
          })) {
            throw new Error('Canva approval pins contain an export from another capture or revision');
          }
          const policyCurrent=(await sql<{current:boolean}>`SELECT hawa.canva_export_policy_current(o.tenant_id,o.client_id,o.metadata) AS current
            FROM hawa.canva_remote_operations o JOIN hawa.canva_export_bytes b ON b.operation_id=o.id AND b.tenant_id=o.tenant_id
            WHERE b.id=${checkedId}::uuid AND b.tenant_id=${params.tenantId}::uuid`.execute(dbClient)).rows[0];
          if (!policyCurrent?.current) throw new Error('Precondition failed: Client font policy changed; capture and review the design again before approval');
          approvedCanvaBinding = binding;
        }
      }

      // 3. Ensure review_request exists
      let reviewReq = await dbClient
        .selectFrom('review_requests')
        .selectAll()
        .where('task_id', '=', params.taskId)
        .where('design_revision_id', '=', params.revisionId)
        .where('tenant_id', '=', params.tenantId)
        .executeTakeFirst();

      if (!reviewReq) {
        reviewReq = await dbClient
          .insertInto('review_requests')
          .values({
            tenant_id: params.tenantId,
            task_id: params.taskId,
            design_revision_id: params.revisionId,
            qc_run_id: qcRun?.id ?? null,
            stage: 'human_review',
            assigned_user_id: params.decidedBy,
            assigned_role: 'operator',
            status: 'decided',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      // 4. Insert approval record
      const nonce = params.nonce || `approval_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const approval = await dbClient
        .insertInto('approvals')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          review_request_id: reviewReq.id,
          design_revision_id: params.revisionId,
          qc_run_id: qcRun?.id ?? null,
          decision: params.decision,
          decided_by: params.decidedBy,
          reason: params.reason || null,
          // The task-locked repository is the final authority for capture identity. Both Desk and
          // request-owned lifecycle approvals receive the same immutable server binding proof.
          decision_payload: {
            ...(params.decisionPayload || {}),
            ...authorityPayload,
            ...(approvedCanvaBinding ? {
              canvaBindingId: approvedCanvaBinding.id,
              canvaBindingVersion: approvedCanvaBinding.version,
              canvaDesignId: approvedCanvaBinding.canva_design_id,
            } : {}),
          },
          nonce,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 5. Update design_revisions status
      const nextRevStatus = params.decision === 'approved' ? 'approved' : 'rejected';
      await dbClient
        .updateTable('design_revisions')
        .set({ status: nextRevStatus })
        .where('id', '=', params.revisionId)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      // 6. Update task state
      // Count the newly recorded request while the task row is locked. The third repair request
      // needs an operator, and this transition belongs in the same transaction as the approval.
      const revisionRequestCount = params.decision === 'revision_requested'
        ? Number((await dbClient.selectFrom('approvals')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('tenant_id', '=', params.tenantId)
            .where('task_id', '=', params.taskId)
            .where('decision', '=', 'revision_requested')
            .executeTakeFirstOrThrow()).count)
        : 0;
      const nextTaskState = params.decision === 'approved'
        ? 'approved'
        : params.decision === 'rejected'
        ? 'rejected'
        : revisionRequestCount > 2 ? 'failed_operator' : 'revision_requested';
      const nextTaskVersion = Number(task.version) + 1;
      await dbClient
        .updateTable('tasks')
        .set({
          state: nextTaskState,
          version: nextTaskVersion,
          updated_at: new Date(),
        })
        .where('id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      // 7. Append task_events
      const eventType = params.decision === 'approved'
        ? 'design.approved'
        : params.decision === 'rejected'
        ? 'design.rejected'
        : 'design.revision_requested';

      await dbClient
        .insertInto('task_events')
        .values({
          tenant_id: params.tenantId,
          task_id: params.taskId,
          event_type: eventType,
          schema_version: 1,
          aggregate_version: nextTaskVersion,
          actor_type: 'user',
          actor_id: params.decidedBy,
          correlation_id: params.correlationId || crypto.randomUUID(),
          causation_id: null,
          trace_id: currentTraceId(),
          data: {
            approvalId: approval.id,
            revisionId: params.revisionId,
            decision: params.decision,
            reason: params.reason,
            nonce,
          },
        })
        .execute();

      // Feedback is part of the decision commit, not a later best-effort projection. A keyed
      // retry returns above before this insert, so one decision produces one feedback signal.
      if (!task.client_id && params.lifecycleRequestId) {
        throw new Error('Request-owned review cannot record feedback without a resolved client');
      }
      if (task.client_id) {
        const detail = params.decisionPayload?.revisionRequest;
        const structured = detail && typeof detail === 'object' && !Array.isArray(detail)
          ? detail as Record<string, unknown> : null;
        const priority = structured?.priority;
        const rejectionCategory = params.decisionPayload?.rejectionCategory;
        const target: Record<string, unknown> = {
          approvalId: approval.id, decision: params.decision, revisionId: params.revisionId,
          ...(typeof rejectionCategory === 'string' ? { rejectionCategory } : {}),
          ...(structured ? { revisionRequest: structured } : {}),
        };
        await new FeedbackRepository(dbClient).recordFeedback({
          tenantId: params.tenantId, clientId: task.client_id,
          projectId: task.project_id, taskId: params.taskId,
          beforeRevisionId: params.revisionId,
          category: params.decision === 'rejected' && typeof rejectionCategory === 'string'
            ? `rejection.${rejectionCategory}` : `decision.${params.decision}`,
          severity: priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'critical'
            ? priority : 'medium',
          scope: 'one_time',
          explicitness: params.decision === 'approved' ? 'approval_signal' : 'direct_instruction',
          target, comment: params.reason, actorId: params.decidedBy,
        }, dbClient);
      }

      return { ...approval, replayed: false as const };
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }
}
