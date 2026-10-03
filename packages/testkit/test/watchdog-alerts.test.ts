import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/ops/watchdog.sh after the 2026-09-30 outage (ADR-158).
 *
 * - One 30-minute cooldown covered every problem: an alert at 07:17 about something else kept the
 *   Postgres outage of 07:26-07:38 from being sent until 07:47. A new or changed problem now alerts at
 *   once; the cooldown only holds back the same problems again (their numbers aside).
 * - Postgres crash recovery and Restate's "Severe lag" (the Docker VM stalling, minutes before both
 *   crashes) are read from the containers' logs since the last pass and alerted.
 * - Every line the watchdog writes carries its UTC time.
 * - It works on the release ~/.hawa/current points to: compose files, backups and build stamp.
 * - The disk is judged by free space, not percent.
 * - Core's "disabled" paid probe (HAWA_BILLING_PROBE_ENABLED off) is not a problem.
 *
 * A full stack is stubbed: docker, curl, sleep and open on PATH; the release is a directory whose infra
 * links to this checkout's, with a valid nightly backup receipt of its own.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const watchdog = path.join(repo, 'infra/ops/watchdog.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-watchdog-alerts-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const STACK = ['nginx', 'desk', 'core', 'cutout', 'postgres', 'restate', 'vector', 'worker-blue'].map((s) => `hawa-production-${s}-1`);
const WORKER = JSON.stringify({ status: 'healthy', background: 'live', outbox: {}, telegramPoller: { mode: 'on', background: 'live' } });
const health = (over: Record<string, unknown> = {}, status = 'healthy') => JSON.stringify({ status, telegramPoller: 'worker', dependencies: {
  postgres: 'connected', parkedClientMessages: 0, canva: 'unverified', canvaCircuitBreaker: 'CLOSED', telegram: 'active', waha: 'unconfigured',
  disk: 'writable', restate: 'connected', restatePausedInvocations: 0, modelProvider: 'disabled', telegramApi: 'connected', funnel: 'idle',
  cutout: 'connected', ...over } });

let n = 0;
function setup(opts: { freeKb?: number; running?: string[] } = {}) {
  const t = path.join(tmp, `case-${++n}`);
  const bin = path.join(t, 'bin'); const home = path.join(t, 'home'); const release = path.join(t, 'release');
  for (const d of [bin, path.join(home, '.hawa', 'watchdog'), path.join(release, 'infra', 'backup', 'snapshots')]) fs.mkdirSync(d, { recursive: true });
  // The release production runs: this checkout's scripts, its own backups, its own commit.
  for (const d of ['docker', 'ops']) fs.symlinkSync(path.join(repo, 'infra', d), path.join(release, 'infra', d));
  fs.symlinkSync(path.join(repo, 'infra/backup/restate_nightly.py'), path.join(release, 'infra/backup/restate_nightly.py'));
  const stamp = new Date(Date.now() - 3600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dump = path.join(release, 'infra/backup/snapshots', `hawa_${stamp}.dump`);
  fs.writeFileSync(dump, 'dump');
  const sha = createHash('sha256').update('dump').digest('hex');
  fs.writeFileSync(`${dump}.sha256`, `${sha}\n`);
  fs.writeFileSync(path.join(release, 'infra/backup/snapshots/backup.log'), `2026-09-30T03:30:00Z OK ${stamp} bytes=4 sha256=${sha.slice(0, 16)}\n`);
  execFileSync('git', ['init', '-q', release]);
  execFileSync('git', ['-C', release, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'release']);
  fs.symlinkSync(release, path.join(home, '.hawa', 'current'));
  fs.writeFileSync(path.join(home, '.hawa', 'watchdog', 'state'), `last_cleanup=${Math.floor(Date.now() / 1000)}\n`);
  const f = (name: string) => path.join(t, name);
  fs.writeFileSync(f('running'), `${(opts.running ?? STACK).join('\n')}\n`);
  fs.writeFileSync(f('health'), health());
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
case "$*" in
  "info"*) exit 0 ;;
  "ps --filter name=hawa-production- --filter status=running"*) cat '${f('running')}' ;;
  "ps -a"*) ;;
  "exec "*) echo '${WORKER}' ;;
  "logs --since "*" hawa-production-postgres-1") echo "docker $*" >> '${f('calls')}'; cat '${f('pg.log')}' 2>/dev/null ;;
  "logs --since "*" hawa-production-restate-1") cat '${f('restate.log')}' 2>/dev/null ;;
  "compose "*) echo "docker $* stamp=$HAWA_BUILD_COMMIT" >> '${f('calls')}' ;;
  *) echo "docker $*" >> '${f('calls')}' ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
