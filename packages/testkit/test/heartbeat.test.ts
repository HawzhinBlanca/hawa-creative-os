import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The outside heartbeat (2026-10-02 operations review): alerts were sent from the host they watched, so a
 * host that was off said nothing. hawa_heartbeat pings an https check URL on each healthy watchdog pass.
 * `curl` is a stub on PATH that records its arguments.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '../../../infra/ops/host_lib.sh');
const watchdog = path.resolve(here, '../../../infra/ops/watchdog.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function run(envFile: string | null, env: Record<string, string> = {}, curlExit = 0) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-heartbeat-'));
  temps.push(t);
  const bin = path.join(t, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(t, 'calls');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\necho "$*" >> '${calls}'\nexit ${curlExit}\n`, { mode: 0o755 });
  const file = path.join(t, '.env.production');
  if (envFile !== null) fs.writeFileSync(file, envFile);
  const res = spawnSync(BASH, ['-c', `source '${lib}'; hawa_heartbeat '${file}'`], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: t, ...env },
  });
  return { code: res.status, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim() : '' };
}

describe('hawa_heartbeat', () => {
  it('pings the https URL from the production env file, quotes and a CR stripped', () => {
    const r = run('OTHER=1\nHAWA_HEARTBEAT_URL="https://hc.example.test/ping/abc"\r\n');
    expect(r.code).toBe(0);
    expect(r.calls).toBe('-fsS -m 10 -o /dev/null https://hc.example.test/ping/abc');
  });
  it('prefers the environment, and sends nothing when unset or not https', () => {
    expect(run('HAWA_HEARTBEAT_URL=https://file.example.test/x\n', { HAWA_HEARTBEAT_URL: 'https://env.example.test/y' }).calls)
      .toBe('-fsS -m 10 -o /dev/null https://env.example.test/y');
    expect(run('HAWA_HEARTBEAT_URL=\n').calls).toBe('');
    expect(run(null).calls).toBe('');
    expect(run('HAWA_HEARTBEAT_URL=http://plain.example.test/z\n').calls).toBe('');
  });
  // Hunt 3: the owner pastes this line by hand. A trailing space, or a URL pasted without its scheme, sent
  // nothing and said nothing, and a new healthchecks.io check never alerts before its first ping: the
  // dead-man's switch looked armed and was not.
  it('trims spaces around the value, and returns 2 (not 0) for a value that is set but not an https URL', () => {
    expect(run('HAWA_HEARTBEAT_URL=https://hc.example.test/ping/abc  \n').calls).toBe('-fsS -m 10 -o /dev/null https://hc.example.test/ping/abc');
    expect(run('HAWA_HEARTBEAT_URL= "https://hc.example.test/ping/q" \n').calls).toBe('-fsS -m 10 -o /dev/null https://hc.example.test/ping/q');
    for (const bad of ['hc-ping.com/abc', 'http://plain.example.test/z', 'https://hc.example.test/a b']) {
      const r = run(`HAWA_HEARTBEAT_URL=${bad}\n`);
      expect(r.code, bad).toBe(2);
      expect(r.calls, bad).toBe('');
    }
    expect(run('HAWA_HEARTBEAT_URL=\n').code).toBe(0);
    expect(run(null).code).toBe(0);
  });
  it('the watchdog says when the heartbeat is misconfigured', () => {
    const script = fs.readFileSync(watchdog, 'utf8');
    expect(script).toMatch(/2\) say "HAWA_HEARTBEAT_URL is set but is not an https URL/);
  });
  it('returns 1 when the ping fails, so the watchdog can say so', () => {
    expect(run('HAWA_HEARTBEAT_URL=https://hc.example.test/ping/abc\n', {}, 7).code).toBe(1);
  });
  it('the watchdog pings it on a healthy pass only', () => {
    const script = fs.readFileSync(watchdog, 'utf8');
    const healthy = script.indexOf('say "healthy"');
    const ping = script.indexOf('hawa_heartbeat "$PROD"');
    expect(healthy).toBeGreaterThan(0);
    expect(ping).toBeGreaterThan(healthy);
    expect(script.lastIndexOf('hawa_heartbeat')).toBe(ping);
  });
});
