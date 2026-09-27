/**
 * What createApp shares with the route modules and services split out of app.ts (architecture
 * programme 1.3, SPLIT_PLAN.md F2 and F10): the constants every one of them used to redefine, and
 * the context object createApp builds once. A route module receives it as `RouteContext`
 * (routes/types.ts), which adds only the Hono app and `registerRoute`.
 *
 * Imports here are type-only: services and route modules import this file, and it names their types.
 */
import type {
  Database,
  Kysely,
  TaskRepository,
  ClientRepository,
  OutboxRepository,
  RevisionRepository,
  PublicationRepository,
} from '@hawa/db';
import type { Publisher, QAEngine } from '@hawa/contracts';
import type { DesignBrief, ClientDNA } from '@hawa/domain';
import type {
  UnifiedIngressService,
  TelegramBridgeDaemon,
  CircuitBreaker,
  CanvaNativeAdapter,
  HistoricalDesignMigrator,
  ReconciliationService,
  TelegramActionTokenService,
  KurdishVoiceTranscriber,
} from '@hawa/integrations';
import type { CreativeDirectorRunner } from '@hawa/creative';
import type { SyntheticTrafficDaemon } from '@hawa/testkit';
import type { DurableEvaluationService } from './services/durable-evaluations.js';
import type { PaidModelHealth } from './services/paid-model-health.js';
import type { AuthContext, ClientDnaSnapshot } from './routes/types.js';
import type { CreateAppOptions } from './core-helpers.js';
import type { CanvaConnectService } from './services/canva-connect-service.js';
import type { DeliverableStore } from './services/pinned-deliverables.js';
import type { TaskReader } from './services/task-reader.js';
import type { ClientDnaResolver } from './services/client-dna-resolver.js';
import type { OmnichannelDelivery } from './services/omnichannel-delivery.js';

/** The one tenant this office runs as. */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
/** The operator a request acts as when it names no user. */
export const OPERATOR_USER_ID = '00000000-0000-4000-b000-000000000001';
export const ADMIN_USER_ID = '00000000-0000-4000-b000-000000000002';
/**
 * A fixture client's id that some routes still use when a request names no client. It is not a
 * real office; replacing the fallback with a refusal is clients-and-DNA work (SPLIT_PLAN.md section 6).
 */
export const DEFAULT_CLIENT_ID = 'client-office-1';

export interface CoreContext {
  /** createApp's options, as the caller passed them. */
  options?: CreateAppOptions;
  /** Running in production. Route modules read this rather than the environment (no-second-system test). */
  isProduction: boolean;
  db: Kysely<Database> | null;
  taskRepo: TaskRepository | null;
  clientRepo: ClientRepository | null;
  outboxRepo: OutboxRepository | null;
  revisionRepo: RevisionRepository | null;
  publicationRepo: PublicationRepository | null;
  unifiedIngress: UnifiedIngressService;
  telegramBridge?: TelegramBridgeDaemon;
  telegramActionTokenService?: TelegramActionTokenService;
  sloDaemon: SyntheticTrafficDaemon;
  evaluationService: DurableEvaluationService | null;
  reconciliationService: ReconciliationService;
  canvaConnectService: CanvaConnectService | null;
  /** Where approved exports are read from (pinned-deliverables.ts). */
  deliverableStore: DeliverableStore;
  qaEngine: QAEngine;
  creativeDirector: CreativeDirectorRunner;
  publisher: Publisher;
  voiceTranscriber: KurdishVoiceTranscriber;
  /** Telegram user ids of the office (TELEGRAM_ALLOWED_USERS). */
  telegramAllowedUsers: string[];
  /** The office plus the requesters allowed to send work in Telegram (TELEGRAM_INTAKE_ALLOWED_USERS). */
  telegramIntakeUsers: string[];
  /** Brand guidelines being read in the background after the sender was answered; tests await them. */
  guidelineReadings: Set<Promise<void>>;

  // Without a database only: with one, each holds nothing and Postgres is the only truth
  // (services/no-database-store.ts). Routes still read and write them for the in-memory mode.
  tasks: Map<string, any>;
  events: Map<string, any[]>;
  briefs: Map<string, DesignBrief>;
  clientSnapshots: Map<string, ClientDnaSnapshot[]>;
  uploadedAssets: Map<string, any>;
  /** Client DNA as this process loaded it; Postgres answers first (services/client-dna-resolver.ts). */
  clientDnas: Map<string, ClientDNA>;

  historicalMigrator: HistoricalDesignMigrator;
  globalCanvaNativeAdapter: CanvaNativeAdapter;
  globalCanvaCircuitBreaker: CircuitBreaker;
  channelKillSwitches: { telegram: boolean; waha: boolean };
  /** The event stream's open connections. */
  subscribers: Set<any>;

  // Shared utility functions
  /** `ticketCredential`: the bearer token a redeemed stream ticket stood for (the event stream only). */
  verifyRequestAuth: (c: any, ticketCredential?: string) => AuthContext;
  problem: (c: any, status: number, title: string, detail?: string, ext?: Record<string, any>) => Response;
  broadcastEvent: (type: string, data: any) => void;
  /** Tells the Desk a task moved, in the one task:transitioned shape (packages/contracts task-status.ts). */
  broadcastTransition: (taskId: string, from: string | null | undefined, to: string, version?: number | string | null) => void;
  /** A task as Postgres has it (services/task-reader.ts); readCurrentTask throws when it cannot be read. */
  resolveTaskWithFallback: TaskReader['resolveTaskWithFallback'];
  readCurrentTask: TaskReader['readCurrentTask'];
  resolveClientDna: ClientDnaResolver;
  /** Delivery of an approved design (services/omnichannel-delivery.ts). */
  delivery: Pick<OmnichannelDelivery, 'executeOmnichannelPublish' | 'storedCompletePublication' | 'reopenInterruptedDelivery' | 'changeBlockingDelivery'
    | 'requesterChatOf' | 'deliveryExecutorOfTask' | 'startWorkflowDelivery' | 'prepareWorkflowDelivery' | 'finishWorkflowDelivery'>;
  /** The model provider's last known health, for the failed-task sweep (health probes stay in app.ts). */
  probeModelProvider: () => Promise<string>;
  paidModelHealth: () => Promise<PaidModelHealth>;
  honestHealthHandler: (c: any) => Promise<Response>;
  handleDecommissionedFigmaRoute: (c: any) => Response;
  ensureSessionLoaded?: (token?: string) => Promise<void>;
  bearerTokenOf?: (c: any) => string | undefined;
  saveSession?: (token: string, session: any) => void;
  persistSession?: (token: string, session: any) => Promise<boolean>;
  revokeSession?: (token: string) => Promise<void>;
  /** One-use stream tickets (services/stream-tickets.ts, ADR-037). */
  streamTickets?: import('./services/stream-tickets.js').StreamTicketStore;
}
