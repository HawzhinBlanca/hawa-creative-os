import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, TaskState } from './types.js';
import { withRlsContext } from './client.js';
import { currentTraceId } from './trace-context.js';

export interface TaskReconciliationResult {
  totalScanned: number;
  divergedCount: number;
  reconciledCount: number;
  details: Array<{
    taskId: string;
    previousState: TaskState;
    inferredState: TaskState;
    reason: string;
  }>;
}

export async function reconcileTasksFromEvents(
  db: Kysely<Database>,
  tenantId: string = '00000000-0000-4000-a000-000000000001',
  dryRun: boolean = false
): Promise<TaskReconciliationResult> {
  return await withRlsContext(
    db,
    { tenantId, userId: '00000000-0000-4000-b000-000000000002', role: 'administrator' },
    async (trx) => {
      const result: TaskReconciliationResult = {
        totalScanned: 0,
        divergedCount: 0,
        reconciledCount: 0,
        details: [],
      };

      const tasks = await trx
        .selectFrom('tasks')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .execute();

      result.totalScanned = tasks.length;

      for (const task of tasks) {
        // 1. Check if publication exists and is complete
        const publication = await trx
          .selectFrom('publications')
          .select(['state'])
          .where('task_id', '=', task.id)
          .where('state', '=', 'complete')
          .executeTakeFirst();

        if (publication && task.state !== 'complete') {
          result.divergedCount++;
          result.details.push({
            taskId: task.id,
            previousState: task.state,
            inferredState: 'complete',
            reason: 'Authoritative publication record is complete in hawa.publications',
          });

          if (!dryRun) {
            const nextVersion = Number(task.version) + 1;
            await trx
              .updateTable('tasks')
              .set({
                state: 'complete',
                version: nextVersion,
                completed_at: new Date(),
                updated_at: new Date(),
              })
              .where('id', '=', task.id)
              .execute();

            await trx
              .insertInto('task_events')
              .values({
                tenant_id: tenantId,
                task_id: task.id,
                event_type: 'task.state_changed',
                schema_version: 1,
                aggregate_version: nextVersion,
                actor_type: 'system',
                actor_id: 'reconciliation_worker',
                correlation_id: crypto.randomUUID(),
                causation_id: null,
                trace_id: currentTraceId(),
                data: {
                  fromState: task.state,
                  toState: 'complete',
                  reason: 'Authoritative publication record is complete in hawa.publications',
                },
              })
              .execute();

            result.reconciledCount++;
          }
          continue;
        }

        // 2. Check if approved revision exists
        const approval = await trx
          .selectFrom('approvals')
          .select(['decision'])
          .where('task_id', '=', task.id)
          .where('decision', '=', 'approved')
          .executeTakeFirst();

        if (approval && task.state !== 'approved' && task.state !== 'publishing' && task.state !== 'complete') {
          result.divergedCount++;
          result.details.push({
            taskId: task.id,
            previousState: task.state,
            inferredState: 'approved',
            reason: 'Authoritative approval record exists in hawa.approvals',
          });

          if (!dryRun) {
            const nextVersion = Number(task.version) + 1;
            await trx
              .updateTable('tasks')
              .set({
                state: 'approved',
                version: nextVersion,
                updated_at: new Date(),
              })
              .where('id', '=', task.id)
              .execute();

            await trx
              .insertInto('task_events')
              .values({
                tenant_id: tenantId,
                task_id: task.id,
                event_type: 'task.state_changed',
                schema_version: 1,
                aggregate_version: nextVersion,
                actor_type: 'system',
                actor_id: 'reconciliation_worker',
                correlation_id: crypto.randomUUID(),
                causation_id: null,
                trace_id: currentTraceId(),
                data: {
                  fromState: task.state,
                  toState: 'approved',
                  reason: 'Authoritative approval record exists in hawa.approvals',
                },
              })
              .execute();

            result.reconciledCount++;
          }
          continue;
        }

        // 3. Check if design revision exists but task is still in received/routing
        const revision = await trx
          .selectFrom('design_revisions')
          .select(['id'])
          .where('task_id', '=', task.id)
          .executeTakeFirst();

        if (revision && (task.state === 'received' || task.state === 'routing' || task.state === 'brief_draft')) {
          result.divergedCount++;
          result.details.push({
            taskId: task.id,
            previousState: task.state,
            inferredState: 'human_review',
            reason: 'Design revision exists in hawa.design_revisions awaiting review',
          });

          if (!dryRun) {
            const nextVersion = Number(task.version) + 1;
            await trx
              .updateTable('tasks')
              .set({
                state: 'human_review',
                version: nextVersion,
                updated_at: new Date(),
              })
              .where('id', '=', task.id)
              .execute();

            await trx
              .insertInto('task_events')
              .values({
                tenant_id: tenantId,
                task_id: task.id,
                event_type: 'task.state_changed',
                schema_version: 1,
                aggregate_version: nextVersion,
                actor_type: 'system',
                actor_id: 'reconciliation_worker',
                correlation_id: crypto.randomUUID(),
                causation_id: null,
                trace_id: currentTraceId(),
                data: {
                  fromState: task.state,
                  toState: 'human_review',
                  reason: 'Design revision exists in hawa.design_revisions awaiting review',
                },
              })
              .execute();

            result.reconciledCount++;
          }
          continue;
        }
      }

      return result;
    }
  );
}
