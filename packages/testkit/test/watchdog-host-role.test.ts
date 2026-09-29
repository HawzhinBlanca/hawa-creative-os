import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/ops/watchdog.sh on the hosts of a move (ADR-141, plans/hosting sections 7.4 and 8).
 *
 * Retired and standby hosts: when production moves, the old host's watchdog would start its stack
 * again within five minutes, and two hosts would poll the same Telegram bot. On a host marked retired
 * or standby the watchdog starts nothing, never touches Restate, and reports (and alerts about)
 * production containers running there.
 *
 * Linux: Docker Engine is a systemd service. The watchdog reads its state instead of `open -ga Docker`
 * (a Mac app), and the disk alert no longer sends a server's owner to macOS System Settings.
 *
 * `docker`, `curl`, `open`, `sleep`, `uname`, `systemctl` and `df` are stubs on PATH.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = path.resolve(here, '../../../infra/ops/watchdog.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function setup(opts: { running?: string[]; dockerUp?: boolean | 'after-2'; os?: string; dockerService?: string; diskPercent?: number } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-watchdog-role-'));
  temps.push(t);
  const bin = path.join(t, 'bin');
  const home = path.join(t, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, '.hawa', 'watchdog'), { recursive: true });
  // No clean-up run in a test: the last one was just now.
  fs.writeFileSync(path.join(home, '.hawa', 'watchdog', 'state'), `last_cleanup=${Math.floor(Date.now() / 1000)}\n`);
  const calls = path.join(t, 'calls');
  const counter = path.join(t, 'info-count');
  const up = opts.dockerUp ?? true;
  const info = up === true ? 'exit 0' : up === false ? 'exit 1'
    : `n=$(( $(cat '${counter}' 2>/dev/null || echo 0) + 1 )); echo $n > '${counter}'; [[ $n -gt 2 ]] && exit 0; exit 1`;
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> "$STUB_CALLS"
case "$*" in
  "info"*) ${info} ;;
  "ps --filter name=hawa-production- --filter status=running"*) printf '%s\\n' ${(opts.running ?? []).map((n) => `'${n}'`).join(' ')} ;;
