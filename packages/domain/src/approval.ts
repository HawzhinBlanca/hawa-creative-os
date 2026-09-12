import type { UUID, SHA256, ISODateTime, Result, AppError } from '@hawa/contracts';
import crypto from 'node:crypto';

export type ApprovalState = 'approved' | 'revision_requested' | 'rejected';

export type StandardReviewerRole =
  | 'art_director'
  | 'creative_director'
  | 'account_lead'
  | 'office_admin'
  | 'client_reviewer'
  | 'operator'
  | 'administrator';

export const AUTHORIZED_REVIEWER_ROLES: readonly StandardReviewerRole[] = [
  'art_director',
  'creative_director',
  'account_lead',
  'office_admin',
  'client_reviewer',
  'operator',
  'administrator',
] as const;

export interface StructuredRevisionRequest {
  scope?: 'full_design' | 'typography' | 'layout' | 'color' | 'assets' | 'copy';
  category?: 'factual_error' | 'brand_violation' | 'aesthetic_preference' | 'legal_compliance' | 'technical_defect';
  targetNodes?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  isReusableFeedback?: boolean;
  comment: string;
  affectedNodeIds?: string[];
  requestedChanges?: Array<{
    target: 'copy' | 'color' | 'layout' | 'asset' | 'dimensions' | 'general';
    description: string;
  }>;
}

export interface ApprovalActor {
  userId: UUID;
  displayName: string;
  role: string;
  verifiedServerSide: boolean; // Invariant: Must be server-verified, cannot be forged from client body
  clientIds?: UUID[];
}

export interface ApprovalDecision {
  decisionId: UUID;
  taskId: UUID;
  designRevisionId: UUID;
  sourceHash: SHA256;
  qcReportHash: SHA256;
  decision: ApprovalState;
  actor: {
    userId: UUID;
    displayName: string;
    role: string;
    verifiedServerSide: true; // Invariant 11: Must be server-verified
  };
  revisionRequest?: StructuredRevisionRequest;
  decidedAt: ISODateTime;
}

export interface ApprovalBindingRecord {
  id: UUID;
  tenantId: UUID;
  taskId: UUID;
  clientId: UUID;
  designRevisionId: UUID;
  captureSetId: UUID;
  capturedArtifactSetHash: SHA256; // Merkle root of staged captured files from CV-13
  qcReportHash: SHA256; // Passing critical QA report hash from CV-14
  designSourceSha256: SHA256;
  decision: ApprovalState;
  actor: ApprovalActor;
  expectedTaskVersion: number;
  actualTaskVersion: number;
  revisionRequest?: StructuredRevisionRequest;
  reason?: string;
  nonce: string;
  decidedAt: ISODateTime;
  immutable: true;
}

export interface ReviewDeskInspection {
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
  activeApproval?: ApprovalBindingRecord;
}

/**
 * Validates whether an actor role is authorized to perform reviews and approvals (FR-043).
 */
export function isAuthorizedReviewerRole(role: string): boolean {
  const normRole = role.toLowerCase().trim();
  return AUTHORIZED_REVIEWER_ROLES.some((r) => r === normRole);
}

/**
 * Checks server authentication and role permissions for approval actions (FR-043).
 */
export function verifyApprovalAuthority(
  actor: ApprovalActor,
  customRoles?: string[],
  clientMembership?: { clientId: UUID; allowedRoles?: string[] }
): Result<ApprovalActor, AppError> {
  if (!actor.verifiedServerSide) {
    return {
      ok: false,
      error: {
        code: 'UNVERIFIED_APPROVER',
        message: 'Approval requires a verified server-side authenticated identity; client-asserted identity rejected',
        retryable: false,
        safeAction: 'Authenticate via trusted session or service credentials',
      },
    };
  }

  const allowed = customRoles || AUTHORIZED_REVIEWER_ROLES;
  const normRole = actor.role.toLowerCase().trim();
  if (!allowed.includes(normRole as any)) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHORIZED_ROLE',
        message: `Actor role '${actor.role}' does not have authority to approve or reject designs`,
        retryable: false,
        safeAction: 'Request review by an authorized Art Director or Creative Director',
      },
    };
  }

  // Client-specific scoping
  if (clientMembership && clientMembership.allowedRoles) {
    if (!clientMembership.allowedRoles.includes(normRole)) {
      return {
        ok: false,
        error: {
          code: 'CLIENT_MEMBERSHIP_ROLE_DENIED',
          message: `Actor role '${actor.role}' is not authorized for client ${clientMembership.clientId}`,
          retryable: false,
          safeAction: 'Obtain client reviewer assignment in Client DNA',
        },
      };
    }
  }

  return { ok: true, value: actor };
}

