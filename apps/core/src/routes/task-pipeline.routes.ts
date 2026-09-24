import type { RouteContext } from './types.js';

/**
 * Empty until group G7 (tasks and Desk) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /tasks/:taskId/route, POST /tasks/:taskId/briefs and POST /tasks/:taskId/generate.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerTaskPipelineRoutes(_ctx: RouteContext): void {}
