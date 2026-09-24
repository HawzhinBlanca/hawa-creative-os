import type { RouteContext } from './types.js';

/**
 * Empty until group G1 (leaves) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): GET /migration/ledger, GET /migration/reconciliation and the archive, migrate, reopen-sample and rollback-sample POSTs.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerMigrationRoutes(_ctx: RouteContext): void {}
