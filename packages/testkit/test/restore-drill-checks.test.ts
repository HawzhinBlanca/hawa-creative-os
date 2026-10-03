import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hunt 3: infra/backup/restore_drill.sh compared the newest archived dump with its .sha256 only when the
 * checksum file was there; without it the check was skipped in silence. The nightly backup publishes the
 * checksum before the dump, so a dump without one is a damaged set: the drill now refuses it, recorded
 * and alerted like any other failure. Docker and curl are stubs; nothing is restored.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-restore-drill-checks-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function setup() {
  const t = path.join(tmp, `case-${++n}`);
  const bin = path.join(t, 'bin'), home = path.join(t, 'home'), archive = path.join(t, 'archive');
  for (const d of [bin, home, archive]) fs.mkdirSync(d, { recursive: true });
  const f = (name: string) => path.join(t, name);
  fs.writeFileSync(f('env.production'), 'TELEGRAM_BOT_TOKEN=700:stub:drill\nTELEGRAM_ALLOWED_USERS=9000005\n', { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "docker $*" >> '${f('calls')}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nfor a in "$@"; do [[ "$a" == text=* ]] && printf '%s\\n' "\${a#text=}" >> '${f('alerts')}'; done\nexit 0\n`, { mode: 0o755 });
  const stamp = '20261003T003000Z';
  const dump = path.join(archive, `hawa_${stamp}.dump`);
  fs.writeFileSync(dump, 'not a real dump');
  fs.writeFileSync(path.join(archive, `hawa_${stamp}.blobs`), '');
  const run = () => spawnSync(BASH, [path.join(repo, 'infra/backup/restore_drill.sh')], { encoding: 'utf8', timeout: 60_000, env: {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, HAWA_BACKUP_ARCHIVE_DEST: archive,
    HAWA_BACKUP_NOTIFY_ENV: f('env.production'), HAWA_DRILL_DIR: f('drill'), HAWA_BACKUP_PG_CONTAINER: 'hawa-test-postgres-stub',
    HAWA_DRILL_LOCK_WAIT_SECONDS: '0' } });
  const read = (name: string) => (fs.existsSync(f(name)) ? fs.readFileSync(f(name), 'utf8') : '');
  return { dump, run, read };
}

describe('the monthly restore drill checks the dump it restores', () => {
  it('refuses a dump that has no checksum file, before restoring anything', () => {
    const s = setup();
    const r = s.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DRILL FAIL: hawa_20261003T003000Z\.dump has no checksum file/);
    expect(s.read('alerts')).toContain('Hawa monthly restore drill FAILED');
    expect(s.read('calls')).not.toMatch(/createdb|pg_restore/);
  });

  it('still refuses a dump that does not match its checksum, and goes on with one that does', () => {
    const s = setup();
    fs.writeFileSync(`${s.dump}.sha256`, `${'0'.repeat(64)}\n`);
    expect(s.run().stderr).toMatch(/DRILL FAIL: hawa_20261003T003000Z\.dump does not match its checksum/);
    fs.writeFileSync(`${s.dump}.sha256`, `${createHash('sha256').update('not a real dump').digest('hex')}\n`);
    const r = s.run();
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/checksum/);
    expect(r.stderr).toMatch(/DRILL FAIL: could not create hawa_drill_/);
  });
});
