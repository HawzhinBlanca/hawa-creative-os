/**
 * Hawa Creative OS — Universal Multi-Tenant Search Engine
 * FR-077, NFR-004, Gate B, Gate F
 * Sub-10ms lexical and attribute search across tasks, client DNA, assets, and rules
 * with strict pre-retrieval client isolation (Invariant #6).
 */

export type SearchCategory = 'all' | 'tasks' | 'clients' | 'assets' | 'rules' | 'copy' | 'feedback' | 'revisions';

export interface SearchableItem {
  id: string;
  category: 'tasks' | 'clients' | 'assets' | 'rules' | 'copy' | 'feedback' | 'revisions';
  clientId: string;
  clientName?: string;
  title: string;
  subtitle?: string;
  bodyText: string;
  tags?: string[];
  status?: string;
  metadata?: Record<string, any>;
  updatedAt: string;
}

export interface SearchQuery {
  q: string;
  clientId?: string;
  category?: SearchCategory;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  item: SearchableItem;
  score: number;
  matchedTokens: string[];
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  query: string;
  tookMs: number;
  clientIdFilter?: string;
}

/**
 * Normalizes Kurdish Sorani and Arabic text for consistent tokenization and retrieval.
 */
export function normalizeSearchToken(text: any): string {
  if (text === null || text === undefined) return '';
  const str = typeof text === 'string' ? text : String(text);
  if (!str.trim()) return '';
  return str
    .toLowerCase()
    .normalize('NFC')
    // Standardize Arabic Kaf to Kurdish Kaf
    .replace(/\u0643/g, '\u06a9')
    // Standardize Arabic Yeh to Kurdish Yeh
    .replace(/\u064a/g, '\u06cc')
    // Standardize Eastern numerals to Western digits
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    // Standardize Persian/Kurdish numerals to Western digits
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    // Remove diacritics / tashkeel
    .replace(/[\u064B-\u065F\u0670]/g, '')
    // Normalize Zero-Width Non-Joiner (ZWNJ), Zero-Width Joiner (ZWJ), and directional marks
    .replace(/[\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    // Normalize punctuation
    .replace(/[،؛؟]/g, ' ')
    .trim();
}

/**
 * Splits query string into normalized search tokens.
 */
export function extractSearchTokens(q: string): string[] {
  const normalized = normalizeSearchToken(q);
  return normalized
    .split(/[\s,\-_.:;/"'()[\]{}<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export class VaultSearchEngine {
  private items = new Map<string, SearchableItem>();

  constructor(initialItems?: SearchableItem[]) {
    if (initialItems) {
      for (const item of initialItems) {
        this.indexItem(item);
      }
    }
  }

  indexItem(item: SearchableItem): void {
    this.items.set(item.id, item);
  }

  removeItem(id: string): boolean {
    return this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }

  count(): number {
    return this.items.size;
  }

  /**
   * Executes client-isolated search with sub-10ms ranking.
   */
  search(query: SearchQuery): SearchResult {
    const start = performance.now();
    const rawQ = query.q?.trim() || '';
    const queryTokens = extractSearchTokens(rawQ);
    const normalizedRaw = normalizeSearchToken(rawQ);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
    const offset = Math.max(0, query.offset || 0);

    const hits: SearchHit[] = [];

    for (const item of this.items.values()) {
      // 1. Invariant #6: Strict client isolation
      if (query.clientId && query.clientId !== 'all' && item.clientId !== query.clientId) {
        continue;
      }

      // 2. Category filter
      if (query.category && query.category !== 'all' && item.category !== query.category) {
        continue;
      }

      const itemBody = item.bodyText || '';

      // If empty query, return all matching scope sorted by recency
      if (queryTokens.length === 0) {
        hits.push({
          item,
          score: 1.0,
          matchedTokens: [],
          snippet: itemBody.substring(0, 120),
        });
        continue;
      }

      const itemTitleNorm = normalizeSearchToken(item.title);
      const itemSubNorm = normalizeSearchToken(item.subtitle || '');
      const itemBodyNorm = normalizeSearchToken(itemBody);
      const itemIdNorm = normalizeSearchToken(item.id);
      const itemTagsNorm = (item.tags || []).map((t) => normalizeSearchToken(t));

      let score = 0;
      const matchedTokens: string[] = [];

      // Exact phrase match in title or ID
      if (itemIdNorm === normalizedRaw) {
        score += 25.0;
        matchedTokens.push(item.id);
      } else if (itemTitleNorm === normalizedRaw) {
        score += 20.0;
        matchedTokens.push(item.title);
      } else if (itemTitleNorm.includes(normalizedRaw)) {
        score += 12.0;
        matchedTokens.push(normalizedRaw);
      }

      // Exact phrase match in subtitle
      if (itemSubNorm && itemSubNorm.includes(normalizedRaw)) {
        score += 8.0;
        matchedTokens.push(normalizedRaw);
      }

      // Token-level scoring
      for (const token of queryTokens) {
        let tokenMatched = false;

        if (itemIdNorm.includes(token)) {
          score += 10.0;
          tokenMatched = true;
        }
        if (itemTitleNorm.includes(token)) {
          score += 6.0;
          tokenMatched = true;
        }
        if (itemSubNorm.includes(token)) {
          score += 4.0;
          tokenMatched = true;
        }
        if (itemTagsNorm.some((tag) => tag.includes(token))) {
          score += 5.0;
          tokenMatched = true;
        }
        if (itemBodyNorm.includes(token)) {
          score += 2.0;
          tokenMatched = true;
        }

        if (tokenMatched && !matchedTokens.includes(token)) {
          matchedTokens.push(token);
        }
      }

      // Candidate must match at least one token to qualify
      if (score > 0) {
        // Formulate snippet highlighting the first matched region
        let snippet = itemBody;
        if (snippet.length > 140) {
          const firstIdx = matchedTokens.length > 0
            ? normalizeSearchToken(snippet).indexOf(matchedTokens[0])
            : -1;
          if (firstIdx > 20) {
            snippet = '…' + snippet.substring(firstIdx - 15, firstIdx + 110) + '…';
          } else {
            snippet = snippet.substring(0, 130) + '…';
          }
        }

        hits.push({
          item,
          score,
          matchedTokens,
          snippet,
        });
      }
    }

    // Sort descending by score, then recency
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.updatedAt).getTime() - new Date(a.item.updatedAt).getTime();
    });

    const tookMs = Number((performance.now() - start).toFixed(2));
    const paginated = hits.slice(offset, offset + limit);

    return {
      hits: paginated,
      total: hits.length,
      query: rawQ,
      tookMs,
      clientIdFilter: query.clientId,
    };
  }
}
