import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 4 operations finding 3 (ADR-129). With HAWA_TELEGRAM_POLLER=worker the watchdog read only
 * status, background and outbox from each worker colour, so a colour whose poller was off, never
 * started or failing left every check green while no client message was read. It now alerts when
 * Core says the worker polls and no running colour is polling (or about to). The functions are taken
 * from infra/ops/watchdog.sh itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = fs.readFileSync(path.resolve(here, '../../../infra/ops/watchdog.sh'), 'utf8');

function fn(name: string): string {
  const start = watchdog.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`watchdog.sh has no function ${name}`);
  const end = watchdog.indexOf('\n}\n', start);
  return watchdog.slice(start + 1, end + 3);
}

function run(body: string, stdin = '') {
  const script = ['set -Eeuo pipefail', fn('worker_poller_state'), fn('core_poller_owner'), fn('telegram_poller_problem'), body].join('\n');
  const res = spawnSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', ['-c', script], { encoding: 'utf8', input: stdin });
  return { code: res.status, out: res.stdout.trim() };
}

const worker = (telegramPoller: unknown) => JSON.stringify({ status: 'healthy', background: 'live', outbox: {}, telegramPoller });

describe('the watchdog and the worker Telegram poller', () => {
  it('reads each colour\'s poller as mode:background', () => {
    expect(run('worker_poller_state', worker({ mode: 'on', background: 'live', lastError: null })).out).toBe('on:live');
    expect(run('worker_poller_state', worker({ mode: 'on', background: 'not_started' })).out).toBe('on:not_started');
    expect(run('worker_poller_state', worker({ mode: 'off' })).out).toBe('off');
    expect(run('worker_poller_state', worker({ mode: 'misconfigured', reason: 'x' })).out).toBe('misconfigured');
    expect(run('worker_poller_state', JSON.stringify({ status: 'healthy' })).out).toBe('off');
    expect(run('worker_poller_state', 'not json').out).toBe('unknown');
  });

  it('reads who Core says polls, and nothing from a Core that does not say', () => {
    expect(run('core_poller_owner', JSON.stringify({ status: 'healthy', telegramPoller: 'worker' })).out).toBe('worker');
    expect(run('core_poller_owner', JSON.stringify({ status: 'healthy' })).out).toBe('');
    expect(run('core_poller_owner', 'not json').out).toBe('');
  });

  it('alerts when the worker should poll and no running colour does', () => {
    expect(run('telegram_poller_problem worker 0').out).toMatch(/HAWA_TELEGRAM_POLLER=worker but no worker colour is polling Telegram/);
    expect(run('telegram_poller_problem worker 1').out).toBe('');
    expect(run('telegram_poller_problem core 0').out).toBe('');
    expect(run('telegram_poller_problem "" 0').out).toBe('');
  });

  it('counts a colour as polling only when its poller is on and it is live, always or taking over', () => {
    expect(watchdog).toMatch(/on:live\|on:always\|on:taking_over\) pollers=\$\(\(pollers \+ 1\)\)/);
    expect(watchdog).toMatch(/telegram_poller_problem "\$core_owner" "\$pollers"/);
  });
});
