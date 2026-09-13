/**
 * Hawa Creative OS — Constraint-Based Multi-Artboard Auto-Reflow Engine
 * Mathematically recalculates layer bounding boxes, font sizes, line heights,
 * and anchor positions across 4-in-1 omnichannel aspect ratios:
 * - Story 9:16 (1080x1920 / preview 380x675)
 * - Feed Portrait 4:5 (1080x1350 / preview 480x600)
 * - Square 1:1 (1080x1080 / preview 480x480)
 * - Landscape 16:9 (1920x1080 / preview 640x360)
 *
 * Implements layout and resize constraint solver:
 * - Top-Safe Header & Logo Anchors
 * - Social UI Danger Zone Clearance (Story Top 14% & Bottom 20%, Feed Bottom 12%)
 * - Center-Safe Hero Visuals & Dynamic Badges
 * - Diacritic-Safe Kurdish Sorani Line Height Headroom
 */

export type AspectFormat = 'square' | 'feed' | 'story' | 'landscape';

export interface FormatBounds {
  format: AspectFormat;
  name: string;
  width: number;
  height: number;
  safeMarginTop: number;
  safeMarginBottom: number;
  safeMarginSides: number;
  socialTopDangerRatio: number;
  socialBottomDangerRatio: number;
}

export const FORMAT_SPECS: Record<AspectFormat, FormatBounds> = {
  feed: {
    format: 'feed',
    name: 'Feed Portrait (4:5)',
    width: 480,
    height: 600,
    safeMarginTop: 36,
    safeMarginBottom: 72, // 12% bottom danger
    safeMarginSides: 28,
    socialTopDangerRatio: 0.04,
    socialBottomDangerRatio: 0.12,
  },
  story: {
    format: 'story',
    name: 'Story (9:16)',
    width: 380,
    height: 675,
    safeMarginTop: 95, // 14% top danger
    safeMarginBottom: 135, // 20% bottom danger
    safeMarginSides: 24,
    socialTopDangerRatio: 0.14,
    socialBottomDangerRatio: 0.20,
  },
  square: {
    format: 'square',
    name: 'Square (1:1)',
    width: 480,
    height: 480,
    safeMarginTop: 32,
    safeMarginBottom: 58, // 12% bottom danger
    safeMarginSides: 28,
    socialTopDangerRatio: 0.04,
    socialBottomDangerRatio: 0.12,
  },
  landscape: {
    format: 'landscape',
    name: 'Landscape (16:9)',
    width: 640,
    height: 360,
    safeMarginTop: 24,
    safeMarginBottom: 28,
    safeMarginSides: 36,
    socialTopDangerRatio: 0.04,
    socialBottomDangerRatio: 0.08,
  },
};

export interface ReflowableNode {
  id: string;
  name: string;
  role: 'headline' | 'copy' | 'shape' | 'logo' | 'text_custom' | 'shape_custom' | 'badge_custom' | 'image_custom' | string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  fontSize?: number;
  lineHeight?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  backgroundColor?: string;
  color?: string;
  borderRadius?: number;
  svgContent?: string;
  textEn?: string;
  textCkb?: string;
  [key: string]: any;
}

export interface ReflowOptions {
  preserveManualX?: boolean;
  preserveCenterAlign?: boolean;
  kurdishDiacriticSafe?: boolean;
}

/**
 * Mathematically adapts a set of canvas nodes from a source format to a target format
 * preserving typography hierarchy, brand anchors, and social native UI clearance.
 */
