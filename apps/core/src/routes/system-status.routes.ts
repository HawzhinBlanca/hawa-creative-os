import type { RouteContext } from './types.js';

/**
 * Empty until group G1 (leaves) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): GET /system/revision-metrics, GET /system/studio-status, GET /system/cutover/status and POST /system/cutover/rollback-rehearsal.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerSystemStatusRoutes(_ctx: RouteContext): void {}
