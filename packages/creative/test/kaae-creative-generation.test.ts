import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  getCanonicalBrandKit,
  validateBrandKitContrast,
  CreativeDirectorRunner,
  BriefBuilder,
  buildKaaeCertificateOperations,
  buildKaaeAnnouncementOperations,
  buildKaaeMandateOperations,
  buildKaaeHigherEdStandardsOperations,
  buildKaaeStrategicRoadmapOperations,
  KAAE_MANDATE_BUZZ_MAPPING,
  KAAE_STANDARDS_BUZZ_MAPPING,
  KAAE_ROADMAP_BUZZ_MAPPING,
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
      expect(kit.typography.latinFont).toBe('Minion Variable Concept');
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

  describe('Part 2: Authoritative Accreditation Certificate Template (KaaeCert3.pdf)', () => {
    it('generates complete A4 landscape accreditation certificate operations', () => {
      const ops = buildKaaeCertificateOperations({
        recipientName: 'زانکۆی سەلاحەدین - هەولێر',
        programName: 'کۆلێژی پزیشکی - متمانەبەخشی نیشتمانی تەواو',
        issueDate: '2026-09-06',
        startDate: '2025-09-01',
        endDate: '2030-08-31',
        language: 'ckb',
      });

      expect(ops.length).toBeGreaterThanOrEqual(10);

      // Verify canvas boundaries match 300DPI A4 Landscape (3508 x 2480)
      const bgOp = ops.find((o) => o.op === 'addVector' && o.nodeId === 'cert_bg');
      expect(bgOp).toBeDefined();
      expect(bgOp?.width).toBe(3508);
      expect(bgOp?.height).toBe(2480);
      expect(bgOp?.locked).toBe(true);

      // Verify Double Security Frame (Outer Blue + Inner Gold)
      const bordersOp = ops.find((o) => o.op === 'addVector' && o.nodeId === 'cert_borders');
      expect(bordersOp).toBeDefined();
      expect(bordersOp?.source).toContain('#4770A3');
      expect(bordersOp?.source).toContain('#D4A94C');

      // Verify Official Cryptographic Emblem (Invariant 4)
      const logoOp = ops.find((o) => o.op === 'addImage' && o.nodeId === 'cert_official_logo');
      expect(logoOp).toBeDefined();
      expect(logoOp?.asset.sha256).toBe(KAAE_PRIMARY_LOGO_SHA256);
      expect(logoOp?.asset.storageKey).toBe(`assets/logos/${KAAE_PRIMARY_LOGO_SHA256}.png`);

      // Verify Live Editable Recipient and Program Text (Invariant 1 & 3)
      const recipientOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'cert_recipient');
      expect(recipientOp).toBeDefined();
      expect(recipientOp?.text).toBe('زانکۆی سەلاحەدین - هەولێر');
      expect(recipientOp?.locked).toBe(false);

      const programOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'cert_program_name');
      expect(programOp).toBeDefined();
      expect(programOp?.text).toBe('کۆلێژی پزیشکی - متمانەبەخشی نیشتمانی تەواو');
      expect(programOp?.locked).toBe(false);

      // Verify Statutory Authority & Signature Block
      const authorityOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'cert_statutory_badge');
      expect(authorityOp).toBeDefined();
      expect(authorityOp?.text).toContain('یاسای ژمارە (٦)ی ساڵی ٢٠٢٢');

      const sigOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'cert_sign_name');
      expect(sigOp).toBeDefined();
      expect(sigOp?.text).toContain('Dr. Honar Issa');
    });
  });

  describe('Part 3: Social Announcement Feed Card Template (1080 x 1350)', () => {
    it('generates high-end social announcement feed operations with Kurdish typography', () => {
      const ops = buildKaaeAnnouncementOperations({
        headlineCkb: 'متمانەبەخشین بە کۆلێژی پزیشکی زانکۆی سلێمانی',
        headlineEn: 'Accreditation Granted to College of Medicine, University of Sulaimani',
        copyCkb: 'دەستەی متمانەبەخشی بە پەروەردە و خوێندنی باڵا بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢.',
        categoryBadge: 'بڕیاری فەرمی · OFFICIAL ACCREDITATION',
      });

      expect(ops.length).toBeGreaterThanOrEqual(10);

      // Verify canvas boundaries match 1080 x 1350
      const bgOp = ops.find((o) => o.op === 'addVector' && o.nodeId === 'ann_bg');
      expect(bgOp).toBeDefined();
      expect(bgOp?.width).toBe(1080);
      expect(bgOp?.height).toBe(1350);
      expect(bgOp?.source).toContain('#0A1628'); // Midnight Navy

      // Verify Verified Logo Node
      const logoOp = ops.find((o) => o.op === 'addImage' && o.nodeId === 'ann_logo');
      expect(logoOp).toBeDefined();
      expect(logoOp?.asset.sha256).toBe(KAAE_PRIMARY_LOGO_SHA256);

      // Verify Kurdish Headline in Cairo (Display Typography)
      const headlineOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_headline_ckb');
      expect(headlineOp).toBeDefined();
      expect(headlineOp?.text).toBe('متمانەبەخشین بە کۆلێژی پزیشکی زانکۆی سلێمانی');
      expect(headlineOp?.style?.fontFamily).toBe('Cairo');
      expect(headlineOp?.style?.textAlign).toBe('right');
      expect(headlineOp?.locked).toBe(false);

      // Verify Statutory Badge
      const badgeOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_category_badge');
      expect(badgeOp).toBeDefined();
      expect(badgeOp?.text).toBe('بڕیاری فەرمی · OFFICIAL ACCREDITATION');

      // Verify Law No. 6 of 2022 Statutory Citation Block
      const statutoryOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_statutory_rule');
      expect(statutoryOp).toBeDefined();
      expect(statutoryOp?.text).toContain('یاسای ژمارە (٦)ی ساڵی ٢٠٢٢');
      expect(statutoryOp?.text).toContain('Law No. 6 of 2022');

      // Verify Official Web Address
      const webOp = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_footer_tokens');
      expect(webOp).toBeDefined();
      expect(webOp?.text).toContain('www.kaae.org');
    });
  });

  describe('Part 4: Creative Director Runner Routing & Dispatch', () => {
    const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';

    it('generates studio operations with KAAE brand overrides for typography and background', () => {
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

        // Verify background is KAAE Midnight Navy (#0A1628)
        const bgOp = ops.find((o) => o.nodeId === 'node_bg');
        expect(bgOp).toBeDefined();
        expect(bgOp?.source).toContain('#0A1628');

        // Verify logo references KAAE verified SHA
        const logoOp = ops.find((o) => o.nodeId === 'node_logo');
        expect(logoOp).toBeDefined();
        expect(logoOp?.asset?.sha256).toBe(KAAE_PRIMARY_LOGO_SHA256);

        // Verify Kurdish headline uses Cairo font
        const headlineTextOp = ops.find((o) => o.op === 'addText' && o.role === 'headline');
        expect(headlineTextOp).toBeDefined();
        expect(headlineTextOp?.style?.fontFamily).toBe('Cairo');
      }
    });

    it('dispatches to specialized certificate template via generateKaaeOperations', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-cert-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Issue Institutional Certificate',
        rawRequestText: 'بڕوانامەی متمانەبەخشی بۆ زانکۆی کۆیە',
      });

      if (briefRes.ok) {
        const ops = director.generateKaaeOperations(briefRes.value, 'certificate', {
          recipientName: 'زانکۆی کۆیە',
          programName: 'کۆلێژی ئەندازیاری',
          issueDate: '2026-09-06',
        });

        expect(ops.length).toBeGreaterThan(0);
        const recipient = ops.find((o) => o.op === 'addText' && o.nodeId === 'cert_recipient');
        expect(recipient?.text).toBe('زانکۆی کۆیە');
      }
    });

    it('dispatches to specialized announcement template via generateKaaeOperations', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-ann-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Social Announcement',
        rawRequestText: 'ڕاگەیاندنی وەرگرتنی متمانەبەخشین',
      });

      if (briefRes.ok) {
        const ops = director.generateKaaeOperations(briefRes.value, 'announcement', {
          headlineCkb: 'ڕاگەیاندنی فەرمی نوێ',
        });

        expect(ops.length).toBeGreaterThan(0);
        const headline = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_headline_ckb');
        expect(headline?.text).toBe('ڕاگەیاندنی فەرمی نوێ');
      }
    });

    it('enforces strict language canon: English brief produces 100% English design with zero Kurdish text', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-english-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'English Official Announcement',
        rawRequestText: 'National Standards for Quality Assurance in Education',
        languageHint: 'en',
      });

      if (briefRes.ok) {
        const brief = { ...briefRes.value, primaryLanguage: 'en' as const, direction: 'ltr' as const };
        const ops = director.generateKaaeOperations(brief, 'announcement', {
          headlineEn: 'National Standards for Quality Assurance in Education',
          copyEn: 'Official national standards for higher education launch.',
        });

        expect(ops.length).toBeGreaterThan(0);
        const kurdishHeadline = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_headline_ckb');
        expect(kurdishHeadline).toBeUndefined();

        const kurdishCopy = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_body_ckb');
        expect(kurdishCopy).toBeUndefined();

        const badge = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_category_badge');
        expect(badge?.text).toBe('KAAE OFFICIAL · ACCREDITATION COMMISSION');

        // Check that none of the text elements contain Kurdish characters
        const textOps = ops.filter((o) => o.op === 'addText');
        for (const t of textOps) {
          expect(/[\u0600-\u06FF]/.test((t as any).text)).toBe(false);
        }
      }
    });

    it('dispatches to authentic mandate template via generateKaaeOperations', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-mandate-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Statutory Mandate Notice',
        rawRequestText: 'Institutional Accreditation Mandate',
      });

      if (briefRes.ok) {
        const ops = director.generateKaaeOperations(briefRes.value, 'mandate', {
          headlineEn: 'Custom Institutional Accreditation Mandate',
        });

        expect(ops.length).toBeGreaterThanOrEqual(12);
        const bg = ops.find((o) => o.op === 'addVector' && o.nodeId === 'mandate_bg');
        expect(bg?.source).toContain('#FDF8F3'); // Authentic Cream
        const headline = ops.find((o) => o.op === 'addText' && o.nodeId === 'mandate_headline_en');
        expect(headline?.text).toBe('Custom Institutional Accreditation Mandate');
      }
    });

    it('dispatches to authentic standards template via generateKaaeOperations', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-std-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Higher Education Quality Standards',
        rawRequestText: 'Standards of Higher Education',
      });

      if (briefRes.ok) {
        const ops = director.generateKaaeOperations(briefRes.value, 'standards');
        expect(ops.length).toBeGreaterThanOrEqual(15);
        const bg = ops.find((o) => o.op === 'addVector' && o.nodeId === 'std_bg');
        expect(bg?.height).toBe(1350); // 4:5
        expect(bg?.source).toContain('#0A1628');
        expect(bg?.source).toContain('#1E3A5F');
      }
    });

    it('dispatches to authentic roadmap template via generateKaaeOperations', () => {
      const briefRes = briefBuilder.build({
        taskId: 'task-kaae-road-001',
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Strategic Roadmap 2026-2028',
        rawRequestText: 'Three-Year Strategic Roadmap',
      });

      if (briefRes.ok) {
        const ops = director.generateKaaeOperations(briefRes.value, 'roadmap');
        expect(ops.length).toBeGreaterThanOrEqual(16);
        const headline = ops.find((o) => o.op === 'addText' && o.nodeId === 'roadmap_headline_en');
        expect(headline?.text).toContain('Three-Year Strategic Roadmap');
      }
    });
  });

  describe('Part 5: Figma Buzz Field Mappings & Ground-Truth Tokens', () => {
    it('verifies KAAE Mandate Buzz Field Mapping conformity', () => {
      expect(KAAE_MANDATE_BUZZ_MAPPING.templateId).toBe('kaae_mandate');
      expect(KAAE_MANDATE_BUZZ_MAPPING.targetAspectRatios).toContain('1:1');
      expect(KAAE_MANDATE_BUZZ_MAPPING.textFields.headlineEn).toContain('Institutional Accreditation Mandate');
      expect(KAAE_MANDATE_BUZZ_MAPPING.mediaFields.logo.sha256).toBe(KAAE_PRIMARY_LOGO_SHA256);
    });

    it('verifies KAAE Standards Buzz Field Mapping conformity', () => {
      expect(KAAE_STANDARDS_BUZZ_MAPPING.templateId).toBe('kaae_standards');
      expect(KAAE_STANDARDS_BUZZ_MAPPING.targetAspectRatios).toContain('4:5');
      expect(KAAE_STANDARDS_BUZZ_MAPPING.textFields.std1Title).toContain('Mission, Governance');
    });

    it('verifies KAAE Roadmap Buzz Field Mapping conformity', () => {
      expect(KAAE_ROADMAP_BUZZ_MAPPING.templateId).toBe('kaae_roadmap');
      expect(KAAE_ROADMAP_BUZZ_MAPPING.targetAspectRatios).toContain('1:1');
      expect(KAAE_ROADMAP_BUZZ_MAPPING.textFields.phase1Title).toBe('Comprehensive Institutional Audits');
    });
  });
});
