import type {
  DesignStudioAdapter, StudioDocumentRef, CreateDocumentRequest, ApplyOperationsRequest,
  SourceArtifact, NeutralManifest, RenderRequest, RenderedOutput, RequestContext,
  Result, CapabilityReport, SHA256,
} from '@hawa/contracts';
import type { CanvaNativeAdapter } from './canva-native-adapter.js';

export interface CanvaTaskBinding {
  tenantId: string;
  clientId: string;
  taskId: string;
  canvaDesignId: string;
  editUrl: string;
  viewUrl?: string | null;
}

export interface CanvaDesignStudioAdapterOptions {
  mode?: 'canva_connect_cloud' | 'manual_native_handoff';
  resolveBinding?: (ctx: RequestContext) => Promise<CanvaTaskBinding | undefined>;
}

/** Validate handoff URLs without claiming that the address proves saved content. */
export function validateCanvaDesignUrl(value: string, designId?: string): string {
  const url = new URL(value);
  const match = url.pathname.match(/^\/design\/([A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)?\/(edit|view)$/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.canva.com' || url.port ||
      url.username || url.password || url.search || url.hash || !match ||
      (designId && match[1] !== designId)) {
    throw new Error('Use an https://www.canva.com/design/.../edit or /view URL for this design');
  }
  return match[1];
}

/**
 * Canva handoff boundary. A local recipe is not a saved Canva document.
 * Unimplemented remote operations must never fabricate IDs, hashes or receipts.
 * Durable binding resolution is supplied by the application repository.
 */
export class CanvaDesignStudioAdapter implements DesignStudioAdapter {
  public readonly mode: 'canva_connect_cloud' | 'manual_native_handoff';
  private readonly resolveBinding?: CanvaDesignStudioAdapterOptions['resolveBinding'];

  constructor(_legacyRegistry?: CanvaNativeAdapter, options: CanvaDesignStudioAdapterOptions = {}) {
    this.mode = options.mode ?? 'manual_native_handoff';
    this.resolveBinding = options.resolveBinding;
  }

  private unavailable<T>(operation: string): Result<T> {
    return { ok: false, error: {
      code: 'CANVA_NATIVE_OPERATION_REQUIRED',
      message: `${operation} requires a verified native Canva operation; no cloud change has been made`,
      retryable: false,
      safeAction: 'Bind a separate Canva design to this task, edit in Canva and capture the actual exports for review',
    } };
  }

  async capabilities(_ctx: RequestContext): Promise<Result<CapabilityReport>> {
    return { ok: true, value: {
      name: 'CanvaDesignStudioAdapter', version: '2.1.0-handoff', healthy: false,
      capabilities: {
        mode: this.mode, manualNativeHandoff: Boolean(this.resolveBinding),
        cloudConnected: false, canvaNative: false, liveText: false,
        cmykPdfPrint: false, pngRender: false, expectedRevisionLocks: false,
        qualification: 'native_capture_not_verified',
      }, limits: {}, checkedAt: new Date().toISOString(),
    } };
  }

  async create(_ctx: RequestContext, _request: CreateDocumentRequest): Promise<Result<StudioDocumentRef>> {
    return this.unavailable('Create design');
  }
  async import(_ctx: RequestContext, _source: SourceArtifact): Promise<Result<StudioDocumentRef>> {
    return this.unavailable('Import editable design');
  }
  async apply(_ctx: RequestContext, _request: ApplyOperationsRequest): Promise<Result<StudioDocumentRef>> {
    return this.unavailable('Apply native edits');
  }
  async exportSource(_ctx: RequestContext, _document: StudioDocumentRef): Promise<Result<SourceArtifact>> {
    return this.unavailable('Export editable source');
  }
  async getManifest(_ctx: RequestContext, _document: StudioDocumentRef): Promise<Result<NeutralManifest>> {
    return this.unavailable('Read native semantic manifest');
  }
  async render(_ctx: RequestContext, _request: RenderRequest): Promise<Result<RenderedOutput[]>> {
    return this.unavailable('Capture export');
  }
  async verifyRoundTrip(_ctx: RequestContext, _document: StudioDocumentRef): Promise<Result<{
    pass: boolean; beforeHash: SHA256; afterHash: SHA256; semanticDiff: Record<string, unknown>;
  }>> {
    return this.unavailable('Verify save/reopen');
  }

  async getEditorUrl(ctx: RequestContext, document: StudioDocumentRef, mode: 'edit' | 'review'):
    Promise<Result<{ url: string; expiresAt: string }>> {
    if (!ctx.tenantId || !ctx.clientId || !ctx.taskId || !this.resolveBinding) return this.unavailable('Resolve task binding');
    const binding = await this.resolveBinding(ctx);
    if (!binding || binding.tenantId !== ctx.tenantId || binding.clientId !== ctx.clientId ||
        binding.taskId !== ctx.taskId || (document.studioDocumentId && document.studioDocumentId !== binding.canvaDesignId)) {
      return { ok: false, error: { code: 'CANVA_BINDING_REQUIRED', message: 'No matching Canva design is bound to this task',
        retryable: false, safeAction: 'Bind a separate design using the task Canva handoff' } };
    }
    const url = mode === 'review' && binding.viewUrl ? binding.viewUrl : binding.editUrl;
    try { validateCanvaDesignUrl(url, binding.canvaDesignId); }
    catch { return this.unavailable('Resolve valid Canva URL'); }
    // This expiry is the Hawa handoff response lifetime, not a Canva sharing grant.
    return { ok: true, value: { url, expiresAt: new Date(Date.now() + 300000).toISOString() } };
  }
}
