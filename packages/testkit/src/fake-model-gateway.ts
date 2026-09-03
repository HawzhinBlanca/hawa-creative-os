import type {
  ModelGateway,
  ModelRole,
  ModelDeploymentRef,
  RequestContext,
  Result,
  StructuredModelRequest,
  StructuredModelResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
  AppError,
  JsonObject,
} from '@hawa/contracts';

export class FakeModelGateway implements ModelGateway {
  private failWithCode?: string;

  setFailure(code?: string) {
    this.failWithCode = code;
  }

  async resolve(_ctx: RequestContext, role: ModelRole, _constraints?: JsonObject): Promise<Result<ModelDeploymentRef>> {
    const deploymentId = crypto.randomUUID();
    const map: Record<ModelRole, { provider: string; model: string }> = {
      intake_router: { provider: 'google', model: 'gemini-3.8-flash' },
      brief_builder: { provider: 'google', model: 'gemini-3.8-flash' },
      creative_director: { provider: 'openai', model: 'gpt-5.6-sol' },
      visual_judge: { provider: 'anthropic', model: 'claude-opus-5' },
      feedback_classifier: { provider: 'google', model: 'gemini-3.8-flash' },
      rule_miner: { provider: 'openai', model: 'gpt-5.6-sol' },
      embedding_multimodal: { provider: 'local', model: 'qwen3-vl-embedding-2b' },
      reranker_multimodal: { provider: 'local', model: 'qwen3-vl-reranker-2b' },
    };

    const target = map[role] || { provider: 'local', model: 'default' };
    return {
      ok: true,
      value: {
        deploymentId,
        role,
        provider: target.provider,
        exactModelId: target.model,
        deploymentVersion: '2026-09-03',
      },
    };
  }

  async generateStructured<T>(_ctx: RequestContext, request: StructuredModelRequest): Promise<Result<StructuredModelResponse<T>, AppError>> {
    if (this.failWithCode) {
      return {
        ok: false,
        error: {
          code: this.failWithCode,
          message: `Injected model failure ${this.failWithCode}`,
          retryable: this.failWithCode === 'RATE_LIMIT_429' || this.failWithCode === 'TIMEOUT',
          safeAction: 'Retry or fallback to secondary model provider',
        },
      };
    }

    const resolved = await this.resolve(_ctx, request.role);
    if (!resolved.ok) {
      return {
        ok: false,
        error: { code: 'DEPLOYMENT_RESOLUTION_FAILED', message: 'Failed to resolve model', retryable: false, safeAction: 'Check registry' },
      };
    }

    let val: unknown;
    if (request.role === 'intake_router') {
      val = {
        decision: 'route_matched',
        clientId: 'client-office-1',
        projectId: 'project-campaign-2026',
        confidence: 0.96,
        reasoning: 'Matches known client channel and brand keywords',
      };
    } else if (request.role === 'brief_builder') {
      val = {
        objective: 'Promotional graphic for social media',
        taskRoute: 'template_fill',
        primaryLanguage: 'ckb',
        direction: 'rtl',
        variants: [{ id: 'v1', name: 'square', width: 1080, height: 1080, aspectRatio: '1:1', role: 'instagram_post' }],
        exactCopy: [{ id: 'ec1', role: 'headline', text: 'داشکاندنی بەهارە', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] }],
        missingFacts: [],
        requiredAssetRoles: ['logo_primary'],
      };
    } else if (request.role === 'creative_director') {
      val = {
        topology: 'slot_matrix',
        rationale: 'Clean geometric slot layout highlighting product subject and Sorani typography',
        zones: [
          { id: 'z1', name: 'hero', x: 0, y: 0, width: 1080, height: 700, allowedRoles: ['subject_cutout', 'background'], safeMarginPx: 40, zIndex: 1 },
          { id: 'z2', name: 'copy', x: 40, y: 740, width: 1000, height: 300, allowedRoles: ['headline', 'cta'], safeMarginPx: 20, zIndex: 2 },
        ],
        ingredients: [
          { id: 'i1', role: 'background', sourceType: 'vector_shape', targetWidth: 1080, targetHeight: 1080, transparentBackground: false },
          { id: 'i2', role: 'official_logo', sourceType: 'official_asset', targetWidth: 200, targetHeight: 80, transparentBackground: true },
        ],
      };
    } else if (request.role === 'visual_judge') {
      val = {
        passed: true,
        rubricScores: {
          hierarchy: 9.5,
          legibility: 10.0,
          balance: 9.0,
          artifacts: 0.0,
          brandResemblance: 9.8,
          culturalAppropriateness: 10.0,
        },
        findings: [],
        overallScore: 9.6,
      };
    } else {
      val = { status: 'ok' };
    }

    return {
      ok: true,
      value: {
        deployment: resolved.value,
        value: val as T,
        responseHash: `resp_hash_${request.role}`,
        invocationId: crypto.randomUUID(),
        usage: { inputTokens: 450, outputTokens: 120, estimatedCostUsd: 0.001 },
        latencyMs: 340,
        attempts: 1,
        completedAt: new Date().toISOString(),
      },
    };
  }

  async embed(_ctx: RequestContext, request: EmbeddingRequest): Promise<Result<EmbeddingResponse>> {
    const resolved = await this.resolve(_ctx, 'embedding_multimodal');
    const dims = request.dimensions || 1024;
    return {
      ok: true,
      value: {
        deployment: (resolved as { ok: true; value: ModelDeploymentRef }).value,
        dimensions: dims,
        vectors: request.items.map((item) => ({
          id: item.id,
          vector: new Array(dims).fill(0.01),
        })),
        invocationId: crypto.randomUUID(),
        latencyMs: 120,
      },
    };
  }

  async rerank(_ctx: RequestContext, request: RerankRequest): Promise<Result<RerankResponse>> {
    const resolved = await this.resolve(_ctx, 'reranker_multimodal');
    return {
      ok: true,
      value: {
        deployment: (resolved as { ok: true; value: ModelDeploymentRef }).value,
        ranked: request.candidates.map((c, index) => ({
          id: c.id,
          score: 1.0 - index * 0.1,
          rank: index + 1,
        })),
        invocationId: crypto.randomUUID(),
        latencyMs: 85,
      },
    };
  }
}
