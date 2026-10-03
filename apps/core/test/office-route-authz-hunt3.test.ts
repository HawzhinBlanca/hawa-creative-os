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
