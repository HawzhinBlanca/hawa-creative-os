import type { NeutralManifest, StudioOperation } from '@hawa/contracts';

export type StandardVariantPreset = 'square' | 'feed_portrait' | 'story' | 'landscape';

export interface VariantDimension {
  name: string;
  width: number;
  height: number;
  safeMarginTop: number;
  safeMarginBottom: number;
  safeMarginSides: number;
}

export const VARIANT_PRESETS: Record<StandardVariantPreset, VariantDimension> = {
  square: {
    name: 'Instagram Square (1:1)',
    width: 1080,
    height: 1080,
    safeMarginTop: 54, // 5%
    safeMarginBottom: 54,
    safeMarginSides: 54,
  },
  feed_portrait: {
    name: 'Instagram Feed Portrait (4:5)',
    width: 1080,
    height: 1350,
    safeMarginTop: 68,
    safeMarginBottom: 68,
    safeMarginSides: 54,
  },
  story: {
    name: 'Instagram / TikTok Story (9:16)',
    width: 1080,
    height: 1920,
    safeMarginTop: 250, // System UI top (camera, profile header)
    safeMarginBottom: 340, // System UI bottom (reply bar, reactions)
    safeMarginSides: 54,
  },
  landscape: {
    name: 'Meta Ads Landscape (1.91:1)',
    width: 1200,
    height: 628,
    safeMarginTop: 32,
    safeMarginBottom: 32,
    safeMarginSides: 60,
  },
};

export interface ReflowResult {
  targetPreset: string;
  dimensions: { width: number; height: number };
  reflowedManifest: NeutralManifest;
  operations: StudioOperation[];
}

/**
 * Intelligent Variant Reflow Engine.
 * Mathematically adapts a source manifest to target dimensions and aspect ratios
 * while preserving safe margins, anchor positions, and visual hierarchy.
 */
export function reflowManifest(
  sourceManifest: NeutralManifest,
  target: StandardVariantPreset | { width: number; height: number; name?: string }
): ReflowResult {
  const targetDim: VariantDimension = typeof target === 'string'
    ? VARIANT_PRESETS[target]
    : {
        name: target.name || 'Custom Variant',
        width: target.width,
        height: target.height,
        safeMarginTop: target.height > 1500 ? 250 : Math.round(target.height * 0.05),
        safeMarginBottom: target.height > 1500 ? 340 : Math.round(target.height * 0.05),
        safeMarginSides: Math.round(target.width * 0.05),
      };

  const sourcePage = sourceManifest.pages[0] || { width: 1080, height: 1080 };
  const sourceW = sourcePage.width;
  const sourceH = sourcePage.height;

  const targetW = targetDim.width;
  const targetH = targetDim.height;

  const scaleX = targetW / sourceW;
  const scaleY = targetH / sourceH;

  const operations: StudioOperation[] = [];

  // 1. Resize primary page
  operations.push({
    op: 'resizePage',
    pageId: sourcePage.id || 'page_primary',
    width: targetW,
    height: targetH,
    reflow: 'constraints',
  });

  const reflowedNodes = sourceManifest.nodes.map((node) => {
    const box = node.box || { x: 60, y: 60, width: 200, height: 100 };
    let newX = box.x;
    let newY = box.y;
    let newW = box.width;
    let newH = box.height;

    const role = (node.role || '').toLowerCase();
    const type = (node.type || '').toLowerCase();

    if (role === 'background' || type === 'background' || (box.width >= sourceW && box.height >= sourceH)) {
      // Background expands to fill full canvas
      newX = 0;
      newY = 0;
      newW = targetW;
      newH = targetH;
    } else if (role === 'official_logo' || role.includes('logo')) {
      // Logos stay anchored near top-right/top-left safe zone
      newX = Math.round(box.x * scaleX);
      newY = targetDim.safeMarginTop + 10;
      newW = box.width; // Maintain crisp logo size
      newH = box.height;
    } else if (role === 'headline' || role === 'subheadline' || role === 'cta' || role === 'disclaimer') {
      // Text copy stays within safe zone bounds
      newX = Math.round(box.x * scaleX);
      newW = Math.min(Math.round(box.width * scaleX), targetW - targetDim.safeMarginSides * 2);

      // Relative positioning from bottom or top
      const distFromBottom = sourceH - (box.y + box.height);
      if (distFromBottom < sourceH * 0.4) {
        // Bottom-anchored text
        newY = targetH - targetDim.safeMarginBottom - newH - (distFromBottom > 50 ? 60 : 0);
      } else {
        newY = Math.round(box.y * scaleY);
      }

      // Enforce safe boundary
      if (newY + newH > targetH - targetDim.safeMarginBottom) {
        newY = targetH - targetDim.safeMarginBottom - newH;
      }
      if (newY < targetDim.safeMarginTop) {
        newY = targetDim.safeMarginTop;
      }
    } else if (role.includes('hero') || role.includes('cutout') || role.includes('subject')) {
      // Hero image expands proportionally in the visual center
      const heroScale = Math.min(scaleX, scaleY);
      newW = Math.round(box.width * heroScale);
      newH = Math.round(box.height * heroScale);
      newX = Math.round((targetW - newW) / 2);
      newY = Math.round(targetDim.safeMarginTop + (targetH - targetDim.safeMarginTop - targetDim.safeMarginBottom - newH) / 2);
    } else {
      // General elements scale proportionally
      newX = Math.round(box.x * scaleX);
      newY = Math.round(box.y * scaleY);
      newW = Math.round(box.width * scaleX);
      newH = Math.round(box.height * scaleY);
    }

    operations.push({
      op: 'transform',
      nodeId: node.id,
      x: newX,
      y: newY,
      width: newW,
      height: newH,
    });

    return {
      ...node,
      box: {
        x: newX,
        y: newY,
        width: newW,
        height: newH,
      },
    };
  });

  const reflowedManifest: NeutralManifest = {
    ...sourceManifest,
    pages: sourceManifest.pages.map((p, idx) =>
      idx === 0 ? { ...p, width: targetW, height: targetH } : p
    ),
    nodes: reflowedNodes,
  };

  return {
    targetPreset: targetDim.name,
    dimensions: { width: targetW, height: targetH },
    reflowedManifest,
    operations,
  };
}
