import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const EXEMPLAR_RETRIEVAL_VERSION = 'unicode-bm25-v1';
/** Briefs with photos: recipe-eligible, subject-matched, recipe-diverse (ADR-170). */
export const PHOTO_EXEMPLAR_RETRIEVAL_VERSION = 'photo-recipe-subject-v1';

/** The shared photo recipe ids (ADR-170 v1). `typographic` is a brief with no photo. */
export { PHOTO_RECIPE_IDS } from './art-direction/recipes.js';
import { PHOTO_RECIPE_IDS } from './art-direction/recipes.js';
export type PhotoRecipeId = typeof PHOTO_RECIPE_IDS[number];
export type ExemplarRecipeId = PhotoRecipeId | 'typographic';
const isPhotoRecipe = (v: unknown): v is PhotoRecipeId => (PHOTO_RECIPE_IDS as readonly unknown[]).includes(v);

/**
 * CONFIRMED: the owner confirmed it. office-published: one of the office's own published posts,
 * admitted only for briefs with photos and not owner-confirmed.
 */
export type ExemplarStatus = 'CONFIRMED' | 'office-published';
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
  status: ExemplarStatus;
  recipe: ExemplarRecipeId;
  subject: string[];
  photoCount: number;
  /** How the design uses its photo, for the layout model. Falls back to `reason`. */
  descriptor: string;
  language?: string;
  pairedWith?: string;
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
  status: ExemplarStatus;
  recipe: ExemplarRecipeId;
  subject: string[];
  photoCount: number;
}
export interface ExemplarRetrievalEvidence {
  algorithm: typeof EXEMPLAR_RETRIEVAL_VERSION | typeof PHOTO_EXEMPLAR_RETRIEVAL_VERSION;
  manifestSha256: string;
  mode: 'lexical' | 'format_fallback' | 'curator_fallback' | 'empty' | 'photo_recipe';
  queryTokenCount: number;
  matchedTokenCount: number;
  eligibleCount: number;
  matches: Array<{ id: string; lexicalScore: number; matchedTokens: string[]; formatMatch: boolean;
    recipe?: PhotoRecipeId; subjectMatches?: string[] }>;
  warnings: string[];
  /** Available admitted references, distinct from supported geometry (ADR-189). Photo briefs only. */
  photoRecipeCoverage?: {
    method: 'eligible-recipe-coverage-v1';
    eligible: PhotoRecipeId[];
    represented: PhotoRecipeId[];
    missing: PhotoRecipeId[];
  };
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
export interface ExemplarBrief {
  text: string;
  format?: string;
  category?: string;
  /** Photos the brief carries. Absent or zero: typographic retrieval, unchanged. */
  photoCount?: number;
  /** Recipes the caller found eligible for these photos. Absent: every photo recipe. */
  eligibleRecipes?: readonly string[];
  /** Subject tags of the brief, e.g. report_release, meeting, event_forum. */
  subjects?: readonly string[];
  /**
   * ADR-271: a text-only brief may also be shown the office's own published posts, for their
   * composition (big display type, a navy or cream ground, a clear focal point), not their photos.
   * Absent or false: the typographic retrieval is exactly as before (owner-confirmed set only).
   */
  officePosters?: boolean;
}

/** Search-only normalization. Never substitute this result for approved copy. */
export function exemplarSearchTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase()
    .replace(/ك/g, 'ک').replace(/ي/g, 'ی')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[ـً-ٰٟ]/g, '')
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');

