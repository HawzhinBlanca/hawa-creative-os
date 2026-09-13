import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Database credentials for the suites are never committed. They come from the process environment
 * (CI secret store) or from a gitignored `.env.test` at the repository root (see .env.test.example).
 * Suites that need a database fail loudly without them; the five hawa_repair suites skip unless
 * HAWA_ISOLATED_TEST_DB is set. Only the four database variables are read from the file, so real
 * API keys in other env files can never leak into a test run.
 */
const TEST_ENV_KEYS = ['TEST_DATABASE_URL', 'TEST_DATABASE_OWNER_URL', 'HAWA_ISOLATED_TEST_DB', 'HAWA_ISOLATED_RUNTIME_DB'] as const;

function loadTestEnvFile(): Record<string, string> {
  const file = resolve(process.cwd(), '.env.test');
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

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['archive/**', '**/node_modules/**', '**/dist/**', '**/.turbo/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    env: {
      NODE_ENV: 'test',
      HAWA_BEARER_TOKEN: 'test_bearer',
      HAWA_ADMIN_KEY: 'test_admin_key',
      HAWA_ART_DIRECTOR_KEY: 'test_art_director_bearer',
      HAWA_ACTION_HMAC_SECRET: 'test_hmac_sec',
      TELEGRAM_WEBHOOK_SECRET: ['expected', 'office', 'secret'].join('_'),
      ...databaseEnv,
    },
  },
});
