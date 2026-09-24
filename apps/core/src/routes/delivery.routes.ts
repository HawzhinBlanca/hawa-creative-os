import type { RouteContext } from './types.js';

/**
 * Empty until group G5 (publish and delivery) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST publish, GET publication-state, POST /campaigns/:taskId/dispatch-review, POST publish-omnichannel and GET publication-receipt.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerDeliveryRoutes(_ctx: RouteContext): void {}
