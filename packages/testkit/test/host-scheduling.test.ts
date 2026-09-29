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
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HAWA_UNIT_PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  const unit = (name: string) => fs.readFileSync(path.join(out, name), 'utf8');
  const home = os.userInfo().homedir;

  it('renders a service and a timer for each launch agent, with nothing left unrendered', () => {
    expect(res.status, res.stderr).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['hawa-backup-restore-drill', 'hawa-nightly-backup', 'hawa-offsite-copy', 'hawa-restore-drill', 'hawa-watchdog']
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
    const scripts: Record<string, string> = { 'hawa-watchdog': 'infra/ops/watchdog.sh', 'hawa-nightly-backup': 'infra/backup/nightly_backup.sh',
      'hawa-backup-restore-drill': 'infra/backup/backup_restore_drill.sh', 'hawa-restore-drill': 'infra/backup/restore_drill.sh',
      'hawa-offsite-copy': 'infra/backup/offsite_copy.sh' };
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

  it('renders five valid plists without calling launchctl', () => {
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rendered 5 launch agents');
    for (const label of ['design.hawa.watchdog', 'design.hawa.nightly-backup', 'design.hawa.backup-restore-drill', 'design.hawa.restore-drill', 'design.hawa.offsite-copy']) {
      expect(spawnSync('plutil', ['-lint', path.join(out, `${label}.plist`)]).status, label).toBe(0);
    }
    expect(fs.existsSync(path.join(tmp, 'home', '.hawa'))).toBe(false);
    expect(fs.existsSync(launchctlCalls)).toBe(false);
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
