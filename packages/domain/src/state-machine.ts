import { TASK_TRANSITIONS, type UUID, type ISODateTime, type Result } from '@hawa/contracts';
import type { TaskStatus, FailureClassification, DomainFailure, TaskTransitionEvent, TaskActor } from './types.js';

/**
 * The legal moves are the one vocabulary's (packages/contracts task-status.ts), which took this
 * table as it stood on 2026-09-24 and reconciled it with the database's states and what Core records;
 * the differences are listed there.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = TASK_TRANSITIONS;

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
    const allowed = LEGAL_TRANSITIONS[this.currentStatus] || [];
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