export function reflowCanvasNodes<T extends ReflowableNode>(
  nodes: T[],
  sourceFormat: AspectFormat,
  targetFormat: AspectFormat,
  options: ReflowOptions = {}
): T[] {
  if (sourceFormat === targetFormat) {
    return nodes.map((n) => ({ ...n }));
  }

  const srcSpec = FORMAT_SPECS[sourceFormat] || FORMAT_SPECS.feed;
  const dstSpec = FORMAT_SPECS[targetFormat] || FORMAT_SPECS.story;

  const scaleX = dstSpec.width / srcSpec.width;
  const scaleY = dstSpec.height / srcSpec.height;
  const scaleAvg = Math.min(scaleX, scaleY);

  const topDangerPx = Math.round(dstSpec.height * dstSpec.socialTopDangerRatio);
  const bottomDangerPx = Math.round(dstSpec.height * dstSpec.socialBottomDangerRatio);
  const availableContentHeight = dstSpec.height - topDangerPx - bottomDangerPx;

  return nodes.map((node) => {
    const clone: T = { ...node };

    if (!clone.visible && clone.visible !== undefined) {
      return clone;
    }

    const role = (clone.role || '').toLowerCase();

    switch (role) {
      case 'headline': {
        // Headlines anchor to the top safe zone below social UI headers
        const newFontSize = targetFormat === 'story'
          ? Math.round(23)
          : targetFormat === 'landscape'
          ? Math.round(20)
          : targetFormat === 'square'
          ? Math.round(24)
          : Math.round(26);

        const newWidth = dstSpec.width - dstSpec.safeMarginSides * 2;
        const newHeight = targetFormat === 'landscape' ? 60 : 76;
        const newX = dstSpec.safeMarginSides;
        const newY = topDangerPx + 16;

        clone.x = newX;
        clone.y = newY;
        clone.width = newWidth;
        clone.height = newHeight;
        clone.fontSize = newFontSize;
        clone.lineHeight = options.kurdishDiacriticSafe !== false ? 1.52 : 1.25;
        break;
      }

      case 'copy':
      case 'badge_custom': {
        // Copy badges anchor above the bottom social danger zone
        const newWidth = targetFormat === 'landscape'
          ? Math.min(320, Math.round(dstSpec.width * 0.46))
          : Math.round(dstSpec.width * 0.78);
        const newHeight = targetFormat === 'landscape' ? 44 : 52;
        const newX = dstSpec.safeMarginSides;
        const newY = dstSpec.height - bottomDangerPx - newHeight - 12;

        clone.x = newX;
        clone.y = newY;
        clone.width = newWidth;
        clone.height = newHeight;
        clone.fontSize = targetFormat === 'story' ? 13 : targetFormat === 'landscape' ? 12 : 14;
        break;
      }

      case 'logo': {
        // Logo stays pinned to the top header safe bounds
        clone.x = dstSpec.width - 130;
        clone.y = topDangerPx + 8;
        clone.width = 110;
        clone.height = 36;
        break;
      }

      case 'image_custom': {
        // Hero visual / custom SVG backdrops scale to available vertical space
        if (clone.svgContent || clone.width >= srcSpec.width * 0.8) {
          // Full canvas or major background backdrop expands to target aspect ratio
          clone.x = 0;
          clone.y = 0;
          clone.width = dstSpec.width;
          clone.height = dstSpec.height;
        } else {
          // Centered floating visual
          const heroW = Math.round(Math.min(clone.width * scaleAvg, dstSpec.width - dstSpec.safeMarginSides * 2));
          const heroH = Math.round(clone.height * scaleAvg);
          clone.width = heroW;
          clone.height = heroH;
          clone.x = Math.round((dstSpec.width - heroW) / 2);
          clone.y = Math.round(topDangerPx + (availableContentHeight - heroH) / 2);
        }
        break;
      }

      case 'shape':
      case 'shape_custom': {
        // Organic background shapes scale proportionally and stay within canvas
        const newW = Math.round(clone.width * scaleX);
        const newH = Math.round(clone.height * scaleY);
        clone.width = Math.max(20, Math.min(newW, dstSpec.width));
        clone.height = Math.max(20, Math.min(newH, dstSpec.height));
        clone.x = Math.round(clone.x * scaleX);
        clone.y = Math.round(clone.y * scaleY);

        // Clamp inside bounds
        if (clone.x + clone.width > dstSpec.width) {
          clone.x = Math.max(0, dstSpec.width - clone.width);
        }
        if (clone.y + clone.height > dstSpec.height) {
          clone.y = Math.max(0, dstSpec.height - clone.height);
        }
        break;
      }

      case 'text_custom': {
        // Secondary custom text blocks scale and maintain horizontal center or alignment
        const newW = Math.min(Math.round(clone.width * scaleX), dstSpec.width - dstSpec.safeMarginSides * 2);
        const newH = Math.round(clone.height * scaleY);
        clone.width = newW;
        clone.height = Math.max(30, newH);
        clone.x = Math.round(clone.x * scaleX);
        clone.y = Math.round(clone.y * scaleY);

        // Enforce danger zone clearance
        if (clone.y < topDangerPx) clone.y = topDangerPx + 4;
        if (clone.y + clone.height > dstSpec.height - bottomDangerPx) {
          clone.y = dstSpec.height - bottomDangerPx - clone.height - 4;
        }
        if (clone.fontSize) {
          clone.fontSize = Math.round(clone.fontSize * scaleAvg);
        }
        break;
      }

      default: {
        // Generic elements scale by axis proportions
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
