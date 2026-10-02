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

/**
 * A docker that answers `ps -aq --no-trunc` and `inspect` from the given containers (docker inspect's
 * JSON shape), or fails every call with 'fail'. Returns a PATH with it first.
 */
function fakeDocker(dir: string, containers: object[] | 'fail') {
  const bin = fs.mkdtempSync(path.join(dir, 'fakebin-'));
  const json = path.join(bin, 'inspect.json');
  fs.writeFileSync(json, JSON.stringify(containers === 'fail' ? [] : containers));
  const ids = containers === 'fail' ? '' : containers.map((_, i) => `c${i}`).join('\n');
  fs.writeFileSync(path.join(bin, 'docker'), containers === 'fail' ? '#!/bin/bash\nexit 1\n'
    : `#!/bin/bash\ncase "$1" in\n  ps) [[ -z '${ids}' ]] || printf '%s\\n' '${ids}' ;;\n  inspect) cat '${json}' ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
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
  it('replaces the empty placeholder directories Docker makes for missing bind sources, and refuses one holding a file', () => {
    const s = setup();
    const a = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).out;
    const current = path.join(s.home, '.hawa', 'current');
    // What a container started through ~/.hawa/current before the switch leaves behind (2026-09-30).
    fs.mkdirSync(path.join(current, 'db', 'seed.sql'), { recursive: true });
    fs.mkdirSync(path.join(current, 'infra', 'docker', '00-init-roles.sql'), { recursive: true });
    const placeholder = sh(s, `hawa_release_activate '${a}'`);
    expect(placeholder.code).toBe(0);
    expect(fs.readlinkSync(current)).toBe(a);
    expect(fs.existsSync(path.join(s.home, '.hawa', 'previous'))).toBe(false);

    const t = setup();
    const b = sh(t, `hawa_release_prepare '${t.src}' ${t.head}`).out;
    const real = path.join(t.home, '.hawa', 'current');
    fs.mkdirSync(path.join(real, 'db'), { recursive: true });
    fs.writeFileSync(path.join(real, 'db', 'kept.sql'), 'select 1;');
    const refused = sh(t, `hawa_release_activate '${b}'`);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/holding files/);
    expect(fs.readFileSync(path.join(real, 'db', 'kept.sql'), 'utf8')).toBe('select 1;');
  });

  it('never recreates Postgres before current is switched (deploy.sh starts it with --no-recreate)', () => {
    const deploy = fs.readFileSync(path.join(here, '..', '..', '..', 'infra', 'docker', 'deploy.sh'), 'utf8');
    const activate = deploy.indexOf('hawa_release_activate "$ROOT_DIR"');
    const ups = [...deploy.matchAll(/up -d[^\n]*postgres/g)].filter((m) => (m.index ?? 0) < activate);
    expect(activate).toBeGreaterThan(0);
    expect(ups.length).toBeGreaterThan(0);
    for (const m of ups) expect(m[0]).toContain('--no-recreate');
  });

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
    const r = sh(s, 'hawa_release_prune 2', { PATH: fakeDocker(s.t, []) });
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
    for (const f of ['infra/docker/deploy.sh', 'infra/ops/host_lib.sh', 'infra/ops/release_lib.sh', 'infra/ops/prepare_service_boundaries.py']) {
      fs.mkdirSync(path.dirname(path.join(s.src, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(s.src, f));
    }
    const source = 'DATABASE_URL=postgresql://hawa_app:' + 'synthetic@postgres:5432/hawa\nTELEGRAM_BOT_TOKEN=x\nHAWA_BEARER_TOKEN=' + 'a'.repeat(48) + '\n';
    fs.writeFileSync(path.join(s.shared, 'infra/docker/.env.production'), source, { mode: 0o600 });
    fs.writeFileSync(path.join(s.src, 'infra/docker/.env.production'), source, { mode: 0o600 });
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

  it('the local state audit deploy.sh runs sees the shared credentials and dumps through a release\'s links', () => {
    const s = setup();
    for (const f of ['infra/security/local_state_audit.sh', 'infra/ops/host_lib.sh']) {
      fs.mkdirSync(path.dirname(path.join(s.src, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(s.src, f));
    }
    git(s.src, 'add', '-A');
    git(s.src, 'commit', '-q', '-m', 'audit');
    const head = git(s.src, 'rev-parse', 'HEAD');
    const envFile = path.join(s.shared, 'infra/docker/.env.production');
    fs.writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${'7'.repeat(12)}\n`);
    fs.chmodSync(envFile, 0o600);
    const release = sh(s, `hawa_release_prepare '${s.src}' ${head}`).out;
    const dump = path.join(s.shared, 'infra/backup/snapshots/hawa_20260930T033000Z.dump');
    fs.writeFileSync(dump, 'x'.repeat(4096));
    fs.chmodSync(dump, 0o600);
    const audit = () => spawnSync(BASH, [path.join(release, 'infra/security/local_state_audit.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    const closed = audit();
    expect(closed.status, closed.stdout + closed.stderr).toBe(0);
    expect(closed.stdout).toMatch(/^600 +\d+ +plaintext credentials +infra\/docker\/\.env\.production$/m);
    expect(closed.stdout).toMatch(/^600 +4096 +database dump +infra\/backup\/snapshots\/hawa_20260930T033000Z\.dump$/m);
    fs.chmodSync(envFile, 0o644);
    const open = audit();
    expect(open.status).toBe(1);
    expect(open.stdout).toMatch(/^644 +\d+ +plaintext credentials +infra\/docker\/\.env\.production EXPOSED$/m);
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
    const up = at('HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d');
    expect(at('run --rm --no-deps -T nginx nginx -t')).toBeLessThan(activate);
    expect(at('\nvalidate_vector_config\n')).toBeLessThan(activate);
    expect(at('upgrade.ts')).toBeLessThan(activate);
    expect(activate).toBeLessThan(up);
    expect(at('hawa_release_prune |')).toBeGreaterThan(at('verify_core_health || exit 1'));
    // Addendum 3: the one-off checks bind a candidate copy laid out like ~/.hawa/runtime, with the office
    // proof, and only the checked bytes are copied into the runtime directory, after both checks and
    // before up -d; nginx and vector are then reloaded or restarted, never silently left behind.
    const stage = at('hawa_runtime_sync "$ROOT_DIR" "$CANDIDATE_RUNTIME" "$RUNTIME_SHARED"');
    const nginxT = at('HAWA_RUNTIME_DIR="$CANDIDATE_RUNTIME" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T nginx nginx -t');
    const live = at('RUNTIME_CHANGED="$(hawa_runtime_sync "$CANDIDATE_RUNTIME" "$HAWA_RUNTIME_DIR" "$CANDIDATE_RUNTIME")"');
    expect(deploy).toContain('HAWA_RUNTIME_DIR="$CANDIDATE_RUNTIME" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T vector validate');
    expect(stage).toBeLessThan(nginxT);
    expect(nginxT).toBeLessThan(live);
    expect(at('\nvalidate_vector_config\n')).toBeLessThan(live);
    expect(live).toBeLessThan(up);
    expect(at('\nhawa_nginx_reload || exit 1\napply_vector_config\n')).toBeGreaterThanOrEqual(up);
    // ADR-183's live-mount check compares nginx with the runtime copies it binds, not the release's files.
    expect(deploy).toContain('NGINX_WANT="$("${HAWA_SHA256[@]}" "${HAWA_RUNTIME_DIR}/infra/docker/nginx.conf"');
    expect(deploy).toContain('OFFICE_PROOF_WANT="$("${HAWA_SHA256[@]}" "${HAWA_RUNTIME_DIR}/infra/docker/.office-proxy-header.conf"');
    // The worker identity preparation (which may rewrite the proof) comes before the live copy.
    expect(at('prepare_service_boundaries.py" --directory "$BOUNDARY_DIR" --rotate-design')).toBeLessThan(live);
    expect(deploy).not.toContain('HAWA_RELEASE_ROOT');
    // The pre-backup Postgres start never meets a missing bind source: missing runtime files are seeded first.
    const seed = at('hawa_runtime_sync "$ROOT_DIR" "$HAWA_RUNTIME_DIR" "$RUNTIME_SHARED" missing');
    expect(seed).toBeLessThan(at('up -d --no-recreate postgres'));
  });
});

