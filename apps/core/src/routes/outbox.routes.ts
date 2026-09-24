import type { RouteContext } from './types.js';

/**
 * Empty until group G5 (publish and delivery) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): GET /tasks/:taskId/outbox, POST outbox redrive, GET /outbox/failed and POST outbox retire.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerOutboxRoutes(_ctx: RouteContext): void {}
