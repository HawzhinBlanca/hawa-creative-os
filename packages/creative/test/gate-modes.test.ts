import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  prepareGeneratedLayoutV3,
  resolveOrnamentSettings,
  pageGrammarFromRaw,
  evaluateHardQa,
  measureDesignV3,
  studioReferenceFromRaw,
  type StudioLayoutV2,
} from '../src/index.js';
// The gate is a proof script, not a package, so the test reaches it by path. Importing it at all is
// part of what is under test: until 2026-09-20 the script exported nothing and ran its corpus work
// at import time, so no other caller could reuse its idea of what production runs.
// @ts-expect-error -- a plain .mjs proof script with no type declarations
import { productionModes, readStyleFixtures, verdictTokens, BASELINE_PATH } from '../../../scripts/proofs/reprepare_stored_runs.mjs';

/**
 * The regression gate (`scripts/proofs/reprepare_stored_runs.mjs`) re-prepares the stored corpus and
 * is the last check before a paid run. Until 2026-09-20 it called preparation with only
 * `{width, height, logoAspect, palette}` while production also passes `ornament` and `style`, so it
 * scored a layout production never produces. Over the 200 stored designs the owner's real StyleSpec
 * (task 89c242f2) takes hard QA from 195/200 to 143/200 (51 OVERLAP, 14 COPY_ORDER, 4 COPY_OVERFLOW,
 * 2 LOGO) and the gate still exited 0.
 *
 * That corpus is gitignored (`output/proofs/**\/briefs/`), so these checks run the committed fixture
 * designs through the same mode list instead. They are the gate's foothold where the corpus is absent.
 */
const reference = studioReferenceFromRaw(
  JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'))
);
const ARABIC = /[؀-ۿ]/;

