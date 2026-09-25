/**
 * The Delivery workflow's publication, as Postgres keeps it (architecture programme Phase 2; slices
 * 2.2 and 2.4, PHASE2_DESIGN.md sections 2.5 and 2.8). Two writes, each in the caller's transaction:
 *
 * - the claim: before a run of the workflow starts, the approval's publication is the workflow's
 *   (`executor = 'restate'`) and counts the run, which the workflow's prepare step requires. Slice 2.2's
 *   publish route claims it under the publish lock; slice 2.4's request lifecycle claims it in the
 *   projection that moves the task to PUBLISHING.
 * - the report: a finished run moves the task as Core's own delivery did (COMPLETE, left PUBLISHING
 *   for the Sheets row, or back to APPROVED when nothing reached Drive) and is recorded once.
 */
import crypto from 'node:crypto';
import type { DeliveryOutcome } from '@hawa/contracts';
import { PublicationRepository, TaskRepository, sql, type Database, type Kysely } from '@hawa/db';

export type WorkflowDeliveryRecord =
  | { ok: true; status: 'applied' | 'replayed'; taskState: string; fromState: string }
  | { ok: false; status: number; code: string; message: string };

/** The publication key of an approval: one per task and approval, whichever path delivers it. */
export const publicationKeyOf = (taskId: string, approvalId: string) => `pub_key_${taskId}_${approvalId}`;

/**
 * Records a finished run. A report for a run already recorded answers 'replayed' and changes nothing;
 * a run never started is refused.
 */
export async function recordWorkflowDeliveryIn(
  trx: Kysely<Database>,
  p: { tenantId: string; taskId: string; approvalId: string; deliveryId: string; run: number; outcome: Pick<DeliveryOutcome, 'outcome' | 'archived' | 'sheetsConfirmed' | 'reason'> }
): Promise<WorkflowDeliveryRecord> {
  const publicationKey = publicationKeyOf(p.taskId, p.approvalId);
  const pub = (await sql<{ id: string; executor: string; executor_run: number; executor_finished_run: number }>`
    SELECT id, executor, executor_run, executor_finished_run FROM hawa.publications
    WHERE tenant_id = ${p.tenantId}::uuid AND publication_key = ${publicationKey} FOR UPDATE`.execute(trx)).rows[0];
  if (!pub) return { ok: false, status: 404, code: 'PUBLICATION_NOT_FOUND', message: `No publication ${publicationKey}` };
  if (pub.executor !== 'restate') return { ok: false, status: 409, code: 'NOT_OWNED_BY_WORKFLOW', message: `Publication ${publicationKey} is Core's` };
  const taskRepo = new TaskRepository(trx);
  const current = await taskRepo.findById(p.taskId, p.tenantId, trx);
  const state = String(current?.state || '');
  if (p.run <= Number(pub.executor_finished_run)) return { ok: true, status: 'replayed', taskState: state, fromState: state };
  if (p.run > Number(pub.executor_run)) return { ok: false, status: 409, code: 'UNKNOWN_RUN', message: `Run ${p.run} of ${publicationKey} was never started` };
  let next = state;
  // Only a task still being delivered moves: one delivered or taken back meanwhile stays as it is.
  if (state === 'publishing') {
    const data = { publicationKey, deliveryId: p.deliveryId, outcome: p.outcome.outcome };
    if (p.outcome.archived && p.outcome.sheetsConfirmed) {
      await taskRepo.transitionState({
        taskId: p.taskId, tenantId: p.tenantId, fromState: 'publishing', toState: 'complete', actorType: 'workflow', actorId: 'delivery-workflow',
        reason: 'Delivered by the Delivery workflow', data,
      }, trx);
      await new PublicationRepository(trx).markComplete({ tenantId: p.tenantId, publicationId: String(pub.id), taskId: p.taskId }, trx);
      next = 'complete';
    } else if (!p.outcome.archived) {
      await taskRepo.transitionState({
        taskId: p.taskId, tenantId: p.tenantId, fromState: 'publishing', toState: 'approved', actorType: 'workflow', actorId: 'delivery-workflow',
        reason: `Delivery ended before the Drive archive: ${p.outcome.reason || p.outcome.outcome}`, data,
      }, trx);
      next = 'approved';
    }
  }
  await sql`UPDATE hawa.publications SET executor_finished_run = ${p.run}, updated_at = now()
    WHERE tenant_id = ${p.tenantId}::uuid AND id = ${pub.id}::uuid`.execute(trx);
  return { ok: true, status: 'applied', taskState: next, fromState: state };
}

