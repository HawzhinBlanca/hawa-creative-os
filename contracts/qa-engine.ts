import type { AppError, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';
import type { NeutralManifest, RenderedOutput, StudioDocumentRef } from './design-studio.js';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface QAFinding {
  ruleId: string;
  severity: FindingSeverity;
  hardFailure: boolean;
  category: string;
  message: string;
  nodeIds: string[];
  region?: JsonObject;
  evidence: JsonObject;
  repair?: { operationType: string; targetNodeIds: string[]; arguments: JsonObject; confidence: number };
}

export interface QACheckResult {
  id: string;
  kind: 'schema' | 'copy' | 'facts' | 'font' | 'bidi' | 'layout' | 'brand' | 'image' | 'visual_model' | 'source_package' | 'publication';
  status: 'passed' | 'failed' | 'warning' | 'skipped' | 'error';
  durationMs: number;
  evidence: JsonObject;
  findings: QAFinding[];
}

export interface QARequest {
  taskId: UUID;
  designRevisionId: UUID;
  document: StudioDocumentRef;
  sourceHash: SHA256;
  manifest: NeutralManifest;
  renders: RenderedOutput[];
  brief: JsonObject;
  clientDna: JsonObject;
  profile: { name: string; version: string; rules: JsonObject };
  repairCycle: 0 | 1 | 2;
}

export interface QAReport {
  status: 'passed' | 'failed' | 'error';
  criticalPass: boolean;
  checks: QACheckResult[];
  findings: QAFinding[];
  reportHash: SHA256;
}

export interface QAEngine {
  run(ctx: RequestContext, request: QARequest): Promise<Result<QAReport, AppError>>;
  proposeRepair(ctx: RequestContext, request: QARequest, findings: QAFinding[]): Promise<Result<{ operations: JsonObject[]; bounded: boolean }>>;
  validatePackage(ctx: RequestContext, manifestStorageKey: string): Promise<Result<QAReport>>;
}
