import type { StudioLayoutV2, Box } from './layout-v2.js';
import { declaredTextContrast } from './composite-contrast.js';
import { shapePaintsOver } from './art-direction/surfaces.js';

export interface LayoutMetrics {
  alignmentScore: number; // 0..1 (fraction of edges aligned to grid or other elements)
  whitespaceRatio: number; // 0..1 (non-ink fraction of canvas)
  balanceOffset: number; // % offset of ink centroid from center
  hierarchyRatio: number; // title fontSize / body fontSize
  bodyCharsPerLine: number; // average characters per line in body copy
  lines: Record<number, number>; // copyIndex -> line count
  contrastP05: Record<number, number>; // copyIndex -> p05 contrast
  marginMin: number; // minimum distance in px from any text/logo to canvas edge
  overlapCount: number; // count of overlapping element pairs
  logoWidthPct: number; // logo width as % of canvas width
}

export interface MetricCalculationOptions {
  copyText?: Record<number, string>; // copyIndex -> full text string
  measuredLines?: Record<number, number>; // copyIndex -> actual wrapped line count
  contrastValues?: Record<number, number>; // copyIndex -> measured contrast
}

function boxesIntersect(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/**
 * Every pair the overlap metric counts, by name: text on text, text on the logo, and text under a
 * shape other than a panel. QA reports them by name because refinement acts on the message, which
 * used to read "2 pair(s) of text boxes overlap" for a design whose only overlaps were two blocks
 * on the logo (cheap run 2, brief_03).
 */
export function overlappingPairs(layout: StudioLayoutV2): string[] {
  const name = (t: StudioLayoutV2['text'][number]) => `block ${t.copyIndex} (${t.role})`;
  const pairs: string[] = [];
  for (let i = 0; i < layout.text.length; i++) {
    for (let j = i + 1; j < layout.text.length; j++) {
      if (boxesIntersect(layout.text[i], layout.text[j])) pairs.push(`${name(layout.text[i])} and ${name(layout.text[j])}`);
    }
  }
  for (const t of layout.text) {
    if (boxesIntersect(t, layout.logo)) pairs.push(`${name(t)} and the logo`);
  }
  for (const s of layout.shapes) {
    if (s.role !== 'panel') {
      for (const t of layout.text) {
        if (shapePaintsOver(s, t)) pairs.push(`${name(t)} and the ${s.role} at y=${Math.round(s.y)}`);
      }
    }
  }
  return pairs;
}

export function computeLayoutMetrics(
  layout: StudioLayoutV2,
  options: MetricCalculationOptions = {}
): LayoutMetrics {
  const width = layout.width;
  const height = layout.height;
  const canvasArea = width * height;
  const threshold = 0.005 * width; // 0.5% of width

  // 1. Grid lines and alignment targets
  const gridLinesX: number[] = [
    layout.grid.margin,
    width - layout.grid.margin,
    Math.round(width / 2),
  ];
  const columns = layout.grid.columns;
  const usableWidth = width - 2 * layout.grid.margin;
  const gutter = layout.grid.gutter;
  const colWidth = (usableWidth - (columns - 1) * gutter) / columns;

  for (let c = 0; c < columns; c++) {
    const leftX = layout.grid.margin + c * (colWidth + gutter);
    const rightX = leftX + colWidth;
    gridLinesX.push(Math.round(leftX), Math.round(rightX));
  }

  // Collect all element edges
  const allElements: Box[] = [
    ...layout.text,
    // A frame around the canvas is a border, not an element to align (ADR-170: stroke-only frames).
    ...layout.shapes.filter((s) => (s.role !== 'panel' || (s.width < width * 0.9 && s.height < height * 0.9)) &&
      !(s.fill === 'none' && s.width >= width * 0.85 && s.height >= height * 0.85)),
    layout.logo,
  ];

  const edgesX: number[] = [];
  for (const el of allElements) {
    edgesX.push(el.x, el.x + el.width);
  }

  // An element centred on the canvas axis, or on another element's centre, is aligned: that is
  // how a centred composition aligns. Counting edges only, this gate rejected three of the owner's
  // six confirmed exemplars (0.542, 0.600, 0.667 against 0.70) and 13 of the 20 production-model
  // qualification designs, while the deliberately off-grid fixture still fails with centres
  // counted (0.600). Its 0.70 threshold was justified on the v3 alignment metric's exemplar scores
  // (0.792–1.000), which is a different measure; with centres counted, this one agrees with them.
  const centresX = allElements.map((el) => el.x + el.width / 2);
  const centred = centresX.map(
    (c, k) => Math.abs(c - width / 2) <= threshold || centresX.some((o, j) => j !== k && Math.abs(o - c) <= threshold)
  );

  // Check alignment of each edge
  let alignedEdges = 0;
  for (let i = 0; i < edgesX.length; i++) {
    const x = edgesX[i];
    let isAligned = centred[Math.floor(i / 2)];

    // Check against grid lines
    for (const gx of gridLinesX) {
      if (isAligned) break;
      if (Math.abs(x - gx) <= threshold) {
        isAligned = true;
        break;
      }
    }

    // Check against other elements' edges
    if (!isAligned) {
      for (let j = 0; j < edgesX.length; j++) {
        if (i !== j && Math.abs(x - edgesX[j]) <= threshold) {
          isAligned = true;
          break;
        }
      }
    }

    if (isAligned) alignedEdges++;
  }

  const alignmentScore = edgesX.length > 0 ? parseFloat((alignedEdges / edgesX.length).toFixed(3)) : 1.0;

  // 2. Whitespace ratio & Balance offset
  // Sum ink area (excluding full-bleed panels or art background)
  let totalInkArea = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const el of allElements) {
    const area = el.width * el.height;
    totalInkArea += area;
    const centerX = el.x + el.width / 2;
    const centerY = el.y + el.height / 2;
    weightedX += area * centerX;
    weightedY += area * centerY;
  }

  const whitespaceRatio = parseFloat(Math.max(0, Math.min(1, 1 - totalInkArea / canvasArea)).toFixed(3));

  let balanceOffset = 0;
  if (totalInkArea > 0) {
    const centroidX = weightedX / totalInkArea;
    const centroidY = weightedY / totalInkArea;
    const dx = (centroidX - width / 2) / width;
    const dy = (centroidY - height / 2) / height;
    balanceOffset = parseFloat((Math.sqrt(dx * dx + dy * dy) * 100).toFixed(2));
  }

  // 3. Hierarchy ratio
  let titleSize: number | null = null;
  let bodySize: number | null = null;
  for (const t of layout.text) {
    if (t.role === 'title') {
      titleSize = Math.max(titleSize || 0, t.fontSize);
    }
    if (t.role === 'body') {
      bodySize = Math.max(bodySize || 0, t.fontSize);
    }
  }
  const hierarchyRatio =
    titleSize && bodySize ? parseFloat((titleSize / bodySize).toFixed(2)) : 1.0;

  // 4. Lines per text box & Body chars per line
  const lines: Record<number, number> = {};
  let totalBodyChars = 0;
  let totalBodyLines = 0;

  for (const t of layout.text) {
    let lineCount = options.measuredLines?.[t.copyIndex];
    if (lineCount === undefined) {
      // Estimate lines from box height and lineHeight/fontSize
      const nominalLineHeight = t.fontSize * t.lineHeight;
      lineCount = Math.max(1, Math.round(t.height / nominalLineHeight));
    }
    lines[t.copyIndex] = lineCount;

    if (t.role === 'body') {
      const text = options.copyText?.[t.copyIndex];
      if (text) {
        totalBodyChars += text.length;
        totalBodyLines += lineCount;
      } else {
        // Approximate average characters per line based on width and average font width (~0.5 em)
        const approxCharsPerLine = Math.round(t.width / (t.fontSize * 0.52));
        totalBodyChars += approxCharsPerLine * lineCount;
        totalBodyLines += lineCount;
      }
    }
  }

  const bodyCharsPerLine =
    totalBodyLines > 0 ? parseFloat((totalBodyChars / totalBodyLines).toFixed(1)) : 0;

  // 5. Margin minimum
  let marginMin = Infinity;
  for (const t of [...layout.text, layout.logo]) {
    const left = t.x;
    const top = t.y;
    const right = width - (t.x + t.width);
    const bottom = height - (t.y + t.height);
    marginMin = Math.min(marginMin, left, top, right, bottom);
  }
  if (!Number.isFinite(marginMin)) marginMin = 0;

  // 6. Overlap count
  const overlapCount = overlappingPairs(layout).length;

  // 7. Logo width percentage
  const logoWidthPct = parseFloat(((layout.logo.width / width) * 100).toFixed(2));

  // 8. Contrast P05
  const contrastP05: Record<number, number> = options.contrastValues || {};
  if (!options.contrastValues) {
    for (const t of layout.text) {
      contrastP05[t.copyIndex] = parseFloat(declaredTextContrast(layout, t).toFixed(2));
    }
  }

  return {
    alignmentScore,
    whitespaceRatio,
    balanceOffset,
    hierarchyRatio,
    bodyCharsPerLine,
    lines,
    contrastP05,
    marginMin,
    overlapCount,
    logoWidthPct,
  };
}
