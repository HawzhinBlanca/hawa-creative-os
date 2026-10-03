import type { UUID } from '@hawa/contracts';

/**
 * The input and output of one Canva draft run (canva-draft-workflow.ts). DesignRun, RequestLifecycle's
 * design attempt, is the only caller since ADR-287 retired the task workflow (TaskWorkflow and
 * TaskService are kept bound as refusing shims, services.ts); these types lived in workflow.ts with it.
 * Some fields are only ever set by that retired dispatch and stay optional for old journals.
 */
export interface WorkflowInput {
  taskId: UUID;
  tenantId: UUID;
  clientId?: UUID;
  rawText: string;
  sourcePlatform: string;
  priority?: string;
  idempotencyKey: string;
  canvaAutoGenerate?: boolean;
  /** Requested artboard size recorded at intake; absent for historical tasks. */
  canvaVariant?: { width: number; height: number };
  /** Studio v2 execution flag */
  designStudio?: boolean;
  /** Studio v2 execution options */
  studioOptions?: {
    tier?: 'fast' | 'quality';
    imagery?: 'none' | 'abstract' | 'photographic';
    previews?: number;
    holdForSelection?: boolean;
  };
  /**
   * Set when an operator or the requester asked for the design again (/redo, Desk re-drive). The run
   * is a new one, so every idempotency key it sends Core carries the attempt, and Core does not hand
   * back the first run's answer.
   */
  redriveAttempt?: number;
  /**
   * True when intake already told the requester that no automatic draft is coming (daily cap, no
   * client, instruction only, a reference image). The outcome is still reported, for the task's
   * state, but no second message is sent.
   */
  requesterToldAtIntake?: boolean;
  /**
   * The request that started this work (the id Core wrote with the outbox command). The handler logs
   * under it when the invocation's own x-request-id header is missing.
   */
  requestId?: string;
}

export interface WorkflowOutput {
  taskId: UUID;
  status: string;
  briefId?: UUID;
  documentId?: UUID;
  qcPassed: boolean;
  publicationReceipt?: Record<string, unknown>;
  auditEventsCount: number;
  executedSteps: string[];
  replayedSteps: string[];
}