function admittedEntries(raw: unknown): ExemplarMetadata[] {
  if (!object(raw) || raw.status !== 'CONFIRMED' || !Array.isArray(raw.exemplars))
    throw new Error('Exemplar manifest must be an explicitly confirmed collection.');
  const inheritedApproval = typeof raw.curator === 'string' && !!raw.curator.trim() &&
    typeof raw.confirmedAt === 'string' && !!raw.confirmedAt &&
    typeof raw.confirmationMethod === 'string' && !!raw.confirmationMethod.trim();
  const entries: ExemplarMetadata[] = [];
  const ids = new Set<string>();
  for (const value of raw.exemplars) {
    if (!object(value)) continue;
    const confirmed = value.status === 'CONFIRMED' || value.status === undefined && inheritedApproval;
    if (!confirmed && value.status !== 'office-published') continue;
    if (typeof value.filename !== 'string' || !value.filename || path.basename(value.filename) !== value.filename ||
        typeof value.path !== 'string' || typeof value.reason !== 'string' ||
        !Number.isSafeInteger(value.rank) || Number(value.rank) < 1 ||
        value.recommendedFor !== undefined && !strings(value.recommendedFor) ||
        value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
      throw new Error('Confirmed exemplar metadata is invalid.');
    // A photo exemplar names its recipe and photo count; neither may contradict the other.
    const photoCount = value.photoCount === undefined ? 0 : value.photoCount;
    const recipe = value.recipe === undefined ? 'typographic' : value.recipe;
    if (!Number.isSafeInteger(photoCount) || Number(photoCount) < 0 ||
        !(recipe === 'typographic' ? photoCount === 0 : isPhotoRecipe(recipe) && Number(photoCount) > 0) ||
        value.subject !== undefined && !strings(value.subject) ||
        value.descriptor !== undefined && (typeof value.descriptor !== 'string' || !value.descriptor.trim()))
      throw new Error('Confirmed exemplar metadata is invalid.');
    // An office-published post is admitted only as a photo reference, never into the typographic set.
    if (!confirmed && recipe === 'typographic') throw new Error('Confirmed exemplar metadata is invalid.');
    const id = path.basename(value.filename, path.extname(value.filename)).replace(/[^\p{L}\p{N}_-]/gu, '_');
    if (ids.has(id)) throw new Error('Confirmed exemplar IDs must be unique.');
    ids.add(id);
    const format = typeof value.format === 'string' ? value.format : typeof value.aspectRatio === 'string' ? value.aspectRatio : '1:1';
    entries.push({ id, rank: Number(value.rank), filename: value.filename, path: value.path,
      format, aspectRatio: typeof value.aspectRatio === 'string' ? value.aspectRatio : format,
      reason: value.reason, recommendedFor: (value.recommendedFor ?? []) as string[],
      ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
      status: confirmed ? 'CONFIRMED' : 'office-published',
      recipe: recipe as ExemplarRecipeId, subject: (value.subject ?? []) as string[], photoCount: Number(photoCount),
      descriptor: typeof value.descriptor === 'string' ? value.descriptor : value.reason,
      ...(typeof value.language === 'string' ? { language: value.language } : {}),
      ...(typeof value.pairedWith === 'string' ? { pairedWith: value.pairedWith } : {}) });
  }
  return entries;
}
interface LexicalDocument { exemplar: ExemplarMetadata; counts: Map<string, number>; length: number }
export interface ExemplarIndexOptions {
  manifestPath?: string;
  /** Core supplies the same authorized snapshot used to calculate its policy hash. */
  manifest?: unknown;
}
interface Ranked { doc: LexicalDocument; lexicalScore: number; matchedTokens: string[]; formatMatch: boolean }

/** BM25 over one candidate pool; frequencies come only from that pool. */
function lexicalRank(documents: LexicalDocument[], query: string[], format: string | undefined): { ranked: Ranked[]; matched: Set<string> } {
  const frequencies = new Map<string, number>();
  for (const doc of documents) for (const token of doc.counts.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const averageLength = Math.max(1, documents.reduce((n, d) => n + d.length, 0) / Math.max(1, documents.length));
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
    return { doc, lexicalScore, matchedTokens, formatMatch: !!format && format === doc.exemplar.format };
  });
  return { ranked, matched };
}
const byId = (a: Ranked, b: Ranked) => a.doc.exemplar.id < b.doc.exemplar.id ? -1 : a.doc.exemplar.id > b.doc.exemplar.id ? 1 : 0;
const toMatch = ({ doc, lexicalScore }: Ranked): ExemplarRetrievalMatch => ({
  id: doc.exemplar.id, rank: doc.exemplar.rank, filename: doc.exemplar.filename, path: doc.exemplar.path,
  format: doc.exemplar.format, descriptor: doc.exemplar.descriptor, score: lexicalScore,
  recommendedFor: [...doc.exemplar.recommendedFor], ...(doc.exemplar.sha256 ? { sha256: doc.exemplar.sha256 } : {}),
  status: doc.exemplar.status, recipe: doc.exemplar.recipe, subject: [...doc.exemplar.subject], photoCount: doc.exemplar.photoCount,
});
const RTL_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u;

