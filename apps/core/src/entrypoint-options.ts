import type { CreateAppOptions } from './core-helpers.js';
import { telegramPollerOf } from './services/telegram-poller-owner.js';

/**
 * The options index.ts, the production entrypoint, builds Core with. A function of the environment,
 * so a test can check what production runs without starting it.
 *
 * Core polls Telegram unless HAWA_TELEGRAM_POLLER=worker (Phase 2.1). Commit 36f6958 once turned
 * polling into an option and left index.ts without it: the 2026-09-22 deploy ran for 80 minutes with
 * the bridge idle and nothing from the two client chats reached intake. production-entrypoint.test.ts
 * pins the default.
 *
 * getMe does not compete with getUpdates, so Core probes the bot credential even while the worker
 * polls (ADR-129, Phase 4 operations finding 3).
 */
export function productionAppOptions(env: Record<string, string | undefined> = process.env): CreateAppOptions {
  return {
    enableTelegramPolling: telegramPollerOf(env) === 'core',
    // The bot credential is probed (getMe, at most every five minutes) whichever process polls: with
    // HAWA_TELEGRAM_POLLER=worker a revoked token was otherwise invisible to /v1/health (ADR-129).
    skipTelegramProbe: false,
    // Paid verification has a real recurring cost, so the operator opts in explicitly.
    enableBillingProbeSchedule: env.HAWA_BILLING_PROBE_ENABLED === 'on',
    enableDraftReminders: env.HAWA_DRAFT_REMINDERS !== 'off',
    enableCanvaSweeper: true,
    enablePublicationInspections: env.HAWA_PUBLICATION_INSPECTIONS !== 'off',
  };
}
