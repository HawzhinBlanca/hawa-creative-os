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
import { DoclingParser } from './docling-parser.js';

export interface StoredKnowledgeItem {
  id: UUID;
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
  private parser = new DoclingParser();
  private knowledgeStore: StoredKnowledgeItem[] = [];

  addKnowledgeItem(item: StoredKnowledgeItem) {
    this.knowledgeStore.push(item);
  }

  clear() {
    this.knowledgeStore = [];
  }

  count(): number {
    return this.knowledgeStore.length;
  }

  /**
   * Ingests and indexes authentic ClientDNA (CV-09, FR-007, FR-008, FR-011)
   */
  indexClientDna(dna: ClientDNA) {
    // 1. Index official approved assets
    for (const asset of dna.assets) {
      this.addKnowledgeItem({
        id: asset.assetId,
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
      this.addKnowledgeItem({
        id: crypto.randomUUID(),
        clientId: dna.clientId,
        kind: 'rule',
        sourceId: `rule_${dna.code}_layout_${idx + 1}`,
        title: `${dna.code} Layout Rule ${idx + 1}`,
        text: rule,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: { category: 'layout' },
      });
    }

    // 3. Index required disclaimers
    for (const [idx, disclaimer] of dna.guidelines.requiredDisclaimers.entries()) {
      this.addKnowledgeItem({
        id: crypto.randomUUID(),
        clientId: dna.clientId,
        kind: 'rule',
        sourceId: `rule_${dna.code}_disclaimer_${idx + 1}`,
        title: `${dna.code} Statutory Disclaimer ${idx + 1}`,
        text: disclaimer,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: { category: 'disclaimer' },
      });
    }

    // 4. Index prohibited phrases as negative evidence
    for (const phrase of dna.guidelines.prohibitedPhrases) {
      this.addKnowledgeItem({
        id: crypto.randomUUID(),
        clientId: dna.clientId,
        kind: 'rule',
        sourceId: `rule_${dna.code}_prohibited_${phrase}`,
        title: `Prohibited: ${phrase}`,
        text: phrase,
        polarity: 'negative',
        approved: true,
        active: true,
        metadata: { prohibited: true, phrase },
      });
    }

    // 5. Index Canva Team & Brand Kit mapping
    if (dna.canvaMapping) {
      this.addKnowledgeItem({
        id: crypto.randomUUID(),
        clientId: dna.clientId,
        kind: 'rule',
        sourceId: `canva_mapping_${dna.code}`,
        title: `${dna.code} Canva Team and Brand Kit Mapping`,
        text: `Canva Team ID: ${dna.canvaMapping.canvaTeamId}, Brand Kit ID: ${dna.canvaMapping.canvaBrandKitId}`,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: {
          canvaTeamId: dna.canvaMapping.canvaTeamId,
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
    // Invariant 6: Strict client isolation before any similarity ranking
    const clientPool = this.knowledgeStore.filter(
      (item) => item.clientId === ctx.clientId && item.active
    );

    const evidence: RetrievalCandidate[] = [];
    const negativeEvidence: RetrievalCandidate[] = [];
    const unresolvedConflicts: Array<{
      id: string;
      conflictType: string;
      severity: string;
      description: string;
      safeAction?: string;
    }> = [];

    // Check for prohibited phrases in intent queries
    const prohibitedRules = clientPool.filter(
      (item) => item.polarity === 'negative' || item.metadata?.prohibited === true
    );

    for (const intent of intents) {
      const qLower = intent.query.toLowerCase();
      for (const p of prohibitedRules) {
        if (p.text && qLower.includes(p.text.toLowerCase())) {
          unresolvedConflicts.push({
            id: crypto.randomUUID(),
            conflictType: 'PROHIBITED_LEXICON_VIOLATION',
            severity: 'BLOCKING',
            description: `Query violates client prohibited guidelines: contains "${p.text}"`,
            safeAction: 'Remove prohibited phrase or seek client exception',
          });
        }
      }

      // If intent specifically asks for official_asset, check if client has assets
      if (intent.kinds.includes('official_asset')) {
        const availableAssets = clientPool.filter((item) => item.kind === 'official_asset');
        if (availableAssets.length === 0) {
          unresolvedConflicts.push({
            id: crypto.randomUUID(),
            conflictType: 'MISSING_BRAND_ASSET',
            severity: 'BLOCKING',
            description: `No approved official assets exist for client ${ctx.clientId}. Cannot invent placeholder branding.`,
            safeAction: 'Upload official vector logo/assets before generation',
          });
        }
      }

      const matchingItems = clientPool.filter((item) => {
        if (!intent.kinds.includes(item.kind)) return false;
        if (ctx.projectId && item.projectId && item.projectId !== ctx.projectId) return false;
        return true;
      });

      // Simple scoring: exact word match in text
      const queryWords = intent.query.toLowerCase().split(/\s+/).filter(Boolean);
      for (const item of matchingItems) {
        let score = 0;
        const lower = item.text.toLowerCase();
        for (const w of queryWords) {
          if (lower.includes(w)) {
            score += 1;
          }
        }
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
          vectorScore: score > 0 ? 0.9 : 0.4,
          rerankScore: score > 0 ? 0.95 : 0.5,
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
      clientDnaVersion: 1,
      authoritative: {
        rules: clientPool
          .filter(
            (i) =>
              i.kind === 'rule' &&
              i.approved &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, text: i.text, title: i.title })),
        assets: clientPool
          .filter(
            (i) =>
              i.kind === 'official_asset' &&
              (i.approved ?? true) &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, text: i.text, metadata: i.metadata })),
        templates: clientPool
          .filter(
            (i) =>
              i.kind === 'template' &&
              (i.approved ?? true) &&
              (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId)
          )
          .map((i) => ({ id: i.id, metadata: i.metadata })),
        glossary: [],
      },
      evidence: evidence.slice(0, 10),
      negativeEvidence: negativeEvidence.slice(0, 5),
      unresolvedConflicts: unresolvedConflicts as any,
      retrievalTrace: {
        poolCount: clientPool.length,
        intentsCount: intents.length,
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
    const docId = crypto.randomUUID();
    const parsed = await this.parser.parse(
      docId,
      `Sample document content for ${request.sourceId}`,
      request.mimeType,
      request.sourceId
    );

    for (const chunk of parsed.chunks) {
      this.addKnowledgeItem({
        id: chunk.chunkId,
        clientId: ctx.clientId,
        projectId: request.projectId,
        kind: 'document',
        sourceId: request.sourceId,
        title: `${request.sourceId} - Page ${chunk.pageNumber}`,
        text: chunk.text,
        polarity: 'positive',
        approved: true,
        active: true,
        metadata: { ...chunk.metadata, storageKey: request.storageKey },
      });
    }

    return {
      ok: true,
      value: {
        documentId: docId,
        chunks: parsed.chunks.length,
        changed: true,
      },
    };
  }

  async deactivate(
    ctx: RequestContext & { clientId: UUID },
    sourceId: string,
    _reason: string
  ): Promise<Result<void>> {
    for (const item of this.knowledgeStore) {
      if (item.clientId === ctx.clientId && item.sourceId === sourceId) {
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
    return {
      ok: true,
      value: { runId: crypto.randomUUID() },
    };
  }
}
