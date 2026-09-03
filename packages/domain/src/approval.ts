import type { UUID, SHA256, ISODateTime, Result, AppError } from '@hawa/contracts';

export type ApprovalState = 'approved' | 'revision_requested' | 'rejected';

export interface StructuredRevisionRequest {
  comment: string;
  affectedNodeIds?: string[];
  requestedChanges: Array<{
    target: 'copy' | 'color' | 'layout' | 'asset' | 'dimensions' | 'general';
    description: string;
  }>;
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
    role: 'art_director' | 'copywriter' | 'account_lead' | 'office_admin';
    verifiedServerSide: true; // Invariant 11: Must be server-verified
  };
  revisionRequest?: StructuredRevisionRequest;
  decidedAt: ISODateTime;
}

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
