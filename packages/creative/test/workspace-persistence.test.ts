import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeDocumentHash,
  persistWorkingDraft,
  loadWorkingDraft,
  type SavedCanvasDraft,
} from '../../../apps/desk/src/services/draftStorage.js';
import {
  BRAND_KITS,
  saveCustomBrandKit,
  getCustomBrandKits,
  getAllBrandKits,
  type BrandKit,
} from '../../../apps/desk/src/services/brandKits.js';

describe('Horizon 4: Client Workspace Persistence & Brand Kit Customizer', () => {
  // Mock localStorage for Node test environment
  const mockStorage: Record<string, string> = {};
  beforeEach(() => {
    for (const k in mockStorage) delete mockStorage[k];
    (globalThis as any).localStorage = {
      getItem: (k: string) => mockStorage[k] || null,
      setItem: (k: string, v: string) => { mockStorage[k] = v; },
      removeItem: (k: string) => { delete mockStorage[k]; },
    };
  });

  describe('Cryptographic Document Hashing', () => {
    it('generates deterministic sha256 signatures for document manifests', async () => {
      const manifest1 = JSON.stringify({ headline: 'Hello', format: 'feed' });
      const manifest2 = JSON.stringify({ headline: 'Hello', format: 'feed' });
      const manifestDifferent = JSON.stringify({ headline: 'World', format: 'feed' });

      const hash1 = await computeDocumentHash(manifest1);
      const hash2 = await computeDocumentHash(manifest2);
      const hashDiff = await computeDocumentHash(manifestDifferent);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hashDiff);
      expect(hash1.startsWith('sha256_')).toBe(true);
    });
  });

  describe('Working Draft Persistence & Hydration', () => {
    it('persists draft to local storage backup and loads it accurately', async () => {
      const sampleDraft: SavedCanvasDraft = {
        id: 'draft_test_123',
        taskId: 'task_abc',
        clientId: 'sebar',
        headlineEn: 'Pure Strength',
        headlineCkb: 'هێزی ڕاستەقینە',
        copyEn: '$28.00 USD',
        copyCkb: '٣٨٬٠٠٠ دینار',
        fontFamily: 'Inter',
        fontWeight: 800,
        accentColor: '#F59E0B',
        brandKitId: 'sebar',
        format: 'feed',
        langVariant: 'bilingual',
        nodes: [{ id: 'n1', role: 'headline', x: 20, y: 30, width: 400, height: 80 }],
        zoom: 1.25,
        panOffset: { x: 40, y: -20 },
        selectedNodeIds: ['n1'],
        updatedAt: Date.now(),
      };

      await persistWorkingDraft(sampleDraft);
      const loaded = await loadWorkingDraft('draft_test_123');

      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe('draft_test_123');
      expect(loaded?.headlineEn).toBe('Pure Strength');
      expect(loaded?.headlineCkb).toBe('هێزی ڕاستەقینە');
      expect(loaded?.zoom).toBe(1.25);
      expect(loaded?.selectedNodeIds).toContain('n1');
      expect(loaded?.sha256Proof).toBeDefined();
    });
  });

  describe('Brand Kit Customizer & Persistence', () => {
    it('creates and persists a custom client brand kit', () => {
      const customKit: BrandKit = {
        id: 'custom_slemani_cafe',
        name: 'Slemani Roast & Coffee',
        nameKurdish: 'قاوەخانەی سلێمانی',
        industry: 'Food & Beverage',
        industryKurdish: 'خواردنەوە و کافێ',
        verifiedSha256: 'sha256_slemani_roast_sig_882a',
        palette: {
          primary: '#6F4E37', // Coffee Brown
          secondary: '#2C1B10',
          accent: '#D4AF37', // Gold
          background: 'linear-gradient(135deg, #2C1B10 0%, #6F4E37 100%)',
          text: '#FFFFFF',
          cardBg: 'rgba(255, 255, 255, 0.92)',
        },
        typography: {
          latinFont: 'Inter',
          kurdishFont: 'Vazirmatn',
          headlineWeight: 800,
          copyWeight: 700,
        },
        logoText: 'SLEMANI ROAST',
        logoBadge: '☕ PREMIUM ARABICA',
        defaultHeadlineEn: 'Crafted with Passion in Slemani',
        defaultHeadlineCkb: 'بە خۆشەویستی دروستکراوە لە سلێمانی',
        defaultCopyEn: 'Specialty Latte · $4.00',
        defaultCopyCkb: 'لاتێی تایبەت · ٥٬٥٠٠ دینار',
        contactTokens: ['0770 123 4567', 'Salim St, Sulaymaniyah', 'roast.krd'],
      };

      saveCustomBrandKit(customKit);
      const retrieved = getCustomBrandKits();
      expect(retrieved.custom_slemani_cafe).toBeDefined();
      expect(retrieved.custom_slemani_cafe.name).toBe('Slemani Roast & Coffee');

      const allKits = getAllBrandKits();
      expect(allKits.sebar).toBeDefined();
      expect(allKits.custom_slemani_cafe).toBeDefined();
      expect(Object.keys(allKits).length).toBeGreaterThan(Object.keys(BRAND_KITS).length);
    });
  });
});
