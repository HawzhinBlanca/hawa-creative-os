import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import {
  prepareGeneratedLayoutV3,
  resolveOrnamentSettings,
  evaluateHardQa,
  renderLayoutV2ToSvg,
  encodeStudioTransferV2,
  generateMotifSvg,
  studioReferenceFromRaw,
  logoClearZone,
  type StyleSpec,
  type StudioLayoutV2,
} from '../src/index.js';

// Task 89c242f2 (2026-09-19): the owner's reference had a heavy sans title filling the width, a gold
// edition line, a gold button on the bottom margin and the logo bottom-right; the delivered design
// had a small serif title, a navy box and the logo top-centre. The spec is what the live brief read.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reference-k12-89c242f2.json', import.meta.url), 'utf8')) as {
  spec: StyleSpec;
  copy: { ckb: string[]; en: string[] };
  layouts: StudioLayoutV2[];
};
const reference = studioReferenceFromRaw(
  JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'))
);
const GOLD = '#F7B500';

const prepared = (lang: 'ckb' | 'en', k: number) => {
  const blocks = fixture.copy[lang];
  const copy = { text: Object.fromEntries(blocks.map((b, i) => [i, b])) };
  const raw = JSON.parse(JSON.stringify(fixture.layouts[k])) as StudioLayoutV2;
  for (const t of raw.text) {
    t.rtl = lang === 'ckb';
    if (lang === 'en' && /Amiri|Noto Sans Arabic/.test(t.fontFamily)) t.fontFamily = 'Playfair Display';
  }
  const layout = prepareGeneratedLayoutV3(raw, copy, {
    width: 1080,
    height: 1350,
    logoAspect: 1,
    palette: reference.palette,
    ornament: resolveOrnamentSettings({}),
    style: fixture.spec,
  });
  const script = lang === 'ckb' ? 'arabic' : 'latin';
  const qa = evaluateHardQa(layout, {
    width: 1080,
    height: 1350,
    copyScripts: blocks.map(() => script),
    latinFont: reference.latinFont,
    arabicFont: reference.arabicFont,
    palette: reference.palette,
    logoAspect: 1,
    copyText: copy.text,
  });
  return { layout, qa, copy, blocks };
};

describe('a style spec read from the reference is enforced on every candidate', () => {
  for (const lang of ['ckb', 'en'] as const) {
    for (const k of [0, 1, 2]) {
      it(`${lang} candidate ${k}: passes QA and looks like the reference`, () => {
        const { layout, qa } = prepared(lang, k);
        expect(qa.passed).toBe(true);
        const W = layout.width;
        const m = layout.grid.margin;
        const title = layout.text.find((t) => t.role === 'title')!;
        const cta = layout.text.find((t) => t.role === 'cta')!;
        // Heavy sans display title across the column, its edition line in gold.
        expect(title.fontSize).toBeGreaterThanOrEqual(0.07 * W);
        expect(title.bold).toBe(true);
        expect(title.fontFamily).toBe(lang === 'ckb' ? 'Noto Sans Arabic' : 'Verdana');
        expect(title.accentColor).toBe(GOLD);
        expect(title.width).toBe(W - 2 * m);
        // Reading-direction start: left in English, right in Kurdish.
        for (const t of layout.text.filter((t) => t !== cta)) expect(t.align).toBe(lang === 'ckb' ? 'right' : 'left');
        // A gold button behind the call to action, dark text on it; no other panels, no dividers.
        const buttons = layout.shapes.filter((s) => s.role === 'panel');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].color).toBe(GOLD);
        expect(cta.x).toBeGreaterThan(buttons[0].x);
        expect(cta.x + cta.width).toBeLessThan(buttons[0].x + buttons[0].width);
        expect(cta.color).toBe('#0A1628');
        expect(layout.shapes.some((s) => s.role === 'rule' || s.role === 'accent')).toBe(false);
        // Logo bottom-right; the button on the bottom margin or just above the logo's clear space.
        expect(layout.logo.x + layout.logo.width).toBe(W - m);
        expect(layout.logo.y + layout.logo.height).toBe(layout.height - m);
        const floor = Math.min(layout.height - m, logoClearZone(layout.logo).y);
        expect(buttons[0].y + buttons[0].height).toBeGreaterThanOrEqual(floor - 1);
        // Title high: its top within the upper fifth.
        expect(title.y).toBeLessThan(0.2 * layout.height);
        expect(layout.art).toMatchObject({ source: 'procedural', motif: 'diagonal-lines' });
      });
    }
  }

  it('draws the edition line in gold in the preview and in the Canva deck', async () => {
    const { layout, copy, blocks } = prepared('en', 0);
    const { svg } = renderLayoutV2ToSvg(layout, { copyText: copy.text });
    expect(svg).toMatch(/<tspan[^>]*fill="#F7B500"[^>]*>EDITION 2\.0<\/tspan>/);
    const deck = await encodeStudioTransferV2(layout, blocks, undefined);
    const xml = strFromU8(unzipSync(deck.bytes, { filter: (f) => f.name === 'ppt/slides/slide1.xml' })['ppt/slides/slide1.xml']);
    const edition = xml.slice(xml.indexOf('EDITION') - 400, xml.indexOf('EDITION'));
    expect(edition).toContain('F7B500');
    const framework = xml.slice(xml.indexOf('FRAMEWORK') - 400, xml.indexOf('FRAMEWORK'));
    expect(framework).not.toContain('F7B500');
  });

  it('renders the diagonal-lines texture in brand colours', () => {
    const svg = generateMotifSvg('diagonal-lines', { width: 1080, height: 1350, palette: reference.palette as any });
    expect(svg).toContain('<polygon');
    expect((svg.match(/<line /g) || []).length).toBeGreaterThan(50);
    expect(svg).not.toMatch(/<text/);
  });

  it('leaves a layout alone when the spec decides nothing', () => {
    const neutral = Object.fromEntries(Object.keys(fixture.spec).map((k) => [k, k === 'accentLastTitleLine' ? false : 'as_generated'])) as StyleSpec;
    const blocks = fixture.copy.ckb;
    const copy = { text: Object.fromEntries(blocks.map((b, i) => [i, b])) };
    const canvas = { width: 1080, height: 1350, logoAspect: 1, palette: reference.palette, ornament: resolveOrnamentSettings({}) };
    const a = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(fixture.layouts[0])), copy, canvas);
    const b = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(fixture.layouts[0])), copy, { ...canvas, style: neutral });
    expect(b).toEqual(a);
  });
});
