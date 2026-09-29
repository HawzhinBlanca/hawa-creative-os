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
    // Stage 2 of ADR-135 removed the option with Core's poller.
    expect(productionAppOptions({})).toMatchObject({ enableBillingProbeSchedule: false, enableCanvaSweeper: true, enablePublicationInspections: true });
    for (const value of [undefined, 'core', 'worker']) expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: value })).not.toHaveProperty('enableTelegramPolling');
    // Draft reminders went with ADR-135 stage 2d: they reminded only old-intake tasks.
    expect(productionAppOptions({})).not.toHaveProperty('enableDraftReminders');
    expect(productionAppOptions({ HAWA_BILLING_PROBE_ENABLED: 'on' }).enableBillingProbeSchedule).toBe(true);
    expect(productionAppOptions({ HAWA_PUBLICATION_INSPECTIONS: 'off' }).enablePublicationInspections).toBe(false);
  });
});
