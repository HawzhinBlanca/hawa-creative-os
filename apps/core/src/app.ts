import { persistChatIntake, findRequestAwaitingReference, findAlbumRequest, splitBilingualRequest, runsPipelineV3, PICTURE_ONLY_DIRECTIVE } from './services/chat-intake.js';
import { createPolledUpdateHandler, parkTelegramUpdate } from './services/polled-update-dispatch.js';
import { PostgresTelegramPollState, telegramBotKey } from './services/telegram-poll-state.js';
import { detectFontRequests, scriptLabel, unavailableFontNotice } from './services/feedback-font-request.js';
import { peelTrailingRemarks } from './services/request-remarks.js';
import { hydrateClientDnaFromDb, loadActiveClientDna } from './services/client-dna-hydration.js';
import { probeRestate } from './services/restate-probe.js';
import { createRestateInvocationProbe } from './services/restate-invocations.js';
import { log, requestLogContext, bindLogContext, runWithLogContext, requestIdHeaders } from './logging.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type {
  RequestContext,
  UUID,
  NeutralManifest,
  DesignStudioAdapter,
  StudioOperation,
} from '@hawa/contracts';
import { CHANNEL_INGRESS_USER_ID, SYSTEM_AUTOMATION_USER_ID, PRIMARY_OPERATOR_USER_ID, TASK_TRANSITIONED_EVENT, isTaskApiStatus, isTaskDbState, taskTransitioned, type TaskDbState } from '@hawa/contracts';
import {
  TaskStateMachine,
  extractProtectedTokens,
  validateClientDna,
  validateUploadedAsset,
  sanitizeSvg,
  type TaskStatus,
  type ClientDNA,
  type DesignBrief,
  type ExactCopyBlock,
  type ApprovalDecision,
  type FeedbackEvent,
  type CandidateRule,
  type DomainFailure,
  TaskWorkflowController,
  type TaskActor,
  type WorkflowCheckpoint,
  kaaeClientDNA,
  isAuthorizedReviewerRole,
  resolveModel,
  resolveImageSettings,
  activeModelTier,
  type PinnedExport,
} from '@hawa/domain';
import {
  createDb,
  withRlsContext,
  withSessionAdvisoryLock,
  TaskRepository,
  ClientRepository,
  IngressRepository,
  OutboxRepository,
  RevisionRepository,
  PublicationRepository,
  CanvaBindingRepository,
  IdempotencyConflictError,
  ConcurrencyConflictError,
  toDbTaskState,
  toApiTaskStatus,
  listTaskPage,
  decodeTaskCursor,
  dbStatesForApiStatuses,
  TASK_PAGE_DEFAULT_LIMIT,
  TASK_PAGE_MAX_LIMIT,
  sql,
  type Database,
  type Kysely,
  type TaskState,
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

import {
  CreativeDirectorRunner,
  ComfySandboxValidator,
  type ComfyWorkflowGraph,
  type ComfyWorkflowTemplateId,
  COMFY_WORKFLOW_TEMPLATES,
  ASPECT_RATIO_DIMENSIONS,
  buildComfyWorkflowForTemplate,
  buildCompositedVisualBackdrop,
  generateSmartContrastScrim,
  calculateContrastRatio,
  globalFeedbackMiner,
  type CandidateRuleProposal,
  type ArtboardSnapshot,
  diffDocumentManifests,
  renderOperationsToPng,
  parseInvitationContent,
  resolveOrnamentSettings,
  OpenAiStudioClient,
} from '@hawa/creative';
import {
  DeterministicQAEngine,
  checkCanvaPptx,
  inspectKurdishFontCoverage,
  KURDISH_SORANI_GLYPH_TABLE,
  packageKurdishWebFont,
  generateKurdishFontFaceCss,
  evaluateVisionRubric,
  type FontCoverageResult,
  type KurdishWebFontPackage,
  type QualityEvaluationCandidate,
  type QualityRubricReport,
  type RubricCanvasNode,
} from '@hawa/qa';
import {
  VaultSearchEngine,
  type SearchableItem,
  type SearchQuery,
  type SearchCategory,
} from '@hawa/retrieval';
import {
  GooglePublisher,
  ReconciliationService,
  KurdishVoiceTranscriber,
  ResilientModelGateway,
  globalCostGovernor,
  WahaIngressHandler,
  normalizeKurdishIncomingText,
  buildOutboundReviewDispatch,
  verifyActionSignature,
  computeActionSignature,
  parseCallbackData,
  type CostReceipt,
  type ClientBudgetConfig,
  TelegramBridgeDaemon,
  KAAE_CLIENT_ID,
  UnifiedIngressService,
  MemoryIngressPersistenceAdapter,
  validateFetchDestination,
  sanitizeIngressContent,
  validateIngressAttachment,
  TelegramActionTokenService,
  verifyTelegramMiniAppInitData,
  HumanApprovalManager,
  HistoricalDesignMigrator,
  CanvaNativeAdapter,
  CanvaDesignStudioAdapter,
  validateCanvaDesignUrl,
  CircuitBreaker,
  type TelegramUpdate,
} from '@hawa/integrations';
import { PostgresIngressPersistenceAdapter } from './ingress-persistence-adapter.js';
import { EvaluationRunner } from '@hawa/evals';
import { SyntheticTrafficDaemon } from '@hawa/testkit';
import { registerCanvaRoutes } from './routes/canva.routes.js';
import { registerDesignStudioRoutes } from './routes/design-studio.routes.js';
import { type DesignStudioServiceOptions, DesignStudioService } from './services/design-studio/index.js';
import { studioStatusNote, requesterDraftNotes } from './services/design-studio/studio-status-note.js';
import { escapeTelegramHtml } from '@hawa/integrations';
import { CanvaConnectService, type CanvaServiceOptions } from './services/canva-connect-service.js';
import { manifestFromOperations } from './services/generated-manifest.js';
import {
  canvaDeliverableStore,
  EMPTY_DELIVERABLE_STORE,
  loadPinnedDeliverables,
  parsePinnedExportIds,
  type DeliverableStore,
} from './services/pinned-deliverables.js';
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
import { registerCanvaOutcomeRoutes } from './routes/canva-outcome.routes.js';
import { registerDeliveryRoutes } from './routes/delivery.routes.js';
import { registerOutboxRoutes } from './routes/outbox.routes.js';
import { registerControlsRoutes } from './routes/controls.routes.js';
import { registerTasksRoutes } from './routes/tasks.routes.js';
import { registerTaskPipelineRoutes } from './routes/task-pipeline.routes.js';
import { registerSearchRoutes } from './routes/search.routes.js';
import { registerWhatsappRoutes } from './routes/whatsapp.routes.js';
import { createChatCampaignIntake } from './services/chat-campaign-intake.js';
import { createChannelKillSwitchStore } from './services/channel-kill-switches.js';
import { registerTelegramWebhookRoutes } from './routes/telegram-webhook.routes.js';
import { composeCanvaStatusMessage, composeChangeNeedsDesignerAlert } from './services/canva-status-message.js';
import {
  parseRequesterAction,
  composeRequesterApproved,
  composeChangePrompt,
  composeDesignerTakesOver,
  composeReplacedDraft,
  composeChangeInProgress,
  composeRequesterApprovedAlert,
  composeDesignerHandoff,
  composeAnswerTaken,
  composeSizeStarted,
  answerIndex,
  sizeOf,
  type RequesterAction,
  type AskRecord,
} from './services/requester-actions.js';
import { classifyInboundTelegramMessage } from './services/telegram-classifier.js';
import { sniffImageMime, isUsableImage, TELEGRAM_BOT_DOWNLOAD_MAX_BYTES } from './services/telegram-media.js';
import type { GuidelinesModel } from './services/brand-guidelines.js';
import { handleGuidelinesPdf, handleRulesCommand, saveChatRule, ruleClientById, type RulesIntakeDeps } from './services/telegram-rules-intake.js';
import { parseRulesCommand, isStandingRule } from './services/standing-rules-chat.js';
import { CanvaDesignPlanner, unwrapCopyEnvelope } from './services/canva-design-planner.js';
import { checkProductionFunnelHealth } from './services/funnel-monitor.js';
import { PhotoCutouts } from './services/design-studio/photo-cutouts.js';
import { remindUnansweredDrafts } from './services/draft-reminders.js';
import { revisionMetrics } from './services/revision-metrics.js';
import { askLedger } from './services/ask-ledger.js';
import { createStreamTicketStore } from './services/stream-tickets.js';
import {
  canonicalJson,
  computeDnaHash,
  isValidUuid,
  inlineTemplateCopyMissing,
  COPY_REQUIRED_DETAIL,
  TaskStoreUnavailableError,
  qaReportSha256,
  secretsEqual,
  probeDatabase,
  evaluateCanvaExportQc,
  cutText,
  type CreateAppOptions,
} from './core-helpers.js';
import type { ClientDnaSnapshot, RouteContext } from './routes/types.js';
import type { QAEngine } from '@hawa/contracts';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID, ADMIN_USER_ID, DEFAULT_CLIENT_ID } from './core-context.js';
import { createTaskReader } from './services/task-reader.js';
import { createClientDnaResolver } from './services/client-dna-resolver.js';
import { LIVE_RUN } from './services/live-run.js';
import { pendingChangeOf as findPendingChange, pendingChangeWords } from './services/pending-change.js';
import { createOmnichannelDelivery, type OmnichannelDeliveryDeps } from './services/omnichannel-delivery.js';

// What app.ts exported before its helpers moved to core-helpers.ts; tests and scripts import them from here.
export { canonicalJson, computeDnaHash, isValidUuid, inlineTemplateCopyMissing, qaReportSha256, secretsEqual, probeDatabase, evaluateCanvaExportQc };
export type { CreateAppOptions, DatabaseProbeStatus, CanvaQcEvaluationResult } from './core-helpers.js';
export type { ClientDnaSnapshot } from './routes/types.js';

const globalHistoricalMigrator = new HistoricalDesignMigrator();
const globalCanvaNativeAdapter = new CanvaNativeAdapter();
const globalCanvaCircuitBreaker = new CircuitBreaker({ name: 'canva-api', failureThreshold: 3, cooldownMs: 5000 });

