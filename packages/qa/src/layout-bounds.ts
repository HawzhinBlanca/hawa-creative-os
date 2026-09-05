/**
 * Layout Bounds, Safe Zone & Text Overflow Validation Engine.
 */

export interface SafeZoneSpec {
  topMarginPx: number;
  bottomMarginPx: number;
  leftMarginPx: number;
  rightMarginPx: number;
}

export function getSafeZoneSpec(pageWidth: number, pageHeight: number): SafeZoneSpec {
  const aspectRatio = pageWidth / pageHeight;

  // 9:16 Vertical Story / Reel format (e.g. 1080x1920)
  if (Math.abs(aspectRatio - 9 / 16) < 0.05 || (pageWidth === 1080 && pageHeight === 1920)) {
    return {
      topMarginPx: Math.round(pageHeight * 0.13), // ~250px top header safe zone
      bottomMarginPx: Math.round(pageHeight * 0.177), // ~340px bottom CTA/reply bar
      leftMarginPx: Math.round(pageWidth * 0.06), // ~65px left
      rightMarginPx: Math.round(pageWidth * 0.06), // ~65px right
    };
  }

  // 4:5 Feed Portrait (1080x1350) or 1:1 Square (1080x1080)
  return {
    topMarginPx: Math.round(pageHeight * 0.05), // 5% border margin
    bottomMarginPx: Math.round(pageHeight * 0.05),
    leftMarginPx: Math.round(pageWidth * 0.05),
    rightMarginPx: Math.round(pageWidth * 0.05),
  };
}

export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  role?: string;
  text?: string;
  fontSize?: number;
}

export interface SafeZoneViolation {
  nodeId: string;
  role?: string;
  breachEdge: 'top' | 'bottom' | 'left' | 'right';
  currentPos: number;
  safeLimit: number;
  overflowPx: number;
}

/**
 * Checks whether critical nodes (text, logo, cta) infringe upon platform danger/safe-zone boundaries.
 */
export function checkSafeZoneViolations(
  nodes: NodeRect[],
  pageWidth: number,
  pageHeight: number
): SafeZoneViolation[] {
  const spec = getSafeZoneSpec(pageWidth, pageHeight);
  const violations: SafeZoneViolation[] = [];

  for (const node of nodes) {
    // Only check critical semantic nodes: text, logos, buttons
    const isCritical = node.text || node.role?.includes('logo') || node.role?.includes('cta') || node.role?.includes('headline');
    if (!isCritical) continue;

    // Top breach
    if (node.y < spec.topMarginPx) {
      violations.push({
        nodeId: node.id,
        role: node.role,
        breachEdge: 'top',
        currentPos: node.y,
        safeLimit: spec.topMarginPx,
        overflowPx: spec.topMarginPx - node.y,
      });
    }

    // Bottom breach
    const nodeBottom = node.y + node.height;
    const maxAllowedBottom = pageHeight - spec.bottomMarginPx;
    if (nodeBottom > maxAllowedBottom) {
      violations.push({
        nodeId: node.id,
        role: node.role,
        breachEdge: 'bottom',
        currentPos: nodeBottom,
        safeLimit: maxAllowedBottom,
        overflowPx: nodeBottom - maxAllowedBottom,
      });
    }

    // Left breach
    if (node.x < spec.leftMarginPx) {
      violations.push({
        nodeId: node.id,
        role: node.role,
        breachEdge: 'left',
        currentPos: node.x,
        safeLimit: spec.leftMarginPx,
        overflowPx: spec.leftMarginPx - node.x,
      });
    }

    // Right breach
    const nodeRight = node.x + node.width;
    const maxAllowedRight = pageWidth - spec.rightMarginPx;
    if (nodeRight > maxAllowedRight) {
      violations.push({
        nodeId: node.id,
        role: node.role,
        breachEdge: 'right',
        currentPos: nodeRight,
        safeLimit: maxAllowedRight,
        overflowPx: nodeRight - maxAllowedRight,
      });
    }
  }

  return violations;
}

export interface SocialOverlayCollision {
  platform: 'instagram_story' | 'meta_feed';
  nodeId: string;
  role?: string;
  zone: 'header_ui' | 'footer_ui' | 'side_gutter' | 'right_rail';
  zoneLabel: string;
  overlapPx: number;
}

/**
 * Validates social platform native UI collisions:
 * - Instagram Story 9:16: top 14% header (profile, time, close button), bottom 20% (message/reaction/link pill)
 * - Meta Feed 4:5: bottom 12% (action tray: like, comment, share, save)
 */
