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
