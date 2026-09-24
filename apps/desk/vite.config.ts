import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The task-status vocabulary is bundled from its source file. The Desk image builds only the Desk
 * (`pnpm --filter @hawa/desk build`, infra/docker/Dockerfile.desk), where no package's dist exists,
 * and a dist left from an older build would put stale statuses in the bundle. The file imports
 * nothing, so it bundles on its own. tsconfig.json points the same name at the same file.
 */
const TASK_STATUS_SOURCE = fileURLToPath(new URL('../../packages/contracts/src/task-status.ts', import.meta.url));

const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@hawa/contracts/task-status': TASK_STATUS_SOURCE },
  },
  define: {
    'process.env': {},
  },
  server: {
    port: 5173,
    headers: {
      'Content-Security-Policy': CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/api': 'http://127.0.0.1:3001',
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Content-Security-Policy': CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
