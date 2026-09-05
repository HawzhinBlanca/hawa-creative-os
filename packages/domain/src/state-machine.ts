import type { UUID, ISODateTime, Result } from '@hawa/contracts';
import type { TaskStatus, FailureClassification, DomainFailure, TaskTransitionEvent, TaskActor } from './types.js';

export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  RECEIVED: ['ROUTING'],
  ROUTING: ['ROUTING_REVIEW', 'NEEDS_INFORMATION', 'BRIEFING'],
  ROUTING_REVIEW: ['ROUTING', 'NEEDS_INFORMATION', 'BRIEFING', 'REJECTED'],
  NEEDS_INFORMATION: ['ROUTING', 'BRIEFING', 'REJECTED'],
  BRIEFING: ['BRIEF_REVIEW', 'PLANNING', 'NEEDS_INFORMATION', 'OPERATOR_REQUIRED'],
  BRIEF_REVIEW: ['PLANNING', 'NEEDS_INFORMATION', 'OPERATOR_REQUIRED', 'REJECTED'],
  PLANNING: ['ASSET_GENERATION', 'COMPOSING', 'OPERATOR_REQUIRED'],
  ASSET_GENERATION: ['COMPOSING', 'OPERATOR_REQUIRED'],
  COMPOSING: ['QA', 'OPERATOR_REQUIRED'],
  QA: ['REPAIRING', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED'],
  REPAIRING: ['COMPOSING', 'QA', 'OPERATOR_REQUIRED'],
  AWAITING_APPROVAL: ['REVISION_REQUESTED', 'REJECTED', 'APPROVED', 'OPERATOR_REQUIRED'],
  OPERATOR_REQUIRED: ['ROUTING', 'BRIEFING', 'PLANNING', 'COMPOSING', 'QA', 'AWAITING_APPROVAL', 'PUBLISHING', 'REJECTED'],
  REVISION_REQUESTED: ['PLANNING', 'COMPOSING', 'OPERATOR_REQUIRED'],
  REJECTED: [],
  APPROVED: ['PUBLISHING', 'AWAITING_APPROVAL', 'REVISION_REQUESTED'],
  PUBLISHING: ['COMPLETE', 'PUBLISH_RECONCILIATION', 'OPERATOR_REQUIRED'],
  PUBLISH_RECONCILIATION: ['COMPLETE', 'OPERATOR_REQUIRED'],
  COMPLETE: [],
};

export class TaskStateMachine {
  private currentStatus: TaskStatus;
  private readonly taskId: UUID;
  private repairCount: number = 0;
  private readonly maxRepairs: number = 2;

  constructor(taskId: UUID, initialStatus: TaskStatus = 'RECEIVED', repairCount: number = 0) {
    this.taskId = taskId;
    this.currentStatus = initialStatus;
    this.repairCount = repairCount;
  }

  getStatus(): TaskStatus {
    return this.currentStatus;
  }

  getRepairCount(): number {
    return this.repairCount;
  }

  canTransitionTo(next: TaskStatus): boolean {
    const allowed = LEGAL_TRANSITIONS[this.currentStatus];
    return allowed.includes(next);
  }

  transition(
    next: TaskStatus,
    actor: TaskActor,
    reason: string,
    payload?: Record<string, unknown>
  ): Result<TaskTransitionEvent, DomainFailure> {
    if (!this.canTransitionTo(next)) {
      return {
        ok: false,
        error: {
          classification: 'terminal_policy_failure',
          code: 'ILLEGAL_STATE_TRANSITION',
          message: `Illegal transition from ${this.currentStatus} to ${next}`,
          safeAction: 'Review state history or trigger operator intervention',
          retryable: false,
          occurredAt: new Date().toISOString(),
          recoverableStep: this.currentStatus,
          detail: { from: this.currentStatus, to: next, taskId: this.taskId },
        },
      };
    }

    if (next === 'REPAIRING') {
      if (this.repairCount >= this.maxRepairs) {
        return {
          ok: false,
          error: {
            classification: 'human_resolvable_ambiguity',
            code: 'MAX_REPAIR_BUDGET_EXCEEDED',
            message: `Max repair budget of ${this.maxRepairs} cycles reached. Escalating to operator review.`,
            safeAction: 'Transition to OPERATOR_REQUIRED for human designer review',
            retryable: false,
            occurredAt: new Date().toISOString(),
            recoverableStep: 'AWAITING_APPROVAL',
            detail: { taskId: this.taskId, currentRepairs: this.repairCount },
          },
        };
      }
      this.repairCount += 1;
    }

    const previous = this.currentStatus;
    this.currentStatus = next;

    const event: TaskTransitionEvent = {
      eventId: crypto.randomUUID(),
      taskId: this.taskId,
      fromStatus: previous,
      toStatus: next,
      actor,
      reason,
      occurredAt: new Date().toISOString(),
      payload,
    };

    return { ok: true, value: event };
  }

  classifyFailure(code: string, message: string, cause?: unknown): DomainFailure {
    let classification: FailureClassification = 'deterministic_validation_failure';
    let safeAction = 'Check validation errors and retry with valid inputs';

    if (code.includes('NETWORK') || code.includes('TIMEOUT') || code.includes('503') || code.includes('429')) {
      classification = 'retryable_dependency_failure';
      safeAction = 'Wait for exponential backoff and retry under Restate';
    } else if (code.includes('AMBIGUOUS') || code.includes('UNCERTAIN') || code.includes('MISSING_FACT')) {
      classification = 'human_resolvable_ambiguity';
      safeAction = 'Request clarification via Desk or adapter and pause workflow';
    } else if (code.includes('PERMISSION') || code.includes('LEAK') || code.includes('INJECTION')) {
      classification = 'terminal_policy_failure';
      safeAction = 'Quarantine task and notify security officer';
    }

    return {
      classification,
      code,
      message,
      safeAction,
      retryable: classification === 'retryable_dependency_failure',
      occurredAt: new Date().toISOString(),
      recoverableStep: this.currentStatus,
      detail: cause ? { cause: String(cause) } : undefined,
    };
  }
}
