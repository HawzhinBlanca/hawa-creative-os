import type { AppError, ISODateTime, JsonObject, RequestContext, Result, UUID } from './common.js';

export type FigmaRoute = 'buzz_template' | 'figma_freeform' | 'human';

export type FigmaOperationName =
  | 'inspect_file'
  | 'inspect_selection'
  | 'inspect_client_library'
  | 'find_component'
  | 'duplicate_template'
  | 'create_staging_frame'
  | 'create_buzz_asset'
  | 'set_buzz_text_fields'
  | 'set_buzz_media_fields'
  | 'smart_resize_buzz'
  | 'instantiate_component'
  | 'set_component_property'
  | 'create_text'
  | 'replace_text'
  | 'set_font'
  | 'place_image'
  | 'crop_image'
  | 'create_vector_from_svg'
  | 'move_node'
  | 'resize_node'
  | 'align_nodes'
  | 'set_auto_layout'
  | 'reorder_layers'
  | 'apply_variable'
  | 'apply_style'
  | 'render_preview'
  | 'export_node'
  | 'checkpoint'
  | 'restore_checkpoint'
  | 'inspect_diff';

export interface FigmaLease {
  id: UUID;
  taskId: UUID;
  clientId: UUID;
  fileKey: string;
  holder: string;
  expiresAt: ISODateTime;
  releasedAt?: ISODateTime;
}

export interface FigmaCommand {
  commandId: string;
  taskId: UUID;
  clientId: UUID;
  fileKey: string;
  targetNodeId?: string;
  leaseId: UUID;
  expectedRevision: number;
  operation: FigmaOperationName;
  args: JsonObject;
}

export interface FigmaMutationResult {
  revision: number;
  affectedNodeIds: string[];
  markerId: string;
  previewUrl?: string;
}

export interface FigmaStagingTarget {
  fileKey: string;
  pageName: string;
  frameId: string;
  frameName: string;
  stagingUrl: string;
}

export interface BuzzFieldMapping {
  templateId: string;
  textFields: Record<string, string>;
  mediaFields: Record<string, { storageKey: string; sha256: string; fit?: 'cover' | 'contain' }>;
  targetAspectRatios: Array<'1:1' | '4:5' | '9:16' | '16:9'>;
}

export interface FigmaNodeSnapshot {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  characters?: string;
  fontName?: { family: string; style: string };
  fills?: unknown[];
  strokes?: unknown[];
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  children?: FigmaNodeSnapshot[];
}

export interface FigmaBridge {
  acquireLease(ctx: RequestContext, fileKey: string, ttlSeconds: number): Promise<Result<FigmaLease>>;
  releaseLease(ctx: RequestContext, leaseId: UUID): Promise<Result<void>>;
  inspect(ctx: RequestContext, fileKey: string, nodeId?: string): Promise<Result<FigmaNodeSnapshot | JsonObject>>;
  mutate(ctx: RequestContext, command: FigmaCommand): Promise<Result<FigmaMutationResult, AppError>>;
  renderPreview(ctx: RequestContext, fileKey: string, nodeId: string): Promise<Result<{ buffer: Uint8Array; mimeType: string; width: number; height: number }>>;
  exportNode(ctx: RequestContext, fileKey: string, nodeId: string, format: 'PNG' | 'JPG' | 'PDF' | 'SVG'): Promise<Result<{ buffer: Uint8Array; format: string; byteSize: number }>>;
  createBuzzAsset(ctx: RequestContext, templateId: string, fields: BuzzFieldMapping): Promise<Result<{ nodeId: string; previewUrl?: string }>>;
  smartResizeBuzz(ctx: RequestContext, nodeId: string, targetAspect: '1:1' | '4:5' | '9:16' | '16:9'): Promise<Result<{ resizedNodeId: string }>>;
}
