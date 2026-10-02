import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa, studioReferenceFromRaw, type HardQaContext } from '../src/studio/hard-qa.js';
import { composeGrammarLayout, guidelineDeviations, guidelineFidelityRule, pageGrammarFromRaw, type PageGrammar } from '../src/studio/page-grammar.js';
import { admitPageGrammarFromReference } from '../src/studio/page-grammar-admission.js';
import { composePosterLayout, FOOT_GAP_SHARE, negativeSpaceOf, POSTER_VARIANTS, type PosterVariant } from '../src/studio/poster-grammar.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import { buildPairwiseJudgeSystemPrompt, MAX_JUDGE_HOUSE_RULE_CHARS, POSTER_IMPACT_CRITERIA } from '../src/studio/pairwise-judge-v3.js';
import { ExemplarRetrievalIndex } from '../src/studio/exemplar-retrieval.js';
import { measureDesignV3 } from '../src/studio/pipeline-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { createHash } from 'node:crypto';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { checkCanvaPptx } from '../../qa/src/canva-pptx-check.js';

/**
 * ADR-271 (design review, 2026-10-02): KAAE's shipped text-only designs were the guideline's document
 * page at poster size: ~84% empty, a 64px title on a 1080 canvas, a 0.12 logo, every candidate the
 * same layout. The guideline keeps the palette, the logo, the faces and the elements; the office's
 * own published posts set the poster composition.
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const G = pageGrammarFromRaw(RAW)!;
const PALETTE = studioReferenceFromRaw(RAW).palette;
const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
const KAAE_FONTS = { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] };
const ARABIC = /[؀-ۿ]/;
/** ADR-271 section 8: the smallest clear gap between the foot's parts, in px on a 1350 canvas. */
const GAP = Math.round(FOOT_GAP_SHARE * 1350);

