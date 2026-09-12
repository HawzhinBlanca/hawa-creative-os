import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  CanvaCapturePipeline,
  createSyntheticValidPng,
  createSyntheticValidPdf,
} from '@hawa/integrations';
import type {
  CanvaStudioBinding,
  CanvaCapturedArtifact,
  CanvaSemanticCoverage,
} from '@hawa/contracts';
import { kaaeClientDNA } from '@hawa/domain';

describe('CV-13: Capture Real Immutable Output Packages', () => {
  let pipeline: CanvaCapturePipeline;
  const tenantId = 't0000000-0000-4000-8000-000000000001';
  const taskId = crypto.randomUUID();
  const clientId = kaaeClientDNA.clientId;
  const canvaDesignId = 'DAF_kaae_invitation_cv13_master';
  const bindingId = crypto.randomUUID();

  let initialBinding: CanvaStudioBinding;

  beforeEach(() => {
    pipeline = new CanvaCapturePipeline();
    initialBinding = {
      id: bindingId,
      tenantId,
      taskId,
      clientId,
      canvaDesignId,
      editUrl: `https://www.canva.com/design/${canvaDesignId}/edit`,
      viewUrl: `https://www.canva.com/design/${canvaDesignId}/view`,
      directionName: 'primary',
      status: 'bound',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    pipeline.registerBinding(initialBinding);
  });

  describe('1. PNG & PDF Parsing & Preflight Inspection (FR-038)', () => {
    it('successfully parses valid PNG bytes, extracts dimensions, and verifies sRGB format', () => {
      const pngBuffer = createSyntheticValidPng(1080, 1350);
      const res = pipeline.validateArtifactBytes(pngBuffer, 'png');

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.format).toBe('png');
      expect(res.value.width).toBe(1080);
      expect(res.value.height).toBe(1350);
      expect(res.value.colorSpace).toBe('srgb');
      expect(res.value.dpi).toBe(72);
      expect(res.value.byteSize).toBe(pngBuffer.length);
      expect(res.value.sha256).toMatch(/^sha256_[a-f0-9]{64}$/);
    });

    it('successfully parses print-ready PDF bytes, extracts page boxes, embedded fonts, and verifies CMYK profile', () => {
      const pdfBuffer = createSyntheticValidPdf({
        cmyk: true,
        trimBox: [9, 9, 1089, 1359],
        bleedBox: [0, 0, 1098, 1368],
        fonts: ['Cairo-Bold', 'NotoNaskhArabic-Regular'],
      });
      const res = pipeline.validateArtifactBytes(pdfBuffer, 'pdf_print');

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.format).toBe('pdf_print');
      expect(res.value.colorSpace).toBe('cmyk');
      expect(res.value.dpi).toBe(300);
      expect(res.value.pageBoxes?.trimBox).toEqual([9, 9, 1089, 1359]);
      expect(res.value.pageBoxes?.bleedBox).toEqual([0, 0, 1098, 1368]);
      expect(res.value.embeddedFonts).toContain('Cairo-Bold');
      expect(res.value.embeddedFonts).toContain('NotoNaskhArabic-Regular');
    });
  });

  describe('2. Defect Rejection Matrix (Acceptance Criteria)', () => {
    it('rejects empty or zero-byte output with MISSING_EXPORT_OUTPUT', () => {
      const emptyBuffer = Buffer.alloc(0);
      const res = pipeline.validateArtifactBytes(emptyBuffer, 'png');

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MISSING_EXPORT_OUTPUT');
    });

    it('rejects 8-byte dummy/corrupt file with CORRUPT_OR_EMPTY_ARTIFACT', () => {
      const eightByteBuffer = Buffer.from('12345678');
      const res = pipeline.validateArtifactBytes(eightByteBuffer, 'png');

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('CORRUPT_OR_EMPTY_ARTIFACT');
      expect(res.error.message).toContain('8-byte corrupt/placeholder file');
    });

    it('rejects HTML error page or wrong magic bytes with WRONG_FORMAT_OUTPUT', () => {
      const htmlBuffer = Buffer.from('<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head></html>');
      const res = pipeline.validateArtifactBytes(htmlBuffer, 'png');

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('WRONG_FORMAT_OUTPUT');
    });

    it('rejects RGB PDF when CMYK print PDF is required with PRINT_PREFLIGHT_DEFECT', () => {
      const rgbPdfBuffer = createSyntheticValidPdf({
        cmyk: false, // RGB only
      });
      const res = pipeline.validateArtifactBytes(rgbPdfBuffer, 'pdf_print');

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('PRINT_PREFLIGHT_DEFECT');
      expect(res.error.message).toContain('File color space is not CMYK');
    });
  });

  describe('3. Expired Download URL & Ephemeral Link Defense', () => {
    it('rejects expired download URLs and refuses to treat ephemeral links as backups', async () => {
      const res = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'https://export-api.canva.com/v1/downloads/expired_job?expired=true',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('EXPIRED_DOWNLOAD_URL');
      expect(res.error.message).toContain('Ephemeral links cannot be treated as durable backups');
    });

    it('streams valid artifact bytes into durable staged storage and computes immutable hash', async () => {
      const pngBuffer = createSyntheticValidPng(1080, 1080);
      const res = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'https://export-api.canva.com/v1/downloads/valid_job?token=auth123',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: pngBuffer,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.format).toBe('png');
      expect(res.value.width).toBe(1080);
      expect(res.value.height).toBe(1080);
      expect(res.value.storageKey).toMatch(/^staged\/canva-exports\/sha256_[a-f0-9]{64}\.png$/);
    });
  });

  describe('4. Export Job Reconciliation', () => {
    it('reconciles uncertain export job without duplicating requests', async () => {
      const initRes = await pipeline.initiateExportJob({
        canvaDesignId,
        version: 1,
        format: 'pdf_print',
      });
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const jobId = initRes.value.jobId;

      // Reconcile
      const reconRes = await pipeline.reconcileExportJob(jobId);
      expect(reconRes.ok).toBe(true);
      if (!reconRes.ok) return;

      expect(reconRes.value.jobId).toBe(jobId);
      expect(reconRes.value.reconcileCount).toBe(1);
      expect(reconRes.value.status).toBe('success');
    });
  });

  describe('5. Native Print-Export Upload Handoff Route', () => {
    it('generates operator handoff instructions and ingests manual CMYK print PDF upload', async () => {
      // 1. Generate handoff guidance
      const guidance = pipeline.createPrintExportHandoff({
        taskId,
        canvaDesignId,
        clientName: 'KAAE',
        requiredProfile: 'PDF/X-1a (FOGRA39)',
      });

      expect(guidance.canvaEditUrl).toBe(`https://www.canva.com/design/${canvaDesignId}/edit`);
      expect(guidance.requiredColorSpace).toBe('CMYK');
      expect(guidance.requiredDpi).toBe(300);
      expect(guidance.stepByStepInstructions.length).toBeGreaterThan(3);

      // 2. Ingest manual print PDF upload
      const manualPdf = createSyntheticValidPdf({
        cmyk: true,
        trimBox: [9, 9, 1089, 1359],
        bleedBox: [0, 0, 1098, 1368],
      });

      const ingestRes = await pipeline.ingestManualPrintUpload({
        buffer: manualPdf,
        canvaDesignId,
        version: 1,
      });

      expect(ingestRes.ok).toBe(true);
      if (!ingestRes.ok) return;

      expect(ingestRes.value.format).toBe('pdf_print');
      expect(ingestRes.value.colorSpace).toBe('cmyk');
      expect(ingestRes.value.dpi).toBe(300);
    });
  });

  describe('6. Multi-Format Consistency & Atomic Package Publishing (FR-032, FR-033, FR-045)', () => {
    it('rejects partial output package when required aspect ratio variant is missing', async () => {
      // Provide only 1:1 and 4:5, but requiredVariants asks for 1:1, 4:5, and 9:16
      const png1 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url1',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1080),
      });
      const png2 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url2',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1350),
      });
      const printPdf = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url3',
        expectedFormat: 'pdf_print',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPdf({ cmyk: true }),
      });

      const publishRes = await pipeline.publishCapturePackage({
        tenantId,
        bindingId,
        taskId,
        clientId,
        canvaDesignId,
        expectedVersion: 1,
        requiredVariants: ['1:1', '4:5', '9:16'], // 9:16 is missing!
        artifacts: [png1.value!, png2.value!, printPdf.value!],
        semanticCoverage: {
          textNodesCount: 6,
          imageFillsCount: 1,
          hasLogo: true,
          isComplete: true,
          unobservedLayersCount: 0,
        },
        authActor: { actorType: 'workflow', actorId: 'hawa_capture_worker' },
      });

      expect(publishRes.ok).toBe(false);
      if (publishRes.ok) return;
      expect(publishRes.error.code).toBe('PARTIAL_OUTPUT_PACKAGE');
      expect(publishRes.error.message).toContain('Captured 2 PNG variants, expected 3');
    });

    it('blocks source-complete claims when snapshot is incomplete (unobserved layers exist)', async () => {
      const png1 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url1',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1350),
      });
      const printPdf = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url2',
        expectedFormat: 'pdf_print',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPdf({ cmyk: true }),
      });

      const publishRes = await pipeline.publishCapturePackage({
        tenantId,
        bindingId,
        taskId,
        clientId,
        canvaDesignId,
        expectedVersion: 1,
        requiredVariants: ['4:5'],
        artifacts: [png1.value!, printPdf.value!],
        semanticCoverage: {
          textNodesCount: 3,
          imageFillsCount: 1,
          hasLogo: true,
          isComplete: false, // Incomplete snapshot!
          unobservedLayersCount: 2,
        },
        authActor: { actorType: 'operator', actorId: 'human_operator_1' },
      });

      expect(publishRes.ok).toBe(false);
      if (publishRes.ok) return;
      expect(publishRes.error.code).toBe('INCOMPLETE_SNAPSHOT_ERROR');
    });

    it('atomically publishes complete immutable capture set, bumps version, and records Merkle hash', async () => {
      // 1. Prepare complete artifacts: 3 PNG variants (4:5, 1:1, 9:16), PDF Print (CMYK), and PDF Standard
      const png4x5 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url_4x5',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1350),
      });
      const png1x1 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url_1x1',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1080),
      });
      const png9x16 = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url_9x16',
        expectedFormat: 'png',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPng(1080, 1920),
      });
      const pdfPrint = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url_print',
        expectedFormat: 'pdf_print',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPdf({ cmyk: true }),
      });
      const pdfStandard = await pipeline.streamAndPersistArtifact({
        downloadUrl: 'url_std',
        expectedFormat: 'pdf_standard',
        canvaDesignId,
        version: 1,
        rawBufferOverride: createSyntheticValidPdf({ cmyk: false }),
      });

      const artifacts: CanvaCapturedArtifact[] = [
        png4x5.value!,
        png1x1.value!,
        png9x16.value!,
        pdfPrint.value!,
        pdfStandard.value!,
      ];

      // 2. Publish complete package
      const publishRes = await pipeline.publishCapturePackage({
        tenantId,
        bindingId,
        taskId,
        clientId,
        canvaDesignId,
        expectedVersion: 1,
        requiredVariants: ['4:5', '1:1', '9:16'],
        artifacts,
        semanticCoverage: {
          textNodesCount: 6,
          imageFillsCount: 1,
          hasLogo: true,
          isComplete: true,
          unobservedLayersCount: 0,
        },
        exportSettings: {
          colorProfile: 'CMYK FOGRA39',
          bleedMm: 3,
          cropMarks: true,
        },
        authActor: {
          actorType: 'workflow',
          actorId: 'hawa_restate_worker_01',
        },
      });

      expect(publishRes.ok).toBe(true);
      if (!publishRes.ok) return;

      const captureSet = publishRes.value;
      expect(captureSet.version).toBe(2);
      expect(captureSet.capturedArtifactSetHash).toMatch(/^sha256_[a-f0-9]{64}$/);
      expect(captureSet.artifacts).toHaveLength(5);
      expect(captureSet.semanticCoverage.isComplete).toBe(true);

      // 3. Read back from pipeline
      const readback = pipeline.getCaptureSet(captureSet.id);
      expect(readback).toBeDefined();
      expect(readback?.capturedArtifactSetHash).toBe(captureSet.capturedArtifactSetHash);

      // 4. Stale request rejection: Attempting to publish again with expectedVersion=1 fails
      const staleRes = await pipeline.publishCapturePackage({
        tenantId,
        bindingId,
        taskId,
        clientId,
        canvaDesignId,
        expectedVersion: 1, // Stale! Current is 2
        requiredVariants: ['4:5', '1:1', '9:16'],
        artifacts,
        semanticCoverage: { textNodesCount: 6, imageFillsCount: 1, hasLogo: true, isComplete: true },
        authActor: { actorType: 'operator', actorId: 'op_retry' },
      });
      expect(staleRes.ok).toBe(false);
      if (staleRes.ok) return;
      expect(staleRes.error.code).toBe('STALE_VERSION_CONFLICT');
    });
  });
});
