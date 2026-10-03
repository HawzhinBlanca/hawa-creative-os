import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { composeGrammarLayout, pageGrammarFromRaw, GrammarInfeasibleError, type ComposeGrammarInput } from '../src/studio/page-grammar.js';
import { composePosterLayout, POSTER_VARIANTS } from '../src/studio/poster-grammar.js';
import { measureTextGeometry } from '../src/studio/render-layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { studioReferenceFromRaw } from '../src/studio/hard-qa.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { checkCanvaPptx } from '../../qa/src/canva-pptx-check.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

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
