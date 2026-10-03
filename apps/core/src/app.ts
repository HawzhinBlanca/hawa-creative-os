import { registerCustomerAdminRoutes } from './customer/customer-admin.routes.js';
import { CustomerRequests } from './customer/customer-requests.js';
import { registerCustomerRoutes, CUSTOMER_ORIGINS } from './customer/customer.routes.js';
import { createWorkspaceMemberVerifier } from './customer/supabase-member.js';
import { permitsDesignWorkerRequest } from './services/design-worker-access.js';
import { hydrateClientDnaFromDb } from './services/client-dna-hydration.js';
import { ensureClientPackRows } from './services/client-pack-rows.js';
import { clientPacks } from './services/client-packs.js';
import { probeRestate } from './services/restate-probe.js';
import { createRestateInvocationProbe } from './services/restate-invocations.js';
import { log, requestLogContext, bindLogContext } from './logging.js';
import { CORE_MAX_BODY_BYTES, coreBodyLimit } from './body-limit.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import { SYSTEM_AUTOMATION_USER_ID, PRIMARY_OPERATOR_USER_ID, TASK_TRANSITIONED_EVENT, taskTransitioned } from '@hawa/contracts';
import { type ClientDNA, type DesignBrief, resolveModel, resolveImageSettings, activeModelTier, spendingPolicyValidity } from '@hawa/domain';
import {
  createDb,
  withRlsContext,
  TaskRepository,
  ClientRepository,
  IngressRepository,
  OutboxRepository,
  RevisionRepository,
  PublicationRepository,
  sql,
} from '@hawa/db';

try {
  if (typeof (process as any).loadEnvFile === 'function') {
    const envLocal = path.resolve(process.cwd(), 'infra/docker/.env.local');
    if (fs.existsSync(envLocal)) {
      (process as any).loadEnvFile(envLocal);
    }
  }
} catch {
  // Ignore in environments where env file loading is handled externally
}

import { CreativeDirectorRunner, resolveOrnamentSettings, STUDIO_SPENDING_POLICY } from '@hawa/creative';
import { DeterministicQAEngine } from '@hawa/qa';
import {
  GooglePublisher,
  KurdishVoiceTranscriber,
  ResilientModelGateway,
  TelegramBridgeDaemon,
  UnifiedIngressService,
  MemoryIngressPersistenceAdapter,
  TelegramActionTokenService,
  HistoricalDesignMigrator,
  CanvaNativeAdapter,
  CircuitBreaker,
  GATEWAY_SPENDING_POLICY,
  GATEWAY_SPENDING_POLICY_REVIEW_BY,
} from '@hawa/integrations';
import { PostgresIngressPersistenceAdapter } from './ingress-persistence-adapter.js';
import { DurableEvaluationService } from './services/durable-evaluations.js';
import { registerCanvaRoutes } from './routes/canva.routes.js';
import { registerDesignStudioRoutes } from './routes/design-studio.routes.js';
import { registerStudioRecoveryRoutes } from './routes/studio-recovery.routes.js';
import { registerSpendingPolicyRoutes } from './routes/spending-policy.routes.js';
import { registerCallCostRoutes } from './routes/call-cost.routes.js';
import { CanvaConnectService } from './services/canva-connect-service.js';
import { canvaDeliverableStore, EMPTY_DELIVERABLE_STORE, type DeliverableStore } from './services/pinned-deliverables.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerClientsRoutes } from './routes/clients.routes.js';
import { registerEvalsRoutes } from './routes/evals.routes.js';
import { registerComparisonRoutes } from './routes/comparison.routes.js';
import { registerIngressRoutes } from './routes/ingress.routes.js';
import { registerMigrationRoutes } from './routes/migration.routes.js';
import { registerAssetsRoutes } from './routes/assets.routes.js';
import { registerSimulatorsRoutes } from './routes/simulators.routes.js';
import { registerFontsRoutes } from './routes/fonts.routes.js';
import { registerRubricRoutes } from './routes/rubric.routes.js';
import { registerSystemStatusRoutes } from './routes/system-status.routes.js';
import { registerClientLearningRoutes } from './routes/client-learning.routes.js';
import { registerRevisionsRoutes } from './routes/revisions.routes.js';
import { registerDecisionsRoutes } from './routes/decisions.routes.js';
import { registerOfficeReviewAdminRoutes } from './routes/office-review-admin.routes.js';
import { registerCanvaOutcomeRoutes } from './routes/canva-outcome.routes.js';
import { registerDeliveryRoutes } from './routes/delivery.routes.js';
import { registerDeliveryInternalRoutes } from './routes/delivery-internal.routes.js';
import { registerOutboxRoutes } from './routes/outbox.routes.js';
import { registerControlsRoutes } from './routes/controls.routes.js';
import { registerTasksRoutes } from './routes/tasks.routes.js';
import { registerTaskPipelineRoutes } from './routes/task-pipeline.routes.js';
import { registerSearchRoutes } from './routes/search.routes.js';
import { registerWhatsappRoutes } from './routes/whatsapp.routes.js';
import { createChannelKillSwitchStore } from './services/channel-kill-switches.js';
import { acceptedServiceTokensOf, isInternalPath, registerLifecycleInternalRoutes, serviceTokenOf } from './routes/lifecycle-internal.routes.js';
import { retiredTelegramSettings, telegramPollerOf } from './services/telegram-poller-owner.js';
import { checkProductionFunnelHealth } from './services/funnel-monitor.js';
import { latestOf, readProgressEvidence } from './services/progress-evidence.js';
import { PaidModelProbeService } from './services/paid-model-probe.js';
import { evaluatePaidModelHealth, paidModelConfigFingerprint, readLatestPaidModelObservation, type PaidModelHealth } from './services/paid-model-health.js';
import { PhotoCutouts } from './services/design-studio/photo-cutouts.js';
import { createStreamTicketStore } from './services/stream-tickets.js';
import { googleOidcSettings } from './services/google-oidc.js';
import {
  canonicalJson,
  computeDnaHash,
  isValidUuid,
  inlineTemplateCopyMissing,
  TaskStoreUnavailableError,
  qaReportSha256,
  secretsEqual,
  probeDatabase,
  evaluateCanvaExportQc,
  type CreateAppOptions,
} from './core-helpers.js';
import type { ClientDnaSnapshot, RouteContext } from './routes/types.js';
import type { QAEngine } from '@hawa/contracts';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID, ADMIN_USER_ID } from './core-context.js';
import { createTaskReader } from './services/task-reader.js';
import { createClientDnaResolver, ClientDnaUnavailableError } from './services/client-dna-resolver.js';
import { noDatabaseStore } from './services/no-database-store.js';
import { createOmnichannelDelivery } from './services/omnichannel-delivery.js';
import { PostgresDriveUploadIdentityStore } from './services/drive-upload-reservation.js';
import { PostgresSheetExpectationStore } from './services/publication-expectations.js';
import { PublicationInspectionService, startPublicationInspectionSchedule } from './services/publication-inspections.js';
import { StudioCallSettlementService } from './services/studio-call-settlement.js';
import { registerPublicationInspectionRoutes } from './routes/publication-inspections.routes.js';
import { officeAccessPolicy, permitsOfficeRequest } from './services/office-access.js';

// What app.ts exported before its helpers moved to core-helpers.ts; tests and scripts import them from here.
export { canonicalJson, computeDnaHash, isValidUuid, inlineTemplateCopyMissing, qaReportSha256, secretsEqual, probeDatabase, evaluateCanvaExportQc };
export type { CreateAppOptions, DatabaseProbeStatus, CanvaQcEvaluationResult } from './core-helpers.js';
export type { ClientDnaSnapshot } from './routes/types.js';

