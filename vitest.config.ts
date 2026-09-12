import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    env: {
      NODE_ENV: 'test',
      HAWA_BEARER_TOKEN: 'test_bearer',
      HAWA_ADMIN_KEY: 'test_admin_key',
      HAWA_ACTION_HMAC_SECRET: 'test_hmac_sec',
      TELEGRAM_WEBHOOK_SECRET: ['expected', 'office', 'secret'].join('_'),
      TEST_DATABASE_URL: 'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test',
    },
  },
});