describe('what production reads: scripts through ~/.hawa/current, bound files from ~/.hawa/runtime', () => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  it.skipIf(docker.status !== 0)('every repository file compose binds comes from the runtime directory, none through the current link, whatever directory compose ran from', () => {
    const dir = path.join(tmp, 'compose');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['docker-compose.prod.yml', 'canva-release.override.yml']) fs.copyFileSync(path.join(repo, 'infra/docker', f), path.join(dir, f));
    for (const file of ['.env.production', '.env.worker', '.env.service-boundaries']) fs.writeFileSync(path.join(dir, file), '');
    const res = spawnSync('docker', ['compose', '-f', path.join(dir, 'docker-compose.prod.yml'), '-f', path.join(dir, 'canva-release.override.yml'),
      '--profile', 'worker', 'config', '--format', 'json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/hawa', DATABASE_URL: 'postgresql://x', POSTGRES_PASSWORD: 'x' },
    });
    expect(res.status, res.stderr).toBe(0);
    const services = JSON.parse(res.stdout).services as Record<string, { volumes?: { type: string; source: string }[]; command?: string[]; mem_reservation?: unknown }>;
    const binds = Object.entries(services).flatMap(([name, s]) => (s.volumes ?? []).filter((v) => v.type === 'bind').map((v) => ({ name, source: v.source })));
    const fromRepo = binds.filter((b) => !b.source.startsWith('/home/hawa/.hawa/') || b.source.startsWith('/home/hawa/.hawa/runtime/'));
    expect(fromRepo.filter((b) => b.source !== '/var/run/docker.sock').map((b) => `${b.name} ${b.source}`).sort()).toEqual([
      'nginx /home/hawa/.hawa/runtime/infra/docker/.office-proxy-header.conf', 'nginx /home/hawa/.hawa/runtime/infra/docker/nginx.conf',
      'postgres /home/hawa/.hawa/runtime/db/03-grants.sql', 'postgres /home/hawa/.hawa/runtime/db/rls.sql', 'postgres /home/hawa/.hawa/runtime/db/schema.sql',
      'postgres /home/hawa/.hawa/runtime/db/seed.sql', 'postgres /home/hawa/.hawa/runtime/infra/docker/00-init-roles.sql',
      'vector /home/hawa/.hawa/runtime/infra/docker/vector.yaml',
    ]);
    // Addendum 3: nothing is bound through a link Docker Desktop would resolve once and pin.
    for (const b of binds) {
      expect(b.source, b.name).not.toContain(dir);
      expect(b.source, b.name).not.toMatch(/\/\.hawa\/(current|previous|releases)(\/|$)/);
    }
    // Every runtime file compose binds is one deploy.sh copies, at the same relative path.
    const lib = fs.readFileSync(path.join(repo, 'infra/ops/release_lib.sh'), 'utf8');
    const listed = [...lib.matchAll(/^HAWA_RUNTIME_(?:FILES|SHARED)=\(([^)]*)\)/gm)].flatMap((m) => m[1].trim().split(/\s+/));
    expect(fromRepo.filter((b) => b.source.startsWith('/home/hawa/.hawa/runtime/')).map((b) => b.source.slice('/home/hawa/.hawa/runtime/'.length)).sort())
      .toEqual([...listed].sort());
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

