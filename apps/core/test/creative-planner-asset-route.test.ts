import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  BoundedCreativePlanner,
  HoldoutCopyAuditor,
  BriefBuilder,
  DesignRouter,
  CANONICAL_FORMATS,
} from '@hawa/creative';
import {
  kaaeClientDNA,
  drusteeClientDNA,
  asterClientDNA,
  extractProtectedTokens,
  type DesignBrief,
  type ClientDNA,
} from '@hawa/domain';
import {
  ResilientModelGateway,
  CostGovernor,
  type CostReceipt,
} from '@hawa/integrations';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';

describe('CV-10: Bounded Creative Planner and Asset Route', () => {
  let planner: BoundedCreativePlanner;
  let holdoutAuditor: HoldoutCopyAuditor;
  let costGovernor: CostGovernor;
  let modelGateway: ResilientModelGateway;

  const ctx: RequestContext = {
    tenantId: 't0000000-0000-4000-8000-000000000001',
    actor: { type: 'workflow', id: 'wf-planner-test' },
    correlationId: 'c-planner-cv10',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'idemp-cv10-01',
  };

  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    costGovernor = new CostGovernor();
    planner = new BoundedCreativePlanner({ costGovernor });
    holdoutAuditor = new HoldoutCopyAuditor();
    modelGateway = new ResilientModelGateway();
  });

  describe('1. Structured Brief Generation & Missing Facts Defense (FR-013, FR-014)', () => {
    it('produces a schema-valid DesignBrief with protected tokens for KAAE official announcement', () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        clientDnaVersion: kaaeClientDNA.version,
        objective: 'Official KAAE Quality Standards Announcement for Academic Year 2026-2027',
        rawRequestText: 'ڕاگەیاندنی فەرمی ستانداردەکانی متمانەبەخشین بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە ڕێکەوتی 2026-09-15',
        targetWidth: 1080,
        targetHeight: 1350,
      });

      expect(briefRes.ok).toBe(true);
      if (briefRes.ok) {
        const brief = briefRes.value;
        expect(brief.primaryLanguage).toBe('ckb');
        expect(brief.direction).toBe('rtl');
        expect(brief.variants).toHaveLength(1);
        expect(brief.variants[0].width).toBe(1080);
        expect(brief.variants[0].height).toBe(1350);
        expect(brief.exactCopy).toHaveLength(1);
        expect(brief.missingFacts).toHaveLength(0);

        // Verify protected tokens extracted
        const tokens = brief.exactCopy[0].protectedTokens;
        expect(tokens.length).toBeGreaterThan(0);
        const dateToken = tokens.find((t) => t.type === 'date');
        expect(dateToken).toBeDefined();
        expect(dateToken?.raw).toBe('2026-09-15');
      }
    });

    it('halts with BRIEF_HAS_MISSING_FACTS when blocking indispensable facts are missing (FR-014)', () => {
      // Event announcement without any date provided
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: asterClientDNA.clientId,
        clientDnaVersion: asterClientDNA.version,
        objective: 'Grand Opening Event of Aster Luxury Suites',
        rawRequestText: 'ئاهەنگی کردنەوەی فەرمی لقی نوێی هوتێلی ئەستێرە لە هەولێر بە ئامادەبوونی میوانانی فەرمی',
      });

      expect(briefRes.ok).toBe(false);
      if (!briefRes.ok) {
        expect(briefRes.error.code).toBe('BRIEF_HAS_MISSING_FACTS');
        expect(briefRes.error.detail?.missingFacts[0].field).toBe('event_date');
        expect(briefRes.error.safeAction).toContain('Transition task to PAUSED');
      }
    });
  });

  describe('2. Dual Task Route Selection & Cost Efficiency (FR-016, NFR-018)', () => {
    it('routes routine institutional decree tasks to template_fill with zero generation cost (NFR-018)', () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        clientDnaVersion: kaaeClientDNA.version,
        objective: 'University Eligibility Status Decree for CUE',
        rawRequestText: 'بڕیاری شیاوبوونی زانکۆی کاتۆلیکی لە هەولێر (CUE) بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const resolution = planner.resolveTaskRoute(briefRes.value);
      expect(resolution.route).toBe('template_fill');
      expect(resolution.matchedTemplateId).toBe('kaae_eligibility_decree');
      expect(resolution.confidence).toBeGreaterThanOrEqual(0.95);

      // Package candidate plan
      const packageRes = planner.planCandidatePackage({
        brief: briefRes.value,
        clientDna: kaaeClientDNA,
      });

      expect(packageRes.ok).toBe(true);
      if (packageRes.ok) {
        expect(packageRes.value.routeResolution.route).toBe('template_fill');
        // Routine template tasks avoid deep models and image generation (NFR-018)
        expect(packageRes.value.costReceipt.costUsd).toBe(0.000000);
        expect(packageRes.value.costReceipt.provider).toBe('local');
        expect(packageRes.value.costReceipt.status).toBe('COMMITTED');
      }
    });

    it('routes omnichannel multi-format requests across all 4 canonical formats', () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: drusteeClientDNA.clientId,
        clientDnaVersion: drusteeClientDNA.version,
        objective: 'Omnichannel multi-format campaign for Vitamin D3 Clinical Launch across print and social',
        rawRequestText: 'کەمپینی سەرجەم قەبارەکان بۆ ڤیتامین دی٣ بە نرخی 15,000 IQD',
        providedCopy: [
          { role: 'headline', text: 'ڤیتامین D3 دروستی', language: 'ckb', direction: 'rtl' },
          { role: 'subheadline', text: 'پشتڕاستکراوە بەپێی ستانداردەکانی تەندروستی 15,000 IQD', language: 'ckb', direction: 'rtl' },
          { role: 'disclaimer', text: 'تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە', language: 'ckb', direction: 'rtl' },
        ],
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const resolution = planner.resolveTaskRoute(briefRes.value);
      expect(resolution.route).toBe('multi_format_composition');
      expect(resolution.detectedFormats).toEqual(['feed', 'story', 'landscape', 'print_a4']);
    });
  });

  describe('3. Model Admission & Authentic Provider Receipts (FR-056, FR-057, FR-079)', () => {
    it('admits actual model snapshots by role without hidden remapping', async () => {
      const directorDeployment = await modelGateway.resolve(ctx, 'creative_director');
      expect(directorDeployment.ok).toBe(true);
      if (directorDeployment.ok) {
        expect(directorDeployment.value.provider).toBe('openai');
        expect(directorDeployment.value.exactModelId).toBe('gpt-5.6-sol'); // Exact admitted snapshot
      }

      const judgeDeployment = await modelGateway.resolve(ctx, 'visual_judge');
      expect(judgeDeployment.ok).toBe(true);
      if (judgeDeployment.ok) {
        expect(judgeDeployment.value.provider).toBe('anthropic');
        expect(judgeDeployment.value.exactModelId).toBe('claude-opus-5'); // Exact admitted snapshot
      }
    });

    it('blocks unadmitted or retired models according to admission policy (FR-056, FR-057)', async () => {
      // Mark primary google model as retired
      modelGateway.setDeploymentAdmission('gemini-3.8-flash', 'retired');

      const resolved = await modelGateway.resolve(ctx, 'intake_router');
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        // Skips retired gemini-3.8-flash and picks next admitted fallback (claude-sonnet-5)
        expect(resolved.value.provider).toBe('anthropic');
        expect(resolved.value.exactModelId).toBe('claude-sonnet-5');
      }
    });

    it('enforces pre-flight budget checks and generates committed receipts in client ledger (FR-079)', () => {
      // Set client monthly budget and current spent near cap
      const budget = costGovernor.getOrCreateClientBudget('client-drustee');
      budget.capUsd = 0.10;
      budget.spentUsd = 0.099;

      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: 'client-drustee',
        clientDnaVersion: 1,
        objective: 'Expensive novel visual campaign exceeding budget',
        rawRequestText: 'کەمپینی نوێی داهێنەرانە بۆ فرۆشتن',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const planned = planner.planCandidatePackage({
        brief: briefRes.value,
        clientDna: drusteeClientDNA,
      });

      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.error.code).toBe('BUDGET_EXCEEDED');
        expect(planned.error.message).toContain('Monthly AI budget exceeded for client client-drustee');
      }
    });
  });

  describe('4. Provider Outage Handling & Circuit Breaker (FR-058, FR-059)', () => {
    it('fails over gracefully from primary to secondary when primary encounters rate limit 429', async () => {
      const priorGoogle = process.env.GEMINI_API_KEY;
      const priorAnthropic = process.env.ANTHROPIC_API_KEY;
      process.env.GEMINI_API_KEY = ['fixture', 'google', 'key'].join('-');
      process.env.ANTHROPIC_API_KEY = ['fixture', 'anthropic', 'key'].join('-');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (!String(input).includes('api.anthropic.com')) throw new Error(`Unexpected provider request: ${String(input)}`);
        return new Response(JSON.stringify({
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
          usage: { input_tokens: 100, output_tokens: 20 },
        }), { status: 200 });
      });
      modelGateway.setSimulatedFailure('google', 1);

      const req: StructuredModelRequest = {
        role: 'brief_builder',
        inputs: [{ kind: 'text', text: 'Construct brief for Aster Pharmacy' }],
        systemPromptVersion: '2026-09-04',
        responseSchema: {},
        budget: { maxCostUsd: 0.1, maxLatencyMs: 5000, maxAttempts: 3 },
        egressPolicy: { mode: 'approved_providers', allowedProviders: ['google', 'anthropic', 'openai'] },
        cachePolicy: 'disabled',
      };

      try {
        const res = await modelGateway.generateStructured(ctx, req);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.deployment.provider).toBe('anthropic');
          expect(res.value.deployment.exactModelId).toBe('claude-sonnet-5');
          expect(res.value.attempts).toBe(2);
        }
      } finally {
        fetchSpy.mockRestore();
        if (priorGoogle === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = priorGoogle;
        if (priorAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = priorAnthropic;
      }
    });
  });

  describe('5. Wrong-Output Holdout Controls (FR-014, FR-015)', () => {
    const briefWithTokens: DesignBrief = {
      briefId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      clientId: drusteeClientDNA.clientId,
      clientDnaVersion: 1,
      objective: 'Drustee Vitamin C Serum Discount',
      taskRoute: 'editable_composition',
      primaryLanguage: 'ckb',
      direction: 'rtl',
      variants: [{ id: 'v1', name: 'feed', width: 1080, height: 1350, aspectRatio: '4:5', role: 'instagram_post' }],
      exactCopy: [
        {
          id: 'ec1',
          role: 'headline',
          text: 'سیرۆمی ڤیتامین C دروستی',
          language: 'ckb',
          direction: 'rtl',
          approved: true,
          protectedTokens: [],
        },
        {
          id: 'ec2',
          role: 'subheadline',
          text: 'داشکاندنی تایبەت بە نرخی 25,000 IQD تا ڕێکەوتی 2026-09-30',
          language: 'ckb',
          direction: 'rtl',
          approved: true,
          protectedTokens: [
            { type: 'price', raw: '25,000 IQD', normalized: '25,000 IQD', mustPreserveExact: true },
            { type: 'date', raw: '2026-09-30', normalized: '2026-09-30', mustPreserveExact: true },
          ],
        },
        {
          id: 'ec3',
          role: 'disclaimer',
          text: 'تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە',
          language: 'ckb',
          direction: 'rtl',
          approved: true,
          protectedTokens: [],
        },
      ],
      missingFacts: [],
      requiredAssetRoles: ['logo_primary'],
      createdAt: new Date().toISOString(),
    };

    it('passes holdout audit when all protected tokens, headlines, and disclaimers are preserved', () => {
      const candidateOps = [
        { op: 'addText', text: 'سیرۆمی ڤیتامین C دروستی', role: 'headline' },
        { op: 'addText', text: 'داشکاندنی تایبەت بە نرخی 25,000 IQD تا ڕێکەوتی 2026-09-30', role: 'subheadline' },
        { op: 'addText', text: 'تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە', role: 'disclaimer' },
      ];

      const audit = holdoutAuditor.auditCandidateCopy(briefWithTokens, { operations: candidateOps });
      expect(audit.ok).toBe(true);
      if (audit.ok) {
        expect(audit.value.auditedTokensCount).toBe(2);
        expect(audit.value.exactMatch).toBe(true);
      }
    });

    it('detects price tampering and halts with PROTECTED_TOKEN_MUTATED (FR-014)', () => {
      // Tampered price: changed 25,000 IQD to 20,000 IQD
      const tamperedOps = [
        { op: 'addText', text: 'سیرۆمی ڤیتامین C دروستی', role: 'headline' },
        { op: 'addText', text: 'داشکاندنی تایبەت بە نرخی 20,000 IQD تا ڕێکەوتی 2026-09-30', role: 'subheadline' },
        { op: 'addText', text: 'تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە', role: 'disclaimer' },
      ];

      const audit = holdoutAuditor.auditCandidateCopy(briefWithTokens, { operations: tamperedOps });
      expect(audit.ok).toBe(false);
      if (!audit.ok) {
        expect(audit.error.code).toBe('PROTECTED_TOKEN_MUTATED');
        expect(audit.error.message).toContain('25,000 IQD');
      }
    });

    it('detects dropped statutory disclaimer and halts with MANDATORY_DISCLAIMER_MISSING (FR-014)', () => {
      // Omitted mandatory medical disclaimer
      const missingDisclaimerOps = [
        { op: 'addText', text: 'سیرۆمی ڤیتامین C دروستی', role: 'headline' },
        { op: 'addText', text: 'داشکاندنی تایبەت بە نرخی 25,000 IQD تا ڕێکەوتی 2026-09-30', role: 'subheadline' },
      ];

      const audit = holdoutAuditor.auditCandidateCopy(briefWithTokens, { operations: missingDisclaimerOps });
      expect(audit.ok).toBe(false);
      if (!audit.ok) {
        expect(audit.error.code).toBe('MANDATORY_DISCLAIMER_MISSING');
        expect(audit.error.message).toContain('Statutory holdout control failed');
      }
    });
  });

  describe('6. Bounded Autonomous Repair (Max 2 Cycles) & Work Preservation (FR-040)', () => {
    it('allows up to 2 repair cycles and escalates to OPERATOR_REQUIRED on cycle 3 without losing work', () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        clientDnaVersion: kaaeClientDNA.version,
        objective: 'KAAE Quality Milestone Decree',
        rawRequestText: 'ڕاگەیاندنی دەستکەوتی نێودەوڵەتی متمانەبەخشین بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە بەرواری 2026-09-11',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const packageRes = planner.planCandidatePackage({
        brief: briefRes.value,
        clientDna: kaaeClientDNA,
      });
      expect(packageRes.ok).toBe(true);
      if (!packageRes.ok) return;

      let candidate = packageRes.value;
      expect(candidate.repairCycle).toBe(0);

      // Cycle 1 Repair: Layout text overflow detected
      const repair1 = planner.attemptAutonomousRepair(candidate, 'Text line height collision in Kurdish diacritics');
      expect(repair1.ok).toBe(true);
      if (!repair1.ok) return;
      candidate = repair1.value;
      expect(candidate.repairCycle).toBe(1);
      expect(candidate.status).toBe('REPAIR_REQUIRED');
      expect(candidate.preservedWorkSummary.checkpointsCount).toBe(2);

      // Cycle 2 Repair: Contrast adjustment in header zone
      const repair2 = planner.attemptAutonomousRepair(candidate, 'Header zone contrast below WCAG AA');
      expect(repair2.ok).toBe(true);
      if (!repair2.ok) return;
      candidate = repair2.value;
      expect(candidate.repairCycle).toBe(2);
      expect(candidate.status).toBe('REPAIR_REQUIRED');
      expect(candidate.preservedWorkSummary.checkpointsCount).toBe(3);

      // Attempt 3: Exceeds 2-cycle budget (FR-040)
      const repair3 = planner.attemptAutonomousRepair(candidate, 'Persistent layout margin drift');
      expect(repair3.ok).toBe(false);
      if (!repair3.ok) {
        expect(repair3.error.code).toBe('MAX_REPAIR_BUDGET_EXCEEDED');
        expect(candidate.status).toBe('OPERATOR_REQUIRED');
        // Completed work and checkpoints are preserved
        expect(repair3.error.detail?.preservedCheckpoints).toBe(3);
        expect(repair3.error.detail?.maxAllowed).toBe(2);
        expect(repair3.error.safeAction).toContain('Open Hawa Desk for human designer review');
      }
    });
  });

  describe('7. Visual Ingredient Bounding & Art-Direction Reference Safety (FR-024, FR-026)', () => {
    it('strictly prohibits diffusion model generation for official logos or factual lettering (FR-026)', () => {
      // Candidate client with no official logo in DNA
      const clientWithoutLogo: ClientDNA = {
        ...kaaeClientDNA,
        assets: [], // No official logo
      };

      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: clientWithoutLogo.clientId,
        clientDnaVersion: 1,
        objective: 'KAAE Announcement without vector logo',
        rawRequestText: 'ڕاگەیاندنی فەرمی بەبێ لۆگۆ',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const planned = planner.createBoundedPlan(briefRes.value, clientWithoutLogo);
      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.error.code).toBe('MISSING_BRAND_ASSET');
        expect(planned.error.message).toContain('Diffusion logo invention is strictly prohibited');
      }
    });

    it('enforces Invariant #4: Private composition reference pixels NEVER ship in export artifact (FR-024)', () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: asterClientDNA.clientId,
        clientDnaVersion: asterClientDNA.version,
        objective: 'Novel Luxury Suite Brand Launch Campaign',
        rawRequestText: 'کەمپینی نوێی داهێنەرانە بۆ هۆتێلی ئەستێرە لە هەولێر بەرواری 2026-10-01',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const planRes = planner.createBoundedPlan(briefRes.value, asterClientDNA);
      expect(planRes.ok).toBe(true);
      if (!planRes.ok) return;

      const plan = planRes.value;
      // Invariant: shippedInArtifact MUST be false
      expect(plan.artDirectionReference).toBeDefined();
      expect(plan.artDirectionReference?.shippedInArtifact).toBe(false);

      // Safe export check passes
      const safeCheck = planner.validateExportPackageSafety(plan);
      expect(safeCheck.ok).toBe(true);

      // Mutated export attempting to ship reference pixels fails
      const tamperedPlan = {
        ...plan,
        artDirectionReference: {
          ...plan.artDirectionReference!,
          shippedInArtifact: true as any,
        },
      };

      const blockedCheck = planner.validateExportPackageSafety(tamperedPlan);
      expect(blockedCheck.ok).toBe(false);
      if (!blockedCheck.ok) {
        expect(blockedCheck.error.code).toBe('REFERENCE_PIXEL_SHIPPING_BLOCKED');
      }
    });
  });
});
