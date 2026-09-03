import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Core API: Ingress & Task Lifecycle', () => {
  const app = createApp();

  it('responds to health checks', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('healthy');
  });

  it('rejects unauthenticated telegram webhook', async () => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts authenticated telegram webhook and creates task', async () => {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 101,
        message: { text: 'New poster request', chat: { id: 777 } },
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task.status).toBe('RECEIVED');
  });

  it('deduplicates identical incoming event', async () => {
    const payload = JSON.stringify({
      update_id: 102,
      message: { text: 'Duplicate test', chat: { id: 777 } },
    });
    const res1 = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    expect(res1.status).toBe(201);

    const res2 = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const json = await res2.json();
    expect(json.duplicate).toBe(true);
  });

  it('creates task via Desk API with Idempotency-Key', async () => {
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'desk-key-123',
      },
      body: JSON.stringify({
        title: 'Spring Campaign Poster',
        description: 'Design promo poster for Instagram',
      }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.idempotencyKey).toBe('desk-key-123');

    // Replay returns same task
    const resReplay = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'desk-key-123',
      },
      body: JSON.stringify({
        title: 'Spring Campaign Poster',
      }),
    });
    expect(resReplay.status).toBe(200);
    const replayTask = await resReplay.json();
    expect(replayTask.id).toBe(task.id);
  });

  it('executes end-to-end task progression: route -> brief -> generate -> decide -> publish', async () => {
    // 1. Create task
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Year Campaign' }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    const taskId = task.id;

    // 2. Route task (lock client scope)
    const routeRes = await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-office-1', reason: 'Client assigned' }),
    });
    expect(routeRes.status).toBe(202);
    const routeReceipt = await routeRes.json();
    expect(routeReceipt.commandId).toBeDefined();

    // 3. Create brief
    const briefRes = await app.request(`/v1/tasks/${taskId}/briefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'New Year Promo',
        rawRequestText: 'داشکاندنی ٢٥٪ تا ١٠ی مانگ',
        primaryLanguage: 'ckb',
        direction: 'rtl',
      }),
    });
    expect(briefRes.status).toBe(201);
    const brief = await briefRes.json();
    expect(brief.direction).toBe('rtl');
    expect(brief.exactCopy[0].protectedTokens.length).toBeGreaterThan(0);

    // 4. Generate design
    const genRes = await app.request(`/v1/tasks/${taskId}/generate`, {
      method: 'POST',
    });
    expect(genRes.status).toBe(202);

    // Check task state is AWAITING_APPROVAL
    const taskCheck = await app.request(`/v1/tasks/${taskId}`);
    const currentTask = await taskCheck.json();
    expect(currentTask.status).toBe('AWAITING_APPROVAL');
    expect(currentTask.latestRevisionId).toBeDefined();

    // 5. Decide (Approve)
    const approveRes = await app.request(`/v1/tasks/${taskId}/revisions/${currentTask.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: 'approved',
        reviewerId: 'art_director_1',
      }),
    });
    expect(approveRes.status).toBe(201);

    // 6. Publish task
    const pubRes = await app.request(`/v1/tasks/${taskId}/publish`, {
      method: 'POST',
    });
    expect(pubRes.status).toBe(202);

    const completedCheck = await app.request(`/v1/tasks/${taskId}`);
    const completedTask = await completedCheck.json();
    expect(completedTask.status).toBe('COMPLETE');

    // 7. Check timeline
    const timelineRes = await app.request(`/v1/tasks/${taskId}/timeline`);
    const timeline = await timelineRes.json();
    expect(timeline.events.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces repair budget of max 2 cycles on revision requests', async () => {
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Revision Test' }),
    });
    const { id: taskId } = await createRes.json();

    // Route and Generate
    await app.request(`/v1/tasks/${taskId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-office-1' }),
    });
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });

    const revCheck = await app.request(`/v1/tasks/${taskId}`);
    const { latestRevisionId } = await revCheck.json();

    // Revision 1
    const rev1 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Fix colors' } }),
    });
    expect(rev1.status).toBe(201);
    let taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('REVISION_REQUESTED');

    // Transition back to AWAITING_APPROVAL
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });

    // Revision 2
    const rev2 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Fix alignment' } }),
    });
    expect(rev2.status).toBe(201);
    taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('REVISION_REQUESTED');

    // Transition back to AWAITING_APPROVAL
    await app.request(`/v1/tasks/${taskId}/generate`, { method: 'POST' });

    // Revision 3 (exceeds budget -> OPERATOR_REQUIRED)
    const rev3 = await app.request(`/v1/tasks/${taskId}/revisions/${latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'revision_requested', revisionRequest: { comment: 'Still bad' } }),
    });
    expect(rev3.status).toBe(201);
    taskState = await (await app.request(`/v1/tasks/${taskId}`)).json();
    expect(taskState.status).toBe('OPERATOR_REQUIRED');
  });

  it('provides client DNA, integrations health, and evaluations API', async () => {
    // Client DNA
    const dnaRes = await app.request('/v1/clients/client-office-1/dna');
    expect(dnaRes.status).toBe(200);
    const dna = await dnaRes.json();
    expect(dna.name).toBe('Hawa Creative');

    // Integrations Health
    const healthRes = await app.request('/v1/integrations/health');
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.items.length).toBe(6);

    // Operations Failures
    const failRes = await app.request('/v1/operations/failures');
    expect(failRes.status).toBe(200);
  });
});
