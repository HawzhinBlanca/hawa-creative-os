import type { AppError, CapabilityReport, ISODateTime, JsonObject, RequestContext, Result, SHA256, UUID } from './common.js';

export interface StudioDocumentRef {
  documentId: UUID;
  studioDocumentId?: string;
  sourceRevision: number;
  sourceSha256: SHA256;
  studio: string;
  studioVersion: string;
  schemaVersion: string;
}

export interface CreateDocumentRequest {
  name: string;
  template?: { storageKey: string; sha256: SHA256; templateId: UUID; version: number };
  pages: Array<{ id: string; name: string; width: number; height: number; unit: 'px' | 'mm' | 'in' | 'pt'; language: string; direction: 'ltr' | 'rtl' | 'auto' }>;
  clientDnaVersion: number;
}

export type StudioOperation =
  | { op: 'addText'; nodeId: string; pageId: string; text: string; role: string; x: number; y: number; width: number; height: number; style: JsonObject; locked?: boolean }
  | { op: 'replaceText'; nodeId: string; text: string }
  | { op: 'addImage'; nodeId: string; pageId: string; asset: { storageKey: string; sha256: SHA256; mimeType: string }; x: number; y: number; width: number; height: number; fit: 'cover' | 'contain' | 'stretch'; locked?: boolean }
  | { op: 'addVector'; nodeId: string; pageId: string; source: string; x: number; y: number; width: number; height: number; locked?: boolean }
  | { op: 'transform'; nodeId: string; x?: number; y?: number; width?: number; height?: number; rotation?: number; opacity?: number }
  | { op: 'setStyle'; nodeId: string; style: JsonObject }
  | { op: 'setCrop'; nodeId: string; crop: { x: number; y: number; width: number; height: number }; focalPoint?: { x: number; y: number } }
  | { op: 'group'; groupId: string; pageId: string; nodeIds: string[] }
  | { op: 'lock'; nodeIds: string[]; locked: boolean }
  | { op: 'delete'; nodeIds: string[] }
  | { op: 'resizePage'; pageId: string; width: number; height: number; reflow: 'constraints' | 'scale' | 'none' }
  | { op: 'applyBrand'; pageIds?: string[]; ruleIds: UUID[] }
  | { op: 'custom'; name: string; payload: JsonObject };

export interface ApplyOperationsRequest {
  document: StudioDocumentRef;
  expectedSourceSha256: SHA256;
  operationBatchId: string;
  operations: StudioOperation[];
  allowedNodeIds?: string[];
  prohibitedNodeIds?: string[];
  destructiveOperationsAllowed: boolean;
}

export interface SourceArtifact {
  storageKey: string;
  sha256: SHA256;
  byteSize: number;
  studioSchemaVersion: string;
}

export interface NeutralManifest {
  pages: Array<{ id: string; name: string; width: number; height: number; unit: string; language?: string; direction?: string }>;
  nodes: Array<{ id: string; pageId: string; type: string; role?: string; text?: string; assetSha256?: SHA256; font?: string; locked: boolean; zIndex: number; box?: { x: number; y: number; width: number; height: number } }>;
  fonts: Array<{ family: string; style: string; sha256?: SHA256 }>;
  assets: Array<{ sha256: SHA256; mimeType: string; sourceId?: string }>;
  warnings: Array<{ code: string; message: string; nodeIds?: string[] }>;
}

export interface RenderRequest {
  document: StudioDocumentRef;
  pageIds?: string[];
  format: 'png' | 'jpg' | 'webp' | 'svg' | 'pdf' | 'pptx';
  scale?: number;
  dpi?: number;
  colorSpace?: 'srgb' | 'display-p3' | 'cmyk';
}

export interface RenderedOutput {
  pageId?: string;
  format: RenderRequest['format'];
  storageKey: string;
  sha256: SHA256;
  byteSize: number;
  width?: number;
  height?: number;
  warnings: string[];
}

