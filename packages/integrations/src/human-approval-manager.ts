/**
 * Hawa Creative OS — Human Approval Binding & Review Desk Engine (CV-15)
 * Requirements: FR-041, FR-042, FR-043, FR-044, FR-069
 *
 * Implements:
 * 1. Truthful operator review desk inspection of full-size outputs, exact copy, references, QA evidence, and diffs (FR-041).
 * 2. Direct "Edit in Canva" working link with lease protection.
 * 3. Structured revision requests with scope, category, target nodes, priority, and reusable feedback flag (FR-042).
 * 4. Server-authenticated authority checks with strict role gating (FR-043).
 * 5. Immutable approval records bound to exact captured artifact sets, QA report hash, and expected task version (FR-044).
 * 6. Append-only, attributable audit trail with SHA-256 event chaining (FR-069).
 * 7. Core invariant: B cannot ship using A's approval. Publication either delivers approved stored A
 *    under accepted policy or blocks for B review; never exports live design post-approval.
 * 8. Stale chat action defense and optimistic concurrency locking.
 */

import crypto from 'node:crypto';
import type { Result, AppError, UUID, SHA256, ISODateTime } from '@hawa/contracts';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import {
  type ApprovalState,
  type ApprovalActor,
  type ApprovalBindingRecord,
  type StructuredRevisionRequest,
  type ReviewDeskInspection,
  verifyApprovalAuthority,
  validateApprovalTransaction,
  validatePublicationBinding,
  type ValidateApprovalTransactionParams,
  type ValidatePublicationBindingParams,
} from '@hawa/domain';

export interface AuditLogEntry {
  id: UUID;
  timestamp: ISODateTime;
  eventType: 'approval.created' | 'approval.rejected' | 'approval.revision_requested' | 'approval.invalidated' | 'publication.authorized' | 'publication.denied';
  actorId: UUID;
  actorRole: string;
  actorDisplayName: string;
  taskId: UUID;
  revisionId: UUID;
  captureSetId?: UUID;
  artifactSetHash?: SHA256;
  qcReportHash?: SHA256;
  details: Record<string, any>;
  prevHash: SHA256;
  entryHash: SHA256;
}

export interface FeedbackEventRecord {
  id: UUID;
  tenantId: UUID;
  clientId: UUID;
  taskId: UUID;
  beforeRevisionId: UUID;
  afterRevisionId?: UUID;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  scope: 'one_time' | 'client_dna_rule' | 'global_pattern';
  explicitness: 'direct_instruction';
  target: { nodes: string[]; scope: string };
  comment: string;
  actorId: UUID;
  createdAt: ISODateTime;
}

export interface InvalidationHistoryRecord {
  revisionId: UUID;
  invalidatedAt: ISODateTime;
  reason: 'post_approval_edit' | 'new_capture_registered' | 'brief_updated' | 'external_canva_edit';
  invalidatedApprovalId: UUID;
}

export class HumanApprovalManager {
  private approvals = new Map<UUID, ApprovalBindingRecord>(); // keyed by approval id
  private approvalsByRevision = new Map<UUID, ApprovalBindingRecord>(); // keyed by revision id
  private feedbackEvents: FeedbackEventRecord[] = [];
  private auditLog: AuditLogEntry[] = [];
  private invalidationLedger = new Map<UUID, InvalidationHistoryRecord[]>(); // keyed by task id
  private latestAuditHash: SHA256 = '0000000000000000000000000000000000000000000000000000000000000000';

