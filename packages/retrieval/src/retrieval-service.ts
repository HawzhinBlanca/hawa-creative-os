import crypto from 'node:crypto';
import type {
  RetrievalProvider,
  RetrievalIntent,
  RetrievalCandidate,
  ContextPack,
  RequestContext,
  Result,
  AppError,
  UUID,
} from '@hawa/contracts';
import type { ClientDNA } from '@hawa/domain';
import { extractSearchTokens, normalizeSearchToken } from './search-engine.js';

export interface StoredKnowledgeItem {
  id: UUID;
  tenantId: UUID;
  clientId: UUID;
  projectId?: UUID;
  kind: RetrievalIntent['kinds'][number];
  sourceId: string;
  title: string;
  text: string;
  polarity: 'positive' | 'negative' | 'neutral';
  approved: boolean;
  active: boolean;
  metadata: Record<string, unknown>;
}

export class RetrievalService implements RetrievalProvider {
  private knowledgeStore: StoredKnowledgeItem[] = [];

  addKnowledgeItem(item: StoredKnowledgeItem) {
    if (!item.tenantId || !item.clientId || !item.sourceId) {
      throw new Error('Knowledge needs tenant, client and source identity before indexing.');
    }
    this.knowledgeStore.push(item);
  }

  clear() {
    this.knowledgeStore = [];
  }

  count(): number {
    return this.knowledgeStore.length;
  }

  /**
   * Indexes a caller-supplied active DNA snapshot. This in-memory baseline does not verify a
   * human approval signature; callers must not present it as an authorized production corpus.
   */
  indexClientDna(dna: ClientDNA) {
    if (dna.status !== 'active') throw new Error('Only an active Client DNA snapshot can be indexed.');
    const dnaHash = crypto.createHash('sha256').update(JSON.stringify(dna)).digest('hex');
    if (this.knowledgeStore.some((item) => item.tenantId === dna.tenantId && item.clientId === dna.clientId &&
        item.active && item.metadata?.dnaHash === dnaHash)) return;
    for (const item of this.knowledgeStore) {
      if (item.tenantId === dna.tenantId && item.clientId === dna.clientId && item.metadata?.dnaVersion) item.active = false;
    }
    const stableId = (sourceId: string) => crypto.createHash('sha256')
      .update(JSON.stringify([dna.tenantId, dna.clientId, dna.version, sourceId])).digest('hex');
    // 1. Index official approved assets
    for (const asset of dna.assets) {
      this.addKnowledgeItem({
        id: asset.assetId,
        tenantId: dna.tenantId,
        clientId: dna.clientId,
        kind: 'official_asset',
        sourceId: asset.storageKey,
        title: asset.name,
        text: `${asset.name} (${asset.role}) sha256:${asset.sha256} mime:${asset.mimeType}`,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: {
          role: asset.role,
          dnaVersion: dna.version,
          dnaHash,
          sha256: asset.sha256,
          storageKey: asset.storageKey,
          mimeType: asset.mimeType,
          clearSpacePx: asset.clearSpacePx,
          minimumWidthPx: asset.minimumWidthPx,
          allowedBackgrounds: asset.allowedBackgrounds,
          prohibitedModifications: asset.prohibitedModifications,
        },
      });
    }

    // 2. Index layout rules & guidelines
    for (const [idx, rule] of dna.guidelines.layoutRules.entries()) {
      const sourceId = `rule_${dna.code}_layout_${idx + 1}`;
      this.addKnowledgeItem({
        id: stableId(sourceId),
        tenantId: dna.tenantId,
        clientId: dna.clientId,
        kind: 'rule',
        sourceId,
        title: `${dna.code} Layout Rule ${idx + 1}`,
        text: rule,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: { category: 'layout', dnaVersion: dna.version, dnaHash },
      });
    }

    // 3. Index required disclaimers
    for (const [idx, disclaimer] of dna.guidelines.requiredDisclaimers.entries()) {
      const sourceId = `rule_${dna.code}_disclaimer_${idx + 1}`;
      this.addKnowledgeItem({
        id: stableId(sourceId),
        tenantId: dna.tenantId,
        clientId: dna.clientId,
        kind: 'rule',
        sourceId,
        title: `${dna.code} Statutory Disclaimer ${idx + 1}`,
        text: disclaimer,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: { category: 'disclaimer', dnaVersion: dna.version, dnaHash },
      });
    }

    // 4. Index prohibited phrases as negative evidence
    for (const phrase of dna.guidelines.prohibitedPhrases) {
      const sourceId = `rule_${dna.code}_prohibited_${phrase}`;
      this.addKnowledgeItem({
        id: stableId(sourceId),
        tenantId: dna.tenantId,
        clientId: dna.clientId,
        kind: 'rule',
        sourceId,
        title: `Prohibited: ${phrase}`,
        text: phrase,
        polarity: 'negative',
        approved: true,
        active: true,
        metadata: { prohibited: true, phrase, dnaVersion: dna.version, dnaHash },
      });
    }

    // 5. Index Canva Team & Brand Kit mapping
    if (dna.canvaMapping) {
      const sourceId = `canva_mapping_${dna.code}`;
      this.addKnowledgeItem({
        id: stableId(sourceId),
        tenantId: dna.tenantId,
        clientId: dna.clientId,
        kind: 'rule',
        sourceId,
        title: `${dna.code} Canva Team and Brand Kit Mapping`,
        text: `Canva Team ID: ${dna.canvaMapping.canvaTeamId}, Brand Kit ID: ${dna.canvaMapping.canvaBrandKitId}`,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: {
          canvaTeamId: dna.canvaMapping.canvaTeamId,
          dnaVersion: dna.version,
          dnaHash,
          canvaBrandKitId: dna.canvaMapping.canvaBrandKitId,
          canvaTemplateIds: dna.canvaMapping.canvaTemplateIds,
          verifiedAt: dna.canvaMapping.verifiedAt,
        },
      });
    }
  }

