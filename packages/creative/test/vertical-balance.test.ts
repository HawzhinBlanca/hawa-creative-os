import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { balanceVertically, measureDesignV3, prepareGeneratedLayoutV3, resolveOrnamentSettings, encodeStudioTransferV2, keepCompoundsWhole, type StudioLayoutV2 } from '../src/index.js';

// The cheap-tier winner of task 8fb76534 (2026-09-19): three short Kurdish lines in the top 55% of
// a 1080x1350 canvas, 415px of nothing above a corner logo. It was delivered.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-tier-dead-band-8fb76534.json', import.meta.url), 'utf8')
) as { copy: string[]; layout: StudioLayoutV2 };
const copy = {
  text: Object.fromEntries(fixture.copy.map((b, i) => [i, b])),
  scripts: Object.fromEntries(fixture.copy.map((_, i) => [i, 'arabic' as const])),
};
const clone = () => JSON.parse(JSON.stringify(fixture.layout)) as StudioLayoutV2;

describe('a short stack is re-spaced, not enlarged', () => {
  it('fails negative space as delivered', () => {
    expect(measureDesignV3(clone(), copy).failingMetrics).toContain('negativeSpace');
  });

  it('closes the dead band, keeping order, type sizes, rhythm and the logo', () => {
    const before = clone();
    const after = balanceVertically(clone(), copy);
    const m = measureDesignV3(after, copy);
    expect(m.failingMetrics).not.toContain('negativeSpace');
    expect(m.compositeScore).toBeGreaterThan(measureDesignV3(before, copy).compositeScore);
    expect(after.text.map((t) => t.fontSize)).toEqual(before.text.map((t) => t.fontSize));
    expect(after.text.map((t) => t.height)).toEqual(before.text.map((t) => t.height));
    expect([...after.text].sort((a, b) => a.y - b.y).map((t) => t.copyIndex)).toEqual([0, 1, 2]);
    expect(after.logo).toEqual(before.logo);
    // Every gap grew by the same factor.
    const gaps = (l: StudioLayoutV2) => {
      const s = [...l.text].sort((a, b) => a.y - b.y);
      return s.slice(1).map((t, i) => t.y - (s[i].y + s[i].height));
    };
    const [a, b] = gaps(after).map((g, i) => g / gaps(before)[i]);
    expect(a).toBeCloseTo(b, 1);
    // The empty band under the stack is now about the one above it, not five times it.
    const top = Math.min(...after.shapes.map((s) => s.y), ...after.text.map((t) => t.y)) - after.grid.margin;
    const below = after.logo!.y - 65 - Math.max(...after.text.map((t) => t.y + t.height));
    expect(below / top).toBeLessThan(2);
  });

  it('leaves a layout alone when negative space already passes', () => {
    const once = balanceVertically(clone(), copy);
    const snapshot = JSON.stringify(once);
    expect(JSON.stringify(balanceVertically(once, copy))).toBe(snapshot);
  });

  it('is part of preparation, and HAWA_DESIGN_BALANCE=off turns it off', () => {
    const canvas = { width: 1080, height: 1350, logoAspect: 1 };
    const on = prepareGeneratedLayoutV3(clone(), copy, { ...canvas, ornament: resolveOrnamentSettings({}) });
    const off = prepareGeneratedLayoutV3(clone(), copy, { ...canvas, ornament: resolveOrnamentSettings({ HAWA_DESIGN_BALANCE: 'off' }) });
    expect(measureDesignV3(on, copy).failingMetrics).not.toContain('negativeSpace');
    expect(measureDesignV3(off, copy).failingMetrics).toContain('negativeSpace');
    expect(() => resolveOrnamentSettings({ HAWA_DESIGN_BALANCE: 'maybe' })).toThrow(/HAWA_DESIGN_BALANCE/);
  });
});

describe('the Canva deck sets Kurdish copy as the preview drew it', () => {
  it('keeps a centred Kurdish block centred, and "K-12" on one line', async () => {
    const deck = await encodeStudioTransferV2(clone(), fixture.copy, undefined);
    const xml = strFromU8(unzipSync(deck.bytes, { filter: (f) => f.name === 'ppt/slides/slide1.xml' })['ppt/slides/slide1.xml']);
    const title = xml.slice(xml.indexOf('چوارچێوەی') - 900, xml.indexOf('چوارچێوەی'));
    expect(title).toContain('rtl="1"');
    expect(title).toContain('algn="ctr"');
    expect(xml).toContain('K⁠-⁠12');
    expect(xml).not.toContain('(K-12)');
  });

  it('joins only compounds, never words split by a space or a dash with spaces', () => {
    expect(keepCompoundsWhole('(K-12) 2025/2026')).toBe('(K⁠-⁠12) 2025⁠/⁠2026');
    expect(keepCompoundsWhole('Erbil - 2026')).toBe('Erbil - 2026');
    expect(keepCompoundsWhole('kaae.org')).toBe('kaae.org');
  });
});