/** Small local approved collection. Authorization of that collection belongs to the caller. */
export class ExemplarRetrievalIndex {
  private source: () => string;
  private manifestSha256 = '';
  private documents: LexicalDocument[] = [];

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
    this.documents = exemplars.map(exemplar => {
      // File labels can contain exact institution names; exclude extensions and
      // format digits, which are separate metadata rather than semantic evidence.
      // Subject tags are searchable words too ("report_release" gives "report" and "release").
      const tokens = exemplarSearchTokens(`${path.parse(exemplar.filename).name} ${exemplar.reason} ${exemplar.recommendedFor.join(' ')} ${exemplar.subject.join(' ')}`);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      return { exemplar, counts, length: tokens.length };
    });
    this.manifestSha256 = digest;
    return false;
  }

  /** Every admitted exemplar: the owner-confirmed set and the office-published photo references. */
  public getConfirmedExemplars(): ExemplarMetadata[] {
    this.refresh();
    return structuredClone(this.documents.map(d => d.exemplar));
  }

  public retrieveTopExemplars(brief: ExemplarBrief, k = 3, availableIds?: readonly string[]): ExemplarRetrievalResult {
    const start = performance.now();
    if (!Number.isSafeInteger(k) || k < 0) throw new RangeError('Exemplar count must be a nonnegative integer.');
    const fromCache = this.refresh();
    // Core verifies availability/hashes before ranking. Excluded images must not
    // influence document frequencies, order, or the selected context.
    const allow = availableIds ? new Set(availableIds) : undefined;
    const available = allow ? this.documents.filter(d => allow.has(d.exemplar.id)) : this.documents;
    const query = [...new Set(exemplarSearchTokens(`${brief.text} ${brief.category ?? ''}`))];
    const photoCount = Number.isSafeInteger(brief.photoCount) && Number(brief.photoCount) > 0 ? Number(brief.photoCount) : 0;
    const warnings: string[] = [];
    const photoRecipeCoverage = photoCount > 0 && k > 0 ? (() => {
      const eligible = PHOTO_RECIPE_IDS.filter(id => !brief.eligibleRecipes || brief.eligibleRecipes.includes(id));
      const availableRecipes = new Set(available.filter(d => d.exemplar.photoCount > 0).map(d => d.exemplar.recipe));
      return { method: 'eligible-recipe-coverage-v1' as const, eligible,
        represented: eligible.filter(id => availableRecipes.has(id)),
        missing: eligible.filter(id => !availableRecipes.has(id)) };
    })() : undefined;
    const coverageWarning = photoRecipeCoverage?.missing.length
      ? `MISSING_PHOTO_RECIPE_EXEMPLARS: no available admitted reference for ${photoRecipeCoverage.missing.join(', ')}; reference/taste qualification remains open.`
      : undefined;
    if (photoCount > 0 && k > 0) {
      const photo = this.retrievePhotoExemplars(brief, k, available, query, start, fromCache);
      if (photo) {
        photo.evidence.photoRecipeCoverage = photoRecipeCoverage;
        if (coverageWarning) photo.evidence.warnings.push(coverageWarning);
        return photo;
      }
      warnings.push('NO_ELIGIBLE_PHOTO_EXEMPLAR: no available photo exemplar has an eligible recipe; typographic exemplars were used.');
      if (coverageWarning) warnings.push(coverageWarning);
    }
    // A typographic brief sees only the owner-confirmed typographic set, ranked exactly as before
    // photo exemplars existed: they take no part in its frequencies, order or selection. ADR-271: with
    // `officePosters`, the office's published posts join the pool, and at least one of them (in the
    // brief's script where one exists, never a language twin of another pick) is among the selection.
    const isOfficePoster = (d: LexicalDocument) => d.exemplar.status === 'office-published' && d.exemplar.photoCount > 0;
    const documents = available.filter(d => (d.exemplar.status === 'CONFIRMED' && d.exemplar.photoCount === 0) ||
      (photoCount === 0 && brief.officePosters === true && isOfficePoster(d)));
    const { ranked, matched } = lexicalRank(documents, query, brief.format);
    // A format preference cannot outrank actual text evidence. With no evidence,
    // curator ranking is an explicit usable fallback, never a fabricated similarity.
    ranked.sort((a,b) => b.lexicalScore - a.lexicalScore || Number(b.formatMatch) - Number(a.formatMatch) ||
      a.doc.exemplar.rank - b.doc.exemplar.rank || byId(a, b));
    const hasLexical = matched.size > 0;
    const candidates = hasLexical ? ranked.filter(r => r.lexicalScore > 0) : ranked;
    const selected = candidates.slice(0, Math.min(k, 10));
    if (brief.officePosters === true && photoCount === 0 && selected.length && !selected.some(r => isOfficePoster(r.doc))) {
      const rtl = RTL_SCRIPT.test(brief.text);
      const fits = (language?: string) => language === 'bilingual' || (rtl ? language === 'ckb' : language === 'en');
      const posters = ranked.filter(r => isOfficePoster(r.doc))
        .sort((a, b) => Number(fits(b.doc.exemplar.language)) - Number(fits(a.doc.exemplar.language)) || b.lexicalScore - a.lexicalScore ||
          a.doc.exemplar.rank - b.doc.exemplar.rank || byId(a, b));
      if (posters.length) {
        if (selected.length >= Math.min(k, 10)) selected.pop();
        selected.push(posters[0]);
      }
    }
    const mode: ExemplarRetrievalEvidence['mode'] = !selected.length ? 'empty' : hasLexical ? 'lexical' : selected[0].formatMatch ? 'format_fallback' : 'curator_fallback';
    const retrievedExemplars = selected.map(toMatch);
    return { brief: brief.text, retrievedExemplars, retrievedIds: retrievedExemplars.map(e => e.id),
      executionTimeMs: performance.now() - start, apiCostUsd: 0, fromCache,
      evidence: { algorithm: EXEMPLAR_RETRIEVAL_VERSION, manifestSha256: this.manifestSha256, mode,
        queryTokenCount: query.length, matchedTokenCount: matched.size, eligibleCount: documents.length,
        matches: selected.map(r => ({ id: r.doc.exemplar.id, lexicalScore: r.lexicalScore, matchedTokens: r.matchedTokens, formatMatch: r.formatMatch })),
        warnings: [...warnings, ...(k === 0 || hasLexical ? [] : !documents.length ? ['NO_ELIGIBLE_EXEMPLARS: no approved available examples were selected.'] : ['NO_LEXICAL_MATCH: selected by available format and curator order; cross-language semantic retrieval was not run.'])],
        ...(photoRecipeCoverage ? { photoRecipeCoverage } : {}) },
    };
  }

  /**
   * A brief with photos is shown how the office uses photos: photo exemplars whose recipe is
   * eligible, those sharing the brief's subject first, then text evidence, the brief's script
   * (a Sorani brief sees the Sorani twin), format and curator order. The first picks take one
   * exemplar per recipe, so three references show three different techniques, not one post in
   * two languages. Null when no photo exemplar is eligible.
   */
  private retrievePhotoExemplars(brief: ExemplarBrief, k: number, available: LexicalDocument[], query: string[],
    start: number, fromCache: boolean): ExemplarRetrievalResult | null {
    const eligible = brief.eligibleRecipes ? new Set(brief.eligibleRecipes.filter(isPhotoRecipe)) : undefined;
    const documents = available.filter(d => d.exemplar.photoCount > 0 && isPhotoRecipe(d.exemplar.recipe) &&
      (!eligible || eligible.has(d.exemplar.recipe)));
    if (!documents.length) return null;
    const wanted = new Set([...(brief.subjects ?? []), ...(brief.category ? [brief.category] : [])]
      .map(s => s.trim().toLowerCase()).filter(Boolean));
    const rtl = RTL_SCRIPT.test(brief.text);
    const languageFits = (language?: string) => language === 'bilingual' || (rtl ? language === 'ckb' : language === 'en');
    const { ranked, matched } = lexicalRank(documents, query, brief.format);
    const subjectMatches = new Map(ranked.map(r => [r, r.doc.exemplar.subject.filter(s => wanted.has(s.toLowerCase()))]));
    ranked.sort((a, b) => subjectMatches.get(b)!.length - subjectMatches.get(a)!.length ||
      b.lexicalScore - a.lexicalScore ||
      Number(languageFits(b.doc.exemplar.language)) - Number(languageFits(a.doc.exemplar.language)) ||
      Number(b.formatMatch) - Number(a.formatMatch) ||
      a.doc.exemplar.rank - b.doc.exemplar.rank || byId(a, b));
    const limit = Math.min(k, 10);
    const selected: Ranked[] = [];
    const recipes = new Set<string>();
    const picked = new Set<string>();
    const take = (r: Ranked) => { selected.push(r); recipes.add(r.doc.exemplar.recipe); picked.add(r.doc.exemplar.id); };
    for (const r of ranked) if (selected.length < limit && !recipes.has(r.doc.exemplar.recipe)) take(r);
    // Only when there are fewer eligible recipes than slots: a second design of a recipe, and a
    // language twin of a chosen design last of all.
    for (const r of ranked) if (selected.length < limit && !picked.has(r.doc.exemplar.id) &&
      !selected.some(s => s.doc.exemplar.pairedWith === r.doc.exemplar.id || r.doc.exemplar.pairedWith === s.doc.exemplar.id)) take(r);
    for (const r of ranked) if (selected.length < limit && !picked.has(r.doc.exemplar.id)) take(r);
    const retrievedExemplars = selected.map(toMatch);
    const warnings = wanted.size && selected.some(r => subjectMatches.get(r)!.length) ? [] :
      ['NO_SUBJECT_MATCH: photo exemplars were chosen by eligible recipe, text evidence and curator order.'];
    return { brief: brief.text, retrievedExemplars, retrievedIds: retrievedExemplars.map(e => e.id),
      executionTimeMs: performance.now() - start, apiCostUsd: 0, fromCache,
      evidence: { algorithm: PHOTO_EXEMPLAR_RETRIEVAL_VERSION, manifestSha256: this.manifestSha256, mode: 'photo_recipe',
        queryTokenCount: query.length, matchedTokenCount: matched.size, eligibleCount: documents.length,
        matches: selected.map(r => ({ id: r.doc.exemplar.id, lexicalScore: r.lexicalScore, matchedTokens: r.matchedTokens,
          formatMatch: r.formatMatch, recipe: r.doc.exemplar.recipe as PhotoRecipeId, subjectMatches: subjectMatches.get(r)! })),
        warnings },
    };
  }
}
