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
