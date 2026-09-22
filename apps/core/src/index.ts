import { serve } from '@hono/node-server';
import { createApp } from './app.js';

import fs from 'node:fs';

try {
  if (fs.existsSync('.env')) {
    const envFile = fs.readFileSync('.env', 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val) {
          process.env[key] = val.trim();
        }
      }
    }
  }
} catch {
  // Gracefully continue if .env cannot be read
}

const SERVICE_NAME = 'hawa-core';
// A long-running service that dies without saying why is the hardest kind of outage to diagnose,
// and compose restarts it, so the only trace left is a gap in the logs. Node terminates the
// process on an unhandled rejection by default; these handlers make the reason survive the exit.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[${SERVICE_NAME}] FATAL unhandledRejection: ${err.message}`, err.stack);
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(`[${SERVICE_NAME}] FATAL uncaughtException: ${err.message}`, err.stack);
  process.exit(1);
});

// The production process is the one that polls Telegram. Commit 36f6958 moved this from an
// environment check to an option and did not set it here, so the 2026-09-22 deploy started with
// the bridge idle (adapters/telegram/status: active=false) and nothing from the two client chats
// reached intake for 80 minutes. production-entrypoint.test.ts pins it.
const app = createApp({ enableTelegramPolling: true });
const port = Number(process.env.PORT || 3001);
const hostname = process.env.HOST || '0.0.0.0';

console.log(`Starting Hawa Core API on http://${hostname}:${port}...`);
const server = serve({
  fetch: app.fetch,
  port,
  hostname,
});

let isShuttingDown = false;
const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[${SERVICE_NAME}] Received ${signal}, starting graceful shutdown...`);

  const forceTimeout = setTimeout(() => {
    console.error(`[${SERVICE_NAME}] Graceful shutdown timed out after 10s, forcing exit`);
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    process.exit(1);
  }, 10_000);
  forceTimeout.unref();

  if (typeof (server as any).closeIdleConnections === 'function') {
    (server as any).closeIdleConnections();
  }

  server.close((err?: Error) => {
    clearTimeout(forceTimeout);
    if (err) {
      console.error(`[${SERVICE_NAME}] Error during server close:`, err);
      process.exit(1);
    }
    console.log(`[${SERVICE_NAME}] Server stopped gracefully`);
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
