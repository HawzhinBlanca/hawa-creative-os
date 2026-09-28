import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const EXEMPLAR_RETRIEVAL_VERSION = 'unicode-bm25-v1';
export interface ExemplarMetadata {
  id: string;
  rank: number;
  filename: string;
  path: string;
  format: string;
  aspectRatio: string;
  reason: string;
  recommendedFor: string[];
  sha256?: string;
  status: 'CONFIRMED';
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
  sha256?: string;
}
export interface ExemplarRetrievalEvidence {
  algorithm: typeof EXEMPLAR_RETRIEVAL_VERSION;
  manifestSha256: string;
  mode: 'lexical' | 'format_fallback' | 'curator_fallback' | 'empty';
  queryTokenCount: number;
  matchedTokenCount: number;
  eligibleCount: number;
  matches: Array<{ id: string; lexicalScore: number; matchedTokens: string[]; formatMatch: boolean }>;
  warnings: string[];
}
export interface ExemplarRetrievalResult {
  brief: string;
  retrievedExemplars: ExemplarRetrievalMatch[];
  retrievedIds: string[];
  executionTimeMs: number;
  apiCostUsd: number;
  /** True only when this instance reused its content-identical parsed index. */
  fromCache: boolean;
  evidence: ExemplarRetrievalEvidence;
}

/** Search-only normalization. Never substitute this result for approved copy. */
export function exemplarSearchTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase()
    .replace(/\u0643/g, '\u06a9').replace(/\u064a/g, '\u06cc')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function admittedEntries(raw: unknown): ExemplarMetadata[] {
  if (!object(raw) || raw.status !== 'CONFIRMED' || !Array.isArray(raw.exemplars))
    throw new Error('Exemplar manifest must be an explicitly confirmed collection.');
  const inheritedApproval = typeof raw.curator === 'string' && !!raw.curator.trim() &&
    typeof raw.confirmedAt === 'string' && !!raw.confirmedAt &&
    typeof raw.confirmationMethod === 'string' && !!raw.confirmationMethod.trim();
  const entries: ExemplarMetadata[] = [];
  const ids = new Set<string>();
  for (const value of raw.exemplars) {
    if (!object(value) || !(value.status === 'CONFIRMED' || value.status === undefined && inheritedApproval)) continue;
    if (typeof value.filename !== 'string' || !value.filename || path.basename(value.filename) !== value.filename ||
        typeof value.path !== 'string' || typeof value.reason !== 'string' ||
        !Number.isSafeInteger(value.rank) || Number(value.rank) < 1 ||
        value.recommendedFor !== undefined && (!Array.isArray(value.recommendedFor) || !value.recommendedFor.every(v => typeof v === 'string')) ||
        value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
      throw new Error('Confirmed exemplar metadata is invalid.');
    const id = path.basename(value.filename, path.extname(value.filename)).replace(/[^\p{L}\p{N}_-]/gu, '_');
    if (ids.has(id)) throw new Error('Confirmed exemplar IDs must be unique.');
    ids.add(id);
    const format = typeof value.format === 'string' ? value.format : typeof value.aspectRatio === 'string' ? value.aspectRatio : '1:1';
    entries.push({ id, rank: Number(value.rank), filename: value.filename, path: value.path,
      format, aspectRatio: typeof value.aspectRatio === 'string' ? value.aspectRatio : format,
      reason: value.reason, recommendedFor: (value.recommendedFor ?? []) as string[],
      ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}), status: 'CONFIRMED' });
  }
  return entries;
}
interface LexicalDocument { exemplar: ExemplarMetadata; counts: Map<string, number>; length: number }
export interface ExemplarIndexOptions {
  manifestPath?: string;
  /** Core supplies the same authorized snapshot used to calculate its policy hash. */
  manifest?: unknown;
}

/** Small local approved collection. Authorization of that collection belongs to the caller. */
export class ExemplarRetrievalIndex {
  private source: () => string;
  private manifestSha256 = '';
  private documents: LexicalDocument[] = [];
  private frequencies = new Map<string, number>();
  private averageLength = 1;

  constructor(options: ExemplarIndexOptions | string = {}) {
    // Historical string arguments designated an optional vector-cache file. The
    // obsolete disk cache is deliberately never read or written.
    const opts = typeof options === 'string' ? {} : options;
    if (opts.manifest !== undefined) {
      const snapshot = JSON.stringify(opts.manifest);
      this.source = () => snapshot;
    } else {
      const candidates = opts.manifestPath ? [opts.manifestPath] : [
        path.resolve(import.meta.dirname, '../../assets/kaae-exemplars.json'),
        path.resolve(process.cwd(), 'packages/creative/assets/kaae-exemplars.json'),
        path.resolve(process.cwd(), 'assets/kaae-exemplars.json'),
      ];
      const manifestPath = candidates.find(p => fs.existsSync(p));
      if (!manifestPath) throw new Error('Cannot locate the approved exemplar manifest.');
      this.source = () => fs.readFileSync(manifestPath, 'utf8');
    }
    this.refresh();
  }

