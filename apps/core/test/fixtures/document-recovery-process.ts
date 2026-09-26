/** Disposable HTTP process for the opt-in document recovery drill. Never an application entrypoint. */
import { basename } from 'node:path';
import { serve } from '@hono/node-server';
import { createDb } from '@hawa/db';
import { assertTestDatabaseEnv, connectionTargetOf } from '../../../../packages/db/src/test-database-guard.js';

assertTestDatabaseEnv(process.env);
const target = connectionTargetOf(process.env.TEST_DATABASE_URL ?? '');
if (process.env.HAWA_DOCUMENT_RECOVERY !== '1' || !basename(process.cwd()).startsWith('hawa-pdf-recovery-') ||
    !['localhost', '127.0.0.1'].includes(target.host ?? '') || Number(target.port) !== 55432 ||
    !/^hawa_t_[a-z0-9_]+$/.test(target.database ?? '')) throw new Error('Disposable PDF recovery target required');

// The test passes a minimal environment and a fresh cwd, so app.ts cannot load office .env.local.
// Reject all fetch destinations except this run's local parser/control bridge, including redirects.
const transport = globalThis.fetch;
const origin = new URL(process.env.HAWA_CHAOS_CONTROL_URL!).origin;
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Loopback recovery bridge required');
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin || !['/parse', '/reach'].includes(url.pathname))
    throw new Error('Recovery process refused non-fixture network access');
  return transport(input, { ...init, redirect: 'error' });
};
const { createApp } = await import('../../src/app.js');
const db = createDb(process.env.TEST_DATABASE_URL);
const app = createApp({ db, skipPaidModelProbe: true, skipTelegramProbe: true, enableTelegramPolling: false,
  enableBillingProbeSchedule: false, enableDraftReminders: false, enableCanvaSweeper: false });
await app.clientDnaHydrated;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => process.send?.({ port: info.port }));
process.on('SIGTERM', () => {
  server.close(() => { void db.destroy().finally(() => process.exit(0)); });
  server.closeAllConnections?.();
});
