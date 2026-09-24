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
  OutboxRepository,
  RevisionRepository,
  PublicationRepository,
} from '@hawa/db';
import type {
  DesignBrief,
  ApprovalDecision,
  FeedbackEvent,
  ClientDNA,
  TaskWorkflowController,
} from '@hawa/domain';
import type { QualityRubricReport } from '@hawa/qa';
import type {
  UnifiedIngressService,
  TelegramBridgeDaemon,
  CircuitBreaker,
  CanvaNativeAdapter,
  HistoricalDesignMigrator,
  ReconciliationService,
  TelegramActionTokenService,
} from '@hawa/integrations';
import type { SyntheticTrafficDaemon } from '@hawa/testkit';
import type { EvaluationRunner } from '@hawa/evals';
import type { AuthContext, ClientDnaSnapshot } from './routes/types.js';

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
  db: Kysely<Database> | null;
  taskRepo: TaskRepository | null;
  outboxRepo: OutboxRepository | null;
  revisionRepo: RevisionRepository | null;
  publicationRepo: PublicationRepository | null;
  unifiedIngress: UnifiedIngressService;
  telegramBridge?: TelegramBridgeDaemon;
  telegramActionTokenService?: TelegramActionTokenService;
  sloDaemon: SyntheticTrafficDaemon;
  evaluationRunner: EvaluationRunner;
  reconciliationService: ReconciliationService;

  // In-memory shared stores (used as fallback or for in-memory tests)
  tasks: Map<string, any>;
  events: Map<string, any[]>;
  briefs: Map<string, DesignBrief>;
  revisions: Map<string, any>;
  decisions: Map<string, ApprovalDecision[]>;
  feedbacks: Map<string, FeedbackEvent[]>;
  clientDnas: Map<string, ClientDNA>;
  clientSnapshots: Map<string, ClientDnaSnapshot[]>;
  evalRuns: Map<string, any>;
  uploadedAssets: Map<string, any>;
  workflowControllers: Map<string, TaskWorkflowController>;
  rubricReports: Map<string, QualityRubricReport[]>;
  taskComments: Map<string, any[]>;
  omnichannelReceipts: Map<string, any>;
  historicalMigrator: HistoricalDesignMigrator;
  globalCanvaNativeAdapter: CanvaNativeAdapter;
  globalCanvaCircuitBreaker: CircuitBreaker;
  channelKillSwitches: { telegram: boolean; waha: boolean };
  issuedSessions: Map<string, any> | Set<string>;
  subscribers: Set<any>;

  // Shared utility functions
  /** `ticketCredential`: the bearer token a redeemed stream ticket stood for (the event stream only). */
  verifyRequestAuth: (c: any, ticketCredential?: string) => AuthContext;
  problem: (c: any, status: number, title: string, detail?: string, ext?: Record<string, any>) => Response;
  broadcastEvent: (type: string, data: any) => void;
  honestHealthHandler: (c: any) => Promise<Response>;
  handleDecommissionedFigmaRoute: (c: any) => Response;
  ensureSessionLoaded?: (token?: string) => Promise<void>;
  bearerTokenOf?: (c: any) => string | undefined;
  saveSession?: (token: string, session: any) => void;
  persistSession?: (token: string, session: any) => Promise<boolean>;
  revokeSession?: (token: string) => Promise<void>;
  /** One-use stream tickets (services/stream-tickets.ts, ADR-037). */
  streamTickets?: import('./services/stream-tickets.js').StreamTicketStore;
  clientRepo?: any;
  options?: any;
}
