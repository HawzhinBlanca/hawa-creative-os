import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 8: Tooling Remediation', () => {
  it('1. verifies @vitest/coverage-v8 is installed and functional', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    expect(pkgJson.devDependencies['@vitest/coverage-v8']).toBeDefined();

    // Proves coverage can be executed without missing dependency errors
    const output = execSync('pnpm vitest run --coverage packages/contracts/test/contracts.test.ts', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('Coverage report from v8');
  });

  it('2. verifies strict ratchet on any in source files', () => {
    const ratchetScript = path.join(rootDir, 'scripts/ratchet_any.ts');
    expect(fs.existsSync(ratchetScript)).toBe(true);

    const output = execSync('npx tsx scripts/ratchet_any.ts', {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(output).toContain('RATCHET PASSED');
  });

  it('3. verifies test typechecking script and config exist in package.json', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    expect(pkgJson.scripts['typecheck:tests']).toBeDefined();
    expect(pkgJson.scripts['ratchet:any']).toBeDefined();
    expect(fs.existsSync(path.join(rootDir, 'tsconfig.test.json'))).toBe(true);
  });
});
