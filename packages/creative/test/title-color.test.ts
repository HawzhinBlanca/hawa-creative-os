import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  prepareGeneratedLayoutV3,
  resolveOrnamentSettings,
  evaluateHardQa,
  renderLayoutV2ToSvg,
  studioReferenceFromRaw,
  declaredBackgroundColour,
  calculateLuminanceContrastRatio,
  hexToLuminance,
  requiredContrast,
  NEUTRAL_STYLE_SPEC,
  type StyleSpec,
  type StudioLayoutV2,
} from '../src/index.js';

/**
 * The owner's correction of 2026-09-20: "Title color shouldnt be Gold, should be based on the
 * design." The client's brand rules said the title must be Kurdistan Sun Gold, the rules only
 * started reaching the brief that week (125ea66), and the two designs delivered that morning came
 * back with the whole title gold against an owner reference that shows a white title with only
 * "EDITION 2.0" in gold.
 *
 * The fixture is the real task's three prepared candidates and the spec the live brief read off
 * that reference; its `spec` predates `titleColor`, so these tests add the decision themselves.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reference-k12-89c242f2.json', import.meta.url), 'utf8')) as {
  spec: StyleSpec;
  copy: { ckb: string[]; en: string[] };
  layouts: StudioLayoutV2[];
};
const rawReference = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const reference = studioReferenceFromRaw(rawReference);
// ADR-236: the brand guideline's palette. The fixture's midnight-navy ground snaps to its indigo.
const GOLD = '#E8B85C';
const NAVY = '#17087A';
const LIGHT = ['#FFFFFF', '#FFF2DB'];

const copyOf = (lang: 'ckb' | 'en') => ({
  text: Object.fromEntries(fixture.copy[lang].map((b, i) => [i, b])),
});

/** A candidate of the real task, with the copy's script applied to every block. */
const candidate = (lang: 'ckb' | 'en', k: number): StudioLayoutV2 => {
  const raw = JSON.parse(JSON.stringify(fixture.layouts[k])) as StudioLayoutV2;
  for (const t of raw.text) {
    t.rtl = lang === 'ckb';
    if (lang === 'en' && /Amiri|Noto Sans Arabic/.test(t.fontFamily)) t.fontFamily = 'Playfair Display';
  }
  return raw;
};

const prepare = (layout: StudioLayoutV2, lang: 'ckb' | 'en', style?: StyleSpec) =>
  prepareGeneratedLayoutV3(layout, copyOf(lang), {
    width: 1080,
    height: 1350,
    logoAspect: 1,
    palette: reference.palette,
    ornament: resolveOrnamentSettings({}),
    ...(style ? { style } : {}),
  });

const titleOf = (layout: StudioLayoutV2) => layout.text.find((t) => t.role === 'title')!;

describe("the title takes the design's colour, not a standing gold rule", () => {
  // The delivered designs, reproduced: the promoted rule made the generator set the whole title in
  // gold. The reference says light, so preparation must take it back to light and leave the gold
  // for the edition line alone.
  for (const lang of ['ckb', 'en'] as const) {
    it(`${lang}: a light-title spec undoes an all-gold title and keeps the gold last line`, () => {
      const raw = candidate(lang, 0);
      titleOf(raw).color = GOLD;
      const layout = prepare(raw, lang, { ...fixture.spec, titleColor: 'light' });
      const title = titleOf(layout);
      expect(LIGHT).toContain(title.color);
      expect(title.accentColor).toBe(GOLD);
    });
  }

  it('draws only the edition line in gold under a light title', () => {
    const raw = candidate('en', 0);
    titleOf(raw).color = GOLD;
    const layout = prepare(raw, 'en', { ...fixture.spec, titleColor: 'light' });
    const { svg } = renderLayoutV2ToSvg(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: copyOf('en').text });
    expect(svg).toMatch(/<tspan[^>]*fill="#E8B85C"[^>]*>EDITION 2\.0<\/tspan>/);
    // The title wraps to "K-12 STANDARDS" / "FRAMEWORK" / "EDITION 2.0" at this size. Only the
    // accent line carries a fill of its own; the rest take the title's light colour.
    expect(svg).toMatch(/<tspan(?![^>]*fill=)[^>]*>K-12 STANDARDS<\/tspan>/);
    expect(svg).toMatch(/<tspan(?![^>]*fill=)[^>]*>FRAMEWORK<\/tspan>/);
    expect(svg).toMatch(/<text id="text-copy-0" fill="#(FFFFFF|FFF2DB)"/);
  });

  it('still sets the whole title gold when the reference shows a gold title', () => {
    const layout = prepare(candidate('en', 0), 'en', { ...fixture.spec, titleColor: 'gold' });
    expect(titleOf(layout).color).toBe(GOLD);
  });

  it('keeps a light title the design already has', () => {
    const layout = prepare(candidate('en', 1), 'en', { ...fixture.spec, titleColor: 'light' });
    expect(LIGHT).toContain(titleOf(layout).color);
  });
});

