import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  CanvaNativeAdapter,
  type CanvaNativeDesign,
  type CanvaNativeElement,
} from '@hawa/integrations';
import {
  kaaeClientDNA,
  drusteeClientDNA,
} from '@hawa/domain';
import type { BoundedCanvaOperation, SHA256 } from '@hawa/contracts';

describe('CV-12: Qualify Native Manual Editing & Bounded AI Edits', () => {
  let adapter: CanvaNativeAdapter;
  const tenantId = 't0000000-0000-4000-8000-000000000001';
  const masterTemplateId = 'DAF_kaae_invitation_template_master';

  beforeEach(() => {
    adapter = new CanvaNativeAdapter();
  });

  describe('1. Native Canva Controls Delegation & Desktop/Mobile Edit Matrix', () => {
    it('proves Hawa delegates text, font, spacing, geometry, crop, alignment, layer/group, and undo/redo to Canva native UI', () => {
      const endpoints = adapter.getEditorEndpoints(masterTemplateId);

      // Verify desktop web editor URL
      expect(endpoints.desktopWebUrl).toBe(`https://www.canva.com/design/${masterTemplateId}/edit`);
      // Verify mobile universal link (iOS / Android Canva app)
      expect(endpoints.mobileUniversalLink).toBe(`canva://design/${masterTemplateId}/edit`);
      // Verify mobile web fallback URL
      expect(endpoints.mobileWebUrl).toBe(`https://www.canva.com/design/${masterTemplateId}/edit?mobile=true`);

      // Verify all native controls are handled by Canva, never duplicated in Hawa
      expect(endpoints.supportedNativeControls).toContain('text');
      expect(endpoints.supportedNativeControls).toContain('font');
      expect(endpoints.supportedNativeControls).toContain('spacing');
      expect(endpoints.supportedNativeControls).toContain('geometry');
      expect(endpoints.supportedNativeControls).toContain('crop');
      expect(endpoints.supportedNativeControls).toContain('alignment');
      expect(endpoints.supportedNativeControls).toContain('layer_group');
      expect(endpoints.supportedNativeControls).toContain('undo_redo');
      expect(endpoints.supportedNativeControls).toContain('variants');
    });
  });

  describe('2. Single Automation Lease & Concurrent Writer Coordination', () => {
    it('grants automation lease to single Hawa writer, blocks second writer, and preserves external human Canva access', async () => {
      const taskId = crypto.randomUUID();
      const holderA = 'hawa_writer_service_alpha';
      const holderB = 'hawa_writer_service_beta';

      // 1. Writer A acquires lease
      const leaseResA = await adapter.acquireAutomationLease({
        taskId,
        canvaDesignId: masterTemplateId,
        holderId: holderA,
        ttlSeconds: 30,
      });
      expect(leaseResA.ok).toBe(true);
      if (!leaseResA.ok) return;

      const leaseA = leaseResA.value;
      expect(leaseA.holderId).toBe(holderA);
      expect(leaseA.canvaDesignId).toBe(masterTemplateId);

      // 2. Writer B attempts concurrent acquisition -> blocked with AUTOMATION_LEASE_HELD
      const leaseResB = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: masterTemplateId,
        holderId: holderB,
        ttlSeconds: 30,
      });
      expect(leaseResB.ok).toBe(false);
      if (leaseResB.ok) return;
      expect(leaseResB.error.code).toBe('AUTOMATION_LEASE_HELD');
      expect(leaseResB.error.detail?.currentHolder).toBe(holderA);

      // 3. INVARIANT: External Canva human users are NEVER locked by Hawa leases
      const humanLocked = adapter.isExternalHumanLocked(masterTemplateId);
      expect(humanLocked).toBe(false);

      // 4. Renewal by same holder succeeds
      const renewRes = await adapter.renewAutomationLease(leaseA.leaseId, 60);
      expect(renewRes.ok).toBe(true);

      // 5. Release lease allows Writer B to acquire
      const releaseRes = await adapter.releaseAutomationLease(leaseA.leaseId);
      expect(releaseRes.ok).toBe(true);

      const leaseResB2 = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: masterTemplateId,
        holderId: holderB,
        ttlSeconds: 30,
      });
      expect(leaseResB2.ok).toBe(true);
    });
  });

  describe('3. Concurrent Human Edit Detection (Anti-Overwrite Invariant)', () => {
    it('aborts bounded AI edit with EXPECTED_REVISION_MISMATCH when external human designer modifies design in Canva', async () => {
      // 1. Clone a working design
      const dupRes = await adapter.duplicateAndFillTemplate({
        templateDesignId: masterTemplateId,
        newTitle: 'KAAE Working Draft with Human Protection',
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {},
      });
      expect(dupRes.ok).toBe(true);
      if (!dupRes.ok) return;
      const designId = dupRes.value.canvaDesignId;

      // 2. Acquire automation lease and capture source observation hash
      const readRes = await adapter.readbackDesign(designId);
      expect(readRes.ok).toBe(true);
      if (!readRes.ok) return;
      const initialSha256 = adapter.computeObservationHash(readRes.value);

      const leaseRes = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: designId,
        holderId: 'ai_operator_agent',
      });
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;
      const lease = leaseRes.value;

      // 3. Human designer modifies the design directly in Canva editor (e.g. adjusts date text)
      const humanEditRes = await adapter.applyOneFieldEdit({
        canvaDesignId: designId,
        targetElementId: 'elem_text_date_location',
        newText: 'ڕێکەوت: ٢٠٢٦/١٠/٠٥ | دەستکاری کرا لەلایەن دیزاینەری مرۆڤەوە',
      });
      expect(humanEditRes.ok).toBe(true);

      // 4. AI tries to stage edit using stale expectedSourceSha256
      const stageRes = await adapter.stageEditTransaction({
        leaseId: lease.leaseId,
        canvaDesignId: designId,
        expectedSourceSha256: initialSha256, // Stale!
        operations: [
          {
            op: 'replace_text',
            elementId: 'elem_text_headline',
            text: 'سەردێڕی دەستکاریکراو',
          },
        ],
      });

      // 5. Invariant check: Rejected with EXPECTED_REVISION_MISMATCH, human edit preserved
      expect(stageRes.ok).toBe(false);
      if (stageRes.ok) return;
      expect(stageRes.error.code).toBe('EXPECTED_REVISION_MISMATCH');

      // Verify human edit remains intact
      const verifyRes = await adapter.readbackDesign(designId);
      expect(verifyRes.ok).toBe(true);
      if (!verifyRes.ok) return;
      const dateEl = verifyRes.value.pages[0].elements.find((el) => el.id === 'elem_text_date_location');
      expect(dateEl?.text).toBe('ڕێکەوت: ٢٠٢٦/١٠/٠٥ | دەستکاری کرا لەلایەن دیزاینەری مرۆڤەوە');
    });
  });

  describe('4. Bounded AI Edit Translation & Geometry Application Post-Formatting', () => {
    it('translates AI request, stages preview, applies post-formatting height reflow, and commits revision', async () => {
      // 1. Clone a fresh working design
      const dupRes = await adapter.duplicateAndFillTemplate({
        templateDesignId: masterTemplateId,
        newTitle: 'KAAE Gala 2026 Final Invitation',
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {},
      });
      expect(dupRes.ok).toBe(true);
      if (!dupRes.ok) return;
      const designId = dupRes.value.canvaDesignId;

      // 2. Read baseline and acquire lease
      const readRes = await adapter.readbackDesign(designId);
      expect(readRes.ok).toBe(true);
      if (!readRes.ok) return;
      const initialSha256 = adapter.computeObservationHash(readRes.value);
      const initialHeadline = readRes.value.pages[0].elements.find((el) => el.id === 'elem_text_headline')!;
      const initialHeight = initialHeadline.box.height;

      const leaseRes = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: designId,
        holderId: 'hawa_bounded_planner',
      });
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;

      // 3. AI request with substantial Kurdish text expansion
      const expandedKurdishText =
        'کۆنفرانسی نیشتمانی دڵنیایی جۆری لە پەروەردە و فێرکردنی باڵا بە ئامادەبوونی سەرجەم زانکۆکانی هەرێمی کوردستان و نوێنەرانی نێودەوڵەتی';

      const translation = adapter.translateAiRequestToNativeOperations({
        targetDesignId: designId,
        prompt: 'Expand conference headline to include international delegations and full formal title',
        operations: [
          {
            type: 'replace_text',
            elementId: 'elem_text_headline',
            text: expandedKurdishText,
          },
          {
            type: 'adjust_style',
            elementId: 'elem_text_headline',
            style: { color: '#F8FAFC' },
          },
        ],
      });

      expect(translation.supportedOps).toHaveLength(2);
      expect(translation.unsupportedActions).toHaveLength(0);

      // 4. Stage transaction
      const stageRes = await adapter.stageEditTransaction({
        leaseId: leaseRes.value.leaseId,
        canvaDesignId: designId,
        expectedSourceSha256: initialSha256,
        operations: translation.supportedOps,
      });
      expect(stageRes.ok).toBe(true);
      if (!stageRes.ok) return;
      const tx = stageRes.value;

      // 5. Preview readback inspects updated geometry: height reflowed to fit expanded text
      const previewRes = await adapter.previewReadback(tx.transactionId);
      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;
      const previewHeadline = previewRes.value.pages[0].elements.find((el) => el.id === 'elem_text_headline')!;
      expect(previewHeadline.text).toBe(expandedKurdishText);
      expect(previewHeadline.box.height).toBeGreaterThanOrEqual(initialHeight);

      // 6. Commit transaction
      const commitRes = await adapter.commitEditTransaction(tx.transactionId);
      expect(commitRes.ok).toBe(true);
      if (!commitRes.ok) return;

      const committed = commitRes.value;
      expect(committed.version).toBe(2);
      expect(committed.parentRevisionId).toBe(`${designId}@v1`);

      // 7. Revision history preserves immutable prior snapshot (FR-032)
      const history = adapter.getRevisionHistory(designId);
      expect(history).toHaveLength(1);
      expect(history[0].version).toBe(1);
    });
  });

  describe('5. Cancel Transaction Restores Pristine State', () => {
    it('discards staged preview, releases lease, and preserves original design byte-for-byte', async () => {
      const dupRes = await adapter.duplicateAndFillTemplate({
        templateDesignId: masterTemplateId,
        newTitle: 'KAAE Cancel Drill Design',
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {},
      });
      expect(dupRes.ok).toBe(true);
      if (!dupRes.ok) return;
      const designId = dupRes.value.canvaDesignId;

      const readRes = await adapter.readbackDesign(designId);
      expect(readRes.ok).toBe(true);
      if (!readRes.ok) return;
      const baselineHash = adapter.computeObservationHash(readRes.value);

      const leaseRes = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: designId,
        holderId: 'hawa_abort_tester',
      });
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;

      const stageRes = await adapter.stageEditTransaction({
        leaseId: leaseRes.value.leaseId,
        canvaDesignId: designId,
        expectedSourceSha256: baselineHash,
        operations: [
          {
            op: 'replace_text',
            elementId: 'elem_text_headline',
            text: 'سەردێڕی هەڵوەشاوە',
          },
        ],
      });
      expect(stageRes.ok).toBe(true);
      if (!stageRes.ok) return;

      // Cancel transaction
      const cancelRes = await adapter.cancelEditTransaction(stageRes.value.transactionId);
      expect(cancelRes.ok).toBe(true);

      // Reopen: design is byte-for-byte identical to baseline
      const reopenRes = await adapter.readbackDesign(designId);
      expect(reopenRes.ok).toBe(true);
      if (!reopenRes.ok) return;
      const reopenedHash = adapter.computeObservationHash(reopenRes.value);
      expect(reopenedHash).toBe(baselineHash);
    });
  });

  describe('6. Unsupported Operation Translation to Named Native Human Action', () => {
    it('identifies unsupported AI operation and translates to HUMAN_ACTION_RECOMMENDED without regenerating full design', async () => {
      const translation = adapter.translateAiRequestToNativeOperations({
        targetDesignId: masterTemplateId,
        prompt: 'Morph background vector into intricate abstract curve',
        operations: [
          {
            type: 'arbitrary_vector_morph',
            elementId: 'elem_bg',
            targetSplinePoints: [10, 20, 30, 40],
          },
        ],
      });

      expect(translation.supportedOps[0].op).toBe('unsupported_request');
      expect(translation.unsupportedActions).toHaveLength(1);

      const action = translation.unsupportedActions[0];
      expect(action.code).toBe('UNSUPPORTED_NATIVE_OPERATION');
      expect(action.recommendedAction).toBe('HUMAN_ACTION_RECOMMENDED');
      expect(action.actionName).toBe('MANUAL_CANVA_VECTOR_TWEAK');
      expect(action.targetElementId).toBe('elem_bg');
      expect(action.canvaGuidance).toContain(`https://www.canva.com/design/${masterTemplateId}/edit`);
    });
  });

  describe('7. 50 Undo/Redo Cycles Stress Fixture Qualification', () => {
    it('executes 50 undo/redo stress cycles with 0 dropped nodes and byte-for-byte baseline recovery', async () => {
      const stressRes = await adapter.performUndoRedoStressTest(masterTemplateId, 50);
      expect(stressRes.ok).toBe(true);
      if (!stressRes.ok) return;

      const result = stressRes.value;
      expect(result.cyclesExecuted).toBe(50);
      expect(result.zeroDroppedNodes).toBe(true);
      expect(result.undoMatchesBaseline).toBe(true);
      expect(result.finalMatchesApplied).toBe(true);
    });
  });

  describe('8. Central Kurdish (Sorani) & Arabic Font Glyph Coverage (FR-034, FR-035, FR-037)', () => {
    it('approves authorized client fonts with complete Sorani glyph coverage, rejects Latin-only font', () => {
      const soraniText = 'کۆنفرانسی نیشتمانی پێوەری متمانەبەخشین: پەروەردە و خوێندنی باڵا';

      // Cairo, Vazirmatn, Noto Naskh Arabic cover all Sorani characters
      const cairoCheck = adapter.validateFontGlyphCoverage('Cairo', soraniText, 'ckb');
      expect(cairoCheck.ok).toBe(true);

      const vazirmatnCheck = adapter.validateFontGlyphCoverage('Vazirmatn', soraniText, 'ckb');
      expect(vazirmatnCheck.ok).toBe(true);

      // Latin-only font (e.g. Arial or Helvetica) missing Sorani characters پ, ۆ, ێ, ە
      const arialCheck = adapter.validateFontGlyphCoverage('Arial', soraniText, 'ckb');
      expect(arialCheck.ok).toBe(false);
      if (arialCheck.ok) return;
      expect(arialCheck.error.code).toBe('FONT_GLYPH_COVERAGE_ERROR');
      expect(arialCheck.error.detail?.missingGlyphs).toEqual(expect.arrayContaining(['ۆ', 'ێ', 'ە']));
    });
  });

  describe('9. Linked Aspect Ratio Variants with Explicit Per-Variant Overrides (FR-033)', () => {
    it('generates 1:1 and 9:16 linked variants and preserves explicit per-variant overrides', async () => {
      const variantRes = await adapter.createLinkedVariants({
        masterDesignId: masterTemplateId,
        variantRatios: [
          { name: '1:1', width: 1080, height: 1080 },
          { name: '9:16', width: 1080, height: 1920 },
        ],
        perVariantOverrides: {
          '9:16': {
            elem_text_cta: { y: 1550, height: 90 }, // Shift CTA down for vertical story
          },
        },
      });

      expect(variantRes.ok).toBe(true);
      if (!variantRes.ok) return;

      const design = variantRes.value;
      // Master + 2 linked variants = 3 pages
      expect(design.pages).toHaveLength(3);

      const storyPage = design.pages.find((p) => p.name.includes('9:16'))!;
      expect(storyPage.width).toBe(1080);
      expect(storyPage.height).toBe(1920);

      // Verify explicit per-variant override preserved
      const storyCta = storyPage.elements.find((el) => el.id === 'elem_text_cta')!;
      expect(storyCta.box.y).toBe(1550);
      expect(storyCta.box.height).toBe(90);

      // Verify background stretched to full 9:16 artboard
      const storyBg = storyPage.elements.find((el) => el.role === 'background')!;
      expect(storyBg.box.height).toBe(1920);
    });

    it('rejects createLinkedVariants on design with empty artboards or zero dimensions', async () => {
      const emptyDesignId = 'DAF_empty_artboards';
      adapter.registerDesign({
        canvaDesignId: emptyDesignId,
        title: 'Empty Design',
        tenantId,
        clientId: kaaeClientDNA.clientId,
        taskId: crypto.randomUUID(),
        canvaTeamId: 'team_default',
        pages: [],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        editUrl: `https://www.canva.com/design/${emptyDesignId}/edit`,
        viewUrl: `https://www.canva.com/design/${emptyDesignId}/view`,
        semanticCoverage: { textNodesCount: 0, imageFillsCount: 0, hasLogo: false, isComplete: false, unobservedLayersCount: 0 },
      });

      const emptyRes = await adapter.createLinkedVariants({
        masterDesignId: emptyDesignId,
        variantRatios: [{ name: 'Square', width: 1080, height: 1080 }],
      });
      expect(emptyRes.ok).toBe(false);
      if (emptyRes.ok) return;
      expect(emptyRes.error.code).toBe('INVALID_DESIGN_STRUCTURE');
    });

    it('rejects stageEditTransaction targeting nonexistent elements or violating expectedText optimistic lock', async () => {
      const dupRes = await adapter.duplicateAndFillTemplate({
        templateDesignId: masterTemplateId,
        newTitle: 'KAAE Concurrency Lock Drill',
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {},
      });
      expect(dupRes.ok).toBe(true);
      if (!dupRes.ok) return;
      const designId = dupRes.value.canvaDesignId;
      const designHash = adapter.computeObservationHash(dupRes.value);

      const leaseRes = await adapter.acquireAutomationLease({
        taskId: crypto.randomUUID(),
        canvaDesignId: designId,
        holderId: 'concurrency_lock_tester',
      });
      expect(leaseRes.ok).toBe(true);
      if (!leaseRes.ok) return;

      // 1. Nonexistent element rejected
      const nonExistentRes = await adapter.stageEditTransaction({
        leaseId: leaseRes.value.leaseId,
        canvaDesignId: designId,
        expectedSourceSha256: designHash,
        operations: [
          {
            op: 'replace_text',
            elementId: 'completely_nonexistent_element_404',
            text: 'Will fail',
          },
        ],
      });
      expect(nonExistentRes.ok).toBe(false);
      if (!nonExistentRes.ok) {
        expect(nonExistentRes.error.code).toBe('ELEMENT_NOT_FOUND');
      }

      // 2. Expected text mismatch rejected
      const expectedTextMismatchRes = await adapter.stageEditTransaction({
        leaseId: leaseRes.value.leaseId,
        canvaDesignId: designId,
        expectedSourceSha256: designHash,
        operations: [
          {
            op: 'replace_text',
            elementId: 'elem_text_headline',
            text: 'New Headline',
            expectedText: 'Deliberately incorrect expectation',
          },
        ],
      });
      expect(expectedTextMismatchRes.ok).toBe(false);
      if (!expectedTextMismatchRes.ok) {
        expect(expectedTextMismatchRes.error.code).toBe('EXPECTED_TEXT_MISMATCH');
      }
    });
  });
});
