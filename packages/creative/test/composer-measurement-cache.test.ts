import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { measureTextWidth, wrapTextWithFontkit } from '../src/studio/render-layout-v2.js';
import { pageGrammarFromRaw } from '../src/studio/page-grammar.js';
import { composePosterLayout, POSTER_VARIANTS } from '../src/studio/poster-grammar.js';

/**
 * The poster composer's measurement caches change no number (scripts/poster_composer_snapshot.ts
 * proves every composed layout byte-identical): a cached width is the width fontkit's own run gives,
 * at any size and tracking, and a title no poster can carry is refused in well under a second (it
 * took ~4 s per composition, ~35 s on the CI runner, before).
 */
const fk = ((fontkit as any).default || fontkit) as typeof fontkit;
const font = (file: string) => fk.create(readFileSync(new URL(`../assets/fonts/${file}`, import.meta.url))) as any;
const direct = (f: any, text: string, size: number, tracking: number) => {
  const run = f.layout(text);
  return run.advanceWidth * (size / f.unitsPerEm) + (tracking ? (run.glyphs.length - 1) * (tracking * size) : 0);
};

describe('the composer\'s measurement caches', () => {
  it('a cached width is the width of fontkit\'s own run, at every size and tracking, Latin and Sorani', () => {
    for (const [file, text] of [['Inter-Black.ttf', 'EXACT TITLE OF A VERY LONG ANNOUNCEMENT'], ['IBMPlexSansArabic-Bold.ttf', 'وۆرکشۆپی دڵنیایی جۆری']] as const) {
      const f = font(file);
      for (const size of [17, 108, 216]) {
        for (const tracking of [0, -0.02, 0.1]) {
          // Twice: the first call shapes, the second reads the cache.
          expect(measureTextWidth(text, f, size, tracking)).toBe(direct(f, text, size, tracking));
          expect(measureTextWidth(text, f, size, tracking)).toBe(direct(f, text, size, tracking));
        }
      }
      expect(wrapTextWithFontkit(text, 300, f, 40)).toEqual(wrapTextWithFontkit(text, 300, font(file), 40));
    }
  });

  it('a title no poster can carry is refused quickly', () => {
    const raw = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
    const lines = ['EXACT TITLE OF A VERY LONG ANNOUNCEMENT THAT RUNS ON AND ON '.repeat(4).trim(), 'Exact body text line. Never rewrite it.'];
    const started = performance.now();
    for (const variant of POSTER_VARIANTS) {
      expect(() => composePosterLayout({
        width: 1080, height: 1350, grammar: pageGrammarFromRaw(raw)!, copy: { text: { 0: lines[0], 1: lines[1] } }, roles: { 0: 'title', 1: 'body' },
        logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone: 'page', variant,
        fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' },
      })).toThrow(/GRAMMAR_INFEASIBLE/);
    }
    // Generous for a CI runner: the three take ~0.1 s on the development Mac (~11 s before).
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
