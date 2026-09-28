import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { lockNamedReviewAuthority } from '../src/services/named-review-authority.js';

const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const appDb = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const otherClientId = 'c1000000-0000-4000-8000-000000000003';
const userId = randomUUID();
const projectId = randomUUID();
const sessionHash = 'f'.repeat(64);

async function authority(client = clientId, project: string | null = null) {
  return withRlsContext(appDb, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
    (trx) => lockNamedReviewAuthority(trx, { tenantId, userId, clientId: client, projectId: project, sessionHash }));
}

beforeAll(async () => {
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject)
    VALUES (${userId}::uuid,${`named-review-${userId}@example.test`},'Named Reviewer',${`google-${userId}`})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
    VALUES (${tenantId}::uuid,${userId}::uuid,'approver',true)`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
    VALUES (${tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'approver',true)`.execute(owner);
  await sql`INSERT INTO hawa.projects(id,tenant_id,client_id,code,name)
    VALUES (${projectId}::uuid,${tenantId}::uuid,${clientId}::uuid,${`review-${projectId}`},'Review fixture')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES (${sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:fixture','approver','Named Reviewer',now()+interval '1 hour','google_oidc')`.execute(owner);
});

afterAll(async () => {
  // The per-file database clone is dropped by test setup. Review assignments and their audit
  // events are intentionally append-only, so cleanup must not delete those records.
  await Promise.all([owner.destroy(), appDb.destroy()]);
});

describe('ADR-064 named office assignment', () => {
  it('requires an explicit assignment and matches client and project exactly', async () => {
    expect(await authority()).toBeNull();
    const assignmentId = randomUUID();
    await sql`INSERT INTO hawa.office_review_assignments(id,tenant_id,client_id,project_id,user_id)
      VALUES (${assignmentId}::uuid,${tenantId}::uuid,${clientId}::uuid,${projectId}::uuid,${userId}::uuid)`.execute(owner);
    expect(await authority()).toBeNull();
    expect(await authority(clientId, projectId)).toEqual({ assignmentId, assignmentVersion: 1 });
    expect(await authority(otherClientId, projectId)).toBeNull();
    const clientWideId = randomUUID();
    await sql`INSERT INTO hawa.office_review_assignments(id,tenant_id,client_id,user_id)
      VALUES (${clientWideId}::uuid,${tenantId}::uuid,${clientId}::uuid,${userId}::uuid)`.execute(owner);
    expect(await authority()).toEqual({ assignmentId: clientWideId, assignmentVersion: 1 });
    expect(await authority(clientId, projectId)).toEqual({ assignmentId, assignmentVersion: 1 });
  });

  it('refuses revoked scope, member, user and session at each boundary', async () => {
    const assigned = await authority(clientId, projectId);
    expect(assigned).not.toBeNull();
    await sql`UPDATE hawa.office_review_assignments SET active=false WHERE id=${assigned!.assignmentId}::uuid`.execute(owner);
    const changed = await sql<{ version: string }>`SELECT version FROM hawa.office_review_assignments
      WHERE id=${assigned!.assignmentId}::uuid`.execute(owner);
    expect(Number(changed.rows[0].version)).toBe(2);
    const fallback = await authority(clientId, projectId);
    expect(fallback?.assignmentId).not.toBe(assigned!.assignmentId);
    await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${userId}::uuid`.execute(owner);
    expect(await authority()).toBeNull();
    await sql`UPDATE hawa.client_memberships SET active=true WHERE user_id=${userId}::uuid`.execute(owner);
    await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${userId}::uuid`.execute(owner);
    expect(await authority()).toBeNull();
    await sql`UPDATE hawa.tenant_memberships SET active=true WHERE user_id=${userId}::uuid`.execute(owner);
    await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${userId}::uuid`.execute(owner);
    expect(await authority()).toBeNull();
    await sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${userId}::uuid`.execute(owner);
    await sql`UPDATE hawa.clients SET status='inactive' WHERE id=${clientId}::uuid`.execute(owner);
    expect(await authority()).toBeNull();
    await sql`UPDATE hawa.clients SET status='active' WHERE id=${clientId}::uuid`.execute(owner);
    await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${sessionHash}`.execute(owner);
    expect(await authority()).toBeNull();
  });
});
