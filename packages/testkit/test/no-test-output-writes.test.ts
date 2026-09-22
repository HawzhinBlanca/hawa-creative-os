import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 6: Stop tests writing into tracked files under output/', () => {
  it('proves running native-script-fidelity test does not modify tracked output/ files', () => {
    // Revert any pending changes first
    execSync('git checkout -- output', { cwd: rootDir });

    // Run native-script-fidelity test
    execSync('pnpm vitest run packages/creative/test/native-script-fidelity.test.ts', {
      cwd: rootDir,
      stdio: 'pipe',
    });

    // Check git status of output/
    const status = execSync('git status --porcelain output/', {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();

    expect(status).toBe('');
  });

  it('proves test suites do not write to tracked output/ paths without explicit override', () => {
    const testFiles = [
      path.resolve(rootDir, 'packages/creative/test/native-script-fidelity.test.ts'),
      path.resolve(rootDir, 'packages/db/test/live-recovery-drill.test.ts'),
      path.resolve(rootDir, 'packages/testkit/test/three-client-production-pilot.test.ts'),
    ];

    for (const file of testFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // Must not unconditionally write into output/ directory
      expect(content).not.toMatch(/writeFileSync\(\s*evidenceFile/);
    }
  });
});
