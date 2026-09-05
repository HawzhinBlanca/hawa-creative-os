/**
 * Hawa Creative OS — Studio Canvas Reflow Engine
 * Mathematically adapts canvas layer coordinates, font sizes, line heights,
 * and danger zone clearances across 4-in-1 omnichannel aspect ratios.
 */

import type { AspectPreset } from './canvasExport.js';

export interface FormatConstraintSpec {
  format: AspectPreset;
  name: string;
  width: number;
  height: number;
  safeMarginSides: number;
  socialTopDangerPx: number;
  socialBottomDangerPx: number;
}

export const FORMAT_CONSTRAINTS: Record<AspectPreset, FormatConstraintSpec> = {
  feed: {
    format: 'feed',
    name: 'Feed (4:5)',
    width: 480,
    height: 600,
    safeMarginSides: 28,
    socialTopDangerPx: 24,
    socialBottomDangerPx: 72, // 12% bottom danger
  },
  story: {
    format: 'story',
    name: 'Story (9:16)',
    width: 380,
    height: 675,
    safeMarginSides: 24,
    socialTopDangerPx: 95, // 14% top danger
    socialBottomDangerPx: 135, // 20% bottom danger
  },
  square: {
    format: 'square',
    name: 'Square (1:1)',
    width: 480,
    height: 480,
    safeMarginSides: 28,
    socialTopDangerPx: 24,
    socialBottomDangerPx: 58, // 12% bottom danger
  },
  landscape: {
    format: 'landscape',
    name: 'Landscape (16:9)',
    width: 640,
    height: 360,
    safeMarginSides: 36,
    socialTopDangerPx: 20,
    socialBottomDangerPx: 32,
  },
};

/**
 * Recalculates coordinates and bounds for a list of CanvasNodes to fit target format perfectly.
 */
export function reflowStudioNodes<T extends Record<string, any>>(
  nodes: T[],
  srcFormat: AspectPreset,
  dstFormat: AspectPreset
): T[] {
  if (srcFormat === dstFormat) return nodes.map((n) => ({ ...n }));

  const src = FORMAT_CONSTRAINTS[srcFormat] || FORMAT_CONSTRAINTS.feed;
  const dst = FORMAT_CONSTRAINTS[dstFormat] || FORMAT_CONSTRAINTS.story;

  const scaleX = dst.width / src.width;
  const scaleY = dst.height / src.height;
  const scaleAvg = Math.min(scaleX, scaleY);
  const availableH = dst.height - dst.socialTopDangerPx - dst.socialBottomDangerPx;

  return nodes.map((node) => {
    const clone: any = { ...node };
    const role = (clone.role || '').toLowerCase();

    switch (role) {
      case 'headline': {
        const newFontSize = dstFormat === 'story' ? 23 : dstFormat === 'landscape' ? 20 : dstFormat === 'square' ? 24 : 26;
        const newWidth = dst.width - dst.safeMarginSides * 2;
        const newHeight = dstFormat === 'landscape' ? 56 : 76;
        clone.x = dst.safeMarginSides;
        clone.y = dst.socialTopDangerPx + 16;
        clone.width = newWidth;
        clone.height = newHeight;
        clone.fontSize = newFontSize;
        clone.lineHeight = 1.52;
        break;
      }

      case 'copy':
      case 'badge_custom': {
        const newW = dstFormat === 'landscape' ? Math.min(320, Math.round(dst.width * 0.46)) : Math.round(dst.width * 0.78);
        const newH = dstFormat === 'landscape' ? 44 : 52;
        clone.x = dst.safeMarginSides;
        clone.y = dst.height - dst.socialBottomDangerPx - newH - 12;
        clone.width = newW;
        clone.height = newH;
        clone.fontSize = dstFormat === 'story' ? 12 : dstFormat === 'landscape' ? 12 : 13;
        break;
      }

      case 'logo': {
        clone.x = dst.width - 130;
        clone.y = dst.socialTopDangerPx + 8;
        clone.width = 110;
        clone.height = 36;
        break;
      }

      case 'image_custom': {
        if (clone.svgContent || clone.width >= src.width * 0.8) {
          clone.x = 0;
          clone.y = 0;
          clone.width = dst.width;
          clone.height = dst.height;
        } else {
          const heroW = Math.round(Math.min(clone.width * scaleAvg, dst.width - dst.safeMarginSides * 2));
          const heroH = Math.round(clone.height * scaleAvg);
          clone.width = heroW;
          clone.height = heroH;
          clone.x = Math.round((dst.width - heroW) / 2);
          clone.y = Math.round(dst.socialTopDangerPx + (availableH - heroH) / 2);
        }
        break;
      }

      case 'shape':
      case 'shape_custom': {
        const newW = Math.round(clone.width * scaleX);
        const newH = Math.round(clone.height * scaleY);
        clone.width = Math.max(20, Math.min(newW, dst.width));
        clone.height = Math.max(20, Math.min(newH, dst.height));
        clone.x = Math.max(0, Math.min(Math.round(clone.x * scaleX), dst.width - clone.width));
        clone.y = Math.max(0, Math.min(Math.round(clone.y * scaleY), dst.height - clone.height));
        break;
      }

      default: {
        clone.x = Math.round(clone.x * scaleX);
        clone.y = Math.round(clone.y * scaleY);
        clone.width = Math.round(clone.width * scaleX);
        clone.height = Math.round(clone.height * scaleY);
        break;
      }
    }

    return clone;
  });
}
