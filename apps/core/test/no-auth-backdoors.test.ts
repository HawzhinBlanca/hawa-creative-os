import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../src/app.js';

/**
 * Three ways a request used to become someone it was not:
 *  1. with no database configured, every token-less request was the operator (the "in-memory
 *     harness"), so a misconfigured production could run open;
 *  2. the x-user-role header set the role when HAWA_ALLOW_ROLE_HEADER=true, an env var;
 *  3. an approval's body ("role": "art_director") chose the approver's authority.
 * None is reachable now unless a test passes testAuth to createApp explicitly. These tests run
 * the same createApp production runs, with NODE_ENV=production, and no testAuth.
 */
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const asProduction = () => { process.env.NODE_ENV = 'production'; process.env.HAWA_ALLOW_ROLE_HEADER = 'true'; };
const json = { 'content-type': 'application/json' };

describe('no authentication backdoor survives outside an explicit test option', () => {
  it('a token-less request is anonymous, with or without a database, in every environment', async () => {
    for (const env of ['production', 'development', 'test']) {
      process.env.NODE_ENV = env;
      const res = await createApp().request('/v1/tasks');
      expect(res.status, `NODE_ENV=${env}`).toBe(401);
    }
  });

  it('the x-user-role header grants nothing, even with the old environment switch set', async () => {
    asProduction();
    const res = await createApp().request('/v1/tasks', { headers: { 'x-user-role': 'administrator' } });
    expect(res.status).toBe(401);
  });

  it('a signed-in operator cannot approve by naming a reviewer role in the body or the header', async () => {
    process.env.NODE_ENV = 'development';
    const app = createApp();
    const created = await app.request('/v1/tasks', { method: 'POST', headers: { ...json, Authorization: 'Bearer test_bearer' }, body: JSON.stringify({ title: 'T', clientId: 'kaae' }) });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const rev = await (await app.request(`/v1/tasks/${id}/revisions`, { method: 'POST', headers: { ...json, Authorization: 'Bearer test_bearer' }, body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'x' }] } }) })).json();
    const revId = rev.revisionId || rev.id;
    expect(revId).toBeTruthy();
    for (const headers of [{ ...json, Authorization: 'Bearer test_bearer' }, { ...json, Authorization: 'Bearer test_bearer', 'x-user-role': 'art_director' }]) {
      const res = await app.request(`/v1/tasks/${id}/revisions/${revId}/decisions`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved', role: 'art_director' }) });
      expect(res.status).toBe(403);
    }
  });

  it('the explicit test option is the only door, and only for token-less requests', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' } } });
    expect((await app.request('/v1/tasks')).status).toBe(200);
    // A real, wrong token is still refused: the option does not turn off verification.
    expect((await app.request('/v1/tasks', { headers: { Authorization: 'Bearer not_a_real_token' } })).status).toBe(401);
  });

  it('the production source contains no environment switch for either backdoor', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/HAWA_ALLOW_ROLE_HEADER/);
    expect(src).not.toMatch(/bypassAuthWithoutDb\s*\?\?\s*!db/);
    expect(src).not.toMatch(/x-user-role\x27\)\s*\|\|\s*body\.role/);
  });
});
