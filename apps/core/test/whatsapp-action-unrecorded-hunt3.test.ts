import { afterAll, describe, expect, it } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { actionLinkQuery, signActionLink, type ActionLinkClaims } from '@hawa/integrations';
import { createApp } from '../src/app.js';

/**
 * Hunt-3: the signed WhatsApp review action told the client "Campaign Approved Successfully" (and
 * "Revision Request Recorded") when Postgres refused the change: the error was only logged.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => { await db.destroy(); await owner.destroy(); });
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'art_director' as const };
const app = createApp({ db, testAuth: { principal: scope } });

async function task(): Promise<string> {
  const res = await app.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'WhatsApp action probe', clientId: 'c1000000-0000-4000-8000-000000000002', copyEn: 'Probe' }) });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

async function act(taskId: string, action: 'approve' | 'revision') {
  const claims: ActionLinkClaims = { taskId, action, publish: false, exp: Math.floor(Date.now() / 1000) + 600, phone: '+10000000000' };
  return app.request('/api/webhooks/whatsapp/actions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: actionLinkQuery(claims, signActionLink(claims)) + (action === 'revision' ? '&notes=Bigger+logo' : '') });
}

describe('a WhatsApp review action Postgres did not record (hunt-3)', () => {
  it.each(['approve', 'revision'] as const)('%s: the client is told it was not recorded, and nothing claims it was', async (action) => {
    const id = await task();
    // In review, where both actions are allowed.
    await sql`UPDATE hawa.tasks SET state = 'human_review' WHERE id = ${id}::uuid`.execute(owner);
    await sql.raw('REVOKE INSERT ON hawa.task_events FROM hawa_app').execute(owner);
    let res: Response;
    try { res = await act(id, action); } finally { await sql.raw('GRANT INSERT ON hawa.task_events TO hawa_app').execute(owner); }
    expect(res.status).toBe(503);
    const page = await res.text();
    expect(page).not.toMatch(/Approved Successfully|Revision Request Recorded/);
    const state = (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${id}::uuid`.execute(owner)).rows[0].state;
    expect(state).toBe('human_review');
  });
});