export function checkSocialOverlayCollisions(
  nodes: NodeRect[],
  pageWidth: number,
  pageHeight: number
): SocialOverlayCollision[] {
  const collisions: SocialOverlayCollision[] = [];
  const aspectRatio = pageWidth / pageHeight;
  const isStory = Math.abs(aspectRatio - 9 / 16) < 0.05 || (pageWidth === 1080 && pageHeight === 1920);
  const isFeed = Math.abs(aspectRatio - 4 / 5) < 0.05 || Math.abs(aspectRatio - 1) < 0.05 || (pageWidth === 1080 && pageHeight === 1350);

  for (const node of nodes) {
    const isCritical = Boolean(
      node.text ||
      node.role?.includes('logo') ||
      node.role?.includes('cta') ||
      node.role?.includes('headline') ||
      node.role?.includes('copy') ||
      node.role?.includes('badge')
    );
    if (!isCritical) continue;

    if (isStory) {
      const headerDanger = Math.round(pageHeight * 0.14);
      const footerDanger = Math.round(pageHeight * 0.80);
      const sideMargin = Math.round(pageWidth * 0.05);
      const nodeBottom = node.y + node.height;
      const nodeRight = node.x + node.width;

      if (node.y < headerDanger) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'header_ui',
          zoneLabel: `Instagram Story Header UI (top ${headerDanger}px)`,
          overlapPx: headerDanger - node.y,
        });
      }

      if (nodeBottom > footerDanger) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'footer_ui',
          zoneLabel: `Instagram Story Message/Action Bar (bottom ${pageHeight - footerDanger}px)`,
          overlapPx: nodeBottom - footerDanger,
        });
      }

      if (node.x < sideMargin) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Story Left Edge Gutter (${sideMargin}px)`,
          overlapPx: sideMargin - node.x,
        });
      }

      if (nodeRight > pageWidth - sideMargin) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Story Right Edge Gutter (${sideMargin}px)`,
          overlapPx: nodeRight - (pageWidth - sideMargin),
        });
      }

      // Reels/Story Right-Side Interaction Rail (Like, Comment, Share)
      const railTop = Math.round(pageHeight * 0.45);
      const railBottom = Math.round(pageHeight * 0.82);
      const railLeft = pageWidth - Math.round(pageWidth * 0.09); // rightmost 9%
      if (nodeRight > railLeft && node.y < railBottom && nodeBottom > railTop) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'right_rail',
          zoneLabel: `Story/Reels Right Interaction Rail Danger Zone`,
          overlapPx: nodeRight - railLeft,
        });
      }
    } else if (isFeed) {
      const footerDanger = Math.round(pageHeight * 0.88);
      const sideMargin = Math.round(pageWidth * 0.04);
      const nodeBottom = node.y + node.height;
      const nodeRight = node.x + node.width;

      if (nodeBottom > footerDanger) {
        collisions.push({
          platform: 'meta_feed',
          nodeId: node.id,
          role: node.role,
          zone: 'footer_ui',
          zoneLabel: `Meta Feed Bottom Action Tray (bottom ${pageHeight - footerDanger}px)`,
          overlapPx: nodeBottom - footerDanger,
        });
      }

      if (node.x < sideMargin) {
        collisions.push({
          platform: 'meta_feed',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Meta Feed Left Margin Gutter (${sideMargin}px)`,
          overlapPx: sideMargin - node.x,
        });
      }

      if (nodeRight > pageWidth - sideMargin) {
        collisions.push({
          platform: 'meta_feed',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Meta Feed Right Margin Gutter (${sideMargin}px)`,
          overlapPx: nodeRight - (pageWidth - sideMargin),
        });
      }
    }
  }

  return collisions;
}

/**
 * Checks whether text node exceeds its container bounding box.
 */
export function checkTextContainerOverflow(node: {
  id: string;
  text: string;
  fontSize: number;
  width: number;
  height: number;
}): {
  overflows: boolean;
  estimatedHeight: number;
  containerHeight: number;
} {
  // Approximate average character width for Kurdish Sorani / Arabic at font size S is ~0.55 * S
  const avgCharWidth = node.fontSize * 0.55;
  const charsPerLine = Math.max(1, Math.floor(node.width / avgCharWidth));
  const estimatedLines = Math.ceil(node.text.length / charsPerLine);
  const estimatedHeight = estimatedLines * (node.fontSize * 1.3); // 1.3 line-height

  return {
    overflows: estimatedHeight > node.height * 1.05, // 5% tolerance
    estimatedHeight: Math.round(estimatedHeight),
    containerHeight: node.height,
  };
}
