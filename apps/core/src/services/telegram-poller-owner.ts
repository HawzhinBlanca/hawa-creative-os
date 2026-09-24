/**
 * Which process asks Telegram for updates (architecture programme Phase 2.1, PHASE2_DESIGN.md slice
 * 2.1): Core, as always, or the worker, whose poller hands each update to its chat's ChatInbox in
 * Restate. One bot has one getUpdates consumer, so the switch is global, not per chat.
 *
 * HAWA_TELEGRAM_POLLER=worker moves it to the worker; anything else (unset included) leaves it in
 * Core, so nothing changes in production until the owner sets it. The worker reads the same variable
 * the same way (apps/worker/src/lifecycle/telegram-poller.ts, pollerConfigFromEnv). Rolling back is
 * setting it to `core` and restarting both: they share the offset row in Postgres.
 */
export type TelegramPollerOwner = 'core' | 'worker';

export function telegramPollerOf(env: Record<string, string | undefined> = process.env): TelegramPollerOwner {
  return (env.HAWA_TELEGRAM_POLLER || '').trim().toLowerCase() === 'worker' ? 'worker' : 'core';
}
