import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';

/**
 * index.ts holds the HTTP port closed until client DNA has loaded from PostgreSQL (architecture
 * programme 1.3, SPLIT_PLAN.md G0), but createApp started the Telegram poller before it returned,
 * so an update that arrived during the load went through intake against the six invented fixture
 * offices. The poller now starts only once the load has finished.
 *
 * The load is replaced with one the test finishes by hand; everything else is the real app.
 */
const hydration = vi.hoisted(() => ({ finish: (_n: number) => {} }));
vi.mock('../src/services/client-dna-hydration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/client-dna-hydration.js')>()),
  hydrateClientDnaFromDb: vi.fn(() => new Promise<number>((resolve) => { hydration.finish = resolve; })),
}));

const { createApp } = await import('../src/app.js');

describe('Telegram polling waits for client DNA', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => db.destroy());
  afterEach(() => vi.unstubAllEnvs());

  const bridge = () => ({
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    attachOffsetStorage: vi.fn(),
    startPolling: vi.fn(),
    useUpdateHandler: vi.fn(),
  });

  it('starts polling only after client DNA has loaded from PostgreSQL', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['424242', 'dna_gate_fixture_token'].join(':'));
    const fake = bridge();
    const app = createApp({ db, telegramBridge: fake as any, enableTelegramPolling: true, skipTelegramProbe: true } as any);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.startPolling, 'polled Telegram while client DNA was still the fixtures').not.toHaveBeenCalled();
    // The administrator's "poll now" handler is registered at once, as before.
    expect(fake.useUpdateHandler).toHaveBeenCalledTimes(1);

    hydration.finish(2);
    await app.clientDnaHydrated;
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.startPolling).toHaveBeenCalledTimes(1);
    expect(fake.startPolling.mock.calls[0][0]).toBe(fake.useUpdateHandler.mock.calls[0][0]);
  });
});
