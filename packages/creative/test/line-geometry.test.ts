import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lineGeometry, renderLayoutV2ToSvg, type StudioLayoutV2 } from '../src/index.js';

describe('lineGeometry: a line runs along the long side of its box', () => {
  it('keeps a thick horizontal rule level', () => {
    const g = lineGeometry({ x: 100, y: 1074, width: 205, height: 3 });
    expect(g.orientation).toBe('horizontal');
    expect(g.y1).toBe(g.y2);
    expect(g.y1).toBe(1075.5);
    expect([g.x1, g.x2]).toEqual([100, 305]);
    expect(g.strokeWidth).toBe(3);
  });

  it('draws a vertical accent as a thin upright line, not a slab', () => {
    const g = lineGeometry({ x: 228, y: 1154, width: 6, height: 202 });
    expect(g.orientation).toBe('vertical');
    expect(g.x1).toBe(g.x2);
    expect(g.x1).toBe(231);
    expect([g.y1, g.y2]).toEqual([1154, 1356]);
    expect(g.strokeWidth).toBe(6);
  });

  it('honours an explicit stroke width and never returns a zero stroke', () => {
    expect(lineGeometry({ x: 0, y: 0, width: 400, height: 0 }).strokeWidth).toBe(1);
    expect(lineGeometry({ x: 0, y: 0, width: 400, height: 8, strokeWidth: 2 }).strokeWidth).toBe(2);
    expect(lineGeometry({ x: 0, y: 0, width: 400, height: 8, strokeWidth: 0 }).strokeWidth).toBe(8);
  });

  it('paints inside its own box for every orientation and thickness', () => {
    for (const [width, height] of [[300, 1], [300, 4], [300, 12], [1, 300], [4, 300], [12, 300], [50, 50]]) {
      const box = { x: 40, y: 60, width, height };
      const g = lineGeometry(box);
      const half = g.strokeWidth / 2;
      const minX = Math.min(g.x1, g.x2) - (g.orientation === 'vertical' ? half : 0);
      const maxX = Math.max(g.x1, g.x2) + (g.orientation === 'vertical' ? half : 0);
      const minY = Math.min(g.y1, g.y2) - (g.orientation === 'horizontal' ? half : 0);
      const maxY = Math.max(g.y1, g.y2) + (g.orientation === 'horizontal' ? half : 0);
      expect(minX).toBeGreaterThanOrEqual(box.x);
      expect(maxX).toBeLessThanOrEqual(box.x + Math.max(1, width));
      expect(minY).toBeGreaterThanOrEqual(box.y);
      expect(maxY).toBeLessThanOrEqual(box.y + Math.max(1, height));
    }
  });
});

describe('the preview renderer draws lines through lineGeometry', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/cheap-tier-stroke-slab-brief_08.json', import.meta.url), 'utf8')
  ) as { copy: string[]; layout: StudioLayoutV2 };
  const lineAttrs = (svg: string, id: string) => {
    const tag = new RegExp(`<line id="${id}"[^>]*>`).exec(svg)?.[0] ?? '';
    const num = (name: string) => Number(new RegExp(` ${name}="([^"]+)"`).exec(tag)?.[1]);
    return { x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'), stroke: num('stroke-width') };
  };

  it('a 4px rule is level and a 6x202 accent is a 6px upright line', () => {
    const layout: StudioLayoutV2 = JSON.parse(JSON.stringify(fixture.layout));
    layout.shapes = [
      { kind: 'line', role: 'rule', color: '#F7B500', x: 100, y: 500, width: 205, height: 4 },
      { kind: 'line', role: 'accent', color: '#F7B500', x: 228, y: 600, width: 6, height: 202 },
    ];
    const { svg } = renderLayoutV2ToSvg(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: Object.fromEntries(fixture.copy.map((c, i) => [i, c])) });
    const rule = lineAttrs(svg, 'shape-0');
    expect(rule.y1).toBe(rule.y2);
    expect(rule.stroke).toBe(4);
    const accent = lineAttrs(svg, 'shape-1');
    expect(accent.x1).toBe(accent.x2);
    expect(accent.y2 - accent.y1).toBe(202);
    expect(accent.stroke).toBe(6);
  });
});