case "$*" in
  *"/v1/health"*) cat '${f('health')}' ;;
  *sendMessage*) [[ -f '${f('telegram-down')}' ]] && { echo "curl: (22) The requested URL returned error: 502" >&2; exit 22; }
    for a in "$@"; do [[ "$a" == text=* ]] && printf '%s\\n' "ALERT \${a#text=}" >> '${f('calls')}'; done ;;
esac
exit 0
`, { mode: 0o755 });
  for (const tool of ['sleep', 'open']) fs.writeFileSync(path.join(bin, tool), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const kb = opts.freeKb ?? 500 * 1048576;
  fs.writeFileSync(path.join(bin, 'df'), `#!/bin/bash
case "$1" in
  -h) echo "Filesystem Size Used Avail Capacity Mounted"; echo "/dev/x 1Ti 1Ti $(( ${kb} / 1048576 ))Gi 97% /" ;;
  *) echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 1000000000 970000000 ${kb} 97% /" ;;
esac
`, { mode: 0o755 });
  const envFile = f('env.production');
  fs.writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${['700', 'stub', 'alerts'].join(':')}\nTELEGRAM_ALLOWED_USERS=9000003\n`, { mode: 0o600 });
  return {
    t, home, release, f,
    alerts: () => (fs.existsSync(f('calls')) ? fs.readFileSync(f('calls'), 'utf8').split('\n').filter((l) => l.startsWith('ALERT ')) : []),
    calls: () => (fs.existsSync(f('calls')) ? fs.readFileSync(f('calls'), 'utf8') : ''),
    state: () => fs.readFileSync(path.join(home, '.hawa', 'watchdog', 'state'), 'utf8'),
    setState: (key: string, value: string | number) => {
      const file = path.join(home, '.hawa', 'watchdog', 'state');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    },
    run: (args: string[] = []) => {
      const res = spawnSync(BASH, [watchdog, ...args], { encoding: 'utf8', timeout: 60_000, env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: home, HAWA_WATCHDOG_ENV_FILE: envFile,
        HAWA_RESTATE_BACKUP_HEALTH_SECONDS: '0' } });
      return { code: res.status, stdout: res.stdout, out: `${res.stdout}\n${res.stderr}` };
    },
  };
}

const PG_CRASH = [
  '2026-09-30 07:26:02.100 UTC [1] LOG:  server process (PID 190195) exited with exit code 2',
  '2026-09-30 07:26:02.101 UTC [1] LOG:  terminating any other active server processes',
  '2026-09-30 07:27:08.084 UTC [190213] LOG:  database system was interrupted; last known up at 2026-09-30 07:25:50 UTC',
].join('\n');
const RESTATE_LAG = [
  '\u001b[2m2026-09-30T07:21:16.100Z\u001b[0m \u001b[33mWARN\u001b[0m restate_node::failure_detector',
  '  \u001b[1;33mSevere lag (5.499412096s) was detected in failure detector internal timer, this indicates an overload or a stall.\u001b[0m',
  '  \u001b[1;33mSevere lag (16.542756546s) was detected in failure detector internal timer, this indicates an overload or a stall.\u001b[0m',
].join('\n');

