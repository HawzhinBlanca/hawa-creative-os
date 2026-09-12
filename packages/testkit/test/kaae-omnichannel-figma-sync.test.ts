import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GooglePublisher } from '../../integrations/src/google-publisher.js';
import { FigmaBridgeAdapter } from '../../integrations/src/figma-bridge-adapter.js';
import { kaaeClientDNA } from '../../domain/src/fixtures/kaae-client-dna.js';
import {
  KAAE_MANDATE_BUZZ_MAPPING,
  KAAE_STANDARDS_BUZZ_MAPPING,
  KAAE_ROADMAP_BUZZ_MAPPING,
  KAAE_PRIMARY_LOGO_SHA256,
} from '../../creative/src/index.js';
import type { RequestContext, PublishRequest, FigmaCommand } from '../../contracts/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

describe('KAAE Omnichannel Publish & Figma Bridge Live Sync Integration', () => {
  const defaultContext: RequestContext = {
    tenantId: 'tenant-kaae-office',
    clientId: 'c1000000-0000-4000-8000-000000000002',
    taskId: 'task_kaae_omnichannel_test_001',
    actor: { type: 'human', id: 'lead_evaluator_hawzhin', role: 'admin' },
    correlationId: crypto.randomUUID(),
    deadline: new Date(Date.now() + 120000).toISOString(),
    idempotencyKey: 'idem_kaae_omnichannel_test_001',
  };

  describe('Part 1: Google Shared Drive & Google Sheets Omnichannel Publish (Option 1)', () => {
    it('verifies client DNA destinations point to active Google Drive 1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr', () => {
      // 1. In-memory fixture
      expect(kaaeClientDNA.destinations.googleSharedDriveId).toBe('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(kaaeClientDNA.destinations.productionFolderId).toBe('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(kaaeClientDNA.destinations.spreadsheetId).toBe('1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ');

      // 2. config/clients/kaae.dna.json
      const dnaJsonPath = path.join(rootDir, 'config', 'clients', 'kaae.dna.json');
      const dnaJson = JSON.parse(fs.readFileSync(dnaJsonPath, 'utf8'));
      expect(dnaJson.production.drive.sharedDriveId).toBe('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(dnaJson.production.drive.productionRootFolderId).toBe('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(dnaJson.production.sheets.spreadsheetId).toBe('1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ');
    });

    it('publishes KAAE omnichannel package and returns verified receipt with synced spreadsheet audit row', async () => {
      const publisher = new GooglePublisher({ emulateNetworkForTesting: true, oauthToken: 'test_token' });
      const exportDir = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION');

      const manifestPath = path.join(exportDir, 'campaign_manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.client.destinations.googleSharedDriveId).toBe('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(manifest.client.destinations.spreadsheetId).toBe('1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ');
      expect(manifest.deliverables.length).toBeGreaterThanOrEqual(10);

      const publishReq: PublishRequest = {
        taskId: defaultContext.taskId!,
        clientId: defaultContext.clientId!,
        designRevisionId: 'rev-kaae-omni-test',
        approvalId: 'appr-kaae-board-test',
        publicationKey: 'pub_test_omnichannel_receipt',
        packageHash: 'sha256_mock_manifest_hash',
        destination: {
          sharedDriveId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr',
          productionRootFolderId: '1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr',
          relativeFolderParts: ['2026', 'KAAE_2026_PRODUCTION'],
          spreadsheetId: '1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ',
          sheetId: 0,
        },
        files: manifest.deliverables,
      };

      const pubRes = await publisher.publish(defaultContext, publishReq);
      expect(pubRes.ok).toBe(true);
      if (!pubRes.ok) return;

      const receipt = pubRes.value;
      expect(receipt.state).toBe('complete');
      expect(receipt.driveFolderId).toContain('1XiMeNxKm3ofVSMr4pItZr4NDPltXUjYr');
      expect(receipt.sheet.spreadsheetId).toBe('1BXLlHxozjR4KRwEQ-hvNPgvlCtp-6_FQAL7EJ4GZ');
      expect(receipt.sheet.synced).toBe(true);
      expect(receipt.driveFiles.length).toBe(manifest.deliverables.length);
    });

    it('verifies all 3 KAAE templates produce valid lossless .hyc packages with zero raster layers', () => {
      const exportDir = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION');
      const hycFiles = [
        path.join(exportDir, '03_Accreditation_Certificates_A4_300DPI', 'UKH_Accreditation_Certificate.hyc'),
        path.join(exportDir, '04_Social_Announcements_1080x1350', 'KAAE_Standards_Higher_Ed.hyc'),
        path.join(exportDir, '05_Executive_Statements_1080x1080', 'KAAE_Mandate_Statutory.hyc'),
        path.join(exportDir, '05_Executive_Statements_1080x1080', 'KAAE_Roadmap_Strategic.hyc'),
        path.join(exportDir, '06_Conference_Keynote_Banner_1920x1080', 'KAAE_National_Quality_Summit_2026.hyc'),
      ];

      for (const f of hycFiles) {
        expect(fs.existsSync(f), `Expected file ${f} to exist`).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        expect(parsed.formatVersion).toBe('0.4.0');
        expect(parsed.canvas).toBeDefined();
        expect(Array.isArray(parsed.nodes)).toBe(true);
        expect(parsed.nodes.length).toBeGreaterThan(0);

        // Invariant #2: No flattened bitmaps masquerading as final vector designs
        const hasFlattenedRaster = parsed.nodes.some((n: any) => n.role === 'flattened_canvas' || n.type === 'raster_fallback');
        expect(hasFlattenedRaster).toBe(false);
      }
    });
  });

  describe('Part 2: Figma Bridge Live Sync & Staging Confinement (Option 4)', () => {
    it('acquires and releases single-writer task leases on figma_kaae_master_library', async () => {
      const bridge = new FigmaBridgeAdapter();

      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;

      const lease = leaseRes.value;
      expect(lease.fileKey).toBe('figma_kaae_master_library');
      expect(lease.holder).toBe(defaultContext.actor.id);
      expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // Releasing lease
      const relRes = await bridge.releaseLease(defaultContext, lease.id);
      expect(relRes.ok).toBe(true);
    });

    it('synchronizes Route A Figma Buzz assets for the 3 canonical KAAE templates', async () => {
      const bridge = new FigmaBridgeAdapter();

      // Mandate 1:1
      const mandateRes = await bridge.createBuzzAsset(defaultContext, 'kaae_mandate', KAAE_MANDATE_BUZZ_MAPPING);
      expect(mandateRes.ok).toBe(true);
      if (mandateRes.ok) {
        expect(mandateRes.value.nodeId).toContain('buzz_staging_');
        const resizeRes = await bridge.smartResizeBuzz(defaultContext, mandateRes.value.nodeId, '4:5');
        expect(resizeRes.ok).toBe(true);
      }

      // Standards 4:5
      const standardsRes = await bridge.createBuzzAsset(defaultContext, 'kaae_standards', KAAE_STANDARDS_BUZZ_MAPPING);
      expect(standardsRes.ok).toBe(true);
      if (standardsRes.ok) {
        expect(standardsRes.value.nodeId).toContain('buzz_staging_');
        const resizeRes = await bridge.smartResizeBuzz(defaultContext, standardsRes.value.nodeId, '1:1');
        expect(resizeRes.ok).toBe(true);
      }

      // Roadmap 1:1
      const roadmapRes = await bridge.createBuzzAsset(defaultContext, 'kaae_roadmap', KAAE_ROADMAP_BUZZ_MAPPING);
      expect(roadmapRes.ok).toBe(true);
      if (roadmapRes.ok) {
        expect(roadmapRes.value.nodeId).toContain('buzz_staging_');
        const resizeRes = await bridge.smartResizeBuzz(defaultContext, roadmapRes.value.nodeId, '16:9');
        expect(resizeRes.ok).toBe(true);
      }
    });

    it('strictly confines Route B mutations to 30_AI_STAGING and enforces expected revision locks', async () => {
      const bridge = new FigmaBridgeAdapter();
      const leaseRes = await bridge.acquireLease(defaultContext, 'figma_kaae_master_library', 3600);
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;

      const lease = leaseRes.value;

      // Mutation 1 at expected revision 0
      const cmd1: FigmaCommand = {
        leaseId: lease.id,
        fileKey: 'figma_kaae_master_library',
        clientId: defaultContext.clientId!,
        expectedRevision: 0,
        operation: 'create_text',
        targetNodeId: 'node_test_header',
        args: {
          name: 'StagingHeader',
          text: 'KAAE Staging 2026',
        },
      };
      const mut1 = await bridge.mutate(defaultContext, cmd1);
      expect(mut1.ok).toBe(true);
      if (!mut1.ok) return;
      expect(mut1.value.revision).toBe(1);

      // Stale revision rejection: repeating revision 0 must fail
      const staleMut = await bridge.mutate(defaultContext, cmd1);
      expect(staleMut.ok).toBe(false);
      if (!staleMut.ok) {
        expect(staleMut.error.code).toBe('STALE_REVISION_CONFLICT');
      }

      // Inspect staging container: must reflect all staged nodes inside 30_AI_STAGING
      const inspectRes = await bridge.inspect(defaultContext, 'figma_kaae_master_library', '30_AI_STAGING');
      expect(inspectRes.ok).toBe(true);
      if (inspectRes.ok) {
        const snap = inspectRes.value as any;
        expect(snap.id).toBe('30_AI_STAGING');
        expect(snap.name).toBe('30_AI_STAGING');
        expect(snap.children.length).toBeGreaterThan(0);
        expect(snap.children[0].name).toBe('StagingHeader');
      }
    });

    it('verifies that the generated figma_live_sync_receipt.json exists and contains correct deep links', () => {
      const receiptPath = path.join(rootDir, 'exports', 'KAAE_2026_PRODUCTION', 'figma_live_sync_receipt.json');
      expect(fs.existsSync(receiptPath)).toBe(true);

      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      expect(receipt.fileKey).toBe('figma_kaae_master_library');
      expect(receipt.stagingFrame).toBe('30_AI_STAGING');
      expect(receipt.deepLinks.desktopApp).toBe('figma://file/figma_kaae_master_library?node-id=30_AI_STAGING');
      expect(receipt.deepLinks.webCanvas).toBe('https://www.figma.com/design/figma_kaae_master_library?node-id=30_AI_STAGING');
      expect(receipt.nodeTree.children.length).toBe(9);
    });
  });
});
