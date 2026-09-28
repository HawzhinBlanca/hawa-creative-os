import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';

it('lets only a current named administrator change review scope with an immutable, replayable audit', async () => {
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const administratorId = randomUUID();
  const reviewerId = randomUUID();
  const projectId = randomUUID();
  const assignmentId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const csrf = createHash('sha256').update(`${token}:csrf`).digest('hex');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID', 'test-client');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI', 'https://desk.office.example/v1/auth/google/callback');
  vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS', 'example.test');
  try {
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES
      (${administratorId}::uuid,${`admin-${administratorId}@example.test`},'Named Administrator',${`google-${administratorId}`}),
      (${reviewerId}::uuid,${`review-${reviewerId}@example.test`},'Named Reviewer',${`google-${reviewerId}`})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES
      (${tenantId}::uuid,${administratorId}::uuid,'administrator',true),
      (${tenantId}::uuid,${reviewerId}::uuid,'approver',true)`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${clientId}::uuid,${reviewerId}::uuid,'approver',true)`.execute(owner);
    await sql`INSERT INTO hawa.projects(id,tenant_id,client_id,code,name)
      VALUES (${projectId}::uuid,${tenantId}::uuid,${clientId}::uuid,${`admin-${projectId}`},'Assigned project')`.execute(owner);
    await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
      VALUES (${tokenHash},${tenantId}::uuid,${administratorId}::uuid,'oidc:fixture','administrator',
        'Named Administrator',now()+interval '1 hour','google_oidc')`.execute(owner);

    const desk = createApp({ db });
    const shared = createApp({ db, testAuth: { principal: { role: 'administrator', userId: administratorId } } });
    const path = `/v1/office/review-assignments/${assignmentId}`;
    const firstAction = randomUUID();
    const body = { clientId, projectId, userId: reviewerId, active: true, expectedVersion: 0,
      reason: 'Assign reviewer to this project' };
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': firstAction,
      Cookie: `hawa_session=${token}; hawa_csrf=${csrf}`, 'x-hawa-csrf': csrf };
    expect((await shared.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await shared.request('/v1/office/review-directory')).status).toBe(403);
    const directoryResponse = await desk.request('/v1/office/review-directory', { headers });
    expect(directoryResponse.status).toBe(200);
    const directory = await directoryResponse.json() as {
      reviewers: Array<Record<string, unknown>>; projects: Array<Record<string, unknown>>;
    };
    expect(directory.reviewers).toContainEqual({ userId: reviewerId, displayName: 'Named Reviewer',
      clientId, clientName: expect.any(String) });
    expect(directory.projects).toContainEqual({ id: projectId, clientId, name: 'Assigned project' });

    const created = await desk.request(path, { method: 'PUT', headers, body: JSON.stringify(body) });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({ id: assignmentId, version: 1, replayed: false });
    const replay = await desk.request(path, { method: 'PUT', headers, body: JSON.stringify(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: assignmentId, version: 1, replayed: true });
    expect((await desk.request(path, { method: 'PUT', headers,
      body: JSON.stringify({ ...body, reason: 'Changed purpose' }) })).status).toBe(409);
    const duplicateScope = await desk.request(`/v1/office/review-assignments/${randomUUID()}`, {
      method: 'PUT', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    expect(duplicateScope.status).toBe(409);

    await expect(withRlsContext(db, { tenantId, userId: administratorId, role: 'administrator' },
      (trx) => sql`UPDATE hawa.office_review_assignments SET active=false WHERE id=${assignmentId}::uuid`.execute(trx)))
      .rejects.toThrow('Named administrator action metadata is required');

    const revokeAction = randomUUID();
    const revokeBody = { ...body, active: false, expectedVersion: 1, reason: 'Remove this reviewer from project review' };
    const revoked = await desk.request(path, { method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': revokeAction }, body: JSON.stringify(revokeBody) });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await revoked.json()).toMatchObject({ version: 2, replayed: false });
    const events = await desk.request(`${path}/events`, { headers });
    expect(events.status).toBe(200);
    const history = await events.json() as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history.map((row) => [row.action, Number(row.assignment_version), row.actor_user_id]))
      .toEqual([['revoked', 2, administratorId], ['granted', 1, administratorId]]);
    expect((await sql`SELECT id FROM hawa.office_review_assignment_events
      WHERE assignment_id=${assignmentId}::uuid`.execute(owner)).rows).toHaveLength(2);

    await sql`UPDATE hawa.client_memberships SET active=false
      WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid AND user_id=${reviewerId}::uuid`.execute(owner);
    const ineligible = await desk.request(path, { method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...body, expectedVersion: 2, reason: 'Try to restore without client authority' }) });
    expect(ineligible.status).toBe(422);
    expect((await sql`SELECT id FROM hawa.office_review_assignment_events
      WHERE assignment_id=${assignmentId}::uuid`.execute(owner)).rows).toHaveLength(2);

    await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${tokenHash}`.execute(owner);
    const stale = await desk.request(path, { method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...body, expectedVersion: 2, reason: 'Attempt after sign-out' }) });
    expect(stale.status).toBe(403);
  } finally {
    vi.unstubAllEnvs();
    await Promise.all([owner.destroy(), db.destroy()]);
  }
});
