/**
 * Which process asks Telegram for updates. Since ADR-135 it is always the worker, whose poller hands
 * each update to its chat's ChatInbox in Restate. Core's own poller only ever fed the legacy intake,
 * so polling there would start requests on the old path, which the owner ruled out on 2026-09-28.
 *
 * HAWA_TELEGRAM_POLLER no longer chooses Core: any value leaves Core silent, and /v1/health names the
 * worker, so the watchdog alerts when no worker colour polls (ADR-129). The worker still polls only
 * with HAWA_TELEGRAM_POLLER=worker (apps/worker/src/lifecycle/telegram-poller.ts); a stale `core`
 * therefore stops intake loudly instead of routing it to the old path, and deploy.sh refuses it.
 * The rollback for a broken worker poller is the previous worker colour or the previous release.
 */
export type TelegramPollerOwner = 'worker';

export function telegramPollerOf(_env: Record<string, string | undefined> = process.env): TelegramPollerOwner {
  return 'worker';
}

/**
 * Settings that no longer do anything, named so an operator removes them (Core logs each at start):
 * HAWA_TELEGRAM_POLLER set to anything but `worker` (in production also unset), an error because
 * nobody reads client messages then, and HAWA_LIFECYCLE_CHATS at all, only information: it changes
 * nothing, and logged as an error at every start it read as a fault that was not there (ADR-158).
 */
export interface RetiredTelegramSetting { level: 'error' | 'info'; message: string }

export function retiredTelegramSettings(env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {}): RetiredTelegramSetting[] {
  const found: RetiredTelegramSetting[] = [];
  const poller = (env.HAWA_TELEGRAM_POLLER || '').trim().toLowerCase();
  if (poller !== 'worker' && (poller || options.production)) {
    found.push({ level: 'error', message: `HAWA_TELEGRAM_POLLER=${poller || '(unset)'}: Core no longer polls Telegram (ADR-135), and the worker polls only with HAWA_TELEGRAM_POLLER=worker, so nobody reads client messages` });
  }
  if (env.HAWA_LIFECYCLE_CHATS !== undefined) {
    found.push({ level: 'info', message: 'HAWA_LIFECYCLE_CHATS is set and ignored: every Telegram chat is lifecycle-owned since ADR-135, so it changes nothing; it can be removed from .env.production' });
  }
  return found;
}