type Design = { id: string; layout: StudioLayoutV2; blocks: string[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** A handful of committed designs: the three candidates of task 89c242f2 in both languages, and the
 * three cheap-tier layouts kept as fixtures for earlier preparation bugs. */
function committedDesigns(): Design[] {
  const out: Design[] = [];
  const ref = fixture('reference-k12-89c242f2.json') as { copy: Record<'ckb' | 'en', string[]>; layouts: StudioLayoutV2[] };
  ref.layouts.forEach((layout, i) => {
    for (const lang of ['ckb', 'en'] as const) out.push({ id: `reference-${lang}-${i}`, layout, blocks: ref.copy[lang] });
  });
  for (const name of [
    'cheap-tier-dead-band-8fb76534.json',
    'cheap-tier-overflow-1f392e16.json',
    'cheap-tier-stroke-slab-brief_08.json',
  ]) {
    const f = fixture(name) as { copy: string[]; layout: StudioLayoutV2 };
    out.push({ id: name.replace('.json', ''), layout: f.layout, blocks: f.copy });
  }
  return out;
}

/** Exactly what the gate does to one design in one mode: prepare, then judge before and after. */
function gradeDesign(design: Design, options: Record<string, unknown>) {
  const copy = {
    text: Object.fromEntries(design.blocks.map((t, i) => [i, t])),
    scripts: Object.fromEntries(design.blocks.map((t, i) => [i, ARABIC.test(t) ? 'arabic' as const : 'latin' as const])),
  };
  const raw = JSON.parse(JSON.stringify(design.layout)) as StudioLayoutV2;
  const qaContext = {
    width: raw.width,
    height: raw.height,
    copyScripts: design.blocks.map((t) => (ARABIC.test(t) ? 'arabic' as const : 'latin' as const)) as ('arabic' | 'latin')[],
    latinFont: reference.latinFont,
    arabicFont: reference.arabicFont,
    palette: reference.palette,
    logoAspect: 1,
    copyText: copy.text,
  };
  const judge = (l: StudioLayoutV2) => ({ metrics: measureDesignV3(l, copy), qa: evaluateHardQa(l, qaContext) });
  const before = judge(JSON.parse(JSON.stringify(raw)) as StudioLayoutV2);
  const prepared = prepareGeneratedLayoutV3(raw, copy, {
    width: raw.width,
    height: raw.height,
    logoAspect: 1,
    palette: reference.palette,
    ...options,
  });
  const after = judge(prepared);
  return { qa: after.qa, tokens: verdictTokens(before, after) as string[] };
}

describe('the regression gate runs the option sets production runs', () => {
  it('covers every option the layouts stage passes to preparation', () => {
    // Read from production's own call site rather than restating it here: the gate went blind
    // because `ornament` and `style` were added there and nowhere else (f80733c, 2026-09-19).
    const stage = readFileSync(
      new URL('../../../apps/core/src/services/design-studio/stages/layouts.stage.ts', import.meta.url),
      'utf8'
    );
    const call = /prepareGeneratedLayoutV3\(rawLayout, copy, \{([\s\S]*?)\n {6}\}\)/.exec(stage);
    expect(call, 'the layouts stage no longer calls preparation in the shape this test reads').not.toBeNull();
    const passed = [...call![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(passed).toContain('style');

    const modes = productionModes({ resolveOrnamentSettings, pageGrammarFromRaw }) as { name: string; options: Record<string, unknown> }[];
    // Always supplied by the gate for every mode, so no mode needs to name them.
    const base = ['width', 'height', 'logoAspect', 'palette'];
    const covered = new Set(modes.flatMap((m) => Object.keys(m.options)));
    // `background` is the brand colour a single client names in one request. No stored brief records
    // one, so no mode over the stored corpus can carry it; it is covered by client-direction.test.ts.
    const exempt = ['background'];
    const uncovered = passed.filter((k) => !base.includes(k) && !exempt.includes(k) && !covered.has(k));
    expect(uncovered, `production passes ${uncovered.join(', ')} and the gate never does`).toEqual([]);
  });

  it('is one mode per committed style reference, each carrying ornament as production does', () => {
    const fixtures = readStyleFixtures() as { name: string; spec: Record<string, unknown> }[];
    expect(fixtures.length, 'no reference-*.json fixture left to gate the style path').toBeGreaterThan(0);

    const modes = productionModes({ resolveOrnamentSettings, pageGrammarFromRaw }) as { name: string; options: Record<string, unknown> }[];
    expect(modes.map((m) => m.name)).toEqual(['plain', 'ornament', ...fixtures.map((f) => `style:${f.name}`), 'grammar']);
    for (const mode of modes.filter((m) => m.name.startsWith('style:'))) {
      // Production never passes a style without ornament, and `ornamentForStyle` lets the spec
      // override the texture and dividers. A style mode without ornament would run neither path.
      expect(mode.options.ornament, `${mode.name} drops the ornament production always passes`).toBeTruthy();
      expect(mode.options.style, `${mode.name} carries no spec`).toBeTruthy();
    }
  });

  it('has a recorded baseline for every mode, so a new reference cannot enter ungated', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH as string, 'utf8')) as { modes: Record<string, unknown> };
    const modes = productionModes({ resolveOrnamentSettings, pageGrammarFromRaw }) as { name: string }[];
    const missing = modes.map((m) => m.name).filter((n) => !baseline.modes[n]);
    expect(missing, `run the gate with --update-baseline: no numbers recorded for ${missing.join(', ')}`).toEqual([]);
  });

  it('measures every committed design in every mode without throwing', () => {
    const designs = committedDesigns();
    expect(designs.length).toBe(9);
    const modes = productionModes({ resolveOrnamentSettings, pageGrammarFromRaw }) as { name: string; options: Record<string, unknown> }[];
    for (const mode of modes) for (const d of designs) expect(() => gradeDesign(d, mode.options)).not.toThrow();
    // About 19 s alone since ADR-273's union measure; 30 s timed out under the full suite's load.
  }, 90_000);

  it('sees on the fixtures what a plain-only gate could not: the spec changes the verdict', () => {
    const designs = committedDesigns();
    const modes = productionModes({ resolveOrnamentSettings, pageGrammarFromRaw }) as { name: string; options: Record<string, unknown> }[];
    const plain = modes.find((m) => m.name === 'plain')!;
    const styles = modes.filter((m) => m.name.startsWith('style:'));

    const diverged: string[] = [];
    for (const style of styles) {
      for (const d of designs) {
        const a = gradeDesign(d, plain.options);
        const b = gradeDesign(d, style.options);
        if (a.tokens.join(' ') !== b.tokens.join(' ')) diverged.push(`${style.name}/${d.id}: [${a.tokens}] -> [${b.tokens}]`);
      }
    }
    // Measured 2026-09-20 at 125ea66: all nine fixture designs gain a typeScale failure under the
    // owner's spec (titleScale 'dominant'), and cheap-tier-overflow-1f392e16 passes hard QA plain
    // and fails OVERLAP with the spec, the same defect that is 51 of the corpus's 57 style failures.
    // Asserting that at least one design diverges, not which, so a fix to preparation improves this
    // number instead of breaking the test.
    expect(diverged.length, 'the style modes score exactly what plain scores, so they gate nothing').toBeGreaterThan(0);
  });
});
