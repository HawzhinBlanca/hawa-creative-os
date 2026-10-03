import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The unattended jobs on either host (ADR-141, plans/hosting section 6.1): launch agents on a Mac
 * (infra/ops/install_launch_agents.sh) and systemd timers on Linux (infra/ops/install_systemd_units.sh).
 * Both installers have a --render mode that writes the files to a directory and touches neither
 * launchctl nor systemctl; these tests use only that mode. The systemd units are also checked with
 * `systemd-analyze verify` and installed under a real systemd in a Linux container
 * (plans/hosting/LINUX_READINESS_PROOF.json).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-scheduling-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const me = os.userInfo().username;

describe('systemd units (Linux)', () => {
  const out = path.join(tmp, 'units');
  const res = spawnSync(BASH, [path.join(repo, 'infra/ops/install_systemd_units.sh'), '--render', out, '--user', me], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HAWA_UNIT_PATH: '/usr/local/bin:/usr/bin:/bin',
      // No release on this host for the checkout's own rendering (release-directories.test.ts has the other case).
      HAWA_CURRENT_LINK: path.join(tmp, 'no-release') },
  });
  const unit = (name: string) => fs.readFileSync(path.join(out, name), 'utf8');
  const home = os.userInfo().homedir;

  it('renders a service and a timer for each launch agent, with nothing left unrendered', () => {
    expect(res.status, res.stderr).toBe(0);
    // ADR-240 added the nightly live canary to both hosts' jobs.
    expect(fs.readdirSync(out).sort()).toEqual(['hawa-backup-restore-drill', 'hawa-live-canary', 'hawa-nightly-backup', 'hawa-offsite-copy', 'hawa-restore-drill', 'hawa-watchdog']
      .flatMap((u) => [`${u}.service`, `${u}.timer`]));
    for (const f of fs.readdirSync(out)) expect(unit(f)).not.toMatch(/@[A-Z_]+@/);
  });

  it('runs the same scripts on the same schedule as the launch agents, in Asia/Baghdad time', () => {
    expect(unit('hawa-watchdog.timer')).toMatch(/^OnBootSec=1min$/m);
    expect(unit('hawa-watchdog.timer')).toMatch(/^OnUnitActiveSec=5min$/m);
    expect(unit('hawa-nightly-backup.timer')).toMatch(/^OnCalendar=\*-\*-\* 03:30:00 Asia\/Baghdad$/m);
    expect(unit('hawa-nightly-backup.timer')).toMatch(/^Persistent=true$/m);
    expect(unit('hawa-backup-restore-drill.timer')).toMatch(/^OnCalendar=Sun \*-\*-\* 04:00:00 Asia\/Baghdad$/m);
    expect(unit('hawa-restore-drill.timer')).toMatch(/^OnCalendar=\*-\*-01 05:00:00 Asia\/Baghdad$/m);
    expect(unit('hawa-offsite-copy.timer')).toMatch(/^OnCalendar=\*-\*-\* 05:30:00 Asia\/Baghdad$/m);
    // ADR-254: an hour after the backup, not at the same minute.
    expect(unit('hawa-live-canary.timer')).toMatch(/^OnCalendar=\*-\*-\* 04:30:00 Asia\/Baghdad$/m);
    expect(unit('hawa-live-canary.timer')).toMatch(/^Persistent=false$/m);
    const scripts: Record<string, string> = { 'hawa-watchdog': 'infra/ops/watchdog.sh', 'hawa-nightly-backup': 'infra/backup/nightly_backup.sh',
      'hawa-backup-restore-drill': 'infra/backup/backup_restore_drill.sh', 'hawa-restore-drill': 'infra/backup/restore_drill.sh',
      'hawa-offsite-copy': 'infra/backup/offsite_copy.sh', 'hawa-live-canary': 'infra/ops/live_canary.sh' };
    for (const [name, script] of Object.entries(scripts)) {
      const svc = unit(`${name}.service`);
      expect(svc).toContain(`ExecStart=/bin/bash ${repo}/${script}`);
      expect(fs.existsSync(path.join(repo, script))).toBe(true);
      expect(svc).toMatch(new RegExp(`^User=${me}$`, 'm'));
      expect(svc).toContain(`WorkingDirectory=${repo}`);
      expect(svc).toContain(`Environment=HOME=${home}`);
      expect(svc).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin');
      expect(unit(`${name}.timer`)).toContain(`Unit=${name}.service`);
      expect(unit(`${name}.timer`)).toMatch(/^WantedBy=timers\.target$/m);
    }
  });

  it('reads the backup settings from /etc/hawa/backup.env (required where a missing file would change where the backup goes) and logs where the Mac does', () => {
    expect(unit('hawa-nightly-backup.service')).toMatch(/^EnvironmentFile=\/etc\/hawa\/backup\.env$/m);
    expect(unit('hawa-restore-drill.service')).toMatch(/^EnvironmentFile=\/etc\/hawa\/backup\.env$/m);
    expect(unit('hawa-offsite-copy.service')).toMatch(/^EnvironmentFile=\/etc\/hawa\/backup\.env$/m);
    expect(unit('hawa-watchdog.service')).toMatch(/^EnvironmentFile=-\/etc\/hawa\/backup\.env$/m);
    expect(unit('hawa-nightly-backup.service')).toContain(`StandardOutput=append:${home}/.hawa/logs/design.hawa.nightly-backup.log`);
    expect(unit('hawa-watchdog.service')).toContain(`StandardError=append:${home}/.hawa/logs/design.hawa.watchdog.log`);
  });

  it('refuses root as the jobs\' user, and an install on a host that is not Linux', () => {
    const root = spawnSync(BASH, [path.join(repo, 'infra/ops/install_systemd_units.sh'), '--render', path.join(tmp, 'r'), '--user', 'root'], { encoding: 'utf8' });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain('must not run as root');
    if (os.platform() !== 'linux') {
      const install = spawnSync(BASH, [path.join(repo, 'infra/ops/install_systemd_units.sh'), '--user', me], { encoding: 'utf8' });
      expect(install.status).toBe(1);
      expect(install.stderr).toContain('on a Mac run infra/ops/install_launch_agents.sh');
    }
  });
});