  /**
   * Builds the comprehensive Review Desk Inspection payload for human reviewers (FR-041).
   */
  buildReviewDeskInspection(params: {
    taskId: UUID;
    revisionId: UUID;
    designTitle: string;
    canvaDesignId: string;
    canvaEditUrl: string;
    capturedFiles: Array<{
      artifactId: UUID;
      relativePath: string;
      mimeType: string;
      byteSize: number;
      sha256: SHA256;
      aspectRatio?: string;
      previewUrl: string;
      stagedPath?: string;
    }>;
    capturedArtifactSetHash: SHA256;
    exactCopy: Array<{
      nodeId: string;
      role: string;
      text: string;
      isKurdishRtl: boolean;
    }>;
    brandReferences: {
      clientId: UUID;
      officialLogoSha256: SHA256;
      brandColors: string[];
      approvedFonts: string[];
    };
    qaEvidence: {
      qcRunId: UUID;
      status: 'passed' | 'failed' | 'blocked';
      criticalPass: boolean;
      qcReportHash: SHA256;
      findingsCount: number;
      glyphCoveragePass: boolean;
      unobservedLayersCount: number;
    };
    revisionDiff?: {
      fromRevisionId?: UUID;
      toRevisionId: UUID;
      changedCopy: Array<{ nodeId: string; before: string; after: string }>;
      addedElements: string[];
      removedElements: string[];
    };
  }): ReviewDeskInspection {
    const activeApproval = this.approvalsByRevision.get(params.revisionId);

    return {
      taskId: params.taskId,
      revisionId: params.revisionId,
      designTitle: params.designTitle,
      canvaDesignId: params.canvaDesignId,
      canvaEditUrl: params.canvaEditUrl,
      capturedFiles: params.capturedFiles,
      capturedArtifactSetHash: params.capturedArtifactSetHash,
      exactCopy: params.exactCopy,
      brandReferences: params.brandReferences,
      qaEvidence: params.qaEvidence,
      revisionDiff: params.revisionDiff,
      activeApproval,
    };
  }

  /**
   * Records an atomic approval, rejection, or structured revision decision (FR-042, FR-043, FR-044, FR-069).
   */
  recordDecision(params: ValidateApprovalTransactionParams): Result<
    {
      binding: ApprovalBindingRecord;
      feedbackEvent?: FeedbackEventRecord;
      auditEntry: AuditLogEntry;
    },
    AppError
  > {
    // 1. Validate complete transaction invariants
    const valRes = validateApprovalTransaction(params);
    if (!valRes.ok) {
      this.appendAuditEntry({
        eventType: 'approval.rejected',
        actor: params.actor,
        taskId: params.taskId,
        revisionId: params.submission.revisionId,
        details: { rejectionReason: valRes.error.code, message: valRes.error.message },
      });
      return valRes;
    }

    const { binding } = valRes.value;

    // 2. Persist approval binding (Immutable append-only)
    this.approvals.set(binding.id, binding);
    this.approvalsByRevision.set(binding.designRevisionId, binding);

    // 3. If revision requested, record structured feedback event (FR-042, FR-052)
    let feedbackEvent: FeedbackEventRecord | undefined;
    if (binding.decision === 'revision_requested' && params.submission.revisionRequest) {
      const revReq = params.submission.revisionRequest;
      feedbackEvent = {
        id: crypto.randomUUID(),
        tenantId: binding.tenantId,
        clientId: binding.clientId,
        taskId: binding.taskId,
        beforeRevisionId: binding.designRevisionId,
        category: revReq.category || 'factual_error',
        severity: revReq.priority || 'high',
        scope: revReq.isReusableFeedback ? 'client_dna_rule' : 'one_time',
        explicitness: 'direct_instruction',
        target: {
          nodes: revReq.targetNodes || [],
          scope: revReq.scope || 'copy',
        },
        comment: revReq.comment,
        actorId: params.actor.userId,
        createdAt: binding.decidedAt,
      };
      this.feedbackEvents.push(feedbackEvent);
    }

    // 4. Record Chained Audit Trail Entry (FR-069)
    const auditEntry = this.appendAuditEntry({
      eventType:
        binding.decision === 'approved'
          ? 'approval.created'
          : binding.decision === 'rejected'
          ? 'approval.rejected'
          : 'approval.revision_requested',
      actor: params.actor,
      taskId: binding.taskId,
      revisionId: binding.designRevisionId,
      captureSetId: binding.captureSetId,
      artifactSetHash: binding.capturedArtifactSetHash,
      qcReportHash: binding.qcReportHash,
      details: {
        approvalId: binding.id,
        decision: binding.decision,
        expectedTaskVersion: binding.expectedTaskVersion,
        actualTaskVersion: binding.actualTaskVersion,
        nonce: binding.nonce,
        reason: binding.reason,
        revisionRequest: binding.revisionRequest,
      },
    });

    return {
      ok: true,
      value: {
        binding,
        feedbackEvent,
        auditEntry,
      },
    };
  }

