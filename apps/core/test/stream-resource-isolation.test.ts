import { afterAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { mayReadStreamEvent, type StreamEvent } from '../src/services/stream-event-authority.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
afterAll(async () => { await db.destroy(); await owner.destroy(); });

async function fixture() {
  const userId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  const clients = [randomUUID(), randomUUID()] as const;
  const tasks = [randomUUID(), randomUUID()] as const;
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES
    (${userId}::uuid,${userId + '@example.test'},'Synthetic stream reader')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES
    (${tenantId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  for (const clientId of clients) await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES
    (${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic stream client')`.execute(owner);
  for (let i = 0; i < clients.length; i++) await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state)
    VALUES(${tasks[i]}::uuid,${tenantId}::uuid,${clients[i]}::uuid,'Synthetic stream task','complete')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
    (${tenantId}::uuid,${clients[0]}::uuid,${userId}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${createHash('sha256').update(token).digest('hex')},${tenantId}::uuid,${userId}::uuid,
      ${'oidc:' + userId},'designer','Synthetic stream reader',now()+interval '1 hour','google_oidc')`.execute(owner);
  return { userId, token, clients, tasks };
}

async function listen(app: ReturnType<typeof createApp>, token: string) {
  const response = await app.request('/v1/events/stream', { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let text = '';
  const pump = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      text += new TextDecoder().decode(part.value);
    }
  })();
  return {
    received: () => text,
    async through(id: string) {
      const deadline = Date.now() + 3000;
      while (!text.includes(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(text).toContain(id);
    },
    async ended() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pump, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The revoked stream stayed open')), 3000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    async close() { await reader.cancel(); await pump; },
  };
}

async function upload(app: ReturnType<typeof createApp>, clientId: string) {
  const response = await app.request('/v1/assets/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, filename: `synthetic-${clientId}.svg`, mimeType: 'image/svg+xml',
      content: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#${randomUUID().replaceAll('-', '').slice(0, 6)}"/></svg>` }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ assetId: string }>;
}

it('never discloses a foreign client asset on the real stream while still delivering the assigned client event', async () => {
  const f = await fixture();
  const app = createApp({ db, testAuth: { principal: { role: 'operator' } } });
  const stream = await listen(app, f.token);
  try {
    expect((await app.request(`/v1/clients/${f.clients[1]}`, { headers: { Authorization: `Bearer ${f.token}` } })).status).toBe(404);
    const foreign = await upload(app, f.clients[1]);
    expect((await app.request(`/v1/assets/${foreign.assetId}/content`, { headers: { Authorization: `Bearer ${f.token}` } })).status).toBe(404);
    const allowed = await upload(app, f.clients[0]);
    await stream.through(allowed.assetId);
    expect(stream.received()).not.toContain(foreign.assetId);
    expect(stream.received()).not.toContain(f.clients[1]);
  } finally { await stream.close(); }
});

it('closes a revoked session before sending its next resource event', async () => {
  const f = await fixture(), app = createApp({ db, testAuth: { principal: { role: 'operator' } } });
  const stream = await listen(app, f.token);
  try {
    const logout = await app.request('/v1/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${f.token}` } });
    expect(logout.status).toBe(200);
    const denied = await upload(app, f.clients[0]);
    await stream.ended();
    expect(stream.received()).not.toContain(denied.assetId);
  } finally { await stream.close(); }
});

it('updates an open stream for new client grants and stops disclosure immediately after client revocation', async () => {
  const f = await fixture(), app = createApp({ db, testAuth: { principal: { role: 'operator' } } });
  const stream = await listen(app, f.token);
  try {
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
      (${tenantId}::uuid,${f.clients[1]}::uuid,${f.userId}::uuid,'designer')`.execute(owner);
    const newlyAllowed = await upload(app, f.clients[1]);
    await stream.through(newlyAllowed.assetId);
    await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${f.userId}::uuid
      AND client_id=${f.clients[0]}::uuid`.execute(owner);
    const withdrawn = await upload(app, f.clients[0]);
    const barrier = await upload(app, f.clients[1]);
    await stream.through(barrier.assetId);
    expect(stream.received()).not.toContain(withdrawn.assetId);
  } finally { await stream.close(); }
});

const event = (data: Record<string, unknown>, name = 'task:transitioned'): StreamEvent =>
  ({ id: randomUUID(), event: name, data: { tenantId, ...data } });

it('derives task-only authority from current stored scope and resolves exact UUID/code/client-code identities', async () => {
  const f = await fixture(), scope = { authenticated: true, tenantId, userId: f.userId, role: 'designer' };
  expect(await mayReadStreamEvent(db, scope, event({ taskId: f.tasks[0] }))).toBe(true);
  expect(await mayReadStreamEvent(db, scope, event({ id: f.tasks[0] }, 'task:created'))).toBe(true);
  expect(await mayReadStreamEvent(db, scope, event({ taskId: f.tasks[1] }))).toBe(false);
  await sql`UPDATE hawa.clients SET code='STREAM_ALPHA' WHERE id=${f.clients[0]}::uuid`.execute(owner);
  for (const key of [f.clients[0], f.clients[0].toUpperCase(), 'STREAM_ALPHA', 'client-STREAM_ALPHA'])
    expect(await mayReadStreamEvent(db, scope, event({ clientId: key }, 'dna:updated'))).toBe(true);
  for (const key of [f.clients[1], 'client-UNKNOWN', 'unknown'])
    expect(await mayReadStreamEvent(db, scope, event({ clientId: key }, 'dna:updated'))).toBe(false);
  await sql`UPDATE hawa.clients SET code='client-STREAM_ALPHA' WHERE id=${f.clients[1]}::uuid`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
    (${tenantId}::uuid,${f.clients[1]}::uuid,${f.userId}::uuid,'designer')`.execute(owner);
  expect(await mayReadStreamEvent(db, scope, event({ taskId: f.tasks[0], clientId: 'client-STREAM_ALPHA' }))).toBe(false);
  expect(await mayReadStreamEvent(db, scope, event({ taskId: f.tasks[1], clientId: 'client-STREAM_ALPHA' }))).toBe(true);
});

it('refuses contradictory or invalid resource claims even when both clients are assigned', async () => {
  const f = await fixture(), scope = { authenticated: true, tenantId, userId: f.userId, role: 'designer' };
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
    (${tenantId}::uuid,${f.clients[1]}::uuid,${f.userId}::uuid,'designer')`.execute(owner);
  expect(await mayReadStreamEvent(db, scope, event({ taskId: f.tasks[1], clientId: f.clients[1] }))).toBe(true);
  for (const data of [
    { taskId: f.tasks[1], clientId: f.clients[0] }, { taskId: f.tasks[0], clientId: null },
    { taskId: randomUUID(), clientId: f.clients[0] }, { taskId: null, clientId: f.clients[0] },
    { taskId: 'not-a-task', clientId: f.clients[0] }, { taskId: 0, clientId: f.clients[0] }, { clientId: f.clients[0] },
    { taskId: f.tasks[0], clientId: '' }, { taskId: f.tasks[0], clientId: [f.clients[0]] },
    { taskId: f.tasks[0], tenantId: randomUUID() }, { taskId: f.tasks[0], tenantId: null },
  ]) expect(await mayReadStreamEvent(db, scope, event(data))).toBe(false);
});

it('does not turn system names or cached role claims into office or foreign-client authority', async () => {
  const f = await fixture(), scope = { authenticated: true, tenantId, userId: f.userId, role: 'administrator' };
  expect(await mayReadStreamEvent(db, scope, event({ clientId: f.clients[1] }, 'system:updated'))).toBe(false);
  expect(await mayReadStreamEvent(db, scope, event({}, 'system:updated'))).toBe(false);
  expect(await mayReadStreamEvent(db, scope, event({}, 'operations:kill_switch_toggled'))).toBe(false);
  const office = { authenticated: true, tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
  expect(await mayReadStreamEvent(db, office, event({}, 'operations:kill_switch_toggled'))).toBe(true);
  expect(await mayReadStreamEvent(db, office, event({}, 'operations:unknown'))).toBe(false);
  expect(await mayReadStreamEvent(undefined, office, event({ clientId: f.clients[0] }))).toBe(false);
  expect(await mayReadStreamEvent(db, { ...office, role: 'service' }, event({ clientId: f.clients[0] }))).toBe(false);
});

it('requires active tenant membership independently of retained client grants', async () => {
  const f = await fixture(), scope = { authenticated: true, tenantId, userId: f.userId, role: 'designer' };
  expect(await mayReadStreamEvent(db, scope, event({ clientId: f.clients[0] }, 'dna:updated'))).toBe(true);
  await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${f.userId}::uuid AND tenant_id=${tenantId}::uuid`.execute(owner);
  for (const data of [{ clientId: f.clients[0] }, { clientId: `client-${f.clients[0]}` }, { taskId: f.tasks[0] }])
    expect(await mayReadStreamEvent(db, scope, event(data, 'client:updated'))).toBe(false);
});
