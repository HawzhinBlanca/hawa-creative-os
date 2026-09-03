import type { AppError, JsonObject, RequestContext, Result, UUID } from './common.js';

export interface RetrievalIntent {
  query: string;
  language?: string;
  kinds: Array<'rule' | 'official_asset' | 'template' | 'approved_example' | 'feedback' | 'document' | 'negative_example'>;
  taskType?: string;
  campaign?: string;
  topK: number;
}

export interface RetrievalCandidate {
  id: UUID;
  kind: RetrievalIntent['kinds'][number];
  clientId: UUID;
  projectId?: UUID;
  sourceId: string;
  title?: string;
  text?: string;
  previewStorageKey?: string;
  metadata: JsonObject;
  lexicalScore?: number;
  vectorScore?: number;
  rerankScore?: number;
  approved: boolean;
  polarity: 'positive' | 'negative' | 'neutral';
  active: boolean;
}

export interface ContextPack {
  clientId: UUID;
  projectId?: UUID;
  clientDnaVersion: number;
  authoritative: {
    rules: JsonObject[];
    assets: JsonObject[];
    templates: JsonObject[];
    glossary: JsonObject[];
  };
  evidence: RetrievalCandidate[];
  negativeEvidence: RetrievalCandidate[];
  unresolvedConflicts: Array<{ type: string; sourceIds: string[]; message: string }>;
  retrievalTrace: JsonObject;
}

export interface RetrievalProvider {
  retrieve(ctx: RequestContext & { clientId: UUID }, intents: RetrievalIntent[]): Promise<Result<ContextPack, AppError>>;
  ingest(ctx: RequestContext & { clientId: UUID }, request: { sourceKind: string; sourceId: string; sourceVersion?: string; storageKey: string; mimeType: string; sha256: string; projectId?: UUID }): Promise<Result<{ documentId: UUID; chunks: number; changed: boolean }>>;
  deactivate(ctx: RequestContext & { clientId: UUID }, sourceId: string, reason: string): Promise<Result<void>>;
  evaluate(ctx: RequestContext, datasetId: UUID, candidateConfig: JsonObject): Promise<Result<{ runId: UUID }>>;
}
