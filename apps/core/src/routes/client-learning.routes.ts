import type { RouteContext } from './types.js';

/**
 * Empty until group G2 (clients and DNA) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): budgets, candidate rules, negative feedback, POST /feedback/mine and the learning data lineage, beside clients.routes.ts.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerClientLearningRoutes(_ctx: RouteContext): void {}