/**
 * ADR-158 addendum 3 (2026-09-30 20:58Z). Compose bound nginx.conf, vector.yaml, the Postgres init files and
 * the office proof through ~/.hawa/current. Docker Desktop resolves that link when it creates a container and
 * keeps the release path; nothing recreated vector, and the prune removed the release it was pinned to, so
 * its restart failed. The proof file, replaced by a rename, was also invisible to the running nginx (a
 * single-file bind mount keeps the inode it bound). The bound files now live in ~/.hawa/runtime, copied in
 * place, and the prune keeps any release a container may still bind.
 */
const RUNTIME_FILES = ['infra/docker/nginx.conf', 'infra/docker/vector.yaml', 'infra/docker/00-init-roles.sql', 'db/schema.sql', 'db/rls.sql', 'db/03-grants.sql', 'db/seed.sql'];
const PROOF = 'infra/docker/.office-proxy-header.conf';

/** A release-shaped directory holding every file compose binds, and ~/.hawa/shared holding the office proof. */
function runtimeCase() {
  const t = path.join(tmp, `runtime-${++n}`);
  const release = path.join(t, 'release');
  const home = path.join(t, 'home');
  const shared = path.join(home, '.hawa', 'shared');
  for (const rel of RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(release, rel)), { recursive: true });
    fs.writeFileSync(path.join(release, rel), `${rel} one\n`, { mode: 0o644 });
  }
  fs.mkdirSync(path.join(shared, 'infra/docker'), { recursive: true });
  fs.writeFileSync(path.join(shared, PROOF), 'proxy_set_header X-Hawa-Office-Proof "aaaa";\n', { mode: 0o600 });
  return { t, release, home, shared, runtime: path.join(home, '.hawa', 'runtime') };
}