  private refresh(): boolean {
    const content = this.source();
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest === this.manifestSha256) return true;
    const exemplars = admittedEntries(JSON.parse(content));
    const documents = exemplars.map(exemplar => {
      // File labels can contain exact institution names; exclude extensions and
      // format digits, which are separate metadata rather than semantic evidence.
      const tokens = exemplarSearchTokens(`${path.parse(exemplar.filename).name} ${exemplar.reason} ${exemplar.recommendedFor.join(' ')}`);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      return { exemplar, counts, length: tokens.length };
    });
    const frequencies = new Map<string, number>();
    for (const doc of documents) for (const token of doc.counts.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    this.documents = documents;
    this.frequencies = frequencies;
    this.averageLength = Math.max(1, documents.reduce((sum, d) => sum + d.length, 0) / Math.max(1, documents.length));
    this.manifestSha256 = digest;
    return false;
  }

  public getConfirmedExemplars(): ExemplarMetadata[] {
    this.refresh();
    return structuredClone(this.documents.map(d => d.exemplar));
  }

  public retrieveTopExemplars(brief: { text: string; format?: string; category?: string }, k = 3, availableIds?: readonly string[]): ExemplarRetrievalResult {
    const start = performance.now();
    if (!Number.isSafeInteger(k) || k < 0) throw new RangeError('Exemplar count must be a nonnegative integer.');
    const fromCache = this.refresh();
    // Core verifies availability/hashes before ranking. Excluded images must not
    // influence document frequencies, order, or the selected context.
    const allow = availableIds ? new Set(availableIds) : undefined;
    const documents = allow ? this.documents.filter(d => allow.has(d.exemplar.id)) : this.documents;
    const frequencies = allow ? new Map<string, number>() : this.frequencies;
    if (allow) for (const doc of documents) for (const token of doc.counts.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    const averageLength = allow ? Math.max(1, documents.reduce((n,d) => n+d.length,0) / Math.max(1,documents.length)) : this.averageLength;
    const query = [...new Set(exemplarSearchTokens(`${brief.text} ${brief.category ?? ''}`))];
    const matched = new Set<string>();
    const ranked = documents.map(doc => {
      let lexicalScore = 0;
      const matchedTokens: string[] = [];
      for (const token of query) {
        const tf = doc.counts.get(token) ?? 0;
        if (!tf) continue;
        const df = frequencies.get(token)!;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        lexicalScore += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
        matchedTokens.push(token); matched.add(token);
      }
      return { doc, lexicalScore, matchedTokens, formatMatch: !!brief.format && brief.format === doc.exemplar.format };
    });
    // A format preference cannot outrank actual text evidence. With no evidence,
    // curator ranking is an explicit usable fallback, never a fabricated similarity.
    ranked.sort((a,b) => b.lexicalScore - a.lexicalScore || Number(b.formatMatch) - Number(a.formatMatch) ||
      a.doc.exemplar.rank - b.doc.exemplar.rank || (a.doc.exemplar.id < b.doc.exemplar.id ? -1 : a.doc.exemplar.id > b.doc.exemplar.id ? 1 : 0));
    const hasLexical = matched.size > 0;
    const candidates = hasLexical ? ranked.filter(r => r.lexicalScore > 0) : ranked;
    const selected = candidates.slice(0, Math.min(k, 10));
    const mode: ExemplarRetrievalEvidence['mode'] = !selected.length ? 'empty' : hasLexical ? 'lexical' : selected[0].formatMatch ? 'format_fallback' : 'curator_fallback';
    const retrievedExemplars = selected.map(({ doc, lexicalScore }) => ({
      id: doc.exemplar.id, rank: doc.exemplar.rank, filename: doc.exemplar.filename, path: doc.exemplar.path,
      format: doc.exemplar.format, descriptor: doc.exemplar.reason, score: lexicalScore,
      recommendedFor: [...doc.exemplar.recommendedFor], ...(doc.exemplar.sha256 ? { sha256: doc.exemplar.sha256 } : {}),
    }));
    return { brief: brief.text, retrievedExemplars, retrievedIds: retrievedExemplars.map(e => e.id),
      executionTimeMs: performance.now() - start, apiCostUsd: 0, fromCache,
      evidence: { algorithm: EXEMPLAR_RETRIEVAL_VERSION, manifestSha256: this.manifestSha256, mode,
        queryTokenCount: query.length, matchedTokenCount: matched.size, eligibleCount: documents.length,
        matches: selected.map(r => ({ id: r.doc.exemplar.id, lexicalScore: r.lexicalScore, matchedTokens: r.matchedTokens, formatMatch: r.formatMatch })),
        warnings: k === 0 || hasLexical ? [] : !documents.length ? ['NO_ELIGIBLE_EXEMPLARS: no approved available examples were selected.'] : ['NO_LEXICAL_MATCH: selected by available format and curator order; cross-language semantic retrieval was not run.'] },
    };
  }
}
