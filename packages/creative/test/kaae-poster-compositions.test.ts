import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa, studioReferenceFromRaw, type HardQaContext } from '../src/studio/hard-qa.js';
import { composeGrammarLayout, guidelineDeviations, guidelineFidelityRule, pageGrammarFromRaw, type PageGrammar } from '../src/studio/page-grammar.js';
import { admitPageGrammarFromReference } from '../src/studio/page-grammar-admission.js';
import { composePosterLayout, negativeSpaceOf, POSTER_VARIANTS, type PosterVariant } from '../src/studio/poster-grammar.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { buildPairwiseJudgeSystemPrompt, MAX_JUDGE_HOUSE_RULE_CHARS, POSTER_IMPACT_CRITERIA } from '../src/studio/pairwise-judge-v3.js';
import { ExemplarRetrievalIndex } from '../src/studio/exemplar-retrieval.js';
import { measureDesignV3 } from '../src/studio/pipeline-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { createHash } from 'node:crypto';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { checkCanvaPptx } from '../../qa/src/canva-pptx-check.js';

/**
 * ADR-262 (design review, 2026-10-02): KAAE's shipped text-only designs were the guideline's document
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
        expect(ns, `${variant} negative space`).toBeLessThanOrEqual(0.65);
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
    expect(l.shapes.find((s) => s.primitive === 'title_bar')!.width).toBe(Math.round(0.16 * 1080));
    expect(l.ornaments?.[0]).toMatchObject({ kind: 'sunburst', color: '#4A90E2', opacity: 0.35 });
    expect(l.ornaments![0].width).toBeGreaterThanOrEqual(Math.round(0.33 * 1080));
    // The call to action on a gold pill, in Midnight.
    const cta = l.text.find((t) => t.role === 'cta')!;
    expect(cta).toMatchObject({ color: '#0A1628', bold: true });
    expect(l.shapes.some((s) => s.role === 'panel' && s.color === '#F7B500' && cta.x >= s.x && cta.x + cta.width <= s.x + s.width)).toBe(true);
  });

  it('cream: the cream ground, a Royal title, the details on a Royal card with a Sun first line, a gold sunburst', () => {
    const [b] = BRIEFS;
    const l = poster(b.lines, b.roles, 'cream');
    expect(l.background.color).toBe('#FDF8F3');
    expect(l.text.find((t) => t.role === 'title')!.color).toBe('#1E3A5F');
    expect(l.shapes.some((s) => s.primitive === 'card' && s.color === '#1E3A5F')).toBe(true);
    expect(l.text.find((t) => t.role === 'date')).toMatchObject({ color: '#FFD700', fontFamily: 'Crimson Pro' });
    expect(l.ornaments?.[0]).toMatchObject({ kind: 'sunburst', color: '#F7B500' });
  });

  it('band: the white page with a full-width gradient band holding the title, the bar bridging its edge, the foot rule', () => {
    const [b] = BRIEFS;
    const l = poster(b.lines, b.roles, 'band');
    expect(l.background.color).toBe('#FFFFFF');
    const title = l.text.find((t) => t.role === 'title')!;
    const band = l.shapes.find((s) => s.role === 'panel' && s.width === 1080 && s.gradient)!;
    expect(band.x).toBe(0);
    expect(title.y).toBeGreaterThanOrEqual(band.y);
    expect(title.y + title.height).toBeLessThanOrEqual(band.y + band.height);
    const bar = l.shapes.find((s) => s.primitive === 'title_bar')!;
    expect(bar.y).toBeLessThan(band.y + band.height);
    expect(bar.y + bar.height).toBeGreaterThan(band.y + band.height);
    expect(l.shapes.some((s) => s.primitive === 'foot_rule')).toBe(true);
  });

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
    expect(rule).toMatch(/a poster: the bar/);
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
