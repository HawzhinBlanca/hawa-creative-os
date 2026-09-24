import type { RouteContext } from './types.js';

/**
 * Empty until group G4 (Canva outcome) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /tasks/:taskId/canva-binding, the canva-status and canva-ready notifications, GET editor-url and GET export-package.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerCanvaOutcomeRoutes(_ctx: RouteContext): void {}
