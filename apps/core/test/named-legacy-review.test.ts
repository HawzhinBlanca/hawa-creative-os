import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDb, RevisionRepository, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const artDirectorId = '00000000-0000-4000-b000-000000000002';

it('checks a named legacy decision under the task lock and replays one attributed rejection', async () => {
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const reviewerId = randomUUID();
  const projectId = randomUUID();
  const assignmentId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  const sessionHash = createHash('sha256').update(token).digest('hex');
  const csrf = createHash('sha256').update(`${token}:csrf`).digest('hex');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID', 'test-client');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI', 'https://desk.office.example/v1/auth/google/callback');
  vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS', 'example.test');
  try {
    const setup = createApp({ db, testAuth: { principal: { role: 'art_director', userId: artDirectorId } } });
    const taskResponse = await setup.request('/v1/tasks', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ title: 'Older task awaiting a named decision', priority: 3 }) });
    expect(taskResponse.status, await taskResponse.clone().text()).toBe(201);
    const task = await taskResponse.json() as { id: string };
    const revisionResponse = await setup.request(`/tasks/${task.id}/revisions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Editable concept' }] }) });
    expect(revisionResponse.status, await revisionResponse.clone().text()).toBe(201);
    const revision = await revisionResponse.json() as { revisionId: string };
    await sql`INSERT INTO hawa.projects(id,tenant_id,client_id,code,name)
      VALUES (${projectId}::uuid,${tenantId}::uuid,${clientId}::uuid,${`legacy-${projectId}`},'Legacy review')`.execute(owner);
    await sql`UPDATE hawa.tasks SET client_id=${clientId}::uuid,project_id=${projectId}::uuid,
      state='human_review',current_design_revision_id=${revision.revisionId}::uuid
      WHERE id=${task.id}::uuid`.execute(owner);
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject)
      VALUES (${reviewerId}::uuid,${`review-${reviewerId}@example.test`},'Named Reviewer',${`google-${reviewerId}`})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${reviewerId}::uuid,'approver',true)`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${clientId}::uuid,${reviewerId}::uuid,'approver',true)`.execute(owner);
    await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
      VALUES (${sessionHash},${tenantId}::uuid,${reviewerId}::uuid,'oidc:fixture','approver','Named Reviewer',now()+interval '1 hour','google_oidc')`.execute(owner);

    const desk = createApp({ db });
    const actionId = randomUUID();
    const path = `/v1/tasks/${task.id}/revisions/${revision.revisionId}/decisions`;
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': actionId,
      Cookie: `hawa_session=${token}; hawa_csrf=${csrf}`, 'x-hawa-csrf': csrf };
    const body = JSON.stringify({ action: 'reject', rejectionCategory: 'concept', reason: 'This concept needs a new direction' });
    expect((await desk.request(path, { method: 'POST', headers, body })).status).toBe(403);
    await sql`INSERT INTO hawa.office_review_assignments(id,tenant_id,client_id,project_id,user_id)
      VALUES (${assignmentId}::uuid,${tenantId}::uuid,${clientId}::uuid,${projectId}::uuid,${reviewerId}::uuid)`.execute(owner);

    const original = RevisionRepository.prototype.recordApproval;
    const intercepted = vi.spyOn(RevisionRepository.prototype, 'recordApproval').mockImplementation(
      async function (this: RevisionRepository, params, trx) {
        await sql`UPDATE hawa.office_review_assignments SET active=false WHERE id=${assignmentId}::uuid`.execute(owner);
        return original.call(this, params, trx);
      });
    const refused = await desk.request(path, { method: 'POST', headers, body });
    expect(refused.status, await refused.clone().text()).toBe(403);
    intercepted.mockRestore();
    expect((await sql`SELECT id FROM hawa.approvals WHERE task_id=${task.id}::uuid`.execute(owner)).rows).toHaveLength(0);

    await sql`UPDATE hawa.office_review_assignments SET active=true WHERE id=${assignmentId}::uuid`.execute(owner);
    const accepted = await desk.request(path, { method: 'POST', headers, body });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const saved = await sql<{ id: string; decision_payload: Record<string, unknown> }>`SELECT id,decision_payload
      FROM hawa.approvals WHERE task_id=${task.id}::uuid`.execute(owner);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].decision_payload).toMatchObject({ authMethod: 'google_oidc',
      reviewerAssignmentId: assignmentId, reviewerAssignmentVersion: 3,
      reviewClientId: clientId, reviewProjectId: projectId });
    const replay = await desk.request(path, { method: 'POST', headers, body });
    expect(replay.status).toBe(200);
    expect((await replay.json()).decisionId).toBe(saved.rows[0].id);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([db.destroy(), owner.destroy()]);
  }
});
