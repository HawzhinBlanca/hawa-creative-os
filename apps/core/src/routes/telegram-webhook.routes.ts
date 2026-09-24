import type { RouteContext } from './types.js';

/**
 * Empty until group G9 (Telegram intake) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /webhooks/telegram: the secret, parsing, the kill switch and dispatch to services/telegram-intake/.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerTelegramWebhookRoutes(_ctx: RouteContext): void {}
