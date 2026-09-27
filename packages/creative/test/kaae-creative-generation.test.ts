import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  getCanonicalBrandKit,
  validateBrandKitContrast,
  CreativeDirectorRunner,
  BriefBuilder,
  KAAE_PRIMARY_LOGO_SHA256,
  KAAE_SYMBOL_SHA256,
} from '../src/index.js';
import { kaaeClientDNA, validateClientDna } from '@hawa/domain';

describe('KAAE Pro Brand DNA & Creative Generation Suite', () => {
  const director = new CreativeDirectorRunner();
  const briefBuilder = new BriefBuilder();

  describe('Part 1: Canonical Brand Kit & Domain Model Verification', () => {
    it('validates kaaeClientDNA passes domain model validation', () => {
      const validation = validateClientDna(kaaeClientDNA);
      expect(validation.ok).toBe(true);
      if (validation.ok) {
        expect(validation.value.code).toBe('KAAE');
        expect(validation.value.defaultLocale).toBe('en');
        expect(validation.value.defaultDirection).toBe('ltr');
        expect(validation.value.assets.length).toBe(4);
      }
    });

    it('loads canonical KAAE brand kit with official institutional design tokens', () => {
      const kit = getCanonicalBrandKit('kaae');
      expect(kit.name).toBe('Kurdistan Accrediting Association for Education');
      expect(kit.nameKurdish).toBe('دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا');
      expect(kit.palette.primary).toBe('#4770A3');   // KAAE Blue (Pantone 5415 C)
      expect(kit.palette.secondary).toBe('#0A1628'); // Midnight Navy
      expect(kit.palette.accent).toBe('#F7B500');    // Sunburst Gold (Pantone 7549 C)
      expect(kit.palette.background).toContain('#0A1628'); // Deep Midnight Gradient
      expect(kit.verifiedSha256).toBe(KAAE_PRIMARY_LOGO_SHA256);
      expect(kit.typography.latinFont).toBe('Verdana');
      expect(kit.typography.kurdishFont).toBe('Cairo');
      expect(kit.contactTokens).toContain('60m Street, Erbil');
      expect(kit.contactTokens).toContain('info@kaae.krd');
      expect(kit.contactTokens).toContain('www.kaae.org');
    });

    it('validates WCAG 2.2 AAA contrast standards for KAAE brand palette', () => {
      const kit = getCanonicalBrandKit('kaae');
      const contrast = validateBrandKitContrast(kit);
      expect(contrast.isAccessible).toBe(true);
      expect(contrast.contrastRatio).toBeGreaterThanOrEqual(7.0);
    });

    it('verifies physical asset files on disk match verified SHA-256 checksums', () => {
      const logosDir = path.resolve(__dirname, '../../../apps/desk/public/assets/logos');

      const filesToCheck = [
        {
          name: 'kaae-logo-primary.png',
          expectedSha: KAAE_PRIMARY_LOGO_SHA256,
        },
        {
          name: 'kaae-symbol.png',
          expectedSha: KAAE_SYMBOL_SHA256,
        },
        {
          name: 'kaae-logo-primary.svg',
          expectedSha: 'accadd24fd04d26d8e700ef2fb07ce50f128beb2924562d7cc4a5b02e4670be7',
        },
        {
          name: 'kaae-symbol.svg',
          expectedSha: '935f3f5820d6dd293e5fd86d66bee959b0941d22f7a085cddeb37f8969d778fc',
        },
      ];

      for (const item of filesToCheck) {
        const filePath = path.join(logosDir, item.name);
        expect(fs.existsSync(filePath), `Asset ${item.name} must exist on disk`).toBe(true);
        const buffer = fs.readFileSync(filePath);
        const actualSha = crypto.createHash('sha256').update(buffer).digest('hex');
        expect(actualSha, `SHA-256 of ${item.name} must match canonical record`).toBe(item.expectedSha);
      }
    });
  });

  describe('Part 4: Creative Director Runner Routing & Dispatch', () => {
    const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';

    it("draws KAAE with no KAAE styling of its own: its v1 templates and overrides are retired (ADR-038)", () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Official KAAE Accreditation Notice',
        rawRequestText: 'متمانەبەخشین بە زانکۆی نوێ لە هەرێمی کوردستان',
      });

      expect(briefRes.ok).toBe(true);
      if (briefRes.ok) {
        const plan = director.createDesignPlan(briefRes.value, ['#4770a3', '#0A1628', '#F7B500']);
        const ops = director.generateStudioOperations(briefRes.value, plan, KAAE_PRIMARY_LOGO_SHA256);
        expect(ops.length).toBeGreaterThan(0);
        // The generic legacy draft, the same for every client: KAAE's designs come from the studio.
        expect(ops.find((o) => o.nodeId === 'node_bg')?.source).not.toContain('#0A1628');
        expect(ops.find((o) => o.nodeId === 'node_logo')?.width).toBe(240);
        // It draws the logo it is handed, and no other.
        expect(ops.find((o) => o.nodeId === 'node_logo')?.asset?.sha256).toBe(KAAE_PRIMARY_LOGO_SHA256);
      }
    });

    it('has no KAAE template to fall back to for a brand it does not know', () => {
      const briefRes = briefBuilder.build({ taskId: 't', clientId: 'client-nova', clientDnaVersion: 1, objective: 'Launch', rawRequestText: 'Launch' });
      expect(briefRes.ok).toBe(true);
      if (briefRes.ok) {
        expect(() => director.generateCommercialBrandOperations('nova', briefRes.value)).toThrow(/made in the design studio/);
        expect((director as unknown as Record<string, unknown>).generateKaaeOperations).toBeUndefined();
      }
    });
  });

});