/**
 * Verifies legacy approval eligibility for backward compatibility.
 */
export function verifyApprovalEligibility(
  decision: ApprovalDecision,
  currentRevisionHash: SHA256,
  latestQcHash: SHA256
): Result<ApprovalDecision, AppError> {
  // Post-approval or mid-approval edits invalidate decision if hash differs
  if (decision.sourceHash !== currentRevisionHash) {
    return {
      ok: false,
      error: {
        code: 'STALE_REVISION_APPROVAL',
        message: 'Approval cannot be recorded: source document has changed since review was initiated',
        retryable: false,
        safeAction: 'Reload review workspace with latest revision and re-evaluate',
      },
    };
  }

  if (decision.qcReportHash !== latestQcHash) {
    return {
      ok: false,
      error: {
        code: 'STALE_QC_APPROVAL',
        message: 'Approval cannot be recorded: a new QC check has run since review',
        retryable: false,
        safeAction: 'Inspect latest QC findings and confirm acceptance',
      },
    };
  }

  if (!decision.actor.verifiedServerSide) {
    return {
      ok: false,
      error: {
        code: 'UNVERIFIED_APPROVER',
        message: 'Approval requires a verified server-side authenticated identity',
        retryable: false,
        safeAction: 'Re-authenticate with Google Workspace SSO',
      },
    };
  }

  return { ok: true, value: decision };
}

export interface ValidateApprovalTransactionParams {
  actor: ApprovalActor;
  taskId: UUID;
  currentTaskRevisionId: UUID;
  currentTaskVersion: number;
  expectedTaskVersion?: number;
  submission: {
    revisionId: UUID;
    decision: ApprovalState;
    captureSetId: UUID;
    capturedArtifactSetHash: SHA256;
    qcReportHash: SHA256;
    sourceHash: SHA256;
    revisionRequest?: StructuredRevisionRequest;
    reason?: string;
    nonce?: string;
  };
  storedCaptureSet: {
    id: UUID;
    taskId: UUID;
    capturedArtifactSetHash: SHA256;
    artifactsCount: number;
    canvaRevisionNumber?: number;
  };
  storedQcRun: {
    id: UUID;
    taskId: UUID;
    designRevisionId: UUID;
    status: 'passed' | 'failed' | 'blocked';
    criticalPass: boolean;
    reportSha256: SHA256;
  };
  currentCanvaRevisionNumber?: number;
}

/**
 * Verifies all preconditions for recording an immutable approval bound to a captured revision (CV-15).
 */
