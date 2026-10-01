import { describe, expect, it } from 'vitest';
import { computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import { evaluateHardQa, type HardQaContext } from '../src/studio/hard-qa.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { SIX_CONFIRMED_EXEMPLARS, BAD_OFF_GRID } from './fixtures/design-metrics-fixtures.js';

function aligned(align: 'left' | 'right' | 'center'): StudioLayoutV2 {
  return { version: 2, width: 1000, height: 1000, grid: { margin: 100, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#FFFFFF' }, shapes: [], logo: { x: align === 'right' ? 800 : 100, y: 100, width: 100, height: 100 },
    text: [
      { copyIndex: 0, role: 'title', x: 100, y: 300, width: 800, height: 100, fontSize: 55, lineHeight: 1.2, fontFamily: 'Verdana', color: '#000000', align },
      { copyIndex: 1, role: 'body', x: align === 'right' ? 444 : align === 'center' ? 272 : 100, y: 550, width: 456, height: 100,
        fontSize: 25, lineHeight: 1.4, fontFamily: 'Verdana', color: '#000000', align },
    ] };
}
const ctx: HardQaContext = { width: 1000, height: 1000, palette: ['#FFFFFF', '#000000'], copyScripts: ['latin', 'latin'],
  copyText: { 0: 'Title', 1: 'Report evidence for review.' }, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1 };

describe('declared text alignment axes (ADR204)', () => {
  it.each(['left', 'right', 'center'] as const)('recognizes unequal-width %s columns without requiring an unused edge', align => {
    const layout = aligned(align), before = structuredClone(layout);
    expect(computeLayoutMetrics(layout).alignmentScore).toBe(.833);
    expect(evaluateHardQa(layout, ctx).defectCodes).not.toContain('POOR_GRID_ALIGNMENT');
    expect(layout).toEqual(before);
  });

  it.each(['left', 'right'] as const)('refuses ragged %s text even when unused box centres coincide', align => {
    const layout = aligned(align);
    layout.text[0].x = 150; layout.text[0].width = 600;
    layout.text[1].x = 230; layout.text[1].width = 440;
    if (align === 'right') for (const t of layout.text) t.x = layout.width - t.x - t.width;
    expect(layout.text.map(t => t.x + t.width / 2)).toEqual(align === 'left' ? [450, 450] : [550, 550]);
    expect(computeLayoutMetrics(layout).alignmentScore).toBeLessThan(.7);
    expect(evaluateHardQa(layout, ctx).defectCodes).toContain('POOR_GRID_ALIGNMENT');
  });

  it('keeps the original half-percent alignment tolerance and ignores unused widths', () => {
    const layout = aligned('left');
    layout.text[1].width = 333;
    const baseline = computeLayoutMetrics(layout).alignmentScore;
    layout.text[1].x += 4;
    expect(computeLayoutMetrics(layout).alignmentScore).toBe(baseline);
    layout.text[1].x += 2;
    expect(computeLayoutMetrics(layout).alignmentScore).toBeLessThan(.7);
  });

  it('preserves existing approved and deliberately off-grid controls', () => {
    for (const layout of SIX_CONFIRMED_EXEMPLARS) expect(computeLayoutMetrics(layout).alignmentScore).toBeGreaterThanOrEqual(.7);
    expect(computeLayoutMetrics(BAD_OFF_GRID).alignmentScore).toBeLessThan(.7);
  });
});