const globalHistoricalMigrator = new HistoricalDesignMigrator();
const globalCanvaNativeAdapter = new CanvaNativeAdapter();
const globalCanvaCircuitBreaker = new CircuitBreaker({ name: 'canva-api', failureThreshold: 3, cooldownMs: 5000 });

export function createApp(options?: CreateAppOptions) {
  const app = new Hono();
  const officeAccess = officeAccessPolicy(process.env);
  // The Node adapter sees an HTTP upstream socket behind the HTTPS reverse proxy. Compare browser
  // Origin with the configured public OAuth callback origin, never that internal request scheme.
  const officeBrowserOrigin = googleOidcSettings()?.redirectUri;
  const currentEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const isProduction = currentEnv === 'production';
  const db = options?.db || (process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : null);
  const taskRepo = db ? new TaskRepository(db) : null;
  const clientRepo = db ? new ClientRepository(db) : null;
  const ingressRepo = db ? new IngressRepository(db) : null;
  const outboxRepo = db ? new OutboxRepository(db) : null;
  const revisionRepo = db ? new RevisionRepository(db) : null;
  const canvaConnectService = options?.canvaConnectService || (db ? new CanvaConnectService(db, options?.canvaOptions) : null);
  const deliverableStore: DeliverableStore =
    options?.deliverableStore || (canvaConnectService ? canvaDeliverableStore(canvaConnectService) : EMPTY_DELIVERABLE_STORE);
  const publicationRepo = options?.publicationRepo || (db ? new PublicationRepository(db) : null);
  const ingressPersistence = (db && ingressRepo && taskRepo)
    ? new PostgresIngressPersistenceAdapter(db, ingressRepo, taskRepo)
    : new MemoryIngressPersistenceAdapter();
  const unifiedIngress = new UnifiedIngressService(ingressPersistence);

  // Middleware
  // First, so every later middleware, handler and error line carries the request's id (logging.ts).
  app.use('*', requestLogContext());
  app.use('*', cors({
    origin: (origin, c) => c.req.path.startsWith('/v1/customer/')
      ? (CUSTOMER_ORIGINS.has(origin) ? origin : '')
      : officeAccess.mode === 'trusted_office' ? officeAccess.origin! : '*',
    exposeHeaders: ['X-Content-SHA256'],
    allowHeaders: [
      'Content-Type',
      'X-Hawa-Office-Request',
      'Authorization',
      'Idempotency-Key',
      'X-Content-SHA256',
      'X-Photo-Filename',
      'If-Match-Version',
      'x-telegram-bot-api-secret-token',
      'x-waha-signature',
      'x-signature-ed25519',
      'x-signature-timestamp',
      'baggage',
      'sentry-trace',
      'traceparent',
      'x-request-id',
    ],
  }));

  app.use('*', async (c, next) => {
    const start = Date.now();
    const correlationId = c.req.header('X-Correlation-ID') || crypto.randomUUID();
    c.header('X-Correlation-ID', correlationId);
    await next();
    c.header('X-Response-Time', `${Date.now() - start}ms`);
  });

  // Security Headers Middleware (OWASP Secure Headers)
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '1; mode=block');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    await next();
    // Download and nonce-bearing HTML handlers own their more specific policy.
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' https:; frame-ancestors 'none';");
    }
  });

  // Bug hunt 3: no request body above CORE_MAX_BODY_BYTES is read (body-limit.ts).
  app.use('*', coreBodyLimit(CORE_MAX_BODY_BYTES, (c) => problem(c, 413, 'Payload Too Large',
    `Request bodies are limited to ${CORE_MAX_BODY_BYTES} bytes`)));

  app.onError((err, c) => {
    if (err instanceof ClientDnaUnavailableError) return problem(c, 503, 'Client DNA Unavailable', err.message);
    if (err instanceof TaskStoreUnavailableError) {
      log.warn('[core:task_read]', err.message, (err as { cause?: unknown }).cause);
      return problem(c, 503, 'Database Unavailable', err.message);
    }
    log.error('[core:unhandled_error]', err);
    if (process.env.NODE_ENV === 'production') {
      return problem(c, 500, 'Internal Server Error', 'An unexpected internal server error occurred');
    }
    return c.json({ error: err.message, stack: err.stack }, 500);
  });

  // RFC 7807 Problem Helper
  function problem(c: any, status: number, title: string, detail?: string) {
    return c.json({
      type: `https://hawa.design/errors/${status}`,
      title,
      status,
      detail: detail || title,
      // OAuth callback URLs carry one-time codes and state. Problem responses must not echo
      // query strings into the browser, proxy logs, or any captured support bundle.
      instance: new URL(c.req.url).pathname,
    }, status);
  }

  // Domain singletons
  const creativeDirector = new CreativeDirectorRunner();
  const qaEngine: QAEngine = options?.qaEngine || new DeterministicQAEngine();
  const publisher = options?.publisher || new GooglePublisher({
    uploadIdentityStore: db ? new PostgresDriveUploadIdentityStore(db) : undefined,
    sheetExpectationStore: db ? new PostgresSheetExpectationStore(db) : undefined,
  });
  const modelGateway = new ResilientModelGateway();
  const evaluationService = db ? new DurableEvaluationService(db, options?.evaluationGateway || modelGateway) : null;
  const voiceTranscriber = new KurdishVoiceTranscriber();
  const telegramActionTokenService =
    options?.telegramActionTokenService || new TelegramActionTokenService(process.env.HAWA_ACTION_HMAC_SECRET);
  const telegramAllowedUsers = process.env.TELEGRAM_ALLOWED_USERS
    ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const telegramIntakeUsers = [...new Set([...telegramAllowedUsers, ...(process.env.TELEGRAM_INTAKE_ALLOWED_USERS || '').split(',').map(s=>s.trim()).filter(Boolean)])];
  const telegramBridge =
    options?.telegramBridge ||
    new TelegramBridgeDaemon({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      targetIngressUrl: 'http://127.0.0.1:8080/api/webhooks/telegram',
    });
  // The office's switches, kept in Postgres so a restart keeps a thrown one (architecture programme
  // 1.3, G8; services/channel-kill-switches.ts). Without a database they are this app's alone.
  const channelKillSwitchStore = createChannelKillSwitchStore(db);
  const channelKillSwitches = channelKillSwitchStore.switches;
  // The office's Telegram kill switch stops intake: the worker's poller reads its row in Postgres
  // before every poll, and Core's intake routes refuse while it is on. Core has no poller (ADR-135).

  // Without a database, the office's tasks, their events and briefs, client DNA history and uploaded
  // assets live in these maps (development and the in-memory tests). With one, each holds nothing and
  // Postgres is the only truth (services/no-database-store.ts; architecture programme 1.3, cleanup).
  const tasks: Map<string, any> = noDatabaseStore(db);
  const events: Map<string, any[]> = noDatabaseStore(db);
  const briefs: Map<string, DesignBrief> = noDatabaseStore(db);
  const clientSnapshots: Map<string, ClientDnaSnapshot[]> = noDatabaseStore(db);
  const uploadedAssets: Map<string, any> = noDatabaseStore(db);
  // Client DNA as this process loaded it from Postgres (clientDnaHydrated below), which answers first
  // (services/client-dna-resolver.ts). Without a database, or for the invented offices a test seeds,
  // it is all there is.
  const clientDnas = new Map<string, ClientDNA>();
  const resolveClientDna = createClientDnaResolver({ db, clientDnas });
  // Evaluation runs have no table yet; SPLIT_PLAN.md section 7 leaves them to the owner.

  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;
  const adminUserId = ADMIN_USER_ID;

  // Real-time Event System (Server-Sent Events)
  type SystemEvent = {
    id: string;
    event: string;
    data: any;
    timestamp: string;
  };

  type StreamSubscriber = (event: SystemEvent) => Promise<void> | void;
  const subscribers = new Set<StreamSubscriber>();

  function broadcast(event: string, data: any) {
    const enrichedData = (typeof data === 'object' && data !== null)
      ? { tenantId: data.tenantId || defaultTenantId, ...data }
      : data;
    const systemEvent: SystemEvent = {
      id: crypto.randomUUID(),
      event,
      data: enrichedData,
      timestamp: new Date().toISOString(),
    };
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber(systemEvent);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }

  /**
   * Tells the Desk a task moved, in the one shape {taskId, from, to, version, at} (packages/contracts
   * task-status.ts). `from` and `to` are database states or API statuses; `version` is tasks.version
   * after the move, or null when the move was not written to the database. The event had four shapes
   * and carried words the Desk did not know. A word the vocabulary does not have is a bug: it is
   * logged and not sent, rather than failing a request whose change is already committed.
   */
  function broadcastTransition(taskId: string, from: string | null | undefined, to: string, version?: number | string | null) {
    try {
      broadcast(TASK_TRANSITIONED_EVENT, taskTransitioned({ taskId, from, to, version }));
    } catch (err) {
      log.error(`[core:events] Task ${taskId}: ${TASK_TRANSITIONED_EVENT} not sent:`, (err as Error)?.message || err);
    }
  }

  // Client DNA comes from PostgreSQL (clientDnaHydrated below). Only a test seeds invented offices,
  // through options.seedClientDna (SPLIT_PLAN.md section 6, stage 2).
  options?.seedClientDna?.(clientDnas, clientSnapshots);

  interface IssuedSession {
    authenticated: boolean;
    tenantId: string;
    userId: string;
    actorId: string;
    role: string;
    displayName: string;
    authMethod?: 'shared_key' | 'google_oidc' | 'telegram_miniapp';
    expiresAt?: number;
    /** Last time PostgreSQL confirmed this session (revocation from another instance is honoured within a minute). */
    checkedAt?: number;
  }
  const issuedSessions = new Map<string, IssuedSession>();
  // One-use, 60 s tickets that open the event stream in place of the session token (ADR-037).
  const streamTickets = createStreamTicketStore();
  const SESSION_RECHECK_MS = 60000;
  const sessionHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
  const sessionRls = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };

  async function persistSession(token: string, session: IssuedSession): Promise<boolean> {
    if (!db) return false;
    try {
      await withRlsContext(db, sessionRls, (trx) => sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
        VALUES (${sessionHash(token)},${session.tenantId}::uuid,${session.userId}::uuid,${session.actorId},${session.role},${session.displayName},${new Date(session.expiresAt || Date.now() + 86400000)},${session.authMethod || 'shared_key'})`.execute(trx));
      return true;
    } catch (err) {
      log.error('[core:sessions] could not persist session; it will not survive a restart:', err);
      return false;
    }
  }
  async function revokeSession(token: string): Promise<void> {
    issuedSessions.delete(token);
    if (!db) return;
    try {
      await withRlsContext(db, sessionRls, (trx) => sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${sessionHash(token)} AND revoked_at IS NULL`.execute(trx));
    } catch (err) {
      log.error('[core:sessions] could not record revocation:', err);
    }
  }
  /**
   * Loads a Desk session from PostgreSQL on a cache miss (fresh process, other instance) and
   * re-validates cached sessions periodically so a revocation elsewhere takes effect.
   */
  async function ensureSessionLoaded(token: string | undefined): Promise<void> {
    // Desk sign-ins and Telegram Mini App sign-ins (auth.routes.ts) are both in hawa.desk_sessions.
    if (!db || !token || !(token.startsWith('hawa_sess_') || token.startsWith('tg_miniapp_sess_'))) return;
    const cached = issuedSessions.get(token);
    if (cached && cached.checkedAt && Date.now() - cached.checkedAt < SESSION_RECHECK_MS) return;
    try {
      const row = await withRlsContext(db, sessionRls, async (trx) => (await sql<any>`SELECT tenant_id,user_id,actor_id,role,display_name,expires_at,revoked_at,auth_method
        FROM hawa.desk_sessions WHERE token_hash=${sessionHash(token)}`.execute(trx)).rows[0]);
      if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
        if (cached && row && (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now())) issuedSessions.delete(token);
        else if (cached && !row) issuedSessions.delete(token);
        return;
      }
      issuedSessions.set(token, {
        authenticated: true, tenantId: row.tenant_id, userId: row.user_id, actorId: row.actor_id, role: row.role,
        displayName: row.display_name, authMethod: row.auth_method,
        expiresAt: new Date(row.expires_at).getTime(), checkedAt: Date.now(),
      });
    } catch (err) {
      // Database trouble must not log everyone out: keep whatever the cache already knows.
      log.warn('[core:sessions] lookup failed; using cached sessions only:', err);
    }
  }
  const bearerTokenOf = (c: any): string | undefined => {
    const header = c.req.header('Authorization');
    if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = getCookie(c, 'hawa_session');
    return cookie?.startsWith('hawa_sess_') ? cookie : undefined;
  };

  function saveSession(token: string, session: IssuedSession) {
    if (issuedSessions.size > 5000) {
      const now = Date.now();
      for (const [k, s] of issuedSessions) {
        if (s.expiresAt && now > s.expiresAt) issuedSessions.delete(k);
      }
      if (issuedSessions.size > 5000) {
        const firstKey = issuedSessions.keys().next().value;
        if (firstKey) issuedSessions.delete(firstKey);
      }
    }
    issuedSessions.set(token, session);
  }

  /**
   * `ticketCredential` is the bearer token a redeemed stream ticket stood for (routes/system.routes.ts);
   * it is checked exactly as that header would be. Nothing else passes it.
   */
  function verifyRequestAuth(c: any, ticketCredential?: string): { authenticated: boolean; tenantId: string; userId: string; actorId: string; role: string; displayName?: string; authMethod?: string } {
    // The worker's own credential (architecture programme Phase 2.1): HAWA_WORKER_TOKEN is a
    // `service` principal on /v1/internal/* and nothing anywhere else, and those routes take no other
    // credential: not the operator's or administrator's keys, a session, a stream ticket, the webhook
    // secret, a test principal or a role header. The worker used to call Core with the operator's key.
    // During a rotation the previous value is accepted too: a colour still draining keeps it (ADR-129).
    const workerTokens = acceptedServiceTokensOf();
    if (isInternalPath(String(c.req.path || ''))) {
      const presented = ticketCredential ? '' : String(c.req.header('Authorization') || '').replace(/^Bearer\s*/, '').trim();
      if (presented && workerTokens.some((token) => secretsEqual(presented, token))) {
        return { authenticated: true, tenantId: defaultTenantId, userId: SYSTEM_AUTOMATION_USER_ID, actorId: 'hawa_worker', role: 'service', displayName: 'Hawa worker' };
      }
      return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
    }
    // ADR-163: no ordinary operator key in the worker. Preserve Canva grant ownership,
    // but authorize only the worker's task-scoped design endpoints, never approvals or administration.
    const designTokens = [process.env.HAWA_DESIGN_WORKER_TOKEN?.trim(), process.env.HAWA_DESIGN_WORKER_TOKEN_PREVIOUS?.trim()].filter((t): t is string => Boolean(t));
    const designPresented = ticketCredential || bearerTokenOf(c) || '';
    if (designPresented && designTokens.some(token => secretsEqual(designPresented, token))) {
      if (!ticketCredential && permitsDesignWorkerRequest(c.req.path, c.req.method)) {
        return { authenticated: true, tenantId: defaultTenantId, userId: operatorUserId,
          actorId: 'hawa_design_worker', role: 'operator', displayName: 'Hawa design worker', authMethod: 'design_worker' };
      }
      return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
    }
    let authHeader = ticketCredential ? `Bearer ${ticketCredential}` : c.req.header('Authorization');
    if (!authHeader) {
      const rawCookie = getCookie(c, 'hawa_session');
      const cookieSession = rawCookie?.startsWith('hawa_sess_') ? rawCookie : undefined;
      if (cookieSession) authHeader = `Bearer ${cookieSession}`;
    }
    // No credential is read from the query string (ADR-128). Media and preview endpoints used to take
    // the session token as `?access_token=`: it reached nginx's error log whenever a stored file was
    // missing. The Desk fetches pictures with the header (AuthorizedImage), and an <img> sends the
    // session cookie read above; the event stream takes a one-use ticket (ADR-037).
    // The Telegram webhook secret is shared with the Telegram platform and is never a credential. It
    // authenticated the old intake's webhook deliveries (an 'adapter' principal on /api/webhooks/*);
    // that intake went with stage 2 of ADR-135, and a request carrying it is anonymous everywhere.
    if (c.req.header('x-telegram-bot-api-secret-token')) {
      return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
    }

    // Trusted-office mode (ADR-146) lets a request with no credential from the office origin act as the
    // office. A request that presents a credential is verified exactly as in required mode below: the
    // worker's old Canva and Studio calls reached Core from inside the Docker network with HAWA_BEARER_TOKEN,
    // never from the office origin, and ignoring that key failed every design (2026-09-29 23:31 to the
    // fix). The worker's internal token still authenticates only /v1/internal/*.
    if (officeAccess.mode === 'trusted_office') {
      const presented = String(authHeader || '').replace(/^Bearer\s*/, '').trim();
      if (presented && workerTokens.some(token => secretsEqual(presented, token))) {
        return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
      }
      // Only a successfully redeemed one-use ticket supplies this marker. A header
      // containing the same text is still a presented key and must be verified.
      if (!presented || ticketCredential === 'hawa_trusted_office') {
        if (!permitsOfficeRequest(officeAccess, c.req)) {
          return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
        }
        return { authenticated: true, tenantId: defaultTenantId, userId: adminUserId,
          actorId: 'trusted_office_team', role: 'administrator', displayName: 'Office team', authMethod: 'trusted_office' };
      }
    }

    const allowRoleOverride = Boolean(options?.testAuth?.roleHeader ?? options?.allowRoleHeader);
    if (allowRoleOverride && c.req.header('x-user-role')) {
      const customRole = c.req.header('x-user-role').toLowerCase().trim();
      return { authenticated: true, tenantId: defaultTenantId, userId: operatorUserId, actorId: `test_${customRole}`, role: customRole, displayName: `Test ${customRole}` };
    }

    if (authHeader) {
      if (authHeader.startsWith('Bearer ') || authHeader === 'Bearer') {
        const token = authHeader.replace(/^Bearer\s*/, '').trim();
        if (!token) {
          return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
        }

        if (issuedSessions.has(token)) {
          const session = issuedSessions.get(token)!;
          if (session.expiresAt && Date.now() > session.expiresAt) {
            issuedSessions.delete(token);
            return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
          }
          return session;
        }

        // The worker's token (and its previous value during a rotation) opens /v1/internal/* only (above).
        if (workerTokens.some((workerToken) => secretsEqual(token, workerToken))) {
          return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
        }

        if (options?.extraBearerTokens && options.extraBearerTokens[token]) {
          const entry = options.extraBearerTokens[token];
          if (typeof entry === 'string') {
            return { authenticated: true, tenantId: defaultTenantId, userId: operatorUserId, actorId: `test_${entry}`, role: entry, displayName: `Test ${entry}` };
          }
          return {
            authenticated: true,
            tenantId: defaultTenantId,
            userId: entry.sub || operatorUserId,
            actorId: entry.sub || `test_${entry.role}`,
            role: entry.role,
            displayName: entry.email || `Test ${entry.role}`
          };
        }

        const adminKeys = new Set([
          process.env.HAWA_ADMIN_KEY,
        ].filter((k): k is string => Boolean(k && k.trim())));

        const reviewerKeys = new Set([
          process.env.HAWA_REVIEWER_KEY,
          process.env.HAWA_ART_DIRECTOR_KEY,
        ].filter((k): k is string => Boolean(k && k.trim())));

        const validKeys = new Set([
          process.env.HAWA_API_KEY,
          process.env.HAWA_BEARER_TOKEN,
          process.env.HAWA_DESK_SECRET,
        ].filter((k): k is string => Boolean(k && k.trim())));

        if (adminKeys.has(token)) {
          return { authenticated: true, tenantId: defaultTenantId, userId: adminUserId, actorId: 'admin_1', role: 'administrator', displayName: 'Administrator' };
        }

        if (reviewerKeys.has(token)) {
          return { authenticated: true, tenantId: defaultTenantId, userId: adminUserId, actorId: 'art_director_1', role: 'art_director', displayName: 'Art Director' };
        }

        if (validKeys.has(token)) {
          return { authenticated: true, tenantId: defaultTenantId, userId: operatorUserId, actorId: 'operator_1', role: 'operator', displayName: 'Primary Operator' };
        }
        return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
      }
      return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
    }

    // In-memory harness fallback: when running pure unit test harnesses without DB outside production,
    // permit requests unless explicitly enforcing auth or accessing protected provider endpoints
    // A test may supply the principal a token-less request runs as. Nothing else does: there is no
    // "no database, so everyone is signed in" rule any more, in any environment.
    const testPrincipal = options?.testAuth?.principal ?? (options?.bypassAuthWithoutDb && !db ? { role: 'operator' } : undefined);
    if (testPrincipal && !c.req.header('x-enforce-auth')) {
      return { authenticated: true, tenantId: defaultTenantId, userId: testPrincipal.userId || operatorUserId, actorId: 'test_harness', role: testPrincipal.role, displayName: testPrincipal.displayName || 'Test Harness' };
    }

    return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
  }

  // Honest Health & Readiness Probes (CV-20, FR-064, FR-073, R1/F10) - Zero hardcoded health!
  // Null until a paid probe has actually been sent: it used to start at boot time, and so reported
  // "verified progress" for a Core that had verified nothing (ADR-158).
  let lastVerifiedProgressAt: string | null = null;

  // The scheduled call records its result in Postgres. Health never turns a configured key or a
  // result from another key/model into proof that the current model can take paid traffic.
  interface PaidProbeState {
    lastAlertSentAt?: number;
    lastAlertMessageId?: string;
  }
  let lastPaidProbe: PaidProbeState = {};

  const paidProbeScope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' };
  const paidProbeService = db ? new PaidModelProbeService(db) : null;
  const executePaidModelProbe = async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { status: 'unconfigured' };
    if (!paidProbeService || (options?.skipPaidModelProbe ?? !options?.enableBillingProbeSchedule)) return { status: 'unverified' };
    const result = await paidProbeService.execute(paidProbeScope, key, process.env.OPENAI_MODEL || resolveModel('text'), billingProbeMs);
    if (result.dispatched) lastVerifiedProgressAt = new Date().toISOString();
    return result;
  };

  const checkAndAlertBilling = async (probeResult: { status: string }) => {
    if (probeResult.status === 'billing_exhausted' || probeResult.status === 'unauthorized') {
      const now = Date.now();
      const cooldownMs = 15 * 60 * 1000;
      if (!lastPaidProbe.lastAlertSentAt || now - lastPaidProbe.lastAlertSentAt > cooldownMs) {
        lastPaidProbe.lastAlertSentAt = now;
        const targetChat = telegramAllowedUsers[0];
        if (targetChat && telegramBridge) {
          const alertText = probeResult.status === 'billing_exhausted'
            ? `⚠️ <b>Hawa Watchdog Alert</b>: OpenAI credit balance exhausted (429 insufficient_quota).\nOperator action required: Add credits at <a href="https://platform.openai.com/settings/organization/billing/">OpenAI Billing</a>`
            : `⚠️ <b>Hawa Watchdog Alert</b>: OpenAI API key unauthorized (HTTP ${probeResult.status}).\nOperator action required: Verify API credentials.`;
          try {
            const outRes: any = await telegramBridge.dispatchOutboundMessage(targetChat, {
              text: alertText,
              parse_mode: 'HTML',
            });
            lastPaidProbe.lastAlertMessageId = outRes?.messageId ? String(outRes.messageId) : (outRes?.message_id ? String(outRes.message_id) : undefined);
          } catch (err) {
            log.error('[HealthProbe] Watchdog alert delivery failed:', err);
          }
        }
      }
    }
  };

  const paidModelHealth = async (): Promise<PaidModelHealth> => {
    const key = process.env.OPENAI_API_KEY;
    const configSha256 = key ? paidModelConfigFingerprint(key, process.env.OPENAI_MODEL || resolveModel('text')) : null;
    const enabled = !(options?.skipPaidModelProbe ?? !options?.enableBillingProbeSchedule);
    if (!configSha256 || !enabled || !db) return evaluatePaidModelHealth(null, configSha256, enabled, 2 * billingProbeMs);
    try {
      const observation = await readLatestPaidModelObservation(db, DEFAULT_TENANT_ID, SYSTEM_AUTOMATION_USER_ID);
      const health = evaluatePaidModelHealth(observation, configSha256, enabled, 2 * billingProbeMs);
      const spending = await paidProbeService!.admissionHealth(paidProbeScope, key!, process.env.OPENAI_MODEL || resolveModel('text'));
      return { ...health, ...spending, status: spending.spendingStatus === 'ready' ? health.status :
        spending.spendingStatus === 'reconciliation_required' ? 'reconciliation_required' : 'budget_held' };
    } catch (err) {
      log.error('[HealthProbe] Paid observation read failed:', err);
      return { status: 'unknown', observedStatus: null, at: null, schemaVersion: null };
    }
  };
  const probeModelProvider = async (): Promise<string> => (await paidModelHealth()).status;

  // The paid billing probe runs on a schedule only: HAWA_BILLING_PROBE_MINUTES, default 30, never
  // under 5. It ran every 3 minutes with up to 100 output tokens on gpt-6-astra from 2026-09-16:
  // 480 paid calls a day, up to ~$2.40, recorded nowhere. A design that hits exhausted credit
  // already fails with INSUFFICIENT_QUOTA and tells the requester; this only warns the owner early.
  const billingProbeMs = Math.round(Math.min(1440, Math.max(5, Number(process.env.HAWA_BILLING_PROBE_MINUTES) || 30)) * 60_000);
  if (options?.enableBillingProbeSchedule && !options?.skipPaidModelProbe) {
    const initialProbeTimer = setTimeout(async () => {
      try {
        const res = await executePaidModelProbe();
        await checkAndAlertBilling(res);
      } catch (err) {
        log.error('[HealthProbe] Initial probe failed:', err);
      }
    }, 2000);
    initialProbeTimer.unref();
    const recurringProbeTimer = setInterval(async () => {
      try {
        const res = await executePaidModelProbe();
        await checkAndAlertBilling(res);
      } catch (err) {
        log.error('[HealthProbe] Scheduled probe failed:', err);
      }
    }, billingProbeMs);
    recurringProbeTimer.unref();
  }

  // The bot credential is probed with getMe at most every five minutes: a revoked or stale token
  // must show in /health, not as a silent poll loop that never receives updates again.
  let telegramProbe: { at: number; status: string } = { at: 0, status: 'unverified' };
  const probeTelegram = async (): Promise<string> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return 'unconfigured';
    // Probed only when asked (production does, entrypoint-options.ts); tests keep Telegram out.
    if (options?.skipTelegramProbe ?? true) return 'unverified';
    if (Date.now() - telegramProbe.at < 300000) return telegramProbe.status;
    let status = 'unreachable';
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(5000) });
      status = res.status === 401 ? 'unauthorized' : res.ok ? 'connected' : `http_${res.status}`;
    } catch { status = 'unreachable'; }
    telegramProbe = { at: Date.now(), status };
    return status;
  };

  const healthCutouts = new PhotoCutouts();
  const restateInvocations = createRestateInvocationProbe();
  const honestHealthHandler = async (c: any) => {
    const dbStatus = await probeDatabase(db);

    const canvaBreakerState = globalCanvaCircuitBreaker.getSnapshot();
    let canvaStatus = canvaBreakerState.state === 'OPEN' ? 'outage' : (canvaBreakerState.state === 'HALF_OPEN' ? 'degraded' : 'unverified');
    // The breaker only counts failed calls. An expired authorization fails every design at the Canva
    // transfer while the breaker stays closed: from 2026-09-17 to 2026-09-18 health said "connected"
    // while the connection needed reconnecting. Designs transfer as the Primary Operator, so that is
    // the connection that counts.
    if (canvaStatus === 'unverified' && db) {
      try {
        const connection = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: PRIMARY_OPERATOR_USER_ID, role: 'operator' }, async (trx) =>
          (await sql<{ status: string }>`SELECT status FROM hawa.canva_connections
            WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx)).rows[0]);
        if (connection?.status !== 'active') canvaStatus = 'reconnect_required';
      } catch {
        // An unreachable database is reported by the database probe above.
      }
    }

    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN) && !channelKillSwitches.telegram;
    const hasWaha = Boolean(process.env.WAHA_API_KEY || process.env.WAHA_BASE_URL) && !channelKillSwitches.waha;
    const bridgeStatus = typeof (telegramBridge as any)?.getStatus === 'function' ? (telegramBridge as any).getStatus() : null;
    const telegramStatus = channelKillSwitches.telegram ? 'kill_switch_active'
      : (hasTelegram ? (bridgeStatus?.degraded ? 'degraded' : 'active') : 'unconfigured');
    const wahaStatus = channelKillSwitches.waha ? 'kill_switch_active' : (hasWaha ? 'active' : 'unconfigured');

    let diskStatus = 'writable';
    try {
      const probeFile = path.join(process.cwd(), '.health_probe');
      fs.writeFileSync(probeFile, Date.now().toString());
      fs.unlinkSync(probeFile);
    } catch {
      diskStatus = 'read_only';
    }

    const modelHealth = await paidModelHealth();
    // ADR-158: with HAWA_BILLING_PROBE_ENABLED off there is no probe to wait for. "disabled" says so,
    // and it is not counted as degraded (production was "degraded" permanently for this alone).
    const paidProbeScheduled = !(options?.skipPaidModelProbe ?? !options?.enableBillingProbeSchedule);
    const paidProbeStatus = !paidProbeScheduled && modelHealth.status === 'unverified' ? 'disabled' : modelHealth.status;
    // ADR-288: "disabled" described the probe, not the provider, while production models drafted every
    // request. Without a probe the provider's status is read from production's own recorded calls:
    // connected (one of the newest three answered), failing (none did), idle (no call in 24 h).
    let progress: Awaited<ReturnType<typeof readProgressEvidence>> | null = null;
    if (db && dbStatus === 'connected') {
      try {
        progress = await readProgressEvidence(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID });
      } catch (err) {
        log.warn('[HealthProbe] Production call evidence unreadable:', (err as Error)?.message || err);
      }
    }
    const modelProviderStatus = paidProbeStatus === 'disabled' && progress ? progress.modelStatus : paidProbeStatus;
    const telegramApiStatus = hasTelegram ? await probeTelegram() : 'unconfigured';
    // Degraded rather than unhealthy: the worker waits for a healthy core before it starts, and
    // Restate can only register the worker once it is running.
    // Paused invocations wait for a person and are otherwise silent (architecture programme 0.1).
    // Asked side by side, so a hung Restate adds one timeout to /health, not two.
    const [restateProbe, restateWork] = await Promise.all([probeRestate(), restateInvocations()]);
    const restateStatus = restateProbe.status;

    let funnelMetrics: any = null;
    let funnelStatus: string = 'idle';
    if (db) {
      try {
        funnelMetrics = await checkProductionFunnelHealth(db, { windowHours: 48 });
        funnelStatus = funnelMetrics.status;
      } catch {
        // A failed funnel read is unknown even when the simple database ping succeeded.
        funnelStatus = 'unknown';
      }
    }

    // A client message that intake could not accept and had to park. Someone has to read it and
    // answer the sender, so it shows here for 48 hours, which is what the watchdog pages on.
    let parkedUpdates = 0;
    if (db && dbStatus === 'connected') {
      try {
        parkedUpdates = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
          Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.inbox_events
            WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND event_kind = 'telegram_update_parked'
              AND received_at > now() - interval '48 hours'`.execute(trx)).rows[0]?.n || 0));
      } catch {
        // The database probe above reports an unreachable database.
      }
    }

    // Production without a database handle keeps state in process memory only: that is an outage.
    // People cut out of client photos (ADR-032). Down, photos are placed framed and the requester is
    // told; the watchdog alerts on 'unreachable' so the office knows before a request needs one.
    const cutoutStatus = await healthCutouts.health();
    // ADR-159: the price policies' review dates. From 14 days before, a warning the watchdog pages on;
    // from the date, the Canva planner sends nothing until a person renews the prices.
    const policyChecks = [
      { policy: STUDIO_SPENDING_POLICY.id, ...spendingPolicyValidity(STUDIO_SPENDING_POLICY.reviewBy) },
      { policy: GATEWAY_SPENDING_POLICY, ...spendingPolicyValidity(GATEWAY_SPENDING_POLICY_REVIEW_BY) },
    ];
    const spendingPolicyStatus = policyChecks.some((p) => p.status === 'expired') ? 'expired'
      : policyChecks.some((p) => p.status === 'expiring') ? 'expiring' : 'valid';
    const isUnhealthy = dbStatus === 'disconnected' || (isProduction && dbStatus !== 'connected') || diskStatus === 'read_only';
    // Canva's "unverified" is not degraded: no Canva probe exists, so it could never become "connected"
    // (ADR-158). An expired connection is "reconnect_required" and a failing one opens the breaker.
    const isDegraded = canvaStatus === 'outage' || canvaStatus === 'degraded' || canvaStatus === 'reconnect_required' || channelKillSwitches.telegram || channelKillSwitches.waha
      || (isProduction && modelProviderStatus !== 'connected' && modelProviderStatus !== 'disabled' && modelProviderStatus !== 'idle')
      || modelProviderStatus === 'failing'
      || modelProviderStatus === 'unauthorized' || modelProviderStatus === 'unreachable'
      || modelProviderStatus === 'billing_exhausted' || modelProviderStatus === 'rate_limited'
      || modelProviderStatus === 'http_error' || modelProviderStatus === 'budget_held' || modelProviderStatus === 'reconciliation_required'
      || telegramApiStatus === 'unauthorized' || telegramApiStatus === 'unreachable' || telegramStatus === 'degraded'
      || restateStatus === 'unregistered' || restateStatus === 'unreachable'
      || funnelStatus === 'stalled' || (Boolean(db) && funnelStatus === 'unknown')
      || parkedUpdates > 0
      || (restateWork.paused ?? 0) > 0
      || spendingPolicyStatus !== 'valid';
    const status = isUnhealthy ? 'unhealthy' : (isDegraded ? 'degraded' : 'healthy');

    return c.json({
      status,
      timestamp: new Date().toISOString(),
      buildCommit: process.env.HAWA_BUILD_COMMIT || 'unknown',
      configurationRevision: process.env.HAWA_CONFIGURATION_REVISION || null,
      flags: {
        DESIGN_PIPELINE_V3: process.env.DESIGN_PIPELINE_V3 || 'off',
        // How many chats DESIGN_PIPELINE_V3_CHATS enrols in v3 while the flag above is off, read as
        // isV3PilotChat reads it; never which chats (ADR-158). "off" alone hid two pilot chats.
        DESIGN_PIPELINE_V3_CHATS: new Set((process.env.DESIGN_PIPELINE_V3_CHATS || '').split(',').map((c) => c.trim()).filter(Boolean)).size,
        DESIGN_STUDIO_V2: process.env.DESIGN_STUDIO_V2 || 'off',
      },
      // Who is meant to ask Telegram for updates: the watchdog then requires a polling worker colour
      // when this says worker (ADR-129).
      telegramPoller: telegramPollerOf(process.env),
      // The newest thing production demonstrably did: a paid probe sent, a model call answered, or a
      // Canva draft made (ADR-288). It was only ever a probe, so null for good with the probe off.
      lastVerifiedProgressAt: latestOf(lastVerifiedProgressAt, progress?.modelCalls.lastAnsweredAt, progress?.lastDraftAt),
      lastDraftAt: progress?.lastDraftAt ?? null,
      modelCalls: progress?.modelCalls ?? null,
      lastPaidProbe: {
        at: modelHealth.at,
        status: paidProbeStatus,
        observedStatus: modelHealth.observedStatus,
        schemaVersion: modelHealth.schemaVersion,
        detail: modelHealth.spendingStatus || null,
        callId: modelHealth.callId || null,
        lastAlertMessageId: lastPaidProbe.lastAlertMessageId || null,
        // Null when no schedule runs: "30" read as a probe every half hour that was never sent.
        everyMinutes: paidProbeScheduled ? billingProbeMs / 60_000 : null,
      },
      funnel: funnelMetrics,
      restateInvocations: restateWork,
      spendingPolicy: { status: spendingPolicyStatus, policies: policyChecks,
        ...(spendingPolicyStatus !== 'valid' ? { warning: 'Re-check the provider prices and renew the price policy (runbooks/SPENDING_POLICY.md).' } : {}) },
      // Which models new requests will use: HAWA_MODEL_TIER=dev is the owner's cheap tier, and
      // HAWA_MODEL_<ROLE> / HAWA_IMAGE_* override single settings. Never shows a key, only whether
      // the selected image provider has one.
      models: {
        tier: activeModelTier(),
        text: resolveModel('text'),
        layout: resolveModel('layout'),
        critique: resolveModel('critique'),
        judge: resolveModel('judge'),
        ornament: (() => {
          try {
            return resolveOrnamentSettings();
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        })(),
        image: (() => {
          try {
            const img = resolveImageSettings();
            const key = img.provider === 'google' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
            return { ...img, key: key ? 'present' : 'missing' };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        })(),
      },
      dependencies: {
        postgres: dbStatus,
        parkedClientMessages: parkedUpdates,
        canva: canvaStatus,
        canvaCircuitBreaker: canvaBreakerState.state,
        telegram: telegramStatus,
        waha: wahaStatus,
        disk: diskStatus,
        restate: restateStatus,
        restatePausedInvocations: restateWork.paused ?? restateWork.status,
        modelProvider: modelProviderStatus,
        telegramApi: telegramApiStatus,
        funnel: funnelStatus,
        cutout: cutoutStatus,
        ...(funnelMetrics?.alert ? { funnelAlert: funnelMetrics.alert } : {}),
        ...(spendingPolicyStatus !== 'valid' ? { spendingPolicy: spendingPolicyStatus } : {}),
        ...(bridgeStatus?.lastError ? { telegramLastError: bridgeStatus.lastError.code } : {}),
      },
    }, isUnhealthy ? 503 : 200);
  };

  // A task as Postgres has it, for routes about to act on its status (services/task-reader.ts).
  const { resolveTaskWithFallback, readCurrentTask } = createTaskReader({ db, taskRepo, tasks });

  // Delivery of an approved design to Drive, Sheets and the requester (services/omnichannel-delivery.ts).
  const {
    executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery,
    requesterChatOf, deliveryExecutorOfTask, prepareWorkflowDelivery,
  } = createOmnichannelDelivery({
    db, taskRepo, outboxRepo, publicationRepo, publisher, deliverableStore, events,
    isProduction, readCurrentTask, resolveClientDna, broadcastEvent: broadcast,
  });

  // Helper to register routes for /v1/..., /api/v1/..., /api/... and /...
  // All routes are deny-by-default: unless the route is an explicit public probe/asset/webhook
  // or the session endpoint, an unauthenticated caller gets 401 before the handler runs.

  const PUBLIC_MUTATION_PATHS = new Set(['/auth/session', '/auth/telegram-miniapp']);
  const isPublicMutation = (path: string) => PUBLIC_MUTATION_PATHS.has(path) || path.startsWith('/webhooks/');

  const PUBLIC_READ_PATHS = new Set([
    '/auth/session',
    '/auth/providers',
    '/auth/google/start',
    '/auth/google/callback',
    '/health',
    '/ready',
    '/system/studio-status',
    '/system/cutover/status',
    '/system/funnel/health',
    '/adapters/telegram/status',
    '/waha/health',
  ]);
  const isPublicRead = (path: string) =>
    PUBLIC_READ_PATHS.has(path) ||
    path.startsWith('/fonts/cdn/') ||
    path.startsWith('/adapters/figma/') ||
    path.includes('figma') ||
    path.startsWith('/webhooks/');

  // Routes that authenticate the request themselves, with more than the bearer header: the event
  // stream also takes a one-use ticket, since EventSource cannot send a header (ADR-037).
  const SELF_AUTHENTICATED_READS = new Set(['/events/stream', '/monitoring/availability/probe']);
  const SELF_AUTHENTICATED_WRITES = new Set(['/monitoring/availability/observations']);

  const registerRoute = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: any) => {
    const isPublic = method === 'get' ? isPublicRead(path) || SELF_AUTHENTICATED_READS.has(path) :
      isPublicMutation(path) || method === 'post' && SELF_AUTHENTICATED_WRITES.has(path);
    const guarded = isPublic
      ? handler
        : async (c: any, next: any) => {
          if (method !== 'get' && !c.req.header('Authorization')) {
            const cookieSession = getCookie(c, 'hawa_session');
            if (cookieSession) {
              const presented = c.req.header('x-hawa-csrf') || '';
              const expected = crypto.createHash('sha256').update(`${cookieSession}:csrf`).digest('hex');
              const origin = c.req.header('Origin');
              const requestOrigin = new URL(officeBrowserOrigin || c.req.url).origin;
              if (!secretsEqual(presented, expected) || (origin && origin !== requestOrigin)) {
                return problem(c, 403, 'CSRF Check Failed', 'The office session requires a same-origin request and CSRF proof');
              }
            }
          }
          await ensureSessionLoaded(bearerTokenOf(c));
          const auth = verifyRequestAuth(c);
          if (!auth.authenticated) return problem(c, 401, 'Authentication Required', 'Sign in to Hawa first');
          bindLogContext({ tenantId: auth.tenantId });
          return handler(c, next);
        };
    (app as any)[method](`/v1${path}`, guarded);
    (app as any)[method](`/api/v1${path}`, guarded);
    (app as any)[method](`/api${path}`, guarded);
    (app as any)[method](path, guarded);
  };

  const handleDecommissionedFigmaRoute = (c: any) => {
    return c.json(
      {
        error: 'FIGMA_TRANSPORT_DECOMMISSIONED',
        statusCode: 410,
        message:
          'The active Figma bridge and lease transport was decommissioned under CV-23 (ADR 021). All active design studio operations must use the Canva Native Studio (/system/studio-status).',
        activeStudio: 'canva_native',
        decommissionedUnder: 'CV-23',
        canonicalDocumentation: '/docs/CV-23-figma-decommission.md',
      },
      410
    );
  };

  // Everything a route module or shared service reads from createApp (core-context.ts). Typed, so a
  // field the context names and this object lacks fails the build.
  const routeContext: RouteContext = {
    app,
    registerRoute,
    options,
    isProduction,
    db,
    taskRepo,
    clientRepo,
    outboxRepo,
    revisionRepo,
    publicationRepo,
    unifiedIngress,
    telegramBridge,
    telegramActionTokenService,
    evaluationService,
    canvaConnectService,
    deliverableStore,
    qaEngine,
    creativeDirector,
    publisher,
    voiceTranscriber,
    telegramAllowedUsers,
    telegramIntakeUsers,
    tasks,
    events,
    briefs,
    clientDnas,
    clientSnapshots,
    uploadedAssets,
    historicalMigrator: globalHistoricalMigrator,
    globalCanvaNativeAdapter,
    globalCanvaCircuitBreaker,
    channelKillSwitches,
    subscribers,
    verifyRequestAuth,
    problem,
    broadcastEvent: broadcast,
    broadcastTransition,
    resolveTaskWithFallback,
    readCurrentTask,
    resolveClientDna,
    delivery: {
      executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery,
      requesterChatOf, deliveryExecutorOfTask, prepareWorkflowDelivery,
    },
    probeModelProvider,
    paidModelHealth,
    honestHealthHandler,
    handleDecommissionedFigmaRoute,
    ensureSessionLoaded,
    bearerTokenOf,
    saveSession,
    persistSession,
    revokeSession,
    streamTickets,
  };

  if (options?.customerApi) {
    if (!db || officeAccess.mode === 'trusted_office')
      throw new Error('Customer API requires durable storage and required office authentication');
    registerCustomerRoutes(app, new CustomerRequests(db, DEFAULT_TENANT_ID, canvaConnectService ?? undefined),
      createWorkspaceMemberVerifier(options.customerApi), false); // ADR260: full customer journey admission remains pending.
  }
  registerCustomerAdminRoutes(routeContext);
  registerSystemRoutes(routeContext);
  registerPublicationInspectionRoutes(routeContext,Boolean(db && options?.enablePublicationInspections));
  registerCanvaRoutes(routeContext, options?.canvaOptions);
  registerDesignStudioRoutes(routeContext, options?.designStudioOptions, options?.designStudioService);
  registerStudioRecoveryRoutes(routeContext);
  registerCallCostRoutes(routeContext);
  registerSpendingPolicyRoutes(routeContext);
  registerAuthRoutes(routeContext);
  registerClientsRoutes(routeContext);
  registerEvalsRoutes(routeContext);
  registerComparisonRoutes(routeContext);
  registerIngressRoutes(routeContext);

  // The route groups being moved out of createApp (architecture programme 1.3, SPLIT_PLAN.md section
  // 2), in the plan's order. Each module is filled by one group; nothing else here changes when it is.
  // Registration order between modules decides nothing: no two routes of one method can match one URL
  // except GET revisions/diff before revisions/:revisionId, both in revisions.routes.ts (route-inventory
  // test, N2).
  registerMigrationRoutes(routeContext);
  registerAssetsRoutes(routeContext);
  registerSimulatorsRoutes(routeContext);
  registerFontsRoutes(routeContext);
  registerRubricRoutes(routeContext);
  registerSystemStatusRoutes(routeContext);
  registerClientLearningRoutes(routeContext);
  registerRevisionsRoutes(routeContext);
  registerDecisionsRoutes(routeContext);
  registerOfficeReviewAdminRoutes(routeContext);
  registerCanvaOutcomeRoutes(routeContext);
  registerDeliveryRoutes(routeContext);
  registerDeliveryInternalRoutes(routeContext);
  registerOutboxRoutes(routeContext);
  registerControlsRoutes(routeContext);
  registerTasksRoutes(routeContext);
  registerTaskPipelineRoutes(routeContext);
  registerSearchRoutes(routeContext);
  registerWhatsappRoutes(routeContext);

  if (db && options?.enablePublicationInspections) {
    const inspections = new PublicationInspectionService(db,options.publicationInspector || new GooglePublisher());
    startPublicationInspectionSchedule(inspections,defaultTenantId,(cause) => log.warn(`[publication-inspections] Pass not confirmed (${cause}); durable claims retain their state.`));
  }

  // (Reminders about drafts a requester had not answered went with ADR-135 stage 2d: they reminded
  // only old-intake tasks, with buttons nothing reads any more.)

  // Canva operations nobody follows any more (an import still settling when the studio stopped
  // polling, an export the worker ran out of polls for, a call cut off by a restart) are settled
  // every five minutes. Unknown creations retain their reconciliation hold (ADR-108).
  // A check export it retrieves is recorded as the draft's QC run, as a Desk capture is.
  if (db && canvaConnectService && options?.enableCanvaSweeper) {
    const sweepDb = db;
    const sweeper = canvaConnectService;
    const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' };
    const pass = async () => {
      try {
        const swept = await sweeper.sweepStrandedOperations({ tenantId: DEFAULT_TENANT_ID, actorId: SYSTEM_AUTOMATION_USER_ID });
        if (swept.sweptCount) log.info(`[canva-sweeper] settled ${swept.sweptCount} operation(s):`, JSON.stringify(swept.settled));
        const { recordCheckedExportQc } = await import('./services/canva-task-outcome.js');
        const checked = new Set(swept.settled.filter((o) => o.kind === 'export' && o.format === 'pptx' && o.status === 'retrieved').map((o) => o.taskId));
        for (const taskId of checked) {
          await withRlsContext(sweepDb, scope, (trx) => recordCheckedExportQc(trx, evaluateCanvaExportQc, { tenantId: DEFAULT_TENANT_ID, taskId }))
            .catch((err) => log.warn(`[canva-sweeper] task ${taskId}: check not recorded:`, (err as Error)?.message || err));
        }
      } catch (err) {
        log.warn('[canva-sweeper] pass failed:', (err as Error)?.message || err);
      }
    };
    setInterval(pass, 5 * 60_000).unref?.();
    setTimeout(pass, 120_000).unref?.();
  }

  // Requests waiting too long for a person (in review, approved and not sent, handed to the office after
  // a failed design, a question unanswered after its reminders): every office member hears of each once
  // per stage (ADR-155, services/lifecycle-stale-sweep.ts). Started with the Canva sweeper.
  if (db && options?.enableCanvaSweeper) {
    const staleDb = db;
    const stalePass = async () => {
      try {
        const { sweepStaleLifecycleRequests } = await import('./services/lifecycle-stale-sweep.js');
        const alerted = await sweepStaleLifecycleRequests(staleDb, { tenantId: DEFAULT_TENANT_ID, officeChatIds: telegramAllowedUsers, nowMs: Date.now() });
        if (alerted.length) log.info(`[lifecycle-stale] alerted the office about ${alerted.length} waiting request(s):`, JSON.stringify(alerted));
      } catch (err) {
        log.warn('[lifecycle-stale] pass failed:', (err as Error)?.message || err);
      }
    };
    setInterval(stalePass, 15 * 60_000).unref?.();
    setTimeout(stalePass, 180_000).unref?.();
  }

  // A paid call with no provider outcome for hours is charged its whole reservation, recorded as
  // System Automation's evidence, so it stops blocking its task and every later office day (ADR-159).
  if (db && options?.enableUncertainCallExpiry) {
    const settlement = new StudioCallSettlementService(db);
    const expire = async () => {
      try {
        const charged = await settlement.settleExpired(DEFAULT_TENANT_ID);
        if (charged.studioRuns.length || charged.plannerCalls.length) log.warn('[uncertain-calls] charged in full:', JSON.stringify(charged));
      } catch (err) {
        log.warn('[uncertain-calls] pass failed:', (err as Error)?.message || err);
      }
    };
    setInterval(expire, 15 * 60_000).unref?.();
    setTimeout(expire, 180_000).unref?.();
  }

  // Client DNA as the office saved it in PostgreSQL, loaded before the port opens (a test may have
  // seeded invented offices above; the database wins: see client-dna-hydration.ts). Production
  // refuses to start when it cannot be read.
  const clientDnaHydrated: Promise<number> = db
    ? hydrateClientDnaFromDb(db, clientDnas, { tenantId: defaultTenantId, userId: operatorUserId }, { dropUnknown: isProduction }).then(
        (n) => { log.info(`[core:client_dna] hydrated ${n} client(s) from PostgreSQL`); return n; },
        (err) => {
          log.error('[core:client_dna] could not hydrate client DNA from PostgreSQL:', err?.message || err);
          if (isProduction) throw err;
          return 0;
        }
      )
    : Promise.resolve(0);

  // Every client pack has its hawa.clients row (ADR-127): a request routed to a client added since
  // this database was built could not otherwise be saved. Missing rows only; nothing is changed.
  if (db) {
    ensureClientPackRows(db, DEFAULT_TENANT_ID, clientPacks())
      .catch((err) => log.error('[client-packs] could not check the client rows:', (err as Error)?.message || err));
  }

  // The worker's calls into Core (Phase 2.1): ChatInbox hands each polled update to intake here, and
  // dead-letters one intake keeps failing. Only HAWA_WORKER_TOKEN opens them (verifyRequestAuth).
  registerLifecycleInternalRoutes(routeContext);
  // Only the worker polls (ADR-135): without its credential nothing reaches intake.
  if ((isProduction || (process.env.HAWA_TELEGRAM_POLLER || '').trim().toLowerCase() === 'worker') && !serviceTokenOf()) {
    log.error('[core:internal] HAWA_WORKER_TOKEN is not usable here: the worker cannot hand updates to intake, and Core does not poll. Set HAWA_WORKER_TOKEN in .env.production (infra/docker/README.md).');
  }
  for (const retired of retiredTelegramSettings(process.env, { production: isProduction })) log[retired.level](`[core] ${retired.message}`);

  // index.ts awaits clientDnaHydrated before it opens the port.
  return Object.assign(app, { clientDnaHydrated });
}
