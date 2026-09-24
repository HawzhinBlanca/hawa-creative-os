import type { RouteContext } from './types.js';

/**
 * Empty until group G3 (revisions and decisions) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /tasks/:taskId/revisions/:revisionId/decisions, GET /tasks/:taskId/review-desk and POST /tasks/:taskId/chat-approval-action.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerDecisionsRoutes(_ctx: RouteContext): void {}