esac
exit 0
`, { mode: 0o755 });
  for (const tool of ['curl', 'open', 'sleep']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "$STUB_CALLS"\nexit 0\n`, { mode: 0o755 });
  }
  if (opts.os) fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/bash\n[[ "$1" == -s ]] && echo ${opts.os} || /usr/bin/uname "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash\necho "systemctl $*" >> "$STUB_CALLS"\n[[ "$*" == "is-active docker" ]] && { echo ${opts.dockerService ?? 'inactive'}; [[ ${opts.dockerService ?? 'inactive'} == active ]]; exit; }\nexit 0\n`, { mode: 0o755 });
  if (opts.diskPercent) {
    fs.writeFileSync(path.join(bin, 'df'), `#!/bin/bash
echo "Filesystem Size Used Avail Capacity Mounted"
if [[ "$1" == -h ]]; then echo "/dev/x 100G 95G 5${opts.os === 'Darwin' ? 'Gi' : 'G'} ${opts.diskPercent}% /"; else echo "/dev/x 100 95 5 ${opts.diskPercent}% /"; fi
`, { mode: 0o755 });
  }
  const envFile = path.join(t, 'env.production');
  fs.writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${['700', 'stub', 'role'].join(':')}\nTELEGRAM_ALLOWED_USERS=9000002\n`, { mode: 0o600 });
  return {
    home,
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''),
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: home, STUB_CALLS: calls,
      HAWA_RESTATE_BACKUP_HEALTH_SECONDS: '0', HAWA_WATCHDOG_ENV_FILE: envFile } as Record<string, string>,
  };
}

function run(s: ReturnType<typeof setup>, args: string[] = [], extra: Record<string, string> = {}) {
  const res = spawnSync(BASH, [watchdog, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...s.env, ...extra } });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}
const STARTS = /compose .*(start|up)|docker start|open -ga|restate/;
const retire = (s: ReturnType<typeof setup>, role = 'retired') => fs.writeFileSync(path.join(s.home, '.hawa', 'host-role'), `${role}\n`);

describe('the watchdog on a retired or standby host', () => {
  it('a retired host with nothing running starts nothing and says so', () => {
    const s = setup();
    retire(s);
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`retired host (${path.join(s.home, '.hawa', 'host-role')}): production runs elsewhere; nothing was started`);
    expect(s.calls()).not.toMatch(STARTS);
    expect(s.calls()).not.toMatch(/curl/);
  });

  it('the same with HAWA_HOST_ROLE=standby, even with Docker stopped (it is not started)', () => {
    const s = setup({ dockerUp: false });
    const r = run(s, [], { HAWA_HOST_ROLE: 'standby' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('standby host (HAWA_HOST_ROLE): production runs elsewhere; nothing was started');
    expect(s.calls()).not.toMatch(STARTS);
    expect(s.calls()).not.toMatch(/sleep/);
  });

  it('production containers running on a retired host are reported and alerted, never restarted or stopped', () => {
    const s = setup({ running: ['hawa-production-core-1', 'hawa-production-worker-blue-1'] });
    retire(s);
    const r = run(s);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('PROBLEM: this retired host is running production containers (hawa-production-core-1 hawa-production-worker-blue-1); stop them here, since two live hosts poll the same Telegram bot');
    expect(s.calls()).toMatch(/curl .*sendMessage/);
    expect(s.calls()).not.toMatch(STARTS);
    expect(s.calls()).not.toMatch(/docker (stop|rm|kill)/);
    // The next pass within 30 minutes does not alert again.
    const alerts = (s.calls().match(/sendMessage/g) ?? []).length;
    expect(run(s).code).toBe(1);
    expect((s.calls().match(/sendMessage/g) ?? []).length).toBe(alerts);
  });

  it('--status on a retired host reports and never alerts', () => {
    const s = setup({ running: ['hawa-production-worker-green-1'] });
    retire(s);
    const r = run(s, ['--status']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('this retired host is running production containers (hawa-production-worker-green-1)');
    expect(s.calls()).not.toMatch(/curl/);
  });

  it('an unknown role starts nothing and is reported', () => {
    const s = setup();
    retire(s, 'retierd');
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toContain("PROBLEM: unrecognised host role 'retierd'");
    expect(s.calls()).not.toMatch(STARTS);
  });

  it('--announce on a retired host says what the watchdog will and will not do', () => {
    const s = setup();
    retire(s);
    const r = run(s, ['--announce']);
    expect(r.code).toBe(0);
    expect(s.calls()).toMatch(/curl .*this host is retired .*never starts production here/);
  });

  it('no marker: the pass is today\'s pass (it starts the stack)', () => {
    const s = setup();
    const r = run(s);
    expect(r.out).not.toMatch(/retired|standby/);
    expect(s.calls()).toMatch(/docker compose .* start/);
  });
});

describe('the watchdog on a Linux host', () => {
  it('reports a stopped docker.service without opening a Mac app or waiting', () => {
    const s = setup({ os: 'Linux', dockerUp: false, dockerService: 'inactive' });
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Docker is not running: docker.service is inactive (start it with sudo systemctl start docker');
    expect(s.calls()).toMatch(/systemctl is-active docker/);
    expect(s.calls()).not.toMatch(/^open /m);
    expect(s.calls()).not.toMatch(/sleep 5/);
    expect(s.calls()).not.toMatch(/compose/);
  });

  it('an active docker.service this user cannot reach is named as such', () => {
    const s = setup({ os: 'Linux', dockerUp: false, dockerService: 'active' });
    expect(run(s, ['--status']).out).toContain('docker.service is active but this user cannot reach Docker (is it in the docker group?)');
  });

  it('waits for a docker.service that is starting', () => {
    const s = setup({ os: 'Linux', dockerUp: 'after-2', dockerService: 'activating' });
    const r = run(s, ['--status']);
    expect(r.out).not.toMatch(/Docker is not running|cannot reach Docker/);
    expect(s.calls()).toMatch(/sleep 5/);
  });

  it('macOS still opens Docker Desktop', () => {
    const s = setup({ os: 'Darwin', dockerUp: false });
    const r = run(s);
    expect(r.out).toContain('Docker is not running and could not be started');
    expect(s.calls()).toMatch(/^open -ga Docker$/m);
    expect(s.calls()).not.toMatch(/systemctl/);
  });

  it('the disk alert names the production host, with a Linux or a macOS hint', () => {
    const linux = setup({ os: 'Linux', diskPercent: 95 });
    run(linux);
    expect(linux.calls()).toMatch(/The production host's disk is 95% full \(5 GB free\)/);
    expect(linux.calls()).toMatch(/du -xh --max-depth=2/);
    expect(linux.calls()).not.toMatch(/System Settings|Mac/);
    const mac = setup({ os: 'Darwin', diskPercent: 95 });
    run(mac);
    expect(mac.calls()).toMatch(/The production host's disk is 95% full \(5 GB free\).*System Settings, General, Storage/);
  });
});
