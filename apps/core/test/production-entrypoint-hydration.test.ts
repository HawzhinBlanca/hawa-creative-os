import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

/**
 * index.ts started serving as soon as createApp returned, without waiting for client DNA to load
 * from PostgreSQL (architecture programme 1.3, SPLIT_PLAN.md sections 0 and 6). Until hydration
 * finished, every request that read a client's DNA was answered from the six invented fixture
 * offices, and a production hydration failure was noticed only after the port was open.
 *
 * These import the real entrypoint with createApp and the HTTP server replaced, so they check what
 * index.ts does, not what its text says.
 */
const PROCESS_EVENTS = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'] as const;

describe('the production entrypoint waits for client DNA before serving', () => {
  let serve: ReturnType<typeof vi.fn>;
  let listenersBefore: Map<string, Function[]>;

  beforeEach(() => {
    vi.resetModules();
    serve = vi.fn(() => ({ close: vi.fn() }));
    vi.doMock('@hono/node-server', () => ({ serve }));
    // index.ts reads a `.env` in the working directory; a test must not load one into its process.
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === '.env' ? false : existsSync(p)));
    listenersBefore = new Map(PROCESS_EVENTS.map((e) => [e, process.listeners(e) as Function[]]));
  });

  afterEach(() => {
    // The entrypoint installs process-wide handlers that exit the process; remove the ones it added.
    for (const e of PROCESS_EVENTS) {
      for (const l of process.listeners(e)) {
        if (!listenersBefore.get(e)!.includes(l)) process.removeListener(e, l as (...args: unknown[]) => void);
      }
    }
    vi.doUnmock('@hono/node-server');
    vi.doUnmock('../src/app.js');
    vi.restoreAllMocks();
  });

  function appWhoseHydrationIs(hydrated: Promise<number>) {
    const app = { fetch: vi.fn(), clientDnaHydrated: hydrated };
    const createApp = vi.fn(() => app);
    vi.doMock('../src/app.js', () => ({ createApp }));
    return { app, createApp };
  }

  it('opens the port only after client DNA has loaded from PostgreSQL', async () => {
    let finishHydration!: (n: number) => void;
    const { app, createApp } = appWhoseHydrationIs(new Promise<number>((resolve) => { finishHydration = resolve; }));

    const started = import('../src/index.js');
    // Loading the module takes a while; once the app exists, give the entrypoint time to go on.
    await vi.waitFor(() => expect(createApp).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(serve, 'served while client DNA was still the fixtures').not.toHaveBeenCalled();

    finishHydration(3);
    await started;
    expect(serve).toHaveBeenCalledTimes(1);
    expect(serve.mock.calls[0][0]).toMatchObject({ fetch: app.fetch });
  });

  it('never opens the port when hydration fails, and exits non-zero', async () => {
    appWhoseHydrationIs(Promise.reject(new Error('database unreachable')));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(import('../src/index.js')).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(serve).not.toHaveBeenCalled();
  });
});
