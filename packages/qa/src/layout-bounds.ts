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
  const safeWidth = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 1080;
  const safeHeight = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 1080;
  const aspectRatio = safeWidth / safeHeight;

  // 9:16 Vertical Story / Reel format (e.g. 1080x1920)
  if (Math.abs(aspectRatio - 9 / 16) < 0.05 || (safeWidth === 1080 && safeHeight === 1920)) {
    return {
      topMarginPx: Math.round(safeHeight * 0.13), // ~250px top header safe zone
      bottomMarginPx: Math.round(safeHeight * 0.177), // ~340px bottom CTA/reply bar
      leftMarginPx: Math.round(safeWidth * 0.06), // ~65px left
      rightMarginPx: Math.round(safeWidth * 0.06), // ~65px right
    };
  }

  // 4:5 Feed Portrait (1080x1350) or 1:1 Square (1080x1080)
  return {
    topMarginPx: Math.round(safeHeight * 0.05), // 5% border margin
    bottomMarginPx: Math.round(safeHeight * 0.05),
    leftMarginPx: Math.round(safeWidth * 0.05),
    rightMarginPx: Math.round(safeWidth * 0.05),
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
  const safeWidth = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 1080;
  const safeHeight = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 1080;
  const spec = getSafeZoneSpec(safeWidth, safeHeight);
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
    const maxAllowedBottom = safeHeight - spec.bottomMarginPx;
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
    const maxAllowedRight = safeWidth - spec.rightMarginPx;
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
  const safeWidth = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 1080;
  const safeHeight = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 1080;
  const collisions: SocialOverlayCollision[] = [];
  const aspectRatio = safeWidth / safeHeight;
  const isStory = Math.abs(aspectRatio - 9 / 16) < 0.05 || (safeWidth === 1080 && safeHeight === 1920);
  const isFeed = Math.abs(aspectRatio - 4 / 5) < 0.05 || Math.abs(aspectRatio - 1) < 0.05 || (safeWidth === 1080 && safeHeight === 1350);

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
      const headerDanger = Math.round(safeHeight * 0.14);
      const footerDanger = Math.round(safeHeight * 0.80);
      const sideMargin = Math.round(safeWidth * 0.05);
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
          zoneLabel: `Instagram Story Message/Action Bar (bottom ${safeHeight - footerDanger}px)`,
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

      if (nodeRight > safeWidth - sideMargin) {
        collisions.push({
          platform: 'instagram_story',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Story Right Edge Gutter (${sideMargin}px)`,
          overlapPx: nodeRight - (safeWidth - sideMargin),
        });
      }

      // Reels/Story Right-Side Interaction Rail (Like, Comment, Share)
      const railTop = Math.round(safeHeight * 0.45);
      const railBottom = Math.round(safeHeight * 0.82);
      const railLeft = safeWidth - Math.round(safeWidth * 0.09); // rightmost 9%
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
      const footerDanger = Math.round(safeHeight * 0.88);
      const sideMargin = Math.round(safeWidth * 0.04);
      const nodeBottom = node.y + node.height;
      const nodeRight = node.x + node.width;

      if (nodeBottom > footerDanger) {
        collisions.push({
          platform: 'meta_feed',
          nodeId: node.id,
          role: node.role,
          zone: 'footer_ui',
          zoneLabel: `Meta Feed Bottom Action Tray (bottom ${safeHeight - footerDanger}px)`,
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

      if (nodeRight > safeWidth - sideMargin) {
        collisions.push({
          platform: 'meta_feed',
          nodeId: node.id,
          role: node.role,
          zone: 'side_gutter',
          zoneLabel: `Meta Feed Right Margin Gutter (${sideMargin}px)`,
          overlapPx: nodeRight - (safeWidth - sideMargin),
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
  const safeFontSize = Number.isFinite(node.fontSize) && node.fontSize > 0 ? node.fontSize : 16;
  const safeWidth = Number.isFinite(node.width) && node.width > 0 ? node.width : 1;
  const safeHeight = Number.isFinite(node.height) && node.height > 0 ? node.height : 0;
  const safeText = typeof node.text === 'string' ? node.text : '';

  // Approximate average character width for Kurdish Sorani / Arabic at font size S is ~0.55 * S
  const avgCharWidth = safeFontSize * 0.55;
  const charsPerLine = Math.max(1, Math.floor(safeWidth / avgCharWidth));
  const estimatedLines = Math.max(1, Math.ceil(safeText.length / charsPerLine));
  const estimatedHeight = estimatedLines * (safeFontSize * 1.3); // 1.3 line-height

  return {
    overflows: safeHeight > 0 ? estimatedHeight > safeHeight * 1.05 : safeText.length > 0, // 5% tolerance
    estimatedHeight: Math.round(estimatedHeight),
    containerHeight: safeHeight,
  };
}

export interface NodeCollisionViolation {
  nodeIdA: string;
  roleA?: string;
  nodeIdB: string;
  roleB?: string;
  intersectionAreaPx: number;
  intersectionBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Checks for Axis-Aligned Bounding Box (AABB) collisions between critical foreground elements.
 * Critical foreground nodes include text blocks, headings, buttons, and badges.
 * Excludes intentional background rectangles, scrims, and decorative borders.
 */
export function checkNodeCollisions(nodes: NodeRect[]): NodeCollisionViolation[] {
  const violations: NodeCollisionViolation[] = [];

  // Filter for critical foreground nodes that have non-zero dimensions
  const critical = nodes.filter((n) => {
    if (!n.width || !n.height || n.width <= 0 || n.height <= 0) return false;
    const role = (n.role || '').toLowerCase();
    if (role.includes('background') || role.includes('scrim') || role.includes('border') || role.includes('frame')) {
      return false;
    }
    // Critical nodes have text or specific roles
    return Boolean(
      n.text ||
      role.includes('headline') ||
      role.includes('body') ||
      role.includes('button') ||
      role.includes('badge') ||
      role.includes('cta') ||
      role.includes('logo')
    );
  });

  for (let i = 0; i < critical.length; i++) {
    for (let j = i + 1; j < critical.length; j++) {
      const a = critical[i];
      const b = critical[j];

      // If one is a parent container/box containing the other (e.g. card box vs card text label), skip
      const aContainsB = a.x <= b.x && a.y <= b.y && (a.x + a.width >= b.x + b.width) && (a.y + a.height >= b.y + b.height);
      const bContainsA = b.x <= a.x && b.y <= a.y && (b.x + b.width >= a.x + a.width) && (b.y + b.height >= a.y + a.height);
      if (aContainsB || bContainsA) {
        continue;
      }

      // Compute AABB intersection
      const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

      // Disregard hairline touches (<= 2px tolerance for sub-pixel borders)
      if (xOverlap > 2 && yOverlap > 2) {
        violations.push({
          nodeIdA: a.id,
          roleA: a.role,
          nodeIdB: b.id,
          roleB: b.role,
          intersectionAreaPx: Math.round(xOverlap * yOverlap),
          intersectionBox: {
            x: Math.max(a.x, b.x),
            y: Math.max(a.y, b.y),
            width: Math.round(xOverlap),
            height: Math.round(yOverlap),
          },
        });
      }
    }
  }

  return violations;
}

