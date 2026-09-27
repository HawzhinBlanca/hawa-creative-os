import type { StudioOperation } from '@hawa/contracts';
import type { DesignBrief, DesignPlan, AssetTopology, VisualIngredient, LayoutZone } from '@hawa/domain';
import {
  buildFastpayPromoTemplate,
  buildAsterHealthcareTemplate,
  buildDrusteeClinicalTemplate,
  FASTPAY_PRIMARY_LOGO_SHA256,
  ASTER_PRIMARY_LOGO_SHA256,
  DRUSTEE_PRIMARY_LOGO_SHA256,
} from './templates/index.js';

export type CanonicalFormat = 'feed' | 'story' | 'landscape' | 'print_a4';

export interface CanonicalFormatSpec {
  format: CanonicalFormat;
  name: string;
  width: number;
  height: number;
  aspectRatio: string;
  dpi: number;
  isPrint: boolean;
  safeMarginTop: number;
  safeMarginBottom: number;
  safeMarginSides: number;
  socialTopDangerRatio?: number;
  socialBottomDangerRatio?: number;
  typographyScale: {
    headlineSize: number;
    subheadlineSize: number;
    bodySize: number;
    lineHeight: number;
  };
}

export const CANONICAL_FORMATS: Record<CanonicalFormat, CanonicalFormatSpec> = {
  feed: {
    format: 'feed',
    name: 'Social Feed Card (4:5)',
    width: 1080,
    height: 1350,
    aspectRatio: '4:5',
    dpi: 72,
    isPrint: false,
    safeMarginTop: 60,
    safeMarginBottom: 80,
    safeMarginSides: 60,
    socialTopDangerRatio: 0.04,
    socialBottomDangerRatio: 0.06,
    typographyScale: {
      headlineSize: 48,
      subheadlineSize: 28,
      bodySize: 22,
      lineHeight: 1.38,
    },
  },
  story: {
    format: 'story',
    name: 'Vertical Story (9:16)',
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    dpi: 72,
    isPrint: false,
    safeMarginTop: 270, // 14% top danger
    safeMarginBottom: 384, // 20% bottom danger
    safeMarginSides: 60,
    socialTopDangerRatio: 0.14,
    socialBottomDangerRatio: 0.20,
    typographyScale: {
      headlineSize: 52,
      subheadlineSize: 30,
      bodySize: 24,
      lineHeight: 1.40,
    },
  },
  landscape: {
    format: 'landscape',
    name: 'Horizontal Landscape (16:9)',
    width: 1920,
    height: 1080,
    aspectRatio: '16:9',
    dpi: 72,
    isPrint: false,
    safeMarginTop: 50,
    safeMarginBottom: 60,
    safeMarginSides: 80,
    socialTopDangerRatio: 0.04,
    socialBottomDangerRatio: 0.05,
    typographyScale: {
      headlineSize: 56,
      subheadlineSize: 32,
      bodySize: 24,
      lineHeight: 1.40,
    },
  },
  print_a4: {
    format: 'print_a4',
    name: 'Print A4 Document (300 DPI)',
    width: 2480,
    height: 3508,
    aspectRatio: '1:1.414',
    dpi: 300,
    isPrint: true,
    safeMarginTop: 180,
    safeMarginBottom: 220,
    safeMarginSides: 180,
    typographyScale: {
      headlineSize: 108,
      subheadlineSize: 64,
      bodySize: 46,
      lineHeight: 1.45,
    },
  },
};

