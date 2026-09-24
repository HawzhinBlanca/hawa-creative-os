import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/ops/watchdog.sh starts every stopped stack container every 5 minutes. The nightly Restate
 * backup (infra/backup/restate-nightly.sh) stops Restate for the length of a tar; a watchdog pass then
 * would start it under the tar and tear the archive. While a backup run is alive (its state file names
 * a live restate-nightly process, written in the last 30 minutes) the watchdog skips its pass.
 *
 * `docker`, `curl` and `open` are stubbed on PATH, so no pass here reaches Docker, Core or Telegram.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = path.resolve(here, '../../../infra/ops/watchdog.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const temps: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function setup() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-watchdog-rb-'));
  temps.push(t);
  const bin = path.join(t, 'bin');
  const home = path.join(t, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, '.hawa'), { recursive: true });
  for (const tool of ['docker', 'curl', 'open']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "${path.join(t, 'calls')}"\nexit 0\n`, { mode: 0o755 });
  }
  return { t, bin, home, state: path.join(home, '.hawa', 'restate-backup.state'), calls: () => (fs.existsSync(path.join(t, 'calls')) ? fs.readFileSync(path.join(t, 'calls'), 'utf8') : '') };
}

/** A live process whose command line names restate-nightly, as the real backup's does. */
function fakeBackupProcess(t: string): ChildProcess {
  const file = path.join(t, 'restate-nightly.sh');
  fs.writeFileSync(file, 'sleep 60\n');
  const child = spawn(BASH, [file], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function runWatchdog(s: ReturnType<typeof setup>, args: string[] = []) {
  const res = spawnSync(BASH, [watchdog, ...args], { encoding: 'utf8', timeout: 60_000, env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: s.home } });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

describe('the watchdog and the nightly Restate backup', () => {
  it('skips its pass, touching nothing, while a backup run is alive', () => {
    const s = setup();
    const child = fakeBackupProcess(s.t);
    fs.writeFileSync(s.state, `pid=${child.pid}\nstamp=20260925T013000Z\nswitch=1\nrestate=1\ncontainer=hawa-production-restate-1\n`);
    const r = runWatchdog(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/nightly Restate backup is running \(pid \d+\); this pass is skipped/);
    expect(s.calls()).toBe('');
  });

  it('runs as usual when the run named in the state file is gone (a killed backup)', () => {
    const s = setup();
    const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(s.state, `pid=${dead}\nstamp=20260925T013000Z\nswitch=1\nrestate=1\ncontainer=hawa-production-restate-1\n`);
    const r = runWatchdog(s, ['--status']);
    expect(r.out).not.toMatch(/this pass is skipped/);
    expect(s.calls()).toMatch(/^docker /m);
  });

  it('runs as usual when the state file has not moved for 30 minutes (a hung backup)', () => {
    const s = setup();
    const child = fakeBackupProcess(s.t);
    fs.writeFileSync(s.state, `pid=${child.pid}\nstamp=20260925T013000Z\nswitch=1\nrestate=1\ncontainer=hawa-production-restate-1\n`);
    const old = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(s.state, old, old);
    const r = runWatchdog(s, ['--status']);
    expect(r.out).not.toMatch(/this pass is skipped/);
    expect(s.calls()).toMatch(/^docker /m);
  });
});
