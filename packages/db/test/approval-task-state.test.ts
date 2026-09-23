import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import { RevisionRepository, unapprovableTaskReason } from '../src/repositories/revision.repository.js';
import type { TaskState } from '../src/types.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') {
  throw new Error('Isolated hawa_repair database required');
}

describe('a task replaced by a revision, or past approval, is not approved', () => {
  it('names why for each state that cannot be approved, and nothing for one that can', () => {
    expect(unapprovableTaskReason('t', 'r', 'revision_requested')).toMatch(/^Cannot approve stale revision r: task t was replaced by a newer revision; approve the latest revision instead$/);
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

  it('refuses a task a newer revision replaced, and one already delivering, delivered, cancelled or rejected', async () => {
    const replaced = await reviewedTask('revision_requested');
    await expect(approve(replaced)).rejects.toThrow(/was replaced by a newer revision; approve the latest revision instead/);
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
});
