import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/ops/watchdog.sh and the nightly Restate backup (infra/backup/restate_nightly.py; ADR-053/054,
 * ADR-127). The watchdog starts every stopped stack container every 5 minutes; during a backup that
 * would start Restate under the cold copy. A backup killed outright runs no cleanup, so Restate stays
 * stopped and Telegram intake paused until someone notices. Ported from studio-v2 088ce5e6/4eb16341
 * onto this branch's Python backup: the archive lock says whether a run is alive, its run record says
 * what a dead run changed, and `restate_nightly.py --recover` puts that back.
 *
 * `docker`, `curl`, `open` and `sleep` are stubbed on PATH, so no pass here reaches Docker, Core or
 * Telegram; the real restate_nightly.py runs against the stub.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = path.resolve(here, '../../../infra/ops/watchdog.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const TAG = '00000000-0000-4000-a000-000000000007';

const temps: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

const DOCKER_STUB = `#!/bin/bash
args="$*"
echo "docker \${args//$'\\n'/ }" >> "$STUB_CALLS"
case "$*" in
  "info"*) exit 0 ;;
  *"--format {{.State.Health.Status}}"*) echo healthy ;;
  *" psql "*) echo t ;;
  "exec hawa-production-core-1 node -e"*" release ${TAG}") echo '{"enabled":true,"killSwitchActive":false,"changeTag":"00000000-0000-4000-a000-000000000008","channels":{"telegram":true}}' ;;
  "exec hawa-production-core-1 node -e"*" status") echo '{"channels":{"telegram":true}}' ;;
  "ps -a "*) [[ -n "\${STUB_EXITED:-}" ]] && printf '%s\\n' \${STUB_EXITED} ;;
  *" up -d --no-deps restate") [[ -z "\${STUB_RESTATE_UP_FAILS:-}" ]] || exit 1 ;;
esac
exit 0
`;

function setup() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-watchdog-rb-'));
  temps.push(t);
  const bin = path.join(t, 'bin');
  const home = path.join(t, 'home');
  const archive = path.join(t, 'archive');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, '.hawa'), { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  const callsFile = path.join(t, 'calls');
  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  for (const tool of ['curl', 'open', 'sleep']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "$STUB_CALLS"\nexit 0\n`, { mode: 0o755 });
  }
  const record = path.join(home, '.hawa', 'restate-backup.state');
  return {
    t, bin, home, archive, record,
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8') : ''),
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: home, STUB_CALLS: callsFile, HAWA_RESTATE_BACKUP_HEALTH_SECONDS: '0' },
  };
}

function writeRecord(s: ReturnType<typeof setup>, fields: Record<string, unknown>) {
  fs.writeFileSync(s.record, JSON.stringify({ v: 1, pid: 1, stamp: '20260928T013000Z', archiveDir: s.archive, switch: 'paused', changeTag: TAG, restate: 'stopping', ...fields }), { mode: 0o600 });
}

/** A live backup run: a process holding the archive lock, as nightly_backup.sh's does for the whole night. */
async function liveBackup(s: ReturnType<typeof setup>): Promise<void> {
  const child = spawn('python3', ['-c', `import fcntl,sys,time\nf=open(sys.argv[1],'w')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\ntime.sleep(120)`, path.join(s.archive, '.restate-backup.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', () => reject(new Error('lock holder exited')));
  });
}

function runWatchdog(s: ReturnType<typeof setup>, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const res = spawnSync(BASH, [watchdog, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...s.env, ...extraEnv } });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

describe('the watchdog and the nightly Restate backup', () => {
  it('skips its pass, touching nothing, while a backup run holds the archive lock', async () => {
    const s = setup();
    writeRecord(s, {});
    await liveBackup(s);
    const r = runWatchdog(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/the nightly Restate backup is running; this pass is skipped/);
    expect(s.calls()).toBe('');
    expect(fs.existsSync(s.record)).toBe(true);
  });

  it('puts back what a backup killed outright left: Restate first, then its own pause, by its revision', () => {
    const s = setup();
    writeRecord(s, {});
    const r = runWatchdog(s);
    expect(r.out, s.calls()).toMatch(/the nightly Restate backup was cut off; recovered: restate,kill_switch/);
    // The pass goes on after the recovery: with the stubbed stack it ends on its own health problems.
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/PROBLEM: .*core health does not answer/);
    expect(r.out).not.toMatch(/Restate backup recovery failed/);
    const calls = s.calls().split('\n');
    const up = calls.findIndex((c) => /^docker compose .* up -d --no-deps restate$/.test(c));
    const release = calls.findIndex((c) => c.startsWith('docker exec hawa-production-core-1 node -e') && c.endsWith(` release ${TAG}`));
    expect(up, s.calls()).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(up);
    expect(fs.existsSync(s.record)).toBe(false);
  });

  it('--status reports a record left to put back and changes nothing', () => {
    const s = setup();
    writeRecord(s, {});
    const r = runWatchdog(s, ['--status']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/cut-off Restate backup left Restate or intake to put back/);
    expect(s.calls()).not.toMatch(/up -d --no-deps restate|release/);
    expect(fs.existsSync(s.record)).toBe(true);
  });

  it('reports, and keeps the record, when the cut-off run left a pause whose revision it never saw', () => {
    const s = setup();
    writeRecord(s, { switch: 'pausing', changeTag: null, restate: 'running' });
    fs.writeFileSync(path.join(s.bin, 'docker'), DOCKER_STUB.replace('*" psql "*) echo t ;;', '*" psql "*) echo f ;;').replace(`echo '{"channels":{"telegram":true}}'`, `echo '{"channels":{"telegram":false}}'`), { mode: 0o755 });
    const r = runWatchdog(s);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/pause revision was never recorded/);
    expect(s.calls()).not.toMatch(/ release /);
    expect(fs.existsSync(s.record)).toBe(true);
  });

  // Review finding (2026-09-28): a recovery problem was put into `problems` before the Docker check,
  // and step 2 (start and report the stack containers) ran only with no problem at all, so a record
  // that could not be put back stopped every restart and every "N/6 running" report until it cleared.
  const STACK_START = /^docker compose .* (start|up -d --no-build --no-recreate)$/m;

  it('still starts and reports stopped stack containers when a pausing record cannot be put back', () => {
    const s = setup();
    writeRecord(s, { switch: 'pausing', changeTag: null, restate: 'running' });
    fs.writeFileSync(path.join(s.bin, 'docker'), DOCKER_STUB.replace('*" psql "*) echo t ;;', '*" psql "*) echo f ;;').replace(`echo '{"channels":{"telegram":true}}'`, `echo '{"channels":{"telegram":false}}'`), { mode: 0o755 });
    const r = runWatchdog(s);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/pause revision was never recorded/);
    expect(s.calls(), r.out).toMatch(STACK_START);
    expect(r.out).toMatch(/only 0\/6 stack containers running \(down: nginx,desk,core,cutout,postgres,restate\)/);
    expect(fs.existsSync(s.record)).toBe(true);
  });

  it('after a reboot, a failed Restate start in recovery does not stop the stack restart', () => {
    const s = setup();
    writeRecord(s, {});
    const r = runWatchdog(s, [], { STUB_RESTATE_UP_FAILS: '1' });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/Restate backup recovery failed/);
    expect(s.calls(), r.out).toMatch(STACK_START);
    expect(r.out).toMatch(/stack containers running/);
    expect(fs.existsSync(s.record)).toBe(true);
  });

  it('with a backup stuck under a live lock, starts the other containers but never Restate', async () => {
    const s = setup();
    writeRecord(s, {});
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(s.record, threeHoursAgo, threeHoursAgo);
    await liveBackup(s);
    const exited = 'hawa-production-core-1 hawa-production-restate-1 hawa-production-nginx-1 hawa-production-vector-1';
    const r = runWatchdog(s, [], { STUB_EXITED: exited });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/has held the archive lock for \d+ minutes/);
    const calls = s.calls();
    // Neither a bare `compose start`/`up` (every service, Restate with them) nor Restate by name.
    expect(calls, r.out).not.toMatch(STACK_START);
    expect(calls).not.toMatch(/docker start hawa-production-restate-1/);
    expect(calls).not.toMatch(/ up .*restate/);
    expect(calls).toMatch(/^docker start hawa-production-core-1$/m);
    expect(calls).toMatch(/^docker start hawa-production-nginx-1$/m);
    expect(calls).toMatch(/^docker start hawa-production-vector-1$/m);
    expect(calls).toMatch(/^docker compose .* up -d --no-build --no-recreate --no-deps nginx desk core cutout postgres vector$/m);
    expect(r.out).toMatch(/stack containers running \(down: .*restate/);
    expect(fs.existsSync(s.record)).toBe(true);
  });

  it('with no record the pass goes on as before', () => {
    const s = setup();
    const r = runWatchdog(s, ['--status']);
    expect(r.out).not.toMatch(/Restate backup/);
    expect(s.calls()).toMatch(/^docker /m);
  });
});
