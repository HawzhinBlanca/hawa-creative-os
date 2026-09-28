import { describe, it, expect } from 'vitest';
import { createApp } from '../../../apps/core/src/app.js';

// The two checks that read app.ts's text for `registerAuthRoutes` and friends, and looked for the
// route files by name, are gone (architecture programme 1.3, step P): the route inventory in
// apps/core/test/route-inventory.test.ts asks the router what it serves, wherever a route lives.
describe('Task 4: app.ts Modular Route Decomposition', () => {
  it('verifies decomposed auth, client, and evals routes handle requests properly', async () => {
    const app = createApp();

    // Auth route verification
    const authRes = await app.request('/auth/session', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect(authRes.status).toBe(200);
    const authJson = await authRes.json();
    expect(authJson.authenticated).toBe(true);

    // Clients route verification
    const clientsRes = await app.request('/clients', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect([200, 204]).toContain(clientsRes.status);

    // Evals route verification
    const evalsRes = await app.request('/evaluations/runs', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect(evalsRes.status).toBe(503);
    expect((await evalsRes.json()).title).toBe('Evaluation Database Required');
  });
});
