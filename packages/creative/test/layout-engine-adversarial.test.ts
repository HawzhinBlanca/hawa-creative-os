import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { composeGrammarLayout, pageGrammarFromRaw, GrammarInfeasibleError, type ComposeGrammarInput } from '../src/studio/page-grammar.js';
import { composePosterLayout, POSTER_VARIANTS } from '../src/studio/poster-grammar.js';
import { measureTextGeometry, wrappedLinesOf } from '../src/studio/render-layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { ALIGNMENT_POLICY, computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import { declaredTextContrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import { studioReferenceFromRaw } from '../src/studio/hard-qa.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { checkCanvaPptx } from '../../qa/src/canva-pptx-check.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { RecipeInfeasibleError, solveRecipe, type SolverPhoto } from '../src/studio/art-direction/solver.js';

/**
 * Hunt 3 (2026-10-03): adversarial deterministic briefs through the real composers. Each test is a
 * defect found by `output/hunt/fuzz.ts` and failed before its fix.
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const G = pageGrammarFromRaw(RAW)!;
const PALETTE = studioReferenceFromRaw(RAW).palette;
const KAAE_FONTS = { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] };
const ARABIC = /[؀-ۿ]/;

const input = (lines: string[], roles: string[], o: Partial<ComposeGrammarInput> = {}): ComposeGrammarInput => ({
  width: 1080, height: 1350, grammar: G, copy: { text: Object.fromEntries(lines.map((t, i) => [i, t])) }, roles: Object.fromEntries(roles.map((r, i) => [i, r])),
  logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone: 'page', fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' }, ...o,
});
const tryCompose = (f: () => StudioLayoutV2): StudioLayoutV2 | undefined => {
  try {
    return f();
  } catch (err) {
    if (err instanceof GrammarInfeasibleError) return undefined;
    throw err;
  }
};
/** Every line of every block within its box, as hard QA's COPY_OVERFLOW measures it. */
const overflowing = (l: StudioLayoutV2, lines: string[]) =>
  measureTextGeometry(l, Object.fromEntries(lines.map((t, i) => [i, t])))
    .filter((m) => m.status === 'measured' && m.maxLineWidthPx > l.text.find((t) => t.copyIndex === m.copyIndex)!.width + 4)
    .map((m) => m.copyIndex);
