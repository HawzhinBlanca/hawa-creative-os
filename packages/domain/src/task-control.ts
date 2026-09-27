import { isTerminalTaskStatus, taskGenerationBlocker, type TaskApiStatus } from '@hawa/contracts';

export type TaskControl = 'pause' | 'resume' | 'cancel';

export class TaskControlPolicyError extends Error {
  readonly code = 'TASK_CONTROL_CONFLICT';
}

/** Operator moves are conditional on a retained checkpoint, unlike normal pipeline moves. */
export function taskControlTarget(current: TaskApiStatus, control: TaskControl, pausedFrom?: TaskApiStatus): TaskApiStatus {
  if (isTerminalTaskStatus(current)) throw new TaskControlPolicyError('This task is closed. Create a new request for further work.');
  if (control === 'cancel') return 'CANCELLED';
  if (control === 'pause') {
    const blocker = taskGenerationBlocker(current);
    if (blocker) throw new TaskControlPolicyError(blocker);
    return 'PAUSED';
  }
  if (current !== 'PAUSED' || !pausedFrom || taskGenerationBlocker(pausedFrom)) {
    throw new TaskControlPolicyError('There is no operator pause checkpoint to resume. Resolve the pending question or inspect the saved workflow.');
  }
  return pausedFrom;
}
