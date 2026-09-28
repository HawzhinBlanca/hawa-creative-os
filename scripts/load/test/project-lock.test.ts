import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The load runner shares the hawa-chaos project with the chaos suite. On 2026-09-28 a load run that
 * gave up after waiting 30 minutes for the project still ran its teardown (`finally`), took down a
 * chaos suite in the middle of its scenarios, and every later scenario failed with ECONNREFUSED on
 * 56090. The runner now takes the project's lock (driver/stack.ts acquireProject) and tears down only
 * what it holds. Starting Docker here is not possible, so this reads the source.
 */
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'run.ts'), 'utf8');

describe('load runner: the hawa-chaos project is torn down only by the run that holds it', () => {
  it('takes the lock before its first down, and marks the project its own only then', () => {
    const lock = source.indexOf('await acquireProject(');
    const owned = source.indexOf('owned = true;');
    const firstDown = source.indexOf('down({ volumes: true });', source.indexOf('try {', lock - 200));
    expect(lock).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(lock);
    expect(firstDown).toBeGreaterThan(owned);
    expect(source).not.toContain('waitForFreeChaosProject');
  });

  it('guards every teardown by ownership and gives the lock back', () => {
    const downs = [...source.matchAll(/down\(\{ volumes: true \}\)/g)].map((m) => m.index!);
    expect(downs.length).toBeGreaterThanOrEqual(3);
    // The SIGINT handler and the finally block: each down there is preceded by an ownership check.
    const sigint = source.slice(source.indexOf("process.on('SIGINT'"), source.indexOf('process.exit(130)'));
    expect(sigint).toMatch(/if \(owned && !keep\) down\(\{ volumes: true \}\)/);
    const final = source.slice(source.lastIndexOf('} finally {'));
    expect(final).toMatch(/if \(!owned\)[\s\S]*else if \(!keep\) \{\s*down\(\{ volumes: true \}\)/);
    expect(final).toContain('await releaseProject();');
  });
});