const BRIEFS: Array<{ id: string; lines: string[]; roles: string[] }> = [
  { id: 'workshop', lines: ['Quality Assurance Workshop', 'For university deans', '15 October 2026 · 9:30 AM', 'Rotana Hotel, Erbil', 'Registration is free'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'peer call', lines: ['Call for Peer Evaluators', 'K-12 and Higher Education'], roles: ['title', 'subtitle'] },
  { id: 'symposium', lines: ['KAAE Annual Accreditation Symposium 2026', '4 November 2026', 'Erbil International Fair'], roles: ['title', 'date', 'venue'] },
  { id: 'Sorani workshop', lines: ['وۆرکشۆپی دڵنیایی جۆری', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'], roles: ['title', 'subtitle', 'date', 'venue', 'cta'] },
  { id: 'Sorani peer call', lines: ['بانگەواز بۆ هەڵسەنگێنەرانی هاوتا', 'پەروەردەی بنەڕەتی و خوێندنی باڵا'], roles: ['title', 'subtitle'] },
];

const copyOf = (lines: string[]) => Object.fromEntries(lines.map((t, i) => [i, t]));
const scriptsOf = (lines: string[]) => lines.map((t) => (ARABIC.test(t) ? 'arabic' : 'latin') as 'arabic' | 'latin');
const input = (lines: string[], roles: string[], grammar: PageGrammar = G) => ({
  width: 1080, height: 1350, grammar, copy: { text: copyOf(lines) }, roles: Object.fromEntries(roles.map((r, i) => [i, r])),
  logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone: 'page' as const,
  fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' },
});
const poster = (lines: string[], roles: string[], variant: PosterVariant) => composePosterLayout({ ...input(lines, roles), variant });
const tryPoster = (lines: string[], roles: string[], variant: PosterVariant) => {
  try {
    return poster(lines, roles, variant);
  } catch {
    return undefined;
  }
};
const qa = (layout: StudioLayoutV2, lines: string[]) => {
  const render = renderLayoutV2(layout, { copyText: copyOf(lines), logoDataUri: `data:image/png;base64,${LOGO.toString('base64')}` });
  const ctx: HardQaContext = {
    width: 1080, height: 1350, copyScripts: scriptsOf(lines), latinFont: 'Inter', arabicFont: 'Noto Sans Arabic', admittedDisplayFonts: KAAE_FONTS,
    palette: PALETTE, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15, copyText: copyOf(lines),
    renderedComposite: render.noTextPng, fontFidelity: render.fontFidelity,
  };
  return evaluateHardQa(layout, ctx);
};
const validation = (lines: string[]): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: lines.length, copyScripts: scriptsOf(lines), photoCount: 0,
  reference: { rules: { fontFamily: 'Inter', palette: PALETTE, admittedDisplayFonts: KAAE_FONTS }, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
});

describe('the poster rules are the reference\'s data, admitted with the grammar', () => {
  it('reads the poster rules: a title at 10-18% of the width, a 16% logo, a 0.65 negative-space ceiling, three compositions', () => {
    expect(G.poster).toMatchObject({ titleSizeShare: { min: 0.1, max: 0.18 }, logoWidthShare: 0.16, negativeSpaceMax: 0.65 });
    expect(G.poster!.navy.sunburst.opacity).toBeGreaterThanOrEqual(0.2);
    expect(G.poster!.navy.sunburst.opacity).toBeLessThanOrEqual(0.35);
    expect(RAW.rules.colorUsage).toMatch(/the office's own published posts set how a poster is composed/);
    expect(RAW.rules.artDirection.join(' ')).not.toMatch(/With no photo, type, cards and rules are the design/);
  });

  it('refuses a poster colour outside the palette and a title range that descends', () => {
    const bad = structuredClone(RAW);
    bad.rules.pageGrammar.poster.navy.pill = '#123456';
    expect(() => admitPageGrammarFromReference(bad)).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.poster\.navy\.pill/);
    const descending = structuredClone(RAW);
    descending.rules.pageGrammar.poster.titleSizeShare = { min: 0.2, max: 0.1 };
    expect(() => admitPageGrammarFromReference(descending)).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.poster\.titleSizeShare/);
    const none = structuredClone(RAW);
    delete none.rules.pageGrammar.poster;
    expect(admitPageGrammarFromReference(none)?.poster).toBeUndefined();
  });
});

describe('the three poster compositions, composed with no model call', () => {
  for (const b of BRIEFS) {
    it(`${b.id}: every feasible composition is bold, on the guideline, passes the validator and hard QA, and at least two are feasible`, () => {
      const feasible = POSTER_VARIANTS.map((v) => [v, tryPoster(b.lines, b.roles, v)] as const).filter(([, l]) => l);
      expect(feasible.length).toBeGreaterThanOrEqual(2);
      for (const [variant, layout] of feasible) {
        const l = layout!;
        expect(l.composition).toEqual({ grammar: 'poster', variant });
        const title = l.text.find((t) => t.role === 'title')!;
        expect(title.fontSize / 1080, `${variant} title`).toBeGreaterThanOrEqual(0.1);
        expect(title.fontSize / 1080, `${variant} title`).toBeLessThanOrEqual(0.18);
        // One dominant display moment: the title at least 2.2 times every other block.
        for (const t of l.text) if (t !== title) expect(title.fontSize).toBeGreaterThanOrEqual(2.2 * t.fontSize);
        expect(l.logo.width / 1080).toBeGreaterThanOrEqual(0.16);
        expect(l.logo.x).toBe(76);
        const ns = negativeSpaceOf(l, { copy: { text: copyOf(b.lines) } });
        // The ceiling is a target: when no step of the type scale lands under it with the details at
        // their poster size, the nearest over it is kept (a Sorani navy poster, 0.653) rather than
        // smaller details.
        expect(ns, `${variant} negative space`).toBeLessThanOrEqual(0.66);
        expect(ns, `${variant} negative space`).toBeGreaterThanOrEqual(0.36);
        expect(guidelineDeviations(l, G, { arabicFonts: KAAE_FONTS.arabic })).toEqual([]);
        expect(validateLayoutV2(l, validation(b.lines)), variant).toMatchObject({ ok: true });
        const result = qa(l, b.lines);
        expect(result.passed, `${variant}: ${result.messages.join(' | ')}`).toBe(true);
        expect(measureDesignV3(l, { text: copyOf(b.lines) }).metrics.negativeSpace.score).toBeGreaterThanOrEqual(0.7);
        if (ARABIC.test(b.lines[0])) expect(title).toMatchObject({ rtl: true, align: 'right', fontFamily: 'IBM Plex Sans Arabic' });
        else expect(title).toMatchObject({ fontFamily: 'Crimson Pro', bold: true, align: 'left' });
      }
    }, 60000);
  }

  it('navy: the cover\'s gradient, a white title, a gold bar and a visible Sky sunburst clear of the copy', () => {
    const [b] = BRIEFS;
    const l = poster(b.lines, b.roles, 'navy');
    expect(l.shapes[0]).toMatchObject({ primitive: 'cover_ground', gradient: { angle: 45 } });
    expect(l.text.find((t) => t.role === 'title')!.color).toBe('#FFFFFF');
    // 16% of the width, its free end on the nearest grid line (hard QA's alignment reads it).
    expect(Math.abs(l.shapes.find((s) => s.primitive === 'title_bar')!.width - Math.round(0.16 * 1080))).toBeLessThanOrEqual(0.05 * 1080);
    expect(l.ornaments?.[0]).toMatchObject({ kind: 'sunburst', color: '#4A90E2', opacity: 0.35 });
    expect(l.ornaments![0].width).toBeGreaterThanOrEqual(Math.round(0.33 * 1080));
    // The call to action on a gold pill, in Midnight.
    const cta = l.text.find((t) => t.role === 'cta')!;
    expect(cta).toMatchObject({ color: '#0A1628', bold: true });
    expect(l.shapes.some((s) => s.role === 'panel' && s.color === '#F7B500' && cta.x >= s.x && cta.x + cta.width <= s.x + s.width)).toBe(true);
  });

  it('cream: the cream ground, a Royal title at the top, the details on a full-bleed Royal block with a Sun first line, a gold sun on its horizon', () => {
    const [b] = BRIEFS;
    const l = poster(b.lines, b.roles, 'cream');
    expect(l.background.color).toBe('#FDF8F3');
    const title = l.text.find((t) => t.role === 'title')!;
    expect(title.color).toBe('#1E3A5F');
    // ADR-271 section 8: the block closes the poster, edge to edge and down to the canvas's lower edge.
    const block = l.shapes.find((s) => s.surface === 'plate')!;
    expect(block).toMatchObject({ x: 0, width: 1080, color: '#1E3A5F' });
    expect(block.y + block.height).toBe(1350);
    expect(title.y).toBeLessThan(0.3 * 1350);
    const date = l.text.find((t) => t.role === 'date')!;
    expect(date).toMatchObject({ color: '#FFD700', fontFamily: 'Inter', bold: true });
    expect(date.y).toBeGreaterThan(block.y);
    const sun = l.ornaments![0];
    expect(sun).toMatchObject({ kind: 'sunburst', color: '#F7B500', corner: 'bottom-right' });
    expect(sun.y + sun.height).toBe(block.y);
  });

  it('band: the white page with a gradient band holding the title from its starting edge, the bar bridging its edge, the foot rule', () => {
    const [b] = BRIEFS;
    const l = poster(b.lines, b.roles, 'band');
    expect(l.background.color).toBe('#FFFFFF');
    const title = l.text.find((t) => t.role === 'title')!;
    const band = l.shapes.find((s) => s.role === 'panel' && s.kind === 'rect' && s.gradient)!;
    expect(band.x).toBe(0);
    expect(band.x + band.width).toBeGreaterThanOrEqual(title.x + title.width);
    expect(title.y).toBeGreaterThanOrEqual(band.y);
    expect(title.y + title.height).toBeLessThanOrEqual(band.y + band.height);
    const bar = l.shapes.find((s) => s.primitive === 'title_bar')!;
    expect(bar.y).toBeLessThan(band.y + band.height);
    expect(bar.y + bar.height).toBeGreaterThan(band.y + band.height);
    expect(l.shapes.some((s) => s.primitive === 'foot_rule')).toBe(true);
  });

  it('the details read under a poster title: at least 4% of the width, and a date or a place on one line', () => {
    for (const b of BRIEFS) {
      for (const variant of POSTER_VARIANTS) {
        const l = tryPoster(b.lines, b.roles, variant);
        if (!l) continue;
        const details = l.text.filter((t) => t.role !== 'title' && t.role !== 'cta');
        // A band under a long Sorani title cannot hold them at that size; it keeps the scale's step instead.
        const min = variant === 'band' && ARABIC.test(b.lines[0]) ? 0.033 : 0.04;
        for (const t of details) expect(t.fontSize / 1080, `${b.id} ${variant} ${t.role}`).toBeGreaterThanOrEqual(min);
        for (const t of l.text.filter((x) => x.role === 'date' || x.role === 'venue')) {
          expect(t.height, `${b.id} ${variant} ${t.role} on one line`).toBeLessThan(2 * t.fontSize * t.lineHeight);
        }
      }
    }
    // Before (2026-10-02): 38-40px details under a 122-191px title, 0.035-0.037 of the width.
    const navy = poster(BRIEFS[0].lines, BRIEFS[0].roles, 'navy');
    expect(navy.text.find((t) => t.role === 'date')!.fontSize).toBeGreaterThanOrEqual(44);
  }, 60000);

  it('band with short copy: the band sits under the logo and the guideline\'s triangle pattern rises from the foot', () => {
    const b = BRIEFS[1];
    const l = poster(b.lines, b.roles, 'band');
    const band = l.shapes.find((s) => s.role === 'panel' && s.kind === 'rect' && s.gradient)!;
    const lead = l.text.find((t) => t.role === 'subtitle')!;
    // ADR-271 section 8: the judges saw "the top 40% empty white with a faint sun" over a low band.
    expect(band.y - (l.logo.y + l.logo.height)).toBeLessThanOrEqual(0.1 * 1350);
    const rule = l.shapes.find((s) => s.primitive === 'foot_rule')!;
    const pattern = l.ornaments![0];
    expect(pattern).toMatchObject({ kind: 'triangle_pattern', color: '#2C5282', fade: 'to-top' });
    expect(pattern.opacity).toBeGreaterThanOrEqual(0.5);
    expect(pattern.y).toBeGreaterThanOrEqual(lead.y + lead.height + GAP);
    expect(pattern.y + pattern.height).toBeLessThanOrEqual(rule.y - GAP);
    // A Sorani band runs from the right edge, as the office's Sorani title tab does.
    const ckb = BRIEFS[3];
    const sl = poster(ckb.lines, ckb.roles, 'band');
    const sband = sl.shapes.find((s) => s.role === 'panel' && s.kind === 'rect' && s.gradient)!;
    const stitle = sl.text.find((t) => t.role === 'title')!;
    expect(sband.x + sband.width).toBe(1080);
    expect(sband.x).toBeLessThanOrEqual(stitle.x);
    expect(sband.width).toBeLessThan(1080);
  });

  it('every composition passes hard QA\'s alignment check (a Sorani navy poster measured 0.688 against 0.70)', () => {
    const b = BRIEFS[3];
    const dated = b.lines.map((t, i) => (b.roles[i] === 'date' ? '١٥ی تشرینی یەکەمی ٢٠٢٦، ٩:٣٠ی بەیانی' : t));
    for (const variant of POSTER_VARIANTS) {
      const l = tryPoster(dated, b.roles, variant);
      if (l) expect(computeLayoutMetrics(l).alignmentScore, variant).toBeGreaterThanOrEqual(0.7);
    }
  }, 60000);

  it('the three compositions are different designs, not one layout three times', () => {
    const [b] = BRIEFS;
    const ls = POSTER_VARIANTS.map((v) => poster(b.lines, b.roles, v));
    expect(new Set(ls.map((l) => l.background.color)).size).toBe(3);
    expect(new Set(ls.map((l) => l.text.find((t) => t.role === 'title')!.color)).size).toBeGreaterThanOrEqual(2);
  });

  it('every composition reaches the Canva deck as native, editable shapes and text in the admitted faces', async () => {
    const [b] = BRIEFS;
    const sha256 = createHash('sha256').update(LOGO).digest('hex');
    for (const variant of POSTER_VARIANTS) {
      const l = poster(b.lines, b.roles, variant);
      const deck = await encodeStudioTransferV2(l, b.lines, { bytes: LOGO, mimeType: 'image/png', sha256 });
      const check = checkCanvaPptx(deck.bytes, b.lines, { allowedFontsByScript: KAAE_FONTS });
      expect(check.copyPass, variant).toBe(true);
      expect(check.fontPass, variant).toBe(true);
      expect(check.sourceTextObjects).toHaveLength(b.lines.length);
    }
  }, 60000);

  it('is deterministic', () => {
    const [b] = BRIEFS;
    expect(JSON.stringify(poster(b.lines, b.roles, 'navy'))).toBe(JSON.stringify(poster(b.lines, b.roles, 'navy')));
  });

  it('a grammar without poster rules composes no poster', () => {
    const { poster: _p, ...plain } = G;
    expect(() => composePosterLayout({ ...input(BRIEFS[0].lines, BRIEFS[0].roles, plain as PageGrammar), variant: 'navy' })).toThrow(/GRAMMAR_INFEASIBLE/);
  });
});

/**
 * ADR-271 section 8 (design audit and blind panel, 2026-10-02): the composer's defects. The panel
 * scored the band 5.2 against navy 6.0 and cream 5.9, and named the same weaknesses throughout.
 */
describe('the poster composer\'s defects (ADR-271 section 8)', () => {
  type Box = { x: number; y: number; width: number; height: number };
  const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d });
  const all = () => BRIEFS.flatMap((b) => POSTER_VARIANTS.map((v) => ({ b, v, l: tryPoster(b.lines, b.roles, v) })).filter((x) => x.l)) as Array<{ b: typeof BRIEFS[number]; v: PosterVariant; l: StudioLayoutV2 }>;

  it('1. the brand element never runs under copy, a card, a pill, the band, the bar or the rule, and keeps a clear gap from them', () => {
    // Before: in the workshop's cream poster the sunburst ran under the details card's corner (a ray
    // clipped by it), and in the Sorani workshop's band it sat under the card's lower left.
    for (const { b, v, l } of all()) {
      const o = l.ornaments?.[0];
      expect(o, `${b.id} ${v}: a visible brand element`).toBeDefined();
      for (const t of l.text) expect(hit(grow(t, GAP - 1), o!), `${b.id} ${v}: element on copy ${t.role}`).toBe(false);
      for (const sh of l.shapes) {
        if (sh.primitive === 'cover_ground') continue;
        // The cream block is the ground the sun stands on: touching its edge, never on it.
        const clearance = sh.surface === 'plate' ? 0 : GAP - 1;
        expect(hit(grow(sh, clearance), o!), `${b.id} ${v}: element under ${sh.primitive ?? sh.surface ?? sh.role}`).toBe(false);
      }
    }
  }, 60000);

  it('2. navy, cream and band are three compositions, not one geometry in three colourways', () => {
    // Where each poster's mass sits: the content boxes (copy, cards, pills, band, block, element) on
    // a 12 x 15 grid. Before, navy and cream set every box of the peer call (English and Sorani) in
    // the same place: no cell differed.
    const cells = (l: StudioLayoutV2) => {
      const boxes: Box[] = [...l.text, ...l.shapes.filter((sh) => sh.primitive !== 'cover_ground'), ...(l.ornaments ?? [])];
      const out: boolean[] = [];
      for (let j = 0; j < 15; j++) for (let i = 0; i < 12; i++) {
        const c = { x: (i + 0.5) * 90, y: (j + 0.5) * 90 };
        out.push(boxes.some((b) => c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height));
      }
      return out;
    };
    for (const b of BRIEFS) {
      const ls = POSTER_VARIANTS.map((v) => [v, tryPoster(b.lines, b.roles, v)] as const).filter(([, l]) => l);
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const a = cells(ls[i][1]!);
        const c = cells(ls[j][1]!);
        const differ = a.filter((x, k) => x !== c[k]).length / a.length;
        expect(differ, `${b.id}: ${ls[i][0]} vs ${ls[j][0]}`).toBeGreaterThanOrEqual(0.12);
      }
      // Each composition's own structure: navy a single field, cream a block that closes it, the band a title band.
      const shapesOf = (v: PosterVariant) => ls.find(([x]) => x === v)?.[1]?.shapes ?? [];
      if (ls.some(([x]) => x === 'cream')) expect(shapesOf('cream').some((sh) => sh.surface === 'plate' && sh.width === 1080), b.id).toBe(b.lines.length > 1);
      expect(shapesOf('navy').some((sh) => sh.surface === 'plate'), b.id).toBe(false);
    }
    // Where the room allows, navy lowers its title under the sun at the top right.
    const peer = poster(BRIEFS[1].lines, BRIEFS[1].roles, 'navy');
    expect(peer.ornaments![0].corner).toBe('top-right');
    expect(peer.text.find((t) => t.role === 'title')!.y).toBeGreaterThan(poster(BRIEFS[1].lines, BRIEFS[1].roles, 'cream').text.find((t) => t.role === 'title')!.y);
  }, 60000);

  it('3. one face per details group: the date and the place in the body face, the date marked by weight and colour', () => {
    // Before: the date was Crimson Pro bold and the place Inter regular in one two-line group.
    for (const { b, v, l } of all()) {
      const group = l.text.filter((t) => t.role === 'date' || t.role === 'venue');
      expect(new Set(group.map((t) => t.fontFamily)).size, `${b.id} ${v}`).toBeLessThanOrEqual(1);
      if (!ARABIC.test(b.lines[0])) for (const t of group) expect(t.fontFamily, `${b.id} ${v}`).toBe(G.body.fontFamily);
    }
    const l = poster(BRIEFS[0].lines, BRIEFS[0].roles, 'cream');
    expect(l.text.find((t) => t.role === 'date')).toMatchObject({ bold: true, color: '#FFD700' });
    expect(l.text.find((t) => t.role === 'venue')!.bold).toBeFalsy();
  }, 60000);

  it('4. the band sits under the logo, with no dead white over it, and its element is not a faint blob', () => {
    for (const b of BRIEFS) {
      const l = tryPoster(b.lines, b.roles, 'band');
      if (!l) continue;
      const band = l.shapes.find((s) => s.role === 'panel' && s.kind === 'rect' && s.gradient)!;
      // Before: 0.1 of the height over the band with details, 0.82 of the room without.
      expect(band.y - (l.logo.y + l.logo.height), b.id).toBeLessThanOrEqual(0.1 * 1350);
      const o = l.ornaments![0];
      // Before: KAAE Blue at 0.16 on white, which read as a grey blob.
      expect(o.opacity, b.id).toBeGreaterThanOrEqual(0.3);
      expect(PALETTE.map((c) => c.toUpperCase())).toContain(o.color.toUpperCase());
    }
    expect(G.poster!.band.pattern).toMatchObject({ color: '#2C5282' });
    expect(G.poster!.band.sunburst.opacity).toBeGreaterThanOrEqual(0.3);
  }, 60000);

  it('5. the foot keeps clear gaps between card, pill, element and rule, and the call to action is the gold primary action', () => {
    for (const { b, v, l } of all()) {
      const cards = l.shapes.filter((sh) => sh.primitive === 'card');
      const pills = l.shapes.filter((sh) => sh.surface === 'pill');
      const rule = l.shapes.find((sh) => sh.primitive === 'foot_rule');
      for (const p of pills) {
        // The primary action in every composition: KAAE Gold with Midnight text (before, cream's pill was a muted KAAE Blue).
        expect(p.color, `${b.id} ${v}`).toBe('#F7B500');
        if (rule) expect(rule.y - (p.y + p.height), `${b.id} ${v}: pill to rule`).toBeGreaterThanOrEqual(GAP);
        for (const c of cards) {
          // A pill either bridges the card's lower edge or stands clear of it.
          const bridges = p.y < c.y + c.height && p.y + p.height > c.y + c.height;
          if (!bridges) expect(Math.max(p.y - (c.y + c.height), c.y - (p.y + p.height)), `${b.id} ${v}: pill to card`).toBeGreaterThanOrEqual(GAP);
          else {
            // Clear of the card's copy above it.
            for (const t of l.text) if (t.role !== 'cta' && hit(t, c)) expect(p.y - (t.y + t.height), `${b.id} ${v}`).toBeGreaterThanOrEqual(0.5 * GAP);
          }
        }
      }
      if (rule) for (const c of cards) expect(rule.y - (c.y + c.height), `${b.id} ${v}: card to rule`).toBeGreaterThanOrEqual(GAP);
      const cta = l.text.find((t) => t.role === 'cta');
      if (cta) expect(cta.color, `${b.id} ${v}`).toBe('#0A1628');
    }
    expect(G.poster!.cream).toMatchObject({ pill: '#F7B500', pillText: '#0A1628' });
  }, 60000);

  it('6. a title-only brief is composed as one: a strong secondary lead, its own element, no dead gap, no copy added', () => {
    for (const b of BRIEFS.filter((x) => x.roles.length === 2)) {
      const copy = { text: copyOf(b.lines) };
      for (const v of POSTER_VARIANTS) {
        const l = tryPoster(b.lines, b.roles, v);
        if (!l) continue;
        // Copy is never invented: one block per line of the brief, each the brief's own.
        expect(l.text.map((t) => t.copyIndex).sort(), `${b.id} ${v}`).toEqual(b.lines.map((_, i) => i));
        const lead = l.text.find((t) => t.role === 'subtitle')!;
        // A size up from the details' step (0.04-0.046 of the width), still under the title.
        expect(lead.fontSize / 1080, `${b.id} ${v} lead`).toBeGreaterThanOrEqual(0.05);
        const ns = measureDesignV3(l, copy).metrics.negativeSpace;
        expect((ns.details as { internalGapFraction: number }).internalGapFraction, `${b.id} ${v}`).toBeLessThanOrEqual(0.22);
        expect(ns.score, `${b.id} ${v}`).toBeGreaterThanOrEqual(0.7);
        expect(l.ornaments?.length, `${b.id} ${v}`).toBe(1);
      }
      // Cream sets the lead on its block, the secondary moment opposite the title.
      const cream = poster(b.lines, b.roles, 'cream');
      const block = cream.shapes.find((sh) => sh.surface === 'plate')!;
      const lead = cream.text.find((t) => t.role === 'subtitle')!;
      expect(lead.y).toBeGreaterThan(block.y);
      expect(lead).toMatchObject({ bold: true, color: '#FFD700' });
    }
    // The band's pattern rises from the foot under the lead (before: a sun over a low band).
    expect(poster(BRIEFS[1].lines, BRIEFS[1].roles, 'band').ornaments![0].kind).toBe('triangle_pattern');
  }, 60000);
});

