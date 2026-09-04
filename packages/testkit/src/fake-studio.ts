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
  UUID,
} from '@hawa/contracts';

interface StoredDocument {
  ref: StudioDocumentRef;
  content: {
    schemaVersion: '1.0';
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
        type: string;
        role?: string;
        text?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        style?: Record<string, unknown>;
        locked: boolean;
        assetSha256?: string;
      }>;
    }>;
  };
}

export class FakeDesignStudioAdapter implements DesignStudioAdapter {
  private documents = new Map<string, StoredDocument>();
  private failureMode: 'none' | 'stale_revision' | 'render_timeout' = 'none';

  setFailureMode(mode: 'none' | 'stale_revision' | 'render_timeout') {
    this.failureMode = mode;
  }

  private computeHash(obj: unknown): SHA256 {
    const str = JSON.stringify(obj);
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
        name: 'FakeHyCanvasStudio',
        version: '0.3.9',
        healthy: true,
        capabilities: {
          vectorExport: true,
          liveText: true,
          rtlSupport: true,
          bidiIsolation: true,
        },
        limits: { maxCanvasWidth: 8192, maxCanvasHeight: 8192 },
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async create(_ctx: RequestContext, request: CreateDocumentRequest): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const initialContent: StoredDocument['content'] = {
      schemaVersion: '1.0',
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

    const hash = this.computeHash(initialContent);
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `fake-doc-${documentId}`,
      sourceRevision: 1,
      sourceSha256: hash,
      studio: 'FakeHyCanvas',
      studioVersion: '0.3.9',
      schemaVersion: '1.0',
    };

    this.documents.set(documentId, { ref, content: initialContent });
    return { ok: true, value: ref };
  }

  async import(_ctx: RequestContext, source: SourceArtifact): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `imported-${documentId}`,
      sourceRevision: 1,
      sourceSha256: source.sha256,
      studio: 'FakeHyCanvas',
      studioVersion: '0.3.9',
      schemaVersion: source.studioSchemaVersion,
    };
    return { ok: true, value: ref };
  }

  async exportSource(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<SourceArtifact>> {
    const doc = this.documents.get(document.documentId);
    const hash = doc ? doc.ref.sourceSha256 : document.sourceSha256;
    return {
      ok: true,
      value: {
        storageKey: `sources/${document.documentId}/rev-${document.sourceRevision}.hyc`,
        sha256: hash,
        byteSize: 1024,
        studioSchemaVersion: '1.0',
      },
    };
  }

  async getManifest(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<NeutralManifest>> {
    const doc = this.documents.get(document.documentId);
    if (!doc) {
      return {
        ok: true,
        value: {
          pages: [],
          nodes: [],
          fonts: [{ family: 'Vazirmatn', style: 'Regular' }],
          assets: [],
          warnings: [],
        },
      };
    }

    const pages = doc.content.pages.map((p) => ({
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      unit: p.unit,
      direction: p.direction,
    }));

    const nodes = doc.content.pages.flatMap((p) =>
      p.nodes.map((n, i) => ({
        id: n.id,
        pageId: p.id,
        type: n.type,
        role: n.role,
        text: n.text,
        locked: n.locked,
        zIndex: i,
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

  async apply(ctx: RequestContext, request: ApplyOperationsRequest): Promise<Result<StudioDocumentRef, AppError>> {
    if (this.failureMode === 'stale_revision') {
      return {
        ok: false,
        error: {
          code: 'STALE_REVISION_CONFLICT',
          message: 'Expected revision hash does not match current studio state',
          retryable: false,
          safeAction: 'Reload document and rebase operations',
        },
      };
    }

    const doc = this.documents.get(request.document.documentId);
    if (!doc) {
      return {
        ok: false,
        error: {
          code: 'DOCUMENT_NOT_FOUND',
          message: `Document ${request.document.documentId} not found in studio`,
          retryable: false,
          safeAction: 'Re-create document from brief',
        },
      };
    }

    if (request.expectedSourceSha256 !== doc.ref.sourceSha256) {
      return {
        ok: false,
        error: {
          code: 'EXPECTED_SHA_MISMATCH',
          message: `Expected sha ${request.expectedSourceSha256} does not match current ${doc.ref.sourceSha256}`,
          retryable: false,
          safeAction: 'Rebase pending operations on latest document revision',
        },
      };
    }

    // Apply operations
    for (const op of request.operations) {
      if (op.op === 'addText') {
        const page = doc.content.pages.find((p) => p.id === op.pageId) || doc.content.pages[0];
        if (page) {
          page.nodes.push({
            id: op.nodeId,
            type: 'text',
            role: op.role,
            text: op.text,
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            style: op.style,
            locked: Boolean(op.locked),
          });
        }
      } else if (op.op === 'replaceText') {
        for (const p of doc.content.pages) {
          const node = p.nodes.find((n) => n.id === op.nodeId);
          if (node) {
            node.text = op.text;
          }
        }
      } else if (op.op === 'addImage') {
        const page = doc.content.pages.find((p) => p.id === op.pageId) || doc.content.pages[0];
        if (page) {
          page.nodes.push({
            id: op.nodeId,
            type: 'image',
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            locked: Boolean(op.locked),
            assetSha256: op.asset.sha256,
          });
        }
      }
    }

    const newRevision = doc.ref.sourceRevision + 1;
    const newHash = this.computeHash(doc.content);
    doc.ref = {
      ...doc.ref,
      sourceRevision: newRevision,
      sourceSha256: newHash,
    };

    return { ok: true, value: doc.ref };
  }

  async render(_ctx: RequestContext, request: RenderRequest): Promise<Result<RenderedOutput[]>> {
    if (this.failureMode === 'render_timeout') {
      throw new Error('Fake render worker timeout');
    }

    const output: RenderedOutput = {
      format: request.format,
      storageKey: `renders/${request.document.documentId}/${request.format}/rev-${request.document.sourceRevision}.${request.format}`,
      sha256: `render_hash_${request.document.sourceSha256}`,
      byteSize: 2048,
      width: 1080,
      height: 1080,
      warnings: [],
    };

    return { ok: true, value: [output] };
  }

  async verifyRoundTrip(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<{ pass: boolean; beforeHash: SHA256; afterHash: SHA256; semanticDiff: Record<string, unknown> }>> {
    const doc = this.documents.get(document.documentId);
    const hash = doc ? doc.ref.sourceSha256 : document.sourceSha256;
    return {
      ok: true,
      value: {
        pass: true,
        beforeHash: hash,
        afterHash: hash,
        semanticDiff: {},
      },
    };
  }

  async getEditorUrl(_ctx: RequestContext, document: StudioDocumentRef, mode: 'edit' | 'review'): Promise<Result<{ url: string; expiresAt: string }>> {
    const baseUrl = process.env.HAWA_STUDIO_URL || 'http://localhost:4173/review';
    return {
      ok: true,
      value: {
        url: `${baseUrl}?doc=${document.documentId}&mode=${mode}&rev=${document.sourceRevision}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    };
  }
}
