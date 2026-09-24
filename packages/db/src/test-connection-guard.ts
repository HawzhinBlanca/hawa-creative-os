/**
 * Vitest setup file (vitest.config.ts `setupFiles`). Inside every test worker it refuses any pg
 * connection to the production server, whatever URL a test built for itself: the check in
 * vitest.config.ts only sees environment variables, this one sees the connection pg is about to
 * open. pg.Pool and Kysely both open connections through Client.prototype.connect.
 *
 * With HAWA_TEST_CONNECTION_LOG set to a file path, every target (host:port/database user, never
 * the password) is appended to that file, so a run can show where its connections went.
 */
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { productionTargetReason } from './test-database-guard.js';

/**
 * With per-file databases (packages/db/test-support/test-database-clone.ts sets
 * hawaPerFileDatabases) no file may reach the old shared databases: a connection there means a
 * file built its own URL instead of reading the variables, and would share rows with every other
 * file again.
 */
const SHARED_DATABASES = new Set(['hawa_test', 'hawa_repair']);

interface ConnectionParameters {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}
type ConnectCallback = (error: Error | null) => void;
type GuardedClient = pg.Client & { connectionParameters: ConnectionParameters };
type Connect = (this: GuardedClient, callback?: ConnectCallback) => Promise<void> | void;

const prototype = pg.Client.prototype as unknown as { connect: Connect; hawaProductionGuard?: true; hawaPerFileDatabases?: boolean };

// Setup files run once per test file, but pg is loaded once per worker; wrap it only once.
if (!prototype.hawaProductionGuard) {
  const connect = prototype.connect;
  prototype.connect = function guardedConnect(this: GuardedClient, callback?: ConnectCallback) {
    const { host, port, database, user } = this.connectionParameters;
    const log = process.env.HAWA_TEST_CONNECTION_LOG;
    if (log) appendFileSync(log, `${host}:${port}/${database} ${user}\n`);
    const reason =
      productionTargetReason({ host, port, database }) ??
      (prototype.hawaPerFileDatabases && database && SHARED_DATABASES.has(database)
        ? 'this run gives every test file its own database; read TEST_DATABASE_URL and friends instead of naming a shared one'
        : null);
    if (reason) {
      const error = new Error(`Test connection to ${host}:${port}/${database} refused: ${reason}.`);
      if (callback) {
        process.nextTick(callback, error);
        return;
      }
      return Promise.reject(error);
    }
    return connect.call(this, callback);
  };
  prototype.hawaProductionGuard = true;
}
