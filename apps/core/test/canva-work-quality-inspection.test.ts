import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { DeterministicQAEngine } from '@hawa/qa';
import type {
  QARequest,
  RequestContext,
  NeutralManifest,
  RenderedOutput,
  StudioDocumentRef,
  SHA256,
  UUID,
} from '@hawa/contracts';
import { kaaeClientDNA } from '@hawa/domain';

describe('CV-14: Make Quality Checks Inspect the Actual Work', () => {
  let qaEngine: DeterministicQAEngine;
  const tenantId = 't0000000-0000-4000-8000-000000000001' as UUID;
  const taskId = crypto.randomUUID() as UUID;
  const clientId = kaaeClientDNA.clientId as UUID;
  const designRevisionId = crypto.randomUUID() as UUID;

  const mockCtx: RequestContext = {
    tenantId,
    taskId,
    clientId,
    actor: { type: 'system', id: 'hawa_qa_auditor', role: 'qa_agent' },
    correlationId: crypto.randomUUID(),
  };

  const documentRef: StudioDocumentRef = {
    documentId: crypto.randomUUID() as UUID,
    sourceRevision: 1,
    sourceSha256: 'sha256_mock_source_hash' as SHA256,
    studio: 'canva',
    studioVersion: 'v1',
    schemaVersion: '1.0',
  };

  const canonicalApprovedCopy = [
    {
      id: 'copy_headline',
      role: 'headline',
      text: 'کۆنفرانسی نیشتمانی دڵنیایی جۆری لە پەروەردە',
      language: 'ckb',
      protectedTokens: [{ raw: 'کۆنفرانسی نیشتمانی', type: 'event_name' }],
    },
    {
      id: 'copy_subheadline',
      role: 'subheadline',
      text: 'National Quality Assurance Conference',
      language: 'en',
      protectedTokens: [{ raw: 'National Quality Assurance', type: 'event_name' }],
    },
    {
      id: 'copy_date',
      role: 'body',
      text: 'ڕێکەوت: 2026-09-15 | شوێن: هۆڵی پێشەوا، هەولێر',
      language: 'ckb',
      protectedTokens: [
        { raw: '2026-09-15', type: 'date' },
        { raw: 'هۆڵی پێشەوا', type: 'location' },
      ],
    },
    {
      id: 'copy_disclaimer',
      role: 'disclaimer',
      text: 'دەستەی متمانەبەخشی بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان',
      language: 'ckb',
      protectedTokens: [{ raw: 'یاسای ژمارە (٦)ی ساڵی ٢٠٢٢', type: 'legal_decree' }],
    },
  ];

  const canonicalBrief = {
    taskId,
    clientId,
    title: 'KAAE National Conference Invitation Master',
    exactCopy: canonicalApprovedCopy,
    variants: [
      { width: 1080, height: 1350 }, // 4:5 Portrait
      { width: 1080, height: 1080 }, // 1:1 Square
      { width: 1080, height: 1920 }, // 9:16 Story
    ],
    requiredAssetRoles: ['logo_primary'],
    confidentialTokens: ['internal_budget_confidential', 'nda_draft_pricing'],
  };

  const canonicalManifest: NeutralManifest = {
    pages: [
      { id: 'page_4x5', name: 'Portrait 4:5', width: 1080, height: 1350, unit: 'px', language: 'ckb', direction: 'rtl' },
      { id: 'page_1x1', name: 'Square 1:1', width: 1080, height: 1080, unit: 'px', language: 'ckb', direction: 'rtl' },
      { id: 'page_9x16', name: 'Story 9:16', width: 1080, height: 1920, unit: 'px', language: 'ckb', direction: 'rtl' },
    ],
    nodes: [
      {
        id: 'node_bg',
        pageId: 'page_4x5',
        type: 'shape',
        role: 'background',
        locked: true,
        zIndex: 1,
        box: { x: 0, y: 0, width: 1080, height: 1350 },
      },
      {
        id: 'node_logo',
        pageId: 'page_4x5',
        type: 'image',
        role: 'official_logo',
        locked: true,
        zIndex: 10,
        assetSha256: (kaaeClientDNA.assets?.logos?.primary?.sha256 || 'accadd24fd04d26d8e700ef2fb07ce50f128beb2924562d7cc4a5b02e4670be7') as SHA256,
        box: { x: 410, y: 80, width: 260, height: 110 },
      },
      {
        id: 'node_headline',
        pageId: 'page_4x5',
        type: 'text',
        role: 'headline',
        text: 'کۆنفرانسی نیشتمانی دڵنیایی جۆری لە پەروەردە',
        font: 'Cairo-Bold',
        locked: false,
        zIndex: 20,
        box: { x: 60, y: 240, width: 960, height: 160 },
      },
      {
        id: 'node_subheadline',
        pageId: 'page_4x5',
        type: 'text',
        role: 'subheadline',
        text: 'National Quality Assurance Conference',
        font: 'Inter-Bold',
        locked: false,
        zIndex: 20,
        box: { x: 60, y: 430, width: 960, height: 90 },
      },
      {
        id: 'node_date',
        pageId: 'page_4x5',
        type: 'text',
        role: 'body',
        text: 'ڕێکەوت: 2026-09-15 | شوێن: هۆڵی پێشەوا، هەولێر',
        font: 'Cairo-Regular',
        locked: false,
        zIndex: 20,
        box: { x: 100, y: 860, width: 880, height: 120 },
      },
      {
        id: 'node_disclaimer',
        pageId: 'page_4x5',
        type: 'text',
        role: 'disclaimer',
        text: 'دەستەی متمانەبەخشی بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان',
        font: 'NotoNaskhArabic-Regular',
        locked: true,
        zIndex: 20,
        box: { x: 60, y: 1220, width: 960, height: 60 },
      },
    ],
    fonts: [
      { family: 'Cairo', style: 'Bold' },
      { family: 'Inter', style: 'Bold' },
      { family: 'Noto Naskh Arabic', style: 'Regular' },
    ],
    assets: [
      {
        sha256: (kaaeClientDNA.assets?.logos?.primary?.sha256 || 'accadd24fd04d26d8e700ef2fb07ce50f128beb2924562d7cc4a5b02e4670be7') as SHA256,
        mimeType: 'image/png',
        sourceId: 'logo_primary',
      },
    ],
    warnings: [],
  };

  const canonicalRenders: RenderedOutput[] = [
    {
      pageId: 'page_4x5',
      format: 'png',
      storageKey: 'renders/kaae_4x5.png',
      sha256: 'sha256_mock_render_4x5' as SHA256,
      byteSize: 102400,
      width: 1080,
      height: 1350,
      warnings: [],
    },
  ];

  beforeEach(() => {
    qaEngine = new DeterministicQAEngine();
  });

  describe('1. Positive Baseline Verification (Full Quality Pass)', () => {
    it('passes completely with status=passed, criticalPass=true, and zero critical findings', async () => {
      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: JSON.parse(JSON.stringify(canonicalManifest)),
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
        captureSet: {
          semanticCoverage: { textNodesCount: 4, imageFillsCount: 1, hasLogo: true, isComplete: true, unobservedLayersCount: 0 },
        },
        capturedPackageId: 'pkg_valid_kaae_capture_001',
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const report = res.value;
      expect(report.status).toBe('passed');
      expect(report.criticalPass).toBe(true);
      expect(report.findings.filter((f) => f.hardFailure)).toHaveLength(0);
    });
  });

  describe('2. Negative Control 1: Altered Date Token Mutation', () => {
    it('rejects design when date token 2026-09-15 is altered to 2026-09-20', async () => {
      const mutatedManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const dateNode = mutatedManifest.nodes.find((n) => n.id === 'node_date')!;
      dateNode.text = 'ڕێکەوت: 2026-09-20 | شوێن: هۆڵی پێشەوا، هەولێر'; // Mutated date!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: mutatedManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      expect(res.value.criticalPass).toBe(false);
      const dateFinding = res.value.findings.find((f) => f.ruleId === 'PROTECTED_TOKEN_MUTATED');
      expect(dateFinding).toBeDefined();
      expect(dateFinding?.message).toContain('2026-09-15');
    });
  });

  describe('3. Negative Control 2: Altered Statutory Decree / Institutional Legal Claim', () => {
    it('rejects design when statutory decree token is mutated or omitted', async () => {
      const mutatedManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const disclNode = mutatedManifest.nodes.find((n) => n.id === 'node_disclaimer')!;
      disclNode.text = 'دەستەی متمانەبەخشی بەپێی یاسای ژمارە (٧)ی ساڵی ٢٠٢٣'; // Mutated decree!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: mutatedManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const decreeFinding = res.value.findings.find(
        (f) => f.ruleId === 'PROTECTED_TOKEN_MUTATED' && f.message.includes('یاسای ژمارە (٦)ی ساڵی ٢٠٢٢')
      );
      expect(decreeFinding).toBeDefined();
    });
  });

  describe('4. Negative Control 3: Confidentiality Policy Violation', () => {
    it('rejects design when confidential or forbidden token leaks into canvas text', async () => {
      const leakedManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const headlineNode = leakedManifest.nodes.find((n) => n.id === 'node_headline')!;
      headlineNode.text += ' [internal_budget_confidential]'; // Leaked confidential token!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: leakedManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const confFinding = res.value.findings.find((f) => f.ruleId === 'CONFIDENTIALITY_POLICY_VIOLATION');
      expect(confFinding).toBeDefined();
      expect(confFinding?.message).toContain('internal_budget_confidential');
    });
  });

  describe('5. Negative Control 4: Wrong or Mutated Official Logo Hash', () => {
    it('rejects design when official logo hash does not match Client DNA approved hash', async () => {
      const wrongLogoManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const logoNode = wrongLogoManifest.nodes.find((n) => n.role === 'official_logo')!;
      logoNode.assetSha256 = 'sha256_unauthorized_spoofed_logo' as SHA256; // Wrong hash!
      wrongLogoManifest.assets = []; // No approved logo in manifest

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: wrongLogoManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const logoFinding = res.value.findings.find((f) => f.ruleId === 'OFFICIAL_LOGO_MISSING_OR_MUTATED');
      expect(logoFinding).toBeDefined();
    });
  });

  describe('6. Negative Control 5: Invisible Text Defect', () => {
    it('rejects design when text node has opacity 0 or matching background color', async () => {
      const invisibleManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const subheadlineNode = invisibleManifest.nodes.find((n) => n.id === 'node_subheadline') as any;
      subheadlineNode.opacity = 0; // Invisible!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: invisibleManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const invisFinding = res.value.findings.find((f) => f.ruleId === 'INVISIBLE_TEXT_DEFECT');
      expect(invisFinding).toBeDefined();
    });
  });

  describe('7. Negative Control 6: Text Overflow & Canvas Clipping Defect', () => {
    it('rejects design when text node overflows canvas bounds', async () => {
      const overflowManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const headlineNode = overflowManifest.nodes.find((n) => n.id === 'node_headline')!;
      // Place node at x: 800, width: 400 on a 1080px canvas -> right edge 1200px (overflows by 120px)
      headlineNode.box = { x: 800, y: 240, width: 400, height: 160 };

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: overflowManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const overflowFinding = res.value.findings.find((f) => f.ruleId === 'TEXT_OVERFLOW_DEFECT');
      expect(overflowFinding).toBeDefined();
      expect(overflowFinding?.message).toContain('overflows canvas artboard');
    });
  });

  describe('8. Negative Control 7: Missing Font / Kurdish Sorani Glyph Coverage Defect', () => {
    it('rejects design when Kurdish Sorani text uses Latin-only font without Kurdish glyphs', async () => {
      const fontDefectManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const headlineNode = fontDefectManifest.nodes.find((n) => n.id === 'node_headline')!;
      headlineNode.font = 'Arial-Regular'; // Latin-only font lacking Sorani characters!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: fontDefectManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const fontFinding = res.value.findings.find((f) => f.ruleId === 'FONT_GLYPH_COVERAGE_DEFECT');
      expect(fontFinding).toBeDefined();
      expect(fontFinding?.message).toContain('Arial-Regular');
    });
  });

  describe('9. Negative Control 8: Missing Required Aspect Ratio Variant', () => {
    it('rejects design when brief requires 3 variants but manifest only provides 2', async () => {
      const missingVariantManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      // Remove 9:16 story page
      missingVariantManifest.pages = missingVariantManifest.pages.filter((p) => p.name !== 'Story 9:16');

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: missingVariantManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const variantFinding = res.value.findings.find((f) => f.ruleId === 'REQUIRED_PAGE_VARIANT_MISSING');
      expect(variantFinding).toBeDefined();
      expect(variantFinding?.message).toContain('1080x1920');
    });
  });

  describe('10. Negative Control 9: Zero Renders Provided', () => {
    it('rejects QA check when zero rendered outputs are supplied', async () => {
      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: JSON.parse(JSON.stringify(canonicalManifest)),
        renders: [], // Zero renders!
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const renderFinding = res.value.findings.find((f) => f.ruleId === 'ZERO_RENDERS_DEFECT');
      expect(renderFinding).toBeDefined();
    });
  });

  describe('11. Negative Control 10: Nonexistent Output Package Reference', () => {
    it('rejects QA check when captured package ID does not exist', async () => {
      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: JSON.parse(JSON.stringify(canonicalManifest)),
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
        capturedPackageId: 'pkg_nonexistent_deadbeef', // Nonexistent!
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.status).toBe('failed');
      const pkgFinding = res.value.findings.find((f) => f.ruleId === 'NONEXISTENT_PACKAGE_ERROR');
      expect(pkgFinding).toBeDefined();
    });
  });

  describe('12. Invariant: Advisory Visual Critique Cannot Waive Hard Failures', () => {
    it('ensures high advisory score (99/100) cannot waive hard failure (mutated date)', async () => {
      const mutatedManifest: NeutralManifest = JSON.parse(JSON.stringify(canonicalManifest));
      const dateNode = mutatedManifest.nodes.find((n) => n.id === 'node_date')!;
      dateNode.text = 'ڕێکەوت: 2026-09-20 | شوێن: هۆڵی پێشەوا، هەولێر'; // Mutated date!

      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: mutatedManifest,
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
        advisoryVisionScore: 99, // Super high aesthetic score from vision model!
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const report = res.value;
      // Invariant: Status must remain FAILED, criticalPass must be FALSE
      expect(report.status).toBe('failed');
      expect(report.criticalPass).toBe(false);
      expect(report.advisorySummary?.waivedHardFailuresCount).toBe(0);
    });
  });

  describe('13. Invariant: Insufficient Inspection Coverage is BLOCKED', () => {
    it('marks QA status as BLOCKED when source snapshot has unobserved layers', async () => {
      const request: QARequest = {
        taskId,
        designRevisionId,
        document: documentRef,
        sourceHash: 'sha256_mock' as SHA256,
        manifest: JSON.parse(JSON.stringify(canonicalManifest)),
        renders: canonicalRenders,
        brief: canonicalBrief,
        clientDna: kaaeClientDNA as any,
        profile: { name: 'Institutional_Strict', version: '1.0', rules: {} },
        repairCycle: 0,
        captureSet: {
          semanticCoverage: {
            textNodesCount: 2,
            imageFillsCount: 1,
            hasLogo: true,
            isComplete: false, // Incomplete snapshot!
            unobservedLayersCount: 3,
          },
        },
      };

      const res = await qaEngine.run(mockCtx, request);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Status must be blocked, not passed
      expect(res.value.status).toBe('blocked');
      expect(res.value.criticalPass).toBe(false);
      const coverageFinding = res.value.findings.find((f) => f.ruleId === 'INSUFFICIENT_INSPECTION_COVERAGE');
      expect(coverageFinding).toBeDefined();
    });
  });
});
