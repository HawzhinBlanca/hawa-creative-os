import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { PNG } from 'pngjs';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa, studioReferenceFromRaw, logoRuleDefects, type HardQaContext } from '../src/studio/hard-qa.js';
import { solveRecipe, brandTones, type ArtDirectionChoice, type SolverPhoto } from '../src/studio/art-direction/solver.js';
import { solveConcepts } from '../src/studio/art-direction/generate.js';
import { artDirectionPrior } from '../src/studio/art-direction/prior.js';
import { tonePreferenceFromWords, resolveSurfaceTone, toneGroundHex } from '../src/studio/art-direction/tone.js';
import { nearestGroundColour, prepareGeneratedLayoutV3 } from '../src/studio/pipeline-v3.js';
import { buildLayoutV3SystemPrompt, buildLayoutV3UserPrompt, LAYOUT_V3_JSON_SCHEMA } from '../src/studio/layout-generator-v3.js';
import { calculateLuminanceContrastRatio, hexToLuminance, declaredTextContrast } from '../src/studio/composite-contrast.js';
import {
  pageGrammarFromRaw, composeGrammarLayout, headerPrimitives, titleBarPrimitive, cardPrimitives, footRulePrimitive, coverGroundPrimitive,
  conformToPageGrammar, pageGrammarPrompt,
} from '../src/studio/page-grammar.js';
import { BRAND_ELEMENT_ASSETS, ornamentSvgDocument, sunburstSvg, trianglePatternSvg } from '../src/studio/brand-elements.js';
import { gradientColourAt, gradientOoxml } from '../src/studio/shape-gradient.js';
import { admittedFontFaces, fontFaceSupports, fontFileFor, probeFontFidelity, renderLayoutV2, renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { logoClearZone } from '../src/studio/house-rules.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * ADR-238 (owner, 2026-10-01): KAAE's designs follow its 2025 guideline, "Brand Guidelines —
 * Excellence Edition" (KAAE_Guidelines4.pdf, kept out of git; printed page numbers cited). It replaces
 * the older brand book ADR-236 applied (withdrawn by the owner). ADR-236's light-first logic stays.
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const REF = studioReferenceFromRaw(RAW);
const PALETTE = REF.palette;
const G = pageGrammarFromRaw(RAW)!;
const [WHITE, CREAM, BLUE, GOLD, MIDNIGHT, ROYAL, OCEAN, SKY, SUN] = ['#FFFFFF', '#FDF8F3', '#4770A3', '#F7B500', '#0A1628', '#1E3A5F', '#2C5282', '#4A90E2', '#FFD700'];
const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
const OWNER = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward education quality improvement.' };
const SLOTS: ArtDirectionChoice['slots'] = [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }];
const WORKSHOP = ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'];
const WORKSHOP_ROLES = ['title', 'subtitle', 'date', 'venue', 'cta'];
const COVER = ['Accreditation Cycle 2027', 'Applications now open', 'From 1 November 2026', 'kaae.org'];
const COVER_ROLES = ['title', 'subtitle', 'date', 'footer'];
const KAAE_FONTS = { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] };
const photo = (quietLuminance: number): SolverPhoto => ({ photoIndex: 0, width: 2048, height: 1536, salient: { x: 0.5, y: 0.45 }, quiet: 'top', quietLuminance });
const context = (copyCount = 3, photoCount = 1): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount, copyScripts: Array(copyCount).fill('latin'), photoCount,
  photoSelection: { mode: 'choose', minimum: 1 },
  reference: { rules: { fontFamily: 'Inter', palette: PALETTE, admittedDisplayFonts: KAAE_FONTS }, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
});
const solve = (recipe: ArtDirectionChoice['recipe'], params: ArtDirectionChoice['params'], p = photo(0.8), grammar = false) => solveRecipe({
  width: 1080, height: 1350, copy: { text: OWNER }, photos: [p], palette: PALETTE, logoAspect: 1,
  choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params },
  ...(grammar ? { grammar: G, logoClearSpaceShare: 0.15, logoMinimumWidthPx: 80 } : {}),
});
const contrast = (a: string, b: string) => calculateLuminanceContrastRatio(hexToLuminance(a), hexToLuminance(b));
const copyOf = (lines: string[]) => Object.fromEntries(lines.map((t, i) => [i, t]));
const compose = (lines: string[], roles: string[], tone: 'page' | 'cover', variant?: string, scripts?: Record<number, 'latin' | 'arabic'>) => composeGrammarLayout({
  width: 1080, height: 1350, grammar: G, copy: { text: copyOf(lines), ...(scripts ? { scripts } : {}) }, roles: Object.fromEntries(roles.map((r, i) => [i, r])),
  logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone, ...(variant ? { variant } : {}),
  fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' },
});
const qaContext = (lines: string[], scripts?: Array<'latin' | 'arabic'>): HardQaContext => ({
  width: 1080, height: 1350, copyScripts: scripts ?? lines.map(() => 'latin'), latinFont: 'Inter', arabicFont: 'Noto Sans Arabic',
  admittedDisplayFonts: KAAE_FONTS, palette: PALETTE, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15, copyText: copyOf(lines),
});
const rendered = (layout: StudioLayoutV2, lines: string[]) => renderLayoutV2(layout, { copyText: copyOf(lines), logoDataUri: `data:image/png;base64,${LOGO.toString('base64')}` });
const pixel = (png: Buffer, x: number, y: number) => {
  const img = PNG.sync.read(png);
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

describe('the palette is the 2025 guideline\'s (pp.7-8), and the older brand book is gone', () => {
  it('reads KAAE Blue and Gold, the extended palette and the white page, light first', () => {
    expect(PALETTE).toEqual([WHITE, CREAM, BLUE, GOLD, MIDNIGHT, ROYAL, OCEAN, SKY, SUN]);
    expect(RAW.rules.paletteFallbacks).toEqual({ background: WHITE, text: MIDNIGHT, accent: BLUE });
    expect(RAW.sourceFile).toBe('KAAE_Guidelines4.pdf');
    expect(RAW.sourceTitle).toMatch(/Excellence Edition \(2025\)/);
    expect(REF.promotedRules).toMatch(/KAAE Blue \(#4770A3, Pantone 5415 C\)/);
    expect(REF.promotedRules).toMatch(/KAAE Gold \(#F7B500, Pantone 7549 C\)/);
    expect(brandTones(PALETTE)).toEqual({ navy: MIDNIGHT, deep: ROYAL, gold: GOLD, cream: CREAM, white: WHITE });
  });

  it('carries no value of the withdrawn brand book anywhere in the reference', () => {
    const text = JSON.stringify(RAW);
    for (const old of ['#17087A', '#3833A3', '#0F73DE', '#E8B85C', '#FFF2DB', '#160874', '#35309B', '#000000']) expect(text.toUpperCase()).not.toContain(old);
    expect(text).not.toMatch(/indigo|minion|BRAND GUIDLINES/i);
    // Verdana is named only as the Typography pages' text, which the owner set aside for the look.
    expect(JSON.stringify(RAW.rules.typography.formalBody) + RAW.rules.fontFamily + JSON.stringify(RAW.rules.typography.display.admitted)).not.toMatch(/Verdana/);
  });

  it('hard QA accepts the guideline\'s colours and refuses the withdrawn indigo, in a fill or a gradient stop', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    expect(validateLayoutV2(page, context(5, 0))).toMatchObject({ ok: true });
    const indigo = { ...page, background: { color: '#17087A' } };
    expect(validateLayoutV2(indigo, context(5, 0))).toMatchObject({ ok: false, code: 'PALETTE' });
    const stop = JSON.parse(JSON.stringify(page)) as StudioLayoutV2;
    stop.shapes.find((s) => s.primitive === 'foot_rule')!.gradient!.stops[2].color = '#E8B85C';
    expect(validateLayoutV2(stop, context(5, 0))).toMatchObject({ ok: false, code: 'PALETTE', message: expect.stringContaining('Gradient colour #E8B85C') });
  });

  it('snaps a ground to the guideline\'s navy, never to an ink', () => {
    expect(nearestGroundColour('#17087A', PALETTE)).toBe(ROYAL);
    expect(nearestGroundColour('#000000', PALETTE)).toBe(MIDNIGHT);
    expect(nearestGroundColour('#FFF2DB', PALETTE)).toBe(CREAM);
  });
});

describe('the page grammar is checked whole where the reference is admitted (Codex review, 2026-10-02)', () => {
  const withGrammar = (mutate: (g: any) => void) => {
    const raw = JSON.parse(JSON.stringify(RAW));
    mutate(raw.rules.pageGrammar);
    return () => pageGrammarFromRaw(raw);
  };
  it('refuses required parts present as empty objects', () => {
    expect(withGrammar((g) => { g.header = {}; g.cards = {}; })).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.header/);
  });
  it('refuses a gradient with no stops, stops out of order, and stops that do not span 0..1', () => {
    expect(withGrammar((g) => { g.header.accent.stops = []; })).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.header\.accent\.stops/);
    expect(withGrammar((g) => { g.footRule.stops = [{ at: 1, color: '#4770A3' }, { at: 0, color: '#F7B500' }]; })).toThrow(/ascend/);
    expect(withGrammar((g) => { g.titleBar.stops = [{ at: 0.2, color: '#F7B500' }, { at: 0.8, color: '#FFD700' }]; })).toThrow(/0 to 1/);
  });
  it('refuses a share that is not a finite number, and a colour outside the palette', () => {
    expect(withGrammar((g) => { g.header.accent.widthShare = 'wide'; })).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.header\.accent\.widthShare/);
    expect(withGrammar((g) => { g.title.sizeShare = Infinity; })).toThrow(/PAGE_GRAMMAR_INVALID/);
    expect(withGrammar((g) => { g.title.color = '#17087A'; })).toThrow(/not in the client's palette/);
    expect(withGrammar((g) => { g.title.fontFamily = ''; })).toThrow(/PAGE_GRAMMAR_INVALID: pageGrammar\.title\.fontFamily/);
  });
  it('admits the guideline\'s own grammar, and a reference with none stays without one', () => {
    expect(pageGrammarFromRaw(RAW)).toMatchObject({ title: { fontFamily: 'Crimson Pro' } });
    const none = JSON.parse(JSON.stringify(RAW));
    delete none.rules.pageGrammar;
    expect(pageGrammarFromRaw(none)).toBeUndefined();
  });
});

describe('typography: the guideline\'s look (owner, 2026-10-01), not the "Verdana" text of pp.9-10', () => {
  it('admits Crimson Pro for titles and Inter with a real italic for leads and body', () => {
    expect(RAW.rules.fontFamily).toBe('Inter');
    expect(RAW.rules.typography.formalBody).toEqual({ latin: 'Inter', arabic: 'Noto Sans Arabic' });
    expect(G.title).toMatchObject({ fontFamily: 'Crimson Pro', bold: true, color: BLUE });
    expect(G.lead).toMatchObject({ fontFamily: 'Inter', italic: true, color: BLUE });
    expect(admittedFontFaces({ script: 'latin', role: 'display', bold: true }).map((f) => f.name)).toContain('Crimson Pro');
    expect(admittedFontFaces({ script: 'latin', role: 'body' }).map((f) => f.name)).toContain('Inter');
    expect(fontFileFor('Crimson Pro', true)).toMatch(/CrimsonPro-Bold\.ttf$/);
    expect(fontFileFor('Inter', false, true)).toMatch(/Inter-Italic\.otf$/);
    expect(fontFaceSupports('Inter', false, true)).toEqual({ bold: false, italic: true });
    expect(fontFaceSupports('Crimson Pro', true, false)).toEqual({ bold: true, italic: false });
  });

  it('draws Crimson Pro and Inter from their own files (the fidelity probe), not a stand-in', () => {
    expect(probeFontFidelity('Crimson Pro')).toBe('exact');
    expect(probeFontFidelity('Inter')).toBe('exact');
  });

  it('keeps the admitted Sorani sans faces for Kurdish (p.10)', () => {
    expect(RAW.rules.scriptFonts.arabic).toBe('Noto Sans Arabic');
    expect(RAW.rules.typography.display.admitted).toEqual(['Crimson Pro', 'Inter', 'Noto Sans Arabic', 'IBM Plex Sans Arabic']);
  });
});

describe('the guideline\'s layout primitives', () => {
  it('header: a thin grey rule across the content width with a gold gradient segment under the logo', () => {
    const [rule, accent] = headerPrimitives(G, 1080, 76, 928, 300);
    expect(rule).toMatchObject({ primitive: 'header_rule', role: 'rule', color: MIDNIGHT, opacity: 0.08, x: 76, width: 928 });
    expect(accent).toMatchObject({ primitive: 'header_accent', x: 76, width: Math.round(0.11 * 1080) });
    expect(accent.gradient!.stops.map((s) => s.color)).toEqual([GOLD, SUN, GOLD]);
    expect(accent.height).toBeGreaterThan(rule.height);
  });

  it('title bar: a short gold gradient bar under the title, at its start (its end in Sorani)', () => {
    const title = { x: 76, y: 300, width: 928, height: 200 };
    const left = titleBarPrimitive(G, 1080, title, 'left');
    expect(left).toMatchObject({ primitive: 'title_bar', kind: 'roundRect', x: 76, width: Math.round(0.085 * 1080) });
    expect(left.y).toBeGreaterThan(title.y + title.height);
    const right = titleBarPrimitive(G, 1080, title, 'right');
    expect(right.x + right.width).toBe(76 + 928);
    expect(left.gradient!.stops.map((s) => s.color)).toEqual([GOLD, SUN, GOLD]);
  });

  it('cards: rounded with a soft shadow; brand cards KAAE Blue; tint cards cream with a gold edge on the start side', () => {
    const [brand] = cardPrimitives(G, 1080, 'brand', { x: 76, y: 600, width: 928, height: 200 });
    expect(brand).toMatchObject({ primitive: 'card', role: 'panel', surface: 'card', kind: 'roundRect', color: BLUE, radius: 13 });
    expect(brand.shadow).toMatchObject({ color: MIDNIGHT, opacity: 0.1 });
    const [tint, edge] = cardPrimitives(G, 1080, 'tint', { x: 76, y: 900, width: 928, height: 100 });
    expect(tint.color).toBe(CREAM);
    expect(edge).toMatchObject({ primitive: 'card_edge', role: 'accent', color: GOLD, x: 76 });
    const [, rtlEdge] = cardPrimitives(G, 1080, 'tint', { x: 76, y: 900, width: 928, height: 100 }, true);
    expect(rtlEdge.x + rtlEdge.width).toBe(76 + 928);
    expect(G.cards.brand).toMatchObject({ fill: BLUE, title: SUN, text: WHITE });
  });

  it('foot rule and cover ground: the guideline\'s gradients (p.7 Blue to Gold; the cover Blue to Midnight)', () => {
    const foot = footRulePrimitive(G, 1080, 76, 928, 1280);
    expect(foot.gradient!.stops.map((s) => s.color)).toEqual([BLUE, ROYAL, GOLD, SUN]);
    const ground = coverGroundPrimitive(G, 1080, 1350);
    expect(ground).toMatchObject({ primitive: 'cover_ground', x: 0, y: 0, width: 1080, height: 1350 });
    expect(ground.gradient).toMatchObject({ angle: 45 });
    expect(gradientColourAt(ground.gradient!, ground, 0, 0)).toBe(BLUE);
    expect(gradientColourAt(ground.gradient!, ground, 1080, 1350)).toBe(MIDNIGHT);
  });

  it('the preview draws each gradient: the foot rule runs blue at its start and gold at its end', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    const { svg } = renderLayoutV2ToSvg(page, { copyText: copyOf(WORKSHOP), logoDataUri: `data:image/png;base64,${LOGO.toString('base64')}` });
    expect(svg).toMatch(/<linearGradient id="shape-gradient-\d+" gradientUnits="objectBoundingBox"/);
    const foot = page.shapes.find((s) => s.primitive === 'foot_rule')!;
    const png = rendered(page, WORKSHOP).png;
    const [r0, , b0] = pixel(png, foot.x + 4, foot.y + Math.floor(foot.height / 2));
    const [r1, , b1] = pixel(png, foot.x + foot.width - 4, foot.y + Math.floor(foot.height / 2));
    expect(b0).toBeGreaterThan(r0);
    expect(r1).toBeGreaterThan(b1 + 100);
  });

  it('the Canva deck keeps every primitive a native shape, the gradients as native gradient fills', async () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    const deck = await encodeStudioTransferV2(JSON.parse(JSON.stringify(page)), WORKSHOP, { bytes: LOGO, mimeType: 'image/png', sha256: RAW.logoSha256 } as any);
    const xml = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    for (const name of ['Header rule', 'Header gold segment', 'Title bar', 'Card', 'Card edge', 'Foot rule']) expect(xml).toContain(`name="${name} `);
    expect((xml.match(/<a:gradFill/g) || []).length).toBe(page.shapes.filter((s) => s.gradient).length);
    expect(xml).toContain('<a:gs pos="0"><a:srgbClr val="4770A3">');
    expect(xml).toContain('<a:lin ang="0" scaled="1"/>');
    expect(gradientOoxml({ angle: 45, stops: [{ at: 0, color: BLUE }, { at: 1, color: MIDNIGHT }] })).toContain('<a:lin ang="2700000" scaled="1"/>');
    // Titles in Crimson Pro, leads in Inter italic, as the deck sets them.
    expect(xml).toContain('typeface="Crimson Pro"');
    expect(xml).toMatch(/i="1"[^>]*>[\s\S]*?typeface="Inter"/);
  });
});

