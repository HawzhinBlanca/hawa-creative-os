import crypto from 'node:crypto';
import type {
  AppError,
  ApplyOperationsRequest,
  BuzzFieldMapping,
  CapabilityReport,
  CreateDocumentRequest,
  DesignStudioAdapter,
  FigmaBridge,
  FigmaCommand,
  FigmaLease,
  FigmaMutationResult,
  FigmaNodeSnapshot,
  ISODateTime,
  JsonObject,
  NeutralManifest,
  RenderedOutput,
  RenderRequest,
  RequestContext,
  Result,
  SHA256,
  SourceArtifact,
  StudioDocumentRef,
  UUID,
} from '@hawa/contracts';

export class FakeFigmaBridge implements FigmaBridge, DesignStudioAdapter {
  public leases = new Map<string, FigmaLease>();
  public taskLeases = new Map<string, string>(); // taskId -> leaseId
  public stagedDocuments = new Map<string, {
    fileKey: string;
    stagingNodeId: string;
    revision: number;
    nodes: Array<{ id: string; name: string; type: string; text?: string; font?: string; x: number; y: number }>;
  }>();

  public simulateLeaseConflict = false;
  public simulateStaleRevision = false;
  public simulateFontMissing = false;

  private computeHash(val: unknown): SHA256 {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    return `sha256_${crypto.createHash('sha256').update(str).digest('hex')}` as SHA256;
  }

  async acquireLease(ctx: RequestContext, fileKey: string, ttlSeconds: number): Promise<Result<FigmaLease>> {
    if (this.simulateLeaseConflict) {
      return {
        ok: false,
        error: {
          code: 'LEASE_ALREADY_HELD',
          message: 'Simulated lease conflict: another agent is currently holding the write lease',
          retryable: false,
          safeAction: 'Wait for existing lease to expire',
        },
      };
    }

    const taskId = ctx.taskId || crypto.randomUUID();
    const existingLeaseId = this.taskLeases.get(taskId);
    if (existingLeaseId) {
      const active = this.leases.get(existingLeaseId);
      if (active && !active.releasedAt && new Date(active.expiresAt) > new Date()) {
        if (active.holder === ctx.actor.id) {
          active.expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
          return { ok: true, value: { ...active } };
        }
        return {
          ok: false,
          error: {
            code: 'LEASE_ALREADY_HELD',
            message: `Task ${taskId} is currently leased to ${active.holder}`,
            retryable: false,
            safeAction: 'Wait for lease release',
          },
        };
      }
    }

    const lease: FigmaLease = {
      id: crypto.randomUUID(),
      taskId,
      clientId: ctx.clientId || crypto.randomUUID(),
      fileKey,
      holder: ctx.actor.id,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };

    this.leases.set(lease.id, lease);
    this.taskLeases.set(taskId, lease.id);
    return { ok: true, value: { ...lease } };
  }

