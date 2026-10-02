import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getFontFidelityManifest, probeFontScripts, renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import { reviewFindings, evaluateHardQa, type HardQaContext } from '../src/studio/hard-qa.js';
import { resolveRsvgConvert } from '../src/studio/renderer-identity.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const assets = resolve(import.meta.dirname, '../assets/fonts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'hawa-fidelity-review-')); dirs.push(dir); return dir; };
function unidentifiedRenderer() {
  const file = join(folder(), 'rsvg-convert');
  const real = resolveRsvgConvert().replace(/'/g, `'\\''`);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 3; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return file;
}
const copy = 'Exact report wording.';
function layout(family = 'Amiri'): StudioLayoutV2 {
  return {
    version: 2, width: 1080, height: 1350,
    grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
    background: { color: '#FFFFFF' }, shapes: [],
    logo: { x: 490, y: 80, width: 100, height: 100 },
    text: [{ copyIndex: 0, role: 'body', x: 76, y: 300, width: 928, height: 100,
      fontSize: 28, lineHeight: 1.4, fontFamily: family, color: '#000000', align: 'center' }],
  };
}

describe('truthful font fidelity review (ADR202)', () => {
  it('retains an actual unmeasured probe in the manifest and warns for the used family', () => {
    const options = { rsvgConvertPath: unidentifiedRenderer() };
    expect(probeFontScripts('Amiri', options).arabic.verdict).toBe('unmeasured');
    const manifest = getFontFidelityManifest(assets, options);
    expect(manifest.Amiri).toBe('unmeasured');
    expect(reviewFindings(layout(), { fontFidelity: manifest })).toEqual([
      expect.objectContaining({ code: 'FONT_FIDELITY_UNMEASURED', severity: 'warning', message: expect.stringContaining('Amiri') }),
    ]);
  });

  it('honors the explicit measured font directory and preserves an uncovered verdict', () => {
    const dir = folder();
    copyFileSync(join(assets, 'HawaSymbols-Regular.ttf'), join(dir, 'Amiri-Regular.ttf'));
    expect(probeFontScripts('Amiri', { fontsDir: dir }).arabic.verdict).toBe('uncovered');
    const manifest = getFontFidelityManifest(dir);
    expect(manifest.Amiri).toBe('uncovered');
    expect(reviewFindings(layout(), { fontFidelity: manifest }).map(f => f.code)).toEqual(['FONT_FIDELITY_UNCOVERED']);
  });

  it('retains actual render fidelity evidence and live wording without changing the layout', () => {
    const original = layout(); const before = structuredClone(original);
    const result = renderLayoutV2ToSvg(original, { rsvgConvertPath: unidentifiedRenderer(), logoDataUri: KAAE_TEST_LOGO, copyText: { 0: copy } });
    expect(result.fontFidelity.Amiri).toBe('unmeasured');
    expect(Object.keys(result.fontFidelity)).toEqual(['Amiri']);
    expect(result.svg).toContain(copy);
    expect(original).toEqual(before);
    expect(reviewFindings(original, { fontFidelity: result.fontFidelity }).map(f => f.code)).toEqual(['FONT_FIDELITY_UNMEASURED']);
  });

  it('reports a requested family outside the static default report list', () => {
    const requested = 'Hawa Symbols';
    const result = renderLayoutV2ToSvg(layout(requested), { logoDataUri: KAAE_TEST_LOGO, copyText: { 0: copy } });
    expect(Object.keys(result.fontFidelity)).toEqual([requested]);
    expect(['exact', 'stand-in', 'uncovered', 'unmeasured']).toContain(result.fontFidelity[requested]);
  });

  it('retains prototype-like family names as own data fields in the public report', () => {
    const manifest = getFontFidelityManifest(assets, { rsvgConvertPath: unidentifiedRenderer() }, ['__proto__']);
    expect(Object.hasOwn(manifest, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(manifest)).__proto__).toBe('unmeasured');
    expect(Object.getPrototypeOf(manifest)).toBe(Object.prototype);
  });

  it('runs fidelity raster probes only for the requested layout family and its sentinels', () => {
    const dir = folder(); const file = join(dir, 'rsvg-convert'); const log = join(dir, 'calls');
    const real = resolveRsvgConvert().replace(/'/g, `'\\''`);
    writeFileSync(file, `#!/bin/sh\nif [ "$1" != "--version" ]; then /usr/bin/grep -o 'font-family="[^"]*"' "$3" >> '${log}'; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
    renderLayoutV2ToSvg(layout(), { rsvgConvertPath: file, logoDataUri: KAAE_TEST_LOGO, copyText: { 0: copy } });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(4);
    expect(new Set(calls)).toEqual(new Set(['font-family="Amiri"', 'font-family="ZZHawaNoSuchFamilyZZ"']));
  });

  it('flags a missing entry in supplied evidence and leaves preliminary no-manifest checks alone', () => {
    expect(reviewFindings(layout(), {})).toEqual([]);
    expect(reviewFindings(layout(), { fontFidelity: {} }).map(f => f.code)).toEqual(['FONT_FIDELITY_UNMEASURED']);
  });

  it('preserves exact and stand-in controls, deduplicates repeated blocks and does not warn about unused families', () => {
    const l = layout(); l.text.push({ ...l.text[0], copyIndex: 1, y: 500 });
    expect(reviewFindings(l, { fontFidelity: { Amiri: 'exact', Inter: 'stand-in' } })).toEqual([]);
    const warnings = reviewFindings(l, { fontFidelity: { Amiri: 'stand-in' } });
    expect(warnings.map(f => f.code)).toEqual(['FONT_SUBSTITUTED']);
    expect(warnings[0].message).toContain('blocks 0, 1');
  });

  it('keeps the warning advisory and retains hard QA and exact copy', () => {
    const l = layout();
    const manifest = getFontFidelityManifest(assets, { rsvgConvertPath: unidentifiedRenderer() });
    const context: HardQaContext = { width: 1080, height: 1350, palette: ['#FFFFFF', '#000000'], copyText: { 0: copy },
      copyScripts: ['latin'], latinFont: 'Amiri', arabicFont: 'Amiri', logoAspect: 1 };
    const baseline = evaluateHardQa(l, context);
    const result = evaluateHardQa(l, { ...context, fontFidelity: manifest });
    expect(baseline.passed).toBe(true);
    expect(result.passed).toBe(baseline.passed);
    expect(result.defectCodes).toEqual(baseline.defectCodes);
    expect(result.findings.map(f => f.code)).toEqual(['FONT_FIDELITY_UNMEASURED']);
    expect(context.copyText).toEqual({ 0: copy });
  });
});
