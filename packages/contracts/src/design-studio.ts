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
