import { describe, expect, it } from 'vitest';
import { admitPageGrammarFromReference, PageGrammarInvalidError } from '../src/studio/page-grammar-admission.js';
import { GRAMMAR_PALETTE, grammarFixture } from './fixtures/page-grammar.js';

const reference = (pageGrammar: unknown, palette: unknown = GRAMMAR_PALETTE) => ({ rules: { palette, pageGrammar } });
function changed(path: string, value: unknown): unknown {
  const grammar = structuredClone(grammarFixture()) as Record<string, unknown>;
  const keys = path.split('.');
  let owner = grammar;
  for (const key of keys.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
  owner[keys[keys.length - 1]] = value;
  return grammar;
}

describe('pure client-neutral page grammar admission', () => {
  it('returns a typed copy without rewriting source or palette casing', () => {
    const input = reference(changed('body.color', '#ffffff'));
    const before = JSON.stringify(input);
    const grammar = admitPageGrammarFromReference(input);
    expect(grammar?.body.color).toBe('#ffffff');
    expect(grammar?.elements.rule).toBe('Synthetic optional ornament instruction');
    expect(grammar?.source).toBe('Synthetic grammar admission control');
    expect(JSON.stringify(input)).toBe(before);
    expect(grammar).not.toBe(input.rules.pageGrammar);
  });

  it('does not supply a grammar when absent, including for another client', () => {
    expect(admitPageGrammarFromReference({ clientId: 'another-client', rules: { palette: ['#123456'] } })).toBeUndefined();
    expect(admitPageGrammarFromReference({ rules: {} })).toBeUndefined();
  });

  it.each([undefined, null, false, 0, 'grammar', []])('refuses an explicitly supplied malformed value: %s', value => {
    expect(() => admitPageGrammarFromReference(reference(value))).toThrow(PageGrammarInvalidError);
  });

  it.each([
    ['header.accent.widthShare', '0.11'], ['header.accent.widthShare', NaN], ['header.accent.widthShare', Infinity],
    ['header.accent.widthShare', -0.1], ['header.logoWidthShare', 0], ['header.logoWidthShare', 1.01],
    ['header.rule.opacity', 1.01], ['cards.shadow.blurShare', Infinity], ['page.marginShare', 0.5],
    ['body.sizeShare', 0], ['body.lineHeight', 0], ['body.lineHeight', 5.01], ['title.letterSpacing', -1.01],
    ['cover.angle', Infinity], ['cover.angle', 361], ['cover.angle', -1], ['elements.sunburst.rays', 1.5],
    ['elements.sunburst.rays', 65], ['elements.trianglePattern.opacityOnDark', -0.1],
    ['body.bold', 'true'], ['body.fontFamily', ''], ['body.fontFamily', '  '], ['body.fontFamily', 'Inter\nInjected'],
    ['body.fontFamily', 'x'.repeat(129)], ['body.color', 'white'], ['cards.dark.fill', '#123456'],
  ])('refuses invalid %s at the correct field', (path, value) => {
    let error: unknown;
    try { admitPageGrammarFromReference(reference(changed(path, value))); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PageGrammarInvalidError);
    expect(error).toMatchObject({ code: 'PAGE_GRAMMAR_INVALID', field: `pageGrammar.${path}` });
  });

  it.each([
    [], [{ at: 0, color: '#336699' }],
    [{ at: 0.8, color: '#336699' }, { at: 0.2, color: '#FFD700' }],
    [{ at: 0.5, color: '#336699' }, { at: 0.5, color: '#FFD700' }],
    [{ at: 0.2, color: '#336699' }, { at: 0.8, color: '#FFD700' }],
    [{ at: -0.1, color: '#336699' }, { at: 1, color: '#FFD700' }],
    [{ at: 0, color: '#336699' }, { at: Infinity, color: '#FFD700' }],
    [{ at: 0, color: '#336699' }, { at: 1, color: '#123456' }],
    Array.from({ length: 9 }, (_, i) => ({ at: i / 8, color: '#336699' })),
  ].map(stops => [stops]))('refuses malformed, unordered or excessive gradients %#', stops => {
    expect(() => admitPageGrammarFromReference(reference(changed('header.accent.stops', stops)))).toThrow(PageGrammarInvalidError);
  });

  it('uses independent client palettes without rewriting source colours', () => {
    const grammar = grammarFixture();
    const raw = JSON.stringify(reference(grammar));
    const remapped = raw.replaceAll('#336699', '#AABBCC').replaceAll('#FFD700', '#445566');
    expect(admitPageGrammarFromReference(JSON.parse(remapped))?.header.accent.stops[1].color).toBe('#445566');
    expect(() => admitPageGrammarFromReference(reference(grammar, ['#FFFFFF', '#112233', '#AABBCC', '#445566']))).toThrow(PageGrammarInvalidError);
  });

  it.each([null, [], ['white'], Array(65).fill('#FFFFFF')].map(palette => [palette]))('refuses an unusable client palette %#', palette => {
    expect(() => admitPageGrammarFromReference(reference(grammarFixture(), palette))).toThrow('rules.palette');
  });

  it('refuses unknown fields without echoing their private names or values', () => {
    const input = changed('cards.shadow', { ...grammarFixture().cards.shadow, 'private-source-name': 'private-value' });
    expect(() => admitPageGrammarFromReference(reference(input))).toThrow('pageGrammar.cards.shadow violates');
    try { admitPageGrammarFromReference(reference(input)); } catch (error) {
      expect(String(error)).not.toMatch(/private-source-name|private-value/);
    }
  });
});
