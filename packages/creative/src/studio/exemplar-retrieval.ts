import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface ExemplarMetadata {
  id: string;
  rank: number;
  filename: string;
  path: string;
  format: string;
  aspectRatio: string;
  reason: string;
  recommendedFor: string[];
  status?: 'CONFIRMED' | 'pending' | 'dropped';
}

export interface ExemplarRetrievalMatch {
  id: string;
  rank: number;
  filename: string;
  path: string;
  format: string;
  descriptor: string;
  score: number;
  recommendedFor: string[];
}

export interface ExemplarRetrievalResult {
  brief: string;
  retrievedExemplars: ExemplarRetrievalMatch[];
  retrievedIds: string[];
  executionTimeMs: number;
  apiCostUsd: number;
  fromCache: boolean;
}

// Deterministic TF-IDF / Vocabulary Vectorizer
const VOCABULARY = [
  // Intents & Genres
  'standards', 'policy', 'brief', 'accreditation', 'mandate', 'rigor', 'academic',
  'excellence', 'institutional', 'roadmap', 'strategic', 'statutory', 'law',
  'milestone', 'partnership', 'partner', 'recognition', 'membership',
  'announcement', 'presentation', 'feed', 'report',
  // Languages & Entities
  'kurdish', 'sorani', 'english', 'latin', 'auk', 'cue', 'chea', 'ciqg', 'erbil',
  'kurdistan', 'university', 'college',
  // Visual & Formats
  '1:1', '4:5', 'square', 'vertical', 'portrait', 'navy', 'gold', 'cream', 'grid', 'glass',
  'card', 'cards', 'pill', 'badge', 'chevron', 'banner', 'crest', 'emblem'
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9:\s_-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function computeLocalEmbeddingVector(text: string): number[] {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  const vec = new Array(VOCABULARY.length).fill(0);
  for (let i = 0; i < VOCABULARY.length; i++) {
    const word = VOCABULARY[i];
    const count = tf.get(word) || 0;
    if (count > 0) {
      // Sublinear TF scaling
      vec[i] = 1 + Math.log(count);
    }
  }

  // Normalize to unit length
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = parseFloat((vec[i] / norm).toFixed(4));
    }
  }

  return vec;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return parseFloat((dot / (Math.sqrt(normA) * Math.sqrt(normB))).toFixed(4));
}

export class ExemplarRetrievalIndex {
  private exemplars: ExemplarMetadata[] = [];
  private vectors: Map<string, number[]> = new Map();
  private cachePath: string;

  constructor(customCachePath?: string) {
    this.cachePath =
      customCachePath ||
      path.resolve(import.meta.dirname, '../../assets/exemplar-embeddings.json');
    this.loadExemplarsAndEmbeddings();
  }

  public getConfirmedExemplars(): ExemplarMetadata[] {
    return this.exemplars;
  }

  private loadExemplarsAndEmbeddings(): void {
    // 1. Load kaae-exemplars.json
    const jsonPaths = [
      path.resolve(import.meta.dirname, '../../assets/kaae-exemplars.json'),
      path.resolve(process.cwd(), 'packages/creative/assets/kaae-exemplars.json'),
      path.resolve(process.cwd(), 'assets/kaae-exemplars.json'),
      path.resolve(import.meta.dirname, '../../../packages/creative/assets/kaae-exemplars.json'),
    ];
    const targetJson = jsonPaths.find(p => fs.existsSync(p));
    if (!targetJson) {
      throw new Error(`Cannot locate kaae-exemplars.json in expected paths: ${jsonPaths.join(', ')}`);
    }

    const raw = JSON.parse(fs.readFileSync(targetJson, 'utf8'));
    // Strictly filter out any dropped or pending entries
    this.exemplars = (raw.exemplars || []).filter((e: any) => e.status !== 'pending' && e.status !== 'dropped').map((e: any) => {
      const id = path.basename(e.filename, path.extname(e.filename)).replace(/[^a-zA-Z0-9_-]/g, '_');
      return {
        id,
        rank: e.rank,
        filename: e.filename,
        path: e.path,
        format: e.format || e.aspectRatio || '1:1',
        aspectRatio: e.aspectRatio || '1:1',
        reason: e.reason,
        recommendedFor: e.recommendedFor || [],
        status: 'CONFIRMED' as const,
      };
    });

    // 2. Load or Compute Vector Embeddings
    let cacheLoaded = false;
    if (fs.existsSync(this.cachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
        if (cache && typeof cache === 'object' && cache.version === '2026-09-17' && cache.vectors) {
          for (const [id, vec] of Object.entries(cache.vectors)) {
            this.vectors.set(id, vec as number[]);
          }
          cacheLoaded = true;
        }
      } catch {
        cacheLoaded = false;
      }
    }

    if (!cacheLoaded) {
      // Build vectors and save to cache
      const cacheObj: any = {
        version: '2026-09-17',
        updatedAt: new Date().toISOString(),
        vocabulary: VOCABULARY,
        vectors: {},
      };

      for (const ex of this.exemplars) {
        const textToEmbed = `${ex.filename} ${ex.format} ${ex.recommendedFor.join(' ')} ${ex.reason}`;
        const vec = computeLocalEmbeddingVector(textToEmbed);
        this.vectors.set(ex.id, vec);
        cacheObj.vectors[ex.id] = vec;
      }

      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(cacheObj, null, 2), 'utf8');
    }
  }

  public retrieveTopExemplars(
    brief: { text: string; format?: string; category?: string },
    k = 3
  ): ExemplarRetrievalResult {
    const startTime = performance.now();
    const briefText = `${brief.text} ${brief.format || ''} ${brief.category || ''}`;
    const queryVec = computeLocalEmbeddingVector(briefText);

    const scored: Array<{ exemplar: ExemplarMetadata; score: number }> = [];

    for (const ex of this.exemplars) {
      // Hard gate: pending entries must never be retrieved
      if (ex.status === 'pending') continue;

      const exVec = this.vectors.get(ex.id);
      if (!exVec) continue;

      let score = cosineSimilarity(queryVec, exVec);

      // Format alignment bonus (+0.15 if format matches requested format)
      if (brief.format && ex.format === brief.format) {
        score += 0.15;
      }

      scored.push({
        exemplar: ex,
        score: parseFloat(score.toFixed(4)),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, k);

    const retrievedExemplars: ExemplarRetrievalMatch[] = topK.map(item => ({
      id: item.exemplar.id,
      rank: item.exemplar.rank,
      filename: item.exemplar.filename,
      path: item.exemplar.path,
      format: item.exemplar.format,
      descriptor: item.exemplar.reason,
      score: item.score,
      recommendedFor: item.exemplar.recommendedFor,
    }));

    const executionTimeMs = parseFloat((performance.now() - startTime).toFixed(2));

    return {
      brief: brief.text,
      retrievedExemplars,
      retrievedIds: retrievedExemplars.map(e => e.id),
      executionTimeMs,
      apiCostUsd: 0.0000,
      fromCache: true,
    };
  }
}
