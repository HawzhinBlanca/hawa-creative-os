import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { RequestContext } from '@hawa/contracts';
import { FakeFigmaBridge } from '../src/fake-figma-bridge.js';
import { DeterministicQAEngine } from '@hawa/qa';
import { DesignRouter } from '@hawa/creative';
import { FakePublisher } from '../src/fake-publisher.js';

describe('Figma Agent Studio v2.0 Qualification Suite', () => {
  let bridge: FakeFigmaBridge;
  let qaEngine: DeterministicQAEngine;
  let router: DesignRouter;
  let publisher: FakePublisher;

  const defaultContext: RequestContext = {
    tenantId: 'tenant-default',
    clientId: 'c1000000-0000-4000-8000-000000000002', // KAAE
    taskId: 'task-figma-001',
    actor: { type: 'model', id: 'creative_creator' },
    correlationId: crypto.randomUUID(),
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idem_figma_001',
  };

  beforeEach(() => {
    bridge = new FakeFigmaBridge();
    qaEngine = new DeterministicQAEngine();
    router = new DesignRouter();
    publisher = new FakePublisher();
  });

  describe('Gate 1: Figma Task Write Leases (FR-021, FR-022, Invariant #5)', () => {
    it('acquires write lease for authorized creator with TTL', async () => {
      const res = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.holder).toBe('creative_creator');
        expect(res.value.fileKey).toBe('figma_kaae_master_library');
        expect(res.value.releasedAt).toBeUndefined();
      }
    });

    it('rejects concurrent write lease from another actor on same task', async () => {
      // 1. First actor acquires lease
      await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);

      // 2. Second actor tries to acquire lease on same task
      const competitorContext: RequestContext = {
        ...defaultContext,
        actor: { type: 'model', id: 'competitor_agent' },
      };
      const res = await bridge.acquireLease(competitorContext, 'figma_kaae_master_library', 3600);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('LEASE_ALREADY_HELD');
      }
    });

    it('allows same holder to refresh active lease expiration', async () => {
      const first = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 1800);
      expect(first.ok).toBe(true);

      const renewed = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(renewed.ok).toBe(true);
      if (first.ok && renewed.ok) {
        expect(renewed.value.id).toBe(first.value.id);
        expect(new Date(renewed.value.expiresAt).getTime()).toBeGreaterThan(new Date(first.value.expiresAt).getTime());
      }
    });

    it('releasing lease allows another actor to acquire it', async () => {
      const first = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(first.ok).toBe(true);
      if (first.ok) {
        await bridge.releaseLease(defaultContext, first.value.id);
      }

      const competitorContext: RequestContext = {
        ...defaultContext,
        actor: { type: 'user', id: 'art_director' },
      };
      const second = await bridge.acquireLease(competitorContext, 'figma_kaae_master_library', 3600);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.holder).toBe('art_director');
      }
    });
  });

  describe('Gate 2: Staging Area & Expected Revision Invariant (FR-020, FR-023, Invariant #14)', () => {
    it('rejects mutation command when lease is missing or invalid', async () => {
      const res = await bridge.mutate(defaultContext, {
        commandId: 'cmd_1',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId: 'non_existent_lease_id',
        expectedRevision: 0,
        operation: 'create_text',
        args: { text: 'Headline' },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('LEASE_EXPIRED_OR_INVALID');
      }
    });

    it('rejects mutation command when expected revision conflicts with current revision', async () => {
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      const leaseId = (leaseRes as any).value.id;

      // First mutation at rev 0 -> rev 1
      const mut1 = await bridge.mutate(defaultContext, {
        commandId: 'cmd_1',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0,
        operation: 'create_text',
        args: { text: 'Initial Headline' },
      });
      expect(mut1.ok).toBe(true);

      // Stale mutation still expecting rev 0
      const staleMut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_2_stale',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0, // Stale! Current is 1
        operation: 'replace_text',
        args: { text: 'Stale Headline' },
      });

      expect(staleMut.ok).toBe(false);
      if (!staleMut.ok) {
        expect(staleMut.error.code).toBe('STALE_REVISION_CONFLICT');
      }
    });

    it('rejects mutation command targeting wrong file key (f4 in figma_mutation_cases)', async () => {
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      const leaseId = (leaseRes as any).value.id;

      const wrongFileMut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_wrong_file',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'unauthorized_different_file_key',
        leaseId,
        expectedRevision: 0,
        operation: 'replace_text',
        args: { text: 'Hacked Headline' },
      });

      expect(wrongFileMut.ok).toBe(false);
      if (!wrongFileMut.ok) {
        expect(wrongFileMut.error.code).toBe('WRONG_FILE_FOR_LEASE');
      }
    });

    it('rejects mutation command when lease has expired (f5 in figma_mutation_cases)', async () => {
      // Lease with negative/zero TTL to simulate expiration
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', -10);
      expect(leaseRes.ok).toBe(true);
      const leaseId = (leaseRes as any).value.id;

      const expiredMut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_expired_lease',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0,
        operation: 'create_text',
        args: { text: 'Headline' },
      });

      expect(expiredMut.ok).toBe(false);
      if (!expiredMut.ok) {
        expect(expiredMut.error.code).toBe('LEASE_EXPIRED_OR_INVALID');
      }
    });

    it('rejects cross-client mutation attempt under Invariant #6', async () => {
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      const leaseId = (leaseRes as any).value.id;

      const crossClientMut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_cross_client',
        taskId: defaultContext.taskId!,
        clientId: 'c3000000-0000-4000-8000-000000000003', // Different client!
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0,
        operation: 'create_text',
        args: { text: 'Malicious Cross-Tenant Content' },
      });

      expect(crossClientMut.ok).toBe(false);
      if (!crossClientMut.ok) {
        expect(crossClientMut.error.code).toBe('CROSS_CLIENT_VIOLATION');
      }
    });

    it('strictly enforces Staging Confinement and rejects mutations targeting master components (Invariant #14)', async () => {
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      const leaseId = (leaseRes as any).value.id;

      const rogueMut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_rogue_master_mutation',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0,
        targetNodeId: '00_MASTER_COMPONENTS',
        operation: 'replace_text',
        args: { text: 'Rogue Override' },
      });

      expect(rogueMut.ok).toBe(false);
      if (!rogueMut.ok) {
        expect(rogueMut.error.code).toBe('STAGING_CONFINEMENT_VIOLATION');
      }
    });

    it('applies mutation sequentially and increments revision marker', async () => {
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      const leaseId = (leaseRes as any).value.id;

      const mut = await bridge.mutate(defaultContext, {
        commandId: 'cmd_seq_1',
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        fileKey: 'figma_kaae_master_library',
        leaseId,
        expectedRevision: 0,
        operation: 'create_text',
        args: { text: 'دەستەی باڵای متمانەبەخشین', font: 'Cairo' },
      });

      expect(mut.ok).toBe(true);
      if (mut.ok) {
        expect(mut.value.revision).toBe(1);
        expect(mut.value.markerId).toContain('marker_1');
        expect(mut.value.previewUrl).toContain('figma_kaae_master_library');
      }
    });
  });

  describe('Gate 3: Route A (Figma Buzz) & Route B (Figma Design) Routing', () => {
    it('routes recurring template match to buzz_template', () => {
      const brief = {
        briefId: 'b1',
        taskId: 't1',
        clientId: 'c1',
        clientDnaVersion: 1,
        objective: 'Post social card',
        taskRoute: 'template_fill' as const,
        primaryLanguage: 'ckb',
        direction: 'rtl' as const,
        variants: [{ id: 'v1', name: 'Card', width: 1080, height: 1350, aspectRatio: '4:5', role: 'social_post' }],
        exactCopy: [{ id: 'c1', role: 'headline' as const, text: 'بڕیاری متمانەبەخشین', language: 'ckb', direction: 'rtl' as const, approved: true, protectedTokens: [] }],
        missingFacts: [],
        requiredAssetRoles: ['logo_primary'],
        createdAt: new Date().toISOString(),
      };

      const res = router.resolveRoute(brief, [{ id: 'kaae_announcement_feed', category: 'social', matchScore: 0.95 }]);
      expect(res.route).toBe('template_fill');
      expect(res.figmaRoute).toBe('buzz_template');
      expect(res.requiresHumanReview).toBe(false);
    });

    it('routes complex campaign to figma_freeform with Creative Director', () => {
      const brief = {
        briefId: 'b2',
        taskId: 't2',
        clientId: 'c1',
        clientDnaVersion: 1,
        objective: 'Brand Launch Campaign 2026',
        taskRoute: 'creative_director' as const,
        primaryLanguage: 'ckb',
        direction: 'rtl' as const,
        variants: [{ id: 'v1', name: 'Poster', width: 1080, height: 1080, aspectRatio: '1:1', role: 'campaign' }],
        exactCopy: [],
        missingFacts: [],
        requiredAssetRoles: [],
        createdAt: new Date().toISOString(),
      };

      const res = router.resolveRoute(brief, []);
      expect(res.figmaRoute).toBe('figma_freeform');
      expect(res.requiresHumanReview).toBe(false);
    });

    it('creates Buzz asset with field replacement and smart resize', async () => {
      const buzzRes = await bridge.createBuzzAsset(defaultContext, 'template_kaae_social', {
        templateId: 'template_kaae_social',
        textFields: {
          headline: 'دەستپێکی پرۆسەی متمانەبەخشینی ٢٠٢٦',
          badge: 'ڕاگەیەندراوی فەرمی',
        },
        mediaFields: {
          hero_image: { storageKey: 'assets/gold_medal.jpg', sha256: 'sha256_mock_asset', fit: 'contain' },
        },
        targetAspectRatios: ['1:1', '4:5', '9:16'],
      });

      expect(buzzRes.ok).toBe(true);
      if (buzzRes.ok) {
        expect(buzzRes.value.nodeId).toBeDefined();

        const resizeRes = await bridge.smartResizeBuzz(defaultContext, buzzRes.value.nodeId, '9:16');
        expect(resizeRes.ok).toBe(true);
        if (resizeRes.ok) {
          expect(resizeRes.value.resizedNodeId).toContain('9x16');
        }
      }
    });
  });

  describe('Gate 4: Deterministic QA & Idempotent Google Publication Dispatch', () => {
    it('runs QA validation on staged nodes and ensures 100% exact copy fidelity', async () => {
      const exactCopyText = 'بڕوانامەی متمانەبەخشینی زانکۆی کوردستان';
      const stagedManifest = {
        pages: [{ id: 'p1', name: '30_AI_STAGING', width: 1080, height: 1080, unit: 'px', direction: 'rtl' }],
        nodes: [
          { id: 'node_title', pageId: 'p1', type: 'text', role: 'headline', text: exactCopyText, locked: false, zIndex: 1 },
        ],
        fonts: [{ family: 'Cairo', style: 'Bold' }],
        assets: [{ sha256: 'sha256_logo_verified', mimeType: 'image/svg+xml', sourceId: 'logo_primary' }],
        warnings: [],
      };

      const qaReport = await qaEngine.run(defaultContext, {
        tenantId: 'tenant-default',
        taskId: 'task-figma-001',
        manifest: stagedManifest as any,
        brief: {
          variants: [{ width: 1080, height: 1080 }],
          exactCopy: [{ id: 'c1', role: 'headline', text: exactCopyText, language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] }],
          requiredAssetRoles: ['logo_primary'],
        } as any,
        clientDna: {
          palette: { primary: '#0A1628', secondary: '#4770A3', accent: '#D4A94C', background: '#FFFFFF', text: '#0A1628' },
        } as any,
      });

      expect(qaReport.ok).toBe(true);
      if (qaReport.ok) {
        expect(qaReport.value.status).toBe('passed');
        expect(qaReport.value.criticalPass).toBe(true);
      }
    });

    it('dispatches publication idempotently to Google Drive destination with SHA-256 integrity', async () => {
      const exportRes = await bridge.exportNode(defaultContext, 'figma_kaae_master', 'node_staging_root', 'PNG');
      expect(exportRes.ok).toBe(true);

      const pubRes = await publisher.publish(defaultContext, {
        taskId: 'task-figma-001',
        clientId: defaultContext.clientId!,
        designRevisionId: 'rev-figma-001',
        approvalId: 'appr-figma-001',
        publicationKey: 'pub_key_figma_001',
        packageHash: 'sha256_mock_package_hash',
        destination: {
          sharedDriveId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr',
          productionRootFolderId: 'kaae_prod_2026_accreditation',
          relativeFolderParts: ['2026', 'KAAE'],
          spreadsheetId: 'kaae_institutional_register_2026',
          sheetId: 0,
        },
        files: [
          {
            artifactId: 'art-001',
            relativePath: 'KAAE_Social_Card_1080x1350.png',
            storageKey: 'exports/KAAE_Social_Card.png',
            filename: 'KAAE_Social_Card_1080x1350.png',
            sha256: 'sha256_mock_verified_delivery_hash',
            byteSize: 1024,
            mimeType: 'image/png',
          },
        ],
        sheetRow: { task_id: 'task-figma-001', status: 'published' },
      });

      expect(pubRes.ok).toBe(true);
      if (pubRes.ok) {
        expect(pubRes.value.driveFolderId).toContain('kaae_prod_2026_accreditation');
        expect(pubRes.value.state).toBe('complete');
        expect(pubRes.value.driveFiles[0].verified).toBe(true);
      }
    });
  });
});
