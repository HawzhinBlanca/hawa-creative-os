import type { RouteContext } from './types.js';

/**
 * Empty until group G3 (revisions and decisions) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): revisions, QA, comments, feedback and asks. GET /tasks/:taskId/revisions/diff must stay registered before GET /tasks/:taskId/revisions/:revisionId.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerRevisionsRoutes(_ctx: RouteContext): void {}