export interface DesignStudioAdapter {
  capabilities(ctx: RequestContext): Promise<Result<CapabilityReport>>;
  create(ctx: RequestContext, request: CreateDocumentRequest): Promise<Result<StudioDocumentRef>>;
  import(ctx: RequestContext, source: SourceArtifact): Promise<Result<StudioDocumentRef>>;
  exportSource(ctx: RequestContext, document: StudioDocumentRef): Promise<Result<SourceArtifact>>;
  getManifest(ctx: RequestContext, document: StudioDocumentRef): Promise<Result<NeutralManifest>>;
  apply(ctx: RequestContext, request: ApplyOperationsRequest): Promise<Result<StudioDocumentRef, AppError>>;
  render(ctx: RequestContext, request: RenderRequest): Promise<Result<RenderedOutput[]>>;
  verifyRoundTrip(ctx: RequestContext, document: StudioDocumentRef): Promise<Result<{ pass: boolean; beforeHash: SHA256; afterHash: SHA256; semanticDiff: JsonObject }>>;
  getEditorUrl(ctx: RequestContext, document: StudioDocumentRef, mode: 'edit' | 'review'): Promise<Result<{ url: string; expiresAt: ISODateTime }>>;
}

// ============================================================================
// CANVA NATIVE STUDIO BINDING & CAPTURE CONTRACTS (ADR 020 / CV-04)
// ============================================================================

export interface CanvaStudioBinding {
  id: UUID;
  tenantId: UUID;
  taskId: UUID;
  clientId: UUID;
  canvaDesignId: string;
  canvaTeamId?: string;
  canvaUserId?: string;
  editUrl: string;
  viewUrl?: string;
  directionName: string;
  status: 'bound' | 'unbound' | 'revoked';
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CanvaCapturedArtifact {
  format: 'png' | 'pdf_print' | 'svg' | 'pdf_standard';
  storageKey: string;
  sha256: SHA256;
  byteSize: number;
  width?: number;
  height?: number;
  dpi?: number;
  colorSpace?: 'cmyk' | 'srgb';
}

export interface CanvaSemanticCoverage {
  textNodesCount: number;
  imageFillsCount: number;
  hasLogo: boolean;
  isComplete: boolean;
  unobservedLayersCount?: number;
}

export interface CanvaCaptureArtifactSet {
  id: UUID;
  tenantId: UUID;
  bindingId: UUID;
  taskId: UUID;
  clientId: UUID;
  parentRevisionId?: UUID;
  capturedArtifactSetHash: SHA256;
  artifacts: CanvaCapturedArtifact[];
  exportSettings: JsonObject;
  semanticCoverage: CanvaSemanticCoverage;
  effectJobId?: string;
  authActor: {
    actorType: 'user' | 'model' | 'workflow' | 'operator';
    actorId: string;
  };
  version: number;
  createdAt: ISODateTime;
}

export interface CreateCanvaBindingRequest {
  tenantId: UUID;
  taskId: UUID;
  clientId: UUID;
  canvaDesignId: string;
  canvaTeamId?: string;
  canvaUserId?: string;
  editUrl?: string;
  viewUrl?: string;
  directionName?: string;
}

export interface CaptureCanvaArtifactSetRequest {
  tenantId: UUID;
  taskId: UUID;
  clientId: UUID;
  canvaDesignId: string;
  expectedVersion: number;
  parentRevisionId?: UUID;
  artifacts: CanvaCapturedArtifact[];
  exportSettings?: JsonObject;
  semanticCoverage: CanvaSemanticCoverage;
  effectJobId?: string;
  authActor: {
    actorType: 'user' | 'model' | 'workflow' | 'operator';
    actorId: string;
  };
}

export interface CanvaBindingAppError extends AppError {
  code:
    | 'FOREIGN_CLIENT_DENIAL'
    | 'UNKNOWN_DESIGN_DENIAL'
    | 'STALE_VERSION_CONFLICT'
    | 'INCOMPLETE_SNAPSHOT_ERROR'
    | 'INVALID_REQUEST';
}

export function validateCanvaCaptureInvariants(
  request: CaptureCanvaArtifactSetRequest,
  binding: CanvaStudioBinding
): Result<void, CanvaBindingAppError> {
  // 1. Server-derived client ownership check: A design URL or request alone cannot cross client boundaries
  if (request.clientId !== binding.clientId) {
    return {
      ok: false,
      error: {
        code: 'FOREIGN_CLIENT_DENIAL',
        message: `Cross-client violation: request client ${request.clientId} does not match bound client ${binding.clientId}`,
        retryable: false,
        safeAction: 'Verify task client assignment and obtain authorized credentials',
        detail: { requestedClientId: request.clientId, boundClientId: binding.clientId, taskId: request.taskId }
      }
    };
  }

  // 2. Bound design identity check: Reject unknown or spoofed design IDs
  if (request.canvaDesignId !== binding.canvaDesignId) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_DESIGN_DENIAL',
        message: `Design mismatch: design ${request.canvaDesignId} does not match bound design ${binding.canvaDesignId}`,
        retryable: false,
        safeAction: 'Re-bind design or specify correct bound design ID',
        detail: { requestedDesignId: request.canvaDesignId, boundDesignId: binding.canvaDesignId }
      }
    };
  }

  // 3. Optimistic concurrency check: Reject stale requests
  if (request.expectedVersion !== binding.version) {
    return {
      ok: false,
      error: {
        code: 'STALE_VERSION_CONFLICT',
        message: `Optimistic lock conflict: expected version ${request.expectedVersion} does not match current version ${binding.version}`,
        retryable: true,
        safeAction: 'Fetch fresh binding state and retry operation',
        detail: { expectedVersion: request.expectedVersion, currentVersion: binding.version }
      }
    };
  }

  // 4. Invariant: Snapshot incompleteness cannot be represented as a fully observed source
  if (!request.semanticCoverage.isComplete) {
    return {
      ok: false,
      error: {
        code: 'INCOMPLETE_SNAPSHOT_ERROR',
        message: 'Snapshot incompleteness cannot be represented as fully observed source',
        retryable: false,
        safeAction: 'Complete full layer observation before finalizing capture set',
        detail: { semanticCoverage: request.semanticCoverage as unknown as JsonObject }
      }
    };
  }

  // 5. Basic payload sanity
  if (!request.artifacts || request.artifacts.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Artifact set cannot be empty; at least one captured artifact required',
        retryable: false,
        safeAction: 'Include valid captured export artifacts'
      }
    };
  }

  return { ok: true, value: undefined };
}

