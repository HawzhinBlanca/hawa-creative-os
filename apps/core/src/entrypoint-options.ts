import type { CreateAppOptions } from './core-helpers.js';

/**
 * The options index.ts, the production entrypoint, builds Core with. A function of the environment,
 * so a test can check what production runs without starting it.
 *
 * Core never polls Telegram (ADR-135): the worker's poller is the only one, whatever
 * HAWA_TELEGRAM_POLLER says, because Core's poller fed only the legacy intake. (Before ADR-135 Core
 * polled unless HAWA_TELEGRAM_POLLER=worker; commit 36f6958 once dropped the option by mistake and the
 * 2026-09-22 deploy ran 80 minutes with nobody reading the chats. production-entrypoint.test.ts pins
 * the current rule.)
 *
 * getMe does not compete with getUpdates, so Core probes the bot credential even while the worker
 * polls (ADR-129, Phase 4 operations finding 3).
 */
export function productionAppOptions(env: Record<string, string | undefined> = process.env): CreateAppOptions {
  return {
    enableTelegramPolling: false,
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
