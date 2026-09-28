import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileTestProject, testTypeCoverage } from '../typecheck_tests.js';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hawa-type-gate-')); fixtures.push(root);
  mkdirSync(join(root, 'apps/example/test'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['apps/**/*.ts'] }));
  writeFileSync(join(root, 'apps/example/test/check.test.ts'), 'export const value: number = 1;\n');
  return root;
}
describe('test type gate negative controls', () => {
  it('accepts a real clean compiler result and complete test inventory', async () => {
    const cwd = fixture();
    expect(testTypeCoverage(cwd, ['tsconfig.json'])).toEqual({ expected: 1, covered: 1, missing: [], errors: [] });
    expect(await compileTestProject('tsconfig.json', { cwd })).toBe(true);
  });
  it('rejects a real imported-source error outside a test directory', async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, 'apps/example/source.ts'), 'export const value: number = "wrong";\n');
    writeFileSync(join(cwd, 'apps/example/test/check.test.ts'), 'export {value} from "../source";\n');
    expect(await compileTestProject('tsconfig.json', { cwd })).toBe(false);
  });
  it('rejects compiler configuration errors and missing execution', async () => {
    const cwd = fixture();
    expect(await compileTestProject('missing.json', { cwd })).toBe(false);
    expect(await compileTestProject('tsconfig.json', { cwd, executable: join(cwd, 'missing-node') })).toBe(false);
    expect(await compileTestProject('tsconfig.json', { cwd, compiler: join(cwd, 'missing-compiler.js') })).toBe(false);
  });
  it('finds active tests even when the compiler configuration excludes them', () => {
    const cwd = fixture();
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ files: [] }));
    expect(testTypeCoverage(cwd, ['tsconfig.json']).missing).toEqual(['apps/example/test/check.test.ts']);
  });
  it('finds test roots in new repository directories without a hardcoded package list', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'tools'));
    writeFileSync(join(cwd, 'tools/check.test.tsx'), 'export const value: number = 1;\n');
    expect(testTypeCoverage(cwd, ['tsconfig.json']).missing).toEqual(['tools/check.test.tsx']);
  });
  it('covers every repository test, including Core, Worker, scripts, chaos and browser tests', () => {
    const coverage = testTypeCoverage();
    expect(coverage.errors).toEqual([]);
    expect(coverage.missing).toEqual([]);
    expect(coverage.expected).toBeGreaterThan(477);
  });
});