  async releaseLease(_ctx: RequestContext, leaseId: UUID): Promise<Result<void>> {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return {
        ok: false,
        error: { code: 'LEASE_NOT_FOUND', message: 'Lease does not exist', retryable: false, safeAction: 'Verify lease ID' },
      };
    }
    lease.releasedAt = new Date().toISOString();
    return { ok: true, value: undefined };
  }

  async inspect(_ctx: RequestContext, fileKey: string, nodeId?: string): Promise<Result<FigmaNodeSnapshot | JsonObject>> {
    const doc = this.stagedDocuments.get(fileKey);
    return {
      ok: true,
      value: {
        id: nodeId || '30_AI_STAGING',
        name: '30_AI_STAGING',
        type: 'FRAME',
        visible: true,
        children: doc ? doc.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, characters: n.text })) : [],
      },
    };
  }

  async mutate(_ctx: RequestContext, command: FigmaCommand): Promise<Result<FigmaMutationResult, AppError>> {
    const lease = this.leases.get(command.leaseId);
    if (!lease || lease.releasedAt || new Date(lease.expiresAt) <= new Date()) {
      return {
        ok: false,
        error: {
          code: 'LEASE_EXPIRED_OR_INVALID',
          message: `Lease ${command.leaseId} is expired or invalid`,
          retryable: false,
          safeAction: 'Re-acquire lease',
        },
      };
    }

    if (lease.fileKey !== command.fileKey) {
      return {
        ok: false,
        error: {
          code: 'WRONG_FILE_FOR_LEASE',
          message: `Lease ${command.leaseId} was issued for file ${lease.fileKey}, but command targeted ${command.fileKey}`,
          retryable: false,
          safeAction: 'Target the leased file or acquire a lease for target file',
        },
      };
    }

    if (lease.clientId !== command.clientId) {
      return {
        ok: false,
        error: {
          code: 'CROSS_CLIENT_VIOLATION',
          message: `Lease client ${lease.clientId} does not match command client ${command.clientId}`,
          retryable: false,
          safeAction: 'Verify tenant scope locking',
        },
      };
    }

    if (command.targetNodeId && (
      command.targetNodeId.startsWith('00_') ||
      command.targetNodeId.startsWith('master_') ||
      command.targetNodeId === 'PAGE_ROOT' ||
      command.targetNodeId.toLowerCase().includes('master_library')
    )) {
      return {
        ok: false,
        error: {
          code: 'STAGING_CONFINEMENT_VIOLATION',
          message: `Operation rejected: mutations must be strictly confined to 30_AI_STAGING. Target '${command.targetNodeId}' violates master library isolation`,
          retryable: false,
          safeAction: 'Confine all AI mutations to 30_AI_STAGING container',
        },
      };
    }

    let doc = this.stagedDocuments.get(command.fileKey);
    if (!doc) {
      doc = {
        fileKey: command.fileKey,
        stagingNodeId: 'node_staging_root',
        revision: 0,
        nodes: [],
      };
      this.stagedDocuments.set(command.fileKey, doc);
    }

    if (this.simulateStaleRevision || command.expectedRevision !== doc.revision) {
      return {
        ok: false,
        error: {
          code: 'STALE_REVISION_CONFLICT',
          message: `Expected revision ${command.expectedRevision} but found ${doc.revision}`,
          retryable: false,
          safeAction: 'Rebase mutations on current document revision',
          detail: { currentRevision: doc.revision },
        },
      };
    }

    if (this.simulateFontMissing) {
      return {
        ok: false,
        error: {
          code: 'FONT_NOT_AVAILABLE',
          message: 'Requested font family is not installed in the Figma environment',
          retryable: false,
          safeAction: 'Install font or select an approved substitute',
        },
      };
    }

    const affectedNodeIds: string[] = [];
    if (command.operation === 'set_buzz_text_fields') {
      const fields = (command.args.fields || {}) as Record<string, string>;
      for (const [k, v] of Object.entries(fields)) {
        const id = `node_${k}`;
        doc.nodes.push({ id, name: k, type: 'TEXT', text: v, font: 'Cairo', x: 0, y: 0 });
        affectedNodeIds.push(id);
      }
    } else if (command.operation === 'create_text' || command.operation === 'replace_text') {
      const id = command.targetNodeId || `node_text_${crypto.randomUUID().slice(0, 6)}`;
      doc.nodes.push({
        id,
        name: 'Text',
        type: 'TEXT',
        text: String(command.args.text || ''),
        font: String(command.args.font || 'Cairo'),
        x: 0,
        y: 0,
      });
      affectedNodeIds.push(id);
    }

    doc.revision += 1;
    return {
      ok: true,
      value: {
        revision: doc.revision,
        affectedNodeIds,
        markerId: `marker_${doc.revision}`,
        previewUrl: `https://www.figma.com/design/${command.fileKey}?node-id=${doc.stagingNodeId}`,
      },
    };
  }

  async renderPreview(_ctx: RequestContext, _fileKey: string, _nodeId: string): Promise<Result<{ buffer: Uint8Array; mimeType: string; width: number; height: number }>> {
    return {
      ok: true,
      value: {
        buffer: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        mimeType: 'image/png',
        width: 1080,
        height: 1080,
      },
    };
  }

  async exportNode(_ctx: RequestContext, _fileKey: string, _nodeId: string, format: 'PNG' | 'JPG' | 'PDF' | 'SVG'): Promise<Result<{ buffer: Uint8Array; format: string; byteSize: number }>> {
    const raw = new Uint8Array([137, 80, 78, 71]);
    return {
      ok: true,
      value: {
        buffer: raw,
        format,
        byteSize: raw.byteLength,
      },
    };
  }

  async createBuzzAsset(_ctx: RequestContext, templateId: string, fields: BuzzFieldMapping): Promise<Result<{ nodeId: string; previewUrl?: string }>> {
    const stagingNodeId = `buzz_staging_${crypto.randomUUID().slice(0, 8)}`;
    return {
      ok: true,
      value: {
        nodeId: stagingNodeId,
        previewUrl: `https://www.figma.com/design/figma_buzz_file?node-id=${stagingNodeId}`,
      },
    };
  }

  async smartResizeBuzz(_ctx: RequestContext, nodeId: string, targetAspect: '1:1' | '4:5' | '9:16' | '16:9'): Promise<Result<{ resizedNodeId: string }>> {
    return {
      ok: true,
      value: {
        resizedNodeId: `${nodeId}_${targetAspect.replace(':', 'x')}`,
      },
    };
  }

  // --- DesignStudioAdapter ---

  async capabilities(_ctx: RequestContext): Promise<Result<CapabilityReport>> {
    return {
      ok: true,
      value: {
        name: 'FakeFigmaBridge',
        version: '2.0.0',
        healthy: true,
        capabilities: { figmaDesign: true, figmaBuzz: true, taskLeases: true, stagingIsolation: true },
        limits: {},
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async create(ctx: RequestContext, request: CreateDocumentRequest): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const fileKey = 'figma_kaae_master_library';
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `staging_${documentId.slice(0, 8)}`,
      sourceRevision: 1,
      sourceSha256: this.computeHash(request.name),
      studio: 'Figma Design',
      studioVersion: '2.0.0',
      schemaVersion: '2.0.0',
    };
    return { ok: true, value: ref };
  }

  async import(_ctx: RequestContext, source: SourceArtifact): Promise<Result<StudioDocumentRef>> {
    const documentId = crypto.randomUUID();
    const ref: StudioDocumentRef = {
      documentId,
      studioDocumentId: `imp_${documentId.slice(0, 8)}`,
      sourceRevision: 1,
      sourceSha256: source.sha256,
      studio: 'Figma Design',
      studioVersion: '2.0.0',
      schemaVersion: '2.0.0',
    };
    return { ok: true, value: ref };
  }

  async exportSource(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<SourceArtifact>> {
    return {
      ok: true,
      value: {
        storageKey: `figma/export/${document.documentId}.json`,
        sha256: document.sourceSha256,
        byteSize: 2048,
        studioSchemaVersion: '2.0.0',
      },
    };
  }

  async getManifest(_ctx: RequestContext, _document: StudioDocumentRef): Promise<Result<NeutralManifest>> {
    return {
      ok: true,
      value: {
        pages: [{ id: 'p1', name: '30_AI_STAGING', width: 1080, height: 1080, unit: 'px', direction: 'rtl' }],
        nodes: [],
        fonts: [{ family: 'Cairo', style: 'Bold' }],
        assets: [],
        warnings: [],
      },
    };
  }

  async apply(_ctx: RequestContext, request: ApplyOperationsRequest): Promise<Result<StudioDocumentRef, AppError>> {
    const newRev = request.document.sourceRevision + 1;
    const ref: StudioDocumentRef = {
      ...request.document,
      sourceRevision: newRev,
      sourceSha256: this.computeHash(`rev_${newRev}`),
    };
    return { ok: true, value: ref };
  }

  async render(_ctx: RequestContext, request: RenderRequest): Promise<Result<RenderedOutput[]>> {
    return {
      ok: true,
      value: [{
        format: request.format,
        storageKey: `renders/${request.document.documentId}.${request.format}`,
        sha256: this.computeHash('render'),
        byteSize: 1024,
        width: 1080,
        height: 1080,
        warnings: [],
      }],
    };
  }

  async verifyRoundTrip(_ctx: RequestContext, document: StudioDocumentRef): Promise<Result<{ pass: boolean; beforeHash: SHA256; afterHash: SHA256; semanticDiff: Record<string, unknown> }>> {
    return {
      ok: true,
      value: {
        pass: true,
        beforeHash: document.sourceSha256,
        afterHash: document.sourceSha256,
        semanticDiff: {},
      },
    };
  }

  async getEditorUrl(_ctx: RequestContext, document: StudioDocumentRef, mode: 'edit' | 'review'): Promise<Result<{ url: string; expiresAt: string }>> {
    return {
      ok: true,
      value: {
        url: `https://www.figma.com/design/figma_kaae_master?node-id=${document.studioDocumentId}&mode=${mode}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    };
  }
}
