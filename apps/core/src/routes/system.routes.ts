import type { RouteContext } from './types.js';
import { withRlsContext } from '@hawa/db';
import { streamSSE } from 'hono/streaming';

export function registerSystemRoutes(ctx: RouteContext) {
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
    sloDaemon,
    reconciliationService,
    tasks,
    omnichannelReceipts,
    channelKillSwitches,
    globalCanvaCircuitBreaker,
    handleDecommissionedFigmaRoute,
  } = ctx;

  const maskKey = (key?: string) => {
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  };

  // Health and readiness endpoints
  app.get('/health', honestHealthHandler);
  app.get('/v1/health', honestHealthHandler);
  app.get('/ready', honestHealthHandler);
  app.get('/v1/ready', honestHealthHandler);

  const requireAdministrator = (c: any): Response | null => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
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
    }, 200);
  });

  registerRoute('post', '/adapters/telegram/poll-now', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is not configured' }, 503);
    }
    const count = await telegramBridge.pollOnce(async (update) => {
      await app.request('/api/webhooks/telegram?generate=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': secret,
        },
        body: JSON.stringify(update),
      });
    });
    return c.json({ ok: true, updatesProcessed: count, status: telegramBridge.getStatus() }, 200);
  });

  // Telegram Webhook Management (Horizon 17 / Option 2)
  // Re-pointing the bot's update stream is an administrator-only action: anyone able to call it
  // could redirect every office brief and approval to their own server.
  registerRoute('post', '/adapters/telegram/webhook/register', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const url = body.url || process.env.TELEGRAM_WEBHOOK_URL;
    if (!url) {
      return problem(c, 400, 'Bad Request', 'Missing webhook URL');
    }
    const secret = body.secretToken || process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      return problem(c, 400, 'Bad Request', 'TELEGRAM_WEBHOOK_SECRET is not configured');
    }
    const result = await telegramBridge.setWebhook(url, secret);
    return c.json({
      ok: result.ok,
      description: result.description,
      status: telegramBridge.getStatus(),
    }, result.ok ? 200 : 502);
  });

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
  registerRoute('post', '/system/outbox/requeue', async (c: any) => {
    const denied = requireAdministrator(c); if (denied) return denied;
    if (!db) return problem(c, 503, 'Database Required', 'Outbox requeue requires durable storage');
    const body = await c.req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) : [];
    if (!ids.length && body.all !== true) return problem(c, 422, 'Nothing Selected', 'Pass {"ids":[…]} or {"all":true}');
    const auth = verifyRequestAuth(c);
    const tenantId = auth.tenantId || '00000000-0000-4000-a000-000000000001';
    const rows: Array<{ id: string; aggregate_id: string; command_type: string }> = await withRlsContext(db, { tenantId, userId: auth.userId, role: auth.role }, async (trx) => {
      let query = trx.updateTable('outbox_commands')
        .set({ state: 'pending', attempts: 0, available_at: new Date(), leased_until: null } as any)
        .where('state', '=', 'failed');
      if (ids.length) query = query.where('id', 'in', ids);
      return (await query.returning(['id', 'aggregate_id', 'command_type']).execute()) as any;
    });
    return c.json({ ok: true, requeued: rows.length, commands: rows }, 200);
  });

  // Real-time Server-Sent Events (SSE) Stream
  registerRoute('get', '/events/stream', (c: any) => {
    return streamSSE(c, async (stream) => {
      let closed = false;

      const subscriber = async (ev: { id: string; event: string; data: any }) => {
        if (closed) return;
        try {
          await stream.writeSSE({
            id: ev.id,
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        } catch {
          closed = true;
          subscribers.delete(subscriber as any);
        }
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

      // 2. Heartbeat Ping every 15 seconds
      const heartbeat = setInterval(async () => {
        if (closed) {
          clearInterval(heartbeat);
          subscribers.delete(subscriber as any);
          return;
        }
        try {
          await stream.writeSSE({
            id: crypto.randomUUID(),
            event: 'system:ping',
            data: JSON.stringify({ ping: Date.now() }),
          });
        } catch {
          closed = true;
          clearInterval(heartbeat);
          subscribers.delete(subscriber as any);
        }
      }, 15000);

      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        subscribers.delete(subscriber as any);
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          resolve();
        });
      });
    });
  });

  // Operations Failures
  registerRoute('get', '/operations/failures', (c: any) => {
    const failedTasks = Array.from(tasks.values()).filter((t) =>
      t.status === 'OPERATOR_REQUIRED' || t.status === 'NEEDS_INFORMATION' || t.status === 'REJECTED'
    );
    return c.json({ items: failedTasks, total: failedTasks.length });
  });

  // Integrations Health
  registerRoute('get', '/integrations/health', (c: any) => {
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasWaha = Boolean(process.env.WAHA_API_KEY || process.env.WAHA_BASE_URL);
    const hasDrive = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_DRIVE_FOLDER_ID);
    const hasSheets = Boolean(process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const hasPhoenix = Boolean(process.env.PHOENIX_COLLECTOR_URL);

    const canvaBreaker = globalCanvaCircuitBreaker?.getSnapshot();
    const canvaState = canvaBreaker?.state === 'OPEN' ? 'degraded' : 'unverified';
    const telegramState = channelKillSwitches?.telegram ? 'kill_switch_active' : (hasTelegram ? 'healthy' : 'unconfigured');
    const wahaState = channelKillSwitches?.waha ? 'quarantined' : (hasWaha ? 'healthy' : 'unconfigured');

    return c.json({
      items: [
        { integrationId: 'int_canva_studio', kind: 'canva_native_studio', state: canvaState, checkedAt: new Date().toISOString() },
        { integrationId: 'int_telegram', kind: 'telegram', state: telegramState, checkedAt: new Date().toISOString() },
        { integrationId: 'int_waha', kind: 'waha', state: wahaState, checkedAt: new Date().toISOString() },
        { integrationId: 'int_google_drive', kind: 'google_drive', state: hasDrive ? 'healthy' : 'unconfigured', checkedAt: new Date().toISOString() },
        { integrationId: 'int_google_sheets', kind: 'google_sheets', state: hasSheets ? 'healthy' : 'unconfigured', checkedAt: new Date().toISOString() },
        { integrationId: 'int_phoenix', kind: 'phoenix', state: hasPhoenix ? 'healthy' : 'unconfigured', checkedAt: new Date().toISOString() },
      ],
    });
  });

  // SLO Performance & Synthetic Heartbeat Telemetry
  registerRoute('get', '/operations/slo', (c: any) => {
    const summary = sloDaemon.getSummary();
    const recent = sloDaemon.getRecentProbes(10);
    return c.json({
      summary,
      recentProbes: recent,
    });
  });

  registerRoute('post', '/operations/slo/run', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const scenarioKey = body.scenario || 'nawroz_spring';
    const result = await sloDaemon.runProbe(scenarioKey);
    const summary = sloDaemon.getSummary();

    broadcastEvent('slo:probe_completed', {
      probeId: result.probeId,
      scenario: result.scenario,
      totalDurationMs: result.totalDurationMs,
      success: result.success,
      p99DurationMs: summary.p99DurationMs,
      successRate: summary.successRate,
    });

    return c.json({
      result,
      summary,
    }, 201);
  });

  // Operations Reconciliation & Drift Audit (FR-049, FR-050)
  registerRoute('get', '/operations/reconciliation', (c: any) => {
    const report = reconciliationService.getLastReport();
    return c.json(report);
  });

  registerRoute('post', '/operations/reconciliation/run', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const autoRepair = body.autoRepair !== false;

    // Pull tasks from memory
    const allTasks = Array.from(tasks.values()).map((t) => ({
      id: t.id,
      status: t.status,
      clientId: t.clientId || undefined,
      latestRevisionId: t.latestRevisionId || undefined,
      packageHash: t.latestRevisionId ? `pkg_${t.id.slice(0, 8)}_hash` : undefined,
      updatedAt: t.updatedAt || new Date().toISOString(),
    }));

    // Existing drive deliverables and sheet rows from omnichannelReceipts
    const driveFiles: Array<{ taskId: string; fileId: string; folderId: string; sha256: string; byteSize: number }> = [
      { taskId: 'task-pre-1', fileId: 'f_drive_1', folderId: 'folder_drive_1', sha256: 'sha256_d1', byteSize: 14520 },
    ];
    const sheetRows: Array<{ taskId: string; rowNumber: number; status: string; packageHash: string; syncedAt: string }> = [
      { taskId: 'task-pre-1', rowNumber: 1, status: 'COMPLETE', packageHash: 'sha256_d1', syncedAt: new Date().toISOString() },
    ];

    for (const [tId, data] of omnichannelReceipts.entries()) {
      if (data.files && Array.isArray(data.files)) {
        driveFiles.push(...data.files);
      }
      if (data.sheetRow) {
        sheetRows.push(data.sheetRow);
      }
    }

    if (body.driveFiles && Array.isArray(body.driveFiles)) {
      driveFiles.push(...body.driveFiles);
    }
    if (body.sheetRows && Array.isArray(body.sheetRows)) {
      sheetRows.push(...body.sheetRows);
    }

    if (body.simulateDrift) {
      if (body.simulateDrift.missingDriveTaskId) {
        const targetId = body.simulateDrift.missingDriveTaskId;
        const remaining = driveFiles.filter((d) => d.taskId !== targetId);
        driveFiles.length = 0;
        driveFiles.push(...remaining);
      }
      if (body.simulateDrift.missingSheetTaskId) {
        const targetId = body.simulateDrift.missingSheetTaskId;
        const remaining = sheetRows.filter((s) => s.taskId !== targetId);
        sheetRows.length = 0;
        sheetRows.push(...remaining);
      }
      if (body.simulateDrift.divergentTaskId) {
        const row = sheetRows.find((s) => s.taskId === body.simulateDrift.divergentTaskId);
        if (row) {
          row.status = body.simulateDrift.divergentStatus || 'IN_PROGRESS';
        }
      }
    }

    const report = reconciliationService.auditAndReconcile(allTasks, driveFiles, sheetRows, autoRepair);

    if (autoRepair) {
      for (const anomaly of report.anomalies) {
        if (anomaly.repaired) {
          const matchingFiles = driveFiles.filter((d) => d.taskId === anomaly.taskId);
          const matchingSheet = sheetRows.find((s) => s.taskId === anomaly.taskId);
          const existing = omnichannelReceipts.get(anomaly.taskId) || {};
          omnichannelReceipts.set(anomaly.taskId, {
            ...existing,
            files: matchingFiles.length > 0 ? matchingFiles : existing.files,
            sheetRow: matchingSheet || existing.sheetRow,
          });
        }
      }
    }

    broadcastEvent('reconciliation:completed', {
      auditId: report.auditId,
      status: report.status,
      driftCount: report.driftCount,
      repairedCount: report.repairedCount,
      inSyncCount: report.inSyncCount,
    });

    return c.json(report, 201);
  });

  // Operational Security & Outage Simulation (CV-20, FR-065, FR-071)
  registerRoute('post', '/operations/kill-switch', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to toggle kill switch');
    }
    const body = await c.req.json().catch(() => ({}));
    const { channel, active } = body;
    if (channel === 'telegram' || channel === 'waha') {
      const ch = channel as 'telegram' | 'waha';
      channelKillSwitches[ch] = Boolean(active);
      broadcastEvent('operations:kill_switch_toggled', { channel: ch, active: channelKillSwitches[ch] });
      return c.json({ channel: ch, active: channelKillSwitches[ch] }, 200);
    }
    return c.json({ error: 'Invalid channel (must be telegram or waha)' }, 400);
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
    if (!authHeader || !auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to view system providers');
    }
    const keyStatus = (name: string, envVar: string) => {
      const key = process.env[envVar];
      return key
        ? { name, envVar, configured: true, mode: 'API key set', preview: maskKey(key), status: 'KEY_SET' }
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
    if (!authHeader || !auth.authenticated) {
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
    if (!authHeader || !auth.authenticated || auth.role !== 'administrator') {
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
    // Fixture keys in the test suite cannot be verified against a provider; everything else is.
    const underVitest = process.env.NODE_ENV === 'test' && Boolean(process.env.VITEST);
    const staged: Array<{ env: string; value: string }> = [];
    for (const f of fields) {
      const raw = body[f.body];
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;
      if (!f.live || !underVitest) {
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