export class CreativeDirectorRunner {
  /**
   * Resolves canonical format from brief variants or target format parameter.
   */
  resolveCanonicalFormat(brief: DesignBrief, targetFormat?: CanonicalFormat): CanonicalFormatSpec {
    if (targetFormat && CANONICAL_FORMATS[targetFormat]) {
      return CANONICAL_FORMATS[targetFormat];
    }

    const firstVariant = brief.variants?.[0];
    if (firstVariant) {
      if (firstVariant.width === 1080 && firstVariant.height === 1920) return CANONICAL_FORMATS.story;
      if (firstVariant.width === 1920 && firstVariant.height === 1080) return CANONICAL_FORMATS.landscape;
      if (firstVariant.width === 2480 && firstVariant.height === 3508) return CANONICAL_FORMATS.print_a4;
      if (firstVariant.width === 1080 && firstVariant.height === 1350) return CANONICAL_FORMATS.feed;
      if (firstVariant.aspectRatio === '9:16') return CANONICAL_FORMATS.story;
      if (firstVariant.aspectRatio === '16:9') return CANONICAL_FORMATS.landscape;
      if (firstVariant.aspectRatio === '1:1.414' || firstVariant.name?.toLowerCase().includes('a4')) return CANONICAL_FORMATS.print_a4;
    }

    return CANONICAL_FORMATS.feed;
  }

