import type { Hono } from 'hono';
import type {
  Database,
  Kysely,
  TaskRepository,
  IngressRepository,
  OutboxRepository,
  RevisionRepository,
  CanvaBindingRepository,
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

export interface ClientDnaSnapshot {
  snapshotId: string;
  clientId: string;
  version: number;
  sha256: string;
  commitMessage: string;
  createdBy: string;
  createdAt: string;
  dna: ClientDNA;
}

export type RouteRegistrar = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: any) => void;

export interface AuthContext {
  authenticated: boolean;
  role?: string;
  tenantId?: string;
  actorId?: string;
  userId?: string;
}

export interface RouteContext {
  app: Hono;
  registerRoute: RouteRegistrar;
  db: Kysely<Database> | null;
  taskRepo: TaskRepository | null;
  ingressRepo: IngressRepository | null;
  outboxRepo: OutboxRepository | null;
  revisionRepo: RevisionRepository | null;
  canvaBindingRepo: CanvaBindingRepository | null;
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
  rawEvents: Map<string, any>;
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
  streamTickets?: import('../services/stream-tickets.js').StreamTicketStore;
  clientRepo?: any;
  options?: any;
}
