import { describe, it, expect } from 'vitest';
import { computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

describe('Design Studio v2: Layout Metrics Engine (computeLayoutMetrics)', () => {
  const fixtureLayout: StudioLayoutV2 = {
    version: 2,
    width: 1000,
    height: 1000,
    grid: { margin: 100, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [],
    logo: {
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    },
    text: [
      {
        copyIndex: 0,
        role: 'title',
        x: 100,
        y: 250,
        width: 800,
        height: 100,
        fontSize: 50,
        lineHeight: 1.2,
        fontFamily: 'Verdana',
        color: '#F7B500',
        align: 'left',
      },
      {
        copyIndex: 1,
        role: 'body',
        x: 100,
        y: 400,
        width: 800,
        height: 100,
        fontSize: 25,
        lineHeight: 1.4,
        fontFamily: 'Verdana',
        color: '#FDF8F3',
        align: 'left',
      },
    ],
  };

  it('computes exact hand-verified metrics for fixture layout', () => {
    // Hand calculations:
    // Canvas: 1000x1000 = 1,000,000 px^2
    // Elements:
    //   Logo: 100x100 = 10,000 px^2, center (150, 150)
    //   Title: 800x100 = 80,000 px^2, center (500, 300)
    //   Body: 800x100 = 80,000 px^2, center (500, 450)
    // Total ink area = 170,000 px^2
    // Whitespace ratio = 1 - 170000 / 1000000 = 0.830
    //
    // Edges (X):
    //   Logo: [100, 200]
    //   Title: [100, 900]
    //   Body: [100, 900]
    //   Grid targets: margin=100, width-margin=900, center=500, column lines
    //   100 is aligned (matches margin and other elements) -> 3 edges aligned
    //   900 is aligned (matches right margin and other elements) -> 2 edges aligned
    //   200 is not aligned (closest grid line is 217, diff 17 > 5px threshold)
    //   Aligned count = 5 / 6 edges = 0.833
    //
    // Centroid:
    //   Weighted X = 10000*150 + 80000*500 + 80000*500 = 81,500,000 / 170,000 = 479.412
    //   Weighted Y = 10000*150 + 80000*300 + 80000*450 = 61,500,000 / 170,000 = 361.765
    //   Center: (500, 500)
    //   dx = (479.412 - 500) / 1000 = -0.020588
    //   dy = (361.765 - 500) / 1000 = -0.138235
    //   balanceOffset = sqrt((-0.020588)^2 + (-0.138235)^2) * 100 = 13.98%
    //
    // Hierarchy: 50 / 25 = 2.00
    // Logo width pct: 100 / 1000 * 100 = 10.00%
    // Margin min: 100 px
    // Overlap count: 0
    const bodyCopy = 'The American University of Kurdistan provides international standard academic education.';
    const metrics = computeLayoutMetrics(fixtureLayout, {
      measuredLines: { 0: 1, 1: 3 },
      copyText: { 1: bodyCopy },
      contrastValues: { 0: 8.5, 1: 9.2 },
    });

    expect(metrics.alignmentScore).toBe(0.833);
    expect(metrics.whitespaceRatio).toBe(0.830);
    expect(metrics.balanceOffset).toBe(13.98);
    expect(metrics.hierarchyRatio).toBe(2.00);
    expect(metrics.logoWidthPct).toBe(10.00);
    expect(metrics.marginMin).toBe(100);
    expect(metrics.overlapCount).toBe(0);
    expect(metrics.lines[0]).toBe(1);
    expect(metrics.lines[1]).toBe(3);
    expect(metrics.bodyCharsPerLine).toBe(parseFloat((bodyCopy.length / 3).toFixed(1))); // 89 / 3 = 29.7
    expect(metrics.contrastP05[0]).toBe(8.5);
    expect(metrics.contrastP05[1]).toBe(9.2);
  });

  it('detects overlaps and updates overlapCount accurately', () => {
    const overlappingLayout: StudioLayoutV2 = {
      ...fixtureLayout,
      text: [
        {
          ...fixtureLayout.text[0],
          y: 150, // Overlaps with logo [100, 100, 100, 100] (y: 100..200)
        },
        fixtureLayout.text[1],
      ],
    };

    const metrics = computeLayoutMetrics(overlappingLayout);
    expect(metrics.overlapCount).toBe(1);
  });
});
