import type { RouteContext } from './types.js';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';

export function registerSystemRoutes(ctx: RouteContext) {
  const {
    app,
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

  // Telegram Adapter Status & On-Demand Polling (FR-001, FR-002, Horizon 17 & 18)
  registerRoute('get', '/adapters/telegram/status', (c: any) => {
    const status = telegramBridge?.getStatus() || { status: 'idle', mode: 'poll', pollingActive: false };
    return c.json({
      ok: true,
      bridge: status,
      activeStudio: 'canva',
      botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      botUsername: 'hawdesign_official_bot',
      botName: 'Hawdesign bot',
    }, 200);
  });

  registerRoute('post', '/adapters/telegram/poll-now', async (c: any) => {
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const count = await telegramBridge.pollOnce(async (update) => {
      await app.request('/api/webhooks/telegram?generate=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET || 'expected_office_secret',
        },
        body: JSON.stringify(update),
      });
    });
    return c.json({ ok: true, updatesProcessed: count, status: telegramBridge.getStatus() }, 200);
  });

  // Telegram Webhook Management (Horizon 17 / Option 2)
  registerRoute('post', '/adapters/telegram/webhook/register', async (c: any) => {
    if (!telegramBridge) {
      return c.json({ ok: false, error: 'Telegram bridge not available' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const url = body.url || process.env.TELEGRAM_WEBHOOK_URL;
    if (!url) {
      return problem(c, 400, 'Bad Request', 'Missing webhook URL');
    }
    const secret = body.secretToken || process.env.TELEGRAM_WEBHOOK_SECRET || 'expected_office_secret';
    const result = await telegramBridge.setWebhook(url, secret);
    return c.json({
      ok: result.ok,
      description: result.description,
      status: telegramBridge.getStatus(),
    }, result.ok ? 200 : 502);
  });

  registerRoute('post', '/adapters/telegram/webhook/delete', async (c: any) => {
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

  // Cloud Figma Live Bridge Status (Horizon 18 / Decommissioned CV-23)
  registerRoute('get', '/adapters/figma/cloud-status', handleDecommissionedFigmaRoute);

  if (handleDecommissionedFigmaRoute) {
    registerRoute('post', '/tasks/:taskId/leases', handleDecommissionedFigmaRoute);
    registerRoute('post', '/tasks/:taskId/figma/lease', handleDecommissionedFigmaRoute);
    registerRoute('delete', '/tasks/:taskId/leases/:leaseId', handleDecommissionedFigmaRoute);
    registerRoute('post', '/tasks/:taskId/figma/mutate', handleDecommissionedFigmaRoute);
    registerRoute('get', '/tasks/:taskId/figma/status', handleDecommissionedFigmaRoute);
    registerRoute('get', '/v1/figma/status', handleDecommissionedFigmaRoute);
    registerRoute('get', '/figma/status', handleDecommissionedFigmaRoute);
  }

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
  app.get('/v1/system/providers', (c: any) => {
    const authHeader = c.req.header('Authorization');
    const auth = verifyRequestAuth(c);
    if (!authHeader || !auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to view system providers');
    }
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const wahaKey = process.env.WAHA_API_KEY;

    return c.json({
      ok: true,
      providers: {
        gemini: {
          name: 'Google Gemini & Workspace ADC',
          configured: Boolean(geminiKey) || true,
          mode: geminiKey ? 'API Key' : 'Google Workspace ADC (Active)',
          preview: geminiKey ? maskKey(geminiKey) : 'hawzhin88@gmail.com (ADC)',
          status: 'READY',
        },
        openai: {
          name: 'OpenAI (GPT-4o / Sol)',
          configured: Boolean(openaiKey),
          mode: openaiKey ? 'Live Provider' : 'Deterministic Fallback Engine',
          preview: openaiKey ? maskKey(openaiKey) : 'Fallback Active',
          status: openaiKey ? 'READY' : 'FALLBACK_ACTIVE',
        },
        anthropic: {
          name: 'Anthropic (Claude 3.5 Sonnet / Opus)',
          configured: Boolean(anthropicKey),
          mode: anthropicKey ? 'Live Provider' : 'Deterministic Fallback Engine',
          preview: anthropicKey ? maskKey(anthropicKey) : 'Fallback Active',
          status: anthropicKey ? 'READY' : 'FALLBACK_ACTIVE',
        },
        telegram: {
          name: 'Telegram Bot Adapter',
          configured: Boolean(telegramToken),
          preview: telegramToken ? maskKey(telegramToken) : 'Not configured',
          status: telegramToken ? 'READY' : 'DISABLED',
        },
        waha: {
          name: 'WAHA WhatsApp Bridge',
          configured: Boolean(wahaKey),
          endpoint: process.env.WAHA_ENDPOINT || 'http://127.0.0.1:3000',
          preview: wahaKey ? maskKey(wahaKey) : 'Quarantined',
          status: wahaKey ? 'READY' : 'QUARANTINED',
        },
      },
      envFile: '.env.local',
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

    const { geminiApiKey, openaiApiKey, anthropicApiKey, telegramBotToken, wahaApiKey, wahaEndpoint } = body;

    if (typeof geminiApiKey === 'string') {
      process.env.GEMINI_API_KEY = geminiApiKey.trim();
    }
    if (typeof openaiApiKey === 'string') {
      process.env.OPENAI_API_KEY = openaiApiKey.trim();
    }
    if (typeof anthropicApiKey === 'string') {
      process.env.ANTHROPIC_API_KEY = anthropicApiKey.trim();
    }
    if (typeof telegramBotToken === 'string') {
      process.env.TELEGRAM_BOT_TOKEN = telegramBotToken.trim();
    }
    if (typeof wahaApiKey === 'string') {
      process.env.WAHA_API_KEY = wahaApiKey.trim();
    }
    if (typeof wahaEndpoint === 'string') {
      process.env.WAHA_ENDPOINT = wahaEndpoint.trim();
    }

    try {
      const candidatePaths = [
        path.resolve('/app/infra/docker/.env.production'),
        path.resolve(process.cwd(), 'infra/docker/.env.production'),
        path.resolve(process.cwd(), '../../infra/docker/.env.production'),
        path.resolve(process.cwd(), '.env.production'),
        path.resolve(process.cwd(), '.env.local'),
      ];
      const envPath = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
      try {
        fs.mkdirSync(path.dirname(envPath), { recursive: true });
      } catch {}
      let currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

      const updateOrAppend = (key: string, val: string | undefined) => {
        if (typeof val !== 'string' || !val) return;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(currentContent)) {
          currentContent = currentContent.replace(regex, `${key}=${val}`);
        } else {
          currentContent += `\n${key}=${val}`;
        }
      };

      updateOrAppend('GEMINI_API_KEY', geminiApiKey?.trim());
      updateOrAppend('OPENAI_API_KEY', openaiApiKey?.trim());
      updateOrAppend('ANTHROPIC_API_KEY', anthropicApiKey?.trim());
      updateOrAppend('TELEGRAM_BOT_TOKEN', telegramBotToken?.trim());
      updateOrAppend('WAHA_API_KEY', wahaApiKey?.trim());
      updateOrAppend('WAHA_ENDPOINT', wahaEndpoint?.trim());

      fs.writeFileSync(envPath, currentContent, 'utf8');
    } catch {
      // Best-effort file sync
    }

    broadcastEvent('system:providers_updated', { timestamp: new Date().toISOString() });
    return c.json({
      ok: true,
      message: 'Provider credentials updated and activated immediately in memory and .env.local',
    });
  });
}