  /**
   * Creates a structured DesignPlan with format-specific layout zones and typography regions.
   */
  createDesignPlan(brief: DesignBrief, clientColors: string[], format?: CanonicalFormat): DesignPlan {
    const spec = this.resolveCanonicalFormat(brief, format);
    const w = spec.width;
    const h = spec.height;
    const isRtl = brief.direction === 'rtl' || brief.primaryLanguage === 'ckb' || brief.primaryLanguage === 'ar';

    const topology: AssetTopology = spec.format === 'landscape' ? 'modular_field' : 'slot_matrix';

    let zones: LayoutZone[] = [];

    if (spec.format === 'story') {
      // 9:16 Story layout with top (270px) and bottom (384px) safety clearance
      zones = [
        {
          id: 'zone_header',
          name: 'header_logo_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop,
          width: w - spec.safeMarginSides * 2,
          height: 130,
          allowedRoles: ['official_logo'],
          safeMarginPx: 30,
          zIndex: 10,
        },
        {
          id: 'zone_hero',
          name: 'hero_visual_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop + 150,
          width: w - spec.safeMarginSides * 2,
          height: 860,
          allowedRoles: ['subject_cutout', 'product_render', 'background'],
          safeMarginPx: 20,
          zIndex: 1,
        },
        {
          id: 'zone_content',
          name: 'typography_copy_zone',
          x: spec.safeMarginSides,
          y: h - spec.safeMarginBottom - 260,
          width: w - spec.safeMarginSides * 2,
          height: 240,
          allowedRoles: ['headline', 'subheadline', 'cta', 'disclaimer'],
          safeMarginPx: 30,
          zIndex: 20,
        },
      ];
    } else if (spec.format === 'landscape') {
      // 16:9 Landscape split layout
      const splitWidth = Math.floor((w - spec.safeMarginSides * 2 - 40) / 2);
      const heroX = isRtl ? spec.safeMarginSides : spec.safeMarginSides + splitWidth + 40;
      const contentX = isRtl ? spec.safeMarginSides + splitWidth + 40 : spec.safeMarginSides;

      zones = [
        {
          id: 'zone_header',
          name: 'header_logo_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop,
          width: w - spec.safeMarginSides * 2,
          height: 100,
          allowedRoles: ['official_logo'],
          safeMarginPx: 20,
          zIndex: 10,
        },
        {
          id: 'zone_hero',
          name: 'hero_visual_zone',
          x: heroX,
          y: spec.safeMarginTop + 110,
          width: splitWidth,
          height: h - spec.safeMarginTop - spec.safeMarginBottom - 110,
          allowedRoles: ['subject_cutout', 'product_render', 'background'],
          safeMarginPx: 20,
          zIndex: 1,
        },
        {
          id: 'zone_content',
          name: 'typography_copy_zone',
          x: contentX,
          y: spec.safeMarginTop + 140,
          width: splitWidth,
          height: h - spec.safeMarginTop - spec.safeMarginBottom - 140,
          allowedRoles: ['headline', 'subheadline', 'cta', 'disclaimer'],
          safeMarginPx: 30,
          zIndex: 20,
        },
      ];
    } else if (spec.format === 'print_a4') {
      // High-resolution Print A4 (2480x3508 at 300 DPI)
      zones = [
        {
          id: 'zone_header',
          name: 'header_logo_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop,
          width: w - spec.safeMarginSides * 2,
          height: 320,
          allowedRoles: ['official_logo'],
          safeMarginPx: 60,
          zIndex: 10,
        },
        {
          id: 'zone_hero',
          name: 'hero_visual_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop + 360,
          width: w - spec.safeMarginSides * 2,
          height: 1650,
          allowedRoles: ['subject_cutout', 'product_render', 'background'],
          safeMarginPx: 40,
          zIndex: 1,
        },
        {
          id: 'zone_content',
          name: 'typography_copy_zone',
          x: spec.safeMarginSides,
          y: h - spec.safeMarginBottom - 1050,
          width: w - spec.safeMarginSides * 2,
          height: 1020,
          allowedRoles: ['headline', 'subheadline', 'cta', 'disclaimer'],
          safeMarginPx: 60,
          zIndex: 20,
        },
      ];
    } else {
      // Default: 4:5 Feed Portrait (1080x1350)
      zones = [
        {
          id: 'zone_header',
          name: 'header_logo_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop,
          width: w - spec.safeMarginSides * 2,
          height: 120,
          allowedRoles: ['official_logo'],
          safeMarginPx: 40,
          zIndex: 10,
        },
        {
          id: 'zone_hero',
          name: 'hero_visual_zone',
          x: spec.safeMarginSides,
          y: spec.safeMarginTop + 140,
          width: w - spec.safeMarginSides * 2,
          height: 680,
          allowedRoles: ['subject_cutout', 'product_render', 'background'],
          safeMarginPx: 20,
          zIndex: 1,
        },
        {
          id: 'zone_content',
          name: 'typography_copy_zone',
          x: spec.safeMarginSides,
          y: h - spec.safeMarginBottom - 380,
          width: w - spec.safeMarginSides * 2,
          height: 360,
          allowedRoles: ['headline', 'subheadline', 'cta', 'disclaimer'],
          safeMarginPx: 30,
          zIndex: 20,
        },
      ];
    }

    const contentZone = zones.find((z) => z.id === 'zone_content')!;
    const heroZone = zones.find((z) => z.id === 'zone_hero')!;

    const ingredients: VisualIngredient[] = [
      {
        id: 'ing_bg',
        role: 'background',
        sourceType: 'vector_shape',
        targetWidth: w,
        targetHeight: h,
        transparentBackground: false,
      },
      {
        id: 'ing_logo',
        role: 'official_logo',
        sourceType: 'official_asset',
        targetWidth: spec.format === 'print_a4' ? 600 : 260,
        targetHeight: spec.format === 'print_a4' ? 240 : 110,
        transparentBackground: true,
      },
    ];

    return {
      planId: crypto.randomUUID(),
      briefId: brief.briefId,
      taskId: brief.taskId,
      topology,
      rationale: `Multi-format canonical layout for ${spec.name} (${w}x${h}) prioritizing ${isRtl ? 'RTL Kurdish Sorani right-aligned typography' : 'LTR typography'} with diacritic-safe clearance and calibrated zones`,
      zones,
      ingredients,
      artDirectionReference: {
        referenceId: crypto.randomUUID(),
        storageKey: `refs/${brief.taskId}/art_direction_${spec.format}.png`,
        sha256: 'sha256_art_ref_internal_private',
        prompt: `Artistic visual direction for ${brief.objective} in ${spec.name}`,
        modelSnapshot: 'gemini-3.8-flash',
        shippedInArtifact: false, // Invariant 4: MUST BE FALSE
        analyzedFeatures: {
          palette: clientColors.length > 0 ? clientColors : ['#0F172A', '#38BDF8', '#FFFFFF'],
          depthLayers: 3,
          textRegions: [{ x: contentZone.x, y: contentZone.y, width: contentZone.width, height: contentZone.height }],
          focalPoint: { x: heroZone.x + heroZone.width / 2, y: heroZone.y + heroZone.height / 2 },
        },
      },
      estimatedCostUsd: 0.002,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Generates coordinated plans across all requested canonical formats (defaults to all 4).
   */
  createMultiFormatDesignPlans(
    brief: DesignBrief,
    clientColors: string[],
    formats: CanonicalFormat[] = ['feed', 'story', 'landscape', 'print_a4']
  ): Record<CanonicalFormat, DesignPlan> {
    const plans = {} as Record<CanonicalFormat, DesignPlan>;
    for (const fmt of formats) {
      plans[fmt] = this.createDesignPlan(brief, clientColors, fmt);
    }
    return plans;
  }

  /**
   * Generates live, editable StudioOperations for the chosen canonical format.
   */
  generateStudioOperations(
    brief: DesignBrief,
    plan: DesignPlan,
    primaryLogoSha256: string,
    targetFormat?: CanonicalFormat
  ): StudioOperation[] {
    const spec = this.resolveCanonicalFormat(brief, targetFormat);
    const ops: StudioOperation[] = [];
    const pageId = `page_${spec.format}`;
    const isRtl = brief.direction === 'rtl' || brief.primaryLanguage === 'ckb' || brief.primaryLanguage === 'ar';

    // 1. Add background vector/shape
    // KAAE's own styling left this generic generator with its v1 templates (ADR-038): KAAE's designs
    // come from the design studio.
    const bgFill = '<rect width="100%" height="100%" fill="#0B0F19"/>';

    ops.push({
      op: 'addVector',
      nodeId: 'node_bg',
      pageId,
      source: bgFill,
      x: 0,
      y: 0,
      width: spec.width,
      height: spec.height,
      locked: true,
    });

    // 2. Add primary logo asset in header zone
    const headerZone = plan.zones.find((z) => z.id === 'zone_header') || {
      x: spec.safeMarginSides,
      y: spec.safeMarginTop,
      width: spec.width - spec.safeMarginSides * 2,
      height: 120,
    };

    const logoWidth = spec.format === 'print_a4' ? 620 : 240;
    const logoHeight = spec.format === 'print_a4' ? 260 : 80;
    const logoX = isRtl ? headerZone.x + headerZone.width - logoWidth : headerZone.x;

    ops.push({
      op: 'addImage',
      nodeId: 'node_logo',
      pageId,
      asset: {
        storageKey: `assets/logos/${primaryLogoSha256}.png`,
        sha256: primaryLogoSha256,
        mimeType: 'image/png',
      },
      x: logoX,
      y: headerZone.y,
      width: logoWidth,
      height: logoHeight,
      fit: 'contain',
      locked: true,
    });

    // 3. Add live editable text operations in typography content zone
    const contentZone = plan.zones.find((z) => z.id === 'zone_content') || {
      x: spec.safeMarginSides,
      y: spec.height - spec.safeMarginBottom - 300,
      width: spec.width - spec.safeMarginSides * 2,
      height: 260,
    };

    let currentY = contentZone.y;
    const { headlineSize, subheadlineSize, lineHeight } = spec.typographyScale;

    for (let i = 0; i < brief.exactCopy.length; i++) {
      const block = brief.exactCopy[i];
      const isEnglish = block.language === 'en' || block.direction === 'ltr';

      let fontFamily = isEnglish ? 'Inter' : 'Noto Naskh Arabic';
      if (
        brief.clientId === 'c1000000-0000-4000-8000-000000000003' ||
        brief.clientId?.includes('drustee') ||
        brief.clientId === 'c1000000-0000-4000-8000-000000000004' ||
        brief.clientId?.includes('fastpay')
      ) {
        fontFamily = isEnglish ? 'Inter' : 'Vazirmatn';
      } else if (!isEnglish && block.role === 'headline') {
        fontFamily = 'Cairo';
      }

      const fontSize = block.role === 'headline' ? headlineSize : subheadlineSize;
      const blockHeight = Math.round(fontSize * lineHeight * 1.3);

      ops.push({
        op: 'addText',
        nodeId: `node_text_${i}`,
        pageId,
        text: block.text,
        role: block.role,
        x: contentZone.x,
        y: currentY,
        width: contentZone.width,
        height: blockHeight,
        style: {
          fontSize,
          fontWeight: block.role === 'headline' ? 'bold' : 'normal',
          fontFamily,
          textAlign: isEnglish ? 'left' : 'right',
          color: '#FFFFFF',
          lineHeight, // Diacritic-safe Kurdish Sorani line height (>= 1.38)
        },
        locked: false, // Invariant 3: Live text must be editable
      });

      currentY += blockHeight + (spec.format === 'print_a4' ? 30 : 16);
    }

    return ops;
  }

  /**
   * High-level batch generation for all canonical formats in a single pass.
   */
  generateMultiFormatStudioOperations(
    brief: DesignBrief,
    primaryLogoSha256: string,
    formats: CanonicalFormat[] = ['feed', 'story', 'landscape', 'print_a4']
  ): Record<CanonicalFormat, { plan: DesignPlan; operations: StudioOperation[]; formatSpec: CanonicalFormatSpec }> {
    const results = {} as Record<CanonicalFormat, { plan: DesignPlan; operations: StudioOperation[]; formatSpec: CanonicalFormatSpec }>;
    
    for (const fmt of formats) {
      const plan = this.createDesignPlan(brief, [], fmt);
      const operations = this.generateStudioOperations(brief, plan, primaryLogoSha256, fmt);
      results[fmt] = {
        plan,
        operations,
        formatSpec: CANONICAL_FORMATS[fmt],
      };
    }

    return results;
  }

  /**
   * Generates authentic commercial operations for Kurdistan brands (FastPay, Aster Pharmacy, Drustee Health).
   */
  generateCommercialBrandOperations(
    brandId: 'fastpay' | 'aster' | 'drustee' | string,
    brief: DesignBrief,
    customParams?: Record<string, any>
  ): StudioOperation[] {
    const enHeadline = brief.exactCopy.find((c) => c.language === 'en' && c.role === 'headline');
    const ckbHeadline = brief.exactCopy.find((c) => c.language === 'ckb' && c.role === 'headline');
    const enCopy = brief.exactCopy.find((c) => c.language === 'en' && (c.role === 'subheadline' || c.role === 'body'));
    const ckbCopy = brief.exactCopy.find((c) => c.language === 'ckb' && (c.role === 'subheadline' || c.role === 'body'));

    if (brandId === 'fastpay') {
      return buildFastpayPromoTemplate({
        headlineEn: customParams?.headlineEn || enHeadline?.text,
        headlineCkb: customParams?.headlineCkb || ckbHeadline?.text,
        copyEn: customParams?.copyEn || enCopy?.text,
        copyCkb: customParams?.copyCkb || ckbCopy?.text,
        badgeText: customParams?.badgeText,
        discountText: customParams?.discountText,
        ...customParams,
      });
    } else if (brandId === 'aster' || brandId === 'client-aster') {
      return buildAsterHealthcareTemplate({
        headlineEn: customParams?.headlineEn || enHeadline?.text,
        headlineCkb: customParams?.headlineCkb || ckbHeadline?.text,
        copyEn: customParams?.copyEn || enCopy?.text,
        copyCkb: customParams?.copyCkb || ckbCopy?.text,
        discountBadge: customParams?.discountBadge,
        offerPill: customParams?.offerPill,
        ...customParams,
      });
    } else if (brandId === 'drustee' || brandId === 'client-drustee') {
      return buildDrusteeClinicalTemplate({
        headlineEn: customParams?.headlineEn || enHeadline?.text,
        headlineCkb: customParams?.headlineCkb || ckbHeadline?.text,
        copyEn: customParams?.copyEn || enCopy?.text,
        copyCkb: customParams?.copyCkb || ckbCopy?.text,
        potencyBadge: customParams?.potencyBadge,
        lotText: customParams?.lotText,
        ...customParams,
      });
    } else {
      // Any other brand used to fall through to KAAE's v1 templates, drawing another client's design
      // in KAAE's identity. Those templates are retired (ADR-038); other clients are designed in the studio.
      throw new Error(`No legacy template for brand "${brandId}"; its designs are made in the design studio.`);
    }
  }
}