const validate = (l: StudioLayoutV2, lines: string[], logoAspect = 1) => validateLayoutV2(l, {
  expectedWidth: l.width, expectedHeight: l.height, copyCount: lines.length, copyScripts: lines.map((t) => (ARABIC.test(t) ? 'arabic' : 'latin')), photoCount: 0,
  copyText: Object.fromEntries(lines.map((t, i) => [i, t])),
  reference: { rules: { fontFamily: 'Inter', palette: PALETTE, admittedDisplayFonts: KAAE_FONTS }, logoAspect, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
});

describe('the page and cover composer never runs a word past its box', () => {
  // Before: the guideline page set "Supercalifragilisticexpialidociousness" at its own title size, a
  // 1224px line in a 928px box, and a URL call to action 854px wide on an 837px card: hard QA's
  // COPY_OVERFLOW refused every one, so the composer handed on designs that could never ship.
  const cases: Array<{ lines: string[]; roles: string[] }> = [
    { lines: ['Supercalifragilisticexpialidociousness', 'For university deans'], roles: ['title', 'subtitle'] },
    { lines: ['Quality Assurance Workshop', '15 October 2026', 'https://kaae.org/registration/2026/workshop?ref=poster'], roles: ['title', 'date', 'cta'] },
  ];
  for (const c of cases) {
    for (const [tone, variant] of [['page', 'brand_card'], ['page', 'cards'], ['cover', 'pattern'], ['cover', 'sunburst']] as const) {
      it(`${c.lines[0].slice(0, 24)}: ${tone} ${variant}`, () => {
        // A page still composes, at a smaller scale; a cover may instead be cleanly infeasible.
        const l = tryCompose(() => composeGrammarLayout(input(c.lines, c.roles, { tone, variant })));
        if (tone === 'page') expect(l).toBeDefined();
        if (l) expect(overflowing(l, c.lines)).toEqual([]);
      });
    }
  }
});

describe('the header label beside the logo stays inside the safe margin', () => {
  // Before: an eyebrow beside a wide, short logo was centred on the logo's line and rose above the
  // safe margin: a 1920x1080 poster with a 3.2:1 logo set it at y 67 against a margin of 76, a page
  // with a 5:1 logo at y 74: the validator's BOUNDS refused both.
  const lines = ['Announcement', 'Quality Assurance Workshop'];
  const cases: Array<[number, number, number]> = [[1920, 1080, 3.2], [1920, 1080, 8], [1080, 1350, 5], [1080, 1920, 8]];
  for (const [width, height, logoAspect] of cases) {
    for (const variant of [...POSTER_VARIANTS, 'page'] as const) {
      it(`${variant} ${width}x${height}, logo ${logoAspect}:1`, () => {
        const base = input(lines, ['eyebrow', 'title'], { width, height, logoAspect });
        const l = tryCompose(() => (variant === 'page' ? composeGrammarLayout({ ...base, variant: 'brand_card' }) : composePosterLayout({ ...base, variant })));
        if (!l) return;
        const v = validate(l, lines, logoAspect);
        expect(v.ok ? 'ok' : `${v.code}: ${v.message}`).toBe('ok');
      });
    }
  }
  it('still composes the navy and cream 1920x1080 posters with a 3.2:1 logo, the label set in the flow', () => {
    for (const variant of ['navy', 'cream'] as const) {
      const l = tryCompose(() => composePosterLayout({ ...input(lines, ['eyebrow', 'title'], { width: 1920, height: 1080, logoAspect: 3.2 }), variant }));
      expect(l, variant).toBeDefined();
      expect(l!.text.find((t) => t.copyIndex === 0)!.y).toBeGreaterThanOrEqual(l!.logo.y + l!.logo.height);
    }
  });
});

describe('a poster-sized or page-sized wide logo keeps its official aspect', () => {
  // Before: the aspect search ran only while the logo was within 40px of the house minimum, but the
  // poster's and page's logo (0.16 of the width, 173px) starts past it, so a 5:1 logo was drawn
  // 173x35 (4.94:1) and an 8:1 logo 173x22: the validator's LOGO rule (1%) refused every design.
  for (const logoAspect of [2.7, 5, 8]) {
    for (const variant of [...POSTER_VARIANTS, 'page'] as const) {
      it(`${variant}, logo ${logoAspect}:1`, () => {
        const lines = ['Quality Assurance Workshop', '15 October 2026'];
        const base = input(lines, ['title', 'date'], { logoAspect });
        const l = tryCompose(() => (variant === 'page' ? composeGrammarLayout({ ...base, variant: 'brand_card' }) : composePosterLayout({ ...base, variant })));
        expect(l).toBeDefined();
        expect(Math.abs(l!.logo.width / l!.logo.height - logoAspect) / logoAspect).toBeLessThanOrEqual(0.01);
        const v = validate(l!, lines, logoAspect);
        expect(v.ok ? 'ok' : `${v.code}: ${v.message}`).toBe('ok');
      });
    }
  }
});

describe('a Sorani composed design reaches the Canva deck', () => {
  // Before: the poster and page composers set every Sorani title in IBM Plex Sans Arabic (ADR-238), the
  // deck's admitted faces did not include it, and production's transfer stage passes only the client's
  // formal faces (Inter, Noto Sans Arabic) as extra fonts: every Sorani composition threw "Unsupported
  // font or unreadable size: IBM Plex Sans Arabic 148px" and produced no deliverable.
  const lines = ['وۆرکشۆپی دڵنیایی جۆری', 'بۆ ڕاگرانی زانکۆکان', '١٥ی تشرینی یەکەمی ٢٠٢٦', 'هوتێل ڕۆتانا، هەولێر', 'تۆمارکردن بەخۆڕاییە'];
  const roles = ['title', 'subtitle', 'date', 'venue', 'cta'];
  const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
  const sha256 = createHash('sha256').update(LOGO).digest('hex');
  // As apps/core's transfer stage passes them for KAAE (latinFont, arabicFont and its fixed list).
  const extraFonts = ['Inter', 'Noto Sans Arabic', 'Verdana', 'Noto Sans Arabic', 'Cinzel', 'Playfair Display'];
  for (const variant of [...POSTER_VARIANTS, 'page'] as const) {
    it(variant, async () => {
      const base = input(lines, roles);
      const l = variant === 'page' ? composeGrammarLayout({ ...base, variant: 'brand_card' }) : composePosterLayout({ ...base, variant });
      expect(l.text.find((t) => t.role === 'title')!.fontFamily).toBe('IBM Plex Sans Arabic');
      const deck = await encodeStudioTransferV2(l, lines, { bytes: LOGO, mimeType: 'image/png', sha256 }, { extraFonts });
      const fontsByIndex = lines.map((_, i) => l.text.find((t) => t.copyIndex === i)!.fontFamily);
      const check = checkCanvaPptx(deck.bytes, lines, { fontsByIndex, uppercaseByIndex: lines.map(() => false) });
      expect(check.copyPass).toBe(true);
      expect(check.fontPass).toBe(true);
    });
  }
});

describe('the page and cover composer promises hard QA\'s alignment check, as the poster composer does', () => {
  // Before: a title-only sunburst cover set the logo, the title and its gold bar on the start margin,
  // and the logo's and the bar's free ends lined up with nothing: alignment 0.667 against hard QA's
  // 0.70 (POOR_GRID_ALIGNMENT), on every canvas. The composer now refuses such a layout itself.
  for (const lines of [['Workshop'], ['Call for Peer Evaluators']]) {
    for (const [width, height] of [[1080, 1350], [1080, 1080], [1080, 1920], [1920, 1080]] as const) {
      it(`${lines[0]} ${width}x${height}`, () => {
        for (const variant of ['pattern', 'sunburst', 'brand_card', 'cards']) {
          const tone = variant === 'pattern' || variant === 'sunburst' ? 'cover' : 'page';
          const l = tryCompose(() => composeGrammarLayout(input(lines, ['title'], { width, height, tone, variant })));
          if (l) expect(computeLayoutMetrics(l).alignmentScore, variant).toBeGreaterThanOrEqual(ALIGNMENT_POLICY.passScore);
        }
      });
    }
  }
});

describe('a landscape poster\'s display title reaches the Canva deck', () => {
  // Before: the composers size a title by the width (KAAE: up to 0.2 of it, 384px on 1920x1080) and the
  // deck refused any size over 0.25 of the height (270px there): a one-word 1920x1080 poster titled at
  // 296px, and its page at 346px beside a wide logo, threw "Unsupported font or unreadable size" at the transfer.
  const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
  const sha256 = createHash('sha256').update(LOGO).digest('hex');
  const lines = ['Workshop'];
  for (const variant of [...POSTER_VARIANTS, 'page'] as const) {
    it(variant, async () => {
      // The page's title reaches 346px beside a wide 3.2:1 logo (its header sets a smaller scale with a square one).
      const base = input(lines, ['title'], { width: 1920, height: 1080, logoAspect: variant === 'page' ? 3.2 : 1 });
      const l = variant === 'page' ? composeGrammarLayout({ ...base, variant: 'brand_card' }) : composePosterLayout({ ...base, variant });
      expect(l.text[0].fontSize).toBeGreaterThan(0.25 * 1080);
      const deck = await encodeStudioTransferV2(l, lines, { bytes: LOGO, mimeType: 'image/png', sha256 });
      const check = checkCanvaPptx(deck.bytes, lines, { fontsByIndex: [l.text[0].fontFamily], uppercaseByIndex: [l.text[0].textTransform === 'uppercase'] });
      expect(check.copyPass && check.fontPass).toBe(true);
    });
  }
});

describe('the composer\'s contrast check is at least as strict as hard QA\'s', () => {
  // Before: checkGrammarLayout read the gradient under a block at five sample points and passed the
  // gold lead of an all-capitals cover at 4.5:1, while hard QA bounds the gradient by its channel
  // envelope and measured 4.48:1 (CONTRAST): the composer handed on a design QA always refuses.
  it('all-capitals cover with the triangle band, 1080x1080 with a 3.2:1 logo', () => {
    const lines = ['QUALITY ASSURANCE WORKSHOP', 'FOR UNIVERSITY DEANS', '15 OCTOBER 2026'];
    const l = tryCompose(() => composeGrammarLayout(input(lines, ['title', 'subtitle', 'date'], { width: 1080, height: 1080, logoAspect: 3.2, tone: 'cover', variant: 'pattern' })));
    if (!l) return;
    for (const t of l.text) expect(declaredTextContrast(l, t), `block ${t.copyIndex}`).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, Boolean(t.bold)));
  });
});

