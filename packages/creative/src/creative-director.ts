import type { StudioOperation } from '@hawa/contracts';
import type { DesignBrief, DesignPlan, AssetTopology, VisualIngredient, LayoutZone } from '@hawa/domain';

export class CreativeDirectorRunner {
  createDesignPlan(brief: DesignBrief, clientColors: string[]): DesignPlan {
    const primaryVariant = brief.variants[0] || { width: 1080, height: 1080 };
    const w = primaryVariant.width;
    const h = primaryVariant.height;

    const topology: AssetTopology = 'slot_matrix';

    const zones: LayoutZone[] = [
      {
        id: 'zone_header',
        name: 'header_logo_zone',
        x: 60,
        y: 60,
        width: w - 120,
        height: 100,
        allowedRoles: ['official_logo'],
        safeMarginPx: 40,
        zIndex: 10,
      },
      {
        id: 'zone_hero',
        name: 'hero_visual_zone',
        x: 60,
        y: 180,
        width: w - 120,
        height: h - 500,
        allowedRoles: ['subject_cutout', 'product_render', 'background'],
        safeMarginPx: 20,
        zIndex: 1,
      },
      {
        id: 'zone_content',
        name: 'typography_copy_zone',
        x: 60,
        y: h - 300,
        width: w - 120,
        height: 240,
        allowedRoles: ['headline', 'subheadline', 'cta', 'disclaimer'],
        safeMarginPx: 30,
        zIndex: 20,
      },
    ];

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
        targetWidth: 240,
        targetHeight: 80,
        transparentBackground: true,
      },
    ];

    return {
      planId: crypto.randomUUID(),
      briefId: brief.briefId,
      taskId: brief.taskId,
      topology,
      rationale: 'Structured modern layout prioritizing Sorani right-aligned headline with hero visual ingredient',
      zones,
      ingredients,
      artDirectionReference: {
        referenceId: crypto.randomUUID(),
        storageKey: `refs/${brief.taskId}/art_direction.png`,
        sha256: 'sha256_art_ref_internal_private',
        prompt: `Artistic visual direction for ${brief.objective}`,
        modelSnapshot: 'gemini-3.8-flash',
        shippedInArtifact: false, // Invariant 4: MUST BE FALSE
        analyzedFeatures: {
          palette: clientColors.length > 0 ? clientColors : ['#0F172A', '#38BDF8', '#FFFFFF'],
          depthLayers: 3,
          textRegions: [{ x: 60, y: h - 300, width: w - 120, height: 240 }],
          focalPoint: { x: w / 2, y: h / 2 - 50 },
        },
      },
      estimatedCostUsd: 0.002,
      createdAt: new Date().toISOString(),
    };
  }

  generateStudioOperations(brief: DesignBrief, plan: DesignPlan, primaryLogoSha256: string): StudioOperation[] {
    const ops: StudioOperation[] = [];
    const variant = brief.variants[0] || { width: 1080, height: 1080 };
    const pageId = 'page_primary';

    // 1. Add background vector/shape
    ops.push({
      op: 'addVector',
      nodeId: 'node_bg',
      pageId,
      source: '<rect width="100%" height="100%" fill="#0B0F19"/>',
      x: 0,
      y: 0,
      width: variant.width,
      height: variant.height,
      locked: true,
    });

    // 2. Add primary logo asset
    ops.push({
      op: 'addImage',
      nodeId: 'node_logo',
      pageId,
      asset: {
        storageKey: `assets/logos/${primaryLogoSha256}.png`,
        sha256: primaryLogoSha256,
        mimeType: 'image/png',
      },
      x: 60,
      y: 60,
      width: 240,
      height: 80,
      fit: 'contain',
      locked: true,
    });

    // 3. Add exact copy headline and subheadline with live text
    let currentY = variant.height - 280;
    for (let i = 0; i < brief.exactCopy.length; i++) {
      const block = brief.exactCopy[i];
      const isEnglish = block.language === 'en' || block.direction === 'ltr';
      ops.push({
        op: 'addText',
        nodeId: `node_text_${i}`,
        pageId,
        text: block.text,
        role: block.role,
        x: 60,
        y: currentY,
        width: variant.width - 120,
        height: 70,
        style: {
          fontSize: block.role === 'headline' ? 44 : 26,
          fontWeight: block.role === 'headline' ? 'bold' : 'normal',
          fontFamily: isEnglish ? 'Inter' : 'Vazirmatn',
          textAlign: isEnglish ? 'left' : 'right',
          color: '#FFFFFF',
          lineHeight: 1.3,
        },
        locked: false, // Invariant 3: Live text must be editable
      });
      currentY += 80;
    }


    return ops;
  }
}