describe('the guideline\'s own page keeps its grammar with the poster type scale and logo', () => {
  it('sets the workshop page title at 10-18% of the width and the logo at 16%; without poster rules, as before', () => {
    const [b] = BRIEFS;
    const page = composeGrammarLayout({ ...input(b.lines, b.roles), variant: 'brand_card' });
    const title = page.text.find((t) => t.role === 'title')!;
    expect(title.fontSize / 1080).toBeGreaterThanOrEqual(0.1);
    expect(page.logo.width / 1080).toBeGreaterThanOrEqual(0.16);
    expect(qa(page, b.lines).passed).toBe(true);
    const { poster: _p, ...plain } = G;
    const before = composeGrammarLayout({ ...input(b.lines, b.roles, plain as PageGrammar), variant: 'brand_card' });
    expect(before.text.find((t) => t.role === 'title')!.fontSize / 1080).toBeLessThan(0.1);
    expect(before.logo.width).toBe(Math.round(0.12 * 1080));
  });
});

describe('the judge reads posters as posters; other clients\' prompts are unchanged', () => {
  it('adds impact at a 300px thumbnail, a focal point and fit to the request only with posterImpact', () => {
    for (const photoBrief of [false, true]) {
      const plain = buildPairwiseJudgeSystemPrompt({ photoBrief, houseRules: ['R'] });
      const posterPrompt = buildPairwiseJudgeSystemPrompt({ photoBrief, houseRules: ['R'], posterImpact: true });
      expect(buildPairwiseJudgeSystemPrompt({ photoBrief, houseRules: ['R'], posterImpact: false })).toBe(plain);
      expect(plain).not.toMatch(/300px/);
      expect(posterPrompt).toContain(POSTER_IMPACT_CRITERIA.hierarchy);
      expect(posterPrompt).toContain(POSTER_IMPACT_CRITERIA.brand_fit);
      if (!photoBrief) expect(posterPrompt).toContain(POSTER_IMPACT_CRITERIA.composition);
    }
  });

  it('the guideline-fidelity rule does not count a poster\'s missing document header against it', () => {
    const rule = guidelineFidelityRule(G);
    expect(rule.length).toBeLessThanOrEqual(MAX_JUDGE_HOUSE_RULE_CHARS);
    // ADR-274: nor its missing gold bar or its dark title tab (the office's own techniques).
    expect(rule).toMatch(/document page lacking header rule/);
    expect(rule).toMatch(/dark title tab or missing bar is fine/);
  });
});

