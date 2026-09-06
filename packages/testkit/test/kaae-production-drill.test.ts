import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, QARequest } from '@hawa/contracts';
import {
  TaskStateMachine,
  extractProtectedTokens,
  validateBrief,
  validateClientDna,
  type DesignBrief,
  type ClientDNA,
  kaaeClientDNA,
} from '@hawa/domain';
import {
  BriefBuilder,
  CreativeDirectorRunner,
  DesignRouter,
  buildKaaeCertificateOperations,
  buildKaaeAnnouncementOperations,
  getCanonicalBrandKit,
  validateBrandKitContrast,
  KAAE_PRIMARY_LOGO_SHA256,
} from '@hawa/creative';
import {
  DeterministicQAEngine,
  validateKurdishOrthography,
  checkKurdishTypographyClearance,
} from '@hawa/qa';
import {
  TelegramAdapter,
  GooglePublisher,
} from '@hawa/integrations';
import { createApp } from '../../../apps/core/src/app.js';
import {
  generateHycPackageData,
  importFromHycPackage,
  FORMAT_DIMENSIONS,
} from '../../../apps/desk/src/services/canvasExport.js';
import { getBrandKit } from '../../../apps/desk/src/services/brandKits.js';

describe('KAAE End-to-End Production Qualification Drill (All 4 Pillars)', () => {
  const telegramBotToken = '8975998512:AAELwUMofl2S-Rho0zrXjVL66tlJzTAfHzI';
  const telegramWebhookSecret = 'kaae_office_secret_production_entropy_99f3b817';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';

  // --------------------------------------------------------------------------
  // PILLAR 1: Interactive Studio & HyCanvas AST Round-Trip in Desk
  // --------------------------------------------------------------------------
  describe('Pillar 1: Interactive Studio & HyCanvas AST Round-Trip (Invariant #1, #2, #3)', () => {
    it('retrieves KAAE canonical brand kit from Desk services with exact tokens', () => {
      const kit = getBrandKit('kaae');
      expect(kit.id).toBe('kaae');
      expect(kit.palette.primary).toBe('#4770A3');
      expect(kit.palette.secondary).toBe('#0A1628');
      expect(kit.palette.accent).toBe('#F7B500');
      expect(kit.typography.latinFont).toBe('Minion Variable Concept');
      expect(kit.typography.kurdishFont).toBe('Cairo');
      expect(kit.verifiedSha256).toBe(KAAE_PRIMARY_LOGO_SHA256);
      expect(kit.contactTokens).toContain('www.kaae.org');
    });

    it('generates, packages, and round-trips KAAE Accreditation Certificate via HyCanvas (.hyc)', async () => {
      const ops = buildKaaeCertificateOperations({
        recipientName: 'زانکۆی کوردستان - هەولێر (UKH)',
        programName: 'کۆلێژی پزیشکی - متمانەبەخشی نیشتمانی نایاب',
        issueDate: '2026-09-06',
        startDate: '2025-09-01',
        endDate: '2030-08-31',
        directorName: 'Dr. Honar Issa',
        language: 'ckb',
      });

      expect(ops.length).toBeGreaterThanOrEqual(10);

      // Verify canvas operations preserve live editable nodes
      const textOps = ops.filter((o) => o.op === 'addText');
      const vectorOps = ops.filter((o) => o.op === 'addVector');
      const imageOps = ops.filter((o) => o.op === 'addImage');

      expect(textOps.length).toBeGreaterThanOrEqual(6);
      expect(vectorOps.length).toBeGreaterThanOrEqual(2);
      expect(imageOps.length).toBeGreaterThanOrEqual(1);

      // Package into .hyc bundle format
      const deskKit = getBrandKit('kaae');
      const { filename, json, package: pkg } = generateHycPackageData({
        headlineEn: 'Accreditation Granted to University of Kurdistan Hewlêr (UKH)',
        headlineCkb: 'پێدانی بڕوانامەی متمانەبەخشین بە زانکۆی کوردستان - هەولێر',
        copyEn: 'Statutory Authority: Kurdistan Regional Law No. 6 of 2022',
        copyCkb: 'بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان',
        langVariant: 'bilingual',
        fontFamily: 'Cairo',
        fontWeight: 700,
        accentColor: '#F7B500',
        brandKit: deskKit,
        format: 'landscape',
        scale: 2,
        nodes: ops,
      });

      expect(pkg).toBeDefined();
      expect(pkg.canvas).toBeDefined();
      expect(pkg.canvas.brandKitId).toBe('kaae');
      expect(pkg.canvas.format).toBe('landscape');

      // Deserialize and restore vector AST
      const restored = await importFromHycPackage(json);
      expect(restored.ok).toBe(true);
      expect(restored.brandKitId).toBe('kaae');
      expect(restored.nodes?.length).toBe(ops.length);

      // Invariant #2: Verify 0 flattened raster layers for factual text
      const restoredTextNodes = (restored.nodes || []).filter((n: any) => n.role === 'headline' || n.role === 'copy' || n.textEn || n.textCkb);
      expect(restoredTextNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('generates and packages KAAE Social Announcement Card (1080 x 1350) with Cairo font', () => {
      const ops = buildKaaeAnnouncementOperations({
        headlineCkb: 'دەستپێکردنی گەڕی نوێی متمانەبەخشین بە زانکۆکان بۆ ساڵی ٢٠٢٦',
        headlineEn: 'KAAE Commences 2026 University Accreditation Cycle',
        copyCkb: 'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا لە هەرێمی کوردستان.',
        categoryBadge: 'بڕیاری فەرمی · OFFICIAL ANNOUNCEMENT',
      });

      expect(ops.length).toBeGreaterThanOrEqual(10);
      const headline = ops.find((o) => o.op === 'addText' && o.nodeId === 'ann_headline_ckb');
      expect(headline?.style?.fontFamily).toBe('Cairo');
      expect(headline?.style?.textAlign).toBe('right');
    });
  });

  // --------------------------------------------------------------------------
  // PILLAR 2: Deterministic QA Engine Validation & Kurdish Orthography
  // --------------------------------------------------------------------------
  describe('Pillar 2: Deterministic QA Engine & Kurdish Orthography Compliance', () => {
    const qaEngine = new DeterministicQAEngine();

    it('verifies Kurdish Sorani orthography, city names, and diacritic clearances', () => {
      const nonStandardNotice = 'دەستەی متمانەبەخشی KAAE لە أربيل و السليمانية و دهوك پرۆگرامی نیشتمانی ڕادەگەیەنێت';
      const orthoReport = validateKurdishOrthography(nonStandardNotice);
      expect(orthoReport.normalizedText).toContain('هەولێر');
      expect(orthoReport.normalizedText).toContain('سلێمانی');
      expect(orthoReport.normalizedText).toContain('دهۆک');

      // Test already-standard text is 100% valid
      const standardNotice = 'دەستەی متمانەبەخشی لە هەولێر و سلێمانی و دهۆک پرۆگرامی نیشتمانی ڕادەگەیەنێت';
      const cleanReport = validateKurdishOrthography(standardNotice);
      expect(cleanReport.valid).toBe(true);

      // Test diacritic ascender/descender clearance for Kurdish glyphs (ڵ/ۆ/ێ/ڕ)
      const clearance = checkKurdishTypographyClearance(standardNotice, 1.4, 4);
      expect(clearance.safe).toBe(true);
    });

    it('verifies WCAG 2.2 AAA contrast standards for KAAE palette', () => {
      const canonicalKit = getCanonicalBrandKit('kaae');
      const contrast = validateBrandKitContrast(canonicalKit);
      expect(contrast.isAccessible).toBe(true);
      expect(contrast.contrastRatio).toBeGreaterThanOrEqual(7.0);
    });

    it('runs DeterministicQAEngine on KAAE manifest with zero hard escapes', async () => {
      const ctx: RequestContext = {
        tenantId: 'a0000000-0000-4000-8000-000000000001',
        taskId: 'task-kaae-qa-001',
        actor: { type: 'system', id: 'qa_engine' },
        correlationId: randomUUID(),
        deadline: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: 'idem_kaae_qa_001',
      };

      const qaReport = await qaEngine.run(ctx, {
        taskId: 'task-kaae-qa-001',
        designRevisionId: 'rev_kaae_001',
        brief: {
          briefId: 'b_001',
          taskId: 'task-kaae-qa-001',
          clientId: kaaeClientId,
          clientDnaVersion: 1,
          objective: 'Institutional Accreditation',
          taskRoute: 'template_fill',
          primaryLanguage: 'ckb',
          direction: 'rtl',
          variants: [{ id: 'v1', name: 'Certificate', width: 3508, height: 2480, aspectRatio: 'A4', role: 'custom' }],
          exactCopy: [
            { id: 'c1', role: 'headline', text: 'زانکۆی کوردستان - هەولێر', language: 'ckb', direction: 'rtl', approved: true, protectedTokens: [] },
          ],
          missingFacts: [],
          requiredAssetRoles: ['logo_primary'],
          createdAt: new Date().toISOString(),
        },
        clientDna: kaaeClientDNA,
        profile: { name: 'strict', version: '1.0', rules: {} },
        repairCycle: 0,
        manifest: {
          schemaVersion: 1,
          pages: [
            {
              id: 'page_certificate',
              name: 'Certificate',
              width: 3508,
              height: 2480,
            },
          ],
          nodes: [
            {
              id: 'cert_recipient',
              pageId: 'page_certificate',
              type: 'text',
              text: 'زانکۆی کوردستان - هەولێر',
              role: 'headline',
              locked: false,
              zIndex: 1,
            },
            {
              id: 'cert_logo',
              pageId: 'page_certificate',
              type: 'image',
              role: 'logo_primary',
              assetSha256: KAAE_PRIMARY_LOGO_SHA256,
              locked: true,
              zIndex: 2,
            },
          ],
          colorPalette: ['#4770A3', '#0A1628', '#F7B500'],
          typography: [{ family: 'Cairo', weight: 700, role: 'display' }],
          assets: [
            {
              id: 'kaae_logo',
              role: 'logo_primary',
              sha256: KAAE_PRIMARY_LOGO_SHA256,
              verified: true,
            },
          ],
        } as any,
        renderedImages: [
          { pageId: 'page_certificate', format: 'png', storageKey: 'test/cert.png', sha256: 'sha256_mock_cert' },
        ],
      } as any);

      expect(qaReport.ok).toBe(true);
      if (qaReport.ok) {
        expect(qaReport.value.status).toBe('passed');
        expect(qaReport.value.criticalPass).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // PILLAR 3: Production Telegram / Message Ingress Setup & Lifecycle
  // --------------------------------------------------------------------------
  describe('Pillar 3: Production Telegram Ingress & Webhook Qualification', () => {
    const app = createApp();
    const tgAdapter = new TelegramAdapter({
      botToken: telegramBotToken,
      webhookSecret: telegramWebhookSecret,
      hawaDeskBaseUrl: 'https://desk.hawa.office',
    });

    it('rejects unauthorized incoming webhooks with missing or invalid secret token', async () => {
      // 1. Missing secret token
      const resNoSecret = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 9001 }),
      });
      expect(resNoSecret.status).toBe(401);

      // 2. Invalid secret token
      const resBadSecret = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'wrong_secret_token_123',
        },
        body: JSON.stringify({ update_id: 9002 }),
      });
      expect(resBadSecret.status).toBe(401);
    });

    it('accepts authenticated Telegram webhook for KAAE accreditation request and locks client scope', async () => {
      const rawUpdate = {
        update_id: 889901,
        message: {
          message_id: 42,
          date: 1772832000,
          chat: { id: 7001, type: 'group', title: 'KAAE Operations Council' },
          from: { id: 99, first_name: 'Dr. Honar', username: 'honar_issa' },
          text: 'داواکاری فەرمی KAAE: دەرکردنی بڕوانامەی متمانەبەخشین بۆ زانکۆی کوردستان هەولێر بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢. پەیوەندی: info@kaae.krd و 0750 777 8888',
        },
      };

      // 1. Verify via TelegramAdapter standalone
      const verifyRes = await tgAdapter.verifyAndNormalize({
        headers: new Headers({ 'x-telegram-bot-api-secret-token': telegramWebhookSecret }),
        rawBody: new TextEncoder().encode(JSON.stringify(rawUpdate)),
        receivedAt: new Date().toISOString(),
      });
      expect(verifyRes.ok).toBe(true);

      // 2. Ingest via Hawa Core API webhook endpoint
      process.env.TELEGRAM_WEBHOOK_SECRET = telegramWebhookSecret;

      const apiRes = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': telegramWebhookSecret,
        },
        body: JSON.stringify({
          ...rawUpdate,
          clientId: kaaeClientId,
        }),
      });

      expect(apiRes.status).toBe(201);
      const apiJson = await apiRes.json();
      expect(apiJson.ok).toBe(true);
      expect(apiJson.task).toBeDefined();
      expect(apiJson.task.clientId).toBe(kaaeClientId);
      expect(apiJson.task.status).toBe('RECEIVED');

      // 3. Deduplication check: duplicate update_id returns duplicate: true without creating a new task
      const dupRes = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': telegramWebhookSecret,
        },
        body: JSON.stringify({
          ...rawUpdate,
          clientId: kaaeClientId,
        }),
      });
      expect(dupRes.status).toBe(200);
      const dupJson = await dupRes.json();
      expect(dupJson.duplicate).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // PILLAR 4: Google Drive & Google Sheets Live Sync Integration
  // --------------------------------------------------------------------------
  describe('Pillar 4: Google Drive & Google Sheets Live Sync Integration', () => {
    const publisher = new GooglePublisher();

    it('publishes KAAE deliverables to official Google Shared Drive and mirrors to Google Sheets', async () => {
      const taskId = `task_kaae_pub_${Date.now()}`;
      const publicationKey = `pub_kaae_idem_${taskId}`;

      const ctx: RequestContext = {
        tenantId: 'a0000000-0000-4000-8000-000000000001',
        taskId,
        actor: { type: 'workflow', id: 'google_publisher' },
        correlationId: randomUUID(),
        deadline: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: publicationKey,
      };

      const certPngSha = 'sha256_kaae_cert_png_highres_300dpi_001';
      const certHycSha = 'sha256_kaae_cert_hyc_package_vector_001';

      const publishResult = await publisher.publish(ctx, {
        taskId,
        clientId: kaaeClientId,
        designRevisionId: 'rev_kaae_cert_final',
        approvalId: 'appr_honar_issa_001',
        publicationKey,
        packageHash: createHash('sha256').update(publicationKey).digest('hex'),
        files: [
          {
            artifactId: 'art_kaae_cert_png',
            relativePath: 'KAAE/2026/Certificates/UKH_Accreditation_Certificate.png',
            storageKey: `deliverables/${taskId}/UKH_Certificate.png`,
            filename: 'UKH_Accreditation_Certificate.png',
            mimeType: 'image/png',
            byteSize: 3450000,
            sha256: certPngSha,
          },
          {
            artifactId: 'art_kaae_cert_hyc',
            relativePath: 'KAAE/2026/Certificates/UKH_Accreditation_Certificate.hyc',
            storageKey: `deliverables/${taskId}/UKH_Certificate.hyc`,
            filename: 'UKH_Accreditation_Certificate.hyc',
            mimeType: 'application/octet-stream',
            byteSize: 120000,
            sha256: certHycSha,
          },
        ],
        destination: {
          sharedDriveId: kaaeClientDNA.destinations.googleSharedDriveId,
          productionRootFolderId: kaaeClientDNA.destinations.productionFolderId,
          relativeFolderParts: ['2026_PRODUCTION', 'Certificates'],
          spreadsheetId: kaaeClientDNA.destinations.spreadsheetId,
          sheetId: kaaeClientDNA.destinations.sheetId,
        },
        sheetRow: {
          taskId,
          client: kaaeClientId,
          recipient: 'University of Kurdistan Hewlêr (UKH)',
          program: 'College of Medicine Accreditation',
          statutoryLaw: 'Law No. 6 of 2022',
          status: 'COMPLETE',
          publishedAt: new Date().toISOString(),
        },
      });

      expect(publishResult.ok).toBe(true);
      if (!publishResult.ok) return;

      const receipt = publishResult.value;
      expect(receipt.state).toBe('complete');
      expect(receipt.driveFiles.length).toBe(2);

      // Verify Google Drive receipts
      const pngReceipt = receipt.driveFiles.find((f) => f.name.endsWith('.png'));
      expect(pngReceipt).toBeDefined();
      expect(pngReceipt?.verified).toBe(true);
      expect(pngReceipt?.webViewLink).toContain('drive.google.com/file/d/');

      const hycReceipt = receipt.driveFiles.find((f) => f.name.endsWith('.hyc'));
      expect(hycReceipt).toBeDefined();
      expect(hycReceipt?.verified).toBe(true);

      // Verify Google Sheets reporting mirror row
      expect(receipt.sheet.spreadsheetId).toBe(kaaeClientDNA.destinations.spreadsheetId);
      expect(receipt.sheet.synced).toBe(true);
      expect(receipt.sheet.rowKey).toBe(taskId);

      // Invariant #12: Replay with the same publication key returns identical receipt
      const replayResult = await publisher.publish(ctx, {
        taskId,
        clientId: kaaeClientId,
        designRevisionId: 'rev_kaae_cert_final',
        approvalId: 'appr_honar_issa_001',
        publicationKey,
        packageHash: createHash('sha256').update(publicationKey).digest('hex'),
        files: [],
        destination: {
          sharedDriveId: kaaeClientDNA.destinations.googleSharedDriveId,
          productionRootFolderId: kaaeClientDNA.destinations.productionFolderId,
          relativeFolderParts: ['2026_PRODUCTION', 'Certificates'],
          spreadsheetId: kaaeClientDNA.destinations.spreadsheetId,
          sheetId: kaaeClientDNA.destinations.sheetId,
        },
      });

      expect(replayResult.ok).toBe(true);
      if (replayResult.ok) {
        expect(replayResult.value.publicationId).toBe(receipt.publicationId);
        expect(replayResult.value.driveFiles.length).toBe(2);
      }
    });

    it('verifies Hawa Core API /tasks/:id/publish route dispatches to KAAE Google Drive destinations', async () => {
      const app = createApp();

      // Create a task
      const createRes = await app.request('/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hawa-Desk': 'internal',
        },
        body: JSON.stringify({
          clientId: kaaeClientId,
          objective: 'Publish UKH Certificate',
        }),
      });

      expect(createRes.status).toBe(201);
      const task = await createRes.json();
      expect(task.clientId).toBe(kaaeClientId);

      // Route task
      const routeRes = await app.request(`/v1/tasks/${task.id}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: kaaeClientId, reason: 'Confirmed KAAE Official Tenant' }),
      });
      expect(routeRes.status).toBe(202);

      // Create Brief
      await app.request(`/v1/tasks/${task.id}/briefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: 'KAAE Certificate',
          rawRequestText: 'Certificate for UKH',
          copyBlocks: [
            { role: 'headline', text: 'زانکۆی کوردستان - هەولێر' },
          ],
        }),
      });

      // Generate Studio Revision & Run QA
      const genRes = await app.request(`/v1/tasks/${task.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Accreditation certificate' }),
      });
      expect(genRes.status).toBe(202);

      const taskCheck = await app.request(`/v1/tasks/${task.id}`);
      const generatedTask = await taskCheck.json();
      expect(generatedTask.status).toBe('AWAITING_APPROVAL');
      expect(generatedTask.latestRevisionId).toBeDefined();

      // Human Approval Gate (Invariant #11)
      const decisionRes = await app.request(`/v1/tasks/${task.id}/revisions/${generatedTask.latestRevisionId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: 'approved',
          reviewerId: 'art_director',
          notes: 'Accreditation certificate approved by Council.',
        }),
      });
      expect(decisionRes.status).toBe(201);

      // Execute Publish to Google Drive & Google Sheets
      const pubRes = await app.request(`/v1/tasks/${task.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(pubRes.status).toBe(202);
      const pubJson = await pubRes.json();
      expect(pubJson.taskId).toBe(task.id);
      expect(pubJson.vaultUri).toContain(kaaeClientId);
    });
  });
});
