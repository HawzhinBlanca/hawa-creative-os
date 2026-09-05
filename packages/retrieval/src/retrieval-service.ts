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
import { DoclingParser } from './docling-parser.js';

interface StoredKnowledgeItem {
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

  async retrieve(ctx: RequestContext & { clientId: UUID }, intents: RetrievalIntent[]): Promise<Result<ContextPack, AppError>> {
    // Invariant 6: Hard client isolation before any similarity ranking
    const clientPool = this.knowledgeStore.filter((item) => item.clientId === ctx.clientId && item.active);

    const evidence: RetrievalCandidate[] = [];
    const negativeEvidence: RetrievalCandidate[] = [];

    for (const intent of intents) {
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
          .filter((i) => i.kind === 'rule' && i.approved && (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId))
          .map((i) => ({ id: i.id, text: i.text, title: i.title })),
        assets: clientPool
          .filter((i) => i.kind === 'official_asset' && (i.approved ?? true) && (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId))
          .map((i) => ({ id: i.id, text: i.text, metadata: i.metadata })),
        templates: clientPool
          .filter((i) => i.kind === 'template' && (i.approved ?? true) && (!ctx.projectId || !i.projectId || i.projectId === ctx.projectId))
          .map((i) => ({ id: i.id, metadata: i.metadata })),
        glossary: [],
      },
      evidence: evidence.slice(0, 10),
      negativeEvidence: negativeEvidence.slice(0, 5),
      unresolvedConflicts: [],
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
    request: { sourceKind: string; sourceId: string; sourceVersion?: string; storageKey: string; mimeType: string; sha256: string; projectId?: UUID }
  ): Promise<Result<{ documentId: UUID; chunks: number; changed: boolean }>> {
    const docId = crypto.randomUUID();
    const parsed = await this.parser.parse(docId, `Sample document content for ${request.sourceId}`, request.mimeType, request.sourceId);

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

  async deactivate(ctx: RequestContext & { clientId: UUID }, sourceId: string, _reason: string): Promise<Result<void>> {
    for (const item of this.knowledgeStore) {
      if (item.clientId === ctx.clientId && item.sourceId === sourceId) {
        item.active = false;
      }
    }
    return { ok: true, value: undefined };
  }

  async evaluate(_ctx: RequestContext, _datasetId: UUID, _candidateConfig: Record<string, unknown>): Promise<Result<{ runId: UUID }>> {
    return {
      ok: true,
      value: { runId: crypto.randomUUID() },
    };
  }
}