export function createApp(options?: CreateAppOptions) {
  const app = new Hono();
  const currentEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const isProduction = currentEnv === 'production';
  const db = options?.db || (process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : null);
  // Brand guidelines being read in the background after the sender was answered; tests await them.
  const guidelineReadings = new Set<Promise<void>>();
  // Albums already answered in a chat (one reply per album, not one per photo).
  const acknowledgedAlbums = new Set<string>();
  // A message the bot asked about ("revise the last design, or a new one?"), kept until answered.
  const pendingClarifications = new Map<string, { rawText: string; referenceImageBase64?: string; task?: any; at: number }>();
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
    origin: '*',
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
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
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' https:; frame-ancestors 'none';");
    await next();
  });

  app.onError((err, c) => {
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
      instance: c.req.url,
    }, status);
  }

  // Domain singletons
  const creativeDirector = new CreativeDirectorRunner();
  const qaEngine: QAEngine = options?.qaEngine || new DeterministicQAEngine();
  // Production Studio is strictly Canva Native Studio under ADR 021 & CV-22/CV-23
  const activeStudioType = 'canva';
  const publisher = options?.publisher || new GooglePublisher();
  const modelGateway = new ResilientModelGateway();
  const evalRunner = new EvaluationRunner(modelGateway);
  // Zero seed probes: every SLO data point must come from a probe that actually ran.
  const sloDaemon = new SyntheticTrafficDaemon(0, { publisher });
  const reconciliationService = new ReconciliationService();
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
      secretToken: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      targetIngressUrl: 'http://127.0.0.1:8080/api/webhooks/telegram',
      deskBaseUrl:
        process.env.PUBLIC_TUNNEL_URL ||
        process.env.HAWA_PUBLIC_URL ||
        process.env.HAWA_DESK_BASE_URL ||
        'http://127.0.0.1:8080',
      actionTokenService: telegramActionTokenService,
      allowedUserIds: telegramAllowedUsers,
    });
  // The office's switches, kept in Postgres so a restart keeps a thrown one (architecture programme
  // 1.3, G8; services/channel-kill-switches.ts). Without a database they are this app's alone.
  const channelKillSwitchStore = createChannelKillSwitchStore(db);
  const channelKillSwitches = channelKillSwitchStore.switches;
  // The office's Telegram kill switch stops intake at the source: while it is on, the poller asks
  // Telegram for nothing (the webhook route refuses with 503 below). It used to change only the
  // health report, and messages kept being read and designs kept being started. Until Postgres has
  // been read the poller waits too: it cannot know yet whether the office switched intake off. Polls
  // queue behind the first read (for at most 10 s, so "poll now" answers while Postgres is down) and
  // stay paused while it has not succeeded.
  telegramBridge.pauseIntakeWhen?.(() => !channelKillSwitchStore.isLoaded() || channelKillSwitches.telegram);
  telegramBridge.waitBeforePolling?.(
    Promise.race([channelKillSwitchStore.loaded, new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref?.())])
  );

  // Local instance-scoped data structures
  const tasks = new Map<string, any>();
  const events = new Map<string, any[]>();
  const briefs = new Map<string, DesignBrief>();
  const revisions = new Map<string, any>();
  const decisions = new Map<string, ApprovalDecision[]>();
  const feedbacks = new Map<string, FeedbackEvent[]>();
  const clientDnas = new Map<string, ClientDNA>();
  const resolveClientDna = createClientDnaResolver({ db, clientDnas });

  const clientSnapshots = new Map<string, ClientDnaSnapshot[]>();

  const evalRuns = new Map<string, any>();
  const uploadedAssets = new Map<string, any>();
  const workflowControllers = new Map<string, TaskWorkflowController>();
  const rubricReports = new Map<string, QualityRubricReport[]>();
  const taskComments = new Map<string, any[]>();
  const omnichannelReceipts = new Map<string, any>();
  const inFlightPublications: OmnichannelDeliveryDeps['inFlightPublications'] = new Map();
  const inMemoryOutbox = options?.inMemoryOutbox ?? new Map<string, any[]>();

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
  const defaultClientId = DEFAULT_CLIENT_ID;
  options?.seedClientDna?.(clientDnas, clientSnapshots);

  interface IssuedSession {
    authenticated: boolean;
    tenantId: string;
    userId: string;
    actorId: string;
    role: string;
    displayName: string;
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
      await withRlsContext(db, sessionRls, (trx) => sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at)
        VALUES (${sessionHash(token)},${session.tenantId}::uuid,${session.userId}::uuid,${session.actorId},${session.role},${session.displayName},${new Date(session.expiresAt || Date.now() + 86400000)})`.execute(trx));
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
      const row = await withRlsContext(db, sessionRls, async (trx) => (await sql<any>`SELECT tenant_id,user_id,actor_id,role,display_name,expires_at,revoked_at
        FROM hawa.desk_sessions WHERE token_hash=${sessionHash(token)}`.execute(trx)).rows[0]);
      if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
        if (cached && row && (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now())) issuedSessions.delete(token);
        else if (cached && !row) issuedSessions.delete(token);
        return;
      }
      issuedSessions.set(token, {
        authenticated: true, tenantId: row.tenant_id, userId: row.user_id, actorId: row.actor_id, role: row.role,
        displayName: row.display_name, expiresAt: new Date(row.expires_at).getTime(), checkedAt: Date.now(),
      });
    } catch (err) {
      // Database trouble must not log everyone out: keep whatever the cache already knows.
      log.warn('[core:sessions] lookup failed; using cached sessions only:', err);
    }
  }
  const bearerTokenOf = (c: any): string | undefined => {
    const header = c.req.header('Authorization');
    if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
    return undefined;
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
  function verifyRequestAuth(c: any, ticketCredential?: string): { authenticated: boolean; tenantId: string; userId: string; actorId: string; role: string; displayName?: string } {
    let authHeader = ticketCredential ? `Bearer ${ticketCredential}` : c.req.header('Authorization');
    // Browser <img> elements cannot set request headers: media and preview endpoints may carry the
    // session token as an `access_token` query parameter (validated against issued sessions). The
    // event stream no longer does: it takes a one-use ticket instead (ADR-037).
    let isQueryToken = false;
    if (
      !authHeader &&
      (String(c.req.path || '').includes('/studio/') ||
        String(c.req.path || '').match(/\.(png|jpg|jpeg|webp|svg|pdf)$/i))
    ) {
      const queryToken = c.req.query('access_token');
      if (queryToken) {
        authHeader = `Bearer ${queryToken}`;
        isQueryToken = true;
      }
    }
    const botSecret = c.req.header('x-telegram-bot-api-secret-token');

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (botSecret) {
      // The webhook secret is shared with the Telegram platform. It authenticates webhook
      // deliveries only and must never act as an operator credential for the rest of the API.
      const isWebhookPath = String(c.req.path || '').startsWith('/api/webhooks/');
      if (isWebhookPath && secretsEqual(botSecret, expectedSecret)) {
        return { authenticated: true, tenantId: defaultTenantId, userId: operatorUserId, actorId: 'telegram_bot', role: 'adapter', displayName: 'Telegram Bridge' };
      }
      return { authenticated: false, tenantId: '', userId: '', actorId: 'anonymous', role: 'anonymous' };
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

        if (isQueryToken) {
          // Task R04: Static long-lived bearer credentials must never be passed in URL query parameters
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
  let lastVerifiedProgressAt = new Date().toISOString();

  // Active, scheduled paid billing probe (R1/F10)
  // Executes a minimal paid completion call (gpt-4o-mini, max_tokens: 1) every 3 minutes.
  // Real billing exhaustion (429 credit_balance_exhausted / insufficient_quota) and auth errors (401/403)
  // flip health to billing_exhausted / unauthorized and trigger operator alerts.
  interface PaidProbeState {
    at: number;
    status: string;
    detail?: any;
    lastAlertSentAt?: number;
    lastAlertMessageId?: string;
  }
  let lastPaidProbe: PaidProbeState = { at: 0, status: 'unverified' };

  const executePaidModelProbe = async (): Promise<{ status: string; detail?: any }> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { status: 'unconfigured' };
    if (options?.skipPaidModelProbe ?? !options?.enableBillingProbeSchedule) {
      return { status: lastPaidProbe.status !== 'unverified' ? lastPaidProbe.status : 'connected' };
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || resolveModel('text'),
          messages: [{ role: 'user', content: 'ping' }],
          // One token proves the key and the credit. A reasoning model stops at the limit, which the
          // handler below counts as connected.
          max_completion_tokens: 1,
        }),
        signal: AbortSignal.timeout(7000),
      });

      if (res.status === 401 || res.status === 403) {
        const errJson: any = await res.json().catch(() => ({}));
        return { status: 'unauthorized', detail: errJson?.error || { message: `HTTP ${res.status}` } };
      } else if (res.status === 429) {
        const errJson: any = await res.json().catch(() => ({}));
        const code = errJson?.error?.code;
        const type = errJson?.error?.type;
        const isBilling = code === 'credit_balance_exhausted' || type === 'insufficient_quota';
        return {
          status: isBilling ? 'billing_exhausted' : 'rate_limited',
          detail: errJson?.error || { message: 'Rate limit or billing exhaustion' },
        };
      } else if (res.ok) {
        return { status: 'connected' };
      } else {
        const errJson: any = await res.json().catch(() => ({}));
        if (errJson?.error?.message?.includes('max_tokens or model output limit was reached')) {
          return { status: 'connected' };
        }
        return { status: `http_${res.status}`, detail: errJson?.error || { message: `HTTP ${res.status}` } };
      }
    } catch (err: any) {
      return { status: 'unreachable', detail: { message: err?.message || 'Network error' } };
    }
  };

  const checkAndAlertBilling = async (probeResult: { status: string; detail?: any }) => {
    lastPaidProbe = {
      at: Date.now(),
      status: probeResult.status,
      detail: probeResult.detail,
      lastAlertSentAt: lastPaidProbe.lastAlertSentAt,
      lastAlertMessageId: lastPaidProbe.lastAlertMessageId,
    };
    lastVerifiedProgressAt = new Date().toISOString();

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
            lastPaidProbe.lastAlertMessageId = outRes?.messageId ? String(outRes.messageId) : (outRes?.message_id ? String(outRes.message_id) : `alert_${now}`);
          } catch (err) {
            log.error('[HealthProbe] Watchdog alert delivery failed:', err);
          }
        }
      }
    }
  };

  const probeModelProvider = async (): Promise<string> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return 'unconfigured';
    if (options?.skipPaidModelProbe ?? !options?.enableBillingProbeSchedule) {
      return lastPaidProbe.status !== 'unverified' ? lastPaidProbe.status : 'connected';
    }

    // Health reports the scheduled probe's last result and never pays for one itself: Docker checks
    // /health every 10 s, and an inline probe on a stale result made the 3-minute schedule a floor.
    return lastPaidProbe.status;
  };

  // The paid billing probe runs on a schedule only: HAWA_BILLING_PROBE_MINUTES, default 30, never
  // under 5. It ran every 3 minutes with up to 100 output tokens on gpt-6-astra from 2026-09-16:
  // 480 paid calls a day, up to ~$2.40, recorded nowhere. A design that hits exhausted credit
  // already fails with INSUFFICIENT_QUOTA and tells the requester; this only warns the owner early.
  const billingProbeMs = Math.max(5, Number(process.env.HAWA_BILLING_PROBE_MINUTES) || 30) * 60_000;
  if (options?.enableBillingProbeSchedule) {
    setTimeout(async () => {
      try {
        const res = await executePaidModelProbe();
        await checkAndAlertBilling(res);
      } catch (err) {
        log.error('[HealthProbe] Initial probe failed:', err);
      }
    }, 2000);
    setInterval(async () => {
      try {
        const res = await executePaidModelProbe();
        await checkAndAlertBilling(res);
      } catch (err) {
        log.error('[HealthProbe] Scheduled probe failed:', err);
      }
    }, billingProbeMs);
  }

  // The bot credential is probed with getMe at most every five minutes: a revoked or stale token
  // must show in /health, not as a silent poll loop that never receives updates again.
  let telegramProbe: { at: number; status: string } = { at: 0, status: 'unverified' };
  const probeTelegram = async (): Promise<string> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return 'unconfigured';
    if (options?.skipTelegramProbe ?? !options?.enableTelegramPolling) return 'unverified';
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
    let canvaStatus = canvaBreakerState.state === 'OPEN' ? 'outage' : (canvaBreakerState.state === 'HALF_OPEN' ? 'degraded' : 'connected');
    // The breaker only counts failed calls. An expired authorization fails every design at the Canva
    // transfer while the breaker stays closed: from 2026-09-17 to 2026-09-18 health said "connected"
    // while the connection needed reconnecting. Designs transfer as the Primary Operator, so that is
    // the connection that counts.
    if (canvaStatus === 'connected' && db) {
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

    const modelProviderStatus = await probeModelProvider();
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
        // DB error already reported under postgres dependency probe
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
    const isUnhealthy = dbStatus === 'disconnected' || (isProduction && dbStatus !== 'connected') || diskStatus === 'read_only';
    const isDegraded = canvaStatus === 'outage' || canvaStatus === 'degraded' || canvaStatus === 'reconnect_required' || channelKillSwitches.telegram || channelKillSwitches.waha
      || modelProviderStatus === 'unauthorized' || modelProviderStatus === 'unreachable' || modelProviderStatus === 'billing_exhausted'
      || telegramApiStatus === 'unauthorized' || telegramApiStatus === 'unreachable' || telegramStatus === 'degraded'
      || restateStatus === 'unregistered' || restateStatus === 'unreachable'
      || funnelStatus === 'stalled'
      || parkedUpdates > 0
      || (restateWork.paused ?? 0) > 0;
    const status = isUnhealthy ? 'unhealthy' : (isDegraded ? 'degraded' : 'healthy');

    return c.json({
      status,
      timestamp: new Date().toISOString(),
      buildCommit: process.env.HAWA_BUILD_COMMIT || 'unknown',
      flags: {
        DESIGN_PIPELINE_V3: process.env.DESIGN_PIPELINE_V3 || 'off',
        DESIGN_STUDIO_V2: process.env.DESIGN_STUDIO_V2 || 'off',
      },
      lastVerifiedProgressAt,
      lastPaidProbe: {
        at: lastPaidProbe.at ? new Date(lastPaidProbe.at).toISOString() : null,
        status: lastPaidProbe.status,
        detail: lastPaidProbe.detail || null,
        lastAlertMessageId: lastPaidProbe.lastAlertMessageId || null,
        everyMinutes: billingProbeMs / 60_000,
      },
      funnel: funnelMetrics,
      restateInvocations: restateWork,
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
        ...(bridgeStatus?.lastError ? { telegramLastError: bridgeStatus.lastError.code } : {}),
      },
    }, isUnhealthy ? 503 : 200);
  };

  // A task as Postgres has it, for routes about to act on its status (services/task-reader.ts).
  const { resolveTaskWithFallback, readCurrentTask } = createTaskReader({ db, taskRepo, tasks });

  // Delivery of an approved design to Drive, Sheets and the requester (services/omnichannel-delivery.ts).
  const { executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery } = createOmnichannelDelivery({
    db, taskRepo, outboxRepo, publicationRepo, publisher, deliverableStore, decisions, events, omnichannelReceipts,
    inFlightPublications, inMemoryOutbox, isProduction, readCurrentTask, resolveClientDna, broadcastEvent: broadcast,
  });

  // Helper to register routes for /v1/..., /api/v1/..., /api/... and /...
  // All routes are deny-by-default: unless the route is an explicit public probe/asset/webhook
  // or the session endpoint, an unauthenticated caller gets 401 before the handler runs.

  const PUBLIC_MUTATION_PATHS = new Set(['/auth/session', '/auth/telegram-miniapp']);
  const isPublicMutation = (path: string) => PUBLIC_MUTATION_PATHS.has(path) || path.startsWith('/webhooks/');

  const PUBLIC_READ_PATHS = new Set([
    '/auth/session',
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
  const SELF_AUTHENTICATED_READS = new Set(['/events/stream']);

  const registerRoute = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: any) => {
    const isPublic = method === 'get' ? isPublicRead(path) || SELF_AUTHENTICATED_READS.has(path) : isPublicMutation(path);
    const guarded = isPublic
      ? handler
      : async (c: any, next: any) => {
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
    sloDaemon,
    evaluationRunner: evalRunner,
    reconciliationService,
    canvaConnectService,
    deliverableStore,
    qaEngine,
    creativeDirector,
    publisher,
    voiceTranscriber,
    telegramAllowedUsers,
    telegramIntakeUsers,
    guidelineReadings,
    tasks,
    events,
    briefs,
    revisions,
    decisions,
    feedbacks,
    clientDnas,
    clientSnapshots,
    evalRuns,
    uploadedAssets,
    workflowControllers,
    rubricReports,
    taskComments,
    omnichannelReceipts,
    inFlightPublications,
    inMemoryOutbox,
    historicalMigrator: globalHistoricalMigrator,
    globalCanvaNativeAdapter,
    globalCanvaCircuitBreaker,
    channelKillSwitches,
    issuedSessions,
    subscribers,
    verifyRequestAuth,
    problem,
    broadcastEvent: broadcast,
    broadcastTransition,
    resolveTaskWithFallback,
    readCurrentTask,
    resolveClientDna,
    delivery: { executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery },
    probeModelProvider,
    honestHealthHandler,
    handleDecommissionedFigmaRoute,
    ensureSessionLoaded,
    bearerTokenOf,
    saveSession,
    persistSession,
    revokeSession,
    streamTickets,
  };

  registerSystemRoutes(routeContext);
  registerCanvaRoutes(routeContext, options?.canvaOptions);
  registerDesignStudioRoutes(routeContext, options?.designStudioOptions, options?.designStudioService);
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
  registerCanvaOutcomeRoutes(routeContext);
  registerDeliveryRoutes(routeContext);
  registerOutboxRoutes(routeContext);
  registerControlsRoutes(routeContext);
  registerTasksRoutes(routeContext);
  registerTaskPipelineRoutes(routeContext);
  registerSearchRoutes(routeContext);
  registerWhatsappRoutes(routeContext);
  registerTelegramWebhookRoutes(routeContext);

  // Moved to services/chat-campaign-intake.ts (architecture programme 1.3, G8); the Telegram webhook below still calls it here.
  const { ingestChatCampaignTask } = createChatCampaignIntake(routeContext);

  // --- Re-drive Failed Tasks & Automated Recovery Sweep ---
  // Moved to services/redrive.ts with the controls routes (architecture programme 1.3, G6). The
  // Telegram handler's /redo still calls it by this name until Telegram intake moves (G9). The module
  // is imported here, where it is used, so this move left the shared import list alone.
  const redriveTask = async (...args: Parameters<import('./services/redrive.js').Redrive['redriveTask']>) =>
    (await import('./services/redrive.js')).createRedrive(routeContext).redriveTask(...args);

  /**
   * Whether this Telegram update already saved something: a request or revision (persistChatIntake
   * keys it `<chat>:<update>` and `<chat>:<update>_<suffix>`), an answered question, a rule, a PDF
   * being read. Read before any paid call.
   */
  async function telegramUpdateHandled(chat: string, updateId: string): Promise<{ taskId?: string } | false> {
    if (!db) return false;
    const key = `${chat}:${updateId}`;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; task_id: string | null }>`SELECT e.id,
          (SELECT o.aggregate_id FROM hawa.outbox_commands o WHERE o.tenant_id = e.tenant_id AND o.command_type = 'task.created'
            AND o.idempotency_key = ${`chat:telegram:${key}`} LIMIT 1) AS task_id
        FROM hawa.inbox_events e
        WHERE e.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND e.source_account_id = 'telegram'
          AND (e.source_event_id = ${key} OR e.source_event_id LIKE ${`${key}\\_%`})
        LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.task_id || undefined } : false;
  }

  /** Records a side effect that leaves no task behind (a rule saved, a rule removed, a PDF read). */
  async function markTelegramUpdateHandled(chat: string, updateId: string, kind: string, payload: unknown): Promise<void> {
    if (!db || !chat || chat === 'tg_default' || !updateId) return;
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : { value: payload };
    try {
      await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
        await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
          SELECT ${DEFAULT_TENANT_ID}::uuid, 'telegram', ${`${chat}:${updateId}`}, ${kind}, ${JSON.stringify(record)}::jsonb,
            ${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}, true
          WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid
            AND source_account_id = 'telegram' AND source_event_id = ${`${chat}:${updateId}`})`.execute(trx);
      });
    } catch (err) {
      log.warn(`[TelegramIngress] Could not record update ${updateId} as handled (${kind}):`, err);
    }
  }

  // Moved to services/office-alerts.ts and services/ask-history.ts with the Canva outcome routes
  // (architecture programme 1.3, G4). The Telegram handler still calls them by these names until
  // Telegram intake moves (G9); imported here, where they are used, as redriveTask is.
  const enqueueOfficeAlert = async (...args: Parameters<import('./services/office-alerts.js').OfficeAlerts['enqueueOfficeAlert']>) =>
    (await import('./services/office-alerts.js')).createOfficeAlerts({ db, outboxRepo }).enqueueOfficeAlert(...args);
  const askHistory = async (...args: Parameters<import('./services/ask-history.js').AskHistory['askHistory']>) =>
    (await import('./services/ask-history.js')).createAskHistory({ db }).askHistory(...args);

  /**
   * The requester's buttons under a draft (services/requester-actions.ts). None of them approves a
   * design: Approve records the requester's sign-off and tells the office, whose approval in Hawa Desk
   * still delivers (ADR-022). A button works only in the chat the design was made for.
   */
  async function handleRequesterAction(
    c: Context,
    cb: { id: string; from?: { id?: number | string }; message?: { chat?: { id?: number | string } } },
    rq: { action: RequesterAction; taskId: string },
    updateId: string
  ) {
    const chat = String(cb?.message?.chat?.id ?? cb?.from?.id ?? '');
    const answer = (text: string, alert = false) => telegramBridge?.answerCallbackQuery(cb.id, text, alert).catch(() => false);
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML'; reply_markup?: unknown }) =>
      telegramBridge?.dispatchOutboundMessage(chat, message as Outbound).catch(() => undefined);
    if (!db) {
      await answer('This is not available right now. Please try again in a minute.', true);
      return problem(c, 503, 'Database Unavailable', 'The requester action could not be recorded');
    }
    if (await telegramUpdateHandled(chat, updateId).catch(() => false)) {
      await answer('Done');
      return c.json({ ok: true, duplicate: true, updateId }, 200);
    }
    const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
    const facts = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ title: string | null; chat: string | null; newer: string | null; canva: string | null; done: boolean; payload: TaskCreatedPayload }>`SELECT t.title,
          o.payload->>'sourceChannelId' AS chat, o.payload,
          (SELECT ct.id::text FROM hawa.tasks ct JOIN hawa.outbox_commands co ON co.aggregate_id = ct.id AND co.command_type = 'task.created'
             WHERE ct.tenant_id = t.tenant_id AND co.payload->'studioOptions'->>'parentTaskId' = ${rq.taskId}
               AND ct.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
               AND COALESCE(co.payload->'studioOptions'->>'reformat', '') = ''
             ORDER BY ct.created_at DESC LIMIT 1) AS newer,
          (SELECT n.payload->>'canvaUrl' FROM hawa.outbox_commands n WHERE n.tenant_id = t.tenant_id AND n.aggregate_id = t.id
             AND n.command_type = 'notify.telegram' AND n.payload ? 'canvaUrl' ORDER BY n.created_at DESC LIMIT 1) AS canva,
          EXISTS (SELECT 1 FROM hawa.inbox_events e WHERE e.tenant_id = t.tenant_id AND e.event_kind = ${`telegram_requester_${rq.action}`}
             AND e.payload->>'taskId' = ${rq.taskId}) AS done
        FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${rq.taskId}::uuid LIMIT 1`.execute(trx)).rows[0]);
    if (!facts || String(facts.chat || '') !== chat) {
      await answer('This button belongs to a design made for another chat.', true);
      return c.json({ ok: false, reason: 'NOT_THIS_CHAT', taskId: rq.taskId }, 200);
    }
    const chosen = answerIndex(rq.action);
    if (chosen !== undefined) {
      const pending = await pendingQuestion(rq.taskId, chat);
      const option = pending?.options[chosen];
      if (!pending || !option) {
        await answer('This question was already answered.');
        return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, already: true }, 200);
      }
      const taken = await answerQuestion({ chat, pending, answer: option, updateId, rawJson: { callback: cb.id, action: rq.action, taskId: rq.taskId } });
      await answer(taken.ok ? '👍 Got it' : 'Your answer was not saved. Please tap it again in a minute.', !taken.ok);
      return c.json({ ok: taken.ok, requesterAction: rq.action, taskId: rq.taskId, revisionTaskId: taken.revisionTaskId }, 200);
    }
    const record = { taskId: rq.taskId, actorId: String(cb?.from?.id || '') };
    // A button on a draft a newer version replaced acts on nothing, sizes included: a size of the old
    // version was made, paid, without its change (review of 2026-09-24). While that newer version is
    // still being made there is no newer draft yet to point to, so that is what the requester is told.
    if (facts.newer && rq.action !== 'dsg') {
      const newer = facts.newer;
      const ready = await withRlsContext(db, scope, async (trx) =>
        (await sql<{ ready: boolean }>`SELECT EXISTS (SELECT 1 FROM hawa.outbox_commands n
            WHERE n.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND n.aggregate_id = ${newer}::uuid AND n.command_type = 'notify.telegram'
              AND n.payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') AS ready`.execute(trx)).rows[0]?.ready === true);
      await answer(ready ? 'A newer version of this design exists.' : 'Your change is still being made.');
      await send(ready ? composeReplacedDraft(newer) : composeChangeInProgress(newer));
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_replaced', { ...record, newer, ready });
      return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, replacedBy: newer, newerReady: ready }, 200);
    }
    const size = sizeOf(rq.action);
    if (size && !runsPipelineV3(chat)) {
      // Only offered in a chat on the v3 pipeline, which makes sizes; a button from an earlier message
      // still made one elsewhere (review of 2026-09-24).
      await answer('Other sizes are not available in this chat. Ask the office for one.', true);
      return c.json({ ok: false, requesterAction: rq.action, taskId: rq.taskId, reason: 'SIZES_NOT_AVAILABLE' }, 200);
    }
    if (size) {
      // Another size of this design (plan 4.3): once per size, as its own task and draft.
      if (facts.done) {
        await answer(`The ${size.label} version is already being made.`);
        return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, already: true }, 200);
      }
      const made = await makeOtherSize({ chat, taskId: rq.taskId, title: facts.title, payload: facts.payload || {}, size, updateId, action: rq.action });
      if (!made.ok) {
        await answer('This could not be started just now. Please try again in a minute.', true);
        return c.json({ ok: false, requesterAction: rq.action, taskId: rq.taskId }, 200);
      }
      await markTelegramUpdateHandled(chat, updateId, `telegram_requester_${rq.action}`, { ...record, sizeTaskId: made.sizeTaskId });
      await answer(`📐 Making the ${size.label} version`);
      return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, sizeTaskId: made.sizeTaskId }, 200);
    }
    if (rq.action === 'ok') {
      if (facts.done) {
        await answer('You already approved this design. The art director is on it.');
        return c.json({ ok: true, requesterAction: 'ok', taskId: rq.taskId, already: true }, 200);
      }
      const variant = (facts.payload?.variant || {}) as { width?: number; height?: number };
      // Other sizes are made by the v3 edit; a chat on the older pipeline is not offered them.
      await send(composeRequesterApproved(rq.taskId, { width: variant.width ?? 1080, height: variant.height ?? 1350 }, runsPipelineV3(chat)));
      await enqueueOfficeAlert(rq.taskId, `requester-approved:${rq.taskId}`, composeRequesterApprovedAlert({ taskId: rq.taskId, title: facts.title, canvaUrl: facts.canva || undefined }), chat);
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_ok', record);
      broadcast('task:requester_approved', { taskId: rq.taskId, source: 'telegram' });
      await answer('✅ Thank you!');
    } else if (rq.action === 'chg') {
      await send(composeChangePrompt(rq.taskId));
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_chg', record);
      await answer('Reply with what to change');
    } else {
      const history = await askHistory(rq.taskId);
      await send(composeDesignerTakesOver(rq.taskId));
      if (!facts.done) {
        await enqueueOfficeAlert(rq.taskId, `designer-asked:${rq.taskId}`, composeDesignerHandoff({ taskId: rq.taskId, title: facts.title, canvaUrl: facts.canva || undefined, asks: history.asks, rounds: history.rounds, why: 'asked' }), chat);
      }
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_dsg', record);
      broadcast('task:designer_requested', { taskId: rq.taskId, source: 'telegram' });
      await answer('A designer will take over');
    }
    return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId }, 200);
  }

  /** The parts of a task's task.created payload a revision or another size of it is made from (chat-intake.ts). */
  interface TaskCreatedPayload {
    sourceChannelId?: string;
    rawRequestText?: string;
    clientId?: string | null;
    headlineEn?: string | null;
    headlineCkb?: string | null;
    copyEn?: string | null;
    copyCkb?: string | null;
    designInstructions?: string;
    exactCopy?: unknown[];
    variant?: { width: number; height: number };
    designStudio?: boolean;
    studioOptions?: Record<string, unknown>;
  }

  /**
   * The same design in another size: a new task from the design's own task.created payload (its copy,
   * photos, reference and client), sized to the format, whose run lays the approved design out again
   * (edit stage, reformat). Its draft comes to the chat on its own, with its own buttons.
   */
  async function makeOtherSize(input: {
    chat: string;
    taskId: string;
    title: string | null;
    payload: TaskCreatedPayload;
    size: { label: string; width: number; height: number };
    updateId: string;
    action: string;
  }): Promise<{ ok: boolean; sizeTaskId?: string }> {
    const { payload, size } = input;
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML' }) => telegramBridge?.dispatchOutboundMessage(input.chat, message as Outbound).catch(() => undefined);
    // The design's own options, less what made it a change: this is a format of it, not a round.
    const { parentTaskId: _p, revisionDirective: _d, clarified: _c, reformat: _r, answers: _a, revisionRound: _n, ...kept } = (payload.studioOptions || {}) as Record<string, unknown>;
    try {
      const persisted = await persistChatIntake(db!, {
        platform: 'telegram',
        sourceEventId: `${input.updateId}_size_${input.action}_${input.taskId}`,
        sourceChannelId: input.chat,
        rawText: String(payload.rawRequestText || input.title || 'Design'),
        rawJson: { callback: input.action, taskId: input.taskId },
        clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
        title: `${String(input.title || 'Design').replace(/ \((Revision|story|square post|landscape banner)[^)]*\)/g, '')} (${size.label})`,
        headlineEn: payload.headlineEn || undefined,
        headlineCkb: payload.headlineCkb || undefined,
        copyEn: payload.copyEn || undefined,
        copyCkb: payload.copyCkb || undefined,
        designInstructions: String(payload.designInstructions || ''),
        exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
        autoGenerate: true,
        variant: { width: size.width, height: size.height },
        ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
        studioOptions: {
          ...kept,
          parentTaskId: input.taskId,
          revisionDirective: `The same design as a ${size.label} (${size.width}x${size.height}).`,
          reformat: size.label,
          // The round is the design's, carried on: a change to a size of a third-round design was
          // round 1, and the office alert at three rounds never came (review of 2026-09-24). Metrics
          // leave reformats out of the rounds.
          ...(typeof _n === 'number' ? { revisionRound: _n } : {}),
        },
      });
      if (persisted.autoGenerateDeclined) {
        await send({
          text: `📐 <b>The ${escapeTelegramHtml(size.label)} version is saved.</b>\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat, so the art director will make it in Hawa Desk.</i>\n\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
          parse_mode: 'HTML',
        });
      } else {
        await send(composeSizeStarted(size.label, size.width, size.height, persisted.task.id));
      }
      broadcast('task:created', persisted.task);
      return { ok: true, sizeTaskId: persisted.task.id };
    } catch (err) {
      log.error(`[Core] Task ${input.taskId}: the ${size.label} version could not be started:`, err);
      return { ok: false };
    }
  }

  /**
   * Where a reply to a question message goes once the question is no longer waiting (answered, out of
   * date, or its task was closed): the newest live version of the design the question was about (the
   * answer's revision, or a newer change), else that design itself. A question's task has no design
   * of its own, so a reply read as a change to it started a whole new paid design (2026-09-24 review).
   * Null for a task that never asked a question.
   */
  async function questionFollowUp(taskId: string): Promise<string | null> {
    if (!db || !isValidUuid(taskId)) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ parent: string | null; newest: string | null }>`SELECT o.payload->'studioOptions'->>'parentTaskId' AS parent,
          (SELECT n.id::text FROM hawa.tasks n JOIN hawa.outbox_commands no ON no.aggregate_id = n.id AND no.command_type = 'task.created'
            WHERE n.tenant_id = t.tenant_id AND n.id <> t.id
              AND no.payload->'studioOptions'->>'parentTaskId' = o.payload->'studioOptions'->>'parentTaskId'
              AND COALESCE(no.payload->'studioOptions'->>'reformat', '') = ''
              AND n.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
            ORDER BY n.created_at DESC LIMIT 1) AS newest
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (SELECT stages FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${taskId}::uuid
          AND r.stages->'directed'->>'refused' = 'NEEDS_CLARIFICATION'
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    if (!row) return null;
    const next = row.newest || row.parent;
    return next && isValidUuid(next) ? next : null;
  }

  interface PendingQuestion {
    taskId: string;
    title: string | null;
    /** The waiting revision's own task.created payload: everything a revision of the same design needs. */
    payload: TaskCreatedPayload;
    question: string;
    options: string[];
  }

  /**
   * The question a task is waiting on (edit stage, NEEDS_CLARIFICATION): its latest studio run
   * stopped to ask it, the task is paused for the answer, and the task came from this chat. Null
   * otherwise, including once it has been answered (the task is then closed).
   */
  async function pendingQuestion(taskId: string, chat: string): Promise<PendingQuestion | null> {
    if (!db || !isValidUuid(taskId) || !chat) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ title: string | null; state: string; payload: unknown; stages: unknown; answered: boolean; superseded: boolean }>`SELECT t.title, t.state::text AS state, o.payload, r.stages,
          -- Already answered, even if closing this task did not go through.
          EXISTS (SELECT 1 FROM hawa.outbox_commands a WHERE a.tenant_id = t.tenant_id AND a.command_type = 'task.created'
            AND a.payload->'studioOptions'->>'answers' = t.id::text) AS answered,
          -- A newer change to the same design exists: this question is out of date.
          EXISTS (SELECT 1 FROM hawa.tasks n JOIN hawa.outbox_commands no ON no.aggregate_id = n.id AND no.command_type = 'task.created'
            WHERE n.tenant_id = t.tenant_id AND n.id <> t.id AND n.created_at > t.created_at
              AND no.payload->'studioOptions'->>'parentTaskId' = o.payload->'studioOptions'->>'parentTaskId'
              AND COALESCE(no.payload->'studioOptions'->>'reformat', '') = ''
              AND n.state NOT IN ('cancelled', 'rejected', 'failed_operator')) AS superseded
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (SELECT stages FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${taskId}::uuid
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    if (!row || row.state !== 'paused' || row.answered || row.superseded) return null;
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}) as TaskCreatedPayload;
    const stages = (typeof row.stages === 'string' ? JSON.parse(row.stages) : row.stages || {}) as { directed?: { refused?: unknown; clarify?: { question?: unknown; options?: unknown } } };
    const clarify = stages?.directed?.refused === 'NEEDS_CLARIFICATION' ? stages.directed.clarify : undefined;
    if (!clarify || typeof clarify.question !== 'string' || !Array.isArray(clarify.options)) return null;
    if (String(payload.sourceChannelId || '') !== chat) return null;
    const options = payload.studioOptions || {};
    if (typeof options.parentTaskId !== 'string' || typeof options.revisionDirective !== 'string') return null;
    return {
      taskId,
      title: row.title,
      payload,
      question: clarify.question,
      options: clarify.options.filter((o: unknown): o is string => typeof o === 'string' && o.trim() !== ''),
    };
  }

  /**
   * The requester's answer to a question asked before their change was made: the change starts again
   * with the answer in it, as a new revision of the same design (the waiting task's own payload, so
   * it carries the same copy, photos, reference and round), and is never asked about again. The
   * waiting task is closed. The answer is a tapped option or their own words in reply.
   */
  async function answerQuestion(input: { chat: string; pending: PendingQuestion; answer: string; updateId: string; rawJson: unknown; referenceImageBase64?: string }): Promise<{ ok: boolean; revisionTaskId?: string }> {
    const { pending, chat } = input;
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML' }) => telegramBridge?.dispatchOutboundMessage(chat, message as Outbound).catch(() => undefined);
    // A picture sent as the answer, with no words, is the answer: "the attached picture".
    const pictureOnly = Boolean(input.referenceImageBase64) && input.answer.trim() === PICTURE_ONLY_DIRECTIVE;
    const answer = pictureOnly ? 'the attached picture' : cutText(input.answer.replace(/\s+/g, ' ').trim(), 500);
    const payload = pending.payload;
    const options = payload.studioOptions as Record<string, unknown>;
    const directive = `${String(options.revisionDirective).trim()}\n\nAsked "${pending.question}", the client answered: ${answer}`;
    try {
      const persisted = await persistChatIntake(db!, {
        platform: 'telegram',
        sourceEventId: `${input.updateId}_answer_${pending.taskId}`,
        sourceChannelId: chat,
        rawText: String(payload.rawRequestText || pending.title || 'Design'),
        rawJson: input.rawJson,
        clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
        title: pending.title || 'Design (Revision)',
        headlineEn: payload.headlineEn || undefined,
        headlineCkb: payload.headlineCkb || undefined,
        copyEn: payload.copyEn || undefined,
        copyCkb: payload.copyCkb || undefined,
        designInstructions: `${String(payload.designInstructions || '')}\nAnswer to "${pending.question}": ${answer}`.trim(),
        exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
        autoGenerate: true,
        ...(payload.variant ? { variant: payload.variant } : {}),
        ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
        studioOptions: {
          ...options,
          revisionDirective: directive,
          clarified: true,
          answers: pending.taskId,
          ...(input.referenceImageBase64 ? { referenceImageBase64: input.referenceImageBase64 } : {}),
        },
      });
      if (persisted.autoGenerateDeclined) {
        await send({
          text: `👍 <b>Got it:</b> ${escapeTelegramHtml(cutText(answer, 300))}\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your change is saved and queued for the art director in Hawa Desk.</i>\n\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
          parse_mode: 'HTML',
        });
      } else {
        await send(composeAnswerTaken(answer, persisted.task.id));
      }
      const { closeAnsweredQuestion } = await import('./services/canva-task-outcome.js');
      await withRlsContext(db!, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        closeAnsweredQuestion(trx, { tenantId: DEFAULT_TENANT_ID, taskId: pending.taskId, revisionTaskId: persisted.task.id })
      ).catch((err) => log.warn(`[Core] Task ${pending.taskId}: answered, but could not be closed:`, err));
      await markTelegramUpdateHandled(chat, input.updateId, 'telegram_requester_answer', { taskId: pending.taskId, revisionTaskId: persisted.task.id });
      broadcast('task:created', persisted.task);
      return { ok: true, revisionTaskId: persisted.task.id };
    } catch (err) {
      // Nothing is sent from here: a tapped answer is told in its pop-up, and a typed one is retried
      // with the update (a message here would repeat on every retry).
      log.error(`[Core] Task ${pending.taskId}: the answer to its question could not be saved:`, err);
      return { ok: false };
    }
  }

  /** Where a task's design is: being made, finished (a draft exists), failed, or never started. */
  async function taskDesignState(taskId: string): Promise<'running' | 'finished' | 'failed' | 'none'> {
    if (!db || !isValidUuid(taskId)) return 'none';
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ live: boolean; finished: boolean; runs: number }>`SELECT
          bool_or(${LIVE_RUN}) AS live,
          bool_or(r.status IN ('transferred', 'degraded')) AS finished,
          count(*)::int AS runs
        FROM hawa.design_studio_runs r WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.task_id = ${taskId}::uuid`.execute(trx)).rows[0]);
    if (!row || !row.runs) return 'none';
    if (row.live) return 'running';
    return row.finished ? 'finished' : 'failed';
  }

  /**
   * What a typed reply to `taskId`'s draft is about: the chat the design was made for, and its newest
   * version (a change of a change, followed to the last). Buttons already refuse an old draft and a
   * design from another chat; a typed reply did neither, so a reply to an older draft was made again
   * from it, losing the change in between, and a draft forwarded to another chat could be revised
   * from there (review of 2026-09-24). Versions follow the buttons' rule: not reformats, and not ones
   * cancelled, rejected, failed or paused on a question. Only finished versions (a design made, or its
   * draft sent) are followed: a reply that reaches a version still being made stays on the one before,
   * so that "your previous change is still being made" still answers it. Following into an unfinished
   * version started a second paid change on top of one with no design yet.
   */
  async function replyDesign(taskId: string): Promise<{ chat: string | null; newest: string }> {
    return withRlsContext(db!, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const own = await sql<{ chat: string | null }>`SELECT o.payload->>'sourceChannelId' AS chat FROM hawa.outbox_commands o
        WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND o.aggregate_id = ${taskId}::uuid AND o.command_type = 'task.created' LIMIT 1`.execute(trx);
      let newest = taskId;
      for (let hop = 0; hop < 50; hop++) {
        const next = (await sql<{ id: string; finished: boolean }>`SELECT ct.id::text AS id,
              (EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.tenant_id = ct.tenant_id AND r.task_id = ct.id AND r.status IN ('transferred', 'degraded'))
               OR EXISTS (SELECT 1 FROM hawa.outbox_commands n WHERE n.tenant_id = ct.tenant_id AND n.aggregate_id = ct.id
                            AND n.command_type = 'notify.telegram' AND n.payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW')) AS finished
            FROM hawa.tasks ct
            JOIN hawa.outbox_commands co ON co.aggregate_id = ct.id AND co.command_type = 'task.created'
            WHERE ct.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND co.payload->'studioOptions'->>'parentTaskId' = ${newest}
              AND ct.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
              AND COALESCE(co.payload->'studioOptions'->>'reformat', '') = ''
            ORDER BY ct.created_at DESC LIMIT 1`.execute(trx)).rows[0];
        if (!next || next.id === newest || !next.finished) break;
        newest = next.id;
      }
      return { chat: own.rows[0]?.chat ?? null, newest };
    });
  }

  // A change the client asked for, which approval waits for (services/pending-change.ts).
  const pendingChangeOf = (tenantId: string, taskId: string, after?: Date) => findPendingChange(db!, tenantId, taskId, after);

  /** A revision of this design that is still being made, if any. */
  async function revisionInFlight(parentTaskId: string): Promise<{ taskId: string; title: string } | null> {
    if (!db || !isValidUuid(parentTaskId)) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; title: string | null }>`SELECT t.id, t.title FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid
          AND o.payload->'studioOptions'->>'parentTaskId' = ${parentTaskId}
          AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''
          AND t.created_at > now() - interval '2 hours'
          AND (NOT EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id)
               AND t.created_at > now() - interval '5 minutes'
               -- A change with no run yet is on its way only if one will start: one the daily cap
               -- declined never runs, and the next change was dropped as "still being made".
               AND o.payload->>'autoGenerate' = 'true'
            OR EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id AND ${LIVE_RUN}))
        ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.id, title: row.title || 'your change' } : null;
  }

  /** The request this chat made in the last half hour whose design is being made, if any. */
  async function studioRunInProgressForChat(chat: string): Promise<{ taskId: string; title: string } | null> {
    if (!db || !chat || chat === 'tg_default') return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; title: string | null }>`SELECT t.id, t.title FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid
          AND o.payload->>'sourceChannelId' = ${chat}
          AND t.created_at > now() - interval '30 minutes'
          AND t.client_id IS NOT NULL
          AND COALESCE(o.payload->>'isInstructionOnly', 'false') != 'true'
          AND EXISTS (SELECT 1 FROM hawa.design_studio_runs r WHERE r.task_id = t.id AND r.tenant_id = t.tenant_id AND ${LIVE_RUN})
        ORDER BY t.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    return row ? { taskId: row.id, title: row.title || 'your request' } : null;
  }

  // Webhooks
  registerRoute('post', '/webhooks/telegram', async (c: any) => {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secretsEqual(secret, expectedSecret)) {
      return problem(c, 401, 'Unauthorized', 'Invalid or missing Telegram webhook secret token');
    }
    // The same answer the WhatsApp kill switch gives. Telegram keeps a refused webhook update and
    // sends it again, so nothing is lost while intake is off; nothing is read or started either.
    if (channelKillSwitches.telegram) {
      return problem(c, 503, 'Service Unavailable', 'Telegram intake is disabled by the office kill switch. Fall back to Hawa Desk intake at /desk.');
    }

    const rawBody = await c.req.arrayBuffer();
    const bodyText = new TextDecoder().decode(rawBody);
    let json: any = {};
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = { text: bodyText };
    }

    const sourceEventId = String(json.update_id ?? json.eventId ?? '');
    if (json.update_id == null && !json.eventId) return problem(c, 400, 'Missing event ID', 'Telegram must supply a stable update ID');
    // Every line written while this update is handled names its chat (logging.ts).
    bindLogContext({ chatId: String(json.message?.chat?.id ?? json.callback_query?.message?.chat?.id ?? json.channel_post?.chat?.id ?? json.edited_message?.chat?.id ?? json.sourceChannelId ?? '') });
    const verifiedSender = String(json.callback_query?.from?.id || json.message?.from?.id || json.edited_message?.from?.id || '');
    const isIntakeOpen = telegramIntakeUsers.includes('*') || process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*';
    if (isProduction && !isIntakeOpen && (!telegramIntakeUsers.length || !telegramIntakeUsers.includes(verifiedSender))) {
      return problem(c, 403, 'Forbidden', 'Sender is not in the configured office allowlist');
    }
    // The requester's own buttons under a draft come first; every other button is refused below.
    const requesterAction = json.callback_query ? parseRequesterAction(json.callback_query.data) : null;
    if (requesterAction) return handleRequesterAction(c, json.callback_query, requesterAction, sourceEventId);

    // Chat actions never approve or modify a design (ADR-022). The command text is read from every
    // place the command dispatcher below reads it: checking only message.text let a channel post or a
    // bare-text body through to /approve, which then created the named task out of nothing.
    const commandSource = json.message || json.channel_post || json;
    const commandText = String(commandSource?.text || commandSource?.caption || json.text || '');
    // Prefix match, as the bridge's handleCommand uses: "/approve_now <id>" is dispatched as /approve.
    if (json.callback_query || /^\s*\/(approve|publish|revise|reject)/i.test(commandText)) {
      if (json.callback_query?.id) {
        await telegramBridge?.answerCallbackQuery(
          json.callback_query.id,
          'Desk review required: Approve in Hawa Desk',
          true
        ).catch(() => {});
      } else if (commandSource?.chat?.id) {
        // A typed /approve got no reply at all: the 422 below is final for the poller, so the sender
        // was left waiting on a command that had been refused.
        await telegramBridge?.dispatchOutboundMessage(String(commandSource.chat.id), {
          text:
            `ℹ️ <b>Designs are approved in Hawa Desk, not in chat.</b>\n\n` +
            `<i>To change a draft, reply to its image with what to change. To approve it, open the task in Hawa Desk.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return problem(c, 422, 'Desk review required', 'Use authenticated Hawa Desk review bound to a captured revision; chat actions cannot approve or modify a design');
    }

    // An edited message is not a new request, and its text was read as empty: the edit vanished
    // and the design went ahead with the old words. The sender is told what to do instead.
    if (json.edited_message && !json.message) {
      const editedChat = json.edited_message.chat?.id;
      if (editedChat !== undefined && editedChat !== null) {
        await telegramBridge?.dispatchOutboundMessage(String(editedChat), {
          text:
            `✏️ <b>Edits to a message already sent are not picked up.</b>\n\n` +
            `<i>Send the corrected text as a new message. To change a draft you already received, reply to its image with the change.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason: 'EDITED_MESSAGE', updateId: sourceEventId }, 200);
    }

    // Handle inline interactive callback queries (e.g. [✅ Approve & Publish] or [✏️ Request Revision] clicks)
    if (json.callback_query) {
      const cb = json.callback_query;
      const cbData = cb.data || '';
      const actorId = String(cb.from?.id || '');

      // Check allowed user authorization ("Unknown users cannot approve")
      if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(actorId)) {
        await telegramBridge.answerCallbackQuery(cb.id, '❌ Unauthorized user', true);
        return problem(c, 403, 'Forbidden', `User ${actorId} is not authorized to execute actions on this office task`);
      }

      let targetTaskId: string;
      let targetAction: 'approve' | 'revision' | 'pick_layout';

      if (cbData.startsWith('act:')) {
        const verifyRes = telegramActionTokenService.verifyAndConsumeToken(cbData, {
          actorId,
          allowedActors: telegramAllowedUsers,
        });
        if (!verifyRes.ok) {
          await telegramBridge.answerCallbackQuery(cb.id, `❌ ${verifyRes.error}`, true);
          const status = verifyRes.code === 'STALE_REVISION' ? 409 : 403;
          return problem(c, status, verifyRes.code, verifyRes.error);
        }
        targetTaskId = verifyRes.payload.taskId;
        targetAction = verifyRes.payload.action;
      } else {
        const parsed = parseCallbackData(cbData);
        if (!parsed) {
          return c.json({ ok: false, error: 'Invalid callback data format' }, 400);
        }

        if (!verifyActionSignature(parsed.taskId, parsed.action, parsed.signature)) {
          return problem(c, 403, 'Forbidden', 'Invalid action callback signature');
        }
        targetTaskId = parsed.taskId;
        targetAction = parsed.action;
      }

      // A button acts only on a task Core holds; an unknown id is refused, never made up.
      const task = await resolveTaskWithFallback(targetTaskId);
      if (!task) {
        await telegramBridge.answerCallbackQuery(cb.id, `❌ Task ${targetTaskId} was not found. Nothing was changed.`, true);
        return problem(c, 404, 'Task Not Found', `Task ${targetTaskId} does not exist; nothing was approved or changed`);
      }

      const chatId = cb.message?.chat?.id || cb.from?.id;

      if (targetAction === 'approve') {
        const publishRes = await executeOmnichannelPublish(
          targetTaskId,
          { type: 'adapter', id: String(cb.from?.id || 'telegram') },
          'Approved via Telegram inline callback button',
          true
        );

        // The answer reports the outcome; it used to announce "Approved & Publishing" before either happened.
        if (!publishRes.ok) {
          await telegramBridge.answerCallbackQuery(cb.id, `❌ ${(publishRes as any).message || 'Publishing failed'}`, true);
          return problem(c, (publishRes as any).status || 500, (publishRes as any).message || 'Omnichannel publishing failed');
        }
        await telegramBridge.answerCallbackQuery(cb.id, '✅ Approved and published');

        broadcast('task:approved', { taskId: targetTaskId, approvedBy: cb.from?.id, via: 'telegram' });

        const notice = telegramBridge.formatPublicationNotice({
          id: targetTaskId,
          title: task.title || `Task ${targetTaskId}`,
          driveUrl: publishRes.driveFolderUrl!,
          sheetUrl: publishRes.sheetRowUrl!,
          workflowId: (publishRes as any).publicationReceipt?.publicationId || (publishRes as any).publicationReceipt?.workflowId || 'kaae-pub-flow-2026',
        });
        if (chatId) {
          await telegramBridge.dispatchOutboundMessage(chatId, notice);
        }

        return c.json({ ok: true, action: 'approve', taskId: targetTaskId, status: 'COMPLETE', publishRes });
      } else if (targetAction === 'pick_layout') {
        await telegramBridge.answerCallbackQuery(cb.id, '🎯 Layout Pick Processed');
        return c.json({ ok: true, action: 'pick_layout', taskId: targetTaskId, status: task.status });
      } else {
        await telegramBridge.answerCallbackQuery(cb.id, '✏️ Revision Requested');
        // REVISION_REQUESTED, the status the database uses for a design sent back for changes. This
        // said IN_PROGRESS, a word only Core's memory had. The move is not written here (version null).
        const fromStatus = task.status;
        task.status = 'REVISION_REQUESTED';
        events.get(targetTaskId)?.push({
          eventId: crypto.randomUUID(),
          taskId: targetTaskId,
          fromStatus,
          toStatus: 'REVISION_REQUESTED',
          actor: { type: 'adapter', id: String(cb.from?.id || 'telegram') },
          reason: 'Revision requested via Telegram inline button',
          occurredAt: new Date().toISOString(),
        });
        broadcast('task:revision_requested', { taskId: targetTaskId, notes: 'Revision requested via Telegram button', requestedBy: cb.from?.id });
        broadcastTransition(targetTaskId, isTaskApiStatus(fromStatus) ? fromStatus : null, 'REVISION_REQUESTED', null);

        if (chatId) {
          await telegramBridge.dispatchOutboundMessage(chatId, {
            text: `✏️ <b>Revision request logged for task</b> <code>${escapeTelegramHtml(targetTaskId)}</code>\nDesign team alerted in Hawa Desk.`,
            parse_mode: 'HTML',
          });
        }

        return c.json({ ok: true, action: 'revision', taskId: targetTaskId, status: 'REVISION_REQUESTED' });
      }
    }

    const msg = json.message || json.channel_post || json;
    // An update Telegram delivers again (Core restarted after handling it and before the poller
    // stored its position) was read again from the top: transcribed, classified, and able to start
    // a second paid design or remove a second rule. Anything this update already saved ends it here,
    // before any paid call.
    const updateChat = String(msg.chat?.id || json.sourceChannelId || '');
    if (db && updateChat && updateChat !== 'tg_default' && json.update_id != null) {
      // With the database unreachable nothing could be saved anyway: the update waits for it here,
      // not after a paid transcription and classification that the poller repeats every 30 s.
      const handledBefore = await telegramUpdateHandled(updateChat, sourceEventId).catch((err: unknown) => {
        log.warn('[TelegramIngress] Could not check whether the update was handled before:', err);
        return null;
      });
      if (handledBefore === null) return problem(c, 503, 'Database Unavailable', 'The update is retried when the database answers');
      if (handledBefore) {
        // The request this update saved, as the first delivery answered it.
        const saved = handledBefore.taskId ? await readCurrentTask(handledBefore.taskId) : undefined;
        return c.json({ ok: true, duplicate: true, updateId: sourceEventId, ...(handledBefore.taskId ? { task: saved || { id: handledBefore.taskId } } : {}) }, 200);
      }
    }
    let rawText = msg.text || msg.caption || json.text || '';
    let voiceTranscript: string | undefined = undefined;

    // Detect Voice or Audio Ingress (Telegram voice or audio message)
    const voiceObj = msg.voice || msg.audio || json.voice || json.audio;
    if (voiceObj) {
      const fileId = voiceObj.file_id;
      let audioBuf: Buffer | undefined;
      if (fileId) {
        try {
          const downloaded = await telegramBridge.downloadFile(fileId);
          if (downloaded) {
            audioBuf = downloaded;
          }
        } catch (err) {
          log.warn('[TelegramIngress] Failed to download audio file:', err);
        }
      } else if (json.audioBase64) {
        audioBuf = Buffer.from(json.audioBase64, 'base64');
      }

      const duration = voiceObj.duration || json.durationSeconds || 15;
      const transcription = await voiceTranscriber.transcribe(
        {
          audioBuffer: audioBuf,
          audioBase64: json.audioBase64,
          audioMimeType: voiceObj.mime_type || 'audio/ogg',
          durationSeconds: duration,
          languageHint: 'ckb',
        },
        rawText || json.transcriptFallback
      );

      voiceTranscript = transcription.transcript;
      // The caption and what was said, together (the transcriber joins them).
      rawText = transcription.normalizedText || rawText;
    }

    // Detect Photo or Image Reference Ingress (Telegram photo or document image)
    let referenceImageBase64: string | undefined = undefined;
    const photoList = msg.photo || json.photo;
    const docObj = msg.document || json.document;
    let photoFileId: string | undefined;

    if (Array.isArray(photoList) && photoList.length > 0) {
      photoFileId = photoList[photoList.length - 1]?.file_id;
    } else if (docObj && typeof docObj.mime_type === 'string' && docObj.mime_type.startsWith('image/')) {
      photoFileId = docObj.file_id;
    }

    const imageDocument = Boolean(photoFileId && docObj && photoFileId === docObj.file_id);
    const refuseImageFile = async (why: string, reason: string) => {
      const chat = String(msg.chat?.id || json.sourceChannelId || '');
      if (chat) {
        await telegramBridge.dispatchOutboundMessage(chat, {
          text: `📎 <b>${escapeTelegramHtml(String(docObj?.file_name || 'This picture'))} ${why}</b>\n\n` +
            `<i>Send it as a photo instead of a file (Telegram converts it), or as a JPEG or PNG file. Nothing was started.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason, updateId: sourceEventId }, 200);
    };
    // Telegram refuses a bot any file over 20 MB: the download failed, the update was retried for
    // about a minute, holding up every chat, and then parked with a generic notice (review of 2026-09-24).
    if (imageDocument && Number(docObj.file_size) > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
      return refuseImageFile('is larger than 20 MB, which Telegram does not let the bot download.', 'IMAGE_FILE_TOO_LARGE');
    }

    if (photoFileId) {
      let unusable: string | undefined;
      try {
        const photoBuf = await telegramBridge.downloadFile(photoFileId);
        if (photoBuf && photoBuf.length > 0) {
          // An image sent as a file keeps its own format (a PNG with transparency, a WebP); it was
          // labelled JPEG whatever it was, and the models and the deck read the label.
          const mime = sniffImageMime(photoBuf);
          if (imageDocument && !isUsableImage(mime)) unusable = mime.slice('image/'.length).toUpperCase();
          else referenceImageBase64 = `data:${mime};base64,${photoBuf.toString('base64')}`;
        }
      } catch (err) {
        log.warn('[TelegramIngress] Failed to download reference photo:', err);
      }
      if (unusable) return refuseImageFile(`is a ${unusable} file, which the design cannot use.`, 'IMAGE_FORMAT_UNSUPPORTED');
      // A picture Telegram could not hand over is fetched again with the whole update: the poller
      // retries a 503 and, after its last try, tells the sender. Going ahead without it made a paid
      // design without the picture, and a picture sent again later no longer joined that request.
      if (!referenceImageBase64) {
        return problem(c, 503, 'Picture Not Downloaded', 'The picture could not be downloaded from Telegram; the update is retried');
      }
    } else if (json.referenceImageBase64) {
      referenceImageBase64 = json.referenceImageBase64;
    }

    if ((!rawText || !rawText.trim()) && referenceImageBase64) {
      rawText = PICTURE_ONLY_DIRECTIVE;
    }

    const sourceChannelId = String(msg.chat?.id || json.sourceChannelId || 'tg_default');
    const rulesDeps: RulesIntakeDeps | null = db
      ? {
          db,
          tenantId: DEFAULT_TENANT_ID,
          userId: SYSTEM_AUTOMATION_USER_ID,
          bridge: telegramBridge,
          trustNamedClient: telegramAllowedUsers.includes(verifiedSender),
        }
      : null;

    // A document that is not an image. A PDF is read as brand guidelines and its rules saved for the
    // client; anything else is refused out loud. A PDF used to be answered "this message contained
    // no text or media", or, with a caption, the caption became a design brief and the PDF was
    // dropped: a client's new brand guidelines never reached a design (2026-09-22).
    if (docObj && !photoFileId && !voiceObj && sourceChannelId !== 'tg_default') {
      const docName = String(docObj.file_name || '');
      const isPdfDocument = String(docObj.mime_type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(docName);
      if (!isPdfDocument || !rulesDeps) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `📎 <b>${escapeTelegramHtml(docName || 'This file')} cannot be read here.</b>\n\n` +
            `<i>Send brand guidelines as a PDF, pictures as photos or image files, and the text for a design as a message.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        return c.json({ ok: true, ignored: true, reason: 'UNSUPPORTED_DOCUMENT', updateId: sourceEventId }, 200);
      }
      const model: GuidelinesModel = options?.guidelinesModel || new OpenAiStudioClient({ apiKey: process.env.OPENAI_API_KEY || '', timeoutMs: 180000 });
      const reading = await handleGuidelinesPdf({ ...rulesDeps, model }, {
        sourceChannelId,
        fileId: String(docObj.file_id || ''),
        fileUniqueId: docObj.file_unique_id ? String(docObj.file_unique_id) : undefined,
        fileName: docName,
        fileSize: Number(docObj.file_size) || undefined,
        caption: String(msg.caption || ''),
      });
      if (reading.done) {
        // The set held the reading itself and deleted a different promise, so it only grew.
        const tracked: Promise<void> = reading.done.finally(() => guidelineReadings.delete(tracked));
        guidelineReadings.add(tracked);
      }
      // A PDF read is a paid call: the same update delivered again is not read twice.
      if (reading.accepted) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_guidelines_pdf', json);
      return c.json({ ok: true, guidelines: reading.accepted ? 'reading' : 'refused', updateId: sourceEventId }, 200);
    }

    // An update without usable text (sticker, photo without caption, chat-member event, or a voice
    // note that could not be transcribed) is acknowledged and skipped. Persisting it would throw,
    // the poller would retry the same update forever, and every later message would be blocked.
    if (typeof rawText !== 'string' || !rawText.trim()) {
      // A sticker (a 👍 on a draft) is a reaction, not an empty message: it was answered "this message
      // contained no text or media" (review of 2026-09-24). No model is asked about it.
      if (msg.sticker && sourceChannelId !== 'tg_default') {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: msg.reply_to_message
            ? '🙏 Thank you. If the design is right, tap ✅ Approve design under it; to change anything, reply to the design with the change in words.'
            : 'Stickers are not read as requests. Send the request, or a change to a design, as text.',
        }).catch(() => undefined);
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_sticker', { replied: Boolean(msg.reply_to_message) });
        return c.json({ ok: true, ignored: true, reason: 'STICKER', updateId: sourceEventId }, 200);
      }
      const reason = voiceObj ? 'VOICE_NOT_TRANSCRIBED' : (photoFileId ? 'PHOTO_DOWNLOAD_FAILED' : 'NO_TEXT');
      if (sourceChannelId !== 'tg_default' && (msg.chat?.id || voiceObj)) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: voiceObj
            ? 'Your voice note was received but could not be transcribed. Please send the brief as text so nothing is guessed.'
            : photoFileId
              // The picture came, and could not be fetched from Telegram: saying the message had no
              // media told the sender their photo never arrived.
              ? 'Your picture arrived but could not be downloaded from Telegram, so nothing was saved. Please send it again.'
              : 'Please send your design brief as text (or an image reference / voice note); this message contained no text or media to work with.',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason, updateId: sourceEventId }, 200);
    }

    // A photo sent without a caption right after a request is part of that request. Telegram sends
    // the text and the photo as two messages; on 2026-09-19 the photo became a "revision" (task
    // 936c5c6f) and a second full design run. If the request's design has not reached layout
    // generation, the photo is saved as an instruction-only task pointing at it and the studio
    // follows it; otherwise it takes the revision path below, as before.
    const captionless = Boolean(referenceImageBase64) && !String(msg.caption || msg.text || json.text || '').trim();
    const albumId = msg.media_group_id ? String(msg.media_group_id) : undefined;
    // One answer per album: each of its photos arrives as its own message.
    const firstOfAlbum = (() => {
      if (!albumId) return true;
      const key = `${sourceChannelId}:${albumId}`;
      if (acknowledgedAlbums.has(key)) return false;
      acknowledgedAlbums.add(key);
      if (acknowledgedAlbums.size > 500) acknowledgedAlbums.delete(acknowledgedAlbums.values().next().value as string);
      return true;
    })();
    // An album sent as a reply to a draft carries the reply on every photo: only the first is read
    // as the change, and the album's other photos join the revision it made (one paid run, one
    // answer). Each used to start its own revision.
    if (captionless && (!msg.reply_to_message || (albumId && !firstOfAlbum)) && db && sourceChannelId !== 'tg_default') {
      // A photo from the album whose captioned photo is the request belongs to that request.
      const album = albumId
        ? await findAlbumRequest(db, { sourceChannelId, mediaGroupId: albumId }).catch((err) => {
            log.warn('[TelegramIngress] Could not look for the album request:', err);
            return null;
          })
        : null;
      // An album photo belongs to its album's request or to none yet: with the caption on a later
      // photo, the first one was attached to whichever request the chat made last.
      const target = album || (albumId ? null : await findRequestAwaitingReference(db, { sourceChannelId }).catch((err) => {
        log.warn('[TelegramIngress] Could not look for a request to attach the photo to:', err);
        return null;
      }));
      if (target) {
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: target.clientId,
          title: `${target.title} (reference image)`,
          designInstructions: rawText,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceFor: target.taskId, referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
        });
        // The album's request was already acknowledged with its first photo.
        if (!album && firstOfAlbum) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Picture added to your request</b> "${escapeTelegramHtml(target.title)}"\n\n` +
              `<i>The design uses it as your message says: placed in the design, or followed as the style to match. No separate draft is made.</i>`,
            parse_mode: 'HTML',
          });
        }
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, referenceFor: target.taskId, album: Boolean(album), task: persisted.task }, 201);
      }
      // A picture that comes after the design has passed its brief cannot join it, and "send the
      // request text now" made the sender send the request again: a second paid design (2026-09-23).
      if (!albumId) {
        const running = await studioRunInProgressForChat(sourceChannelId).catch(() => null);
        if (running) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Your design "${escapeTelegramHtml(running.title)}" is already being made</b> with the pictures it had.\n\n` +
              `<i>When the draft arrives, reply to it with this picture and say what to do with it. Nothing new was started.</i>`,
            parse_mode: 'HTML',
          }).catch(() => undefined);
          await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_late_picture', json);
          return c.json({ ok: true, ignored: true, reason: 'DESIGN_ALREADY_RUNNING', taskId: running.taskId }, 200);
        }
      }
      // No request to attach to yet: the image is kept as a reference for the request that follows.
      // It used to fall through to intake as a brief whose copy was the sentence "Apply the attached
      // visual reference image…" (two such tasks on 2026-09-22), which a design would then print.
      const persisted = await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId,
        sourceChannelId,
        rawText,
        rawJson: json,
        clientId: null,
        title: `${[msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Client'}: reference image (awaiting request)`,
        designInstructions: rawText,
        exactCopy: [],
        isInstructionOnly: true,
        autoGenerate: false,
        studioOptions: { referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
      });
      if (firstOfAlbum) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `🖼️ <b>${albumId ? 'Pictures' : 'Picture'} saved.</b>\n\n` +
            (albumId
              // The album's caption can be on a later photo, which arrives after this answer: "send the
              // request text now" had the sender send the request again, a second paid design.
              ? `<i>If one of these pictures carries your request as its caption, nothing more is needed: it is being read now. Otherwise, send the request text and the design will use them.</i>`
              : `<i>Send the request text now and the design will use it. Nothing is designed from pictures alone.</i>`),
          parse_mode: 'HTML',
        });
      }
      broadcast('task:created', persisted.task);
      return c.json({ ok: true, referenceAwaitingRequest: true, task: persisted.task }, 201);
    }

    // An album sent as a reply to a draft whose caption is on a later photo: the first photo, which
    // had no words, already started the change. This photo and its caption join that change (the
    // studio waits for the album to settle before it reads the change), instead of meeting "your
    // previous change is still being made" and being dropped with the caption (review of 2026-09-24).
    if (albumId && !firstOfAlbum && msg.reply_to_message && referenceImageBase64 && !captionless && db && sourceChannelId !== 'tg_default') {
      const album = await findAlbumRequest(db, { sourceChannelId, mediaGroupId: albumId }).catch((err) => {
        log.warn('[TelegramIngress] Could not look for the album change:', err);
        return undefined;
      });
      if (album === undefined) return problem(c, 503, 'Database unavailable', 'The album this photo belongs to could not be looked up; retry');
      if (album) {
        const caption = rawText.trim().slice(0, 2000);
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: album.clientId,
          title: `${album.title} (album picture)`,
          designInstructions: caption,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceFor: album.taskId, referenceImageBase64, mediaGroupId: albumId, albumCaption: caption },
        });
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `✏️ <b>Change received:</b> "${escapeTelegramHtml(cutText(caption, 500))}"\n\n` +
            `<i>It is being made with the pictures you sent together with it. The new draft comes to this chat when ready.</i>\n\n` +
            `🆔 Task ID: <code>${escapeTelegramHtml(album.taskId)}</code>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, status: 'ALBUM_CAPTION_JOINED', referenceFor: album.taskId, task: persisted.task }, 201);
      }
    }

    // /status: this chat's latest requests and where each one is. It used to report the bridge's own
    // counters (mode, ingress URL, uptime), which told the sender nothing about their design.
    if (typeof rawText === 'string' && /^\/status(@\w+)?(\s.*)?$/is.test(rawText.trim()) && db && sourceChannelId !== 'tg_default') {
      const rows = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
        (await sql<{ id: string; title: string | null; state: string; created_at: Date; design_id: string | null }>`
          SELECT t.id, t.title, t.state, t.created_at,
            (SELECT b.canva_design_id FROM hawa.canva_bindings b WHERE b.task_id = t.id AND b.tenant_id = t.tenant_id AND b.status = 'bound' ORDER BY b.created_at DESC LIMIT 1) AS design_id
          FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
          WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND o.command_type = 'task.created'
            AND o.payload->>'sourceChannelId' = ${sourceChannelId}
            AND COALESCE(o.payload->>'isInstructionOnly', 'false') <> 'true'
          ORDER BY t.created_at DESC LIMIT 5`.execute(trx)).rows
      ).catch((err: unknown) => {
        // A read that failed answered "No requests from this chat yet", which is untrue.
        log.warn('[TelegramIngress] /status could not read the chat\'s requests:', err);
        return null;
      });
      if (!rows) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: '📊 Your requests could not be read just now. Please send /status again in a minute.',
        });
        return c.json({ ok: false, command: true, status: 'UNAVAILABLE' }, 200);
      }
      // Keyed by every database state, so a state added to the vocabulary does not compile until it has words.
      const stateLabel: Record<TaskDbState, string> = {
        received: 'being designed', promotion_pending: 'being designed', routing: 'being designed', routing_review: 'being designed',
        brief_draft: 'being designed', brief_review: 'being designed', context_ready: 'being designed', design_planning: 'being designed',
        asset_production: 'being designed', studio_composition: 'being designed', qa: 'being checked', auto_repair: 'being checked',
        human_review: 'draft ready, awaiting approval in Hawa Desk', revision_requested: 'replaced by a newer version',
        approved: 'approved, awaiting delivery', publishing: 'being delivered', complete: 'delivered', paused: 'waiting for your answer to a question',
        failed_retryable: 'delayed, being retried', failed_operator: 'needs the office (the automatic draft failed)',
        rejected: 'rejected', cancelled: 'cancelled',
      };
      // A paused task waits for an answer only while its question does: one answered or overtaken by a
      // newer change said "waiting for your answer" while its buttons said it was answered (review of 2026-09-24).
      const stillAsking = new Set<string>();
      for (const r of rows) {
        if (r.state === 'paused' && (await pendingQuestion(r.id, sourceChannelId).catch(() => null))) stillAsking.add(r.id);
      }
      const labelOf = (r: { id: string; state: string }) =>
        r.state === 'paused' && !stillAsking.has(r.id) ? 'no longer waiting: answered, or replaced by a newer change' : (isTaskDbState(r.state) ? stateLabel[r.state] : r.state);
      const lines = rows.map((r, i) =>
        `${i + 1}. <b>${escapeTelegramHtml(cutText(String(r.title || 'Request').replace(/^[^:]*:\s*/, ''), 60))}</b>\n` +
        `   ${escapeTelegramHtml(labelOf(r))}` +
        (r.design_id ? ` · <a href="https://www.canva.com/design/${escapeTelegramHtml(r.design_id)}/edit">Canva</a>` : '') +
        `\n   <code>${r.id.slice(0, 8)}</code>`
      );
      await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
        text: lines.length ? `📊 <b>Your latest requests</b>\n\n${lines.join('\n')}` : '📊 No requests from this chat yet.',
        parse_mode: 'HTML',
      });
      return c.json({ ok: true, command: true, status: rows.length }, 200);
    }

    // The client's standing rules: /rules lists them, /forget 2 removes one.
    const rulesCommand = typeof rawText === 'string' ? parseRulesCommand(rawText) : null;
    if (rulesCommand && sourceChannelId !== 'tg_default') {
      if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
      await handleRulesCommand(rulesDeps, { sourceChannelId, command: rulesCommand, text: rawText });
      // "/forget 1" delivered twice would remove the rule after it as well.
      if (rulesCommand.kind === 'forget') await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_rules_forget', json);
      return c.json({ ok: true, command: true, rules: rulesCommand.kind }, 200);
    }

    // Handle bot slash commands (/start, /status, /help, /review, /approve, /publish, /revise, /reject)
    if (typeof rawText === 'string' && rawText.startsWith('/')) {
      const cmdReply = telegramBridge.handleCommand(rawText, sourceChannelId, verifiedSender || undefined);
      if (cmdReply) {
        if (cmdReply.action === 'approve' && cmdReply.taskId) {
          const senderId = String(msg?.from?.id || '');
          if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(senderId)) {
            return problem(c, 403, 'Forbidden', `User ${senderId} is not authorized to approve tasks`);
          }
          // /approve acts only on a task Core holds; an unknown id is refused, never made up.
          const task = await resolveTaskWithFallback(cmdReply.taskId);
          if (!task) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Task <code>${escapeTelegramHtml(cmdReply.taskId)}</code> was not found. Nothing was approved.`,
              parse_mode: 'HTML',
            });
            return problem(c, 404, 'Task Not Found', `Task ${cmdReply.taskId} does not exist; nothing was approved`);
          }
          const publishRes = await executeOmnichannelPublish(
            cmdReply.taskId,
            { type: 'adapter', id: sourceChannelId },
            'Approved via Telegram slash command',
            true
          );
          if (!publishRes.ok) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Not approved or published: ${escapeTelegramHtml((publishRes as any).message || 'publishing failed')}`,
              parse_mode: 'HTML',
            });
            return problem(c, (publishRes as any).status || 500, (publishRes as any).message || 'Omnichannel publishing failed');
          }
          broadcast('task:approved', { taskId: cmdReply.taskId, approvedBy: sourceChannelId, via: 'telegram' });
          const notice = telegramBridge.formatPublicationNotice({
            id: cmdReply.taskId,
            title: task.title || `Task ${cmdReply.taskId}`,
            driveUrl: publishRes.driveFolderUrl!,
            sheetUrl: publishRes.sheetRowUrl!,
            workflowId: (publishRes as any).publicationReceipt?.publicationId || (publishRes as any).publicationReceipt?.workflowId || 'kaae-pub-flow-2026',
          });
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, notice);
          return c.json({ ok: true, command: true, action: 'approve', taskId: cmdReply.taskId, status: 'COMPLETE', publishRes });
        } else if (cmdReply.action === 'revision' && cmdReply.taskId) {
          // /revise acts only on a task Core holds; an unknown id is refused, never made up.
          const task = await resolveTaskWithFallback(cmdReply.taskId);
          if (!task) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Task <code>${escapeTelegramHtml(cmdReply.taskId)}</code> was not found. No revision was logged.`,
              parse_mode: 'HTML',
            });
            return problem(c, 404, 'Task Not Found', `Task ${cmdReply.taskId} does not exist; no revision was logged`);
          }
          // REVISION_REQUESTED, as the database names it (this said IN_PROGRESS); not written here.
          const fromStatus = task.status;
          task.status = 'REVISION_REQUESTED';
          events.get(cmdReply.taskId)?.push({
            eventId: crypto.randomUUID(),
            taskId: cmdReply.taskId,
            fromStatus,
            toStatus: 'REVISION_REQUESTED',
            actor: { type: 'adapter', id: sourceChannelId },
            reason: cmdReply.notes || 'Revision requested via Telegram slash command',
            occurredAt: new Date().toISOString(),
          });
          broadcast('task:revision_requested', { taskId: cmdReply.taskId, notes: cmdReply.notes, requestedBy: sourceChannelId });
          broadcastTransition(cmdReply.taskId, isTaskApiStatus(fromStatus) ? fromStatus : null, 'REVISION_REQUESTED', null);
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, cmdReply);
          return c.json({ ok: true, command: true, action: 'revision', taskId: cmdReply.taskId, status: 'REVISION_REQUESTED' });
        } else if (cmdReply.action === 'redrive') {
          let targetTaskId = cmdReply.taskId;
          if (!targetTaskId && db) {
            try {
              const recentFailed = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
                return await sql<any>`
                  SELECT p.task_id
                  FROM hawa.canva_design_plans p
                  JOIN hawa.outbox_commands o ON o.aggregate_id = p.task_id
                  WHERE o.payload->>'sourceChannelId' = ${sourceChannelId}
                    AND p.status IN ('failed', 'uncertain')
                  ORDER BY p.created_at DESC LIMIT 1`.execute(trx);
              });
              if (recentFailed.rows[0]?.task_id) {
                targetTaskId = recentFailed.rows[0].task_id;
              }
            } catch (err) {
              log.warn('[TelegramBridge] Failed to find recent failed task for redrive:', err);
            }
          }
          if (!targetTaskId) {
            const noTaskMsg = {
              text: '⚠️ No failed design task found in this chat to re-drive. Specify the task ID: <code>/redo &lt;taskId&gt;</code>',
              parse_mode: 'HTML',
            };
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, noTaskMsg);
            return c.json({ ok: false, error: 'NO_TASK_TO_REDRIVE' }, 404);
          }
          // redriveTask says what it did (a new draft queued, or the design that already exists).
          const redriveRes = await redriveTask(targetTaskId, sourceChannelId);
          return c.json({ ok: true, command: true, action: 'redrive', taskId: targetTaskId, result: redriveRes });
        }

        await telegramBridge.dispatchOutboundMessage(sourceChannelId, cmdReply);
        return c.json({ ok: true, command: true, reply: cmdReply }, 200);
      }
    }

    const senderName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      json.senderName ||
      'Telegram Client';

    // Check if this is an interactive revision / feedback message on an active task in this Telegram chat
    let feedbackTargetTask: any = null;
    let classification: any = null;
    // The design a reply answers. It is the context the message is read in, not a verdict: a reply
    // used to be a change request whatever it said, so "thanks" under a draft started a paid redesign.
    let replyTarget: any = null;
    // Set when this message stated a lasting preference and it was saved for the client.
    let standingRuleSaved = false;
    const repliedTo = msg.reply_to_message
      ? {
          text: String(msg.reply_to_message.caption || msg.reply_to_message.text || ''),
          fromBot: Boolean(msg.reply_to_message.from?.is_bot),
        }
      : null;

    if (msg.reply_to_message) {
      const replyContext =
        (msg.reply_to_message.caption || msg.reply_to_message.text || '') +
        ' ' +
        (msg.reply_to_message.reply_markup ? JSON.stringify(msg.reply_to_message.reply_markup) : '');
      const uuidMatch = replyContext.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        replyTarget = tasks.get(uuidMatch[1]) || null;
        if (!replyTarget && taskRepo && db) {
          try {
            const dbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              return await taskRepo.findById(uuidMatch[1], DEFAULT_TENANT_ID, trx);
            });
            if (dbTask) {
              replyTarget = {
                id: dbTask.id,
                tenantId: dbTask.tenant_id,
                clientId: dbTask.client_id,
                status: dbTask.state,
                title: dbTask.title,
                sourcePlatform: 'telegram',
                sourceChannelId,
                rawText: dbTask.description,
                createdAt: dbTask.created_at,
                updatedAt: dbTask.updated_at,
              };
              tasks.set(dbTask.id, replyTarget);
            }
          } catch (dbErr) {
            // A database that cannot answer now may answer on the next attempt; a 404 here was final
            // for the poller, and the sender's reply was dropped without a word.
            log.warn('[Core] Failed to find reply task in DB:', dbErr);
            return problem(c, 503, 'Database unavailable', 'The replied-to design could not be looked up; retry');
          }
        }
        if (!replyTarget) {
          // The reply names a task this office does not hold (a message from another deployment,
          // or a test). The message is read as if it were not a reply, rather than dropped.
          log.warn(`[Core] Telegram reply referenced unknown task UUID ${uuidMatch[1]}; reading the message on its own.`);
        }
      }
    }
    let replyDesignOf: { chat: string | null; newest: string; of: string } | null = null;
    if (replyTarget && db && sourceChannelId && sourceChannelId !== 'tg_default' && isValidUuid(String(replyTarget.id))) {
      try {
        replyDesignOf = { ...(await replyDesign(String(replyTarget.id))), of: String(replyTarget.id) };
      } catch (err) {
        log.warn('[Core] Could not look up the design a reply is about:', err);
        return problem(c, 503, 'Database unavailable', 'The replied-to design could not be looked up; retry');
      }
      if (replyDesignOf.chat && replyDesignOf.chat !== sourceChannelId) {
        // A draft forwarded from another chat: its design is not this chat's to change.
        log.warn('[Core] A reply named a design made for another chat; reading the message on its own.');
        replyTarget = null;
        replyDesignOf = null;
      }
    }

    // A reply to a question asked before a change was made is its answer, in the requester's own
    // words, whatever it says: read as a new change request, it would revise a task that has no design.
    if (replyTarget && db && sourceChannelId && sourceChannelId !== 'tg_default' && rawText.trim()) {
      let pending: PendingQuestion | null;
      let followUp: string | null = null;
      try {
        pending = await pendingQuestion(String(replyTarget.id), sourceChannelId);
        if (!pending) followUp = await questionFollowUp(String(replyTarget.id));
      } catch (err) {
        // Read as a change instead, the reply would start a new design; retried, it reaches the answer.
        log.warn('[Core] Could not tell whether a reply answers a question:', err);
        return problem(c, 503, 'Database unavailable', 'Whether this reply answers a question could not be checked; retry');
      }
      if (pending) {
        const taken = await answerQuestion({ chat: sourceChannelId, pending, answer: rawText, updateId: sourceEventId, rawJson: json, referenceImageBase64 });
        if (!taken.ok) return problem(c, 503, 'Answer not saved', 'The answer could not be saved; the message will be retried');
        return c.json({ ok: true, status: 'QUESTION_ANSWERED', taskId: pending.taskId, revisionTaskId: taken.revisionTaskId }, 200);
      }
      if (followUp && followUp !== String(replyTarget.id) && taskRepo) {
        // A reply to a question that no longer waits is about the design it asked about, as it now is.
        const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(followUp!, DEFAULT_TENANT_ID, trx)).catch(() => null);
        // Unread, the reply fell back to the question's own task and started a change from it.
        if (!next) return problem(c, 503, 'Database unavailable', 'The revision that answered the question could not be read; retry');
        {
          replyTarget = {
            id: next.id,
            tenantId: next.tenant_id,
            clientId: next.client_id,
            status: next.state,
            title: next.title,
            sourcePlatform: 'telegram',
            sourceChannelId,
            rawText: next.description,
            createdAt: next.created_at,
            updatedAt: next.updated_at,
          };
          tasks.set(next.id, replyTarget);
        }
      }
    }

    // A reply to an older draft of a design changed since is about the design as it now is.
    let changedNewestVersion = false;
    // (Not when the reply was already moved on, to the revision that answered a question.)
    if (replyTarget && replyDesignOf && replyDesignOf.of === String(replyTarget.id) && replyDesignOf.newest !== replyDesignOf.of && taskRepo && db) {
      const newestId = replyDesignOf.newest;
      const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(newestId, DEFAULT_TENANT_ID, trx)).catch(() => null);
      if (!next) return problem(c, 503, 'Database unavailable', 'The newest version of the replied-to design could not be read; retry');
      replyTarget = {
        id: next.id,
        tenantId: next.tenant_id,
        clientId: next.client_id,
        status: next.state,
        title: next.title,
        sourcePlatform: 'telegram',
        sourceChannelId,
        rawText: next.description,
        createdAt: next.created_at,
        updatedAt: next.updated_at,
      };
      tasks.set(next.id, replyTarget);
      changedNewestVersion = true;
    }

    if (!feedbackTargetTask && /^(please\s+)?(revise|change|fix|update|remove|add|replace|make|adjust|correct)\b/i.test(rawText.trim())) {
      const textUuidMatch = rawText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (textUuidMatch) {
        feedbackTargetTask = tasks.get(textUuidMatch[1]);
        if (!feedbackTargetTask && taskRepo && db) {
          try {
            const dbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              return await taskRepo.findById(textUuidMatch[1], DEFAULT_TENANT_ID, trx);
            });
            if (dbTask) {
              feedbackTargetTask = {
                id: dbTask.id,
                tenantId: dbTask.tenant_id,
                clientId: dbTask.client_id,
                status: dbTask.state,
                title: dbTask.title,
                sourcePlatform: 'telegram',
                sourceChannelId,
                createdAt: dbTask.created_at,
                updatedAt: dbTask.updated_at,
              };
              tasks.set(dbTask.id, feedbackTargetTask);
            }
          } catch (dbErr) {
            log.warn('[Core] Failed to find text UUID task in DB:', dbErr);
          }
        }
        // Like a reply, "revise <id>" changes only a design made for this chat, as it now is.
        if (feedbackTargetTask && db && sourceChannelId && sourceChannelId !== 'tg_default' && isValidUuid(String(feedbackTargetTask.id))) {
          const named = await replyDesign(String(feedbackTargetTask.id)).catch(() => null);
          if (!named) return problem(c, 503, 'Database unavailable', 'The named design could not be looked up; retry');
          if (named.chat && named.chat !== sourceChannelId) {
            log.warn('[Core] A message named a design made for another chat; reading it on its own.');
            feedbackTargetTask = null;
          } else if (named.newest !== String(feedbackTargetTask.id) && taskRepo) {
            const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(named.newest, DEFAULT_TENANT_ID, trx)).catch(() => null);
            if (!next) return problem(c, 503, 'Database unavailable', 'The newest version of the named design could not be read; retry');
            feedbackTargetTask = { id: next.id, tenantId: next.tenant_id, clientId: next.client_id, status: next.state, title: next.title, sourcePlatform: 'telegram', sourceChannelId, createdAt: next.created_at, updatedAt: next.updated_at };
            tasks.set(next.id, feedbackTargetTask);
            changedNewestVersion = true;
          }
        }
      }
    }

    if (!feedbackTargetTask && sourceChannelId && sourceChannelId !== 'tg_default') {
      const isReply = Boolean(msg.reply_to_message);
      // The design the message is read against: the one a reply answers; else this chat's most
      // recent request in PostgreSQL, revisions included (the in-memory map never held revisions, so
      // a second change bound to the original design and lost the first); else the in-memory map.
      let pendingTasks: any[] = replyTarget ? [replyTarget] : [];
      if (!replyTarget && db) {
        try {
          // Only a request that names an earlier design ("option 2", "the second design") reads
          // against it: "make the two dates gold" bound to the chat's second-newest request.
          const isSecond = /\b(?:plan|option|design|draft)\s*(?:2|two)\b|\b(?:second|2nd)\s+(?:plan|option|design|draft)\b/i.test(rawText);
          const isThird = /\b(?:plan|option|design|draft)\s*(?:3|three)\b|\b(?:third|3rd)\s+(?:plan|option|design|draft)\b/i.test(rawText);
          const ordinalIndex = isThird ? 2 : isSecond ? 1 : 0;

          const recentDbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT t.id, t.tenant_id, t.client_id, t.state, t.title, t.description, t.created_at, t.updated_at, o.payload,
                (SELECT encode(e.content, 'base64')
                 FROM hawa.canva_export_bytes e
                 WHERE e.task_id = t.id AND e.format = 'png'
                 ORDER BY e.created_at DESC LIMIT 1) AS preview_image
              FROM hawa.tasks t
              JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
              WHERE o.payload->>'sourceChannelId' = ${sourceChannelId}
                AND t.created_at > now() - interval '48 hours'
                AND t.client_id IS NOT NULL
                AND COALESCE(o.payload->>'isInstructionOnly', 'false') != 'true'
              ORDER BY t.created_at DESC LIMIT 5`.execute(trx);
          });
          const row = recentDbTask.rows[ordinalIndex] || recentDbTask.rows[0];
          if (row) {
            const rehydrated = {
              id: row.id,
              tenantId: row.tenant_id,
              clientId: row.client_id,
              status: toApiTaskStatus(row.state),
              title: row.title,
              sourcePlatform: 'telegram',
              sourceChannelId,
              rawText: row.payload?.rawRequestText || row.description,
              isInstructionOnly: row.payload?.isInstructionOnly === true || row.payload?.isInstructionOnly === 'true',
              previewImageBase64: row.preview_image && row.preview_image.length > 200 ? row.preview_image : undefined,
              previewImageUrl: row.preview_image && row.preview_image.startsWith('http') ? row.preview_image : undefined,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
            tasks.set(row.id, rehydrated);
            pendingTasks = [rehydrated];
          }
        } catch (dbErr) {
          log.warn('[Core] Failed to query recent task by sourceChannelId:', dbErr);
        }
      }

      if (!replyTarget && pendingTasks.length === 0) {
        const maxAgeMs = 2 * 3600 * 1000;
        const nowMs = Date.now();
        pendingTasks = Array.from(tasks.values())
          .filter((t: any) =>
            t.sourceChannelId === sourceChannelId &&
            t.clientId &&
            t.clientId !== 'client-office-1' &&
            isValidUuid(t.clientId) &&
            !t.isInstructionOnly &&
            (nowMs - new Date(t.createdAt).getTime() <= maxAgeMs) &&
            // IN_PROGRESS (a change asked for in chat) is REVISION_REQUESTED now; COMPLETED and
            // CLARIFICATION_REQUIRED were words no task carried in the database.
            (t.status === 'RECEIVED' || t.status === 'AWAITING_APPROVAL' || t.status === 'REVISION_REQUESTED' || t.status === 'OPERATOR_REQUIRED')
          )
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }

      if (pendingTasks.length > 0 && !pendingTasks[0].previewImageBase64 && db) {
        try {
          const imgRow = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT encode(content, 'base64') AS b64
              FROM hawa.canva_export_bytes
              WHERE task_id = ${pendingTasks[0].id}::uuid AND format = 'png'
              ORDER BY created_at DESC LIMIT 1`.execute(trx);
          });
          if (imgRow.rows[0]?.b64) {
            pendingTasks[0].previewImageBase64 = imgRow.rows[0].b64;
          }
        } catch (imgErr) {
          log.warn('[Core] Failed to fetch previewImageBase64 for pending task:', imgErr);
        }
      }

      // The answer to a clarification question completes the message it was asked about. The
      // question used to be sent and the message forgotten, so "revise" became a change request
      // reading "revise" and the brief itself was lost.
      const pendingClarification = pendingClarifications.get(sourceChannelId);
      let answeredKind: 'feedback' | 'new_brief' | undefined;
      if (pendingClarification && Date.now() - pendingClarification.at < 3600_000 && rawText.trim().length <= 60) {
        const answer = rawText.trim();
        // Only an answer to the question counts: a whole short reply, or any reply to the question
        // itself. "Another poster: Eid Mubarak" is a new message, not the answer "new".
        const toQuestion = /Clarification needed/i.test(String(msg.reply_to_message?.text || ''));
        const NEW_ANSWER = /^(new|new one|a new one|new design|a new design|separate|fresh|نوێ|دیزاینی نوێ|دیزاینێکی نوێ)[\s.!]*$/iu;
        const REVISE_ANSWER = /^(revise|revise it|revision|edit|edit it|change it|update it|the same|same design|previous|the previous one|دەستکاری|دەستکاری بکە|پێشوو|هەمان دیزاین)[\s.!]*$/iu;
        if (NEW_ANSWER.test(answer) || (toQuestion && /\bnew\b|نوێ/iu.test(answer))) answeredKind = 'new_brief';
        else if (REVISE_ANSWER.test(answer) || (toQuestion && /\b(revis\w*|change|edit|same|previous)\b|دەستکاری|پێشوو/iu.test(answer))) answeredKind = 'feedback';
        if (answeredKind) {
          pendingClarifications.delete(sourceChannelId);
          rawText = pendingClarification.rawText;
          if (!referenceImageBase64 && pendingClarification.referenceImageBase64) referenceImageBase64 = pendingClarification.referenceImageBase64;
          if (pendingClarification.task) pendingTasks = [pendingClarification.task];
        }
      }
      // Any other message means the sender moved on; the question is dropped, not left to capture
      // a later "new" as its answer.
      if (pendingClarification && !answeredKind) pendingClarifications.delete(sourceChannelId);

      const recentForClassifier = pendingTasks[0]
        ? {
            id: pendingTasks[0].id,
            title: pendingTasks[0].title,
            rawText: pendingTasks[0].rawText || pendingTasks[0].payloadText,
            copy: pendingTasks[0].copyEn ? [pendingTasks[0].copyEn] : undefined,
            previewImageBase64: pendingTasks[0].previewImageBase64,
            previewImageUrl: pendingTasks[0].previewImageUrl,
          }
        : null;
      classification = answeredKind
        ? {
            kind: answeredKind,
            intent: answeredKind === 'feedback' ? 'revision_feedback' : 'new_brief',
            confidence: 1,
            isInstructionOnly: false,
            directive: rawText,
            reason: 'The sender answered the clarification question',
          }
        : await classifyInboundTelegramMessage({
            messageText: rawText,
            recentTask: recentForClassifier,
            // A reply counts as one to a design only when it names one: a full brief sent in reply to
            // the bot's greeting was asked "is this a change to the design?" (review of 2026-09-24).
            hasReplyTo: isReply && Boolean(replyTarget),
            repliedTo,
            hasReferenceImage: Boolean(referenceImageBase64),
          });

      // Handle clarification when confidence is below threshold (< 0.75)
      if (classification.needsClarification && classification.clarifyingQuestion) {
        pendingClarifications.set(sourceChannelId, { rawText, referenceImageBase64, task: pendingTasks[0], at: Date.now() });
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: `❓ <b>Clarification needed:</b>\n\n${escapeTelegramHtml(classification.clarifyingQuestion)}`,
          parse_mode: 'HTML',
        });
        return c.json({ ok: true, status: 'CLARIFICATION_REQUIRED', question: classification.clarifyingQuestion });
      }

      // "From now on, always put the logo bottom-right", sent on its own, is a rule for later
      // designs. Read as a change to the chat's latest draft, it also paid for a revision nobody
      // asked for; read as a brief, the sentence became a design. Only a reply to a draft applies
      // a rule to that draft as well.
      const ruleSentence = !isReply && isStandingRule(rawText) && (
        classification.kind === 'feedback' ||
        (classification.kind === 'new_brief' && rawText.trim().length <= 200 && !/\n/.test(rawText.trim()))
      );
      if (ruleSentence) {
        classification = { ...classification, kind: 'standing_rule', standingRule: classification.standingRule || rawText.trim() };
      }

      // A lasting preference is saved for the client and applies to every later design. On its own
      // it changes nothing now; said with a change to a draft, the draft is revised as well.
      // A new brief that also says "and from now on …" is designed, and its rule is saved too.
      if (classification.standingRule && (classification.kind === 'standing_rule' || classification.kind === 'feedback' || classification.kind === 'new_brief')) {
        if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
        // Said about a design (a reply, or a change to the latest one), the rule is that design's
        // client's, not whichever client the chat asked for last.
        const aboutDesign = classification.kind === 'feedback' || Boolean(replyTarget);
        const designClient = aboutDesign && pendingTasks[0]?.clientId && isValidUuid(pendingTasks[0].clientId)
          ? await ruleClientById(rulesDeps, pendingTasks[0].clientId)
          : undefined;
        const saved = await saveChatRule(rulesDeps, {
          sourceChannelId,
          sourceEventId,
          ruleText: classification.standingRule,
          originalText: rawText,
          client: designClient,
        });
        standingRuleSaved = saved.saved;
        if (classification.kind === 'standing_rule') {
          if (saved.saved) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_standing_rule', json);
          return c.json({ ok: true, status: saved.saved ? 'RULE_SAVED' : 'RULE_CLIENT_UNKNOWN', rule: classification.standingRule, ruleId: saved.ruleId }, 200);
        }
      } else if (classification.kind === 'standing_rule') {
        // Read as a lasting preference with nothing to restate: saved in the sender's own words.
        if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
        const designClient = replyTarget?.clientId && isValidUuid(replyTarget.clientId) ? await ruleClientById(rulesDeps, replyTarget.clientId) : undefined;
        const saved = await saveChatRule(rulesDeps, { sourceChannelId, sourceEventId, ruleText: rawText.trim(), originalText: rawText, client: designClient });
        if (saved.saved) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_standing_rule', json);
        return c.json({ ok: true, status: saved.saved ? 'RULE_SAVED' : 'RULE_CLIENT_UNKNOWN', ruleId: saved.ruleId }, 200);
      }

      // A picture sent with a remark and no request ("use this for the poster") is kept for the
      // request that follows. It used to be answered with a greeting and the picture lost.
      if ((classification.kind === 'question' || classification.kind === 'other') && referenceImageBase64 && db) {
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: null,
          title: `${senderName}: reference image (awaiting request)`,
          designInstructions: rawText,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
        });
        if (firstOfAlbum) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Picture saved with your note.</b>\n\n` +
              `<i>Send the request text now and the design will use it. Nothing is designed from pictures alone.</i>`,
            parse_mode: 'HTML',
          });
        }
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, referenceAwaitingRequest: true, task: persisted.task }, 201);
      }

      // Thanks or an OK in reply to a draft is acknowledged, and nothing is redesigned.
      if (classification.kind === 'other' && replyTarget) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: /[\u0600-\u06FF]/.test(rawText)
            ? '🙏 سوپاس. بۆ هەر گۆڕانکارییەک، وەڵامی وێنەی دیزاینەکە بدەرەوە و بنووسە چی بگۆڕدرێت.'
            : '🙏 Thank you. If the design is right, tap ✅ Approve design under it; to change anything, reply to the design with the change.',
        });
        // Recorded, so a redelivered update is not thanked twice and the draft counts as answered
        // (no reminder the next morning); it returned without a record (review of 2026-09-24).
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_reply_ack', { taskId: String(replyTarget.id) });
        return c.json({ ok: true, status: 'PROCESSED', kind: 'other', taskId: replyTarget.id });
      }

      // Handle questions and general chatter without polluting task pipeline
      if (classification.kind === 'question' || classification.kind === 'other') {
        if (db) {
          try {
            const inquiryHash = crypto.createHash('sha256').update(JSON.stringify(json ?? { text: rawText })).digest('hex');
            const sourceId = `${sourceChannelId}:${sourceEventId}`;
            await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              const existing = await trx.selectFrom('inbox_events').select(['id'])
                .where('tenant_id', '=', DEFAULT_TENANT_ID)
                .where('source_account_id', '=', 'telegram')
                .where('source_event_id', '=', sourceId).executeTakeFirst();
              if (!existing) {
                await trx.insertInto('inbox_events').values({
                  tenant_id: DEFAULT_TENANT_ID,
                  source_account_id: 'telegram',
                  source_event_id: sourceId,
                  event_kind: `telegram_inquiry_${classification.kind}`,
                  payload: json ?? { text: rawText },
                  payload_hash: inquiryHash,
                  verified: true,
                } as any).execute();
              }
            });
          } catch (inqErr) {
            log.warn('[TelegramIngress] Failed to persist inquiry event to inbox_events:', inqErr);
          }
        }
        if (!sourceChannelId || sourceChannelId === 'tg_default') {
          // Returning PROCESSED here without sending anything is how a person ends up messaging
          // the system and getting silence — the reported symptom that started this work. The
          // reply still cannot be sent without a channel, but the drop is no longer invisible.
          log.error(
            `[telegram] Cannot reply to a '${classification.kind}' message: no usable source ` +
              `channel (got ${JSON.stringify(sourceChannelId)}). Sender=${JSON.stringify(senderName)} ` +
              `event=${JSON.stringify(sourceEventId)}. The sender received no answer.`
          );
          return c.json({
            ok: true,
            status: 'UNANSWERABLE_NO_CHANNEL',
            kind: classification.kind,
          });
        }
        {
          const isSorani = /[\u0600-\u06FF]/.test(rawText);
          const replyText = classification.kind === 'question'
            ? (isSorani
                ? `ℹ️ <b>پەیامەکەت گەیشت:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\nئەگەر دەتەوێت داواکاری دیزاین بنێریت، تکایە دەقی ڕاگەیاندن، بەروار، و شوێن بنێرە.`
                : `ℹ️ <b>Question received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\nTo generate a design, please send your announcement text, date, and venue. For revisions on an existing design, reply directly to the preview message.`)
            : (isSorani
                ? `👋 سڵاو! چۆن دەتوانم یارمەتیت بدەم لە دیزاینەکانتدا؟ تکایە دەقی دیزاینەکەت بنێرە.`
                : `👋 Hello! How can Hawa Creative OS assist you today? Please send your event brief or announcement copy to start.`);
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text: replyText,
            parse_mode: 'HTML',
          });
        }
        return c.json({ ok: true, status: 'PROCESSED', kind: classification.kind });
      }

      // Explicit routing: only 'feedback' intent binds to an existing task
      if (classification.kind === 'feedback' && pendingTasks.length > 0) {
        feedbackTargetTask = pendingTasks[0];
      } else {
        feedbackTargetTask = null;
      }
    }

    // A change addressed to a task by its id ("revise task <id>: …") skips the classifier; a lasting
    // preference said in it is saved the same way.
    if (feedbackTargetTask && !classification && rulesDeps && isStandingRule(rawText)) {
      const saved = await saveChatRule(rulesDeps, {
        sourceChannelId,
        sourceEventId,
        ruleText: rawText.replace(/^\s*(please\s+)?\w+\s+task\s+[0-9a-f-]{36}\s*:?\s*/i, '').trim() || rawText.trim(),
        originalText: rawText,
        client: feedbackTargetTask.clientId && isValidUuid(feedbackTargetTask.clientId)
          ? await ruleClientById(rulesDeps, feedbackTargetTask.clientId)
          : undefined,
      });
      standingRuleSaved = saved.saved;
    }

    // A change to a design that is still being made (a reply to "Request saved", a second change
    // before the first one's draft) was revised from nothing: a second full paid design, and a
    // different one. The sender is asked to reply to the draft once it arrives.
    if (feedbackTargetTask && db && sourceChannelId !== 'tg_default' && isValidUuid(feedbackTargetTask.id)) {
      const [designState, pendingChange] = await Promise.all([
        taskDesignState(feedbackTargetTask.id).catch((err: unknown) => {
          log.warn('[TelegramIngress] Could not read the design state of the change target:', err);
          return 'none' as const;
        }),
        revisionInFlight(feedbackTargetTask.id).catch(() => null),
      ]);
      if (designState === 'running' || pendingChange) {
        const title = cutText(String(pendingChange?.title || feedbackTargetTask.title || 'your design').replace(/^[^:]*:\s*/, ''), 80);
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: pendingChange
            ? `⏳ <b>Your previous change to "${escapeTelegramHtml(title)}" is still being made.</b>\n\n` +
              `<i>When its draft arrives, reply to that draft with this change. Nothing new was started.</i>`
            : `⏳ <b>Your draft "${escapeTelegramHtml(title)}" is still being made.</b>\n\n` +
              `<i>When it arrives, reply to its image with this change. Nothing new was started.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_change_while_designing', json);
        return c.json({ ok: true, status: 'DESIGN_STILL_RUNNING', taskId: pendingChange?.taskId || feedbackTargetTask.id }, 200);
      }
    }

    if (feedbackTargetTask) {
      const targetId = feedbackTargetTask.id;
      const prevStatus = feedbackTargetTask.status;
      const clientId = feedbackTargetTask.clientId && isValidUuid(feedbackTargetTask.clientId) && feedbackTargetTask.clientId !== 'client-office-1'
        ? feedbackTargetTask.clientId
        : KAAE_CLIENT_ID;
      const actor = { id: senderName, role: 'operator', name: senderName };

      // REVISION_REQUESTED, as the database names a design sent back for changes (this said
      // IN_PROGRESS, a word only Core's memory had). This path writes no move to the database.
      feedbackTargetTask.status = 'REVISION_REQUESTED';
      feedbackTargetTask.updatedAt = new Date().toISOString();

      if (!feedbacks.has(targetId)) {
        feedbacks.set(targetId, []);
      }
      feedbacks.get(targetId)?.push({
        feedbackId: crypto.randomUUID(),
        taskId: targetId,
        clientId,
        designRevisionId: feedbackTargetTask.latestRevisionId || crypto.randomUUID(),
        polarity: 'negative',
        category: 'layout',
        rawFeedbackText: rawText,
        attributedActor: {
          userId: crypto.randomUUID(),
          displayName: senderName,
        },
        governance: {
          status: 'received',
        },
        occurredAt: new Date().toISOString(),
      });

      // A lasting preference said with this change was saved above as a client rule (the
      // classifier reads it; the old phrase list only proposed it to a Desk queue kept in memory).
      const isExplicitPersistentRule = standingRuleSaved;
      const feedbackScope = isExplicitPersistentRule ? 'client' : 'one_time';

      if (db && isValidUuid(targetId) && isValidUuid(clientId)) {
        try {
          const tenantId = feedbackTargetTask.tenantId && isValidUuid(feedbackTargetTask.tenantId)
            ? feedbackTargetTask.tenantId
            : DEFAULT_TENANT_ID;
          await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            await trx
              .insertInto('feedback_events')
              .values({
                tenant_id: tenantId,
                client_id: clientId,
                task_id: targetId,
                before_revision_id: isValidUuid(feedbackTargetTask.latestRevisionId) ? feedbackTargetTask.latestRevisionId : null,
                category: 'layout',
                severity: 'medium',
                scope: feedbackScope,
                explicitness: 'direct_instruction',
                target: JSON.stringify({ taskTitle: feedbackTargetTask.title }),
                comment: rawText,
                confidence: 1.0,
              })
              .execute();
          });
        } catch (dbErr) {
          log.warn('[Core] Could not persist feedback_event to PostgreSQL:', dbErr);
        }
      }

      if (!events.has(targetId)) {
        events.set(targetId, []);
      }
      events.get(targetId)?.push({
        eventId: crypto.randomUUID(),
        taskId: targetId,
        fromStatus: prevStatus,
        toStatus: 'REVISION_REQUESTED',
        actor: { type: 'adapter', id: sourceChannelId },
        reason: `Feedback received via Telegram: "${rawText.slice(0, 100)}"`,
        occurredAt: new Date().toISOString(),
      });

      broadcast('task:revision_requested', {
        taskId: targetId,
        notes: rawText,
        requestedBy: senderName,
        source: 'telegram',
      });
      broadcastTransition(targetId, isTaskApiStatus(prevStatus) ? prevStatus : null, 'REVISION_REQUESTED', null);

      // --- Governed Learning & Adaptive Memory (CV-18, ADR-0022, ADR-0044) ---
      // 1. Record negative feedback on previous draft so it is never treated as a positive benchmark
      globalFeedbackMiner.recordNegativeFeedback(targetId, clientId, rawText, actor);

      // 2. Semantic Multi-Rule Extraction from Operator Directive
      const lowerFb = rawText.toLowerCase();
      const extractedRules: Array<{
        category: 'typography' | 'palette' | 'copy_token' | 'layout';
        title: string;
        ruleText: string;
        rationale: string;
      }> = [];

      // B. Typography: the face the sender named, applied when the studio has it and refused
      // out loud when it does not. A font remark that names no face is passed on as written; the
      // handler never substitutes a face of its own for the one asked for.
      const fontRequests = detectFontRequests(rawText);
      const unavailableFonts = fontRequests.filter((request) => !request.available);
      for (const request of fontRequests) {
        if (!request.available) continue;
        const target = request.script === 'unspecified' ? (request.admittedFor ?? 'unspecified') : request.script;
        extractedRules.push({
          category: 'typography',
          title: `${request.family} for ${scriptLabel(target)} text`,
          // An alias is said out loud: "Lora" is drawn as Playfair Display, and the sender is told so.
          ruleText: `Set ${scriptLabel(target)} text in ${request.family}${request.askedAs ? ` (asked for as ${request.askedAs})` : ''}.`,
          rationale: `Requested by name in review feedback: "${rawText.trim().slice(0, 120)}"`,
        });
      }

      // The sender's words, as written, are the rule. Three keyword branches used to stand here
      // (logo, "canva|review|edit", colour) and each replaced the message with a canned sentence:
      // "move the logo up" was recorded as "Always use verified authentic master brand seal",
      // "edit the date" as "Direct all design reviews and final edits to Canva". Three of those
      // canned sentences are still in kaae.dna.json. A message whose only ask was a face the studio
      // lacks gets no rule: passing "use Calibri" on would be sanitised to the default face and
      // then reported as applied.
      if (unavailableFonts.length === 0 || extractedRules.length > 0) {
        extractedRules.push({
          category: 'layout',
          title: 'Feedback, as written',
          ruleText: rawText.trim(),
          rationale: 'Review feedback recorded verbatim',
        });
      }

      // A face the studio cannot draw is refused to the sender now, before any draft is promised.
      // Applying it would end in the default face, reported as their preference.
      if (unavailableFonts.length > 0) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: `⚠️ <b>Font not available</b>\n\n` +
            unavailableFonts.map((request) => escapeTelegramHtml(unavailableFontNotice(request))).join('\n\n') +
            `\n\n<i>To add a new typeface, the owner has to install it in the studio first.</i>`,
          parse_mode: 'HTML',
        }).catch((err: unknown) => {
          log.error('[TelegramBridge] Could not send unavailable-font notice:', err);
        });
      }
      // What this message did, said in the message production senders receive (the revision
      // branch returns before the fallback acknowledgement below, so a line only there is never
      // sent to a real user). A standing rule is a proposal until it is approved in the Desk, and
      // until proposals are stored in PostgreSQL a restart forgets it; the line says so.
      const scopeLine = isExplicitPersistentRule
        ? `📌 <b>Also saved as a standing rule</b> for every later design of this client (/rules lists them).\n`
        : `ℹ️ <i>Applied to this design only. Say "from now on …" to make it a standing rule for every later design.</i>\n`;
      const feedbackOutcome = {
        scope: feedbackScope,
        proposedRules: isExplicitPersistentRule ? extractedRules.map((r) => r.ruleText) : [],
        unavailableFonts: unavailableFonts.map((r) => ({ family: r.family, script: r.script, alternatives: r.alternatives })),
      };

      // The revision is the studio's: a new Canva draft of the same copy with the change applied.
      // A local preview from the legacy templates used to go out first, drawn by a different engine,
      // with Approve and Revision buttons that every press refused.
      const revisedPhotoSent = false;
      const effectiveTaskRules = extractedRules.map((r) => r.ruleText);

      // Trigger genuine automated Canva revision draft
      if (db && isValidUuid(feedbackTargetTask.id) && clientId && isValidUuid(clientId) && clientId !== 'client-office-1') {
        try {
          const tenantId = feedbackTargetTask.tenantId && isValidUuid(feedbackTargetTask.tenantId)
            ? feedbackTargetTask.tenantId
            : DEFAULT_TENANT_ID;

          const priorTaskDetails = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT t.id, t.title, t.description, t.client_id, o.payload
              FROM hawa.tasks t
              LEFT JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
              WHERE t.id = ${feedbackTargetTask.id}::uuid
              ORDER BY o.created_at DESC LIMIT 1`.execute(trx);
          });

          const priorRow = priorTaskDetails.rows[0];
          let priorPayload = priorRow?.payload || {};

          // If the prior task was itself a revision or had its headline contaminated with an instruction,
          // follow parentTaskId to restore the authentic event copy
          if (priorPayload?.studioOptions?.parentTaskId && db) {
            try {
              const rootDetails = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
                return await sql<any>`
                  SELECT o.payload FROM hawa.tasks t
                  JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
                  WHERE t.id = ${priorPayload.studioOptions.parentTaskId}::uuid
                  ORDER BY o.created_at DESC LIMIT 1`.execute(trx);
              });
              const rootPayload = rootDetails.rows[0]?.payload;
              if (rootPayload?.exactCopy && Array.isArray(rootPayload.exactCopy) && rootPayload.exactCopy.length > 0) {
                const priorHeadline = priorPayload.headlineEn || priorPayload.exactCopy?.[0]?.text || '';
                if (/^(?:the\s+)?background\s+is\b|^(?:i\s+)?want\s+|make\s+it\b/i.test(priorHeadline)) {
                  priorPayload = {
                    ...priorPayload,
                    headlineEn: rootPayload.headlineEn,
                    headlineCkb: rootPayload.headlineCkb,
                    copyEn: rootPayload.copyEn,
                    copyCkb: rootPayload.copyCkb,
                    exactCopy: rootPayload.exactCopy,
                    rawRequestText: rootPayload.rawRequestText,
                  };
                }
              }
            } catch (e) {
              log.warn('[Core] Failed to resolve parent task payload:', e);
            }
          }

          const baseInstructions = priorPayload.designInstructions || '';
          const revisionInstructions = `${baseInstructions}\nOperator Revision Directive: ${rawText.trim()}`.trim();
          const cleanTitle = (priorRow?.title || feedbackTargetTask.title || 'Design').replace(/ \(Revision.*\)/, '');
          const revisionTitle = `${cleanTitle} (Revision)`;

          const persisted = await persistChatIntake(db, {
            platform: 'telegram',
            sourceEventId: `${sourceEventId}_rev_${targetId}`,
            sourceChannelId,
            rawText: priorPayload.rawRequestText || priorRow?.description || feedbackTargetTask.rawText || rawText,
            rawJson: json,
            clientId,
            title: revisionTitle,
            headlineEn: priorPayload.headlineEn,
            headlineCkb: priorPayload.headlineCkb,
            copyEn: priorPayload.copyEn,
            copyCkb: priorPayload.copyCkb,
            designInstructions: revisionInstructions,
            exactCopy: priorPayload.exactCopy,
            autoGenerate: true,
            variant: priorPayload.variant || { width: 1080, height: 1350 },
            studioOptions: {
              parentTaskId: targetId,
              revisionRound: (priorPayload?.studioOptions?.revisionRound || 0) + 1,
              // The change itself: the studio makes it to the design the sender replied to.
              revisionDirective: (classification?.directive || rawText).trim(),
              // The album this change came in, so its other photos join this revision.
              ...(albumId ? { mediaGroupId: albumId } : {}),
              referenceImageBase64,
            },
          });

          // The flag is on the intake result. This read it off the task row, where it never is, so
          // a sender over the daily cap was told a draft was being prepared and then heard nothing:
          // the worker refuses a task without autoGenerate and no message follows.
          if (persisted.autoGenerateDeclined) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `✏️ <b>Revision instruction received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
                `⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your revision is saved and queued for manual review in Hawa Desk.</i>`,
              parse_mode: 'HTML',
            });
          } else {
            // The change is made to the design the sender saw, so the message no longer promises "a
            // new layout architecture"; it carries the revision's Task ID so a reply to it finds the
            // revision, not the design before it.
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `✏️ <b>Change received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
                (changedNewestVersion
                  ? `🎨 <b>Making this change to the newest version of this design</b> (the draft you replied to was changed since).\n`
                  : `🎨 <b>Making this change to the same design.</b>\n`) +
                `<i>The new draft and its editable Canva link come to this chat when ready. To change it again, reply to the new draft.</i>\n\n` +
                scopeLine +
                `\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
              parse_mode: 'HTML',
            });
            // Three rounds of changes on one design: the office is told, so a designer can step in
            // before the requester gives up (ADR-032 §2.4). Once per round.
            const round = (priorPayload?.studioOptions?.revisionRound || 0) + 1;
            if (round >= 3) {
              const history = await askHistory(targetId).catch(() => ({ asks: [] as AskRecord[], rounds: round - 1 }));
              await enqueueOfficeAlert(
                persisted.task.id,
                `rounds:${persisted.task.id}`,
                composeDesignerHandoff({ taskId: persisted.task.id, title: revisionTitle, asks: [...history.asks, { ask: rawText.trim().slice(0, 200), status: 'open' }], rounds: round, why: 'rounds' }),
                sourceChannelId
              );
            }
          }

          broadcast('task:created', persisted.task);
          broadcast('task:revision_requested', {
            taskId: targetId,
            revisionTaskId: persisted.task.id,
            notes: rawText,
            requestedBy: senderName,
            source: 'telegram',
          });

          return c.json({
            ok: true,
            feedback: true,
            taskId: targetId,
            revisionTaskId: persisted.task.id,
            status: 'REVISION_QUEUED',
            learnedRule: effectiveTaskRules[0] || 'Operator feedback',
            learnedRules: effectiveTaskRules,
            ...feedbackOutcome,
            comment: rawText,
          }, 200);
        } catch (revErr) {
          // Saying "feedback is recorded" here reported a revision that was never saved. The update
          // is retried instead (the revision's event id makes the retry idempotent).
          log.error('[TelegramBridge] Failed to enqueue revision draft:', revErr);
          return problem(c, 503, 'Revision not saved', 'The revision could not be saved; the message will be retried');
        }
      }

      if (!revisedPhotoSent) {
        // The sender is told what this message did: what applies to this design, and whether a
        // standing rule was proposed. "Applied preferences" used to be printed for both, and for
        // requests that were never applied.
        const appliedNow = extractedRules.map((r) => r.ruleText).join('; ');
        const ackNotice = {
          text: `✏️ <b>Revision Feedback Recorded for Task</b> <code>${escapeTelegramHtml(targetId)}</code>\n\n` +
            `📝 <b>Feedback Notes:</b> "${escapeTelegramHtml(cutText(rawText, 300))}"\n` +
            (appliedNow ? `🧠 <b>Applied to this design:</b> "${escapeTelegramHtml(appliedNow)}"\n` : '') +
            scopeLine +
            `\n⚡ Feedback is recorded. Native Canva changes still require a verified edit and capture.`,
          parse_mode: 'HTML',
        };
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, ackNotice);
      }

      return c.json({
        ok: true,
        feedback: true,
        taskId: targetId,
        status: feedbackTargetTask.status,
        learnedRule: effectiveTaskRules[0] || 'Operator feedback',
        learnedRules: effectiveTaskRules,
        ...feedbackOutcome,
        comment: rawText,
      }, 200);
    }

    if (!classification) {
      classification = await classifyInboundTelegramMessage({
        messageText: rawText,
        recentTask: null,
        hasReplyTo: Boolean(msg.reply_to_message),
        hasReferenceImage: Boolean(referenceImageBase64),
      });
    }

    // Refuse auto-generation when the message contains ONLY instructions or styling feedback without any copy/brief
    if (!feedbackTargetTask && classification?.isInstructionOnly) {
      if (sourceChannelId && sourceChannelId !== 'tg_default') {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `📝 <b>Design instruction received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
            `⚠️ <i>No copy or event details were found in your message. Automatic drafting requires the exact text or announcement details to place on the design.</i>\n\n` +
            `<i>Please send the event title, date, venue, or body copy, and the art director will combine it with your styling preferences.</i>`,
          parse_mode: 'HTML',
        });
      }
      const hostHeader = c.req.header('x-forwarded-host') || c.req.header('host');
      const incomingDeskBase = hostHeader ? `https://${hostHeader}` : undefined;
      const result = await ingestChatCampaignTask({
        platform: 'telegram',
        sourceEventId,
        sourceChannelId,
        senderName,
        rawText,
        voiceTranscript,
        referenceImageBase64,
        explicitClientId: json.clientId,
        autoGenerate: false,
        deskBaseUrl: incomingDeskBase,
        rawJson: json,
        isInstructionOnly: true,
      });
      return c.json({ ok: true, task: result.task, instructionOnly: true, notification: result.notification }, 201);
    }

    const shouldGenerate = c.req.query('generate') === 'true' || json.autoGenerate === true || process.env.AUTO_GENERATE_CHAT_DESIGNS === 'true';
    const hostHeader = c.req.header('x-forwarded-host') || c.req.header('host');
    const incomingDeskBase = hostHeader ? `https://${hostHeader}` : undefined;

    try {
    // English and Kurdish copy for one graphic per language becomes two requests, each read and
    // designed on its own (see splitBilingualRequest).
    const bilingual = splitBilingualRequest(rawText);
    if (bilingual) {
      const results = [];
      for (const [lang, text] of [['en', bilingual.en], ['ckb', bilingual.ckb]] as const) {
        results.push(
          await ingestChatCampaignTask({
            platform: 'telegram',
            sourceEventId: `${sourceEventId}:${lang}`,
            sourceChannelId,
            senderName,
            rawText: text,
            voiceTranscript,
            referenceImageBase64,
            explicitClientId: json.clientId,
            autoGenerate: shouldGenerate,
            deskBaseUrl: incomingDeskBase,
            rawJson: { ...json, hawaLanguageGraphic: lang },
          })
        );
      }
      const duplicate = results.every((r) => r.duplicate === true);
      return c.json({ ok: true, tasks: results.map((r) => r.task), task: results[0].task, bilingual: true, duplicate }, duplicate ? 200 : 201);
    }

    const result = await ingestChatCampaignTask({
      platform: 'telegram',
      sourceEventId,
      sourceChannelId,
      senderName,
      rawText,
      voiceTranscript,
      referenceImageBase64,
      explicitClientId: json.clientId,
      autoGenerate: shouldGenerate,
      deskBaseUrl: incomingDeskBase,
      rawJson: json,
    });

    return c.json({ ok: true, task: result.task, duplicate: result.duplicate === true, voiceTranscript, notification: result.notification }, result.duplicate ? 200 : 201);
    } catch (error) {
      log.error('[chat-intake] Durable Telegram intake failed:', error);
      return problem(c, 503, 'Intake not committed', 'The request was not acknowledged. Retry with the same source event ID.');
    }
  });














  // =========================================================================
  // Track B Acceptance Gates: Visual QA Rubric & Durable Workflows
  // =========================================================================



  // Reminders about drafts a requester has not answered: a pass every 15 minutes writes what is due to
  // the outbox, keyed by task and day, so a restart or a second process never sends one twice.
  if (db && outboxRepo && process.env.TELEGRAM_BOT_TOKEN && options?.enableDraftReminders) {
    const reminderDb = db;
    const reminderOutbox = outboxRepo;
    const pass = () =>
      remindUnansweredDrafts({ db: reminderDb, outbox: reminderOutbox, tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID })
        .catch((err) => log.warn('[draft-reminders] pass failed:', (err as Error)?.message || err));
    setInterval(pass, 15 * 60_000).unref?.();
    setTimeout(pass, 90_000).unref?.();
  }

  // Canva operations nobody follows any more (an import still settling when the studio stopped
  // polling, an export the worker ran out of polls for, a call cut off by a restart) are settled
  // every five minutes, so none blocks its task for good. Nothing ran the sweeper before 2026-09-24.
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

  // The fixtures above are a starting point. What the operator saved is in PostgreSQL, and it
  // must win: see client-dna-hydration.ts. Production refuses to serve on fixtures alone.
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

  // Telegram intake by getUpdates. The handler is registered whenever a bot is configured, so the
  // administrator's "poll now" hands updates to intake exactly as the background loop does (through
  // the same retry and dead letter, under the same one-poll-at-a-time lock); the loop itself runs
  // only in the live server.
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const pollScope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID };
    // The offset, and the count of attempts at a failing update, survive a restart in Postgres.
    const pollState = db ? new PostgresTelegramPollState(db, pollScope, telegramBotKey(process.env.TELEGRAM_BOT_TOKEN)) : null;
    if (pollState) telegramBridge.attachOffsetStorage?.(pollState);
    // A failing update is retried, then dead-lettered with the office alerted and the sender told.
    // It is never skipped: see polled-update-dispatch.ts.
    const handlePolledUpdate = createPolledUpdateHandler<TelegramUpdate>({
      deliver: async (update) => {
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
        if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not configured');
        const res = await app.request('/api/webhooks/telegram?generate=true', {
          method: 'POST',
          // The update's own id (tg-<update_id>, set below) carries on into intake and what it writes.
          headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...requestIdHeaders() },
          body: JSON.stringify(update),
        });
        if (!res.ok) log.error(`[TelegramBridge] Ingress dispatch rejected (${res.status}):`, await res.text().catch(() => ''));
        return res.status;
      },
      ...(pollState ? { recordFailure: (update: TelegramUpdate, reason: string) => pollState.recordFailure(update.update_id, reason) } : {}),
      park: async (update, reason) => {
        if (!db || !pollState) throw new Error('no database to park the update in');
        const office = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean);
        await parkTelegramUpdate(db, pollScope, update, reason, {
          officeChatId: office,
          alongside: (trx) => pollState.advanceWithin(trx, update.update_id),
        });
      },
      notifySender: async (update, text) => {
        const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        if (chatId === undefined || chatId === null) return;
        const sent = await telegramBridge.dispatchOutboundMessage(chatId, { text });
        if (!sent.success) throw new Error(sent.error || 'send failed');
      },
    });
    // One log context per update, retries included: tg-<update_id> finds every attempt at it.
    const handleUpdateInContext = (update: TelegramUpdate) =>
      runWithLogContext(
        { requestId: `tg-${update.update_id}`, chatId: String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '') },
        () => handlePolledUpdate(update)
      );
    telegramBridge.useUpdateHandler?.(handleUpdateInContext);
    // An update polled before client DNA has loaded would go through intake against the fixture
    // offices, so the loop starts once the load is done. If it fails in production, index.ts stops
    // the process, and there is nothing to poll for.
    if (options?.enableTelegramPolling) {
      clientDnaHydrated.then(() => telegramBridge.startPolling(handleUpdateInContext), () => {});
    }
  }

  // index.ts awaits clientDnaHydrated before it opens the port.
  return Object.assign(app, { clientDnaHydrated, guidelineReadings });
}
