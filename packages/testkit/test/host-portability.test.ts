import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-141 (plans/hosting section 3.6): the production scripts read file sizes and modes and hash files
 * on macOS today and on an arm64 Linux server later. `stat -f … || stat -c …` stopped deploy.sh on
 * Linux, where `stat -f` is "file-system status": several lines and a failure, both in one variable.
 * infra/ops/host_lib.sh chooses the command once by `uname`; the host role (production, standby,
 * retired) comes from the same file.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const lib = path.join(repo, 'infra/ops/host_lib.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-host-lib-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sh(body: string, env: Record<string, string> = {}) {
  const res = spawnSync(BASH, ['-c', `set -Eeuo pipefail\nsource '${lib}'\n${body}`], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(tmp, 'home'), ...env },
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr };
}

/** A PATH whose `uname` says `os` and whose `stat` only records how it was called. */
function fakeHost(os_: string, extra: Record<string, string> = {}): string {
  const bin = fs.mkdtempSync(path.join(tmp, `bin-${os_}-`));
  fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/bash\necho ${os_}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/bash\necho "stat $*"\n', { mode: 0o755 });
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  return bin;
}

describe('host_lib: stat and SHA-256 by uname, never a || fallback', () => {
  it('uses GNU stat -c on Linux and BSD stat -f on macOS', () => {
    const linux = sh('hawa_file_size /x; hawa_file_mode /x', { PATH: `${fakeHost('Linux')}:/usr/bin:/bin` });
    expect(linux.out.split('\n')).toEqual(['stat -c %s /x', 'stat -c %a /x']);
    const mac = sh('hawa_file_size /x; hawa_file_mode /x', { PATH: `${fakeHost('Darwin')}:/usr/bin:/bin` });
    expect(mac.out.split('\n')).toEqual(['stat -f %z /x', 'stat -f %Lp /x']);
  });

  it('reads real sizes and modes on this host, one line each', () => {
    const f = path.join(tmp, 'sized');
    fs.writeFileSync(f, 'x'.repeat(1234), { mode: 0o640 });
    fs.chmodSync(f, 0o640);
    expect(sh(`hawa_file_size '${f}'; hawa_file_mode '${f}'; printf '%s\\0' '${f}' '${f}' | xargs -0 "\${HAWA_STAT_SIZE[@]}"`).out.split('\n'))
      .toEqual(['1234', '640', '1234', '1234']);
  });

  it('hashes with shasum where it exists, else with sha256sum, in the same format', () => {
    const f = path.join(tmp, 'hashed');
    fs.writeFileSync(f, 'hawa');
    const real = sh(`"\${HAWA_SHA256[@]}" '${f}' | cut -d' ' -f1; printf hawa | "\${HAWA_SHA256[@]}" | cut -d' ' -f1`).out.split('\n');
    expect(real[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(real[1]).toBe(real[0]);
    // No shasum on PATH (a Linux host without perl): sha256sum is chosen.
    const bin = fakeHost('Linux', { sha256sum: '#!/bin/bash\necho "sha256sum $*"\n' });
    const onlyCore = sh(`echo "\${HAWA_SHA256[*]}"`, { PATH: bin });
    expect(onlyCore.out).toBe('sha256sum');
  });
});

describe('host_lib: dates some days ago', () => {
  it('uses BSD date -v on macOS and GNU date -d on Linux, and gives today for 0 days here', () => {
    const rec = { date: '#!/bin/bash\necho "date $*"\n' };
    expect(sh('hawa_utc_days_ago 30 %Y%m%d', { PATH: `${fakeHost('Linux', rec)}:/usr/bin:/bin` }).out).toBe('date -u -d -30 days +%Y%m%d');
    expect(sh('hawa_utc_days_ago 30 %Y%m%d', { PATH: `${fakeHost('Darwin', rec)}:/usr/bin:/bin` }).out).toBe('date -u -v-30d +%Y%m%d');
    expect(sh('hawa_utc_days_ago 0 %Y-%m-%d').out).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('host_lib: the host role', () => {
  const home = path.join(tmp, 'role-home');
  const roleFile = path.join(home, '.hawa', 'host-role');
  const role = (env: Record<string, string> = {}) => sh('r="$(hawa_host_role)" && rc=0 || rc=$?; echo "$r $rc $(hawa_host_role_source)"', { HOME: home, ...env }).out;

  it('is production with no marker, and reads the marker file, then the environment', () => {
    fs.rmSync(home, { recursive: true, force: true });
    expect(role()).toBe(`production 0 ${roleFile}`);
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, ' Retired \n# moved to the server on 2026-10-01\n');
    expect(role()).toBe(`retired 0 ${roleFile}`);
    expect(role({ HAWA_HOST_ROLE: 'standby' })).toBe('standby 0 HAWA_HOST_ROLE');
    expect(role({ HAWA_HOST_ROLE: 'production' })).toBe('production 0 HAWA_HOST_ROLE');
    fs.writeFileSync(roleFile, '');
    expect(role()).toBe(`production 0 ${roleFile}`);
  });

  it('refuses a value it does not know (exit 2), so a typo never counts as production', () => {
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, 'retierd\n');
    expect(role()).toBe(`retierd 2 ${roleFile}`);
    expect(role({ HAWA_HOST_ROLE_FILE: path.join(tmp, 'none') })).toBe(`production 0 ${path.join(tmp, 'none')}`);
  });
});

describe('local_state_audit.sh reads modes with the host\'s stat', () => {
  // A throwaway repository holding the audit and host_lib, so the real checkout's files are never listed.
  const fake = path.join(tmp, 'audit-repo');
  fs.mkdirSync(path.join(fake, 'infra/security'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'infra/ops'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'infra/backup/snapshots'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'infra/security/local_state_audit.sh'), path.join(fake, 'infra/security/local_state_audit.sh'));
  fs.copyFileSync(lib, path.join(fake, 'infra/ops/host_lib.sh'));
  fs.writeFileSync(path.join(fake, '.gitignore'), 'infra/backup/snapshots/\n');
  execFileSync('git', ['init', '-q', fake]);
  const dump = path.join(fake, 'infra/backup/snapshots/hawa_20260929T003004Z.dump');
  fs.writeFileSync(dump, 'x'.repeat(2048));
  const audit = () => spawnSync(BASH, [path.join(fake, 'infra/security/local_state_audit.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });

  it('flags a dump other users can read, and passes it once it is 0600', () => {
    fs.chmodSync(dump, 0o644);
    const open = audit();
    expect(open.status, open.stderr).toBe(1);
    expect(open.stdout).toMatch(/^644 +2048 +database dump +infra\/backup\/snapshots\/hawa_20260929T003004Z\.dump EXPOSED$/m);
    fs.chmodSync(dump, 0o600);
    const closed = audit();
    expect(closed.status, closed.stderr).toBe(0);
    expect(closed.stdout).toMatch(/^600 +2048 +database dump +infra\/backup\/snapshots\/hawa_20260929T003004Z\.dump$/m);
    expect(closed.stderr).toBe('');
  });
});

describe('no production host script keeps a Mac-only or a || stat form', () => {
  const scripts = ['infra/security/local_state_audit.sh', 'infra/backup/nightly_backup.sh', 'infra/backup/restore_drill.sh',
    'infra/backup/backup_restore_drill.sh', 'infra/backup/drill_restore_swap.sh',
    'infra/docker/deploy.sh', 'infra/ops/watchdog.sh', 'infra/ops/disk_cleanup.sh', 'scripts/enforce_release_gate.sh',
    'scripts/disaster_recovery_drill.sh'];
  it.each(scripts)('%s', (script) => {
    const code = fs.readFileSync(path.join(repo, script), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\bstat -[fc]\b/);
    expect(code).not.toMatch(/\bshasum\b/);
    expect(code).not.toMatch(/sed -i ''/);
    expect(code).not.toMatch(/\bdate [^|;]*-[vj]\b/);
    // open -ga (Docker Desktop) stays only behind the watchdog's macOS branch.
    if (script !== 'infra/ops/watchdog.sh') expect(code).not.toMatch(/\bopen -g/);
  });
});
