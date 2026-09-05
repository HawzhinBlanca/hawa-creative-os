import { describe, it, expect } from 'vitest';
import {
  VaultSearchEngine,
  normalizeSearchToken,
  extractSearchTokens,
  type SearchableItem,
} from '../src/search-engine.js';

describe('Universal Multi-Tenant Search Engine (FR-077, Invariant #6, Gate B)', () => {
  const seedItems: SearchableItem[] = [
    {
      id: 'task-drustee-101',
      category: 'tasks',
      clientId: 'client-drustee',
      clientName: 'Drustee Evidence-First Health',
      title: 'Spring Omnichannel Campaign',
      subtitle: 'کەمپینی بەهاری دروستی بۆ تەندروستی',
      bodyText: 'Special promotion on Omega 3 and Vitamin D3 across Erbil and Sulaymaniyah pharmacies.',
      tags: ['campaign', 'spring', 'omega3'],
      status: 'APPROVED',
      updatedAt: '2026-09-05T10:00:00Z',
    },
    {
      id: 'task-aster-202',
      category: 'tasks',
      clientId: 'client-aster',
      clientName: 'Aster Hotel & Resort',
      title: 'Luxury Weekend Suite Package',
      subtitle: 'ئۆفەری تایبەتی پشووی کۆتایی هەفتە لە هەولێر',
      bodyText: 'Book standard and deluxe suites with complimentary breakfast and mountain view.',
      tags: ['hotel', 'hospitality', 'suites'],
      status: 'PUBLISHED',
      updatedAt: '2026-09-05T11:00:00Z',
    },
    {
      id: 'asset-drustee-logo',
      category: 'assets',
      clientId: 'client-drustee',
      clientName: 'Drustee Evidence-First Health',
      title: 'drustee-official-logo.svg',
      subtitle: 'Master Brand Logo Vector',
      bodyText: 'Official vector SVG mark for Drustee healthcare with emerald accent #059669.',
      tags: ['logo', 'vector', 'emerald'],
      metadata: { sha256: 'a1b2c3d4e5f67890...' },
      updatedAt: '2026-09-04T12:00:00Z',
    },
    {
      id: 'rule-drustee-claims',
      category: 'rules',
      clientId: 'client-drustee',
      clientName: 'Drustee Evidence-First Health',
      title: 'Verified Medical Claims Rule',
      subtitle: 'ڕێسای پشتڕاستکردنەوەی وتەی پزیشکی',
      bodyText: 'Never state cures disease without explicit MOH/KRG approval documentation.',
      tags: ['compliance', 'medical', 'disclaimer'],
      status: 'ACTIVE',
      updatedAt: '2026-09-05T09:00:00Z',
    },
  ];

  it('tokenizes and normalizes Kurdish Sorani and Arabic variations identically', () => {
    // Arabic Kaf vs Kurdish Kaf
    expect(normalizeSearchToken('كەمپین')).toBe(normalizeSearchToken('کەمپین'));
    // Arabic Yeh vs Kurdish Yeh
    expect(normalizeSearchToken('تەندروستي')).toBe(normalizeSearchToken('تەندروستی'));
    // Eastern Arabic numerals vs Western digits
    expect(normalizeSearchToken('٢٠٢٦')).toBe('2026');
    expect(normalizeSearchToken('١٠١')).toBe('101');

    const tokens = extractSearchTokens('کەمپینی نوێی بەهار ۲۰۲۶');
    expect(tokens).toContain('کەمپینی');
    expect(tokens).toContain('نوێی');
    expect(tokens).toContain('بەهار');
    expect(tokens).toContain('2026');
  });

  it('Invariant #6: strictly isolates search results by client scope', () => {
    const engine = new VaultSearchEngine(seedItems);

    // Search for general term 'pharmacies' within client-drustee
    const drusteeResults = engine.search({
      q: 'pharmacies',
      clientId: 'client-drustee',
    });
    expect(drusteeResults.hits.length).toBe(1);
    expect(drusteeResults.hits[0].item.id).toBe('task-drustee-101');

    // Searching same term under client-aster MUST return ZERO results
    const asterResults = engine.search({
      q: 'pharmacies',
      clientId: 'client-aster',
    });
    expect(asterResults.hits.length).toBe(0);

    // Searching 'Erbil' or Kurdish 'هەولێر' under client-aster only returns Aster items
    const asterErbil = engine.search({
      q: 'هەولێر',
      clientId: 'client-aster',
    });
    expect(asterErbil.hits.length).toBe(1);
    expect(asterErbil.hits[0].item.clientId).toBe('client-aster');
  });

  it('filters accurately by category (tasks, assets, rules)', () => {
    const engine = new VaultSearchEngine(seedItems);

    // Filter by assets only
    const assetSearch = engine.search({
      q: 'Drustee',
      clientId: 'client-drustee',
      category: 'assets',
    });
    expect(assetSearch.hits.length).toBe(1);
    expect(assetSearch.hits[0].item.category).toBe('assets');
    expect(assetSearch.hits[0].item.title).toBe('drustee-official-logo.svg');

    // Filter by rules only
    const ruleSearch = engine.search({
      q: 'Drustee',
      clientId: 'client-drustee',
      category: 'rules',
    });
    expect(ruleSearch.hits.length).toBe(1);
    expect(ruleSearch.hits[0].item.category).toBe('rules');
  });

  it('ranks exact ID and title matches ahead of body matches with sub-15ms speed', () => {
    const engine = new VaultSearchEngine(seedItems);

    const res = engine.search({
      q: 'task-drustee-101',
      clientId: 'client-drustee',
    });

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].item.id).toBe('task-drustee-101');
    expect(res.hits[0].score).toBeGreaterThan(20);
    expect(res.tookMs).toBeLessThan(15);
  });
});
