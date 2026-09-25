import http from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { withRlsContext, sql, createDb, PostgresTelegramPollState, readTelegramKillSwitch, telegramBotKey } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { OutboxConsumer } from './outbox-consumer.js';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
import { LiveColourGate, runWhileLive, backgroundLoopsFromEnv, type LoopHandle } from './live-colour.js';
import { log } from './logging.js';
import { automationMembershipGaps, servedTenantIds } from './automation-identity.js';
import { useChatInboxCore } from './lifecycle/chat-inbox.js';
import { createCoreClient } from './lifecycle/core-client.js';
import { TelegramPoller, pollerConfigFromEnv, runPoller, type PollerLoopHandle } from './lifecycle/telegram-poller.js';
import { WORKER_SERVICE_NAMES } from './services.js';

const SERVICE_NAME = 'hawa-worker';
// A long-running service that dies without saying why is the hardest kind of outage to diagnose,
// and compose restarts it, so the only trace left is a gap in the logs. Node terminates the
// process on an unhandled rejection by default; these handlers make the reason survive the exit.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal(`[${SERVICE_NAME}] FATAL unhandledRejection: ${err.message}`, err);
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  log.fatal(`[${SERVICE_NAME}] FATAL uncaughtException: ${err.message}`, err);
  process.exit(1);
});
import { outcomeRecorder } from './outcome-without-core.js';
import { missingHandlers } from './lifecycle/shims.js';
import { workerServices } from './worker-services.js';
export * from './workflow.js';
export * from './canva-draft-workflow.js';
export * from './outbox-consumer.js';
export * from './durable-context.js';
export * from './workflow-dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const sharedDb = dbUrl ? createDb(dbUrl) : undefined;

/** Outcomes Core would not take are written to the outbox through the worker's own database. */
const recordOutcome = sharedDb ? outcomeRecorder(sharedDb) : undefined;

