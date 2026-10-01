/** Actual named session and current client memberships through candidate nginx/Core; synthetic data only. */
import { createHash, randomUUID } from 'node:crypto';
import { query, sql, secrets } from './stack.js';
import { TENANT_ID } from './provision.js';
import { waitUntil, type InvariantResult } from './scenario.js';

export async function verifyCandidateStreamIsolation(origin: string, checks: InvariantResult[]): Promise<void> {
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const userId = randomUUID(), clients = [randomUUID(), randomUUID()] as const;
  const session = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  await query(sql`INSERT INTO hawa.users(id,email,display_name) VALUES
    (${userId}::uuid,${userId + '@example.test'},'Synthetic stream reader')`);
  await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES
    (${TENANT_ID}::uuid,${userId}::uuid,'designer')`);
  for (const id of clients) await query(sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES
    (${id}::uuid,${TENANT_ID}::uuid,${id},'Synthetic stream client')`);
  await query(sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
    (${TENANT_ID}::uuid,${clients[0]}::uuid,${userId}::uuid,'designer')`);
  await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${createHash('sha256').update(session).digest('hex')},${TENANT_ID}::uuid,${userId}::uuid,
      ${'oidc:' + userId},'designer','Synthetic stream reader',now()+interval '1 hour','google_oidc')`);
  const headers = { Authorization: `Bearer ${session}` };
  const issued = await fetch(`${origin}/v1/auth/stream-ticket`, { method: 'POST', headers });
  const ticket = await issued.json() as { ticket?: string };
  check('scoped designer receives a one-use stream ticket from deployed Core', issued.status === 201 &&
    typeof ticket.ticket === 'string', `HTTP ${issued.status}`);
  const abort = new AbortController();
  const response = await fetch(`${origin}/v1/events/stream?ticket=${encodeURIComponent(ticket.ticket!)}`, { signal: abort.signal });
  check('scoped live stream crosses production nginx', response.status === 200 &&
    response.headers.get('Content-Type')?.includes('text/event-stream') === true, `HTTP ${response.status}`);
  const reader = response.body!.getReader();
  let seen = '', ended = false;
  const pump = (async () => {
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const part = await reader.read();
        if (part.done) return;
        seen += decoder.decode(part.value, { stream: true });
        if (seen.length > 128 * 1024) throw new Error('Synthetic stream capture exceeded its bound');
      }
    } catch { if (!abort.signal.aborted) throw new Error('Synthetic stream capture unavailable'); }
    finally { ended = true; }
  })();
  // Observe failures without an unhandled rejection while HTTP actions are still in progress.
  let pumpFailed = false;
  void pump.catch(() => { pumpFailed = true; });
  const through = (id: string) => waitUntil('authorized stream event', async () => {
    if (pumpFailed || ended) throw new Error('Synthetic stream closed before its authorized event');
    return seen.includes(id) ? true : null;
  }, 10_000, 20);
  const upload = async (clientId: string) => {
    const body = { clientId, filename: `synthetic-${clientId}.svg`, mimeType: 'image/svg+xml',
      content: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#${randomUUID().replaceAll('-', '').slice(0, 6)}"/></svg>` };
    const saved = await fetch(`${origin}/v1/assets/upload`, { method: 'POST', headers: {
      Authorization: `Bearer ${secrets().CHAOS_BEARER_TOKEN}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    check('synthetic stream source upload is admitted by deployed Core', saved.status === 201, `HTTP ${saved.status}`);
    return saved.json() as Promise<{ assetId: string }>;
  };
  try {
    const replay = await fetch(`${origin}/v1/events/stream?ticket=${encodeURIComponent(ticket.ticket!)}`);
    check('deployed stream rejects a spent ticket', replay.status === 401, `HTTP ${replay.status}`);
    await replay.body?.cancel();
    const foreign = await upload(clients[1]), allowed = await upload(clients[0]);
    await through(allowed.assetId);
    const denied = await fetch(`${origin}/v1/assets/${foreign.assetId}/content`, { headers });
    check('designer API read and stream both refuse the foreign client original', denied.status === 404 &&
      !seen.includes(foreign.assetId) && !seen.includes(clients[1]), `API HTTP ${denied.status}; scoped positive barrier received`);
    await denied.body?.cancel();
    await query(sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
      (${TENANT_ID}::uuid,${clients[1]}::uuid,${userId}::uuid,'designer')`);
    const granted = await upload(clients[1]); await through(granted.assetId);
    check('open deployed stream honors a newly assigned second client', seen.includes(granted.assetId), 'no reconnect or principal client claim');
    await query(sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${TENANT_ID}::uuid
      AND client_id=${clients[0]}::uuid AND user_id=${userId}::uuid`);
    const removed = await upload(clients[0]), barrier = await upload(clients[1]); await through(barrier.assetId);
    check('open deployed stream refuses a removed client while retaining the other assignment',
      !seen.includes(removed.assetId), 'current RLS checked before ordered positive barrier');
    const logout = await fetch(`${origin}/v1/auth/session`, { method: 'DELETE', headers }); await logout.body?.cancel();
    check('deployed designer session can revoke its own stream credential', logout.status === 200, `HTTP ${logout.status}`);
    const afterLogout = await upload(clients[1]);
    await waitUntil('revoked deployed stream closes', async () => ended ? true : null, 10_000, 20);
    check('revoked session closes before the next authorized resource could be disclosed',
      !pumpFailed && !seen.includes(afterLogout.assetId), 'same Core session revocation; no private event after logout');
  } finally {
    abort.abort(); await reader.cancel().catch(() => undefined); await pump.catch(() => undefined);
  }
}
