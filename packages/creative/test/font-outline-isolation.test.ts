import { describe, expect, it, vi } from 'vitest';
import type { StudioLayoutV2, TextElement } from '../src/studio/layout-v2.js';

/**
 * fontkit caches a glyph object by id with the code points it was first created with, and its Arabic
 * shaper reads joining types from them. Reading a composite glyph's outline or box creates its components
 * with no code points: in IBM Plex Sans Arabic Bold the final U+06D5 is built on the heh glyph, so once a
 * line with U+06D5 had its ink read before any heh was shaped, every later U+0647 shaped as non-joining
 * and titles measured 4-7% off what Pango draws (ADR-290). Measurement must not depend on what the process
 * drew before it.
 */
const title = { copyIndex: 0, fontFamily: 'IBM Plex Sans Arabic', bold: true, fontSize: 64, lineHeight: 1.3, width: 3000, height: 120,
  x: 0, y: 0, role: 'title', color: '#000000', align: 'right', rtl: true } as unknown as TextElement;
const layout = { text: [title] } as unknown as StudioLayoutV2;
const withHeh = { 0: 'بەهاری شاری هەولێر' };
const fresh = async () => { vi.resetModules(); return import('../src/studio/render-layout-v2.js'); };

describe('font outline reads never change shaping', () => {
  it('measures a title with heh the same in a process that first read the ink of a line ending in U+06D5', async () => {
    const clean = (await fresh()).measureMaxLineWidths(layout, withHeh)[0];
    expect(clean).toBeGreaterThan(0);
    for (const line of ['ژیانە', 'ە', 'خوێندنەوە']) {
      const renderer = await fresh();
      expect(renderer.measureLineInkClearance({ ...title, width: 1200 } as TextElement, `${line}\n${line}`)).toBeDefined();
      expect(renderer.measureMaxLineWidths(layout, withHeh)[0]).toBe(clean);
    }
  });
});