// ChatInbox calls Core's internal intake with its own credential (HAWA_WORKER_TOKEN), never the
// operator's bearer. Without it an update waits in its chat until the worker is configured.
if (process.env.HAWA_WORKER_TOKEN?.trim()) {
  useChatInboxCore(createCoreClient({ baseUrl: process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001', token: process.env.HAWA_WORKER_TOKEN.trim() }));
}

// Every service any build ever hosted stays bound (services.ts), and every handler the record
// requires (lifecycle/shims.ts). A build that binds less would strand what Restate still routes to
// it (a delayed reminder, an old invocation), so it does not start.
const boundServices = workerServices({ db: sharedDb, recordOutcome });
const boundNames = boundServices.map((s) => s.name).sort();
if (boundNames.join(',') !== [...WORKER_SERVICE_NAMES].sort().join(',')) {
  log.fatal(`[${SERVICE_NAME}] FATAL this build binds ${boundNames.join(', ')} but hosts ${WORKER_SERVICE_NAMES.join(', ')} (services.ts); not serving`);
  process.exit(1);
}
const missing = missingHandlers(boundServices);
if (missing.length) {
  log.fatal(`[${SERVICE_NAME}] FATAL this build lacks handlers Restate may still route to: ${missing.join(', ')} (lifecycle/shims.ts HANDLERS_EVER); not serving`);
  process.exit(1);
}

const restateHandler = boundServices
  .reduce((endpoint, service) => endpoint.bind(service), restate.endpoint())
  .http1Handler();

let outboxConsumer: OutboxConsumer | null = null;
// Blue/green (architecture programme 0.1): a colour runs the outbox only while it is the one Restate
// sends new work to. Without HAWA_WORKER_SELF_URI the worker is alone and runs it as before.
const backgroundMode = backgroundLoopsFromEnv();
const liveGate = backgroundMode.mode === 'live-colour'
  ? new LiveColourGate({ adminUrl: backgroundMode.adminUrl, selfUri: backgroundMode.selfUri, takeoverMs: backgroundMode.takeoverMs, refreshMs: backgroundMode.refreshMs })
  : null;
let gatedLoop: LoopHandle | null = null;
/**
 * Served tenants where System Automation, the worker's database identity, has no operator
 * membership: RLS hides every row there, so the outbox would sit idle without a word. null until
 * the startup check has answered.
 */
let automationGaps: string[] | null = null;
if (sharedDb) {
  automationMembershipGaps(sharedDb, servedTenantIds()).then((gaps) => {
    automationGaps = gaps;
    for (const tenant of gaps) {
      log.error(`[Worker] System Automation has no active operator membership in tenant ${tenant}: the worker can see none of its rows. Add the membership (as migration 012 does) and restart.`);
    }
  }, (err) => log.error('[Worker] Could not check System Automation\'s tenant memberships:', err));
}
if (backgroundMode.mode === 'misconfigured') log.error(`[Worker] Outbox not started: ${backgroundMode.reason}`);
if (sharedDb && backgroundMode.mode !== 'misconfigured') {
  try {
    const dispatcher = new TaskWorkflowDispatcher({
      restateIngressUrl: process.env.RESTATE_INGRESS_URL,
      db: sharedDb,
    });
    const tenantIds = servedTenantIds();
    outboxConsumer = new OutboxConsumer(sharedDb, {
      batchSize: Number(process.env.OUTBOX_BATCH_SIZE || 20),
      pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000),
      tenantIds,
      dispatcher,
    });
    if (liveGate) {
      const consumer = outboxConsumer;
      gatedLoop = runWhileLive({ gate: liveGate, tick: () => consumer.processBatch(), intervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000) });
      log.info(`[Worker] OutboxConsumer runs while ${process.env.HAWA_WORKER_SELF_URI} is the live colour`);
    } else {
      outboxConsumer.start();
      log.info('[Worker] OutboxConsumer background processor started');
    }
  } catch (err) {
    log.error('[Worker] Failed to start OutboxConsumer:', err);
  }
}

// The Telegram poller (Phase 2.1): only with HAWA_TELEGRAM_POLLER=worker, and only in the colour
// Restate sends ChatInbox work to. Core stops polling under the same setting (apps/core/src/index.ts).
const pollerConfig = pollerConfigFromEnv();
let telegramPoller: TelegramPoller | null = null;
let pollerLoop: PollerLoopHandle | null = null;
let pollerGate: LiveColourGate | null = null;
if (pollerConfig.mode === 'misconfigured') log.error(`[Worker] ${pollerConfig.reason}`);
if (pollerConfig.mode === 'on' && sharedDb && backgroundMode.mode !== 'misconfigured') {
  const scope = { tenantId: process.env.HAWA_TENANT_ID || '00000000-0000-4000-a000-000000000001', userId: SYSTEM_AUTOMATION_USER_ID };
  const db = sharedDb;
  telegramPoller = new TelegramPoller({
    botToken: pollerConfig.botToken,
    ingressUrl: pollerConfig.ingressUrl,
    offsets: new PostgresTelegramPollState(db, scope, telegramBotKey(pollerConfig.botToken)),
    killSwitch: () => readTelegramKillSwitch(db, scope),
  });
  pollerGate = backgroundMode.mode === 'live-colour'
    ? new LiveColourGate({ adminUrl: backgroundMode.adminUrl, selfUri: backgroundMode.selfUri, takeoverMs: pollerConfig.takeoverMs, refreshMs: backgroundMode.refreshMs, service: 'ChatInbox' })
    : null;
  pollerLoop = runPoller(telegramPoller, { gate: pollerGate ?? { isLive: async () => true } });
  log.info(`[Worker] Telegram poller runs${pollerGate ? ` while ${process.env.HAWA_WORKER_SELF_URI} serves ChatInbox` : ''}`);
}

const port = Number(process.env.PORT || 9080);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    // A worker whose database is unreachable cannot lease or acknowledge anything; say so.
    const tenantId = process.env.HAWA_TENANT_ID || '00000000-0000-4000-a000-000000000001';
    const probe: Promise<{ postgres: string; outbox: { pending: number; staleOver5m: number; failed: number } | null }> = sharedDb
      ? withRlsContext(sharedDb, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          const row = (await sql<{ pending: string; stale: string; failed: string }>`
            SELECT count(*) FILTER (WHERE state = 'pending') AS pending,
                   count(*) FILTER (WHERE state = 'pending' AND created_at < now() - interval '5 minutes') AS stale,
                   count(*) FILTER (WHERE state = 'failed') AS failed
            FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid`.execute(trx)).rows[0];
          return { postgres: 'connected', outbox: { pending: Number(row?.pending || 0), staleOver5m: Number(row?.stale || 0), failed: Number(row?.failed || 0) } };
        }).catch(() => ({ postgres: 'disconnected', outbox: null }))
      : Promise.resolve({ postgres: 'unconfigured', outbox: null });
    probe.then(({ postgres, outbox }) => {
      const healthy = postgres !== 'disconnected';
      // Backlog or dead letters degrade the worker without failing the container health check.
      const degraded = Boolean(outbox && (outbox.staleOver5m > 0 || outbox.failed > 0)) || backgroundMode.mode === 'misconfigured'
        || Boolean(automationGaps?.length) || pollerConfig.mode === 'misconfigured';
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? (degraded ? 'degraded' : 'healthy') : 'unhealthy',
        worker: 'restate-worker-1',
        buildCommit: process.env.HAWA_BUILD_COMMIT || 'unknown',
        flags: {
          DESIGN_PIPELINE_V3: process.env.DESIGN_PIPELINE_V3 || 'off',
          DESIGN_STUDIO_V2: process.env.DESIGN_STUDIO_V2 || 'off',
        },
        outboxActive: Boolean(outboxConsumer) && (!liveGate || liveGate.state() === 'live'),
        // blue/green: 'live' runs the outbox; 'standby' is a draining (or not yet registered) colour.
        colour: process.env.HAWA_WORKER_COLOUR || null,
        background: backgroundMode.mode === 'always' ? 'always' : backgroundMode.mode === 'misconfigured' ? 'misconfigured' : liveGate!.state(),
        dependencies: { postgres },
        outbox,
        // The Telegram poller (Phase 2.1): off (Core polls), misconfigured, or where it is.
        telegramPoller: pollerConfig.mode === 'on'
          ? { mode: 'on', background: telegramPoller ? (pollerGate ? pollerGate.state() : 'always') : 'not_started', ...(telegramPoller?.status() ?? {}) }
          : pollerConfig.mode === 'misconfigured' ? { mode: 'misconfigured', reason: pollerConfig.reason } : { mode: 'off' },
        // Served tenants where the worker's own database user has no membership (see automationGaps).
        tenantsWithoutAutomationMembership: automationGaps,
        timestamp: new Date().toISOString(),
      }));
    });
    return;
  }
  if (req.url === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ready',
      services: [...WORKER_SERVICE_NAMES],
      outboxConsumer: outboxConsumer ? 'active' : 'idle',
    }));
    return;
  }
  restateHandler(req, res);
});

server.listen(port, () => {
  log.info(`Hawa Worker listening on port ${port} with Restate services [${WORKER_SERVICE_NAMES.join(', ')}]`);
});

const shutdown = () => {
  gatedLoop?.stop();
  pollerLoop?.stop();
  if (outboxConsumer) {
    outboxConsumer.stop();
  }
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
