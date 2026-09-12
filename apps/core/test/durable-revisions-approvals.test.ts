import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, withRlsContext } from '@hawa/db';

describe('Milestone A / Step 7: Durable Revisions & Approvals Integration', () => {
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
  const db = createDb(connectionString);
  const app = createApp({ db });

  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const testBearer = process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token';
  const authSessionBearer = `Bearer ${testBearer}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': authSessionBearer,
  };

  it('1. Rejects unauthenticated revision creation and decision with 401 Unauthorized', async () => {
    // Create task first
    const tRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `auth_check_${Date.now()}` },
      body: JSON.stringify({ title: 'Task For Auth Check', priority: 3 }),
    });
    expect(tRes.status).toBe(201);
    const task = await tRes.json();

    // Anon revision create
    const anonRev = await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Hello' }] }),
    });
    expect(anonRev.status).toBe(401);

    // Anon decision
    const anonDec = await app.request(`/tasks/${task.id}/revisions/rev_fake_123/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(anonDec.status).toBe(401);
  });

  it('2. Atomically persists revision to PostgreSQL and updates task version', async () => {
    const tRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `rev_check_${Date.now()}` },
      body: JSON.stringify({ title: 'Task For Durable Revision', priority: 4 }),
    });
    expect(tRes.status).toBe(201);
    const task = await tRes.json();

    const revRes = await app.request(`/tasks/${task.id}/revisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Primary Canvas Revision',
        nodes: [
          { id: 'headline_1', type: 'text', text: 'بەخێربێن بۆ نەورۆز', role: 'headline' },
          { id: 'banner_rect', type: 'frame', width: 1080, height: 1920 },
        ],
      }),
    });
    expect(revRes.status).toBe(201);
    const revJson = await revRes.json();
    expect(revJson.revisionId).toBeDefined();

    // Verify directly in PostgreSQL
    const { dbRev, dbDoc, dbEvents } = await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const r = await trx
          .selectFrom('design_revisions')
          .selectAll()
          .where('id', '=', revJson.revisionId)
          .executeTakeFirst();
        const d = await trx
          .selectFrom('design_documents')
          .selectAll()
          .where('task_id', '=', task.id)
          .executeTakeFirst();
        const e = await trx
          .selectFrom('task_events')
          .selectAll()
          .where('task_id', '=', task.id)
          .where('event_type', '=', 'design.revision_created')
          .execute();
        return { dbRev: r, dbDoc: d, dbEvents: e };
      }
    );

    expect(dbRev).toBeDefined();
    expect(dbRev!.task_id).toBe(task.id);
    expect(dbRev!.revision).toBe(1);
    expect(dbDoc).toBeDefined();
    expect(dbEvents.length).toBe(1);
  });

  it('3. Atomically records approval in PostgreSQL with server-derived identity and rejects cross-task mismatch', async () => {
    // Create Task A and Task B
    const tARes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `task_a_${Date.now()}` },
      body: JSON.stringify({ title: 'Task A', description: 'Has brief', priority: 4 }),
    });
    const taskA = await tARes.json();

    const tBRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `task_b_${Date.now()}` },
      body: JSON.stringify({ title: 'Task B', description: 'Has brief', priority: 3 }),
    });
    const taskB = await tBRes.json();

    // Create Revision on Task A
    const revARes = await app.request(`/tasks/${taskA.id}/revisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        nodes: [{ id: 'n1', type: 'text', text: 'Task A Artwork' }],
      }),
    });
    const revA = await revARes.json();

    // Adversarial: attempt to approve Task A's revision using Task B's URL
    const crossRes = await app.request(`/tasks/${taskB.id}/revisions/${revA.revisionId}/decisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(crossRes.status).toBe(400);
    const crossJson = await crossRes.json();
    expect(crossJson.title).toContain('Cross-Task Revision Mismatch');

    // Negative control: Approval without verified passing QA run is rejected with 412
    const unverifiedApprove = await app.request(`/tasks/${taskA.id}/revisions/${revA.revisionId}/decisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ decision: 'approved', reason: 'Attempting approval without QA' }),
    });
    expect(unverifiedApprove.status).toBe(412);

    // Record verified passing QA run in PostgreSQL
    await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const profile = await trx.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
        const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
        await trx
          .insertInto('qc_runs')
          .values({
            tenant_id: tenantId,
            task_id: taskA.id,
            design_revision_id: revA.revisionId,
            qc_profile_id: profileId,
            status: 'passed',
            critical_pass: true,
            report: { criticalPass: true, score: 100 } as any,
            report_sha256: 'verified_pass_report_sha256',
          })
          .execute();
      }
    );

    // Legitimate Approval on Task A
    const approveRes = await app.request(`/tasks/${taskA.id}/revisions/${revA.revisionId}/decisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        decision: 'approved',
        userId: 'spoofed_user_trying_to_impersonate',
        reason: 'Approved for production export',
      }),
    });
    expect(approveRes.status).toBe(201);
    const approveJson = await approveRes.json();
    expect(approveJson.decision).toBe('approved');
    // Verify server-derived identity:
    expect(approveJson.actor.userId).toBe(operatorUserId);

    // Direct SQL Readback from PostgreSQL:
    const { dbApproval, dbTaskAfter, dbRevAfter, dbEvents } = await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const a = await trx
          .selectFrom('approvals')
          .selectAll()
          .where('design_revision_id', '=', revA.revisionId)
          .executeTakeFirst();
        const t = await trx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', taskA.id)
          .executeTakeFirst();
        const r = await trx
          .selectFrom('design_revisions')
          .selectAll()
          .where('id', '=', revA.revisionId)
          .executeTakeFirst();
        const e = await trx
          .selectFrom('task_events')
          .selectAll()
          .where('task_id', '=', taskA.id)
          .where('event_type', '=', 'design.approved')
          .execute();
        return { dbApproval: a, dbTaskAfter: t, dbRevAfter: r, dbEvents: e };
      }
    );

    expect(dbApproval).toBeDefined();
    expect(dbApproval!.decision).toBe('approved');
    expect(dbApproval!.decided_by).toBe(operatorUserId);
    expect(dbTaskAfter!.state).toBe('approved');
    expect(dbRevAfter!.status).toBe('approved');
    expect(dbEvents.length).toBe(1);
  });
});