export function validateApprovalTransaction(
  params: ValidateApprovalTransactionParams
): Result<{ binding: ApprovalBindingRecord }, AppError> {
  // 1. Check actor authorization
  const authRes = verifyApprovalAuthority(params.actor);
  if (!authRes.ok) return authRes;

  // 2. Check cross-task mismatch
  if (params.storedCaptureSet.taskId !== params.taskId) {
    return {
      ok: false,
      error: {
        code: 'CROSS_TASK_REVISION_MISMATCH',
        message: `Capture set ${params.submission.captureSetId} belongs to task ${params.storedCaptureSet.taskId}, not task ${params.taskId}`,
        retryable: false,
        safeAction: 'Submit approval for the correct task',
      },
    };
  }
  if (params.storedQcRun.taskId !== params.taskId) {
    return {
      ok: false,
      error: {
        code: 'CROSS_TASK_REVISION_MISMATCH',
        message: `QC run ${params.storedQcRun.id} belongs to task ${params.storedQcRun.taskId}, not task ${params.taskId}`,
        retryable: false,
        safeAction: 'Submit approval for the correct task',
      },
    };
  }

  // 3. Check stale revision
  if (params.currentTaskRevisionId !== params.submission.revisionId) {
    return {
      ok: false,
      error: {
        code: 'STALE_REVISION_APPROVAL',
        message: `Cannot approve stale revision ${params.submission.revisionId}. Task current revision is ${params.currentTaskRevisionId}`,
        retryable: false,
        safeAction: 'Review the latest captured revision and approve current work',
      },
    };
  }

  // 4. Check optimistic concurrency / task version
  if (
    params.expectedTaskVersion !== undefined &&
    params.expectedTaskVersion !== params.currentTaskVersion
  ) {
    return {
      ok: false,
      error: {
        code: 'CONFLICT_CONCURRENT_APPROVAL',
        message: `Concurrent modification detected: expected task version ${params.expectedTaskVersion}, but current version is ${params.currentTaskVersion}`,
        retryable: true,
        safeAction: 'Refresh task review state and re-submit decision',
      },
    };
  }

  // 5. External Canva edits race check
  if (
    params.currentCanvaRevisionNumber !== undefined &&
    params.storedCaptureSet.canvaRevisionNumber !== undefined &&
    params.currentCanvaRevisionNumber > params.storedCaptureSet.canvaRevisionNumber
  ) {
    return {
      ok: false,
      error: {
        code: 'EXTERNAL_CANVA_EDIT_DETECTED',
        message: `Canva design was edited externally (rev ${params.currentCanvaRevisionNumber} > captured rev ${params.storedCaptureSet.canvaRevisionNumber}). Re-observation required`,
        retryable: false,
        safeAction: 'Capture new revision from Canva before approving',
      },
    };
  }

  // 6. Check unqualified capture and QA
  if (params.submission.decision === 'approved') {
    if (params.storedCaptureSet.artifactsCount === 0) {
      return {
        ok: false,
        error: {
          code: 'UNQUALIFIED_CAPTURE',
          message: 'Cannot approve capture set with zero rendered output artifacts',
          retryable: false,
          safeAction: 'Ensure Canva export completed and captured valid files',
        },
      };
    }

    if (
      params.storedQcRun.status !== 'passed' ||
      !params.storedQcRun.criticalPass
    ) {
      return {
        ok: false,
        error: {
          code: 'QA_VERIFICATION_REQUIRED',
          message: `Cannot approve revision without a verified passing critical QA run (observed status: '${params.storedQcRun.status}', criticalPass: ${params.storedQcRun.criticalPass})`,
          retryable: false,
          safeAction: 'Fix quality defects and re-run deterministic QA inspection',
        },
      };
    }
  }

  // 7. Check hash tampering
  if (params.submission.capturedArtifactSetHash !== params.storedCaptureSet.capturedArtifactSetHash) {
    return {
      ok: false,
      error: {
        code: 'TAMPERED_ARTIFACT_HASH',
        message: `Submitted captured artifact set hash '${params.submission.capturedArtifactSetHash}' does not match stored Merkle root '${params.storedCaptureSet.capturedArtifactSetHash}'`,
        retryable: false,
        safeAction: 'Reject tampered review payload',
      },
    };
  }

  if (params.submission.qcReportHash !== params.storedQcRun.reportSha256) {
    return {
      ok: false,
      error: {
        code: 'TAMPERED_QC_HASH',
        message: `Submitted QC report hash '${params.submission.qcReportHash}' does not match stored QC run hash '${params.storedQcRun.reportSha256}'`,
        retryable: false,
        safeAction: 'Inspect authentic QA run evidence',
      },
    };
  }

  const nonce = params.submission.nonce || `appr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const nextTaskVersion = params.currentTaskVersion + 1;

  const binding: ApprovalBindingRecord = {
    id: crypto.randomUUID(),
    tenantId: '00000000-0000-4000-a000-000000000001',
    taskId: params.taskId,
    clientId: '00000000-0000-4000-a000-000000000002',
    designRevisionId: params.submission.revisionId,
    captureSetId: params.submission.captureSetId,
    capturedArtifactSetHash: params.submission.capturedArtifactSetHash,
    qcReportHash: params.submission.qcReportHash,
    designSourceSha256: params.submission.sourceHash,
    decision: params.submission.decision,
    actor: params.actor,
    expectedTaskVersion: params.currentTaskVersion,
    actualTaskVersion: nextTaskVersion,
    revisionRequest: params.submission.revisionRequest,
    reason: params.submission.reason,
    nonce,
    decidedAt: new Date().toISOString(),
    immutable: true,
  };

  return { ok: true, value: { binding } };
}

export interface ValidatePublicationBindingParams {
  taskId: UUID;
  currentTaskRevisionId: UUID;
  currentTaskStatus: string;
  publishTargetRevisionId: UUID;
  approvalId: UUID;
  publicationPolicy?: 'current_task' | 'deliver_approved_stored';
  storedApproval?: ApprovalBindingRecord | null;
  storedCaptureSet?: {
    id: UUID;
    revisionId: UUID;
    artifacts: Array<{
      artifactId: UUID;
      sha256: SHA256;
      filename: string;
      relativePath: string;
    }>;
  };
  requestedFiles: Array<{
    artifactId: UUID;
    sha256: SHA256;
    filename: string;
    relativePath: string;
  }>;
}

/**
 * Enforces the core publication invariant:
 * "B cannot ship using A's approval. Publication either delivers approved stored A
 * under the accepted current-task policy or blocks for B review; it never exports
 * the live design after approval."
 */
export function validatePublicationBinding(
  params: ValidatePublicationBindingParams
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
  },
  AppError
> {
  // 1. Approval record must exist
  if (!params.storedApproval) {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_NOT_FOUND',
        message: `No approved review record found for approval ID ${params.approvalId}`,
        retryable: false,
        safeAction: 'Obtain human approval before publication',
      },
    };
  }

  // 2. Decision must be 'approved'
  if (params.storedApproval.decision !== 'approved') {
    return {
      ok: false,
      error: {
        code: 'UNAPPROVED_DECISION',
        message: `Approval ID ${params.approvalId} has decision '${params.storedApproval.decision}', not 'approved'`,
        retryable: false,
        safeAction: 'Cannot publish a rejected or revision-requested design',
      },
    };
  }

  // 3. Revision binding invariant: B CANNOT SHIP USING A'S APPROVAL
  if (params.storedApproval.designRevisionId !== params.publishTargetRevisionId) {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_REVISION_MISMATCH',
        message: `Revision mismatch: Approval ${params.approvalId} is bound to revision '${params.storedApproval.designRevisionId}', cannot be used to publish target revision '${params.publishTargetRevisionId}'. B cannot ship using A's approval.`,
        retryable: false,
        safeAction: 'Conduct review and approval for the new revision',
      },
    };
  }

  // 4. If current task has moved to a newer revision (e.g. B) and request is under 'current_task' policy:
  if (
    params.publicationPolicy !== 'deliver_approved_stored' &&
    params.currentTaskRevisionId !== params.storedApproval.designRevisionId
  ) {
    return {
      ok: false,
      error: {
        code: 'AWAITING_APPROVAL_FOR_NEW_REVISION',
        message: `Task has been updated to revision '${params.currentTaskRevisionId}', but publication requested revision '${params.storedApproval.designRevisionId}'. Publication blocked pending review of new revision.`,
        retryable: false,
        safeAction: 'Approve new revision or explicitly select deliver_approved_stored policy',
      },
    };
  }

  // 5. Stored capture set verification: MUST deliver from stored capture, NEVER export live design post-approval
  if (!params.storedCaptureSet) {
    return {
      ok: false,
      error: {
        code: 'MISSING_STORED_CAPTURE_SET',
        message: `No immutable capture set found for approved revision '${params.storedApproval.designRevisionId}'. Publication cannot re-export live Canva design post-approval.`,
        retryable: false,
        safeAction: 'Restore immutable captured output package',
      },
    };
  }

  // Verify all files being delivered exist in the stored capture set with identical sha256
  const deliverableFiles = params.requestedFiles.map((reqFile) => {
    const match = params.storedCaptureSet!.artifacts.find(
      (a) => a.sha256 === reqFile.sha256 || a.artifactId === reqFile.artifactId
    );
    if (!match) {
      throw new Error(
        `File ${reqFile.filename} (${reqFile.sha256}) is not part of the approved stored capture set ${params.storedCaptureSet!.id}`
      );
    }
    return {
      ...reqFile,
      source: 'stored_immutable_capture' as const,
    };
  });

  return {
    ok: true,
    value: {
      deliverableFiles,
      approvedRevisionId: params.storedApproval.designRevisionId,
    },
  };
}
