import type { UUID, ISODateTime, JsonObject, SHA256 } from '@hawa/contracts';

export type TaskStatus =
  | 'RECEIVED'
  | 'ROUTING'
  | 'ROUTING_REVIEW'
  | 'NEEDS_INFORMATION'
  | 'BRIEFING'
  | 'BRIEF_REVIEW'
  | 'PLANNING'
  | 'ASSET_GENERATION'
  | 'COMPOSING'
  | 'QA'
  | 'REPAIRING'
  | 'AWAITING_APPROVAL'
  | 'OPERATOR_REQUIRED'
  | 'REVISION_REQUESTED'
  | 'REJECTED'
  | 'APPROVED'
  | 'PUBLISHING'
  | 'COMPLETE'
  | 'PUBLISH_RECONCILIATION';

export type FailureClassification =
  | 'deterministic_validation_failure'
  | 'retryable_dependency_failure'
  | 'human_resolvable_ambiguity'
  | 'terminal_policy_failure';

export interface DomainFailure {
  classification: FailureClassification;
  code: string;
  message: string;
  safeAction: string;
  retryable: boolean;
  occurredAt: ISODateTime;
  recoverableStep?: TaskStatus;
  detail?: JsonObject;
}

export type TaskPriority = 'routine' | 'urgent' | 'broadcast';

export interface TaskActor {
  type: 'user' | 'workflow' | 'model' | 'adapter' | 'system';
  id: string;
  displayName?: string;
}

export interface TaskTransitionEvent {
  eventId: UUID;
  taskId: UUID;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actor: TaskActor;
  reason: string;
  occurredAt: ISODateTime;
  payload?: JsonObject;
  traceId?: string;
}

export interface TaskScope {
  tenantId: UUID;
  clientId: UUID;
  projectId?: UUID;
  clientDnaVersion: number;
  lockedAt: ISODateTime;
}
