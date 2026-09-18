import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { prepareGeneratedLayoutV3, resolveOrnamentSettings, evaluateHardQa, encodeStudioTransferV2, renderMotifPng, type StudioLayoutV2 } from '../src/index.js';

// The owner asked for richer designs (2026-09-19): gold dividers and texture on every design.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cheap-tier-overflow-1f392e16.json', import.meta.url), 'utf8')) as { copy: string[]; layout: StudioLayoutV2 };
const copy = { text: Object.fromEntries(fixture.copy.map((b, i) => [i, b])), script: Object.fromEntries(fixture.copy.map((_, i) => [i, 'latin' as const])) };
const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500', '#FDF8F3', '#2C5282', '#FFFFFF', '#1A1A1A'];
const qa = { width: 1080, height: 1350, copyScripts: fixture.copy.map(() => 'latin' as const), latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette: PALETTE, logoAspect: 1, copyText: copy.text };
const prepare = (ornament?: ReturnType<typeof resolveOrnamentSettings>) =>
  prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(fixture.layout)), copy, { width: 1080, height: 1350, logoAspect: 1, palette: PALETTE, ...(ornament ? { ornament } : {}) });

describe('brand ornament', () => {
  it('defaults to sun rays at a quarter opacity with dividers, and refuses unknown values', () => {
    expect(resolveOrnamentSettings({})).toEqual({ dividers: true, texture: 'sun-rays', textureOpacity: 0.25 });
    expect(resolveOrnamentSettings({ HAWA_DESIGN_TEXTURE: 'none', HAWA_DESIGN_DIVIDERS: 'off' })).toEqual({ dividers: false, texture: 'none', textureOpacity: 0.25 });
    expect(() => resolveOrnamentSettings({ HAWA_DESIGN_TEXTURE: 'marble' })).toThrow(/HAWA_DESIGN_TEXTURE/);
    expect(() => resolveOrnamentSettings({ HAWA_DESIGN_TEXTURE_OPACITY: '0.9' })).toThrow(/OPACITY/);
  });

  it('adds a texture and a gold divider that clear QA, and changes nothing without the setting', () => {
    const plain = prepare();
    expect(plain.art).toBeUndefined();
    const rich = prepare(resolveOrnamentSettings({}));
    expect(rich.art).toMatchObject({ source: 'procedural', motif: 'sun-rays', opacity: 0.25 });
    const rules = rich.shapes.filter((s) => s.role === 'rule');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).toMatchObject({ color: '#F7B500', height: 2 });
    expect(evaluateHardQa(rich, qa).messages).toEqual([]);
    // Copy is untouched: every line centre stays where it was drawn.
    const centre = (l: StudioLayoutV2, i: number) => { const t = l.text.find((x) => x.copyIndex === i)!; return t.y + t.height / 2; };
    for (const t of plain.text) expect(Math.abs(centre(rich, t.copyIndex) - centre(plain, t.copyIndex))).toBeLessThanOrEqual(1);
  });

  it('keeps a layout its own artwork and rules', () => {
    const own = JSON.parse(JSON.stringify(fixture.layout)) as StudioLayoutV2;
    own.art = { source: 'generated', prompt: 'navy silk', opacity: 0.3, box: { x: 0, y: 0, width: 1080, height: 1350 }, calmRegion: { x: 0, y: 0, width: 1080, height: 1350 } } as any;
    const out = prepareGeneratedLayoutV3(own, copy, { width: 1080, height: 1350, logoAspect: 1, palette: PALETTE, ornament: resolveOrnamentSettings({}) });
    expect(out.art).toMatchObject({ source: 'generated', opacity: 0.3 });
  });

  it("sends Canva the texture at the layer's opacity, as the render draws it", async () => {
    const rich = prepare(resolveOrnamentSettings({}));
    const art = renderMotifPng('sun-rays', { width: 1080, height: 1350, palette: PALETTE, opacity: 1 });
    const deck = await encodeStudioTransferV2(rich, fixture.copy, undefined, { artBuffer: art });
    const slide = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    expect(slide).toContain('<a:alphaModFix amt="25000"/>');
  });
});
