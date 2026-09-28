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
 * Since Phase 2.1 the options are a function of the environment (entrypoint-options.ts). Since
 * ADR-135 Core never polls, whatever HAWA_TELEGRAM_POLLER says: the worker's poller is the only one,
 * because Core's fed only the legacy intake (lifecycle-only-telegram.test.ts covers the rest).
 */
describe('the production entrypoint', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

  it('builds Core with the production options', () => {
    expect(source).toMatch(/createApp\(productionAppOptions\(process\.env\)\)/);
  });

  it('never starts Core\'s Telegram poller, and keeps the other defaults', () => {
    expect(productionAppOptions({})).toMatchObject({ enableTelegramPolling: false, enableBillingProbeSchedule: false, enableDraftReminders: true, enableCanvaSweeper: true, enablePublicationInspections: true });
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'core' }).enableTelegramPolling).toBe(false);
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'worker' }).enableTelegramPolling).toBe(false);
    expect(productionAppOptions({ HAWA_DRAFT_REMINDERS: 'off' }).enableDraftReminders).toBe(false);
    expect(productionAppOptions({ HAWA_BILLING_PROBE_ENABLED: 'on' }).enableBillingProbeSchedule).toBe(true);
    expect(productionAppOptions({ HAWA_PUBLICATION_INSPECTIONS: 'off' }).enablePublicationInspections).toBe(false);
  });
});