describe.runIf(os.platform() === 'darwin')('launch agents (macOS)', () => {
  // A stand-in for ~/Library/LaunchAgents with settings added by hand, as the office Mac's are.
  const installed = path.join(tmp, 'installed-agents');
  const out = path.join(tmp, 'agents');
  fs.mkdirSync(installed, { recursive: true });
  const plist = (env: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict></dict></plist>`;
  fs.writeFileSync(path.join(installed, 'design.hawa.nightly-backup.plist'), plist({
    HAWA_BACKUP_ARCHIVE_DEST: '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/HawaBackups',
    HAWA_BACKUP_ARCHIVE_KEYFILE: '/Users/x/.hawa/backup_passphrase', HAWA_RESTATE_BACKUP_ENABLED: 'on' }));
  fs.writeFileSync(path.join(installed, 'design.hawa.offsite-copy.plist'), plist({ HAWA_OFFSITE_DEST: '/Volumes/Offsite/hawa' }));
  // A launchctl stub first on PATH that records and fails: --render must never reach launchctl, and a
  // test must never reach the real one (it would unload this Mac's own agents).
  const stubs = path.join(tmp, 'stub-bin');
  const launchctlCalls = path.join(tmp, 'launchctl-calls');
  fs.mkdirSync(stubs, { recursive: true });
  fs.writeFileSync(path.join(stubs, 'launchctl'), `#!/bin/bash\necho "launchctl $*" >> '${launchctlCalls}'\nexit 99\n`, { mode: 0o755 });
  const res = spawnSync(BASH, [path.join(repo, 'infra/ops/install_launch_agents.sh'), '--render', out], {
    encoding: 'utf8',
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: path.join(tmp, 'home'), HAWA_LAUNCH_AGENTS_DIR: installed },
  });
  const read = (label: string) => fs.readFileSync(path.join(out, `${label}.plist`), 'utf8');
  const envOf = (label: string) => JSON.parse(execFileSync('plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', path.join(out, `${label}.plist`)], { encoding: 'utf8' }));

  it('renders six valid plists without calling launchctl', () => {
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rendered 6 launch agents');
    for (const label of ['design.hawa.watchdog', 'design.hawa.nightly-backup', 'design.hawa.backup-restore-drill', 'design.hawa.restore-drill', 'design.hawa.offsite-copy',
      'design.hawa.live-canary']) {
      expect(spawnSync('plutil', ['-lint', path.join(out, `${label}.plist`)]).status, label).toBe(0);
    }
    expect(fs.existsSync(path.join(tmp, 'home', '.hawa'))).toBe(false);
    expect(fs.existsSync(launchctlCalls)).toBe(false);
  });

  it('the live canary (ADR-240) runs infra/ops/live_canary.sh at 04:30 (ADR-254), with only the backup\'s archive destination', () => {
    expect(read('design.hawa.live-canary')).toContain('<key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer>');
    expect(read('design.hawa.live-canary')).toContain(`<string>${repo}/infra/ops/live_canary.sh</string>`);
    // The archive destination lets it see the backup's archive lock; nothing else of the backup's is its business.
    expect(envOf('design.hawa.live-canary')).toEqual({ HOME: path.join(tmp, 'home'), PATH: expect.any(String),
      HAWA_BACKUP_ARCHIVE_DEST: '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/HawaBackups' });
  });

  it('the off-site agent runs at 05:30 with the nightly job\'s archive settings and its own destination', () => {
    expect(read('design.hawa.offsite-copy')).toContain('<key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer>');
    expect(read('design.hawa.offsite-copy')).toContain(`${repo}/infra/backup/offsite_copy.sh`);
    expect(envOf('design.hawa.offsite-copy')).toMatchObject({
      HAWA_BACKUP_ARCHIVE_DEST: '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/HawaBackups',
      HAWA_BACKUP_ARCHIVE_KEYFILE: '/Users/x/.hawa/backup_passphrase', HAWA_RESTATE_BACKUP_ENABLED: 'on',
      HAWA_OFFSITE_DEST: '/Volumes/Offsite/hawa' });
  });

  it('the existing agents are rendered as before: settings carried, same schedules', () => {
    expect(envOf('design.hawa.nightly-backup')).toMatchObject({ HAWA_RESTATE_BACKUP_ENABLED: 'on' });
    expect(envOf('design.hawa.restore-drill')).toMatchObject({ HAWA_BACKUP_ARCHIVE_KEYFILE: '/Users/x/.hawa/backup_passphrase' });
    expect(envOf('design.hawa.nightly-backup')).not.toHaveProperty('HAWA_OFFSITE_DEST');
    expect(read('design.hawa.watchdog')).toContain('<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>');
    expect(read('design.hawa.nightly-backup')).toContain('<key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer>');
  });
});

