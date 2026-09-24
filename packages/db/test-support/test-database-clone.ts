/**
 * Vitest setup file (vitest.config.ts `setupFiles`), run before each test file is imported: the
 * file gets its own copy of the template databases, and the four database variables are pointed
 * at the copies, so nothing a file writes is seen by another file, another worker or another
 * worktree. The copies are dropped when the file finishes (HAWA_KEEP_TEST_DB=1 keeps them for
 * debugging; the next run's global setup prunes them after six hours).
 *
 * A file that never names a database variable gets no copy: most of the suite is pure unit tests,
 * and cloning costs a few hundred milliseconds. Database access always goes through those
 * variables (no helper module reads them), and a file that reached the shared databases anyway is
 * refused by the connection guard, so a wrong guess fails loudly rather than sharing data.
 */
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, expect, inject } from 'vitest';
import { CLONE_PREFIX, cloneTemplate, dropClone, withDatabase, type TemplateKind } from '../src/test-template.js';

const VARIABLES: Record<TemplateKind, string[]> = {
  test: ['TEST_DATABASE_URL', 'TEST_DATABASE_OWNER_URL'],
  repair: ['HAWA_ISOLATED_TEST_DB', 'HAWA_ISOLATED_RUNTIME_DB'],
};

function needs(kind: TemplateKind, source: string | null): boolean {
  if (!VARIABLES[kind].some((name) => process.env[name])) return false;
  return source === null || VARIABLES[kind].some((name) => source.includes(name));
}

const plan = inject('hawaTestDatabases');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
if (plan) {
  // Tells the connection guard (test-connection-guard.ts) to refuse the old shared databases.
  (pg.Client.prototype as unknown as { hawaPerFileDatabases?: boolean }).hawaPerFileDatabases = true;
}
if (plan && ownerUrl) {
  const testPath = expect.getState().testPath;
  let source: string | null = null;
  try {
    source = testPath ? readFileSync(testPath, 'utf8') : null;
  } catch {
    source = null;
  }
  const clones: string[] = [];
  for (const kind of ['test', 'repair'] as const) {
    if (!needs(kind, source)) continue;
    const clone = `${CLONE_PREFIX[kind]}${plan.runId}_${process.pid}${randomInt(1_000_000)}`;
    await cloneTemplate(ownerUrl, plan.templates[kind], clone);
    clones.push(clone);
    for (const name of VARIABLES[kind]) {
      const value = process.env[name];
      if (value) process.env[name] = withDatabase(value, clone);
    }
  }
  if (clones.length) {
    process.env.HAWA_TEST_DATABASE_CLONES = clones.join(',');
    // Its own file store too (ADR-035): a database's hawa.blobs rows and the files they name belong
    // together, and a file's garbage collection must never see another file's blobs.
    const blobDir = mkdtempSync(join(tmpdir(), 'hawa-test-blobs-'));
    mkdirSync(join(blobDir, 'sha256'), { mode: 0o755 });
    mkdirSync(join(blobDir, 'tmp'), { mode: 0o755 });
    writeFileSync(join(blobDir, '.hawa-blob-store'), 'sha256-v1\n', { mode: 0o644 });
    process.env.HAWA_BLOB_DIR = blobDir;
    afterAll(async () => {
      if (process.env.HAWA_KEEP_TEST_DB === '1') return;
      for (const clone of clones) await dropClone(ownerUrl, clone);
      rmSync(blobDir, { recursive: true, force: true });
    }, 60_000);
  }
}