describe('the guideline page and cover, composed (no model call)', () => {
  it('the Quality Assurance Workshop: header, serif title and bar, italic lead, details on a KAAE Blue card, cream call-to-action card, foot rule', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    expect(page.background.color).toBe(WHITE);
    expect(page.composition).toEqual({ grammar: 'page', variant: 'brand_card' });
    const kinds = page.shapes.map((s) => s.primitive);
    for (const p of ['header_rule', 'header_accent', 'title_bar', 'card', 'card_edge', 'foot_rule']) expect(kinds).toContain(p);
    const t = (i: number) => page.text.find((x) => x.copyIndex === i)!;
    expect(t(0)).toMatchObject({ fontFamily: 'Crimson Pro', bold: true, color: BLUE, align: 'left' });
    // The type is one declared major-third scale from the body, the title at least 2.2x the body.
    expect(page.typeScale).toEqual({ base: t(4).fontSize, ratio: 1.25 });
    expect(t(0).fontSize).toBeGreaterThanOrEqual(2.2 * t(4).fontSize);
    expect(t(0).height).toBeLessThan(2.6 * t(0).fontSize);
    expect(t(1)).toMatchObject({ fontFamily: 'Inter', italic: true, color: BLUE });
    expect(t(2)).toMatchObject({ fontFamily: 'Crimson Pro', color: SUN });
    expect(t(3)).toMatchObject({ fontFamily: 'Inter', color: WHITE });
    expect(t(4)).toMatchObject({ fontFamily: 'Inter', italic: true, color: MIDNIGHT });
    // The logo at the top left; the header rule outside its clear space.
    expect(page.logo.x).toBe(76);
    const clear = logoClearZone(page.logo, 0.15 * page.logo.height);
    expect(page.shapes.find((s) => s.primitive === 'header_rule')!.y).toBeGreaterThanOrEqual(clear.y + clear.height);
    const render = rendered(page, WORKSHOP);
    const qa = evaluateHardQa(page, { ...qaContext(WORKSHOP), renderedComposite: render.noTextPng, fontFidelity: render.fontFidelity });
    expect(qa.passed, qa.messages.join(' | ')).toBe(true);
    expect(qa.findings.map((f) => f.code)).not.toContain('FONT_SUBSTITUTED');
  });

  it('the white-cards variant passes the same gates', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page', 'cards');
    // A date and a place on two white cards side by side, as the guideline's stat cards (p.1).
    expect(page.shapes.filter((s) => s.primitive === 'card' && s.color === WHITE).length).toBe(2);
    expect(page.text.find((t) => t.copyIndex === 2)).toMatchObject({ fontFamily: 'Crimson Pro', color: BLUE, align: 'center' });
    const render = rendered(page, WORKSHOP);
    expect(evaluateHardQa(page, { ...qaContext(WORKSHOP), renderedComposite: render.noTextPng }).passed).toBe(true);
  });

  it('the announcement cover: the navy gradient, a centred logo, a white serif title, the gold bar and a tracked gold subtitle', () => {
    const cover = compose(COVER, COVER_ROLES, 'cover');
    expect(cover.shapes[0]).toMatchObject({ primitive: 'cover_ground', gradient: { angle: 45 } });
    expect(Math.abs(cover.logo.x + cover.logo.width / 2 - 540)).toBeLessThanOrEqual(1);
    const t = (i: number) => cover.text.find((x) => x.copyIndex === i)!;
    expect(t(0)).toMatchObject({ fontFamily: 'Crimson Pro', color: WHITE, align: 'center' });
    expect(t(1)).toMatchObject({ fontFamily: 'Inter', color: GOLD, letterSpacing: 0.1, align: 'center' });
    expect(cover.shapes.some((s) => s.primitive === 'title_bar')).toBe(true);
    expect(cover.ornaments?.[0]).toMatchObject({ kind: 'triangle_pattern', fade: 'to-top', color: SKY });
    const [r, g, b] = pixel(rendered(cover, COVER).png, 4, 4);
    expect(b).toBeGreaterThan(r);
    const render = rendered(cover, COVER);
    const qa = evaluateHardQa(cover, { ...qaContext(COVER), renderedComposite: render.noTextPng });
    expect(qa.passed, qa.messages.join(' | ')).toBe(true);
    for (const x of cover.text) expect(declaredTextContrast(cover, x)).toBeGreaterThanOrEqual(3);
  });

  it('a Sorani page: right-aligned in the admitted sans, the bar under the title\'s right end, the header as it is (p.10)', () => {
    const lines = ['کۆبوونەوەی دڵنیایی جۆری', 'بۆ بەڕێوەبەرانی قوتابخانەکان', '٢٢ی تشرینی یەکەم ٢٠٢٦'];
    const scripts = { 0: 'arabic' as const, 1: 'arabic' as const, 2: 'arabic' as const };
    const page = compose(lines, ['title', 'subtitle', 'date'], 'page', undefined, scripts);
    const title = page.text.find((t) => t.copyIndex === 0)!;
    expect(title).toMatchObject({ rtl: true, align: 'right', fontFamily: 'IBM Plex Sans Arabic', letterSpacing: 0 });
    const bar = page.shapes.find((s) => s.primitive === 'title_bar')!;
    expect(bar.x + bar.width).toBe(title.x + title.width);
    expect(page.logo.x).toBe(76);
    const render = rendered(page, lines);
    const qa = evaluateHardQa(page, { ...qaContext(lines, ['arabic', 'arabic', 'arabic']), renderedComposite: render.noTextPng });
    expect(qa.passed, qa.messages.join(' | ')).toBe(true);
  });

  it('preparation keeps a composed design whole', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    const before = JSON.stringify(page);
    const prepared = prepareGeneratedLayoutV3(JSON.parse(before), { text: copyOf(WORKSHOP) }, { width: 1080, height: 1350, palette: PALETTE, grammar: G });
    // Only the direction each block's script implies is recorded (rtl: false for Latin).
    for (const t of prepared.text) expect(t.rtl).toBe(false);
    expect(JSON.stringify({ ...prepared, text: prepared.text.map(({ rtl: _rtl, ...t }) => t) })).toBe(before);
  });
});

