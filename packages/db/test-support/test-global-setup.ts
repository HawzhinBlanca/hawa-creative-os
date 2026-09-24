/**
 * Vitest global setup (vitest.config.ts `globalSetup`): builds the template databases for the
 * current schema once per run and hands their names to every test file through `provide`. Each
 * file then clones its own databases (test-database-clone.ts). See test-template.ts for why.
 *
 * HAWA_TEST_SHARED_DB=1 keeps the old behaviour (every file on hawa_test and hawa_repair), for a
 * run that has to reproduce something on the shared databases.
 */
import type { TestProject } from 'vitest/node';
import { dropRunClones, ensureTemplates, newRunId, pruneStale, type TemplateKind } from '../src/test-template.js';

declare module 'vitest' {
  export interface ProvidedContext {
    hawaTestDatabases: { runId: string; templates: Record<TemplateKind, string> } | null;
  }
}

/** Clones older than this belong to a run that was killed before its teardown. */
const STALE_CLONE_MS = 6 * 60 * 60 * 1000;

export default async function setup(project: TestProject) {
  const env = { ...process.env, ...(project.config.env ?? {}) } as Record<string, string | undefined>;
  const ownerUrl = env.TEST_DATABASE_OWNER_URL;
  if (!ownerUrl || env.HAWA_TEST_SHARED_DB === '1') {
    project.provide('hawaTestDatabases', null);
    return;
  }
  const started = Date.now();
  await pruneStale(ownerUrl, started, STALE_CLONE_MS);
  const templates = await ensureTemplates(project.config.root, ownerUrl, (line) => console.log(`[test databases] ${line}`));
  const runId = newRunId(started);
  project.provide('hawaTestDatabases', { runId, templates });
  console.log(`[test databases] per-file clones of ${templates.test} and ${templates.repair} (${Date.now() - started} ms)`);
  return async () => {
    // Files drop their own clones; this catches the ones a crashed worker left behind.
    await dropRunClones(ownerUrl, runId);
  };
}
