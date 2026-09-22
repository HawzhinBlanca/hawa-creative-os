import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertTestDatabaseEnv } from './packages/db/src/test-database-guard.js';

/**
 * Database credentials for the suites are never committed. They come from the process environment
 * (CI secret store) or from a gitignored `.env.test` at the repository root (see .env.test.example).
 * Suites that need a database fail loudly without them; the five hawa_repair suites skip unless
 * HAWA_ISOLATED_TEST_DB is set. Only the four database variables are read from the file, so real
 * API keys in other env files can never leak into a test run.
 *
 * The databases live on their own server, hawa-test-postgres (127.0.0.1:55432, `pnpm test:db`).
 * A run whose environment reaches the production server (port 54332) or the live `hawa` database
 * is refused here, before any test file loads; the setup file refuses such connections again inside
 * every worker, for URLs a test builds itself.
 */
const TEST_ENV_KEYS = ['TEST_DATABASE_URL', 'TEST_DATABASE_OWNER_URL', 'HAWA_ISOLATED_TEST_DB', 'HAWA_ISOLATED_RUNTIME_DB'] as const;

function loadTestEnvFile(): Record<string, string> {
  const file = resolve(import.meta.dirname, '.env.test');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && (TEST_ENV_KEYS as readonly string[]).includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}
const fileEnv = loadTestEnvFile();
const databaseEnv: Record<string, string> = {};
for (const key of TEST_ENV_KEYS) {
  const value = process.env[key] ?? fileEnv[key];
  if (value) databaseEnv[key] = value;
}
assertTestDatabaseEnv({ ...process.env, ...databaseEnv });

/**
 * The cost governor keeps the office's daily spend in a file. Every test gets a throwaway one:
 * the governor's tests record simulated calls, and pointed at the real ledger they filled it with
 * USD 19.76 and USD 32.93 of spend that never happened — enough to breach the USD 30 cap and make
 * the qualification refuse to start, while real runs were never recorded at all.
 */
const spendStateDir = mkdtempSync(join(tmpdir(), 'hawa-test-spend-'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['archive/**', '**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/.claude/**', 'apps/desk/e2e/**'],
    fileParallelism: false,
    // Resolved from this file: `pnpm --filter <pkg> test` runs vitest inside the package, where a
    setupFiles: [
      resolve(import.meta.dirname, 'packages/db/src/test-connection-guard.ts'),
      resolve(import.meta.dirname, 'packages/integrations/test/setup-fake-drive.ts'),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    env: {
      NODE_ENV: 'test',
      HAWA_BEARER_TOKEN: 'test_bearer',
      HAWA_DEV_TOKEN: 'hawa_dev_token',
      HAWA_ADMIN_KEY: 'test_admin_key',
      HAWA_ART_DIRECTOR_KEY: 'test_art_director_bearer',
      HAWA_REVIEWER_KEY: 'test_reviewer',
      HAWA_ACTION_HMAC_SECRET: 'test_hmac_sec',
      TELEGRAM_WEBHOOK_SECRET: ['expected', 'office', 'secret'].join('_'),
      HAWA_SPEND_STATE_DIR: spendStateDir,
      HAWA_RETRY_DELAY_MS: '10',
      HISTORICAL_DESIGNS_ARCHIVE_ROOT: resolve(import.meta.dirname, 'node_modules/.cache/historical-designs-test'),
      HAWA_EMULATE_PUBLISHER: 'true',
      HAWA_ALLOW_ROLE_HEADER: 'true',
      ...databaseEnv,
    },
  },
});