describe('the recipe solver never sets a word or a call to action wider than its box', () => {
  // Before: fitScale counted a block's lines but never compared its longest line with its column, and
  // set a call to action measured on the full column into a pill narrower by its padding. On a 1080x1350
  // mosaic "QUALITY ASSURANCE WORKSHOP" ran a 413px word in a 350px column and "Registration is free"
  // wrapped inside its pill to 68px of text in a 35px box: hard QA's COPY_OVERFLOW refused both.
  const lines = ['Quality Assurance Workshop', 'For university deans', '15 October 2026 · 9:30 AM', 'Rotana Hotel, Erbil', 'Registration is free'];
  const slots = ['title', 'accent', 'meta', 'meta', 'cta'] as const;
  const photos: SolverPhoto[] = [0, 1, 2, 3].map((i) => ({ photoIndex: i, width: 1280, height: 853, salient: { x: 0.45, y: 0.6 }, quiet: 'none' as const }));
  for (const [width, height] of [[1080, 1350], [1080, 1080], [1920, 1080]] as const) {
    for (const recipe of ['photo_mosaic', 'editorial_split', 'hero_fade_report', 'scrim_caption'] as const) {
      it(`${recipe} ${width}x${height}`, () => {
        let l: StudioLayoutV2 | undefined;
        try {
          l = solveRecipe({
            width, height, copy: { text: Object.fromEntries(lines.map((t, i) => [i, t])) }, photos, photoSelection: { mode: 'choose', minimum: 1 }, palette: PALETTE, logoAspect: 1,
            choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, supportingPhotoIndices: [1, 2, 3], cutoutPhotoIndex: null, slots: slots.map((slot, copyIndex) => ({ copyIndex, slot })), params: {} },
          });
        } catch (err) {
          if (!(err instanceof RecipeInfeasibleError)) throw err;
        }
        if (l) expect(overflowing(l, lines)).toEqual([]);
        if (l) for (const m of measureTextGeometry(l, Object.fromEntries(lines.map((t, i) => [i, t])))) {
          if (m.status === 'measured') expect(m.requiredHeightPx, `block ${m.copyIndex}`).toBeLessThanOrEqual(l.text.find((t) => t.copyIndex === m.copyIndex)!.height + 1);
        }
      });
    }
  }
});

