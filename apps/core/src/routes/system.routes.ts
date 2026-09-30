import type { OperationsReliabilityReport } from '@hawa/contracts';
import type { RouteContext } from './types.js';
import { OutboxRepository, sql, withRlsContext, dbStatesForApiStatuses, toApiTaskStatus } from '@hawa/db';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { checkProductionFunnelHealth } from '../services/funnel-monitor.js';
// A function declaration, read only when a request arrives, so the import cycle with app.ts is harmless.
import { probeDatabase } from '../core-helpers.js';
import { ReceiptAuditService, ReceiptAuditError } from '../services/receipt-audits.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { SYSTEM_AUTOMATION_USER_ID, publicationAwareTaskStatus } from '@hawa/contracts';
import { log } from '../logging.js';
import { mayChangeKillSwitch, setKillSwitch, type KillSwitchChannel } from '../services/channel-kill-switches.js';
import { telegramPollerOf } from '../services/telegram-poller-owner.js';
import { readLegacyPathStatus } from '../services/legacy-path-status.js';
import { registerAvailabilityRoutes, availabilityConfig, AvailabilityError, readAvailabilityReport } from './availability.routes.js';

/**
 * A dead letter whose send may have reached its recipient: the outbox consumer's "uncertain" errors
 * (apps/worker/src/outbox-consumer.ts), and Core's own inline sends (canvaStatusHandler).
 */
const OUTBOX_UNCERTAIN_SEND = 'DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID|TIMEOUT_AFTER_SEND|KILL_AFTER_SEND|SOCKET_HANGUP_AFTER_WRITE';