describe('the logo rules of pp.3-6 are enforced by hard QA', () => {
  const base = () => compose(WORKSHOP, WORKSHOP_ROLES, 'page');

  it('never under 80px digital (the house\'s 100px floor decides) and never stretched', () => {
    const small = base();
    small.logo = { ...small.logo, width: 90, height: 90 };
    expect(validateLayoutV2(small, context(5, 0))).toMatchObject({ ok: false, code: 'LOGO', message: expect.stringContaining('less than minimum') });
    const stretched = base();
    stretched.logo = { ...stretched.logo, width: stretched.logo.width + 30 };
    expect(validateLayoutV2(stretched, context(5, 0))).toMatchObject({ ok: false, code: 'LOGO', message: expect.stringContaining('aspect') });
  });

  it('keeps its clear space: the client\'s share of the logo\'s height counts when it is the larger', () => {
    const page = base();
    const share = { ...context(5, 0), reference: { ...context(5, 0).reference, logoClearSpaceShareOfHeight: 0.9 } };
    expect(validateLayoutV2(page, share)).toMatchObject({ ok: false, code: 'LOGO' });
    expect(validateLayoutV2(page, context(5, 0))).toMatchObject({ ok: true });
  });

  it('LOGO_CLEAR_SPACE: a card reaching into the clear space; LOGO_EFFECT: a shadow under the logo', () => {
    const intruding = base();
    intruding.shapes.push({ kind: 'roundRect', role: 'panel', primitive: 'card', surface: 'card', color: WHITE, x: intruding.logo.x + 20, y: intruding.logo.y + intruding.logo.height + 10, width: 400, height: 80 });
    expect(logoRuleDefects(intruding, 0).map((d) => d.code)).toContain('LOGO_CLEAR_SPACE');
    const shadowed = base();
    const l = shadowed.logo;
    shadowed.shapes.push({ kind: 'roundRect', role: 'panel', layer: 'overlay', surface: 'tab', color: WHITE, x: l.x - 4, y: l.y - 4, width: l.width + 8, height: l.height + 8,
      shadow: { color: MIDNIGHT, opacity: 0.3, blur: 12, offsetY: 4 } });
    expect(logoRuleDefects(shadowed, 0).map((d) => d.code)).toContain('LOGO_EFFECT');
    expect(logoRuleDefects(base(), 0)).toEqual([]);
  });

  it('LOGO_BUSY_GROUND: a bare logo on a busy ground, measured on the render or recorded by the logo-ground pass', () => {
    const page = base();
    const render = rendered(page, WORKSHOP);
    expect(logoRuleDefects(page, 0, render.noTextPng)).toEqual([]);
    // The same design over a noisy ground round the logo.
    const img = PNG.sync.read(render.noTextPng);
    let s = 1;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const i = (y * img.width + x) * 4;
      s = (s * 9301 + 49297) % 233280;
      const v = Math.floor((s / 233280) * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
    expect(logoRuleDefects(page, 0, PNG.sync.write(img)).map((d) => d.code)).toContain('LOGO_BUSY_GROUND');
    const recorded = { ...page, artDirection: { recipe: 'hero_card' as const, titleZone: { x: 0, y: 0, width: 10, height: 10 }, omittedPhotos: [], rtl: false,
      logoGround: { treatment: 'none' as const, contrast: 4, busyness: 0.2 } } };
    expect(logoRuleDefects(recorded, 0).map((d) => d.code)).toEqual(['LOGO_BUSY_GROUND']);
    const lifted = { ...recorded, artDirection: { ...recorded.artDirection, logoGround: { treatment: 'scrim' as const, contrast: 4, busyness: 0.2 } } };
    expect(logoRuleDefects(lifted, 0)).toEqual([]);
  });

  it('records the guideline\'s logo rules in the reference', () => {
    expect(RAW.rules.logoConstraints).toMatchObject({ minimumWidthPx: 80, clearSpaceShareOfHeight: 0.15 });
    expect(RAW.rules.logo).toMatch(/never stretched or distorted, rotated or tilted, recoloured, given effects or shadows, or set on a busy background/);
  });
});

describe('the brand elements of p.13, as vector art', () => {
  it('the asset files are the generator\'s own output', () => {
    for (const [file, el] of Object.entries(BRAND_ELEMENT_ASSETS)) {
      expect(readFileSync(new URL(`../assets/elements/${file}`, import.meta.url), 'utf8').trim()).toBe(ornamentSvgDocument(el));
    }
  });

  it('a quarter-disc sunburst with five rays; a triangle mosaic fading toward its top', () => {
    const sun = sunburstSvg({ x: 0, y: 0, width: 300, height: 300, color: MIDNIGHT, opacity: 1, corner: 'bottom-left' }, 's');
    expect((sun.match(/<line /g) || []).length).toBe(5);
    expect(sun).toMatch(/<path d="M 0 300 L /);
    const pattern = trianglePatternSvg({ x: 0, y: 0, width: 600, height: 200, color: OCEAN, opacity: 1, fade: 'to-top' }, 'p');
    const rows = [...pattern.matchAll(/<g opacity="([\d.]+)">/g)].map((m) => Number(m[1]));
    expect(rows.length).toBeGreaterThan(4);
    expect(rows[0]).toBeLessThan(rows[rows.length - 1]);
  });

  it('never lies under copy or the logo\'s clear space', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    const title = page.text.find((t) => t.copyIndex === 0)!;
    const over = { ...page, ornaments: [{ kind: 'sunburst' as const, x: title.x, y: title.y, width: 200, height: 200, color: MIDNIGHT, opacity: 0.06 }] };
    expect(validateLayoutV2(over, context(5, 0))).toMatchObject({ ok: false, code: 'ORNAMENT' });
    const offPalette = { ...page, ornaments: [{ kind: 'sunburst' as const, x: 700, y: 1000, width: 200, height: 200, color: '#3833A3', opacity: 0.06 }] };
    expect(validateLayoutV2(offPalette, context(5, 0))).toMatchObject({ ok: false, code: 'PALETTE' });
  });
});

describe('light first (ADR-236 logic, re-pointed at the 2025 palette)', () => {
  const tone = (s: string) => tonePreferenceFromWords(s);
  it('reads light, white, cream and the brand guideline; dark, navy, the evening and a cover', () => {
    expect(tone('Please put it on a white background')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('as per the brand guidelines please')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('light cream background')).toMatchObject({ tone: 'light', ground: 'cream' });
    expect(tone('باکگراوندی سپی بێت')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('use a dark navy background')).toMatchObject({ tone: 'dark', basis: 'colour' });
    expect(tone('An invitation for our evening gala dinner')).toMatchObject({ tone: 'dark', basis: 'occasion' });
    expect(tone('Please make an announcement cover')).toMatchObject({ tone: 'dark', basis: 'occasion' });
    expect(tone('Design a poster for the Quality Assurance Workshop. For school principals.')).toBeUndefined();
    expect(tone('white text on a navy background')).toMatchObject({ tone: 'dark' });
  });

  it('sets a tone\'s ground from the 2025 palette, and the light page is white unless cream is named', () => {
    expect(toneGroundHex({ tone: 'light' }, PALETTE)).toBe(WHITE);
    expect(toneGroundHex({ tone: 'light', ground: 'cream' }, PALETTE)).toBe(CREAM);
    expect(toneGroundHex({ tone: 'dark' }, PALETTE)).toBe(MIDNIGHT);
    expect(resolveSurfaceTone({ requested: 'navy', heroLuminance: 0.8 })).toEqual({ surfaceTone: 'cream', paper: 'white' });
    expect(resolveSurfaceTone({ heroLuminance: 0.15 })).toEqual({ surfaceTone: 'navy', paper: 'white' });
    expect(resolveSurfaceTone({ preference: { tone: 'light', ground: 'cream' } })).toEqual({ surfaceTone: 'cream', paper: 'cream' });
  });

  it('a light recipe with the grammar takes its faces, colours and marks; a dark one stays on navy', () => {
    const light = solve('hero_fade_report', { frame: 'inset', align: 'start', surfaceTone: 'cream', paper: 'white' }, photo(0.8), true);
    expect(light.background.color).toBe(WHITE);
    const title = light.text.find((t) => t.role === 'title')!;
    expect(title).toMatchObject({ fontFamily: 'Crimson Pro', color: BLUE });
    expect(light.text.find((t) => t.role === 'body')).toMatchObject({ fontFamily: 'Inter', color: MIDNIGHT });
    expect(validateLayoutV2(light, context())).toMatchObject({ ok: true });
    const dark = solve('hero_fade_report', { frame: 'inset', align: 'start', surfaceTone: 'navy' }, photo(0.8), true);
    expect(dark.background.color).toBe(MIDNIGHT);
    expect(dark.text.find((t) => t.role === 'title')!.color).toBe(WHITE);
    expect(artDirectionPrior(light, dark, ['report_release'])).toMatchObject({ winner: null });
  });

  it('fade_to_paper on white with the grammar is the guideline page: the photo in a rounded card under the header, title, bar and lead', () => {
    const page = solve('fade_to_paper', { surfaceTone: 'cream', paper: 'white', align: 'start' }, photo(0.8), true);
    expect(page.composition).toMatchObject({ grammar: 'page' });
    expect(page.artDirection).toMatchObject({ recipe: 'fade_to_paper', heroPhotoIndex: 0 });
    const kinds = page.shapes.map((s) => s.primitive);
    for (const p of ['header_rule', 'header_accent', 'title_bar', 'card', 'foot_rule']) expect(kinds).toContain(p);
    const ph = page.photos![0];
    const card = page.shapes.find((s) => s.primitive === 'card' && s.x === ph.x && s.y === ph.y)!;
    expect(card).toMatchObject({ width: ph.width, height: ph.height, shadow: expect.any(Object) });
    expect(ph.radius).toBe(card.radius);
    expect(validateLayoutV2(page, context())).toMatchObject({ ok: true });
  });

  it('solveConcepts with the grammar makes one light concept the guideline page', () => {
    const copyBlocks = [0, 1, 2].map((index) => ({ index, text: OWNER[index as 0 | 1 | 2], script: 'latin' as const, role: index === 0 ? 'title' : index === 1 ? 'subtitle' : 'body' }));
    const choice = (recipe: ArtDirectionChoice['recipe']): ArtDirectionChoice => ({ recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params: { frame: 'inset', align: 'start' } });
    const opts = { brief: '', copyBlocks: copyBlocks as any, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: [photo(0.8)] as any, logoAspect: 1, grammar: G, logoClearSpaceShare: 0.15 };
    const solved = solveConcepts([choice('hero_fade_report'), choice('scrim_caption'), choice('hero_plate')], opts);
    expect(solved.layouts.map((l) => l.artDirection?.recipe)).toContain('fade_to_paper');
    // Without the grammar (a client with none) nothing is replaced.
    const plain = solveConcepts([choice('hero_fade_report'), choice('scrim_caption')], { ...opts, grammar: undefined });
    expect(plain.layouts.map((l) => l.artDirection?.recipe)).not.toContain('fade_to_paper');
  });
});

describe('the layout model is given the grammar and its primitives', () => {
  it('describes the primitives in the system prompt and asks for one per shape', () => {
    expect(buildLayoutV3SystemPrompt()).toContain('CLIENT PAGE GRAMMAR');
    const shape = (LAYOUT_V3_JSON_SCHEMA as any).properties.layouts.items.properties.shapes.items;
    expect(shape.required).toContain('primitive');
    expect(shape.properties.primitive.enum).toEqual(['header_rule', 'header_accent', 'title_bar', 'card', 'card_edge', 'foot_rule', 'cover_ground', null]);
  });

  it('puts the client\'s grammar in the request in place of the generic gold-rule ornament', () => {
    const args = { brief: 'b', copyBlocks: [{ index: 0, text: 'T', role: 'title' as const, script: 'latin' as const }], palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350 };
    const withGrammar = buildLayoutV3UserPrompt({ ...args, pageGrammar: pageGrammarPrompt(G) });
    expect(withGrammar).toContain('14. CLIENT PAGE GRAMMAR');
    expect(withGrammar).toContain('Crimson Pro bold #4770A3');
    expect(withGrammar).not.toContain('BRAND ORNAMENT');
    expect(buildLayoutV3UserPrompt(args)).toContain('BRAND ORNAMENT');
  });

  it('restyles a model\'s layout to the grammar: faces, tagged primitives, the bar and the foot rule', () => {
    const page = compose(WORKSHOP, WORKSHOP_ROLES, 'page');
    const model = JSON.parse(JSON.stringify(page)) as StudioLayoutV2;
    delete model.composition;
    model.shapes = model.shapes.filter((s) => s.primitive !== 'title_bar' && s.primitive !== 'foot_rule').map((s) => (s.primitive === 'card' ? { ...s, radius: 0, shadow: undefined } : s));
    for (const t of model.text) t.fontFamily = t.role === 'title' ? 'Cinzel' : 'Verdana';
    const conformed = conformToPageGrammar(model, G, { logoClearSpaceShare: 0.15 });
    expect(conformed.text.find((t) => t.role === 'title')).toMatchObject({ fontFamily: 'Crimson Pro', bold: true });
    expect(conformed.text.find((t) => t.role === 'subtitle')).toMatchObject({ fontFamily: 'Inter', italic: true });
    expect(conformed.shapes.filter((s) => s.primitive === 'card').every((s) => s.radius === 13 && s.shadow)).toBe(true);
    expect(conformed.shapes.map((s) => s.primitive)).toEqual(expect.arrayContaining(['title_bar', 'foot_rule']));
    // A dark layout becomes the cover: its gradient ground under everything.
    const dark = conformToPageGrammar({ ...JSON.parse(JSON.stringify(model)), background: { color: MIDNIGHT }, shapes: [],
      text: model.text.map((t) => ({ ...t, color: WHITE })) }, G);
    expect(dark.shapes[0]).toMatchObject({ primitive: 'cover_ground' });
    expect(contrast(WHITE, MIDNIGHT)).toBeGreaterThan(15);
  });
});
