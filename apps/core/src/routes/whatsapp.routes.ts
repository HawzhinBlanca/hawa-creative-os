import type { RouteContext } from './types.js';

/**
 * Empty until group G8 (WhatsApp and ingress) of the app.ts split moves its routes here (architecture programme 1.3,
 * SPLIT_PLAN.md section 2): POST /webhooks/whatsapp, the WhatsApp action callbacks, GET /waha/health, POST /waha/kill-switch, POST /ingress/unified, POST /ingress/promote and POST /messages/:messageId/promote.
 * createApp already calls this, so the group changes only this file and deletes its blocks in app.ts.
 */
export function registerWhatsappRoutes(_ctx: RouteContext): void {}
