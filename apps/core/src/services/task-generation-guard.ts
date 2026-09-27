import { taskGenerationBlocker } from '@hawa/contracts';
import { CanvaFlowError } from './canva-flow-error.js';

/** Call under the task lock before admitting a new operation, after historical replay. */
export function assertTaskGenerationAllowed(state: unknown): void {
  const blocker = taskGenerationBlocker(state);
  if (blocker) throw new CanvaFlowError(409, 'TASK_GENERATION_BLOCKED', blocker);
}