  /**
   * Invalidates a previous approval when a new revision or edit occurs (Gate F / Post-Approval Invalidation).
   */
  invalidateApproval(params: {
    taskId: UUID;
    newRevisionId: UUID;
    priorRevisionId: UUID;
    reason: 'post_approval_edit' | 'new_capture_registered' | 'brief_updated' | 'external_canva_edit';
    actor: ApprovalActor;
  }): { priorApprovalInvalidated: boolean; invalidationRecord?: InvalidationHistoryRecord } {
    const priorApproval = this.approvalsByRevision.get(params.priorRevisionId);
    if (!priorApproval) {
      return { priorApprovalInvalidated: false };
    }

    const invRecord: InvalidationHistoryRecord = {
      revisionId: params.priorRevisionId,
      invalidatedAt: new Date().toISOString(),
      reason: params.reason,
      invalidatedApprovalId: priorApproval.id,
    };

    if (!this.invalidationLedger.has(params.taskId)) {
      this.invalidationLedger.set(params.taskId, []);
    }
    this.invalidationLedger.get(params.taskId)!.push(invRecord);

    this.appendAuditEntry({
      eventType: 'approval.invalidated',
      actor: params.actor,
      taskId: params.taskId,
      revisionId: params.priorRevisionId,
      details: {
        invalidatedApprovalId: priorApproval.id,
        newRevisionId: params.newRevisionId,
        reason: params.reason,
      },
    });

    return { priorApprovalInvalidated: true, invalidationRecord: invRecord };
  }

  /**
   * Handles two-way chat actions (Telegram inline buttons / WAHA quick actions) safely.
   * Strictly rejects stale actions if the task has progressed beyond the action's revision.
   */
  handleChatApprovalAction(params: {
    actor: ApprovalActor;
    taskId: UUID;
    actionRevisionId: UUID;
    currentTaskRevisionId: UUID;
    decision: 'approved' | 'rejected' | 'revision_requested';
    reason?: string;
  }): Result<{ accepted: boolean; message: string }, AppError> {
    // 1. Stale chat action check
    if (params.actionRevisionId !== params.currentTaskRevisionId) {
      return {
        ok: false,
        error: {
          code: 'STALE_CHAT_APPROVAL_ACTION',
          message: `Stale chat action: button references revision '${params.actionRevisionId}', but task is currently on revision '${params.currentTaskRevisionId}'. Action rejected.`,
          retryable: false,
          safeAction: 'Use the latest interactive review message in chat',
        },
      };
    }

    // 2. Role check
    const authRes = verifyApprovalAuthority(params.actor);
    if (!authRes.ok) return authRes;

    return {
      ok: true,
      value: {
        accepted: true,
        message: `Chat action '${params.decision}' verified for revision ${params.actionRevisionId}`,
      },
    };
  }

