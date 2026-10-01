import { describe, expect, it } from 'vitest';
import { solveRecipe } from '../src/studio/art-direction/solver.js';
import { candidateRecipeTypeScales, TYPE_SCALE_SEARCH_LIMITS, type RecipeTypeScalePolicy } from '../src/studio/art-direction/type-scale-search.js';
import { MISSED_TYPE_SCALE_INPUT } from './fixtures/type-scale-input.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

describe('bounded joint typography search (ADR203)', () => {
  it('uses a measured title/body scale missed by the coarse factor grid', () => {
    const input = structuredClone(MISSED_TYPE_SCALE_INPUT), before = structuredClone(input);
    const layout = solveRecipe(input);
    expect(layout.text.find(t => t.copyIndex === 0)?.fontSize).toBeGreaterThanOrEqual(56);
    expect(layout.text.find(t => t.copyIndex === 1)?.fontSize).toBeGreaterThanOrEqual(25);
    expect(input).toEqual(before);
    expect(layout.photos?.map(p => p.photoIndex)).toEqual([0]);
  });

  it('retains improved native type sizes, exact live copy and original source photo bytes in transfer', async () => {
    const layout = solveRecipe(structuredClone(MISSED_TYPE_SCALE_INPUT));
    const copy = Object.values(MISSED_TYPE_SCALE_INPUT.copy.text);
    const logo = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const image = new PNG({ width: 2400, height: 1800 }); image.data.fill(255);
    const photo = PNG.sync.write(image);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const transfer = await encodeStudioTransferV2(layout, copy, { bytes: logo, sha256: hash(logo), mimeType: 'image/png' },
      { photos: [{ bytes: photo, mimeType: 'image/png' }, { bytes: photo, mimeType: 'image/png' }] });
    const files = unzipSync(transfer.bytes), slide = strFromU8(files['ppt/slides/slide1.xml']);
    expect(transfer.manifest.copy).toEqual(copy);
    for (const text of copy) expect(slide).toContain(`<a:t>${text}</a:t>`);
    expect(slide).toContain(`sz="${layout.text[0].fontSize * 75}"`);
    expect(Object.entries(files).some(([name, data]) => name.startsWith('ppt/media/') && hash(data) === hash(photo))).toBe(true);
  });

  it('includes the exact minimum and all independently enumerated rounded states in order', () => {
    const policy = { naturalTitle: 71.28, naturalBody: 34.56, minimumBody: 18, minimumFont: 12, titleToBodyMinimum: 2.2 };
    const states = candidateRecipeTypeScales(policy);
    const key = (s: { title: number; accent: number; body: number; footer: number }) => `${s.title},${s.accent},${s.body},${s.footer}`;
    const keys = new Set(states.map(key));
    // Independent dense factor oracle, using the original recipe's size equations.
    for (let i = 0; i <= 20000; i++) {
      const factor = 1 - i / 40000;
      const body = Math.max(18, Math.round(34.56 * Math.min(1, factor + .12)));
      const title = Math.max(Math.ceil(2.2 * body), Math.round(71.28 * factor));
      expect(keys.has(key({ title, accent: Math.round(title * .92), body, footer: Math.max(12, Math.min(body, Math.round(body * .82))) }))).toBe(true);
    }
    expect(states.at(-1)).toEqual({ title: 47, accent: 43, body: 21, footer: 17 });
    expect(states.length).toBeLessThanOrEqual(TYPE_SCALE_SEARCH_LIMITS.states);
    expect(keys.size).toBe(states.length);
    for (let i = 1; i < states.length; i++) {
      expect(states[i].title).toBeLessThanOrEqual(states[i - 1].title);
      expect(states[i].body).toBeLessThanOrEqual(states[i - 1].body);
    }
  });

  it('retains the fixed hierarchy/floors and clamps body sizing at its natural maximum', () => {
    expect(candidateRecipeTypeScales({ naturalTitle: 12, naturalBody: 8, minimumBody: 2, minimumFont: 1, titleToBodyMinimum: 2.2 })).toEqual([
      { title: 18, accent: 17, body: 8, footer: 7 }, { title: 16, accent: 15, body: 7, footer: 6 },
      { title: 14, accent: 13, body: 6, footer: 5 }, { title: 11, accent: 10, body: 5, footer: 4 },
    ]);
  });

  it('returns one maximum state for a zero-width search range', () => {
    expect(candidateRecipeTypeScales({ naturalTitle: 100, naturalBody: 30, minimumBody: 12, minimumFont: 12, titleToBodyMinimum: 2.2 }, 1))
      .toEqual([{ title: 100, accent: 92, body: 30, footer: 25 }]);
  });

  it.each([-1, 1.1, NaN, Infinity])('refuses invalid minimum factor %s', minimum => {
    expect(() => candidateRecipeTypeScales({ naturalTitle: 100, naturalBody: 30, minimumBody: 12, minimumFont: 12, titleToBodyMinimum: 2.2 }, minimum))
      .toThrow('TYPE_SCALE_SEARCH_INVALID');
  });

  it.each([
    { naturalTitle: Infinity }, { naturalBody: NaN }, { minimumBody: 0 }, { minimumFont: 1.5 },
  ])('refuses invalid policy %j before enumeration', change => {
    const policy: RecipeTypeScalePolicy = { naturalTitle: 100, naturalBody: 30, minimumBody: 12, minimumFont: 12, titleToBodyMinimum: 2.2, ...change };
    expect(() => candidateRecipeTypeScales(policy)).toThrow('TYPE_SCALE_SEARCH_INVALID');
  });

  it.each([.5, 1])('refuses unsafe huge transition indices even at minimum factor %s', minimum => {
    expect(() => candidateRecipeTypeScales({ naturalTitle: 1e100, naturalBody: 30, minimumBody: 12, minimumFont: 12, titleToBodyMinimum: 2.2 }, minimum))
      .toThrow('TYPE_SCALE_SEARCH_LIMIT');
  });

  it('refuses finite oversized state enumeration and unsafe multiplied type sizes', () => {
    const policy = { naturalTitle: 1e6, naturalBody: 30, minimumBody: 12, minimumFont: 12, titleToBodyMinimum: 2.2 };
    expect(() => candidateRecipeTypeScales(policy)).toThrow('TYPE_SCALE_SEARCH_LIMIT');
    expect(() => candidateRecipeTypeScales({ ...policy, naturalTitle: 1400 })).toThrow('distinct scale budget');
    expect(() => candidateRecipeTypeScales({ ...policy, naturalTitle: 100, titleToBodyMinimum: 1e308 })).toThrow('TYPE_SCALE_SEARCH_LIMIT');
  });
});
