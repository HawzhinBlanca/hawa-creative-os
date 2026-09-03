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
});
