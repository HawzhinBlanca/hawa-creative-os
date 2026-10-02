import type { StudioLayoutV2, Box } from './layout-v2.js';
import { declaredTextContrast } from './composite-contrast.js';
import { carrierOf, shapePaintsOver } from './art-direction/surfaces.js';

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

/** ADR-273: the alignment rules hard QA's POOR_GRID_ALIGNMENT gate reads, versioned. */
export const ALIGNMENT_POLICY = Object.freeze({
  id: 'studio.layout-alignment',
  version: '2026-10-02.1',
  /** Targets besides the grid: the canvas edges, and for text, the plate, card, tab, pill or fade it sits on. */
  targets: 'grid_margins_centre_canvas_edges_container',
  passScore: 0.7,
});

/**
 * ADR-273: text set on a container (a panel, or a fade or scrim that carries it) aligns to that
 * container: centred in it, or set on its start or end edge at the same inset as the text has from
 * the container's top (even padding). The office centres its title in a plate and sets its call to
 * action in a pill; neither box need meet a grid line of the canvas.
 */
function alignedInContainer(layout: StudioLayoutV2, t: StudioLayoutV2['text'][number], threshold: number): boolean {
  const inside = (o: Box) => t.x >= o.x - 2 && t.y >= o.y - 2 && t.x + t.width <= o.x + o.width + 2 && t.y + t.height <= o.y + o.height + 2;
  const containers: Box[] = (layout.shapes || []).filter((s) => s.role === 'panel' && s.fill !== 'none' &&
    !(s.width >= layout.width * 0.95 && s.height >= layout.height * 0.95) && inside(s));
  const carrier = carrierOf(layout, t);
  if (carrier?.kind === 'overlay') containers.push(carrier.overlay);
  return containers.some((o) => {
    const centred = Math.abs(t.x + t.width / 2 - (o.x + o.width / 2)) <= threshold;
    const pad = t.y - o.y;
    const start = Math.abs(t.x - o.x - pad) <= threshold;
    const end = Math.abs(o.x + o.width - (t.x + t.width) - pad) <= threshold;
    return t.align === 'center' ? centred : t.align === 'right' ? end || centred : start || centred;
  });
}

export function computeLayoutMetrics(
  layout: StudioLayoutV2,
  options: MetricCalculationOptions = {}
): LayoutMetrics {
  const width = layout.width;
  const height = layout.height;
  const canvasArea = width * height;
  const threshold = 0.005 * width; // 0.5% of width

  // 1. Grid lines and alignment targets. ADR-273 (ALIGNMENT_POLICY 2026-10-02.1): the canvas edges
  // are targets too. The office bleeds its title tab, its cards and its footer bar off the edge, and
  // an edge at x=0 or x=W lined up only by coincidence with another bleed.
  const gridLinesX: number[] = [
    0,
    width,
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

  // ADR204: text aligns on its declared left/right/centre axis. A narrower flush body column does
  // not need the title's unused right edge; coincident box centres do not align ragged left text.
  // Shapes/logos retain geometric centre support, including genuinely centred text. Thresholds
  // are unchanged; alignment consistency is not a calibrated human aesthetic score.
  const textAxes = layout.text.map(t => t.align === 'center' ? t.x + t.width / 2 : t.align === 'right' ? t.x + t.width : t.x);
  const centresX = allElements.map((el) => el.x + el.width / 2);
  const alignedAxis = centresX.map((c, k) => k < layout.text.length
    ? gridLinesX.some(x => Math.abs(textAxes[k] - x) <= threshold) ||
      textAxes.some((x, j) => j !== k && Math.abs(textAxes[k] - x) <= threshold) ||
      alignedInContainer(layout, layout.text[k], threshold)
    : Math.abs(c - width / 2) <= threshold || centresX.some((other, j) => j !== k &&
      (j >= layout.text.length || layout.text[j].align === 'center') && Math.abs(other - c) <= threshold));

  // Check alignment of each edge
  let alignedEdges = 0;
  for (let i = 0; i < edgesX.length; i++) {
    const x = edgesX[i];
    let isAligned = alignedAxis[Math.floor(i / 2)];

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
