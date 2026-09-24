import type { RouteContext } from './types.js';

/**
 * Empty until group G6 (controls and redrive) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /tasks/:taskId/pause, resume, cancel and retry, POST redrive, POST /tasks/sweep-failed and the two workflow routes.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerControlsRoutes(_ctx: RouteContext): void {}
