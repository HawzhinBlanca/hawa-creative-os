import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-158: production runs from release directories, not from the checkout people work in.
 *
 * On 2026-09-30 the launch agents, nginx's and Vector's bind mounts and the watchdog's recovery all read
 * /Users/hawzhin/Hawdesign, which was on another tool's branch. deploy.sh now makes
 * ~/.hawa/releases/<commit> (a detached git worktree), links the host-local files from ~/.hawa/shared
 * into it, continues from there, and points ~/.hawa/current at it just before its containers start.
 * The path logic lives in infra/ops/release_lib.sh; these tests source it the way host-portability's
 * source host_lib.sh, against throwaway git repositories and homes.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const lib = path.join(repo, 'infra/ops/release_lib.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-releases-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** A repository shaped like this one where it matters (the real .gitignore), and a home with ~/.hawa/shared. */
function setup(opts: { shared?: boolean; testEnv?: boolean } = {}) {
  const t = path.join(tmp, `case-${++n}`);
  const src = path.join(t, 'checkout');
  const home = path.join(t, 'home');
  fs.mkdirSync(path.join(src, 'infra/docker'), { recursive: true });
  fs.mkdirSync(path.join(src, 'infra/backup'), { recursive: true });
  fs.copyFileSync(path.join(repo, '.gitignore'), path.join(src, '.gitignore'));
  fs.writeFileSync(path.join(src, 'infra/docker/nginx.conf'), 'events {}\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{}\n');
  git(src, 'init', '-q');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'one');
  const shared = path.join(home, '.hawa', 'shared');
  if (opts.shared !== false) {
    fs.mkdirSync(path.join(shared, 'infra/docker'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'infra/docker/.env.production'), 'TELEGRAM_BOT_TOKEN=x\n', { mode: 0o600 });
    fs.writeFileSync(path.join(shared, 'infra/docker/.env'), 'POSTGRES_PASSWORD=x\n', { mode: 0o600 });
    if (opts.testEnv) fs.writeFileSync(path.join(shared, '.env.test'), 'TEST_DATABASE_URL=x\n');
  }
  const commit = () => {
    fs.writeFileSync(path.join(src, 'infra/docker/nginx.conf'), `events {} # ${Math.random()}\n`);
    git(src, 'commit', '-q', '-am', 'next');
    return git(src, 'rev-parse', 'HEAD');
  };
  return { t, src, home, shared, head: git(src, 'rev-parse', 'HEAD'), commit, releases: path.join(home, '.hawa', 'releases') };
}

function sh(s: { home: string }, body: string, env: Record<string, string> = {}) {
  const res = spawnSync(BASH, ['-c', `set -Eeuo pipefail\nsource '${lib}'\n${body}`], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home, HAWA_RELEASE_BUILD: 'true', ...env },
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr };
}

