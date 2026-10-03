import { describe, expect, it } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Hunt-3: office routes that took any signed-in role. The role comes from the test principal
 * (x-user-role, testAuth.roleHeader); no database, no provider call.
 */
const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'art_director' }, roleHeader: true } });
const as = (role: string, body?: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-role': role },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function newTask(): Promise<string> {
  const res = await app.request('/v1/tasks', as('art_director', { title: 'Authz probe', clientId: 'client-drustee', headlineEn: 'Probe headline' }));
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

describe('the review dispatch carries approval authority (hunt-3)', () => {
  // Its answer holds a signed approve link; the public WhatsApp action webhook approves the task on it.
  it.each(['auditor', 'requester', 'designer', 'operator'])('%s cannot obtain a signed approve link', async (role) => {
    const taskId = await newTask();
    const res = await app.request(`/v1/campaigns/${taskId}/dispatch-review`, as(role, { phone: '+10000000000' }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/callbackUrl|signature/);
  });
  it('a reviewer still can', async () => {
    const taskId = await newTask();
    const res = await app.request(`/v1/campaigns/${taskId}/dispatch-review`, as('art_director', { phone: '+10000000000' }));
    expect(res.status).not.toBe(403);
  });
});

describe('promotion writes as the caller (hunt-3)', () => {
  it('a non-administrator cannot name another tenant or user for the new task', async () => {
    for (const body of [
      { messageEventId: 'm1', tenantId: '00000000-0000-4000-a000-000000000007' },
      { messageEventId: 'm2', userId: '00000000-0000-4000-b000-000000000007' },
    ]) {
      const res = await app.request('/v1/ingress/promote', as('operator', body));
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
  });
});

describe('fault injection is for operators (hunt-3)', () => {
  it.each(['auditor', 'requester', 'designer', 'art_director'])('%s cannot trip or reset the Canva circuit breaker', async (role) => {
    for (const path of ['/v1/operations/canva/simulate-outage', '/v1/operations/canva/simulate-recovery']) {
      expect((await app.request(path, as(role))).status, path).toBe(403);
    }
  });
  it('an operator can', async () => {
    expect((await app.request('/v1/operations/canva/simulate-outage', as('operator'))).status).toBe(200);
    expect((await app.request('/v1/operations/canva/simulate-recovery', as('operator'))).status).toBe(200);
  });
});

describe('re-driving a design spends on it again (hunt-3)', () => {
  it.each(['auditor', 'requester', 'designer'])('%s cannot re-drive a task', async (role) => {
    const taskId = await newTask();
    expect((await app.request(`/v1/tasks/${taskId}/redrive`, as(role))).status).toBe(403);
  });
  it('an operator is not refused for the role', async () => {
    const taskId = await newTask();
    expect((await app.request(`/v1/tasks/${taskId}/redrive`, as('operator'))).status).not.toBe(403);
  });
});

describe('the Canva outcome notification is the worker\'s (hunt-3)', () => {
  // It records the task's outcome and messages the requester a Canva link.
  it.each(['auditor', 'requester', 'designer', 'art_director'])('%s cannot report an outcome', async (role) => {
    const res = await app.request('/v1/tasks/00000000-0000-4000-8000-0000000000aa/notifications/canva-status', as(role, { status: 'DRAFT_READY', designId: 'DAFabcd1234' }));
    expect(res.status).toBe(403);
  });
  it('the operator role (the design worker) is not refused for the role', async () => {
    const res = await app.request('/v1/tasks/00000000-0000-4000-8000-0000000000aa/notifications/canva-status', as('operator', { status: 'DRAFT_READY' }));
    expect(res.status).not.toBe(403);
  });
});

describe('the public WhatsApp health probe (hunt-3)', () => {
  // GET /waha/health is public (app.ts PUBLIC_READ_PATHS) for the uptime check; it answered every
  // anonymous caller with the office's WhatsApp group ids, its session name, the connected account
  // (WAHA's `me`: the office phone number) and the raw connection error.
  const GROUP = '120363000000000001@g.us';
  const ME = '9647500000000@c.us';
  async function probe(headers: Record<string, string>, fetchAnswer: () => Promise<Response>) {
    const saved = { groups: process.env.WAHA_ALLOWED_GROUPS, session: process.env.WAHA_OFFICE_SESSION, kill: process.env.WAHA_KILL_SWITCH };
    process.env.WAHA_ALLOWED_GROUPS = GROUP;
    process.env.WAHA_OFFICE_SESSION = 'office_session_name';
    process.env.WAHA_KILL_SWITCH = 'false';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => String(input).includes('/api/sessions/') ? fetchAnswer() : realFetch(input, init)) as typeof fetch;
    try {
      const res = await app.request('/v1/waha/health', { headers: { 'x-enforce-auth': 'true', ...headers } });
      return { status: res.status, text: await res.text() };
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of [['WAHA_ALLOWED_GROUPS', saved.groups], ['WAHA_OFFICE_SESSION', saved.session], ['WAHA_KILL_SWITCH', saved.kill]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }
  it('an anonymous caller gets the state, without group ids, the session, the account or the error', async () => {
    const working = await probe({}, async () => Response.json({ name: 'office_session_name', status: 'WORKING', me: { id: ME, pushName: 'Office' } }));
    expect(working.status).toBe(200);
    expect(JSON.parse(working.text).state).toBe('healthy');
    expect(working.text).not.toContain(GROUP);
    expect(working.text).not.toContain(ME);
    expect(working.text).not.toContain('office_session_name');
    const down = await probe({}, async () => { throw new Error('connect ECONNREFUSED http://waha.internal:3000'); });
    expect(JSON.parse(down.text).state).toBe('unavailable');
    expect(down.text).not.toMatch(/waha\.internal|ECONNREFUSED/);
    expect(down.text).not.toContain(GROUP);
  });
});