describe('release_lib: the runtime directory compose binds from', () => {
  it('copies every bound file at the same relative path, the office proof from ~/.hawa/shared, owner-only where the source is', () => {
    const s = runtimeCase();
    const r = sh(s, `hawa_runtime_sync '${s.release}'`);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').sort()).toEqual([...RUNTIME_FILES, PROOF].map((f) => `changed ${f}`).sort());
    for (const rel of RUNTIME_FILES) {
      expect(fs.readFileSync(path.join(s.runtime, rel), 'utf8')).toBe(`${rel} one\n`);
      expect(fs.statSync(path.join(s.runtime, rel)).mode & 0o777, rel).toBe(0o644);
    }
    expect(fs.readFileSync(path.join(s.runtime, PROOF), 'utf8')).toContain('X-Hawa-Office-Proof "aaaa"');
    expect(fs.statSync(path.join(s.runtime, PROOF)).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(s.runtime).isDirectory()).toBe(true);
    expect(fs.statSync(s.runtime).mode & 0o777).toBe(0o700);
    // A second sync of the same files changes nothing and says so.
    expect(sh(s, `hawa_runtime_sync '${s.release}'`).out).toBe('');
  });

  it('rewrites a changed file in place: the same inode, so a single-file bind mount sees the new content', () => {
    const s = runtimeCase();
    expect(sh(s, `hawa_runtime_sync '${s.release}'`).code).toBe(0);
    const nginx = path.join(s.runtime, 'infra/docker/nginx.conf');
    const proof = path.join(s.runtime, PROOF);
    const before = { nginx: fs.statSync(nginx).ino, proof: fs.statSync(proof).ino };
    // What prepare_service_boundaries.py does: a new proof, written by rename (a new inode in ~/.hawa/shared).
    const tmpProof = path.join(s.shared, 'infra/docker/.tmp-proof');
    fs.writeFileSync(tmpProof, 'proxy_set_header X-Hawa-Office-Proof "bbbb";\n', { mode: 0o600 });
    fs.renameSync(tmpProof, path.join(s.shared, PROOF));
    fs.writeFileSync(path.join(s.release, 'infra/docker/nginx.conf'), 'events {} # two\n');
    const r = sh(s, `hawa_runtime_sync '${s.release}'`);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').sort()).toEqual([`changed ${PROOF}`, 'changed infra/docker/nginx.conf']);
    expect(fs.readFileSync(nginx, 'utf8')).toBe('events {} # two\n');
    expect(fs.readFileSync(proof, 'utf8')).toContain('"bbbb"');
    expect(fs.statSync(nginx).ino).toBe(before.nginx);
    expect(fs.statSync(proof).ino).toBe(before.proof);
    expect(fs.statSync(proof).mode & 0o777).toBe(0o600);
  });

  it('fails, naming it, when the office proof is missing, and refuses a runtime directory that is a link', () => {
    const s = runtimeCase();
    fs.rmSync(path.join(s.shared, PROOF));
    const missing = sh(s, `hawa_runtime_sync '${s.release}'`);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain(`${s.shared}/${PROOF} is missing`);

    const t = runtimeCase();
    fs.mkdirSync(path.join(t.home, '.hawa', 'elsewhere'), { recursive: true });
    fs.symlinkSync(path.join(t.home, '.hawa', 'elsewhere'), t.runtime);
    const linked = sh(t, `hawa_runtime_sync '${t.release}'`);
    expect(linked.code).not.toBe(0);
    expect(linked.err).toContain('must be a real directory');
    expect(fs.readdirSync(path.join(t.home, '.hawa', 'elsewhere'))).toEqual([]);
  });

  it('replaces Docker\'s empty placeholder directory for a missing source, and with "missing" writes only absent files', () => {
    const s = runtimeCase();
    fs.mkdirSync(path.join(s.runtime, 'db', 'seed.sql'), { recursive: true });
    fs.mkdirSync(path.join(s.runtime, 'infra', 'docker'), { recursive: true });
    fs.writeFileSync(path.join(s.runtime, 'infra/docker/nginx.conf'), 'the live one\n');
    const r = sh(s, `hawa_runtime_sync '${s.release}' '${s.runtime}' '${s.shared}' missing`);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('empty placeholder');
    expect(fs.readFileSync(path.join(s.runtime, 'db/seed.sql'), 'utf8')).toBe('db/seed.sql one\n');
    expect(fs.readFileSync(path.join(s.runtime, 'infra/docker/nginx.conf'), 'utf8')).toBe('the live one\n');
    expect(r.out).not.toContain('infra/docker/nginx.conf');
  });

  it('release.sh runtime-sync copies the current release\'s files', () => {
    const s = setup();
    const release = sh(s, `hawa_release_prepare '${s.src}' ${s.head}`).out;
    for (const rel of RUNTIME_FILES) {
      fs.mkdirSync(path.dirname(path.join(release, rel)), { recursive: true });
      if (!fs.existsSync(path.join(release, rel))) fs.writeFileSync(path.join(release, rel), `${rel}\n`);
    }
    fs.writeFileSync(path.join(s.shared, PROOF), 'proxy_set_header X-Hawa-Office-Proof "cccc";\n', { mode: 0o600 });
    sh(s, `hawa_release_activate '${release}'`);
    const res = spawnSync(BASH, [path.join(repo, 'infra/ops/release.sh'), 'runtime-sync'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`✓ ${s.home}/.hawa/runtime holds the files of ${release}; changed:`);
    expect(fs.readFileSync(path.join(s.home, '.hawa/runtime/infra/docker/nginx.conf'), 'utf8')).toBe(fs.readFileSync(path.join(release, 'infra/docker/nginx.conf'), 'utf8'));
  });
});

describe('release_lib: the prune keeps any release a container may still bind', () => {
  /** Releases on disk and a hand-written activation history: [time, commit] per line. */
  function history(activations: [string, string][]) {
    const s = setup();
    fs.mkdirSync(s.releases, { recursive: true });
    for (const c of new Set(activations.map(([, c]) => c))) fs.mkdirSync(path.join(s.releases, c, 'infra/docker'), { recursive: true });
    fs.writeFileSync(path.join(s.releases, '.history'), activations.map(([t, c]) => `${t} ${c}\n`).join(''));
    const last = activations[activations.length - 1][1];
    fs.symlinkSync(path.join(s.releases, last), path.join(s.home, '.hawa', 'current'));
    return s;
  }
  const c = (ch: string) => ch.repeat(40);
  const left = (s: { releases: string }) => fs.readdirSync(s.releases).filter((f) => /^[0-9a-f]{40}$/.test(f)).sort();
  const container = (name: string, created: string, sources: string[], startedAt = created) => ({
    Name: `/${name}`, Created: created, State: { StartedAt: startedAt },
    Mounts: sources.map((Source) => ({ Type: 'bind', Source })), HostConfig: { Binds: sources.map((src) => `${src}:/x:ro`) },
  });

  it('replays 2026-09-30: vector, created through ~/.hawa/current a second after 1737c8f2 was activated, keeps that release', () => {
    const [r1737, r051d, r353c, r6af1, rb2ed, r38f8, r3636, rb7f3] = ['1', '2', '3', '4', '5', '6', '7', '8'].map(c);
    const s = history([
      ['2026-09-30T09:49:55Z', r1737], ['2026-09-30T11:46:59Z', r051d], ['2026-09-30T12:56:42Z', r353c], ['2026-09-30T15:20:16Z', r6af1],
      ['2026-09-30T16:28:15Z', rb2ed], ['2026-09-30T17:27:51Z', r38f8], ['2026-09-30T18:37:39Z', r3636], ['2026-09-30T20:58:37Z', rb7f3],
    ]);
    fs.symlinkSync(path.join(s.releases, r3636), path.join(s.home, '.hawa', 'previous'));
    const current = path.join(s.home, '.hawa', 'current');
    const docker = fakeDocker(s.t, [
      // docker inspect shows the string compose was given, never the release Docker Desktop resolved it to.
      container('hawa-production-vector-1', '2026-09-30T09:49:56.065469929Z', [`${current}/infra/docker/vector.yaml`, '/var/run/docker.sock']),
      container('hawa-production-nginx-1', '2026-09-30T16:28:19.07612409Z', [`${current}/infra/docker/nginx.conf`]),
      // Created before any release existed: it bound Docker's placeholders, not a release (Addendum 2).
      container('hawa-production-postgres-1', '2026-09-30T09:37:20.752997135Z', [`/host_mnt${current}/db/schema.sql`, `${current}/db/seed.sql`]),
    ]);
    const r = sh(s, 'hawa_release_prune 1', { PATH: docker });
    expect(r.code, r.err).toBe(0);
    // Without the check, 1737c8f2, 051d5606, 353c9e0c, 6af16cb8 and b2edf657 were removed.
    expect(left(s)).toEqual([r1737, rb2ed, r38f8, r3636, rb7f3].sort());
    expect(r.out).toContain(`kept release ${r1737}: a container's bind mount may still use it`);
    expect(r.out).toContain(`kept release ${rb2ed}: a container's bind mount may still use it`);
    expect(r.out.split('\n').filter((l) => l.startsWith('removed')).sort()).toEqual([r051d, r353c, r6af1].map((x) => `removed release ${x}`).sort());
  });

  it('keeps a release a container binds directly, however Docker Desktop spells the path', () => {
    const s = history([['2026-09-30T10:00:00Z', c('a')], ['2026-09-30T11:00:00Z', c('b')], ['2026-09-30T12:00:00Z', c('d')], ['2026-09-30T13:00:00Z', c('e')]]);
    const docker = fakeDocker(s.t, [
      container('exited-one', '2026-09-30T12:30:00Z', [`/host_mnt${s.releases}/${c('a')}/infra/docker/nginx.conf`]),
      container('other', '2026-09-30T12:30:00Z', [`${s.releases}/${c('b')}/db/seed.sql`]),
    ]);
    const r = sh(s, 'hawa_release_prune 0', { PATH: docker });
    expect(r.code, r.err).toBe(0);
    expect(left(s)).toEqual([c('a'), c('b'), c('e')].sort());
  });

  it('keeps the releases on both sides of an activation a container was created within seconds of, and resolves its last start too', () => {
    const s = history([['2026-09-30T10:00:00Z', c('a')], ['2026-09-30T11:00:00Z', c('b')], ['2026-09-30T12:00:00Z', c('d')], ['2026-09-30T13:00:00Z', c('e')], ['2026-09-30T14:00:00Z', c('f')]]);
    const current = path.join(s.home, '.hawa', 'current');
    const docker = fakeDocker(s.t, [
      container('at-the-switch', '2026-09-30T10:59:59.500Z', [`${current}/infra/docker/vector.yaml`]),
      container('restarted-later', '2026-09-30T10:30:00Z', [`${current}/infra/docker/nginx.conf`], '2026-09-30T12:30:00Z'),
    ]);
    const r = sh(s, 'hawa_release_prune 0', { PATH: docker });
    expect(r.code, r.err).toBe(0);
    expect(left(s)).toEqual([c('a'), c('b'), c('d'), c('f')].sort());
  });

  it('removes nothing when it cannot be sure: Docker unavailable, no history, or an unreadable time', () => {
    const acts: [string, string][] = [['2026-09-30T10:00:00Z', c('a')], ['2026-09-30T11:00:00Z', c('b')], ['2026-09-30T12:00:00Z', c('d')]];
    const failing = history(acts);
    const r = sh(failing, 'hawa_release_prune 0', { PATH: fakeDocker(failing.t, 'fail') });
    expect(r.code).toBe(0);
    expect(r.err).toContain('no release was removed');
    expect(left(failing)).toEqual([c('a'), c('b'), c('d')]);

    const noHistory = history(acts);
    fs.rmSync(path.join(noHistory.releases, '.history'));
    const current = path.join(noHistory.home, '.hawa', 'current');
    const r2 = sh(noHistory, 'hawa_release_prune 0', { PATH: fakeDocker(noHistory.t, [container('x', '2026-09-30T10:30:00Z', [`${current}/db/rls.sql`])]) });
    expect(r2.err).toContain('no release history to resolve it');
    expect(left(noHistory)).toEqual([c('a'), c('b'), c('d')]);

    const badTime = history(acts);
    const r3 = sh(badTime, 'hawa_release_prune 0', { PATH: fakeDocker(badTime.t, [container('x', 'yesterday', [`${path.join(badTime.home, '.hawa', 'current')}/db/rls.sql`])]) });
    expect(r3.err).toContain('no release was removed');
    expect(left(badTime)).toEqual([c('a'), c('b'), c('d')]);
  });

  it('with no container binding a release, prunes as before', () => {
    const s = history([['2026-09-30T10:00:00Z', c('a')], ['2026-09-30T11:00:00Z', c('b')], ['2026-09-30T12:00:00Z', c('d')]]);
    const docker = fakeDocker(s.t, [container('runtime-only', '2026-09-30T12:00:05Z', [`${s.home}/.hawa/runtime/infra/docker/nginx.conf`, '/var/run/docker.sock'])]);
    const r = sh(s, 'hawa_release_prune 0', { PATH: docker });
    expect(r.code, r.err).toBe(0);
    expect(left(s)).toEqual([c('d')]);
  });
});

describe('the runtime files in the real images', () => {
  const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  const image = 'nginx:1.27-alpine-slim';
  const ready = docker(['image', 'inspect', image]).status === 0;

  /** The repository's own files and a generated proof, synced into a runtime directory under a fake home. */
  function realRuntime() {
    const s = runtimeCase();
    for (const rel of RUNTIME_FILES) fs.copyFileSync(path.join(repo, rel), path.join(s.release, rel));
    fs.mkdirSync(path.join(s.home, '.hawa', 'blobs'), { recursive: true });
    const r = sh(s, `hawa_runtime_sync '${s.release}'`);
    expect(r.code, r.err).toBe(0);
    return s;
  }
  /** nginx's bind mounts exactly as compose resolves them for that home. */
  function nginxMounts(home: string) {
    const dir = fs.mkdtempSync(path.join(tmp, 'compose-'));
    for (const f of ['docker-compose.prod.yml', 'canva-release.override.yml']) fs.copyFileSync(path.join(repo, 'infra/docker', f), path.join(dir, f));
    for (const file of ['.env.production', '.env.worker', '.env.service-boundaries']) fs.writeFileSync(path.join(dir, file), '');
    const res = spawnSync('docker', ['compose', '-f', path.join(dir, 'docker-compose.prod.yml'), '-f', path.join(dir, 'canva-release.override.yml'), 'config', '--format', 'json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, DATABASE_URL: 'postgresql://x', POSTGRES_PASSWORD: 'x' },
    });
    expect(res.status, res.stderr).toBe(0);
    const volumes = JSON.parse(res.stdout).services.nginx.volumes as { type: string; source: string; target: string; read_only?: boolean }[];
    return volumes.filter((v) => v.type === 'bind').flatMap((v) => ['-v', `${v.source}:${v.target}${v.read_only ? ':ro' : ''}`]);
  }

  it.skipIf(!ready)('nginx -t passes in the production image with compose\'s own mounts from the runtime directory, office proof included', () => {
    const s = realRuntime();
    const mounts = nginxMounts(s.home);
    expect(mounts.join(' ')).toContain(`${s.runtime}/infra/docker/.office-proxy-header.conf:/etc/nginx/hawa-office-proof.conf:ro`);
    const r = docker(['run', '--rm', '--pull=never', '--network', 'none', '--add-host', 'core:127.0.0.1', '--add-host', 'desk:127.0.0.1', ...mounts, image, 'nginx', '-t']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('test is successful');
  });

  it.skipIf(!ready)('a running container sees a synced file at once, where a rename-replaced one stays stale', () => {
    const s = realRuntime();
    const name = `hawa-runtime-inplace-test-${process.pid}-${n}`;
    const proof = path.join(s.runtime, PROOF);
    const run = docker(['run', '-d', '--rm', '--pull=never', '--network', 'none', '--name', name, '-v', `${proof}:/etc/nginx/hawa-office-proof.conf:ro`, image, 'sleep', '120']);
    expect(run.status, run.stderr).toBe(0);
    try {
      const seen = () => docker(['exec', name, 'cat', '/etc/nginx/hawa-office-proof.conf']).stdout;
      expect(seen()).toContain('"aaaa"');
      fs.writeFileSync(path.join(s.shared, PROOF), 'proxy_set_header X-Hawa-Office-Proof "dddd";\n', { mode: 0o600 });
      expect(sh(s, `hawa_runtime_sync '${s.release}'`).out).toBe(`changed ${PROOF}`);
      expect(seen()).toContain('"dddd"');
      // What happened in production: a file replaced by a rename is not the one the container bound.
      const next = `${proof}.next`;
      fs.writeFileSync(next, 'proxy_set_header X-Hawa-Office-Proof "eeee";\n', { mode: 0o600 });
      fs.renameSync(next, proof);
      expect(seen()).not.toContain('"eeee"');
    } finally {
      docker(['rm', '-f', name]);
    }
  });
});

describe('release security retirement',()=>{
  it('removes inactive pre-foundation releases while preserving current, previous and shared files',()=>{
    const s=setup(), unsafe=s.head, floor=s.commit(), safe=s.commit();
    for(const commit of [unsafe,floor,safe]) expect(sh(s,`hawa_release_prepare '${s.src}' ${commit}`).code).toBe(0);
    sh(s,`hawa_release_activate '${s.releases}/${floor}'`);
    sh(s,`hawa_release_activate '${s.releases}/${safe}'`);
    const result=sh(s,`hawa_release_prune_unsafe '${s.src}' ${floor}`,{PATH:fakeDocker(s.t,[])});
    expect(result.code,result.err).toBe(0); expect(result.out).toContain(unsafe);
    expect(fs.existsSync(path.join(s.releases,unsafe))).toBe(false);
    expect(fs.existsSync(path.join(s.releases,floor))).toBe(true);
    expect(fs.readFileSync(path.join(s.shared,'infra/docker/.env.production'),'utf8')).toBe('TELEGRAM_BOT_TOKEN=x\n');
  });
  it('refuses active or locally changed unsafe worktrees',()=>{
    const s=setup(), floor=s.commit();
    sh(s,`hawa_release_prepare '${s.src}' ${s.head}`);
    sh(s,`hawa_release_activate '${s.releases}/${s.head}'`);
    expect(sh(s,`hawa_release_prune_unsafe '${s.src}' ${floor}`,{PATH:fakeDocker(s.t,[])}).code).toBe(1);
    fs.unlinkSync(path.join(s.home,'.hawa/current'));
    fs.writeFileSync(path.join(s.releases,s.head,'kept.txt'),'preserve');
    expect(sh(s,`hawa_release_prune_unsafe '${s.src}' ${floor}`,{PATH:fakeDocker(s.t,[])}).code).toBe(1);
    expect(fs.readFileSync(path.join(s.releases,s.head,'kept.txt'),'utf8')).toBe('preserve');
  });
  it('keeps an unsafe release a container still binds, and removes none when it cannot tell (ADR-158 addendum 3)',()=>{
    const s=setup(), unsafe=s.head, floor=s.commit(), safe=s.commit();
    for(const commit of [unsafe,floor,safe]) expect(sh(s,`hawa_release_prepare '${s.src}' ${commit}`).code).toBe(0);
    sh(s,`hawa_release_activate '${s.releases}/${floor}'`);
    sh(s,`hawa_release_activate '${s.releases}/${safe}'`);
    const bound=[{Name:'/hawa-production-vector-1',Created:'2026-09-30T09:49:56Z',State:{StartedAt:'2026-09-30T09:49:56Z'},
      Mounts:[{Type:'bind',Source:`/host_mnt${s.releases}/${unsafe}/infra/docker/vector.yaml`}]}];
    const kept=sh(s,`hawa_release_prune_unsafe '${s.src}' ${floor}`,{PATH:fakeDocker(s.t,bound)});
    expect(kept.code,kept.err).toBe(0);
    expect(kept.out).toContain(`kept unsafe release ${unsafe}`);
    expect(fs.existsSync(path.join(s.releases,unsafe))).toBe(true);
    const unsure=sh(s,`hawa_release_prune_unsafe '${s.src}' ${floor}`,{PATH:fakeDocker(s.t,'fail')});
    expect(unsure.code).toBe(0);
    expect(unsure.err).toContain('no unsafe release was removed');
    expect(fs.existsSync(path.join(s.releases,unsafe))).toBe(true);
  });
  it('blocks activating a pre-identity rollback once the host has migrated',()=>{
    const s=setup(); const release=sh(s,`hawa_release_prepare '${s.src}' ${s.head}`).out;
    fs.writeFileSync(path.join(s.shared,'infra/docker/.worker-identity-v2'),'');
    const result=sh(s,`hawa_release_activate '${release}'`);
    expect(result.code).toBe(1); expect(result.err).toContain('independent worker identities');
    expect(fs.existsSync(path.join(s.home,'.hawa/current'))).toBe(false);
  });
});

// 2026-10-02: two agents deploy to one host; a candidate that lacks the live release is refused.
describe('release_lib: a deployment keeps the live release', () => {
  const live = (s: ReturnType<typeof setup>, commit: string, link = 'current') => {
    const dir = path.join(s.releases, commit);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(s.home, '.hawa'), { recursive: true });
    fs.rmSync(path.join(s.home, '.hawa', link), { force: true });
    fs.symlinkSync(dir, path.join(s.home, '.hawa', link));
  };

  it('passes a first deploy, the live commit itself, and a descendant of it', () => {
    const s = setup();
    expect(sh(s, `hawa_deploy_keeps_live '${s.src}' ${s.head}`).code).toBe(0);
    live(s, s.head);
    expect(sh(s, `hawa_deploy_keeps_live '${s.src}' ${s.head}`).code).toBe(0);
    const next = s.commit();
    expect(sh(s, `hawa_deploy_keeps_live '${s.src}' ${next}`).code).toBe(0);
  });

  it('refuses a candidate that does not contain the live release, naming both', () => {
    const s = setup();
    const base = s.head;
    const theirs = s.commit();
    git(s.src, 'checkout', '-q', base);
    git(s.src, 'checkout', '-q', '-b', 'mine');
    const mine = s.commit();
    live(s, theirs);
    const r = sh(s, `hawa_deploy_keeps_live '${s.src}' ${mine}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${mine.slice(0, 12)} does not contain the live release ${theirs.slice(0, 12)}`);
    // Merged, it passes.
    git(s.src, 'merge', '-q', '--no-edit', '-s', 'ours', theirs);
    expect(sh(s, `hawa_deploy_keeps_live '${s.src}' ${git(s.src, 'rev-parse', 'HEAD')}`).code).toBe(0);
  });

  it('lets the previous release through (the rollback) and an explicit override, saying so', () => {
    const s = setup();
    const older = s.head;
    const newer = s.commit();
    live(s, newer);
    live(s, older, 'previous');
    const rollback = sh(s, `hawa_deploy_keeps_live '${s.src}' ${older}`);
    expect(rollback.code).toBe(0);
    expect(rollback.err).toContain('a rollback');
    const sideways = (() => { git(s.src, 'checkout', '-q', older); git(s.src, 'checkout', '-q', '-b', 'side'); return s.commit(); })();
    expect(sh(s, `hawa_deploy_keeps_live '${s.src}' ${sideways}`).code).toBe(1);
    const forced = sh(s, `hawa_deploy_keeps_live '${s.src}' ${sideways}`, { HAWA_DEPLOY_ALLOW_NON_DESCENDANT: '1' });
    expect(forced.code).toBe(0);
    expect(forced.err).toContain('WARNING');
  });

  it('refuses a live commit this repository does not have', () => {
    const s = setup();
    live(s, 'e'.repeat(40));
    const r = sh(s, `hawa_deploy_keeps_live '${s.src}' ${s.head}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not in this repository');
  });

  it('deploy.sh checks it under the deploy lock, before it prepares the release', () => {
    const deploy = fs.readFileSync(path.join(repo, 'infra/docker/deploy.sh'), 'utf8');
    const locked = deploy.indexOf('exec python3 "${ROOT_DIR}/infra/ops/deploy_lock.py"');
    const keeps = deploy.indexOf('hawa_deploy_keeps_live "$ROOT_DIR" "$BUILD_COMMIT"');
    expect(locked).toBeGreaterThan(0);
    // Under the lock, a deploy that waited for another sees the release that one put live.
    expect(keeps).toBeGreaterThan(locked);
    expect(deploy.indexOf('hawa_release_prepare "$ROOT_DIR" "$BUILD_COMMIT"')).toBeGreaterThan(keeps);
    expect(deploy.split('hawa_deploy_keeps_live "$ROOT_DIR"').length - 1).toBe(1);
  });
});
