import type { AppError, ISODateTime, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';

export type AssetOperation = 'generate' | 'edit' | 'remove_background' | 'extend' | 'upscale' | 'vectorize' | 'normalize';

export interface AssetReference {
  assetId?: UUID;
  storageKey: string;
  mimeType: string;
  sha256: SHA256;
  role: string;
}

export interface AssetJob {
  operation: AssetOperation;
  workflowId: string;
  workflowVersion: string;
  providerRole: 'image_general' | 'image_vector' | 'image_local' | string;
  prompt?: string;
  negativePrompt?: string;
  references: AssetReference[];
  mask?: AssetReference;
  output: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'; transparent?: boolean };
  parameters: JsonObject;
  budget: { maxCostUsd: number; maxRuntimeMs: number; maxAttempts: number };
  policy: { localOnly: boolean; allowedProviders: string[]; allowFaceEditing: boolean };
}

export interface GeneratedAsset {
  assetId: UUID;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: SHA256;
  width: number;
  height: number;
  provider: string;
  exactModelId: string;
  workflowHash: SHA256;
  seed?: string;
  requestHash: SHA256;
  provenance: JsonObject;
  createdAt: ISODateTime;
}

export interface AssetProvider {
  submit(ctx: RequestContext, job: AssetJob): Promise<Result<{ jobId: string }>>;
  awaitResult(ctx: RequestContext, jobId: string): Promise<Result<GeneratedAsset[]>>;
  cancel(ctx: RequestContext, jobId: string): Promise<Result<void>>;
  validateWorkflow(ctx: RequestContext, workflowId: string, version: string): Promise<Result<{ hash: SHA256; approved: boolean; nodeManifest: JsonObject }>>;
  health(ctx: RequestContext): Promise<Result<{ healthy: boolean; queueDepth: number; detail: JsonObject }, AppError>>;
}