  /**
   * Enforces the publication invariant:
   * "B cannot ship using A's approval. Publication either delivers approved stored A
   * under accepted current-task policy or blocks for B review; it never exports
   * the live design after approval."
   */
  validatePublication(
    params: Omit<ValidatePublicationBindingParams, 'storedApproval'>
  ): Result<
    {
      deliverableFiles: Array<{
        artifactId: UUID;
        sha256: SHA256;
        filename: string;
        relativePath: string;
        source: 'stored_immutable_capture';
      }>;
      approvedRevisionId: UUID;
      auditEntry: AuditLogEntry;
    },
    AppError
  > {
    const storedApproval = this.approvals.get(params.approvalId) || null;

    const valRes = validatePublicationBinding({
      ...params,
      storedApproval,
    });

    if (!valRes.ok) {
      const auditEntry = this.appendAuditEntry({
        eventType: 'publication.denied',
        actor: {
          userId: SYSTEM_AUTOMATION_USER_ID,
          displayName: 'Google Publisher',
          role: 'system',
          verifiedServerSide: true,
        },
        taskId: params.taskId,
        revisionId: params.publishTargetRevisionId,
        details: {
          approvalId: params.approvalId,
          error: valRes.error.code,
          message: valRes.error.message,
        },
      });

      return valRes;
    }

    const auditEntry = this.appendAuditEntry({
      eventType: 'publication.authorized',
      actor: {
        userId: SYSTEM_AUTOMATION_USER_ID,
        displayName: 'Google Publisher',
        role: 'system',
        verifiedServerSide: true,
      },
      taskId: params.taskId,
      revisionId: valRes.value.approvedRevisionId,
      details: {
        approvalId: params.approvalId,
        fileCount: valRes.value.deliverableFiles.length,
        policy: params.publicationPolicy || 'current_task',
      },
    });

    return {
      ok: true,
      value: {
        deliverableFiles: valRes.value.deliverableFiles,
        approvedRevisionId: valRes.value.approvedRevisionId,
        auditEntry,
      },
    };
  }

  /**
   * Helper: Appends an attributable, cryptographically hashed audit entry (FR-069).
   */
  private appendAuditEntry(params: {
    eventType: AuditLogEntry['eventType'];
    actor: ApprovalActor;
    taskId: UUID;
    revisionId: UUID;
    captureSetId?: UUID;
    artifactSetHash?: SHA256;
    qcReportHash?: SHA256;
    details: Record<string, any>;
  }): AuditLogEntry {
    const entryId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const prevHash = this.latestAuditHash;

    const contentToHash = JSON.stringify({
      entryId,
      timestamp,
      eventType: params.eventType,
      actorId: params.actor.userId,
      actorRole: params.actor.role,
      taskId: params.taskId,
      revisionId: params.revisionId,
      captureSetId: params.captureSetId,
      artifactSetHash: params.artifactSetHash,
      qcReportHash: params.qcReportHash,
      details: params.details,
      prevHash,
    });

    const entryHash = crypto.createHash('sha256').update(contentToHash).digest('hex');
    this.latestAuditHash = entryHash;

    const entry: AuditLogEntry = {
      id: entryId,
      timestamp,
      eventType: params.eventType,
      actorId: params.actor.userId,
      actorRole: params.actor.role,
      actorDisplayName: params.actor.displayName,
      taskId: params.taskId,
      revisionId: params.revisionId,
      captureSetId: params.captureSetId,
      artifactSetHash: params.artifactSetHash,
      qcReportHash: params.qcReportHash,
      details: params.details,
      prevHash,
      entryHash,
    };

    this.auditLog.push(entry);
    return entry;
  }

  // Getters for inspection and testing
  getApprovalById(id: UUID): ApprovalBindingRecord | undefined {
    return this.approvals.get(id);
  }

  getApprovalByRevision(revisionId: UUID): ApprovalBindingRecord | undefined {
    return this.approvalsByRevision.get(revisionId);
  }

  getFeedbackEvents(): readonly FeedbackEventRecord[] {
    return this.feedbackEvents;
  }

  getAuditLog(): readonly AuditLogEntry[] {
    return this.auditLog;
  }

  getInvalidationHistory(taskId: UUID): readonly InvalidationHistoryRecord[] {
    return this.invalidationLedger.get(taskId) || [];
  }
}