describe('the watchdog\'s alerts', () => {
  it('a healthy pass on the current release: every line timestamped, no alert, the disabled paid probe is not a problem', () => {
    const s = setup();
    const r = s.run();
    expect(r.code, r.out).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /);
    expect(lines.at(-1)).toMatch(/Z healthy$/);
    expect(s.alerts()).toEqual([]);
    // An older Core that still calls itself degraded for an unverified Canva is read as before.
    fs.writeFileSync(s.f('health'), health({}, 'degraded'));
    const older = s.run(['--status']);
    expect(older.code, older.out).toBe(0);
    expect(older.stdout).toMatch(/Z healthy\n$/);
  });

  it('sends a new or changed problem at once, and holds back only the same problems for 30 minutes', () => {
    const s = setup();
    fs.writeFileSync(s.f('health'), health({ parkedClientMessages: 1 }, 'degraded'));
    expect(s.run().code).toBe(1);
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toContain('parkedClientMessages');
    // The same problem with another count: a repeat.
    fs.writeFileSync(s.f('health'), health({ parkedClientMessages: 2 }, 'degraded'));
    s.run();
    expect(s.alerts()).toHaveLength(1);
    // 2026-09-30: nine minutes after that alert, Postgres crashed. It is sent now, not at the next half hour.
    fs.writeFileSync(s.f('pg.log'), PG_CRASH);
    s.run();
    expect(s.alerts()).toHaveLength(2);
    expect(s.alerts()[1]).toMatch(/Postgres crashed and ran crash recovery since the last check \(2 log lines/);
    s.run();
    expect(s.alerts()).toHaveLength(2);
    // The same problems half an hour after the last alert: reminded.
    s.setState('last_alert', Math.floor(Date.now() / 1000) - 1801);
    s.run();
    expect(s.alerts()).toHaveLength(3);
    // Postgres recovered, the parked message is still there: a changed set, sent at once.
    fs.rmSync(s.f('pg.log'));
    s.run();
    expect(s.alerts()).toHaveLength(4);
    expect(s.alerts()[3]).not.toMatch(/Postgres/);
    // All clear: the recovery is announced.
    fs.writeFileSync(s.f('health'), health());
    expect(s.run().code).toBe(0);
    expect(s.alerts().at(-1)).toMatch(/^ALERT ✅ Hawa is back to normal/);
  });

  it('reads the logs only since its last pass', () => {
    const s = setup();
    s.run();
    const lastPass = /^last_pass=(\d+)$/m.exec(s.state())![1];
    s.run();
    expect(s.calls()).toContain(`docker logs --since ${lastPass} hawa-production-postgres-1`);
  });

  it('alerts on Restate\'s severe lag, with how often and the longest', () => {
    const s = setup();
    fs.writeFileSync(s.f('restate.log'), RESTATE_LAG);
    expect(s.run().code).toBe(1);
    expect(s.alerts()[0]).toMatch(/Restate reported severe lag 2 times since the last check \(longest 16 s\): the Docker VM is overloaded or stalling/);
  });

  it('restarts the stack from the current release, stamped with its commit, not from the checkout it was started from', () => {
    const s = setup({ running: STACK.filter((c) => !c.includes('desk')) });
    s.run();
    const commit = execFileSync('git', ['-C', s.release, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(s.calls()).toContain(`docker compose -f ${s.release}/infra/docker/docker-compose.prod.yml -f ${s.release}/infra/docker/canva-release.override.yml --env-file ${s.release}/infra/docker/.env start stamp=${commit}`);
    expect(s.calls()).not.toContain(`-f ${repo}/infra/docker`);
  });

  // Hunt 3 (the 2026-10-02 Telegram outage nobody was told about): notify() counted any answer, or none,
  // as sent. A refused token, a rate limit or Telegram being unreachable from this host marked the alert
  // sent, so the 30-minute cooldown held back the next try, and nothing in the log said it was lost.
  it('an alert Telegram did not take is logged, not counted as sent, and tried again at the next pass', () => {
    const s = setup();
    fs.writeFileSync(s.f('telegram-down'), '');
    fs.writeFileSync(s.f('health'), health({ parkedClientMessages: 1 }, 'degraded'));
    const r = s.run();
    expect(r.code).toBe(1);
    expect(s.alerts()).toEqual([]);
    expect(r.stdout).toMatch(/Z ALERT NOT SENT: Telegram did not take it \(curl exit 22\)/);
    expect(s.state()).toMatch(/^alert_key=''$/m);
    expect(r.out).not.toContain('stub:alerts');
    // Telegram answers again five minutes later: the same problem goes out now, not after the cooldown.
    fs.rmSync(s.f('telegram-down'));
    s.run();
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toContain('parkedClientMessages');
    s.run();
    expect(s.alerts()).toHaveLength(1);
  });

  it('a problem whose every alert was lost is still announced as over once Telegram takes messages again', () => {
    const s = setup();
    fs.writeFileSync(s.f('telegram-down'), '');
    fs.writeFileSync(s.f('health'), health({ telegramApi: 'unreachable' }, 'degraded'));
    s.run(); s.run();
    expect(s.alerts()).toEqual([]);
    fs.rmSync(s.f('telegram-down'));
    fs.writeFileSync(s.f('health'), health());
    expect(s.run().code).toBe(0);
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toMatch(/^ALERT ✅ Hawa is back to normal .*telegramApi/);
  });

  it('a recovery notice Telegram did not take is sent at the next healthy pass', () => {
    const s = setup();
    fs.writeFileSync(s.f('health'), health({ parkedClientMessages: 1 }, 'degraded'));
    s.run();
    expect(s.alerts()).toHaveLength(1);
    fs.writeFileSync(s.f('health'), health());
    fs.writeFileSync(s.f('telegram-down'), '');
    expect(s.run().code).toBe(0);
    expect(s.alerts()).toHaveLength(1);
    fs.rmSync(s.f('telegram-down'));
    expect(s.run().code).toBe(0);
    expect(s.alerts()).toHaveLength(2);
    expect(s.alerts()[1]).toMatch(/^ALERT ✅ Hawa is back to normal .*parkedClientMessages/);
    s.run();
    expect(s.alerts()).toHaveLength(2);
  });

  it('--notify and --announce fail when the message was not delivered (the canary then says it could not alert)', () => {
    const s = setup();
    expect(s.run(['--notify', 'canary failed']).code).toBe(0);
    expect(s.alerts()).toEqual(['ALERT canary failed']);
    fs.writeFileSync(s.f('telegram-down'), '');
    const notify = s.run(['--notify', 'canary failed again']);
    expect(notify.code).toBe(1);
    expect(notify.stdout).toMatch(/ALERT NOT SENT/);
    expect(s.run(['--announce']).code).toBe(1);
    expect(s.alerts()).toHaveLength(1);
  });

  // Hunt 3: while deploy.sh --apply recreated containers, the watchdog saw one missing and ran its own
  // `compose start` / `up -d --no-recreate` beside the deploy's `up -d`: two compose runs creating the same
  // container (a name conflict that ends the deploy half-way, or containers left "Created", as on
  // 2026-09-18). While a deploy applies, containers are left to it; the pass still checks and reports.
  it('starts no container while a deploy holds the deploy lock, and still reports what it sees', async () => {
    const s = setup({ running: STACK.filter((c) => !c.includes('core')) });
    const lockFile = path.join(s.home, '.hawa', 'deploy.lock');
    // The holder's command line names the job: bash -c '…' <name>.
    const hold = (name: string) => spawn('python3', [path.join(repo, 'infra/ops/deploy_lock.py'), '--lock', lockFile, '--',
      'bash', '-c', 'echo held; exec /bin/sleep 30', name]);
    // The nightly canary (or backup) holding it changes no container: the pass starts what is missing.
    const canary = hold('infra/ops/live_canary.sh');
    await once(canary.stdout, 'data');
    try { s.run(); } finally { canary.kill('SIGTERM'); await once(canary, 'exit'); }
    expect(s.calls()).toMatch(/docker compose .* start stamp=/);
    fs.rmSync(s.f('calls'));
    // A deploy holding it: left to the deploy.
    const deploy = hold('infra/docker/deploy.sh');
    await once(deploy.stdout, 'data');
    let r: ReturnType<typeof s.run>;
    try { r = s.run(); } finally { deploy.kill('SIGTERM'); await once(deploy, 'exit'); }
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Z a deploy holds the deploy lock: its containers are left to it this pass/);
    expect(s.calls()).not.toMatch(/docker compose .* (start|up)/);
    expect(s.calls()).not.toMatch(/docker start/);
    expect(r.stdout).toMatch(/Z PROBLEM: only 5\/6 stack containers running \(down: core\)/);
    // Once the deploy is over, the pass starts what is missing as before.
    s.run();
    expect(s.calls()).toMatch(/docker compose .* start stamp=/);
  });

  // Hunt 3: on 2026-10-02 production was unreachable for 70 minutes (17:15-18:25Z) and nobody was told.
  // A Mac that sleeps, is shut down or waits at FileVault runs no watchdog pass at all, and the first pass
  // afterwards found everything healthy and said nothing. The watchdog now notices its own gap.
  it('tells the operator, once, when it did not run for a while (the host asleep, off or locked)', () => {
    const s = setup();
    const lastRun = path.join(s.home, '.hawa', 'watchdog', 'last_run');
    fs.writeFileSync(lastRun, `${Math.floor(Date.now() / 1000) - 70 * 60}\n`);
    const r = s.run();
    expect(r.code).toBe(0);
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0]).toMatch(/^ALERT 🟠 The Hawa watchdog did not run for 70 min \(\d\d:\d\d to \d\d:\d\d\)/);
    expect(r.stdout).toMatch(/Z the watchdog did not run for 70 min/);
    s.run();
    expect(s.alerts()).toHaveLength(1);
    // Passes five or ten minutes apart are normal.
    fs.writeFileSync(lastRun, `${Math.floor(Date.now() / 1000) - 10 * 60}\n`);
    s.run();
    expect(s.alerts()).toHaveLength(1);
  });

  it('judges the disk by free space: 97% used with 30 GiB free is fine, 20 GiB free is reported', () => {
    const fine = setup({ freeKb: 30 * 1048576 });
    expect(fine.run().code).toBe(0);
    const low = setup({ freeKb: 20 * 1048576 });
    const r = low.run();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Z PROBLEM: disk 20 GiB free$/m);
    expect(low.alerts()[0]).toMatch(/The production host's disk has 20 GB free \(97% used; the alert is below 25 GB\)/);
  });
});
