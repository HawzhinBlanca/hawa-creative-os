import { Kysely, sql } from 'kysely';
import crypto from 'node:crypto';
import type { Database } from '../types.js';

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
  qaReport?: Record<string, unknown>;
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
      await dbClient
        .updateTable('approvals')
        .set({
          decision_payload: sql`jsonb_set(COALESCE(decision_payload, '{}'::jsonb), '{invalidated}', 'true')` as any,
        })
        .where('task_id', '=', params.taskId)
        .where('tenant_id', '=', params.tenantId)
        .execute();

      // 5. Update task with current_design_revision_id, reset state to in_review, increment version
      const nextTaskVersion = Number(task.version) + 1;
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
          trace_id: null,
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

      // 2. Ensure verified passing QC run exists (NEVER manufacture fake QA rows)
      // Earlier PASS then later FAIL cannot qualify: order by created_at desc to inspect the latest run
      let qcRun = await dbClient
        .selectFrom('qc_runs')
        .selectAll()
        .where('task_id', '=', params.taskId)
        .where('design_revision_id', '=', params.revisionId)
        .where('tenant_id', '=', params.tenantId)
        .orderBy('started_at', 'desc')
        .executeTakeFirst();

      if (params.decision === 'approved') {
        if (!qcRun || qcRun.status !== 'passed' || !qcRun.critical_pass) {
          throw new Error(
            `Precondition failed: Revision ${params.revisionId} cannot be approved without a verified, passing critical QA run`
          );
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
        // If qcRun is missing on non-approval decisions, find or assign default profile
        let qcRunId = qcRun?.id;
        if (!qcRunId) {
          const profile = await dbClient
            .selectFrom('qc_profiles')
            .select('id')
            .limit(1)
            .executeTakeFirst();
          const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
          const nonPassQa = await dbClient
            .insertInto('qc_runs')
            .values({
              tenant_id: params.tenantId,
              task_id: params.taskId,
              design_revision_id: params.revisionId,
              qc_profile_id: profileId,
              status: 'failed',
              critical_pass: false,
              report: params.qaReport || {},
              report_sha256: this.computeSha256(JSON.stringify(params.qaReport || {})),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          qcRunId = nonPassQa.id;
          qcRun = nonPassQa;
        }

        reviewReq = await dbClient
          .insertInto('review_requests')
          .values({
            tenant_id: params.tenantId,
            task_id: params.taskId,
            design_revision_id: params.revisionId,
            qc_run_id: qcRunId,
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
          qc_run_id: qcRun!.id,
          decision: params.decision,
          decided_by: params.decidedBy,
          reason: params.reason || null,
          decision_payload: params.decisionPayload || {},
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
      const nextTaskState = params.decision === 'approved'
        ? 'approved'
        : params.decision === 'rejected'
        ? 'rejected'
        : 'revision_requested';
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
          trace_id: null,
          data: {
            approvalId: approval.id,
            revisionId: params.revisionId,
            decision: params.decision,
            reason: params.reason,
            nonce,
          },
        })
        .execute();

      return approval;
    };

    if (trx) {
      return await runner(trx);
    }
    return await this.db.transaction().execute(runner);
  }
}