describe('a title colour never breaks the contrast the house rules require', () => {
  const contrastOf = (layout: StudioLayoutV2) => {
    const title = titleOf(layout);
    return {
      ratio: calculateLuminanceContrastRatio(hexToLuminance(title.color), hexToLuminance(declaredBackgroundColour(layout, title))),
      required: requiredContrast(title.fontSize, Boolean(title.bold)),
    };
  };

  it('refuses a dark title on the navy background this client asks for', () => {
    const layout = prepare(candidate('en', 0), 'en', { ...fixture.spec, titleColor: 'dark' });
    expect(layout.background.color).toBe(NAVY);
    // Midnight navy on midnight navy is 1.0:1, so the generator's own colour stands.
    expect(titleOf(layout).color).not.toBe(NAVY);
    const { ratio, required } = contrastOf(layout);
    expect(ratio).toBeGreaterThanOrEqual(required);
  });

  it('applies a dark title over a light ground', () => {
    const raw = candidate('en', 0);
    raw.background = { ...raw.background, color: '#FFF2DB' };
    raw.shapes = (raw.shapes || []).filter((s) => s.role !== 'panel');
    const layout = prepare(raw, 'en', { ...fixture.spec, titleColor: 'dark', cta: 'as_generated' });
    const title = titleOf(layout);
    expect(hexToLuminance(title.color)).toBeLessThan(0.2);
    const { ratio, required } = contrastOf(layout);
    expect(ratio).toBeGreaterThanOrEqual(required);
  });

  it('leaves every candidate readable and passing hard QA under each title colour', () => {
    for (const titleColor of ['light', 'gold', 'dark'] as const) {
      for (const lang of ['ckb', 'en'] as const) {
        for (const k of [0, 1, 2]) {
          const layout = prepare(candidate(lang, k), lang, { ...fixture.spec, titleColor });
          const { ratio, required } = contrastOf(layout);
          expect(ratio, `${titleColor} ${lang} ${k}`).toBeGreaterThanOrEqual(required);
          const qa = evaluateHardQa(layout, {
            width: 1080,
            height: 1350,
            copyScripts: fixture.copy[lang].map(() => (lang === 'ckb' ? 'arabic' : 'latin')),
            latinFont: reference.latinFont,
            arabicFont: reference.arabicFont,
            palette: reference.palette,
            logoAspect: 1,
            copyText: copyOf(lang).text,
          });
          expect(qa.passed, `${titleColor} ${lang} ${k}: ${qa.messages.join('; ')}`).toBe(true);
          // Colour remains readable; mixed-script fit uses actual fallback measurements.
          expect(qa.defectCodes).toEqual([]);
        }
      }
    }
  });
});

describe('a spec that decides no title colour changes nothing', () => {
  it("leaves the layout exactly as 'as_generated' and as no spec at all", () => {
    const raw = () => candidate('ckb', 0);
    const plain = prepare(raw(), 'ckb');
    const neutral = prepare(raw(), 'ckb', { ...NEUTRAL_STYLE_SPEC });
    expect(neutral).toEqual(plain);
    // The whole spec, with and without the key: only the title's colour may differ.
    const withKey = prepare(raw(), 'ckb', { ...fixture.spec, titleColor: 'as_generated' });
    const without = prepare(raw(), 'ckb', { ...fixture.spec });
    expect(withKey).toEqual(without);
  });
});

describe("the client's brand rules make gold an accent, not a mandate on titles", () => {
  const colorUsage: string = rawReference.rules.colorUsage;

  it('no longer requires every title to be Sun Gold', () => {
    expect(colorUsage).not.toMatch(/titles?[^.]*must be[^.]*gold/i);
    expect(colorUsage).toMatch(/accent/i);
  });

  it('states the brand guideline\'s light-first rules (ADR-236)', () => {
    expect(colorUsage).toContain('The default page is White (#FFFFFF) or Cream (#FFF2DB)');
    expect(colorUsage).toContain('Indigo (#17087A) and Royal Indigo (#3833A3) are for header bands, plates, panels, tabs and scrims');
    expect(colorUsage).toContain('Gold (#E8B85C) only for thin rules, frames, borders and small accents');
    expect(colorUsage).toContain('Use an Indigo page only when the brief or the photo calls for it');
    expect(colorUsage).toContain('Never use colours outside this palette.');
    // The navy-only rule of one dark invitation, and its ban on the guideline's own indigo, are gone.
    expect(colorUsage).not.toMatch(/Midnight Navy|#0A1628|Never use purple, violet, indigo/);
  });

  it('reaches the brief as the promoted rules, unchanged', () => {
    expect(studioReferenceFromRaw(rawReference).promotedRules).toBe(colorUsage);
  });
});
