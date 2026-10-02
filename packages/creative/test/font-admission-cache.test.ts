import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { admittedFontFaces, admittedFontFace, loadRenderFontRegistry } from '../src/studio/render-layout-v2.js';

const assets = resolve(import.meta.dirname, '../assets/fonts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hawa-font-admission-cache-'));
  dirs.push(dir);
  const registryPath = join(dir, 'registry.json');
  const regular = join(dir, 'Amiri-Regular.ttf');
  const bold = join(dir, 'Amiri-Bold.ttf');
  copyFileSync(join(assets, 'Amiri-Regular.ttf'), regular);
  copyFileSync(join(assets, 'Amiri-Bold.ttf'), bold);
  const source = loadRenderFontRegistry();
  const registry = structuredClone(source);
  registry.families = { Amiri: { ...registry.families.Amiri, files: { regular, bold } } };
  writeFileSync(registryPath, JSON.stringify(registry));
  const query = { script: 'arabic' as const, role: 'display' as const, fontsDir: dir, registryPath };
  return { dir, regular, bold, registryPath, registry, query };
}

describe('current font admission cache basis (ADR200)', () => {
  it('refuses warmed admission immediately after same-path revocation and restores on re-admission', () => {
    const f = fixture();
    const before = admittedFontFaces(f.query);
    expect(before.map(face => face.name)).toEqual(['Amiri']);
    f.registry.families.Amiri.admitted = false;
    writeFileSync(f.registryPath, JSON.stringify(f.registry));
    expect(() => admittedFontFaces(f.query)).toThrow(/No admitted/);
    f.registry.families.Amiri.admitted = true;
    writeFileSync(f.registryPath, JSON.stringify(f.registry));
    expect(admittedFontFaces(f.query)).toEqual(before);
  });

  it('does not reuse a warmed answer after policy corruption or deletion', () => {
    const f = fixture();
    admittedFontFaces(f.query);
    writeFileSync(f.registryPath, '{invalid');
    expect(() => admittedFontFaces(f.query)).toThrow();
    unlinkSync(f.registryPath);
    expect(() => admittedFontFaces(f.query)).toThrow(/Font registry not found/);
    writeFileSync(f.registryPath, JSON.stringify(f.registry));
    expect(admittedFontFaces(f.query).map(face => face.name)).toEqual(['Amiri']);
  });

  it('refuses replacement with a file missing Sorani glyphs, even with restored mtime, through actual family selection', () => {
    const f = fixture();
    expect(admittedFontFace('Amiri', f.query)).toBe('Amiri');
    const stamp = statSync(f.regular);
    copyFileSync(join(assets, 'Cairo-Regular.ttf'), f.regular);
    utimesSync(f.regular, stamp.atime, stamp.mtime);
    expect(() => admittedFontFace('Amiri', f.query)).toThrow(/No admitted/);
    copyFileSync(join(assets, 'Amiri-Regular.ttf'), f.regular);
    expect(admittedFontFace('Amiri', f.query)).toBe('Amiri');
  });

  it('refuses missing and corrupt measured font files rather than inheriting a warmed answer', () => {
    const f = fixture();
    admittedFontFaces(f.query);
    unlinkSync(f.regular);
    expect(() => admittedFontFaces(f.query)).toThrow(/No admitted/);
    writeFileSync(f.regular, 'not a font');
    expect(() => admittedFontFaces(f.query)).toThrow(/No admitted/);
    copyFileSync(join(assets, 'Amiri-Regular.ttf'), f.regular);
    expect(admittedFontFaces(f.query).map(face => face.name)).toEqual(['Amiri']);
  });

  it('refreshes declared weight presence without changing the existing no-bold fallback policy', () => {
    const f = fixture();
    expect(admittedFontFaces({ ...f.query, bold: true })[0].hasBold).toBe(true);
    unlinkSync(f.bold);
    const after = admittedFontFaces({ ...f.query, bold: true });
    expect(after[0].hasBold).toBe(false);
    expect(after[0].weights).toEqual(['regular']);
    copyFileSync(join(assets, 'Amiri-Bold.ttf'), f.bold);
    expect(admittedFontFaces({ ...f.query, bold: true })[0].hasBold).toBe(true);
  });

  it('retains unchanged-input hits, including a byte-identical policy rewrite, and refreshes role revocation', () => {
    const f = fixture();
    const before = admittedFontFaces(f.query);
    expect(admittedFontFaces(f.query)).toBe(before);
    writeFileSync(f.registryPath, readFileSync(f.registryPath));
    expect(admittedFontFaces(f.query)).toBe(before);
    delete f.registry.families.Amiri.roles.display;
    writeFileSync(f.registryPath, JSON.stringify(f.registry));
    expect(() => admittedFontFaces(f.query)).toThrow(/No admitted/);
  });
});
