import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';

describe('Adversarial Bug Hunt: Unauthenticated Route Escalations & Auth Gate Bypasses', () => {
  const originalEnv = { ...process.env };
  const testAdminKey = 'cfg_adm_secret_9988';
  const testOperatorToken = 'cfg_op_token_1122';

  beforeAll(() => {
    process.env.HAWA_ADMIN_KEY = testAdminKey;
    process.env.HAWA_BEARER_TOKEN = testOperatorToken;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const app = createApp();

  it('Bug 53: denies unauthenticated task control mutation (approve/cancel/pause) on POST /v1/tasks/:taskId/:control', async () => {
    // 1. Create a fixture task with valid operator auth
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testOperatorToken}`,
      },
      body: JSON.stringify({
        title: 'Unauthenticated Attack Vector Task',
        clientId: 'client-drustee',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const taskId = created.id;

    // 2. Adversary attempts to control or approve the task with NO credentials. The controls are four
    // explicit routes (SPLIT_PLAN F9), each behind the sign-in check; `approve` was never a control and
    // now matches no route at all, so it is refused as not found rather than as unauthenticated.
    for (const control of ['pause', 'resume', 'cancel', 'retry']) {
      const attackRes = await app.request(`/v1/tasks/${taskId}/${control}`, {
        method: 'POST',
        headers: {
          'x-enforce-auth': 'true',
        },
      });
      expect(attackRes.status, control).toBe(401);
    }
    const approveRes = await app.request(`/v1/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: {
        'x-enforce-auth': 'true',
      },
    });
    expect(approveRes.status).toBe(404);

    const after = await app.request(`/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${testOperatorToken}` } });
    expect((await after.json()).status).toBe(created.status);
  });

  it('Bug 54: denies unauthenticated omnichannel publication on POST /v1/tasks/:taskId/publish-omnichannel', async () => {
    const attackRes = await app.request('/v1/tasks/00000000-0000-4000-8000-000000000001/publish-omnichannel', {
      method: 'POST',
      headers: {
        'x-enforce-auth': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy: 'current_task' }),
    });

    // Unauthenticated publication must be rejected with 401
    expect(attackRes.status).toBe(401);
  });

  it('Bug 55: denies unauthenticated workflow control on POST /v1/tasks/:taskId/workflow/:action', async () => {
    const attackRes = await app.request('/v1/tasks/00000000-0000-4000-8000-000000000001/workflow/cancel', {
      method: 'POST',
      headers: {
        'x-enforce-auth': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Malicious cancel' }),
    });

    // Unauthenticated workflow state manipulation must be rejected with 401
    expect(attackRes.status).toBe(401);
  });

  it('Bug 56: denies unauthenticated snapshot commit on POST /v1/clients/:clientId/snapshots', async () => {
    const attackRes = await app.request('/v1/clients/client-drustee/snapshots', {
      method: 'POST',
      headers: {
        'x-enforce-auth': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commitMessage: 'Malicious forged governance snapshot',
        createdBy: 'unauthenticated_attacker',
      }),
    });

    // Unauthenticated governance mutation must be rejected with 401
    expect(attackRes.status).toBe(401);
  });

  it('Bug 57: denies unauthenticated budget inspection on GET /v1/clients/budgets and GET /v1/clients/:clientId/budget', async () => {
    const listRes = await app.request('/v1/clients/budgets', {
      headers: {
        'x-enforce-auth': 'true',
      },
    });
    expect(listRes.status).toBe(401);

    const detailRes = await app.request('/v1/clients/client-drustee/budget', {
      headers: {
        'x-enforce-auth': 'true',
      },
    });
    expect(detailRes.status).toBe(401);
  });

  it('Bug 58: denies unauthenticated access to migration ledger, ops failures, and asset directory', async () => {
    const ledgerRes = await app.request('/v1/migration/ledger', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(ledgerRes.status).toBe(401);

    const failuresRes = await app.request('/v1/operations/failures', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(failuresRes.status).toBe(401);

    const assetsRes = await app.request('/v1/assets', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(assetsRes.status).toBe(401);

    const evalsRes = await app.request('/v1/evaluations/runs', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(evalsRes.status).toBe(401);

    const casesRes = await app.request('/v1/evaluations/datasets/brief/cases', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(casesRes.status).toBe(401);

    const lineageRes = await app.request('/v1/clients/client-drustee/learning/data-lineage', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(lineageRes.status).toBe(401);

    const rulesRes = await app.request('/v1/clients/client-drustee/candidate-rules', {
      headers: { 'x-enforce-auth': 'true' },
    });
    expect(rulesRes.status).toBe(401);
  });
});