/**
 * Hunt 3: install_launch_agents.sh boots every agent out, then bootstraps each again. launchd finishes a
 * bootout after the command returns, and a bootstrap straight after it often fails ("Bootstrap failed: 5:
 * Input/output error"). Under set -e the script then stopped at that agent, leaving it and every agent
 * after it unloaded: no watchdog, no backup, nothing said beyond launchctl's own line. A failed
 * bootstrap is now retried, every other agent is still loaded, and the script ends in error naming the
 * ones that did not load. launchctl is a stub: these tests never reach the real one.
 */
describe('installing the launch agents (the launchctl race)', () => {
  function install(failFirst: number, alwaysFail = '') {
    const t = fs.mkdtempSync(path.join(tmp, 'install-'));
    const bin = path.join(t, 'bin'); fs.mkdirSync(bin);
    const calls = path.join(t, 'calls');
    // bootstrap fails the first <failFirst> times for each label, and always for <alwaysFail>.
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash
echo "launchctl $*" >> '${calls}'
case "$1" in
  bootstrap) label="$(basename "$3" .plist)"; n="$(grep -c "^launchctl bootstrap .*/$label.plist" '${calls}')"
    [[ "$label" == '${alwaysFail}' ]] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    (( n > ${failFirst} )) || { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    touch '${t}'/"loaded-$label" ;;
  print) [[ -e '${t}'/"loaded-$(basename "$2")" ]] ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const res = spawnSync(BASH, [path.join(repo, 'infra/ops/install_launch_agents.sh')], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(t, 'home'), HAWA_LAUNCH_AGENTS_DIR: path.join(t, 'agents'),
        HAWA_CURRENT_LINK: path.join(t, 'no-release') },
    });
    const loaded = fs.readdirSync(t).filter((n) => n.startsWith('loaded-')).map((n) => n.slice('loaded-'.length)).sort();
    return { code: res.status, out: `${res.stdout}\n${res.stderr}`, loaded };
  }
  const ALL = ['design.hawa.backup-restore-drill', 'design.hawa.live-canary', 'design.hawa.nightly-backup', 'design.hawa.offsite-copy',
    'design.hawa.restore-drill', 'design.hawa.watchdog'];

  it('retries a bootstrap that loses the race with the bootout, and loads every agent', () => {
    const r = install(2);
    expect(r.code, r.out).toBe(0);
    expect(r.loaded).toEqual(ALL);
  });

  it('an agent that will not load does not leave the others unloaded, and the script fails naming it', () => {
    const r = install(0, 'design.hawa.nightly-backup');
    expect(r.code).toBe(1);
    expect(r.loaded).toEqual(ALL.filter((l) => l !== 'design.hawa.nightly-backup'));
    expect(r.out).toMatch(/ERROR: not loaded: design\.hawa\.nightly-backup/);
  });
});
