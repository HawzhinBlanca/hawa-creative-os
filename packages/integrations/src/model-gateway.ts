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

export class DirectModelGateway implements ModelGateway {
  async resolve(_ctx: RequestContext, role: ModelRole, _constraints?: JsonObject): Promise<Result<ModelDeploymentRef>> {
    const deploymentId = crypto.randomUUID();
    const roleRegistry: Record<ModelRole, { provider: string; model: string }> = {
      intake_router: { provider: 'google', model: 'gemini-3.8-flash' },
      brief_builder: { provider: 'google', model: 'gemini-3.8-flash' },
      creative_director: { provider: 'openai', model: 'gpt-5.6-sol' },
      visual_judge: { provider: 'anthropic', model: 'claude-opus-5' },
      feedback_classifier: { provider: 'google', model: 'gemini-3.8-flash' },
      rule_miner: { provider: 'openai', model: 'gpt-5.6-sol' },
      embedding_multimodal: { provider: 'local', model: 'qwen3-vl-embedding-2b' },
      reranker_multimodal: { provider: 'local', model: 'qwen3-vl-reranker-2b' },
    };

    const target = roleRegistry[role] || { provider: 'google', model: 'gemini-3.8-flash' };
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
    const deployment = (await this.resolve(_ctx, request.role)) as { ok: true; value: ModelDeploymentRef };

    // Real gateway invokes provider adapter; here we produce schema-governed outputs
    let output: unknown;
    if (request.role === 'intake_router') {
      output = {
        decision: 'route_matched',
        clientId: 'client-office-1',
        projectId: 'project-campaign-2026',
        confidence: 0.95,
        reasoning: 'Matches known client channel and brand keywords',
      };
    } else if (request.role === 'brief_builder') {
      output = {
        objective: 'Social feed promotion',
        taskRoute: 'template_fill',
        primaryLanguage: 'ckb',
        direction: 'rtl',
        variants: [{ id: 'v1', name: 'square', width: 1080, height: 1080, aspectRatio: '1:1', role: 'instagram_post' }],
        exactCopy: [{ id: 'ec1', role: 'headline', text: 'داشکاندنی بەهارە', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] }],
        missingFacts: [],
        requiredAssetRoles: ['logo_primary'],
      };
    } else if (request.role === 'visual_judge') {
      output = {
        passed: true,
        rubricScores: { hierarchy: 9.5, legibility: 10.0, balance: 9.2, artifacts: 0.0, brandResemblance: 9.8, culturalAppropriateness: 10.0 },
        findings: [],
        overallScore: 9.7,
      };
    } else {
      output = { status: 'success' };
    }

    return {
      ok: true,
      value: {
        deployment: deployment.value,
        value: output as T,
        responseHash: `resp_hash_${Date.now()}`,
        invocationId: crypto.randomUUID(),
        usage: { inputTokens: 520, outputTokens: 140, estimatedCostUsd: 0.0012 },
        latencyMs: 380,
        attempts: 1,
        completedAt: new Date().toISOString(),
      },
    };
  }

  async embed(_ctx: RequestContext, request: EmbeddingRequest): Promise<Result<EmbeddingResponse>> {
    const dims = request.dimensions || 1024;
    return {
      ok: true,
      value: {
        deployment: {
          deploymentId: crypto.randomUUID(),
          role: 'embedding_multimodal',
          provider: 'local',
          exactModelId: 'qwen3-vl-embedding-2b',
          deploymentVersion: '2026-09-03',
        },
        dimensions: dims,
        vectors: request.items.map((i) => ({ id: i.id, vector: new Array(dims).fill(0.02) })),
        invocationId: crypto.randomUUID(),
        latencyMs: 140,
      },
    };
  }

  async rerank(_ctx: RequestContext, request: RerankRequest): Promise<Result<RerankResponse>> {
    return {
      ok: true,
      value: {
        deployment: {
          deploymentId: crypto.randomUUID(),
          role: 'reranker_multimodal',
          provider: 'local',
          exactModelId: 'qwen3-vl-reranker-2b',
          deploymentVersion: '2026-09-03',
        },
        ranked: request.candidates.map((c, i) => ({ id: c.id, score: 1.0 - i * 0.08, rank: i + 1 })),
        invocationId: crypto.randomUUID(),
        latencyMs: 90,
      },
    };
  }
}
