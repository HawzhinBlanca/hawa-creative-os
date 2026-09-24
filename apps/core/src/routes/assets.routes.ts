import type { RouteContext } from './types.js';

/**
 * Empty until group G1 (leaves) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /assets/upload, POST /assets/sanitize-svg, POST /assets/transcribe-brief and GET /assets.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerAssetsRoutes(_ctx: RouteContext): void {}
