import type { AppError, ISODateTime, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';

export type ModelRole =
  | 'intake_router' | 'brief_builder' | 'creative_director' | 'visual_judge'
  | 'feedback_classifier' | 'rule_miner' | 'embedding_multimodal' | 'reranker_multimodal';

export interface ModelDeploymentRef {
  deploymentId: UUID;
  role: ModelRole;
  provider: string;
  exactModelId: string;
  deploymentVersion: string;
  promptVersion?: string;
}

export interface ModelInputPart {
  kind: 'text' | 'image' | 'document' | 'json';
  text?: string;
  storageKey?: string;
  /** Inline base64 image bytes, with mimeType; used when no retained asset path is supplied. */
  data?: string;
  mimeType?: string;
  json?: unknown;
  sha256?: SHA256;
  sourceId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  mutates: boolean;
}

export interface StructuredModelRequest<TSchema extends JsonObject = JsonObject> {
  role: ModelRole;
  deploymentId?: UUID;
  inputs: ModelInputPart[];
  systemPromptVersion: string;
  responseSchema: TSchema;
  tools?: ToolDefinition[];
  allowedToolNames?: string[];
  temperature?: number;
  reasoningProfile?: 'minimal' | 'low' | 'medium' | 'high' | 'maximum';
  maxOutputTokens?: number;
  budget: { maxCostUsd: number; maxLatencyMs: number; maxAttempts: number };
  egressPolicy: { mode: 'local_only' | 'approved_providers' | 'evaluated_external_allowed'; allowedProviders: string[] };
  cachePolicy: 'disabled' | 'request_hash';
}

export interface StructuredModelResponse<T> {
  deployment: ModelDeploymentRef;
  value: T;
  responseHash: SHA256;
  invocationId: UUID;
  usage: { inputTokens?: number; outputTokens?: number; assetUnits?: number; estimatedCostUsd?: number };
  latencyMs: number;
  attempts: number;
  completedAt: ISODateTime;
  traceId?: string;
}

export interface EmbeddingRequest {
  role: 'embedding_multimodal';
  deploymentId?: UUID;
  items: Array<{ id: string; text?: string; imageStorageKey?: string; mimeType?: string }>;
  dimensions?: number;
  normalize: boolean;
  egressPolicy: StructuredModelRequest['egressPolicy'];
}

export interface EmbeddingResponse {
  deployment: ModelDeploymentRef;
  dimensions: number;
  vectors: Array<{ id: string; vector: number[] }>;
  invocationId: UUID;
  latencyMs: number;
}

export interface RerankRequest {
  role: 'reranker_multimodal';
  deploymentId?: UUID;
  query: ModelInputPart[];
  candidates: Array<{ id: string; parts: ModelInputPart[] }>;
  topK: number;
  egressPolicy: StructuredModelRequest['egressPolicy'];
}

export interface RerankResponse {
  deployment: ModelDeploymentRef;
  ranked: Array<{ id: string; score: number; rank: number }>;
  invocationId: UUID;
  latencyMs: number;
}

export interface ModelGateway {
  resolve(ctx: RequestContext, role: ModelRole, constraints?: JsonObject): Promise<Result<ModelDeploymentRef>>;
  generateStructured<T>(ctx: RequestContext, request: StructuredModelRequest): Promise<Result<StructuredModelResponse<T>, AppError>>;
  embed(ctx: RequestContext, request: EmbeddingRequest): Promise<Result<EmbeddingResponse>>;
  rerank(ctx: RequestContext, request: RerankRequest): Promise<Result<RerankResponse>>;
  cancel?(ctx: RequestContext, invocationId: UUID): Promise<Result<void>>;
}