export type WorkflowClaim =
  | { ok: true; publicationId: string; run: number; created: boolean }
  | { ok: false; code: 'NO_APPROVAL' | 'NO_PINNED_EXPORTS' | 'DELIVERY_OWNED_BY_CORE' | 'DELIVERY_ALREADY_COMPLETE'; message: string };

/**
 * Claims the approval's publication for run `run` of the Delivery workflow: created if it has none
 * (its manifest from the approval's pinned exports; the prepare step checks their bytes), marked the
 * workflow's, and its run count raised to `run`. A publication Core's own delivery started, or one
 * already complete, is not claimed.
 */
export async function claimPublicationForWorkflowIn(
  trx: Kysely<Database>,
  p: { tenantId: string; taskId: string; approvalId: string; run: number }
): Promise<WorkflowClaim> {
  const approval = (await sql<{ id: string; design_revision_id: string; decision_payload: { pinnedExports?: Array<{ artifactId?: string; sha256?: string; byteSize?: number; format?: string }> } | string | null }>`
    SELECT id::text, design_revision_id::text, decision_payload FROM hawa.approvals
    WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND id = ${p.approvalId}::uuid AND decision = 'approved'`.execute(trx)).rows[0];
  if (!approval) return { ok: false, code: 'NO_APPROVAL', message: `Approval ${p.approvalId} of task ${p.taskId} is not recorded` };
  const payload = typeof approval.decision_payload === 'string' ? JSON.parse(approval.decision_payload) : approval.decision_payload;
  const pins = Array.isArray(payload?.pinnedExports) ? payload.pinnedExports.filter((x: { sha256?: string }) => typeof x?.sha256 === 'string') : [];
  if (!pins.length) return { ok: false, code: 'NO_PINNED_EXPORTS', message: 'The approval pins no exported file, so there is nothing to deliver' };
  const publicationKey = publicationKeyOf(p.taskId, p.approvalId);
  let pub = (await sql<{ id: string; state: string; executor: string; executor_run: number }>`
    SELECT id::text, state::text AS state, executor, executor_run FROM hawa.publications
    WHERE tenant_id = ${p.tenantId}::uuid AND publication_key = ${publicationKey} FOR UPDATE`.execute(trx)).rows[0];
  let created = false;
  if (!pub) {
    // What the files are, as the approval pinned them; the same package hash Core's delivery computes.
    const packageSha256 = crypto.createHash('sha256').update(pins.map((f: { sha256: string }) => f.sha256).sort().join('\n')).digest('hex');
    const row = await new PublicationRepository(trx).createPublication({
      tenantId: p.tenantId, taskId: p.taskId, designRevisionId: approval.design_revision_id, approvalId: p.approvalId, publicationKey,
      packageManifest: { files: pins.map((f: { artifactId?: string; sha256: string; byteSize?: number; format?: string }) => ({ name: `${String(f.artifactId ?? f.sha256).slice(0, 36)}.${f.format ?? 'png'}`, sha256: f.sha256, size: f.byteSize ?? null })) },
      packageSha256,
      initialState: 'pending',
    }, trx);
    pub = { id: String(row.id), state: String(row.state), executor: String((row as { executor?: string }).executor ?? 'core'), executor_run: Number((row as { executor_run?: number }).executor_run ?? 0) };
    created = true;
  }
  if (pub.state === 'complete') return { ok: false, code: 'DELIVERY_ALREADY_COMPLETE', message: `Publication ${publicationKey} is complete already` };
  // Core's own delivery started it (it may have sent the files through the outbox): it stays Core's.
  if (pub.executor === 'core' && !created) return { ok: false, code: 'DELIVERY_OWNED_BY_CORE', message: `The delivery of task ${p.taskId} was started by Core; it is finished there` };
  await sql`UPDATE hawa.publications SET executor = 'restate', executor_run = GREATEST(executor_run, ${p.run}), updated_at = now()
    WHERE tenant_id = ${p.tenantId}::uuid AND id = ${pub.id}::uuid`.execute(trx);
  return { ok: true, publicationId: pub.id, run: p.run, created };
}
