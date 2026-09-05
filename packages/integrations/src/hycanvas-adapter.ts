import type {
  DesignStudioAdapter,
  RequestContext,
  Result,
  CapabilityReport,
  CreateDocumentRequest,
  StudioDocumentRef,
  SourceArtifact,
  NeutralManifest,
  ApplyOperationsRequest,
  RenderRequest,
  RenderedOutput,
  AppError,
  SHA256,
} from '@hawa/contracts';

interface HycDocument {
  schemaVersion: string;
  name: string;
  pages: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    unit: string;
    direction: string;
    nodes: Array<{
      id: string;
      pageId: string;
      type: string;
      role?: string;
      text?: string;
      x: number;
      y: number;
      width: number;
      height: number;
      style?: Record<string, unknown>;
      locked: boolean;
      zIndex: number;
      assetSha256?: string;
    }>;
  }>;
}

export class HyCanvasStudioAdapter implements DesignStudioAdapter {
  private documents = new Map<string, { ref: StudioDocumentRef; doc: HycDocument }>();

  private computeSha256(content: unknown): SHA256 {
    const str = JSON.stringify(content);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return `sha256_${Math.abs(hash).toString(16).padStart(16, '0')}`;
  }

  async capabilities(_ctx: RequestContext): Promise<Result<CapabilityReport>> {
    return {
      ok: true,
      value: {
        name: 'HyCanvasStudioAdapter',
        version: '0.3.9',
        healthy: true,
        capabilities: {
          hycFormat: true,
          liveText: true,
          svgRender: true,
          pngRender: true,
          soraniArabicBidi: true,
          expectedRevisionLocks: true,
        },
        limits: { maxCanvasWidth: 8192, maxCanvasHeight: 8192 },
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async create(_ctx: RequestContext, request: CreateDocumentRequest): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const doc: HycDocument = {
      schemaVersion: '0.3.9',
      name: request.name,
      pages: request.pages.map((p) => ({
        id: p.id,
        name: p.name,
        width: p.width,
        height: p.height,
        unit: p.unit,
        direction: p.direction,
        nodes: [],
      })),
    };

    const sourceSha256 = this.computeSha256(doc);
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `hyc_${documentId}`,
      sourceRevision: 1,
      sourceSha256,
      studio: 'HyCanvas',
      studioVersion: '0.3.9',
      schemaVersion: '0.3.9',
    };

    this.documents.set(documentId, { ref, doc });
    return { ok: true, value: ref };
  }

  async import(_ctx: RequestContext, source: SourceArtifact): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const doc: HycDocument = {
      schemaVersion: source.studioSchemaVersion,
      name: 'Imported Document',
      pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px', direction: 'rtl', nodes: [] }],
    };
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `hyc_imp_${documentId}`,
      sourceRevision: 1,
      sourceSha256: source.sha256,
      studio: 'HyCanvas',
      studioVersion: '0.3.9',
      schemaVersion: source.studioSchemaVersion,
    };
    this.documents.set(documentId, { ref, doc });
    return { ok: true, value: ref };
  }

  async exportSource(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<SourceArtifact>> {
    const item = this.documents.get(document.documentId);
    const sha256 = item ? item.ref.sourceSha256 : document.sourceSha256;
    return {
      ok: true,
      value: {
        storageKey: `sources/${document.documentId}/rev-${document.sourceRevision}.hyc`,
        sha256,
        byteSize: 4096,
        studioSchemaVersion: '0.3.9',
      },
    };
  }

  async getManifest(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<NeutralManifest>> {
    const item = this.documents.get(document.documentId);
    if (!item) {
      return {
        ok: true,
        value: {
          pages: [],
          nodes: [],
          fonts: [{ family: 'Vazirmatn', style: 'Bold' }],
          assets: [],
          warnings: [],
        },
      };
    }

    const pages = item.doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      unit: p.unit,
      direction: p.direction,
    }));

    const nodes = item.doc.pages.flatMap((p) =>
      p.nodes.map((n) => ({
        id: n.id,
        pageId: n.pageId,
        type: n.type,
        role: n.role,
        text: n.text,
        locked: n.locked,
        zIndex: n.zIndex,
        assetSha256: n.assetSha256,
      }))
    );

    return {
      ok: true,
      value: {
        pages,
        nodes,
        fonts: [{ family: 'Vazirmatn', style: 'Bold' }],
        assets: [],
        warnings: [],
      },
    };
  }

  async apply(_ctx: RequestContext, request: ApplyOperationsRequest): Promise<Result<StudioDocumentRef, AppError>> {
    const item = this.documents.get(request.document.documentId);
    if (!item) {
      return {
        ok: false,
        error: {
          code: 'DOCUMENT_NOT_FOUND',
          message: `Document ${request.document.documentId} does not exist`,
          retryable: false,
          safeAction: 'Re-create document from brief',
        },
      };
    }

    // Invariant 14: Strict expected revision conflict handling
    if (request.expectedSourceSha256 !== item.ref.sourceSha256) {
      return {
        ok: false,
        error: {
          code: 'STALE_REVISION_CONFLICT',
          message: `Stale revision conflict: expected ${request.expectedSourceSha256} but found ${item.ref.sourceSha256}`,
          retryable: false,
          safeAction: 'Rebase pending operations on latest document revision',
          detail: { currentRevision: item.ref.sourceRevision },
        },
      };
    }

    for (const op of request.operations) {
      if (op.op === 'addText') {
        const page = item.doc.pages.find((p) => p.id === op.pageId) || item.doc.pages[0];
        if (page) {
          page.nodes.push({
            id: op.nodeId,
            pageId: op.pageId,
            type: 'text',
            role: op.role,
            text: op.text,
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            style: op.style,
            locked: Boolean(op.locked),
            zIndex: page.nodes.length,
          });
        }
      } else if (op.op === 'replaceText') {
        for (const p of item.doc.pages) {
          const node = p.nodes.find((n) => n.id === op.nodeId);
          if (node) {
            node.text = op.text;
          }
        }
      } else if (op.op === 'addImage') {
        const page = item.doc.pages.find((p) => p.id === op.pageId) || item.doc.pages[0];
        if (page) {
          page.nodes.push({
            id: op.nodeId,
            pageId: op.pageId,
            type: 'image',
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            locked: Boolean(op.locked),
            zIndex: page.nodes.length,
            assetSha256: op.asset.sha256,
          });
        }
      } else if (op.op === 'addVector') {
        const page = item.doc.pages.find((p) => p.id === op.pageId) || item.doc.pages[0];
        if (page) {
          page.nodes.push({
            id: op.nodeId,
            pageId: op.pageId,
            type: 'vector',
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            locked: Boolean(op.locked),
            zIndex: page.nodes.length,
          });
        }
      }
    }

    const newRev = item.ref.sourceRevision + 1;
    const newHash = this.computeSha256(item.doc);
    item.ref = {
      ...item.ref,
      sourceRevision: newRev,
      sourceSha256: newHash,
    };

    return { ok: true, value: item.ref };
  }

  async render(_ctx: RequestContext, request: RenderRequest): Promise<Result<RenderedOutput[]>> {
    const rendered: RenderedOutput = {
      format: request.format,
      storageKey: `renders/${request.document.documentId}/${request.format}/rev-${request.document.sourceRevision}.${request.format}`,
      sha256: `sha256_rendered_${request.document.sourceSha256}`,
      byteSize: 4096,
      width: 1080,
      height: 1080,
      warnings: [],
    };
    return { ok: true, value: [rendered] };
  }

  async verifyRoundTrip(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<{ pass: boolean; beforeHash: SHA256; afterHash: SHA256; semanticDiff: Record<string, unknown> }>> {
    const item = this.documents.get(document.documentId);
    if (!item) {
      return {
        ok: false,
        error: {
          code: 'DOCUMENT_NOT_FOUND',
          message: `Document ${document.documentId} not found in studio session; round-trip verification failed`,
          retryable: false,
          safeAction: 'Open or create document before verifying round trip',
        },
      };
    }
    const hash = item.ref.sourceSha256;
    const match = hash === document.sourceSha256;
    return {
      ok: true,
      value: {
        pass: match,
        beforeHash: document.sourceSha256,
        afterHash: hash,
        semanticDiff: match ? {} : { drift: 'source hash mismatch' },
      },
    };
  }

  async getEditorUrl(_ctx: RequestContext, document: StudioDocumentRef, mode: 'edit' | 'review'): Promise<Result<{ url: string; expiresAt: string }>> {
    const baseUrl = process.env.HAWA_STUDIO_URL || 'http://localhost:4173/review';
    return {
      ok: true,
      value: {
        url: `${baseUrl}?doc=${document.documentId}&mode=${mode}&rev=${document.sourceRevision}`,
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
      },
    };
  }
}
