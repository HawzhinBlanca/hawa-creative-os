import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { productionAppOptions } from '../src/entrypoint-options.js';

/**
 * index.ts is the only production entrypoint and the only thing that can start Telegram polling.
 * Nothing else exercises it: the test suites build their own apps. Commit 36f6958 turned polling
 * into a createApp option and left this file calling createApp() with none, and the next deploy
 * ran for 80 minutes with the bridge idle while both client chats went unanswered.
 *
 * Since Phase 2.1 the options are a function of the environment (entrypoint-options.ts): Core polls
 * unless HAWA_TELEGRAM_POLLER=worker hands the poller to the worker.
 */
describe('the production entrypoint', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

  it('builds Core with the production options', () => {
    expect(source).toMatch(/createApp\(productionAppOptions\(process\.env\)\)/);
  });

  it('starts Telegram polling unless the worker polls', () => {
    expect(productionAppOptions({})).toMatchObject({ enableTelegramPolling: true, enableDraftReminders: true, enableCanvaSweeper: true });
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'core' }).enableTelegramPolling).toBe(true);
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'worker' }).enableTelegramPolling).toBe(false);
    expect(productionAppOptions({ HAWA_DRAFT_REMINDERS: 'off' }).enableDraftReminders).toBe(false);
  });
});
