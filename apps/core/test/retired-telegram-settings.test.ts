import { describe, expect, it } from 'vitest';
import { retiredTelegramSettings } from '../src/services/telegram-poller-owner.js';

/**
 * Core names the Telegram settings that no longer do anything at every start. HAWA_LIFECYCLE_CHATS
 * changes nothing since ADR-135, and logged as an error at every boot it read as a fault in the
 * 2026-09-30 audit: it is information now (ADR-158). A poller setting that leaves nobody reading
 * client messages stays an error.
 */
describe('retired Telegram settings at start', () => {
  it('HAWA_LIFECYCLE_CHATS is information, saying it is ignored', () => {
    expect(retiredTelegramSettings({ HAWA_TELEGRAM_POLLER: 'worker', HAWA_LIFECYCLE_CHATS: '*' }, { production: true })).toEqual([
      { level: 'info', message: expect.stringMatching(/^HAWA_LIFECYCLE_CHATS is set and ignored: .*changes nothing/) },
    ]);
  });

  it('a poller setting that stops intake is still an error', () => {
    expect(retiredTelegramSettings({}, { production: true })).toEqual([
      { level: 'error', message: expect.stringMatching(/^HAWA_TELEGRAM_POLLER=\(unset\): .*nobody reads client messages/) },
    ]);
    expect(retiredTelegramSettings({ HAWA_TELEGRAM_POLLER: 'worker' }, { production: true })).toEqual([]);
  });
});
