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
  type DesignBrief,
  type DesignPlan,
} from '@hawa/domain';
import { BoundedCreativePlanner } from '@hawa/creative';

describe('CV-11: Create Native Canva Designs from the Start', () => {
  let canvaAdapter: CanvaNativeAdapter;
  let planner: BoundedCreativePlanner;

  const tenantId = 't0000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    canvaAdapter = new CanvaNativeAdapter();
    planner = new BoundedCreativePlanner();
  });

  describe('1. First Fixture: Complete Exact KAAE Invitation (Text Comparison & Logo Identity)', () => {
    it('reads back canonical master invitation with full exact text, logo identity, and addressable native nodes', async () => {
      const readbackRes = await canvaAdapter.readbackDesign('DAF_kaae_invitation_template_master');
      expect(readbackRes.ok).toBe(true);
      if (!readbackRes.ok) return;

      const design = readbackRes.value;
      expect(design.canvaDesignId).toBe('DAF_kaae_invitation_template_master');
      expect(design.canvaTeamId).toBe('team_kaae_erbil');
      expect(design.pages).toHaveLength(1);

      const page = design.pages[0];
      expect(page.width).toBe(1080);
      expect(page.height).toBe(1350);

      // Verify Logo Identity (FR-027)
      const logoElement = page.elements.find((el) => el.role === 'official_logo');
      expect(logoElement).toBeDefined();
      expect(logoElement?.type).toBe('image');
      expect(logoElement?.assetRef?.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(logoElement?.box).toEqual({ x: 410, y: 80, width: 260, height: 110 });
      expect(logoElement?.locked).toBe(true);

      // Verify Full Invitation Exact Copy (FR-014, FR-015, FR-028)
      const headlineCkb = page.elements.find((el) => el.role === 'headline');
      expect(headlineCkb?.text).toBe('کۆنفرانسی نیشتمانی دڵنیایی جۆری لە پەروەردە');
      expect(headlineCkb?.locked).toBe(false);

      const subheadlineEn = page.elements.find((el) => el.role === 'subheadline');
      expect(subheadlineEn?.text).toBe('National Quality Assurance Conference');
      expect(subheadlineEn?.locked).toBe(false);

      const bodyCkb = page.elements.find((el) => el.role === 'body' && el.id === 'elem_text_body');
      expect(bodyCkb?.text).toBe('بانگهێشتنامەی فەرمی بۆ ئامادەبوون لە کۆنفرانسی ساڵانەی پێوەرەکانی متمانەبەخشین.');
      expect(bodyCkb?.locked).toBe(false);

      const dateLoc = page.elements.find((el) => el.id === 'elem_text_date_location');
      expect(dateLoc?.text).toBe('ڕێکەوت: 2026-09-15 | شوێن: هۆڵی پێشەوا، هەولێر');

      const cta = page.elements.find((el) => el.role === 'cta');
      expect(cta?.text).toBe('پشتڕاستکردنەوەی ئامادەبوون: www.kaae.org');

      const disclaimer = page.elements.find((el) => el.role === 'disclaimer');
      expect(disclaimer?.text).toBe('دەستەی متمانەبەخشی بەپێی یاسای ژمارە (٦)ی ساڵی ٢٠٢٢ لە هەرێمی کوردستان');

      // Semantic coverage verification
      expect(design.semanticCoverage.textNodesCount).toBe(6);
      expect(design.semanticCoverage.hasLogo).toBe(true);
      expect(design.semanticCoverage.isComplete).toBe(true);
    });
  });

  describe('2. Path A: Native Template Duplication & Parametric Fill', () => {
    it('clones master template to real Canva design ID and replaces target fields without clobbering layout', async () => {
      const taskId = crypto.randomUUID();
      const duplicateRes = await canvaAdapter.duplicateAndFillTemplate({
        templateDesignId: 'DAF_kaae_invitation_template_master',
        newTitle: 'KAAE Gala Invitation 2026 — Erbil Hall',
        taskId,
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {
          elem_text_date_location: 'ڕێکەوت: 2026-10-20 | شوێن: هۆتێلی ڕۆتانا، هەولێر',
          elem_text_cta: 'تکایە ناوت تۆمار بکە: https://kaae.gov.krd/gala',
        },
      });

      expect(duplicateRes.ok).toBe(true);
      if (!duplicateRes.ok) return;

      const cloned = duplicateRes.value;
      // Real Canva design ID generated
      expect(cloned.canvaDesignId).toMatch(/^DAF_[a-f0-9]{16}$/);
      expect(cloned.parentRevisionId).toBe('DAF_kaae_invitation_template_master');
      expect(cloned.version).toBe(1);
      expect(cloned.editUrl).toBe(`https://www.canva.com/design/${cloned.canvaDesignId}/edit`);

      // Read back cloned design from store
      const readbackRes = await canvaAdapter.readbackDesign(cloned.canvaDesignId);
      expect(readbackRes.ok).toBe(true);
      if (!readbackRes.ok) return;

      const elements = readbackRes.value.pages[0].elements;
      // Replaced fields reflect updated values
      const updatedDate = elements.find((el) => el.id === 'elem_text_date_location');
      expect(updatedDate?.text).toBe('ڕێکەوت: 2026-10-20 | شوێن: هۆتێلی ڕۆتانا، هەولێر');

      const updatedCta = elements.find((el) => el.id === 'elem_text_cta');
      expect(updatedCta?.text).toBe('تکایە ناوت تۆمار بکە: https://kaae.gov.krd/gala');

      // Unrelated fields preserved
      const headline = elements.find((el) => el.role === 'headline');
      expect(headline?.text).toBe('کۆنفرانسی نیشتمانی دڵنیایی جۆری لە پەروەردە');

      const logo = elements.find((el) => el.role === 'official_logo');
      expect(logo?.assetRef?.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('3. Reopen & One-Field Local Edit Preservation (FR-031, FR-032)', () => {
    it('modifies one text field, increments revision version, and strictly preserves unrelated nodes', async () => {
      // 1. Clone a fresh working design
      const dupRes = await canvaAdapter.duplicateAndFillTemplate({
        templateDesignId: 'DAF_kaae_invitation_template_master',
        newTitle: 'KAAE Working Draft Rev 1',
        taskId: crypto.randomUUID(),
        clientId: kaaeClientDNA.clientId,
        tenantId,
        substitutions: {},
      });
      expect(dupRes.ok).toBe(true);
      if (!dupRes.ok) return;
      const designId = dupRes.value.canvaDesignId;

      // 2. Read snapshot before edit
      const beforeRes = await canvaAdapter.readbackDesign(designId);
      expect(beforeRes.ok).toBe(true);
      if (!beforeRes.ok) return;
      const beforeElements = beforeRes.value.pages[0].elements;
      const originalHeadline = beforeElements.find((el) => el.id === 'elem_text_headline')!;
      const originalLogo = beforeElements.find((el) => el.role === 'official_logo')!;
      const originalBg = beforeElements.find((el) => el.role === 'background')!;

      // 3. Apply one-field edit: modify only the CTA button text and color
      const editRes = await canvaAdapter.applyOneFieldEdit({
        canvaDesignId: designId,
        targetElementId: 'elem_text_cta',
        newText: 'تۆمارکردنی بەپەلە: www.kaae.org/urgent',
        newColor: '#38BDF8',
      });

      expect(editRes.ok).toBe(true);
      if (!editRes.ok) return;
      const edited = editRes.value;

      // Invariant: Version increments from 1 to 2 (FR-032)
      expect(edited.version).toBe(2);

      // 4. Read back and verify strict preservation of unrelated nodes (FR-031)
      const afterRes = await canvaAdapter.readbackDesign(designId);
      expect(afterRes.ok).toBe(true);
      if (!afterRes.ok) return;
      const afterElements = afterRes.value.pages[0].elements;

      // Edited node is updated
      const afterCta = afterElements.find((el) => el.id === 'elem_text_cta');
      expect(afterCta?.text).toBe('تۆمارکردنی بەپەلە: www.kaae.org/urgent');
      expect(afterCta?.textStyle?.color).toBe('#38BDF8');

      // Unrelated headline is identical
      const afterHeadline = afterElements.find((el) => el.id === 'elem_text_headline')!;
      expect(afterHeadline.text).toBe(originalHeadline.text);
      expect(afterHeadline.box).toEqual(originalHeadline.box);
      expect(afterHeadline.textStyle).toEqual(originalHeadline.textStyle);

      // Unrelated logo is identical
      const afterLogo = afterElements.find((el) => el.role === 'official_logo')!;
      expect(afterLogo.assetRef?.sha256).toBe(originalLogo.assetRef?.sha256);
      expect(afterLogo.box).toEqual(originalLogo.box);

      // Unrelated background is identical
      const afterBg = afterElements.find((el) => el.role === 'background')!;
      expect(afterBg.fillColor).toBe(originalBg.fillColor);
      expect(afterBg.box).toEqual(originalBg.box);
    });
  });

  describe('4. Path B: Minimal Native-Element Assembly for Novel Layouts (FR-025, FR-026, FR-028)', () => {
    it('assembles a novel Canva design with independent addressable native elements for Drustee Clinical Launch', async () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: drusteeClientDNA.clientId,
        clientDnaVersion: drusteeClientDNA.version,
        objective: 'Novel Drustee Vitamin C Serum Clinical Launch',
        rawRequestText: 'کەمپینی نوێی سیرۆمی ڤیتامین C بە نرخی 25,000 IQD',
        providedCopy: [
          { role: 'headline', text: 'سیرۆمی ڤیتامین C دروستی', language: 'ckb', direction: 'rtl' },
          { role: 'subheadline', text: 'داشکاندنی تایبەت بە نرخی 25,000 IQD بۆ ماوەیەکی دیاریکراو', language: 'ckb', direction: 'rtl' },
          { role: 'disclaimer', text: 'تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە', language: 'ckb', direction: 'rtl' },
          { role: 'cta', text: 'داواکردنی ڕاستەوخۆ: www.drustee.krd', language: 'ckb', direction: 'rtl' },
        ],
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;
      const brief = briefRes.value;

      const planRes = planner.createBoundedPlan(brief, drusteeClientDNA);
      expect(planRes.ok).toBe(true);
      if (!planRes.ok) return;
      const plan = planRes.value;

      // Assemble novel layout with native Canva elements
      const novelRes = await canvaAdapter.assembleNovelLayout({
        brief,
        plan,
        clientDna: drusteeClientDNA,
        title: 'Drustee Vitamin C Clinical Launch — Novel Canva Layout',
        tenantId,
      });

      expect(novelRes.ok).toBe(true);
      if (!novelRes.ok) return;

      const design = novelRes.value;
      expect(design.canvaDesignId).toMatch(/^DAF_novel_[a-f0-9]{16}$/);
      expect(design.editUrl).toContain('https://www.canva.com/design/');
      expect(design.semanticCoverage.isComplete).toBe(true);
      expect(design.semanticCoverage.hasLogo).toBe(true);
      expect(design.semanticCoverage.textNodesCount).toBe(4);

      // Reopen and inspect all live addressable nodes
      const readback = await canvaAdapter.readbackDesign(design.canvaDesignId);
      expect(readback.ok).toBe(true);
      if (!readback.ok) return;

      const elements = readback.value.pages[0].elements;
      // 1. Background
      const bg = elements.find((el) => el.role === 'background');
      expect(bg).toBeDefined();
      expect(bg?.type).toBe('shape');

      // 2. Official Logo
      const logo = elements.find((el) => el.role === 'official_logo');
      expect(logo?.assetRef?.sha256).toBe('6a3f120199e43681c2f8832a819b91811a2f64e26a7cb0195e3479a9578107ef');

      // 3. Independent live text blocks
      const headline = elements.find((el) => el.role === 'headline');
      expect(headline?.text).toBe('سیرۆمی ڤیتامین C دروستی');
      expect(headline?.locked).toBe(false);

      const subheadline = elements.find((el) => el.role === 'subheadline');
      expect(subheadline?.text).toContain('25,000 IQD');
      expect(subheadline?.locked).toBe(false);

      const disclaimer = elements.find((el) => el.role === 'disclaimer');
      expect(disclaimer?.text).toBe('تەواوکەری خۆراکییە و جێگەی دەرمان ناگرێتەوە');

      const cta = elements.find((el) => el.role === 'cta');
      expect(cta?.text).toBe('داواکردنی ڕاستەوخۆ: www.drustee.krd');
    });

    it('STRICT INVARIANT: rejects whole-poster flat SVG/image upload with FLAT_POSTER_REJECTED (FR-028)', async () => {
      const briefRes = planner.createBrief({
        taskId: crypto.randomUUID(),
        clientId: drusteeClientDNA.clientId,
        clientDnaVersion: drusteeClientDNA.version,
        objective: 'Test Flat Poster Rejection',
        rawRequestText: 'تاقیکردنەوەی ڕەتکردنەوەی وێنەی پەستێنراو',
      });
      expect(briefRes.ok).toBe(true);
      if (!briefRes.ok) return;

      const planRes = planner.createBoundedPlan(briefRes.value, drusteeClientDNA);
      expect(planRes.ok).toBe(true);
      if (!planRes.ok) return;

      // Caller attempts to upload a single flattened SVG poster
      const flatUploadAttempt = await canvaAdapter.assembleNovelLayout({
        brief: briefRes.value,
        plan: planRes.value,
        clientDna: drusteeClientDNA,
        title: 'Flat SVG Poster Attempt',
        tenantId,
        flatPosterUploadPayload: {
          svgUrl: 'https://cdn.example.com/flattened_poster.svg',
        },
      });

      expect(flatUploadAttempt.ok).toBe(false);
      if (!flatUploadAttempt.ok) {
        expect(flatUploadAttempt.error.code).toBe('FLAT_POSTER_REJECTED');
        expect(flatUploadAttempt.error.message).toContain('Rejecting flat whole-poster upload');
        expect(flatUploadAttempt.error.safeAction).toContain('Assemble individual native elements');
      }
    });
  });
});
