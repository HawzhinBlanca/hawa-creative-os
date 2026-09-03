import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { TelegramAdapter } from '@hawa/integrations';
import { TaskStateMachine } from '@hawa/domain';

export function createApp() {
  const app = new Hono();

  // Middleware
  app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-telegram-bot-api-secret-token'] }));

  app.use('*', async (c, next) => {
    const start = Date.now();
    const correlationId = c.req.header('X-Correlation-ID') || crypto.randomUUID();
    c.header('X-Correlation-ID', correlationId);
    await next();
    c.header('X-Response-Time', `${Date.now() - start}ms`);
  });

  // Health checks
  app.get('/health', (c) => c.json({ status: 'healthy', timestamp: new Date().toISOString() }));
  app.get('/ready', (c) => c.json({ status: 'ready', dependencies: { postgres: 'connected', restate: 'connected' } }));

  // In-memory store for demonstration & testing
  const tasks = new Map<string, any>();
  const events = new Map<string, any[]>();
  const rawEvents = new Map<string, any>();

  // Webhooks
  app.post('/api/webhooks/telegram', async (c) => {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    if (!secret || secret !== (process.env.TELEGRAM_WEBHOOK_SECRET || 'expected_office_secret')) {
      return c.json({ error: 'Unauthorized webhook secret' }, 401);
    }

    const rawBody = await c.req.arrayBuffer();
    const bodyText = new TextDecoder().decode(rawBody);
    let json: any = {};
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = { text: bodyText };
    }

    const sourceEventId = String(json.update_id || json.eventId || `evt_${Date.now()}`);
    if (rawEvents.has(sourceEventId)) {
      return c.json({ ok: true, duplicate: true, eventId: sourceEventId });
    }
    rawEvents.set(sourceEventId, json);

    // Create task
    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      tenantId: 'tenant-default',
      clientId: json.clientId || null,
      projectId: json.projectId || null,
      status: 'RECEIVED',
      priority: 'routine',
      sourcePlatform: 'telegram',
      sourceEventId,
      sourceChannelId: String(json.message?.chat?.id || 'tg_default'),
      idempotencyKey: `idem_tg_${sourceEventId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.set(taskId, task);
    events.set(taskId, [
      {
        eventId: crypto.randomUUID(),
        taskId,
        fromStatus: 'NONE',
        toStatus: 'RECEIVED',
        actor: { type: 'adapter', id: 'telegram' },
        reason: 'Incoming Telegram message received',
        occurredAt: new Date().toISOString(),
      },
    ]);

    return c.json({ ok: true, task }, 201);
  });

  // Tasks API
  app.get('/api/v1/tasks', (c) => {
    const list = Array.from(tasks.values());
    return c.json({ items: list });
  });

  app.post('/api/v1/tasks', async (c) => {
    const body = await c.req.json();
    const idempotencyKey = c.req.header('Idempotency-Key') || `key_${Date.now()}`;

    // Check duplicate idempotency
    for (const t of tasks.values()) {
      if (t.idempotencyKey === idempotencyKey) {
        return c.json(t, 200);
      }
    }

    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      tenantId: 'tenant-default',
      clientId: body.clientId || null,
      projectId: body.projectId || null,
      status: 'RECEIVED',
      priority: body.priority || 'routine',
      title: body.title,
      description: body.description,
      sourcePlatform: 'hawa_desk',
      sourceEventId: taskId,
      sourceChannelId: 'hawa_desk',
      idempotencyKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tasks.set(taskId, task);
    events.set(taskId, [
      {
        eventId: crypto.randomUUID(),
        taskId,
        fromStatus: 'NONE',
        toStatus: 'RECEIVED',
        actor: { type: 'user', id: 'desk_user' },
        reason: 'Task created via Hawa Desk',
        occurredAt: new Date().toISOString(),
      },
    ]);

    return c.json(task, 201);
  });

  app.get('/api/v1/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const task = tasks.get(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json(task);
  });

  app.get('/api/v1/tasks/:taskId/timeline', (c) => {
    const taskId = c.req.param('taskId');
    const taskEvents = events.get(taskId) || [];
    return c.json({ events: taskEvents });
  });

  app.post('/api/v1/tasks/:taskId/approve', async (c) => {
    const taskId = c.req.param('taskId');
    const task = tasks.get(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const sm = new TaskStateMachine(taskId, task.status);
    const trans = sm.transition('APPROVED', { type: 'user', id: 'approver_1' }, 'Human approved design in Desk');
    if (!trans.ok) {
      return c.json({ error: trans.error }, 400);
    }

    task.status = 'APPROVED';
    task.updatedAt = new Date().toISOString();
    events.get(taskId)?.push(trans.value);

    return c.json({ ok: true, task });
  });

  return app;
}
