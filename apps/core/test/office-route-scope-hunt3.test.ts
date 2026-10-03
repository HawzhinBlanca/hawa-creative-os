import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Hunt-3: two office routes read the task as the system operator rather than as the caller, so a
 * signed-in user who may not read the task still got it (review-desk), or could re-scope it (route).
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => { await db.destroy(); await owner.destroy(); });
const tenantId = '00000000-0000-4000-a000-000000000001';
const operator = createApp({ db, testAuth: { principal: { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as never } });
let outsider: ReturnType<typeof createApp>;
let taskId = '';

beforeAll(async () => {
  // A synthetic requester of this tenant with no client membership: it may read no KAAE task.
  const userId = randomUUID();
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId + '@example.test'},'Synthetic outsider')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'requester')`.execute(owner);
  outsider = createApp({ db, testAuth: { principal: { tenantId, userId, role: 'requester' } as never } });
  const res = await operator.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Private KAAE brief title', clientId: 'c1000000-0000-4000-8000-000000000002', copyEn: 'Private copy' }) });
  expect(res.status).toBe(201);
  taskId = (await res.json()).id;
});

describe('a task the caller may not read (hunt-3)', () => {
  it('the operator can read it (control)', async () => {
    expect((await operator.request(`/v1/tasks/${taskId}`)).status).toBe(200);
  });
  it('review-desk answers 404 and names nothing of it', async () => {
    expect((await outsider.request(`/v1/tasks/${taskId}`)).status).toBe(404);
    const res = await outsider.request(`/v1/tasks/${taskId}/review-desk`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Private KAAE brief title');
  });
  it('routing it to another client is refused and changes nothing', async () => {
    const res = await outsider.request(`/v1/tasks/${taskId}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'drustee' }) });
    expect([403, 404]).toContain(res.status);
    const row = (await sql<{ client_id: string; state: string }>`SELECT client_id, state FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(owner)).rows[0];
    expect(row.client_id).toBe('c1000000-0000-4000-8000-000000000002');
  });
});
