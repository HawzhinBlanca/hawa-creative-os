import type { UUID, ISODateTime, JsonObject, SHA256, TaskApiStatus } from '@hawa/contracts';

/**
 * A task's status: the API statuses of the one vocabulary (packages/contracts task-status.ts,
 * architecture programme 1.2). NEEDS_INFORMATION, which no database state stored, is PAUSED there.
 */
export type TaskStatus = TaskApiStatus;

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