// ============================================================================
// CANVA AUTOMATION LEASE & BOUNDED OPERATION CONTRACTS (CV-12)
// ============================================================================

export interface CanvaAutomationLease {
  leaseId: string;
  canvaDesignId: string;
  taskId: UUID;
  holderId: string;
  acquiredAt: ISODateTime;
  expiresAt: ISODateTime;
  releasedAt?: ISODateTime;
}

export type BoundedCanvaOperation =
  | { op: 'replace_text'; elementId: string; text: string; expectedText?: string }
  | { op: 'adjust_geometry'; elementId: string; box: { x?: number; y?: number; width?: number; height?: number; rotation?: number } }
  | { op: 'adjust_style'; elementId: string; style: { fontSize?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' | number; color?: string; textAlign?: 'left' | 'center' | 'right'; lineHeight?: number } }
  | { op: 'swap_asset'; elementId: string; assetRef: { storageKey: string; sha256: SHA256; mimeType: string } }
  | { op: 'set_crop'; elementId: string; crop: { x: number; y: number; width: number; height: number } }
  | { op: 'group_elements'; groupId: string; elementIds: string[] }
  | { op: 'set_lock'; elementIds: string[]; locked: boolean }
  | { op: 'unsupported_request'; requestedAction: string; targetElementId?: string; reason?: string };

export interface RecommendedHumanAction {
  code: 'UNSUPPORTED_NATIVE_OPERATION';
  recommendedAction: 'HUMAN_ACTION_RECOMMENDED';
  actionName: string;
  targetElementId?: string;
  reason: string;
  canvaGuidance: string;
}

export interface StagedEditTransaction {
  transactionId: string;
  leaseId: string;
  canvaDesignId: string;
  beforeSha256: SHA256;
  previewSha256: SHA256;
  appliedOperations: BoundedCanvaOperation[];
  createdAt: ISODateTime;
  status: 'staged' | 'committed' | 'cancelled';
}