describe('a story-format recipe sets its logo and copy on the grid it declares', () => {
  // Before: on 1080x1920 the solver's safe area took the story zone's side (0.06 of the width, 65px)
  // while the layout declared a 76px grid margin. The logo stood at 65 and lined up with nothing, so a
  // title-only story measured 0.5 on hard QA's alignment: 380 of 12,096
  // deterministic recipe layouts failed POOR_GRID_ALIGNMENT, almost all of them stories.
  const photos: SolverPhoto[] = [0, 1, 2, 3].map((i) => ({ photoIndex: i, width: 1280, height: 853, salient: { x: 0.45, y: 0.6 }, quiet: 'none' as const,
    ...(i === 3 ? { focus: { x: 0.3, y: 0.35 }, faceShare: 0.3, cutoutSize: { width: 600, height: 1100 }, cutoutPixelSize: { width: 600, height: 1100 } } : {}) }));
  for (const recipe of ['hero_fade_report', 'scrim_caption'] as const) {
    it(recipe, () => {
      const l = solveRecipe({
        width: 1080, height: 1920, copy: { text: { 0: 'Workshop' } }, photos, photoSelection: { mode: 'choose', minimum: 1 }, palette: PALETTE, logoAspect: 1,
        choice: { recipe, heroPhotoIndex: recipe === 'cutout_speaker' ? 3 : 0, texturePhotoIndex: null, cutoutPhotoIndex: recipe === 'cutout_speaker' ? 3 : null, slots: [{ copyIndex: 0, slot: 'title' }], params: { frame: 'inset', align: 'start' } },
      });
      expect([l.logo.x, l.logo.x + l.logo.width]).toContain(l.grid.margin);
      expect(computeLayoutMetrics(l).alignmentScore).toBeGreaterThanOrEqual(ALIGNMENT_POLICY.passScore);
    });
  }
});