export function registerSystemRoutes(ctx: RouteContext) {
  registerAvailabilityRoutes(ctx);
  const {
    app,
    db,
    registerRoute,
    honestHealthHandler,
    telegramBridge,
    subscribers,
    broadcastEvent,
    verifyRequestAuth,
    problem,
    channelKillSwitches,
    globalCanvaCircuitBreaker,
    handleDecommissionedFigmaRoute,
    ensureSessionLoaded,
    bearerTokenOf,
    streamTickets,
    paidModelHealth,
  } = ctx;

  const maskKey = (key?: string) => {
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  };

  // Health and readiness endpoints
  app.get('/health', honestHealthHandler);
  app.get('/v1/health', honestHealthHandler);
  // /ready is what Docker polls every 10 s. It was the full health handler, which asks Postgres
  // several questions and calls Restate, Canva's connection row, the cut-out service and Telegram:
  // load that grew with the office, and a container marked unhealthy because a dependency was slow.
  // It only says the process is up and answers, with one database ping at most. /health keeps the
  // whole picture for the watchdog, the deploy and the Desk. A Core without a database keeps its
  // state in memory only, so it is not ready.
  const readinessHandler = async (c: Context) => {
    const postgres = await probeDatabase(db);
    const ready = postgres === 'connected';
    return c.json({ status: ready ? 'ready' : 'not_ready', postgres, timestamp: new Date().toISOString() }, ready ? 200 : 503);
  };
  app.get('/ready', readinessHandler);
  app.get('/v1/ready', readinessHandler);

  // Production Funnel Health & Stall Detection (Step 5 of Engineering Rank Audit)
  registerRoute('get', '/system/funnel/health', async (c: any) => {
    const requestedWindow = Number(c.req.query('windowHours'));
    const windowHours = Number.isInteger(requestedWindow) && requestedWindow >= 1 && requestedWindow <= 168 ? requestedWindow : 48;
    const auth = verifyRequestAuth(c);
    const metrics = await checkProductionFunnelHealth(db, {
      tenantId: auth.tenantId,
      windowHours,
    });
    // A stalled funnel is a successfully read operational fact. Keep this GET readable by the
    // Desk; the status field, not an HTTP error, carries the alert. Unknown still fails closed.
    return c.json({ ok: metrics.status !== 'unknown', ...metrics }, metrics.status === 'unknown' ? 503 : 200);
  });

  const requireAdministrator = (c: any): Response | null => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !c.req.header('Authorization') && auth.authMethod !== 'trusted_office') {
      return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
    }
    if (auth.role !== 'administrator') return problem(c, 403, 'Administrator Required', 'Only an administrator may change Telegram delivery or inspect configuration');
    return null;
  };

  // Telegram Adapter Status & On-Demand Polling (FR-001, FR-002, Horizon 17 & 18)
  // The bot's name is not reported: only Telegram's getMe knows which bot a token belongs to, and
  // this public route does not call Telegram. GET /v1/system/providers/test-telegram does.
  registerRoute('get', '/adapters/telegram/status', (c: any) => {
    const status = telegramBridge?.getStatus() || { status: 'idle', mode: 'poll', pollingActive: false };
    return c.json({
      ok: true,
      bridge: status,
      activeStudio: 'canva',
      botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      // Which process asks Telegram for updates: core, or the worker (HAWA_TELEGRAM_POLLER, Phase 2.1).
      poller: telegramPollerOf(process.env),
    }, 200);
  });

  // "Poll now" (POST /adapters/telegram/poll-now) was removed with Core's poller by stage 2 of
  // ADR-135: the worker's poller is the bot's only getUpdates consumer.

  // Telegram Webhook Management (Horizon 17 / Option 2)
  // Re-pointing the bot's update stream is an administrator-only action: anyone able to call it
  // could redirect every office brief and approval to their own server.
  // Registration (POST /adapters/telegram/webhook/register) was removed by stage 2 of ADR-135: a
  // webhook would send every update past RequestLifecycle and stop the worker's getUpdates. Delete
  // stays, to clear a webhook set outside Hawa; info shows whether one is set.
  registerRoute('post', '/adapters/telegram/webhook/delete', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const dropPending = Boolean(body.dropPendingUpdates);
    const result = await telegramBridge.deleteWebhook(dropPending);
    return c.json({
      ok: result.ok,
      description: result.description,
      status: telegramBridge.getStatus(),
    }, result.ok ? 200 : 502);
  });

  registerRoute('get', '/adapters/telegram/webhook/info', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const info = await telegramBridge.getWebhookInfo();
    return c.json({
      ok: true,
      info,
      status: telegramBridge.getStatus(),
    }, 200);
  });

  // Cloud Figma Live Bridge Status (Decommissioned CV-23)
  const FIGMA_TOMBSTONES: Array<['get' | 'post' | 'delete', string]> = [
    ['get', '/adapters/figma/cloud-status'],
    ['post', '/tasks/:taskId/leases'],
    ['post', '/tasks/:taskId/figma/lease'],
    ['delete', '/tasks/:taskId/leases/:leaseId'],
    ['post', '/tasks/:taskId/figma/mutate'],
    ['get', '/tasks/:taskId/figma/status'],
    ['get', '/v1/figma/status'],
    ['get', '/figma/status'],
  ];
  for (const [method, path] of FIGMA_TOMBSTONES) {
    registerRoute(method, path, handleDecommissionedFigmaRoute);
  }

  // Dead-lettered outbox commands (state = failed) can be requeued by an administrator after the
  // cause recorded in last_error is fixed. Nothing is re-run silently; the response lists the ids.
  //
  // A send that may have arrived (DELIVERY_UNCERTAIN, TELEGRAM_RECEIPT_INVALID, the consumer's other
  // after-send failures) is dead-lettered so that it is never sent twice, and this route put it back
  // to pending with the rest, which deploy.sh suggests after every deploy (2026-09-24). Such a row is
  // requeued only when it is named in `ids` and `confirmUncertainReplay` is true, as the per-task
  // redrive asks; `{"all":true}` leaves it dead-lettered and lists it under `keptUncertain`.
  registerRoute('post', '/system/outbox/requeue', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!db) return problem(c, 503, 'Database Required', 'Outbox requeue requires durable storage');
    const body = await c.req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) : [];
    if (!ids.length && body.all !== true) return problem(c, 422, 'Nothing Selected', 'Pass {"ids":[…]} or {"all":true}');
    const replayUncertain = ids.length > 0 && body.confirmUncertainReplay === true;
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    const uncertain = sql<boolean>`coalesce(last_error, '') ~* ${OUTBOX_UNCERTAIN_SEND}`;
    const { rows, kept } = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, async (trx) => {
      let query = trx.updateTable('outbox_commands')
        .set({ state: 'pending', attempts: 0, available_at: new Date(), leased_until: null } as any)
        .where('state', '=', 'failed');
      if (ids.length) query = query.where('id', 'in', ids);
      if (!replayUncertain) query = query.where(sql<boolean>`NOT ${uncertain}`);
      const requeued = (await query.returning(['id', 'aggregate_id', 'command_type']).execute()) as Array<{ id: string; aggregate_id: string; command_type: string }>;
      // Only a confirmed replay lets the worker make a send that may already have arrived again; a
      // requeue alone restarts the command, and the worker still holds back such a send.
      if (replayUncertain && requeued.length) await new OutboxRepository(trx).releaseUncertainSends(tenantId, requeued.map((r) => r.id), trx);
      let keptQuery = trx.selectFrom('outbox_commands').select(['id', 'aggregate_id', 'command_type', 'last_error'])
        .where('state', '=', 'failed').where(uncertain);
      if (ids.length) keptQuery = keptQuery.where('id', 'in', ids);
      return { rows: requeued, kept: replayUncertain ? [] : await keptQuery.execute() };
    });
    return c.json({
      ok: true,
      requeued: rows.length,
      commands: rows,
      keptUncertain: kept,
      ...(kept.length ? { keptUncertainReason: 'These may already have reached their recipient. Check first, then name each in "ids" with "confirmUncertainReplay": true to send it again.' } : {}),
    }, 200);
  });

  // Real-time Server-Sent Events (SSE) Stream. A browser's EventSource cannot send a header, so the
  // Desk opens it with a one-use ticket (`?ticket=`, from POST /auth/stream-ticket) instead of its
  // session token, which it used to put in the address (ADR-037). A client that can send a header
  // still may. The route authenticates itself (registerRoute's SELF_AUTHENTICATED_READS in app.ts):
  // the ticket is the credential, and a ticket that is unknown, used or expired is refused outright,
  // never answered with whatever else the request carries.
  registerRoute('get', '/events/stream', async (c: any) => {
    const ticket = c.req.query('ticket');
    const credential = ticket !== undefined ? streamTickets?.redeem(ticket) : bearerTokenOf?.(c);
    if (ticket !== undefined && !credential) {
      return problem(c, 401, 'Authentication Required', 'This stream ticket is unknown, used or expired; ask for a new one');
    }
    // The credential is checked again on every heartbeat, from the database when the session cache is
    // due: a session revoked or expired while the stream is open closes it.
    const authOf = async () => {
      if (credential) await ensureSessionLoaded?.(credential);
      return ticket !== undefined ? verifyRequestAuth(c, credential) : verifyRequestAuth(c);
    };
    const auth = await authOf();
    if (!auth.authenticated) {
      return problem(c, 401, 'Authentication Required', 'Sign in to stream system events');
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      // The callback holds the response open until `ended` resolves; streamSSE closes it on return.
      let endStream: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        endStream = resolve;
      });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        subscribers.delete(subscriber as any);
        endStream();
      };

      const subscriber = (ev: { id: string; event: string; data: any }) => {
        if (closed) return;
        const isSystemEvent = ev.event?.startsWith('system:');
        if (!isSystemEvent) {
          const evTenantId = ev.data?.tenantId;
          const evClientId = ev.data?.clientId;
          const userTenantId = auth.tenantId;
          const userClientId = (auth as any).clientId;

          // Tenant isolation (fail-closed): if user is tenant-scoped, domain event MUST have matching tenantId
          if (userTenantId && auth.role !== 'superadmin') {
            if (!evTenantId) return; // Fail-closed: missing tenantId on domain event
            const isDefaultTenant = (t?: string) => t === 'tenant-default' || t === '00000000-0000-4000-a000-000000000001';
            const matchesTenant = evTenantId === userTenantId || (isDefaultTenant(evTenantId) && isDefaultTenant(userTenantId));
            if (!matchesTenant) return;
          }

          // Client isolation (fail-closed): if user is client-scoped, domain event MUST have matching clientId
          if (userClientId && auth.role !== 'superadmin' && auth.role !== 'administrator') {
            if (!evClientId) return; // Fail-closed: missing clientId on domain event
            if (evClientId !== userClientId) return;
          }
        }
        stream.writeSSE({
          id: ev.id,
          event: ev.event,
          data: JSON.stringify(ev.data),
        }).catch(finish);
      };

      subscribers.add(subscriber as any);

      // 1. Initial Handshake
      await stream.writeSSE({
        id: crypto.randomUUID(),
        event: 'system:connected',
        data: JSON.stringify({
          status: 'connected',
          timestamp: new Date().toISOString(),
          activeSubscribers: subscribers.size,
        }),
      });

      // 2. Heartbeat Ping every 15 seconds. A session revoked or expired since the stream opened ends
      // the response, not only the subscription: the browser's EventSource then reconnects, the ticket
      // request meets the 401 and the Desk shows sign-in. An open but silent stream would read as
      // "connected" to the Desk, which then neither polls nor signs out (ADR-037).
      heartbeat = setInterval(async () => {
        if (closed) return finish();
        const currentAuth = await authOf();
        if (closed) return;
        if (!currentAuth.authenticated) return finish();
        try {
          await stream.writeSSE({
            id: crypto.randomUUID(),
            event: 'system:ping',
            data: JSON.stringify({ ping: Date.now() }),
          });
        } catch {
          finish();
        }
      }, 15000);

      stream.onAbort(finish);
      await ended;
    });
  });

  // Operations Failures: the tasks Postgres marks for an operator, or as rejected, newest first. This
  // listed the tasks this process held in memory, so a task the worker failed, or any task after a
  // restart, was missing from the Desk's Ops screen.
  const failedStates = dbStatesForApiStatuses(['OPERATOR_REQUIRED', 'REJECTED']);
  registerRoute('get', '/operations/failures', async (c: Context) => {
    if (!db) return problem(c, 503, 'Database Unavailable', 'Task failures are read from PostgreSQL');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
    try {
      const { rows, total } = await withRlsContext(db, { tenantId, userId: auth.userId || SYSTEM_AUTOMATION_USER_ID, role: auth.role || 'operator' }, async (trx) => {
        const failed = trx.selectFrom('tasks').where('tenant_id', '=', tenantId).where('state', 'in', failedStates);
        const rows = await failed.select(['id', 'title', 'state', 'client_id', 'version', 'created_at', 'updated_at'])
          .orderBy('updated_at', 'desc').limit(200).execute();
        const counted = await failed.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
        return { rows, total: Number(counted?.n ?? 0) };
      });
      const items = rows.map((t) => ({
        id: t.id, title: t.title, status: toApiTaskStatus(t.state), state: t.state, clientId: t.client_id ?? undefined,
        version: Number(t.version), createdAt: iso(t.created_at), updatedAt: iso(t.updated_at),
      }));
      return c.json({ items, total });
    } catch (err) {
      log.error('[core:failures] Could not read the failed tasks:', err);
      return problem(c, 503, 'Database Unavailable', 'The failed tasks could not be read; try again');
    }
  });

  // What is still on the old Telegram path (ADR-135): open legacy Telegram tasks, Core requester
  // sends still queued and legacy Delivery workflow runs in flight. Stage 2 of the retirement has
  // merged, so this is a standing check that every count stays 0 (legacy-path-status.ts).
  // Read-only; administrators only.
  registerRoute('get', '/operations/legacy-path', async (c: Context) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!db) return problem(c, 503, 'Database Unavailable', 'The legacy path is read from PostgreSQL');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || DEFAULT_TENANT_ID;
    try {
      return c.json(await withRlsContext(db, { tenantId, userId: auth.userId || SYSTEM_AUTOMATION_USER_ID, role: 'operator' },
        (trx) => readLegacyPathStatus(trx, tenantId)));
    } catch (err) {
      log.error('[core:legacy-path] Could not read the legacy path:', err);
      return problem(c, 503, 'Database Unavailable', 'The legacy path could not be read; try again');
    }
  });

  // Integrations Health
  registerRoute('get', '/integrations/health', async (c: any) => {
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasWaha = Boolean(process.env.WAHA_API_KEY || process.env.WAHA_BASE_URL);
    const hasDrive = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_DRIVE_FOLDER_ID);
    const hasSheets = Boolean(process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    // Production names it PHOENIX_COLLECTOR_ENDPOINT (.env.production.example); both are accepted (ADR-159).
    const hasPhoenix = Boolean(process.env.PHOENIX_COLLECTOR_URL || process.env.PHOENIX_COLLECTOR_ENDPOINT);

    const canvaBreaker = globalCanvaCircuitBreaker?.getSnapshot();
    const observedAt = new Date().toISOString();
    // Other adapters have only local configuration/switch evidence. The model item uses a stored
    // paid observation; reading this endpoint never makes a provider call.
    const reported = (integrationId: string, kind: string, configured: boolean | null, blocked?: string) => ({
      integrationId,
      kind,
      state: blocked || (configured === null ? 'unknown' : configured ? 'configured' : 'unconfigured'),
      configured,
      reachability: 'unknown',
      paidVerification: 'not_run',
      lastVerifiedAt: null,
      checkedAt: observedAt,
      nextAction: blocked
        ? 'Review the local switch or failure before using this adapter.'
        : configured === false
          ? 'Complete server setup before using this adapter.'
          : 'Verify this adapter with a scoped real operation before relying on it.',
    });

    const model = await paidModelHealth();
    const configuredModel = Boolean(process.env.OPENAI_API_KEY);
    const reachedModel = ['connected', 'unauthorized', 'billing_exhausted', 'rate_limited', 'http_error'].includes(model.status);
    const modelItem = {
      integrationId: 'int_openai_model', kind: 'model_provider',
      state: model.status === 'connected' ? 'paid_verified' : model.status === 'unverified' ? 'configured' : model.status,
      configured: configuredModel,
      reachability: reachedModel ? 'reachable' : model.status === 'unreachable' ? 'unreachable' : 'unknown',
      paidVerification: model.status === 'connected' ? 'paid_verified' : model.status === 'stale' ? 'stale'
        : ['unknown','budget_held','reconciliation_required'].includes(model.status) ? 'unknown'
        : model.status === 'unverified' || model.status === 'unconfigured' ? 'not_run' : 'failed',
      lastVerifiedAt: model.status === 'connected' ? model.at : null,
      lastObservedAt: model.at,
      checkedAt: observedAt,
      callId: model.callId || null,
      spendingStatus: model.spendingStatus || null,
      nextAction: model.status === 'reconciliation_required' ? 'Review the held health probe in Operations call cost accounting. Record terminal provider evidence before another scheduled probe.'
        : model.status === 'budget_held' ? 'Review the shared spending policy, price policy or incomplete cost history in Operations. No probe was sent.'
        : model.status === 'connected' ? 'Monitor the next scheduled paid probe.'
        : model.status === 'unconfigured' ? 'Configure the model provider before using it.'
          : model.status === 'unverified' ? 'Enable and run the paid probe before relying on model health.'
            : model.status === 'stale' ? 'Check why the scheduled paid probe stopped running.'
              : 'Inspect the provider failure and retry a scoped paid probe.',
    };

    return c.json({
      items: [
        modelItem,
        reported('int_canva_studio', 'canva_native_studio', null, canvaBreaker?.state === 'OPEN' ? 'degraded' : undefined),
        reported('int_telegram', 'telegram', hasTelegram, channelKillSwitches?.telegram ? 'kill_switch_active' : undefined),
        reported('int_waha', 'waha', hasWaha, channelKillSwitches?.waha ? 'quarantined' : undefined),
        reported('int_google_drive', 'google_drive', hasDrive),
        reported('int_google_sheets', 'google_sheets', hasSheets),
        reported('int_phoenix', 'phoenix', hasPhoenix),
      ],
    });
  });

  // Fixture timings cannot establish monthly office availability (ADR-102).
  registerRoute('get', '/operations/slo', async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const config = availabilityConfig();
    if (!config && ['HAWA_AVAILABILITY_MONITOR_ID','HAWA_AVAILABILITY_TARGET_ORIGIN','HAWA_AVAILABILITY_MONITOR_SECRET'].some(key => process.env[key]))
      return problem(c, 503, 'Availability Monitor Misconfigured', 'Correct the monitor identity, origin and distinct credential before reading its observations.');
    if (config) {
      if (!db) return problem(c, 503, 'Availability Evidence Unavailable', 'Stored observations require PostgreSQL.');
      const auth = verifyRequestAuth(c);
      if (!auth.authenticated || !auth.tenantId || !auth.userId || !auth.role)
        return problem(c, 403, 'Office Identity Required', 'Active office membership is required.');
      try { return c.json(await readAvailabilityReport(db, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, config, c.req.query('month'))); }
      catch (error) {
        if (error instanceof AvailabilityError) return problem(c, error.status, 'Availability Evidence Refused', error.message);
        return problem(c, 503, 'Availability Evidence Unavailable', 'Stored observations could not be read.');
      }
    }
    const report: OperationsReliabilityReport = {
      schemaVersion: 1, evidenceKind: 'unmeasured', checkedAt: new Date().toISOString(),
      availability: { targetPercent: 99.5, window: 'calendar_month', timeZone: 'Asia/Baghdad',
        observedPercent: null, sloCompliant: null, observationCount: 0 },
      latency: { p50Ms: null, p95Ms: null, p99Ms: null, observationCount: 0 },
      nextAction: 'Collect independent availability observations for office intake and review before evaluating the monthly target.',
    };
    return c.json(report);
  });
  registerRoute('post', '/operations/slo/run', (c: any) => problem(c, 410,
    'Synthetic Operational Probe Retired',
    'Synthetic benchmarks remain in testkit. They cannot establish office availability or publish work through Operations.'));

  // Stored receipt snapshots only; source reads and append are one authorized transaction.
  const auditService = db ? new ReceiptAuditService(db) : null;
  const auditRequest = async (c: any, record: boolean) => {
    c.header('Cache-Control', 'no-store');
    if (!auditService) return problem(c, 503, 'Database Unavailable', 'Stored receipt audits require PostgreSQL.');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId || !auth.role)
      return problem(c, 403, 'RECEIPT_AUDIT_FORBIDDEN', 'An authorized office identity is required.');
    const actor = {tenantId:auth.tenantId,userId:auth.userId,role:auth.role};
    try {
      if (!record) return c.json(await auditService.get(actor,c.req.query('beforeRevision')));
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === 'object' && body.autoRepair === true)
        return problem(c,422,'Auto-Repair Not Available','This audit compares stored receipts and repairs nothing.');
      if (body && typeof body === 'object' && ('simulateDrift' in body || 'driveFiles' in body || 'sheetRows' in body))
        return problem(c,422,'Receipt Simulation Retired','Production audits use PostgreSQL records only. Fixture comparisons belong in testkit.');
      if (!body || c.req.header('Idempotency-Key') !== body.actionId)
        return problem(c,400,'RECEIPT_AUDIT_INVALID','Idempotency-Key must match the saved audit action ID.');
      const result = await auditService.record(actor,body);
      return c.json(result,result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReceiptAuditError) return problem(c,error.status,error.code,error.message);
      log.error('[core:reconciliation] Could not read or record the scoped audit:',error);
      return problem(c,503,'RECEIPT_AUDIT_UNAVAILABLE','The audit result is not available. Retry the exact saved action after access is restored.');
    }
  };
  registerRoute('get','/operations/reconciliation',(c: any)=>auditRequest(c,false));
  registerRoute('post','/operations/reconciliation/run',(c: any)=>auditRequest(c,true));

  // Operational Security & Outage Simulation (CV-20, FR-065, FR-071)
  // An administrator's switch, as POST /waha/kill-switch is: any signed-in role could release a switch
  // an administrator threw, and the answer came before Postgres had it, so a failed save was forgotten
  // by the next restart (audit 2026-09-27 #17, ported under ADR-127). The save is the same revisioned
  // write the intake toggle makes (ADR-054), and its changeTag is returned.
  registerRoute('post', '/operations/kill-switch', async (c: any) => {
    const denied = requireAdministrator(c);
    if (denied) return denied;
    const auth = verifyRequestAuth(c);
    const body = await c.req.json().catch(() => ({}));
    const { channel, active } = body;
    if (channel !== 'telegram' && channel !== 'waha') {
      return c.json({ error: 'Invalid channel (must be telegram or waha)' }, 400);
    }
    const ch = channel as KillSwitchChannel;
    // The same rule as the ingress toggle and POST /waha/kill-switch (ADR-128): this route used to
    // take any signed-in caller and let an art director release the administrator's WhatsApp switch.
    if (!mayChangeKillSwitch(ch, auth.role)) {
      return problem(c, 403, 'Forbidden', ch === 'waha'
        ? 'Administrator role required for the WhatsApp switch'
        : 'Only office operators may change the intake switch');
    }
    // Answered once PostgreSQL has it, like the toggle: the assignment it made before answered at
    // once and saved in the background.
    let changeTag: string | undefined;
    try {
      changeTag = await setKillSwitch(channelKillSwitches, ch, Boolean(active), auth.actorId);
    } catch (err: unknown) {
      log.error(`[core:kill_switch] the ${ch} kill switch could not be saved:`, err instanceof Error ? err.message : err);
      return problem(c, 503, 'Switch State Unconfirmed', `The ${ch} switch write or readback did not complete; inspect its persisted state before retrying.`);
    }
    // The webhook and /waha/health also read the environment's WhatsApp switch (as the toggle does).
    if (ch === 'waha') process.env.WAHA_KILL_SWITCH = active ? 'true' : 'false';
    broadcastEvent('operations:kill_switch_toggled', { channel: ch, active: channelKillSwitches[ch] });
    return c.json({ channel: ch, active: channelKillSwitches[ch], changeTag }, 200);
  });

  registerRoute('post', '/operations/canva/simulate-outage', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for fault injection');
    }
    globalCanvaCircuitBreaker.recordFailure();
    globalCanvaCircuitBreaker.recordFailure();
    globalCanvaCircuitBreaker.recordFailure();
    const snapshot = globalCanvaCircuitBreaker.getSnapshot();
    broadcastEvent('operations:canva_outage_simulated', snapshot);
    return c.json({ simulatedOutage: true, circuitBreaker: snapshot }, 200);
  });

  registerRoute('post', '/operations/canva/simulate-recovery', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for fault injection');
    }
    globalCanvaCircuitBreaker.reset();
    const snapshot = globalCanvaCircuitBreaker.getSnapshot();
    broadcastEvent('operations:canva_recovery_simulated', snapshot);
    return c.json({ simulatedRecovery: true, circuitBreaker: snapshot }, 200);
  });

  // System Providers
  // Reports whether each key is set in this process, and nothing else. A GET calls no provider, so
  // it cannot say a key works (POST verifies a key before activating it). Nothing in Core uses or
  // checks Google Application Default Credentials, so Gemini is configured only by GEMINI_API_KEY.
  // A missing key is reported as missing, not as a fallback: whether a caller degrades to a local
  // path depends on that caller, not on this setting.
  app.get('/v1/system/providers', (c: any) => {
    const authHeader = c.req.header('Authorization');
    const auth = verifyRequestAuth(c);
    if ((!authHeader && auth.authMethod !== 'trusted_office') || !auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to view system providers');
    }
    const isAdmin = auth.role === 'admin' || auth.role === 'administrator';
    const keyStatus = (name: string, envVar: string) => {
      const key = process.env[envVar];
      return key
        ? { name, envVar, configured: true, mode: 'API key set', preview: isAdmin ? maskKey(key) : 'configured (hidden)', status: 'KEY_SET' }
        : { name, envVar, configured: false, mode: 'Not configured', preview: 'Not configured', status: 'NOT_CONFIGURED' };
    };

    return c.json({
      ok: true,
      providers: {
        gemini: keyStatus('Google Gemini', 'GEMINI_API_KEY'),
        openai: keyStatus('OpenAI', 'OPENAI_API_KEY'),
        anthropic: keyStatus('Anthropic', 'ANTHROPIC_API_KEY'),
        telegram: keyStatus('Telegram Bot Adapter', 'TELEGRAM_BOT_TOKEN'),
        waha: {
          ...keyStatus('WAHA WhatsApp Bridge', 'WAHA_API_KEY'),
          endpoint: process.env.WAHA_ENDPOINT || 'http://127.0.0.1:3000',
        },
      },
      checked: 'key presence in this process only; no provider was called',
      envFile: 'infra/docker/.env.production (deploy-time; runtime overrides last until restart)',
    });
  });

  app.get('/v1/system/providers/test-telegram', async (c: any) => {
    const authHeader = c.req.header('Authorization');
    const auth = verifyRequestAuth(c);
    if ((!authHeader && auth.authMethod !== 'trusted_office') || !auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to test telegram connection');
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'replace_with_telegram_bot_token') {
      return c.json({ ok: false, message: 'Telegram bot token is not configured' });
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json();
      return c.json({ ok: res.ok, telegram: data });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message });
    }
  });

  // Provider credentials are deploy-time configuration. This route verifies a key against its
  // provider and activates it in this process only; it never writes a file. Until 2026-09-14 it
  // rewrote the mounted infra/docker/.env.production, which also let the test suite overwrite the
  // production Anthropic key with a fixture (the root cause of the model-provider 401s).
  app.post('/v1/system/providers', async (c: any) => {
    const authHeader = c.req.header('Authorization');
    const auth = verifyRequestAuth(c);
    if ((!authHeader && auth.authMethod !== 'trusted_office') || !auth.authenticated || auth.role !== 'administrator') {
      return problem(c, 401, 'Unauthorized', 'Administrator credentials required to update provider keys');
    }
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid JSON', 'Request body must be valid JSON');
    }
    const timeout = () => ({ signal: AbortSignal.timeout(10000) });
    const fields: Array<{ body: string; env: string; live: boolean; verify: (v: string) => Promise<string | null> }> = [
      { body: 'telegramBotToken', env: 'TELEGRAM_BOT_TOKEN', live: true, verify: async (v) => {
        const r = await fetch(`https://api.telegram.org/bot${v}/getMe`, timeout()); const d: any = await r.json().catch(() => ({}));
        return d?.ok ? null : `Telegram rejected the token (${d?.description || 'HTTP ' + r.status})`; } },
      { body: 'anthropicApiKey', env: 'ANTHROPIC_API_KEY', live: true, verify: async (v) => {
        const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' }, ...timeout() });
        return r.ok ? null : `Anthropic rejected the key (HTTP ${r.status})`; } },
      { body: 'geminiApiKey', env: 'GEMINI_API_KEY', live: true, verify: async (v) => {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}`, timeout());
        return r.ok ? null : `Google rejected the key (HTTP ${r.status})`; } },
      { body: 'openaiApiKey', env: 'OPENAI_API_KEY', live: true, verify: async (v) => {
        const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${v}` }, ...timeout() });
        return r.ok ? null : `OpenAI rejected the key (HTTP ${r.status})`; } },
      { body: 'wahaApiKey', env: 'WAHA_API_KEY', live: false, verify: async (v) => (v.length >= 8 ? null : 'WAHA API key is too short') },
      { body: 'wahaEndpoint', env: 'WAHA_ENDPOINT', live: false, verify: async (v) => (/^https?:\/\//.test(v) ? null : 'WAHA endpoint must be an http(s) URL') },
    ];
    // Fixture keys in test/local execution bypass remote provider validation; production sets verifyProviderKeys
    const isMockFixture = (v: string) => v.startsWith('mock-') || v.startsWith('test-') || v.startsWith('fixture-');
    const shouldVerify = (f: (typeof fields)[number], val: string) => {
      if (!f.live) return true;
      if (ctx.options?.verifyProviderKeys) return true;
      if (isMockFixture(val)) return false;
      return true;
    };
    const staged: Array<{ env: string; value: string }> = [];
    for (const f of fields) {
      const raw = body[f.body];
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;
      if (shouldVerify(f, value)) {
        let reason: string | null;
        try {
          reason = await f.verify(value);
        } catch (err: any) {
          reason = `could not reach the provider to verify it (${err?.name === 'TimeoutError' ? 'timeout' : err?.message || 'network error'})`;
        }
        if (reason) return problem(c, 422, 'PROVIDER_KEY_REJECTED', `${f.env}: ${reason}. Nothing was changed.`);
      }
      staged.push({ env: f.env, value });
    }
    for (const entry of staged) process.env[entry.env] = entry.value;
    if (staged.length) broadcastEvent('system:providers_updated', { timestamp: new Date().toISOString(), keys: staged.map((e) => e.env) });
    return c.json({
      ok: true,
      activated: staged.map((e) => e.env),
      persisted: false,
      message: staged.length
        ? 'Verified and active in this process until the next restart. To keep it across restarts run: bash infra/docker/rotate_external_secrets.sh (writes infra/docker/.env.production and redeploys).'
        : 'No provider values supplied; nothing changed.',
    });
  });
}
