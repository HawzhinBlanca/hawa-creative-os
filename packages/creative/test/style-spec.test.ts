import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
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
  layoutDefectCount,
  checkCandidateSetDegeneracy,
  logoClearZone,
  NEUTRAL_STYLE_SPEC,
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
      it(`${lang} candidate ${k}: preserves reference style and measures actual mixed-font fallback`, () => {
        const { layout, qa } = prepared(lang, k);
        expect(qa.passed, qa.messages.join('; ')).toBe(true);
        expect(qa.defectCodes).toEqual([]);
        if (lang === 'ckb') expect(qa.textMeasurements.some((m) => m.status === 'measured' && m.method === 'pango-wrap-v1')).toBe(true);
        const W = layout.width;
        const m = layout.grid.margin;
        const title = layout.text.find((t) => t.role === 'title')!;
        const cta = layout.text.find((t) => t.role === 'cta')!;
        // Heavy sans display title across the column, its edition line in gold.
        // Display size. Sorani carries its marks above and below the line, so the house leading is
        // 1.6-1.9 against 1.2-1.5 for Latin and the same box holds a slightly smaller face.
        expect(title.fontSize).toBeGreaterThanOrEqual((lang === 'ckb' ? 0.06 : 0.07) * W);
        expect(title.bold).toBe(true);
        expect(title.fontFamily).toBe(lang === 'ckb' ? 'Noto Sans Arabic' : 'Verdana');
        expect(title.accentColor).toBe(GOLD);
        // The measure is the design's own, snapped to its columns, not the full safe area: forcing
        // every block to the column made all three candidates identical.
        expect(title.width).toBeGreaterThan(0.5 * (W - 2 * m));
        expect(title.width).toBeLessThanOrEqual(W - 2 * m);
        // Reading-direction start: left in English, right in Kurdish.
        for (const t of layout.text.filter((t) => t !== cta)) expect(t.align).toBe(lang === 'ckb' ? 'right' : 'left');
        // The button keeps out of the logo's corner, as it does in the owner's reference.
        const button = layout.shapes.find((sh) => sh.role === 'panel')!;
        expect(button.x + button.width).toBeLessThan(layout.logo.x);
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
    const { svg } = renderLayoutV2ToSvg(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: copy.text });
    expect(svg).toMatch(/<tspan[^>]*fill="#F7B500"[^>]*>EDITION 2\.0<\/tspan>/);
    const deck = await encodeStudioTransferV2(layout, blocks, undefined);
    const xml = strFromU8(unzipSync(deck.bytes, { filter: (f) => f.name === 'ppt/slides/slide1.xml' })['ppt/slides/slide1.xml']);
    const edition = xml.slice(xml.indexOf('EDITION') - 400, xml.indexOf('EDITION'));
    expect(edition).toContain('F7B500');
    const framework = xml.slice(xml.indexOf('FRAMEWORK') - 400, xml.indexOf('FRAMEWORK'));
    expect(framework).not.toContain('F7B500');
  });

  it('keeps every paragraph of an accented Kurdish title right-to-left in the Canva deck', async () => {
    const { layout, blocks } = prepared('ckb', 0);
    const deck = await encodeStudioTransferV2(layout, blocks, undefined);
    const xml = strFromU8(unzipSync(deck.bytes, { filter: (f) => f.name === 'ppt/slides/slide1.xml' })['ppt/slides/slide1.xml']);
    const title = xml.slice(xml.lastIndexOf('<p:txBody>', xml.indexOf('چوارچێوەی')), xml.indexOf('</p:txBody>', xml.indexOf('چوارچێوەی')));
    const paragraphs = title.match(/<a:pPr[^>]*>/g) || [];
    expect(paragraphs).toHaveLength(2);
    for (const p of paragraphs) expect(p).toContain('rtl="1"');
    expect(title).toContain('F7B500');
  });

  it('renders the diagonal-lines texture in brand colours', () => {
    const svg = generateMotifSvg('diagonal-lines', { width: 1080, height: 1350, palette: reference.palette as any });
    expect(svg).toContain('<polygon');
    expect((svg.match(/<line /g) || []).length).toBeGreaterThan(50);
    expect(svg).not.toMatch(/<text/);
  });

  it('leaves a layout alone when the spec decides nothing', () => {
    const neutral: StyleSpec = { ...NEUTRAL_STYLE_SPEC };
    const blocks = fixture.copy.ckb;
    const copy = { text: Object.fromEntries(blocks.map((b, i) => [i, b])) };
    const canvas = { width: 1080, height: 1350, logoAspect: 1, palette: reference.palette, ornament: resolveOrnamentSettings({}) };
    const a = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(fixture.layouts[0])), copy, canvas);
    const b = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(fixture.layouts[0])), copy, { ...canvas, style: neutral });
    expect(b).toEqual(a);
  });

  // The spec moves things, so it can put two parts of a design into each other. Preparation gives up
  // one decision at a time, and only the one in the way; a design it cannot hold is delivered as the
  // generator drew it. Applying the owner's real spec to the 200 stored designs used to drop hard QA
  // from 195 to 143.
  it('never leaves a design worse than the same design prepared without the spec', () => {
    const blocks = fixture.copy.ckb;
    const copy = { text: Object.fromEntries(blocks.map((b, i) => [i, b])) };
    const canvas = { width: 1080, height: 1350, logoAspect: 1, palette: reference.palette, ornament: resolveOrnamentSettings({}) };
    // A layout whose logo sits where the spec wants the button, and whose title cannot grow.
    const cramped = JSON.parse(JSON.stringify(fixture.layouts[0])) as StudioLayoutV2;
    cramped.logo = { x: 65, y: 1100, width: 150, height: 150 };
    for (const t of cramped.text) t.rtl = true;
    const plain = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(cramped)), copy, canvas);
    const styled = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(cramped)), copy, { ...canvas, style: fixture.spec });
    expect(layoutDefectCount(styled, copy)).toBeLessThanOrEqual(layoutDefectCount(plain, copy));
  });

  it('keeps the three candidates of a request distinct', () => {
    const blocks = fixture.copy.en;
    const copy = { text: Object.fromEntries(blocks.map((b, i) => [i, b])) };
    const prepared = [0, 1, 2].map((k) => {
      const raw = JSON.parse(JSON.stringify(fixture.layouts[k])) as StudioLayoutV2;
      for (const t of raw.text) if (/Amiri|Noto Sans Arabic/.test(t.fontFamily)) t.fontFamily = 'Playfair Display';
      return prepareGeneratedLayoutV3(raw, copy, {
        width: 1080, height: 1350, logoAspect: 1, palette: reference.palette,
        ornament: resolveOrnamentSettings({}), style: fixture.spec,
      });
    });
    expect(checkCandidateSetDegeneracy(prepared).isDegenerate).toBe(false);
  });
});
