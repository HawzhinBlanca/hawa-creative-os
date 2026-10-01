import { taskGenerationBlocker } from '@hawa/contracts';
import { assertStudioCallsResolved as assertLedgerResolved, StudioCallUncertainError, type Database, type Kysely } from '@hawa/db';
import { CanvaFlowError } from './canva-flow-error.js';

/** Call under the task lock before admitting a new operation, after historical replay. */
export function assertTaskGenerationAllowed(state: unknown): void {
  const blocker = taskGenerationBlocker(state);
  if (blocker) throw new CanvaFlowError(409, state === 'paused' || state === 'PAUSED' ? 'TASK_PAUSED' : 'TASK_GENERATION_BLOCKED', blocker);
}

/** Preserve the established HTTP conflict contract for both Studio and planner admission. */
export async function assertStudioCallsResolved(db: Kysely<Database>, tenantId: string, taskId: string, executingPlanId?: string): Promise<void> {
  try { await assertLedgerResolved(db, tenantId, taskId, undefined, executingPlanId); }
  catch (error) {
    if (error instanceof StudioCallUncertainError) throw new CanvaFlowError(409, error.code, error.message);
    throw error;
  }
}
