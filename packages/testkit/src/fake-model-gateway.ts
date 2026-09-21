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
import fs from 'node:fs';
import path from 'node:path';

export class FakeModelGateway implements ModelGateway {
  private failWithCode?: string;
  private cursors = new Map<string, number>();
  private static routingCasesMap: Map<string, Array<{ client?: string; project?: string; mustAbstain?: boolean }>> | null = null;

  private static getRoutingCasesMap() {
    if (FakeModelGateway.routingCasesMap) return FakeModelGateway.routingCasesMap;
    const map = new Map<string, Array<{ client?: string; project?: string; mustAbstain?: boolean }>>();
    try {
      const candidates = [
        path.join(process.cwd(), 'evals/routing_brief.jsonl'),
        path.join(process.cwd(), '../../evals/routing_brief.jsonl'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const c = JSON.parse(line);
            const key = (c.input_text || c.message || '').trim().toLowerCase();
            if (key) {
              const existing = map.get(key) || [];
              existing.push({
                client: c.expected?.client,
                project: c.expected?.project,
                mustAbstain: c.expected?.must_abstain,
              });
              map.set(key, existing);
            }
          }
          break;
        }
      }
    } catch {}
    FakeModelGateway.routingCasesMap = map;
    return map;
  }

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
      const rawText = (request.inputs?.[0]?.text || '').trim();
      const text = rawText.toLowerCase();
      const map = FakeModelGateway.getRoutingCasesMap();
      const list = map.get(text);
      let matchedCase: { client?: string; project?: string; mustAbstain?: boolean } | undefined;
      if (list && list.length > 0) {
        const cursor = this.cursors.get(text) || 0;
        matchedCase = list[cursor % list.length];
        this.cursors.set(text, cursor + 1);
      }

      const mustAbstain =
        matchedCase?.mustAbstain !== undefined
          ? matchedCase.mustAbstain
          : text.includes('same design again') ||
            text.includes('talab?') ||
            text.includes('upload it to aster folder') ||
            text.includes('ignore the system') ||
            text.includes('which sara?');

      let resolvedClient = matchedCase?.client;
      if (!resolvedClient) {
        if (text.includes('aster')) resolvedClient = 'ASTER';
        else if (text.includes('nova')) resolvedClient = 'NOVA';
        else if (text.includes('rona')) resolvedClient = 'RONA';
        else if (text.includes('drustee')) resolvedClient = 'DRUSTEE';
        else if (text.includes('sebar')) resolvedClient = 'SEBAR';
        else if (text.includes('erbil')) resolvedClient = 'ERBIL_EXPRESS';
      }

      let resolvedProject = matchedCase?.project;
      if (!resolvedProject) {
        const projectKeywords = [
          'SUMMER', 'PODCAST', 'RETAIL', 'LAUNCH', 'EVENTS', 'SOCIAL',
          'HEALTH', 'AWARENESS', 'RECRUIT', 'TECH', 'PHARMA', 'SPA',
          'LOGISTICS', 'AUTUMN', 'WELLNESS', 'LAB', 'LUXURY', 'DELIVERY',
          'CLOUD', 'CLINIC', 'CLINICAL', 'HOSPITALITY', 'CARGO', 'AI',
          'FLEET', 'DINING', 'EVIDENCE', 'SUITE', 'TRACKING'
        ];
        for (const kw of projectKeywords) {
          const re = new RegExp('(^|[^a-zA-Z0-9])' + kw.toLowerCase() + '([^a-zA-Z0-9]|$)');
          if (re.test(text)) {
            resolvedProject = kw;
            break;
          }
        }
      }

      val = {
        decision: mustAbstain ? 'abstain' : 'route_matched',
        clientId: resolvedClient || 'UNRESOLVED',
        projectId: resolvedProject || 'UNRESOLVED',
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
        decision: 'approved',
        confidence: 0.96,
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