describe('release_lib: preparing a release', () => {
  it('makes a detached worktree of the commit under ~/.hawa/releases, linked to the shared host-local files, and clean', () => {
    const s = setup({ testEnv: true });
    const r = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`);
    expect(r.code, r.err).toBe(0);
    const release = path.join(s.releases, s.head);
    expect(r.out).toBe(release);
    expect(git(release, 'rev-parse', 'HEAD')).toBe(s.head);
    expect(git(release, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached
    for (const rel of ['infra/docker/.env.production', 'infra/docker/.env', 'infra/backup/snapshots', 'infra/backup/release-receipts', '.env.test']) {
      expect(fs.readlinkSync(path.join(release, rel)), rel).toBe(path.join(s.shared, rel));
    }
    expect(fs.statSync(path.join(s.shared, 'infra/backup/snapshots')).isDirectory()).toBe(true);
    // The links are ignored by the repository's own .gitignore: deploy.sh refuses a dirty tree.
    expect(git(release, 'status', '--porcelain')).toBe('');
    // Optional files are linked only when the shared copy exists.
    expect(fs.existsSync(path.join(release, 'output/audits'))).toBe(false);
  });

  it('is repeatable, and refuses a release directory at another commit', () => {
    const s = setup();
    expect(sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).code).toBe(0);
    expect(sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).code).toBe(0);
    const next = s.commit();
    fs.renameSync(path.join(s.releases, s.head), path.join(s.releases, next));
    const r = sh(s, `hawa_release_prepare '${s.src}' ${next}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`is at ${s.head}, not ${next}`);
  });

  it('refuses without the shared credentials, naming the switch-over runbook', () => {
    const s = setup({ shared: false });
    const r = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('.hawa/shared/infra/docker/.env.production is missing');
    expect(r.err).toContain('runbooks/PRODUCTION_RELEASE_DIRECTORIES.md');
  });

  it('refuses a short or unknown commit id', () => {
    const s = setup();
    expect(sh(s, `hawa_release_prepare '${s.src}' ${s.head.slice(0, 12)}`).err).toContain('is not a full commit id');
    expect(sh(s, `hawa_release_prepare '${s.src}' ${'e'.repeat(40)}`).code).toBe(1);
  });

  it('installs and builds a release once, and reports a failed build with its log', () => {
    const s = setup();
    const release = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).out;
    const count = path.join(s.t, 'builds');
    const build = `echo x >> '${count}'`;
    expect(sh(s, `hawa_release_install '${release}'`, { HAWA_RELEASE_BUILD: build }).code).toBe(0);
    expect(sh(s, `hawa_release_install '${release}'`, { HAWA_RELEASE_BUILD: build }).code).toBe(0);
    expect(fs.readFileSync(count, 'utf8')).toBe('x\n');
    const other = setup();
    const rel2 = sh(other, `hawa_release_prepare '${other.src}' ${other.head}`).out;
    const failed = sh(other, `hawa_release_install '${rel2}'`, { HAWA_RELEASE_BUILD: 'echo cannot build; exit 3' });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('cannot build');
  });
});

describe('release_lib: switching and keeping releases', () => {
  it('points current at a release in one rename and previous at the one before, never inside the old release', () => {
    const s = setup();
    const a = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).out;
    const second = s.commit();
    const b = sh(s, `hawa_release_prepare '${s.src}' ${second}`).out;
    const current = path.join(s.home, '.hawa', 'current');
    expect(sh(s, `hawa_release_activate '${a}'`).code).toBe(0);
    expect(fs.readlinkSync(current)).toBe(a);
    expect(fs.existsSync(path.join(s.home, '.hawa', 'previous'))).toBe(false);
    expect(sh(s, `hawa_release_activate '${b}'`).code).toBe(0);
    expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(current)).toBe(b);
    expect(fs.readlinkSync(path.join(s.home, '.hawa', 'previous'))).toBe(a);
    // `mv tmp current` would have moved the new link into release a; `ln -sfn` leaves a moment with none.
    expect(fs.readdirSync(a).filter((f) => /current|^[0-9a-f]{40}$/.test(f))).toEqual([]);
    expect(fs.readdirSync(path.join(s.home, '.hawa')).filter((f) => f.includes('.new.'))).toEqual([]);
    // Activating the release already current changes neither link.
    expect(sh(s, `hawa_release_activate '${b}'`).code).toBe(0);
    expect(fs.readlinkSync(path.join(s.home, '.hawa', 'previous'))).toBe(a);
    expect(fs.readFileSync(path.join(s.releases, '.history'), 'utf8').trim().split('\n').map((l) => l.split(' ')[1])).toEqual([s.head, second, second]);
  });

  it('resolves the deployed root to the release itself, or to the fallback before the first release', () => {
    const s = setup();
    expect(sh(s, `hawa_deployed_root /fallback`).out).toBe('/fallback');
    const a = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).out;
    sh(s, `hawa_release_activate '${a}'`);
    expect(sh(s, `hawa_deployed_root /fallback`).out).toBe(a);
  });

  it('prunes all but current, previous and the newest N, removing their worktrees', () => {
    const s = setup();
    const made: string[] = [s.head];
    for (let i = 0; i < 6; i++) made.push(s.commit());
    for (const c of made) sh(s, `hawa_release_prepare '${s.src}' ${c}`);
    // Activated in order, then an old one again (a rollback): current is made[1], previous made[6].
    for (const c of [...made, made[1]]) sh(s, `hawa_release_activate '${path.join(s.releases, c)}'`);
    const r = sh(s, 'hawa_release_prune 2');
    expect(r.code, r.err).toBe(0);
    const left = fs.readdirSync(s.releases).filter((f) => /^[0-9a-f]{40}$/.test(f)).sort();
    expect(left).toEqual([made[1], made[4], made[5], made[6]].sort());
    expect(r.out.split('\n').sort()).toEqual([made[0], made[2], made[3]].map((c) => `removed release ${c}`).sort());
    const worktrees = git(s.src, 'worktree', 'list', '--porcelain');
    for (const c of [made[0], made[2], made[3]]) expect(worktrees).not.toContain(c);
    expect(fs.readlinkSync(path.join(s.home, '.hawa', 'current'))).toBe(path.join(s.releases, made[1]));
  });
});