describe('the renderer never breaks a line at a no-break space', () => {
  // Before: the fontkit wrap split words on /\s+/, which includes U+00A0, U+202F and U+2007, so a
  // title typed "Quality Assurance Workshop" (pasted from a document) was measured and drawn on
  // two lines while pango (the Sorani path), PowerPoint and Canva keep it whole: the deck's line ran
  // past the box the preview measured.
  const t = { copyIndex: 0, role: 'title' as const, x: 0, y: 0, width: 600, height: 100, fontSize: 60, lineHeight: 1.2, fontFamily: 'Inter' as const, color: '#000000' as const, align: 'left' as const, bold: true };
  for (const space of [' ', ' ', ' ']) {
    it(`U+${space.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, () => {
      const copy = ['Quality', 'Assurance', 'Workshop'].join(space);
      const [m] = measureTextGeometry({ text: [t] } as unknown as StudioLayoutV2, { 0: copy });
      expect(m.status === 'measured' && m.lineCount).toBe(1);
      expect(wrappedLinesOf(t as never, copy)).toEqual([copy]);
    });
  }
  it('still breaks at an ordinary space', () => {
    const [m] = measureTextGeometry({ text: [t] } as unknown as StudioLayoutV2, { 0: 'Quality Assurance Workshop' });
    expect(m.status === 'measured' && m.lineCount).toBe(2);
  });
});

describe('the transfer plan records capitals only where the deck draws them', () => {
  // Before: the deck set cap="all" only where uppercaseApplies (no Arabic-script copy, no Arabic face),
  // while the plan recorded textTransform "uppercase" for every left-to-right capitals block. Core
  // reads the plan's textTransform into the frozen export policy, so a block the deck drew as typed
  // ("Cycle ٢٠٢٧", or Latin copy set in an Arabic face) was compared without regard to case.
  const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
  const layout = (copyFont: string): StudioLayoutV2 => ({
    version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 12, gutter: 22, baseline: 8 }, background: { color: '#FFFFFF' }, shapes: [],
    text: [{ copyIndex: 0, role: 'title', x: 76, y: 400, width: 928, height: 200, fontSize: 80, lineHeight: 1.2, fontFamily: copyFont as never, color: '#0A1628', align: 'left', bold: true, rtl: false, textTransform: 'uppercase' }],
    logo: { x: 76, y: 76, width: 173, height: 173 },
  });
  for (const [copy, font] of [['Accreditation Cycle ٢٠٢٧', 'Inter'], ['Accreditation Cycle 2027', 'Noto Sans Arabic']] as const) {
    it(`${copy} in ${font}`, async () => {
      const deck = await encodeStudioTransferV2(layout(font), [copy], { bytes: LOGO, mimeType: 'image/png', sha256: createHash('sha256').update(LOGO).digest('hex') });
      const slide = Object.entries(unzipSync(new Uint8Array(deck.bytes))).find(([n]) => /^ppt\/slides\/slide\d+\.xml$/.test(n))![1];
      const drawnInCapitals = /cap="all"/.test(strFromU8(slide));
      expect(drawnInCapitals).toBe(false);
      expect(deck.plan.text[0].textTransform).toBeUndefined();
    });
  }
  it('a Latin capitals block keeps both', async () => {
    const deck = await encodeStudioTransferV2(layout('Inter'), ['Accreditation Cycle 2027'], { bytes: LOGO, mimeType: 'image/png', sha256: createHash('sha256').update(LOGO).digest('hex') });
    expect(deck.plan.text[0].textTransform).toBe('uppercase');
  });
});

describe('the recipe solver promises hard QA\'s alignment check, as the composers do', () => {
  // Before: a title-only cut-out speaker set its title in the column beside the cut-out (x 432) and the
  // logo on the margin, and lined up 0.5 against hard QA's 0.70; a title-only mosaic on a story 0.5.
  // The solver handed them on, and hard QA always refused them (POOR_GRID_ALIGNMENT). It now treats
  // such a layout as infeasible, so the concept is replaced by one that can ship.
  const photos: SolverPhoto[] = [0, 1, 2, 3].map((i) => ({ photoIndex: i, width: 1280, height: 853, salient: { x: 0.45, y: 0.6 }, quiet: 'none' as const,
    ...(i === 3 ? { focus: { x: 0.3, y: 0.35 }, faceShare: 0.3, cutoutSize: { width: 600, height: 1100 }, cutoutPixelSize: { width: 600, height: 1100 } } : {}) }));
  for (const [recipe, width, height] of [['cutout_speaker', 1080, 1920], ['cutout_speaker', 1080, 1350], ['photo_mosaic', 1080, 1920]] as const) {
    it(`${recipe} ${width}x${height}, title only`, () => {
      let l: StudioLayoutV2 | undefined;
      try {
        l = solveRecipe({
          width, height, copy: { text: { 0: 'Workshop' } }, photos, photoSelection: { mode: 'choose', minimum: 1 }, palette: PALETTE, logoAspect: 1,
          choice: { recipe, heroPhotoIndex: recipe === 'cutout_speaker' ? 3 : 0, texturePhotoIndex: null, supportingPhotoIndices: recipe === 'photo_mosaic' ? [1, 2] : undefined,
            cutoutPhotoIndex: recipe === 'cutout_speaker' ? 3 : null, slots: [{ copyIndex: 0, slot: 'title' }], params: { frame: 'inset', align: 'start' } },
        });
      } catch (err) {
        if (!(err instanceof RecipeInfeasibleError)) throw err;
      }
      if (l) expect(computeLayoutMetrics(l).alignmentScore).toBeGreaterThanOrEqual(ALIGNMENT_POLICY.passScore);
    });
  }
});
