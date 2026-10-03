import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hunt 3: the nightly backup and the monthly restore drill take the archive lock without waiting
 * (infra/backup/archive_lock.py). When it was busy (an off-site copy or a drill still reading the archive,
 * or launchd starting every job a sleeping Mac missed at the same moment on wake), they exited 1 with no
 * line in backup.log, no drill record and no alert: the night's backup was simply not taken, and the
 * watchdog only noticed when the last one turned 26 hours old. Now they wait for the lock
 * (HAWA_BACKUP_LOCK_WAIT_SECONDS / HAWA_DRILL_LOCK_WAIT_SECONDS) and, if it stays busy, fail the way any
 * other failure does: a FAIL line, the operator told.
 *
 * Docker, curl and sleep are stubs first on PATH; the archive lock is held by a real flock.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-archive-lock-wait-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function setup() {
  const t = path.join(tmp, `case-${++n}`);
  const bin = path.join(t, 'bin'), home = path.join(t, 'home'), archive = path.join(t, 'archive'), snapshots = path.join(t, 'snapshots');
  for (const d of [bin, home, archive, snapshots]) fs.mkdirSync(d, { recursive: true });
  const f = (name: string) => path.join(t, name);
  fs.writeFileSync(f('env.production'), 'TELEGRAM_BOT_TOKEN=700:stub:lock\nTELEGRAM_ALLOWED_USERS=9000004\n', { mode: 0o600 });
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Postgres is never ready: a run that got the lock stops at its first step, and says so.
  stub('docker', `echo "docker $*" >> '${f('calls')}'; exit 1`);
  stub('curl', `for a in "$@"; do [[ "$a" == text=* ]] && printf '%s\\n' "\${a#text=}" >> '${f('alerts')}'; done; exit 0`);
  // The lock wait's own pauses are shortened to a tenth of a second.
  stub('sleep', `echo "sleep $*" >> '${f('sleeps')}'; exec /bin/sleep 0.1`);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home,
    HAWA_BACKUP_ARCHIVE_DEST: archive, HAWA_BACKUP_SNAPSHOT_DIR: snapshots, HAWA_BACKUP_NOTIFY_ENV: f('env.production'),
    HAWA_DRILL_DIR: f('drill'), HAWA_BACKUP_PG_CONTAINER: 'hawa-test-postgres-stub',
  };
  const run = (script: string, extra: Record<string, string> = {}) =>
    spawnSync(BASH, [path.join(repo, script)], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  const read = (name: string) => (fs.existsSync(f(name)) ? fs.readFileSync(f(name), 'utf8') : '');
  const log = () => (fs.existsSync(path.join(snapshots, 'backup.log')) ? fs.readFileSync(path.join(snapshots, 'backup.log'), 'utf8') : '');
  return { t, f, archive, snapshots, run, read, log };
}

/** Holds the archive lock exclusively, as a running nightly backup does, until released. */
async function holdLock(archive: string): Promise<{ release: () => Promise<void> }> {
  const holder: ChildProcessWithoutNullStreams = spawn('python3', ['-c',
    "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.readline()",
    path.join(archive, '.restate-backup.lock')]);
  const [ready] = await once(holder.stdout, 'data');
  expect(String(ready)).toContain('locked');
  const exited = once(holder, 'exit');
  return { release: async () => { holder.stdin.end('\n'); await exited; } };
}

describe('the nightly backup when the archive lock is busy', () => {
  it('fails the night loudly once the wait is over: a FAIL line the watchdog reads, and the operator told', async () => {
    const s = setup();
    const lock = await holdLock(s.archive);
    try {
      const r = s.run('infra/backup/nightly_backup.sh', { HAWA_BACKUP_LOCK_WAIT_SECONDS: '0' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(s.log()).toMatch(/^\S+ FAIL \d{8}T\d{6}Z: the backup archive stayed locked for 0 s/m);
      expect(s.read('alerts')).toContain('Hawa nightly backup FAILED');
      expect(s.read('calls')).toBe(''); // nothing was dumped
      const status = spawnSync('python3', [path.join(repo, 'infra/backup/backup_status.py'), '--snapshots', s.snapshots], { encoding: 'utf8' });
      expect(status.status).toBe(1);
      expect(status.stdout).toContain('latest nightly backup failed');
    } finally {
      await lock.release();
    }
  });

  it('waits for the lock, then runs', async () => {
    const s = setup();
    // A holder that lets go by itself after a second and a half (this test's own timers could not run
    // while the script runs synchronously).
    const holder = spawn('python3', ['-c',
      "import fcntl,os,sys,time; fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(1.5)",
      path.join(s.archive, '.restate-backup.lock')]);
    const [ready] = await once(holder.stdout, 'data');
    expect(String(ready)).toContain('locked');
    const r = s.run('infra/backup/nightly_backup.sh', { HAWA_BACKUP_LOCK_WAIT_SECONDS: '3600' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('waiting for the backup archive lock');
    expect(s.read('sleeps')).toMatch(/^sleep 30$/m);
    // It got the lock and ran: its own first step failed (the stub Postgres), not the lock.
    expect(s.log()).toMatch(/FAIL \d{8}T\d{6}Z: postgres container not ready/);
    expect(s.log()).not.toMatch(/stayed locked/);
    expect(s.log().trim().split('\n')).toHaveLength(1);
  });
});

describe('the monthly restore drill when the archive lock is busy', () => {
  it('fails loudly once the wait is over, and tells the operator', async () => {
    const s = setup();
    const lock = await holdLock(s.archive);
    try {
      const r = s.run('infra/backup/restore_drill.sh', { HAWA_DRILL_LOCK_WAIT_SECONDS: '0' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/DRILL FAIL: the backup archive stayed locked for 0 s/);
      expect(s.read('alerts')).toContain('Hawa monthly restore drill FAILED');
      // The failure is recorded in hawa.backup_drills like any other.
      expect(s.read('calls')).toContain('psql -U hawa_owner');
    } finally {
      await lock.release();
    }
  });
});