describe('deploy.sh and the release directory', () => {
  /** A repository holding deploy.sh and the two libraries it sources, committed, and a stubbed docker. */
  function deployRepo() {
    const s = setup();
    for (const f of ['infra/docker/deploy.sh', 'infra/ops/host_lib.sh', 'infra/ops/release_lib.sh']) {
      fs.mkdirSync(path.dirname(path.join(s.src, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(s.src, f));
    }
    git(s.src, 'add', '-A');
    git(s.src, 'commit', '-q', '-m', 'deploy');
    const bin = path.join(s.t, 'bin');
    fs.mkdirSync(bin);
    // docker compose version passes; `volume inspect` fails, so pre-flight stops at step 1b.
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "docker $* (from $PWD)" >> '${path.join(s.t, 'docker-calls')}'\n[[ "$1" == volume ]] && exit 1\nexit 0\n`, { mode: 0o755 });
    return { ...s, head: git(s.src, 'rev-parse', 'HEAD'), bin };
  }

  it('continues pre-flight from ~/.hawa/releases/<commit>, never from the checkout it was started in', () => {
    const s = deployRepo();
    const res = spawnSync(BASH, [path.join(s.src, 'infra/docker/deploy.sh')], {
      encoding: 'utf8', env: { PATH: `${s.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: s.home, HAWA_RELEASE_BUILD: 'true' },
    });
    const release = path.join(s.releases, s.head);
    expect(res.stdout).toContain(`✓ release directory ${release} (from ${s.src}); continuing there`);
    expect(res.stdout).toContain(`✓ running from release directory ${release}`);
    // Stopped by the stubbed volume check, in the release's own copy of deploy.sh.
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Postgres volume 'hawa-production_postgres_data' does not exist");
    // Pre-flight never switches production.
    expect(fs.existsSync(path.join(s.home, '.hawa', 'current'))).toBe(false);
    expect(fs.readlinkSync(path.join(release, 'infra/docker/.env.production'))).toBe(path.join(s.shared, 'infra/docker/.env.production'));
  });

  it('HAWA_RELEASE_DIRS=off runs from the checkout and makes no release', () => {
    const s = deployRepo();
    const res = spawnSync(BASH, [path.join(s.src, 'infra/docker/deploy.sh')], {
      encoding: 'utf8', env: { PATH: `${s.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: s.home, HAWA_RELEASE_DIRS: 'off' },
    });
    expect(res.stdout).toContain(`NOTE: HAWA_RELEASE_DIRS=off: running from ${s.src} itself`);
    expect(fs.existsSync(s.releases)).toBe(false);
  });

  it('switches ~/.hawa/current only after the new files are checked and before its containers start, and prunes after', () => {
    const deploy = fs.readFileSync(path.join(repo, 'infra/docker/deploy.sh'), 'utf8');
    const at = (needle: string) => { const i = deploy.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
    const activate = at('hawa_release_activate "$ROOT_DIR"');
    expect(at('run --rm --no-deps -T nginx nginx -t')).toBeLessThan(activate);
    expect(at('\nvalidate_vector_config\n')).toBeLessThan(activate);
    expect(at('upgrade.ts')).toBeLessThan(activate);
    expect(activate).toBeLessThan(at('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d'));
    expect(at('hawa_release_prune |')).toBeGreaterThan(at('verify_core_health || exit 1'));
    // The one-off checks bind the new release's files, not the running one's.
    expect(deploy).toContain('HAWA_RELEASE_ROOT="$ROOT_DIR" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T nginx nginx -t');
    expect(deploy).toContain('HAWA_RELEASE_ROOT="$ROOT_DIR" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T vector validate');
  });
});

describe('what production reads, through ~/.hawa/current', () => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  it.skipIf(docker.status !== 0)('every repository file compose binds resolves through the current link, whatever directory compose ran from', () => {
    const dir = path.join(tmp, 'compose');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['docker-compose.prod.yml', 'canva-release.override.yml']) fs.copyFileSync(path.join(repo, 'infra/docker', f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '.env.production'), '');
    const res = spawnSync('docker', ['compose', '-f', path.join(dir, 'docker-compose.prod.yml'), '-f', path.join(dir, 'canva-release.override.yml'),
      '--profile', 'worker', 'config', '--format', 'json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/hawa', DATABASE_URL: 'postgresql://x', POSTGRES_PASSWORD: 'x' },
    });
    expect(res.status, res.stderr).toBe(0);
    const services = JSON.parse(res.stdout).services as Record<string, { volumes?: { type: string; source: string }[]; command?: string[]; mem_reservation?: unknown }>;
    const binds = Object.entries(services).flatMap(([name, s]) => (s.volumes ?? []).filter((v) => v.type === 'bind').map((v) => ({ name, source: v.source })));
    const fromRepo = binds.filter((b) => !b.source.startsWith('/home/hawa/.hawa/') || b.source.startsWith('/home/hawa/.hawa/current'));
    expect(fromRepo.filter((b) => b.source !== '/var/run/docker.sock').map((b) => b.source).sort()).toEqual([
      '/home/hawa/.hawa/current/db/03-grants.sql', '/home/hawa/.hawa/current/db/rls.sql', '/home/hawa/.hawa/current/db/schema.sql',
      '/home/hawa/.hawa/current/db/seed.sql', '/home/hawa/.hawa/current/infra/docker/00-init-roles.sql',
      '/home/hawa/.hawa/current/infra/docker/nginx.conf', '/home/hawa/.hawa/current/infra/docker/vector.yaml',
    ]);
    for (const b of binds) expect(b.source, b.name).not.toContain(dir);
  });

  it('the launch agents run the scripts through the current link, and the installers fall back to the checkout only without one', () => {
    const home = path.join(tmp, 'agents-home');
    const release = path.join(tmp, 'agents-release');
    fs.mkdirSync(path.join(home, '.hawa'), { recursive: true });
    fs.mkdirSync(release, { recursive: true });
    fs.symlinkSync(release, path.join(home, '.hawa', 'current'));
    const out = path.join(tmp, 'agents-out');
    const res = spawnSync(BASH, [path.join(repo, 'infra/ops/install_launch_agents.sh'), '--render', out], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, HAWA_LAUNCH_AGENTS_DIR: path.join(tmp, 'agents-installed') },
    });
    expect(res.status, res.stderr).toBe(0);
    const watchdog = fs.readFileSync(path.join(out, 'design.hawa.watchdog.plist'), 'utf8');
    expect(watchdog).toContain(`<string>${home}/.hawa/current/infra/ops/watchdog.sh</string>`);
    expect(watchdog).toContain(`<key>WorkingDirectory</key><string>${home}/.hawa/current</string>`);
    expect(fs.readFileSync(path.join(out, 'design.hawa.nightly-backup.plist'), 'utf8')).toContain(`${home}/.hawa/current/infra/backup/nightly_backup.sh`);
    expect(watchdog).not.toContain(repo);

    const units = path.join(tmp, 'units-out');
    const sys = spawnSync(BASH, [path.join(repo, 'infra/ops/install_systemd_units.sh'), '--render', units, '--user', os.userInfo().username], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HAWA_UNIT_PATH: '/usr/bin:/bin', HAWA_CURRENT_LINK: path.join(home, '.hawa', 'current') },
    });
    expect(sys.status, sys.stderr).toBe(0);
    expect(fs.readFileSync(path.join(units, 'hawa-watchdog.service'), 'utf8')).toContain(`ExecStart=/bin/bash ${home}/.hawa/current/infra/ops/watchdog.sh`);
  });

  it('every script a launch agent starts pins the release it was started in (pwd -P)', () => {
    for (const f of ['infra/ops/watchdog.sh', 'infra/backup/nightly_backup.sh', 'infra/backup/backup_restore_drill.sh', 'infra/backup/restore_drill.sh', 'infra/backup/offsite_copy.sh']) {
      expect(fs.readFileSync(path.join(repo, f), 'utf8'), f).toMatch(/^ROOT(_DIR)?="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/\.\." && pwd -P\)"/m);
    }
  });
});