  async retrieve(
    ctx: RequestContext & { clientId: UUID },
    intents: RetrievalIntent[]
  ): Promise<Result<ContextPack, AppError>> {
    // Scope and lifecycle are checked before even lexical ranking. This in-memory service is a
    // deterministic baseline; it has no embedding or reranker and must never claim their scores.
    const clientPool = this.knowledgeStore.filter(
      (item) => item.tenantId === ctx.tenantId && item.clientId === ctx.clientId && item.active
    );

    const evidence: RetrievalCandidate[] = [];
    const negativeEvidence: RetrievalCandidate[] = [];
    const unresolvedConflicts: ContextPack['unresolvedConflicts'] = [];

    // Check for prohibited phrases in intent queries
    const prohibitedRules = clientPool.filter(
      (item) => item.kind === 'rule' && item.approved && item.metadata?.prohibited === true
    );

    for (const intent of intents) {
      const qLower = normalizeSearchToken(intent.query);
      for (const p of prohibitedRules) {
        if (p.text && qLower.includes(normalizeSearchToken(p.text))) {
          unresolvedConflicts.push({
            id: crypto.randomUUID(),
            conflictType: 'PROHIBITED_LEXICON_VIOLATION',
            type: 'PROHIBITED_LEXICON_VIOLATION',
            sourceIds: [p.sourceId],
            message: `Query violates client prohibited guidelines: contains "${p.text}"`,
            severity: 'BLOCKING',
            description: `Query violates client prohibited guidelines: contains "${p.text}"`,
            safeAction: 'Remove prohibited phrase or seek client exception',
          });
        }
      }

      // If intent specifically asks for official_asset, check if client has assets
      if (intent.kinds.includes('official_asset')) {
        const availableAssets = clientPool.filter((item) => item.kind === 'official_asset' && item.approved);
        if (availableAssets.length === 0) {
          unresolvedConflicts.push({
            id: crypto.randomUUID(),
            conflictType: 'MISSING_BRAND_ASSET',
            type: 'MISSING_BRAND_ASSET',
            sourceIds: [],
            message: `No approved official assets exist for client ${ctx.clientId}. Cannot invent substitute branding.`,
            severity: 'BLOCKING',
            description: `No approved official assets exist for client ${ctx.clientId}. Cannot invent substitute branding.`,
            safeAction: 'Upload official vector logo/assets before generation',
          });
        }
      }

      const matchingItems = clientPool.filter((item) => {
        if (!intent.kinds.includes(item.kind)) return false;
        if (ctx.projectId && item.projectId && item.projectId !== ctx.projectId) return false;
        if (item.polarity !== 'negative' && !item.approved) return false;
        return true;
      });

      const queryWords = extractSearchTokens(intent.query);
      const ranked: Array<{ item: StoredKnowledgeItem; score: number }> = [];
      for (const item of matchingItems) {
        let score = 0;
        const lower = normalizeSearchToken(`${item.title} ${item.text}`);
        for (const w of queryWords) {
          if (lower.includes(w)) score += 1;
        }
        if (qLower && lower.includes(qLower)) score += 2;
        if (score > 0) ranked.push({ item, score });
      }
      ranked.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
      const limit = Math.max(1, Math.min(intent.topK ?? 10, 10));
      for (const { item, score } of ranked.slice(0, limit)) {
        const candidate: RetrievalCandidate = {
          id: item.id,
          clientId: item.clientId,
          projectId: item.projectId,
          kind: item.kind,
          sourceId: item.sourceId,
          title: item.title,
          text: item.text,
          metadata: item.metadata,
          lexicalScore: score,
          approved: item.approved,
          polarity: item.polarity,
          active: item.active,
        };

        if (item.polarity === 'negative') {
          negativeEvidence.push(candidate);
        } else {
          evidence.push(candidate);
        }
      }
    }

    const pack: ContextPack = {
      clientId: ctx.clientId,
      projectId: ctx.projectId,
      clientDnaVersion: Math.max(0, ...clientPool.map((item) => Number(item.metadata?.dnaVersion) || 0)),
      authoritative: {
        rules: clientPool
          .filter(
            (i) =>
              i.kind === 'rule' &&
              i.approved &&
              i.polarity !== 'negative' &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, text: i.text, title: i.title })),
        assets: clientPool
          .filter(
            (i) =>
              i.kind === 'official_asset' &&
              i.approved &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, text: i.text, metadata: i.metadata })),
        templates: clientPool
          .filter(
            (i) =>
              i.kind === 'template' &&
              i.approved &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, metadata: i.metadata })),
        glossary: [],
      },
      evidence: [...new Map(evidence.map((item) => [item.id, item])).values()].slice(0, 10),
      negativeEvidence: [...new Map(negativeEvidence.map((item) => [item.id, item])).values()].slice(0, 5),
      unresolvedConflicts,
      retrievalTrace: {
        poolCount: clientPool.length,
        intentsCount: intents.length,
        retrievalMode: 'lexical_only',
        vectorStatus: 'not_run',
        rerankerStatus: 'not_run',
        timestamp: new Date().toISOString(),
      },
    };

    return { ok: true, value: pack };
  }

  async ingest(
    ctx: RequestContext & { clientId: UUID },
    request: {
      sourceKind: string;
      sourceId: string;
      sourceVersion?: string;
      storageKey: string;
      mimeType: string;
      sha256: string;
      projectId?: UUID;
    }
  ): Promise<Result<{ documentId: UUID; chunks: number; changed: boolean }>> {
    void ctx;
    void request;
    return { ok: false, error: {
      code: 'RETRIEVAL_INGEST_NOT_IMPLEMENTED',
      message: 'The retrieval adapter cannot read and authorize source bytes from this request contract.',
      retryable: false,
      safeAction: 'Use an approved source-byte ingestion path with hash, version and client authorization before indexing.',
    } };
  }

  async deactivate(
    ctx: RequestContext & { clientId: UUID },
    sourceId: string,
    _reason: string
  ): Promise<Result<void>> {
    for (const item of this.knowledgeStore) {
      if (item.tenantId === ctx.tenantId && item.clientId === ctx.clientId && item.sourceId === sourceId) {
        item.active = false;
      }
    }
    return { ok: true, value: undefined };
  }

  async evaluate(
    _ctx: RequestContext,
    _datasetId: UUID,
    _candidateConfig: Record<string, unknown>
  ): Promise<Result<{ runId: UUID }>> {
    return { ok: false, error: {
      code: 'RETRIEVAL_EVALUATION_NOT_IMPLEMENTED',
      message: 'No sealed relevance dataset or measured retrieval run was executed.',
      retryable: false,
      safeAction: 'Run an authorized frozen retrieval dataset with relevance labels before reporting an evaluation ID.',
    } };
  }
}
