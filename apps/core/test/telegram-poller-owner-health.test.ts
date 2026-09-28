import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { productionAppOptions } from '../src/entrypoint-options.js';

/**
 * Phase 4 operations finding 3 (ADR-129). With HAWA_TELEGRAM_POLLER=worker, production Core skipped its
 * getMe probe (the probe ran only when Core polled), so a revoked or rotated bot token never showed as
 * telegramApi "unauthorized", and /v1/health did not say who is meant to poll. The probe costs nothing
 * and getMe does not compete with the worker's getUpdates.
 */
describe('Core health when the worker polls Telegram', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('production Core probes the bot credential whichever process polls', () => {
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'worker' })).toMatchObject({ enableTelegramPolling: false, skipTelegramProbe: false });
    expect(productionAppOptions({})).toMatchObject({ enableTelegramPolling: true, skipTelegramProbe: false });
  });

  it('a revoked bot token shows as telegramApi "unauthorized", and health names the worker as the poller', async () => {
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'worker');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['7000003', 'owner_health_fixture'].join(':'));
    const getMe: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://api.telegram.org/') && u.endsWith('/getMe')) { getMe.push(u); return new Response('{"ok":false}', { status: 401 }); }
      throw new TypeError('fetch failed');
    });
    const { enableTelegramPolling, skipTelegramProbe } = productionAppOptions(process.env);
    const bridge = { dispatchOutboundMessage: vi.fn(), downloadFile: vi.fn(), answerCallbackQuery: vi.fn(), handleCommand: vi.fn() };
    const app = createApp({ telegramBridge: bridge as any, enableTelegramPolling, skipTelegramProbe, skipPaidModelProbe: true } as any);
    const res = await app.request('/v1/health');
    const body = await res.json();
    expect(getMe).toHaveLength(1);
    expect(body.dependencies.telegramApi).toBe('unauthorized');
    expect(body.status).not.toBe('healthy');
    expect(body.telegramPoller).toBe('worker');
  });

  it('health names Core as the poller by default', async () => {
    vi.stubEnv('HAWA_TELEGRAM_POLLER', '');
    const app = createApp({ skipPaidModelProbe: true, skipTelegramProbe: true, enableTelegramPolling: false } as any);
    expect((await (await app.request('/v1/health')).json()).telegramPoller).toBe('core');
  });
});