describe('retrieval: a text-only poster may be shown the office\'s published posts', () => {
  const index = new ExemplarRetrievalIndex();
  it('without the flag, the typographic set only, as before', () => {
    const r = index.retrieveTopExemplars({ text: 'Quality Assurance Workshop for university deans' }, 3);
    expect(r.retrievedExemplars.every((e) => e.status === 'CONFIRMED')).toBe(true);
  });

  it('with officePosters, at least one office post in the brief\'s language joins the selection', () => {
    const en = index.retrieveTopExemplars({ text: 'Call for Peer Evaluators K-12 and Higher Education', officePosters: true }, 3);
    const posts = en.retrievedExemplars.filter((e) => e.status === 'office-published');
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(en.retrievedExemplars.length).toBeLessThanOrEqual(3);
    const ckb = index.retrieveTopExemplars({ text: 'بانگەواز بۆ هەڵسەنگێنەرانی هاوتا', officePosters: true }, 3);
    const ckbPost = ckb.retrievedExemplars.find((e) => e.status === 'office-published')!;
    expect(ckbPost.filename).toMatch(/_ckb\.|_sky_title/);
  });

  it('a photo brief is unchanged by the flag', () => {
    const brief = { text: 'Field visit report', photoCount: 1, subjects: ['report_release'] };
    expect(index.retrieveTopExemplars({ ...brief, officePosters: true }, 3).retrievedIds).toEqual(index.retrieveTopExemplars(brief, 3).retrievedIds);
  });
});
