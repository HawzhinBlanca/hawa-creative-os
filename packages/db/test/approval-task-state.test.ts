import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import { RevisionRepository, unapprovableTaskReason } from '../src/repositories/revision.repository.js';
import type { TaskState } from '../src/types.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) {
  throw new Error('Isolated hawa_repair database required');
}

describe('a task replaced by a revision, or past approval, is not approved', () => {
  it('names why for each state that cannot be approved, and nothing for one that can', () => {
    // No newer revision need exist after changes are requested, so the refusal does not claim one (2026-09-24).
    expect(unapprovableTaskReason('t', 'r', 'revision_requested')).toBe(
      'Cannot approve task t: changes were requested on revision r, so it can no longer be approved; approve the revision made with the changes once it is recorded'
    );
    expect(unapprovableTaskReason('t', 'r', 'publishing')).toMatch(/already approved and being delivered/);
    expect(unapprovableTaskReason('t', 'r', 'complete')).toMatch(/already approved and delivered/);
    expect(unapprovableTaskReason('t', 'r', 'cancelled')).toBe('Cannot approve task t: it was cancelled');
    expect(unapprovableTaskReason('t', 'r', 'rejected')).toBe('Cannot approve task t: it was rejected');
    for (const state of ['received', 'human_review', 'qa', 'auto_repair']) expect(unapprovableTaskReason('t', 'r', state)).toBeUndefined();
  });
});

/**
 * On 2026-09-23 a task superseded by a Telegram change (state revision_requested) could still be
 * approved in the Desk, and the design the office had asked to change would have been delivered.
 */
describe.skipIf(!url)('approval refuses a task in a state past review (PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new RevisionRepository(db);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const approverId = '00000000-0000-4000-b000-000000000002';
  afterAll(() => db.destroy());

  /** A task with a revision and a passing critical QA run, then put in `state`. */
  const reviewedTask = async (state: TaskState) => {
    const taskId = randomUUID();
    await sql`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Approval state check')`.execute(db);
    const revision = await repo.createRevision({ tenantId, taskId, neutralManifest: { nodes: [{ id: 'n1', type: 'text', text: 'KAAE' }] } });
    let profile = await db.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
    if (!profile) {
      // The table's Kysely type predates its columns (content_hash, version as text), so raw SQL.
      profile = (await sql<{ id: string }>`INSERT INTO hawa.qc_profiles (tenant_id, name, version, rules, content_hash)
        VALUES (${tenantId}::uuid, 'approval-state-test', ${randomUUID()}, '{}'::jsonb, 'x') RETURNING id`.execute(db)).rows[0];
    }
    await db
      .insertInto('qc_runs')
      .values({ tenant_id: tenantId, task_id: taskId, design_revision_id: revision.id, qc_profile_id: profile.id, status: 'passed', critical_pass: true, report: {}, report_sha256: 'pass' })
      .execute();
    await db.updateTable('tasks').set({ state }).where('id', '=', taskId).execute();
    return { taskId, revisionId: revision.id };
  };
  const approve = (t: { taskId: string; revisionId: string }) =>
    repo.recordApproval({ tenantId, taskId: t.taskId, revisionId: t.revisionId, decision: 'approved', decidedBy: approverId });
  const approvals = async (taskId: string) => (await db.selectFrom('approvals').select('id').where('task_id', '=', taskId).execute()).length;

  it('records a revision request without inventing a QA run and rejects an approved row with no QA', async () => {
    const taskId = randomUUID();
    await sql`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'No-QA review check')`.execute(db);
    const revision = await repo.createRevision({ tenantId, taskId, neutralManifest: { nodes: [{ id: 'n1', type: 'text', text: 'Draft' }] } });
    const decision = await repo.recordApproval({ tenantId, taskId, revisionId: revision.id,
      decision: 'revision_requested', decidedBy: approverId, reason: 'Change the title' });
    expect(decision.qc_run_id).toBeNull();
    const requests = await db.selectFrom('review_requests').select(['id', 'qc_run_id'])
      .where('task_id', '=', taskId).execute();
    expect(requests).toEqual([expect.objectContaining({ qc_run_id: null })]);
    expect(await db.selectFrom('qc_runs').select('id').where('task_id', '=', taskId).execute()).toEqual([]);
    await expect(db.insertInto('approvals').values({ tenant_id: tenantId, task_id: taskId,
      review_request_id: requests[0]!.id, design_revision_id: revision.id, qc_run_id: null,
      decision: 'approved', decided_by: approverId, reason: null, decision_payload: {}, nonce: randomUUID(),
    }).execute()).rejects.toThrow(/approvals_approved_requires_qc/);
  });

  it('refuses a task a newer revision replaced, and one already delivering, delivered, cancelled or rejected', async () => {
    const replaced = await reviewedTask('revision_requested');
    await expect(approve(replaced)).rejects.toThrow(/changes were requested on revision .*, so it can no longer be approved/);
    for (const state of ['publishing', 'complete', 'cancelled', 'rejected'] as const) {
      const t = await reviewedTask(state);
      await expect(approve(t)).rejects.toThrow(state === 'publishing' || state === 'complete' ? /already approved/ : new RegExp(`it was ${state}`));
      expect(await approvals(t.taskId)).toBe(0);
      const row = await db.selectFrom('tasks').select('state').where('id', '=', t.taskId).executeTakeFirstOrThrow();
      expect(row.state).toBe(state);
    }
    expect(await approvals(replaced.taskId)).toBe(0);
  });

  it('still approves a task in review, or one received', async () => {
    for (const state of ['human_review', 'received'] as const) {
      const t = await reviewedTask(state);
      const approval = await approve(t);
      expect(approval.decision).toBe('approved');
      const row = await db.selectFrom('tasks').select('state').where('id', '=', t.taskId).executeTakeFirstOrThrow();
      expect(row.state).toBe('approved');
    }
  });

  // 2026-09-24: the invalidation and the new revision shared one aggregate version, which the unique
  // key (task_id, aggregate_version) refused, so no revision could follow an approval.
  it('records a new revision after an approval, each event with its own version and the task at the last', async () => {
    const t = await reviewedTask('human_review');
    await approve(t);
    const before = await db.selectFrom('tasks').select('version').where('id', '=', t.taskId).executeTakeFirstOrThrow();
    const next = await repo.createRevision({ tenantId, taskId: t.taskId, neutralManifest: { nodes: [{ id: 'n1', type: 'text', text: 'KAAE, corrected' }] } });
    const events = await db
      .selectFrom('task_events')
      .select(['event_type', 'aggregate_version'])
      .where('task_id', '=', t.taskId)
      .where('aggregate_version', '>', Number(before.version))
      .orderBy('aggregate_version')
      .execute();
    expect(events.map((e) => [e.event_type, Number(e.aggregate_version)])).toEqual([
      ['approval.invalidated', Number(before.version) + 1],
      ['design.revision_created', Number(before.version) + 2],
    ]);
    const after = await db.selectFrom('tasks').select(['version', 'state', 'current_design_revision_id']).where('id', '=', t.taskId).executeTakeFirstOrThrow();
    expect({ version: Number(after.version), state: after.state, revision: after.current_design_revision_id }).toEqual({
      version: Number(before.version) + 2,
      state: 'human_review',
      revision: next.id,
    });
  });
});
