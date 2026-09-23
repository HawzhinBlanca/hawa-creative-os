import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

/**
 * The state of output/ as git sees it: each changed path with a hash of its bytes. This test used to
 * begin with `git checkout -- output`, which threw away every uncommitted edit under output/ each time
 * the suite ran (a plan's status table was lost twice on 2026-09-23). It now compares before and after
 * and never touches the files.
 */
function outputState(): Record<string, string> {
  const status = execSync('git status --porcelain --untracked-files=all output/', { cwd: rootDir, encoding: 'utf8' });
  const state: Record<string, string> = {};
  for (const line of status.split('\n').filter(Boolean)) {
    const file = line.slice(3).replace(/^.* -> /, '');
    const full = path.resolve(rootDir, file);
    state[`${line.slice(0, 2)} ${file}`] = fs.existsSync(full) && fs.statSync(full).isFile() ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : 'absent';
  }
  return state;
}

describe('Task 6: Stop tests writing into tracked files under output/', () => {
  it('proves running native-script-fidelity test does not modify tracked output/ files', () => {
    const before = outputState();

    // Run native-script-fidelity test
    execSync('pnpm vitest run packages/creative/test/native-script-fidelity.test.ts', {
      cwd: rootDir,
      stdio: 'pipe',
    });

    // Nothing under output/ changed: no new, changed or removed file, and no edit already there rewritten.
    expect(outputState()).toEqual(before);
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
