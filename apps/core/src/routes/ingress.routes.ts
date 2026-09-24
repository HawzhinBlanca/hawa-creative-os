import type { RouteContext } from './types.js';
import crypto from 'node:crypto';
import { withRlsContext, IdempotencyConflictError } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { log } from '../logging.js';
import { taskFromRows } from '../services/task-reader.js';
import { refreshKillSwitches, setKillSwitch } from '../services/channel-kill-switches.js';

export function registerIngressRoutes(ctx: RouteContext) {
  const { registerRoute, unifiedIngress, channelKillSwitches, problem } = ctx;

  // Ingress Health & Channel Status. The switches are read from Postgres first: another Core may
  // have thrown one since this process last looked.
  registerRoute('get', '/ingress/status', async (c: any) => {
    try {
      await refreshKillSwitches(channelKillSwitches);
    } catch (err: unknown) {
      log.warn('[core:kill_switch] /ingress/status answers from this process\'s copy; PostgreSQL could not be read:', err instanceof Error ? err.message : err);
    }
    return c.json({
      status: 'active',
      channels: {
        telegram: !channelKillSwitches.telegram,
        waha: !channelKillSwitches.waha,
      },
      timestamp: new Date().toISOString(),
    }, 200);
  });

  // Channel Kill Switch Toggle
  registerRoute('post', '/ingress/channels/:channel/toggle', async (c: any) => {
    const channel = c.req.param('channel') as 'telegram' | 'waha';
    if (channel !== 'telegram' && channel !== 'waha') {
      return problem(c, 400, 'Invalid Channel', 'Supported channels are telegram and waha');
    }
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : channelKillSwitches[channel];
    // Answered only once Postgres has it, so the switch the office sees thrown survives a restart.
    try {
      await setKillSwitch(channelKillSwitches, channel, !enabled, ctx.verifyRequestAuth(c).actorId);
    } catch (err: unknown) {
      log.error(`[core:kill_switch] the ${channel} kill switch could not be saved:`, err instanceof Error ? err.message : err);
      return problem(c, 503, 'Kill switch not saved', `The ${channel} kill switch could not be saved to the database; it is unchanged. Try again.`);
    }
    // POST /waha/kill-switch also sets the environment's WhatsApp switch, which the webhook and
    // /waha/health read; follow it here, or a release through this toggle left WhatsApp refused.
    if (channel === 'waha') process.env.WAHA_KILL_SWITCH = enabled ? 'false' : 'true';
    return c.json({ channel, enabled, killSwitchActive: channelKillSwitches[channel] }, 200);
  });

  // Moved from createApp (architecture programme 1.3, G8): unified ingress and promotion.
  const { db, taskRepo, tasks, events, verifyRequestAuth, broadcastEvent: broadcast } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;

  // Unified Ingress Endpoint (CV-06, FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-010, FR-012)
  registerRoute('post', '/ingress/unified', async (c: any) => {
    // Only an authenticated adapter or operator may declare a verified inbound message.
    const ingressAuth = verifyRequestAuth(c);
    if (!ingressAuth.authenticated) return problem(c, 401, 'Unauthorized', 'Authentication required for unified ingress');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid JSON', 'Request body must be valid JSON');
    }

    if (!body.channel || !body.sourceAccountId || !body.sourceEventId || !body.sourceMessageId) {
      return problem(
        c,
        400,
        'Missing Required Ingress Fields',
        'channel, sourceAccountId, sourceEventId, and sourceMessageId are required'
      );
    }

    // The tenant comes from the credential. Only an administrator may address another tenant
    // (office bootstrap and fixtures); an operator always writes into their own tenant.
    const requestedTenant = typeof body.tenantId === 'string' && isValidUuid(body.tenantId) ? body.tenantId : null;
    const tenantId = ingressAuth.role === 'administrator' && requestedTenant
      ? requestedTenant
      : (ingressAuth.tenantId || '00000000-0000-4000-a000-000000000001');
    const result = await unifiedIngress.ingest({
      tenantId,
      channel: body.channel,
      sourceAccountId: body.sourceAccountId,
      sourceEventId: body.sourceEventId,
      sourceChannelId: body.sourceChannelId || body.sourceAccountId,
      sourceThreadId: body.sourceThreadId,
      sourceMessageId: body.sourceMessageId,
      sourceRevisionId: body.sourceRevisionId,
      senderExternalId: body.senderExternalId || 'anonymous',
      senderDisplayName: body.senderDisplayName,
      text: body.text || '',
      rawPayload: body.rawPayload || body,
      verified: true,
      verificationMethod: 'api_token',
      occurredAt: body.occurredAt,
      receivedAt: body.receivedAt,
      attachments: body.attachments || [],
      explicitClientId: body.explicitClientId,
      isTaskSubmission: body.isTaskSubmission,
      replyContext: body.replyContext,
    });

    const statusCode = result.isDuplicate ? 200 : 201;
    return c.json(result, statusCode);
  });

  // Explicit Promotion Endpoint (FR-010, SEC-04)
  registerRoute('post', '/ingress/promote', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for promotion');
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid JSON', 'Request body must be valid JSON');
    }

    const { messageEventId, clientId, title, description, priority } = body;
    if (!messageEventId) {
      return problem(c, 400, 'Missing Field', 'messageEventId is required');
    }

    const tenantId = (body.tenantId && isValidUuid(body.tenantId)) ? body.tenantId : (auth.tenantId || defaultTenantId);
    const userId = (body.userId && isValidUuid(body.userId)) ? body.userId : (auth.userId || operatorUserId);

    if (db && taskRepo) {
      try {
        const taskAggregate = await withRlsContext(
          db,
          { tenantId, userId, role: auth.role || 'operator' },
          async (trx) => {
            return await taskRepo.createTaskAggregate(
              {
                tenantId,
                userId,
                idempotencyKey: `promote_${messageEventId}`,
                title: title || 'Promoted Task from Message',
                description: description || '',
                clientId: clientId || null,
                priority: priority || 3,
                sourceMessageId: messageEventId,
                enqueueOutbox: true,
              },
              trx
            );
          }
        );
        return c.json({ ok: true, promoted: true, task: taskAggregate.task }, 201);
      } catch (err: any) {
        return problem(c, 500, 'Promotion Failed', err.message);
      }
    }

    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      tenantId,
      title: title || 'Promoted Task from Message',
      description: description || '',
      status: 'RECEIVED',
      state: 'received',
      sourceMessageId: messageEventId,
      clientId: clientId || null,
      createdAt: new Date().toISOString(),
    };
    tasks.set(taskId, task);
    return c.json({ ok: true, promoted: true, task }, 201);
  });

  // Promote Message
  registerRoute('post', '/messages/:messageId/promote', async (c: any) => {
    const messageId = c.req.param('messageId');
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = c.req.header('Idempotency-Key') || `promote_${messageId}`;

    // With a database the promoted task is written like any other, once per key. It was kept in this
    // process alone, where the Desk's list, another Core and a restart never found it.
    if (db && taskRepo) {
      const auth = verifyRequestAuth(c);
      const tenantId = auth.tenantId || defaultTenantId;
      if (body.clientId && !isValidUuid(body.clientId)) return problem(c, 400, 'Invalid Client Identifier', 'clientId must be a UUID');
      const source = { sourcePlatform: 'ingress_message', sourceEventId: messageId, sourceChannelId: 'message_adapter' };
      try {
        const { task, created } = await withRlsContext(db, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'operator' }, (trx) =>
          taskRepo.createTaskAggregate({
            tenantId,
            userId: auth.userId || operatorUserId,
            idempotencyKey,
            title: body.title || `Promoted from message ${messageId}`,
            description: body.description || '',
            clientId: body.clientId || null,
            projectId: isValidUuid(body.projectId) ? body.projectId : null,
            actorType: 'user',
            actorId: auth.actorId || 'operator',
            payload: source,
            enqueueOutbox: true,
          }, trx));
        const promoted = { ...taskFromRows(task, { created: { payload: source } }), idempotencyKey };
        if (created) broadcast('task:created', promoted);
        return c.json(promoted, created ? 201 : 200);
      } catch (err) {
        if (err instanceof IdempotencyConflictError) return problem(c, 409, 'Idempotency Conflict', 'This message was already promoted with different details');
        log.error('[core:promote] the promoted task could not be saved:', err);
        return problem(c, 503, 'Durable Storage Unavailable', 'The promoted task could not be saved; try again');
      }
    }

    // Without a database: deduplicate by idempotency key or source message event ID.
    for (const t of tasks.values()) {
      if (t.idempotencyKey === idempotencyKey || t.sourceEventId === messageId) {
        return c.json(t, 200);
      }
    }

    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      tenantId: 'tenant-default',
      clientId: body.clientId || null,
      projectId: body.projectId || null,
      title: body.title || `Promoted from message ${messageId}`,
      status: 'RECEIVED',
      priority: 'routine',
      sourcePlatform: 'ingress_message',
      sourceEventId: messageId,
      sourceChannelId: 'message_adapter',
      idempotencyKey: c.req.header('Idempotency-Key') || `promote_${messageId}`,
      clientScopeLocked: false,
      repairCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tasks.set(taskId, task);
    events.set(taskId, [
      {
        eventId: crypto.randomUUID(),
        taskId,
        fromStatus: null,
        toStatus: 'RECEIVED',
        actor: { type: 'user', id: 'operator' },
        reason: `Promoted message ${messageId}`,
        occurredAt: new Date().toISOString(),
      },
    ]);

    broadcast('task:created', task);

    return c.json(task, 201);
  });
}
