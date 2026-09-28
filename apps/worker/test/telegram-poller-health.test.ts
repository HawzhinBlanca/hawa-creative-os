import { describe, expect, it } from 'vitest';
import { TelegramPoller, pollerProblem } from '../src/lifecycle/telegram-poller.js';

/**
 * Phase 4 operations finding 3 (ADR-129). With HAWA_TELEGRAM_POLLER=worker, Core no longer polls, and
 * the worker's /health said "healthy" whatever its poller did: a revoked bot token (getUpdates 401), a
 * poller that never started, or one that had not read Telegram for hours. pollerProblem is what
 * /health now degrades on; the watchdog alerts on a degraded worker.
 */
const BOT = ['7000002', 'health_fixture'].join(':');
const quietLog = { info() {}, warn() {}, error() {} };

function poller(answer: () => Response, clock: { t: number }, killSwitch: () => Promise<boolean> = async () => false) {
  const fetch = async (url: string) => {
    if (new URL(url).hostname === 'api.telegram.org') return answer();
    return Response.json({ invocationId: 'inv' }, { status: 202 });
  };
  return new TelegramPoller({
    botToken: BOT, ingressUrl: 'http://restate:8080', offsets: { async getOffset() { return 0; }, async setOffset() {} },
    killSwitch, fetch: fetch as any, killSwitchCacheMs: 0, now: () => clock.t, log: quietLog,
  });
}

const MIN = 60_000;

describe('pollerProblem: when the worker poller degrades /health', () => {
  it('a revoked bot token degrades the live colour at once', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    const p = poller(() => Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 }), clock);
    await p.pollOnce();
    const problem = pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t });
    expect(problem).toMatch(/Telegram refuses the bot token/);
    expect(problem).toMatch(/401/);
  });

  it('a poller that is on but never started degrades the colour', () => {
    expect(pollerProblem({ mode: 'on', started: false, background: 'live', status: null, now: Date.now() })).toMatch(/did not start/);
  });

  it('a live poller with no successful poll for over five minutes degrades the colour; a recent success does not', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    let ok = true;
    const p = poller(() => (ok ? Response.json({ ok: true, result: [] }) : new Response('bad gateway', { status: 502 })), clock);
    await p.pollOnce();
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t })).toBeNull();
    ok = false;
    clock.t += 2 * MIN;
    await p.pollOnce();
    // One transient failure two minutes after a success is not an outage.
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t })).toBeNull();
    clock.t += 4 * MIN;
    await p.pollOnce();
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t })).toMatch(/no successful poll for over 5 minutes.*502/);
  });

  it('a live poller that has never succeeded is stale five minutes after its first attempt', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    const p = poller(() => { throw new TypeError('fetch failed'); }, clock);
    await p.pollOnce();
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t + MIN })).toBeNull();
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t + 6 * MIN })).toMatch(/no successful poll/);
  });

  it('intake switched off on purpose is not a poller fault', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    const p = poller(() => Response.json({ ok: true, result: [] }), clock, async () => true);
    await p.pollOnce();
    clock.t += 30 * MIN;
    await p.pollOnce();
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: p.status(), now: clock.t })).toBeNull();
  });

  it('a colour that is not live, a poller that is off, and one not yet polling are not faults', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    const p = poller(() => Response.json({ ok: false }, { status: 401 }), clock);
    await p.pollOnce();
    for (const background of ['standby', 'taking_over', 'unknown']) {
      expect(pollerProblem({ mode: 'on', started: true, background, status: p.status(), now: clock.t }), background).toBeNull();
    }
    expect(pollerProblem({ mode: 'off', started: false, background: 'live', status: null, now: clock.t })).toBeNull();
    const fresh = poller(() => Response.json({ ok: true, result: [] }), clock);
    expect(pollerProblem({ mode: 'on', started: true, background: 'live', status: fresh.status(), now: clock.t })).toBeNull();
  });

  it('status() reports when the poller last succeeded and when it first polled', async () => {
    const clock = { t: Date.parse('2026-09-28T10:00:00Z') };
    const p = poller(() => Response.json({ ok: true, result: [] }), clock);
    expect(p.status()).toMatchObject({ lastOkAt: null, firstPollAt: null });
    await p.pollOnce();
    expect(p.status()).toMatchObject({ lastOkAt: '2026-09-28T10:00:00.000Z', firstPollAt: '2026-09-28T10:00:00.000Z' });
  });
});

describe('the worker /health wiring', () => {
  it('degrades on pollerProblem and reports it under telegramPoller.problem', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/pollerProblem\(/);
    expect(source).toMatch(/Boolean\(pollerIssue\)/);
    expect(source).toMatch(/problem: pollerIssue/);
  });
});
