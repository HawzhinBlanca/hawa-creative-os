import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-141: infra/docker/deploy.sh on another host than the one Mac it grew up on.
 *
 * Volume stamps. deploy.sh refuses a production volume whose creation time differs from the recorded
 * one (the Postgres volume was recreated, and emptied, by a deploy on 2026-09-17). The stamps were
 * tracked in git with that Mac's times, so every other host refused to deploy, and correcting them
 * made the checkout dirty, which deploy.sh also refuses. They are now host-local; a host that still has
 * the old repository file adopts it once, and a host with neither records the time, as before.
 *
 * Host role. A standby or retired host refuses --apply before anything is touched: two live hosts
 * would poll the same Telegram bot. The functions are taken from deploy.sh itself (as in
 * deploy-sh-worker-steps); `docker` is a stub.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const deployPath = path.join(repo, 'infra/docker/deploy.sh');
const deploySh = fs.readFileSync(deployPath, 'utf8');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-host-state-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fn(name: string): string {
  const start = deploySh.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no function ${name}`);
  const end = deploySh.indexOf('\n}\n', start);
  return deploySh.slice(start + 1, end + 3);
}

const CREATED = '2026-09-17T15:28:05Z';
let n = 0;
function scene() {
  const dir = path.join(tmp, `scene-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, stamp: path.join(dir, 'home/.hawa/volume-stamps/hawa-production_postgres_data.created'), legacy: path.join(dir, 'repo/infra/docker/.postgres_volume_created') };
}
/** check_volume_stamp for the Postgres volume, with `docker volume inspect` answering `created` (or failing). */
function check(s: ReturnType<typeof scene>, opts: { created?: string | null; record?: 0 | 1; role?: string } = {}) {
  const created = opts.created === undefined ? CREATED : opts.created;
  const docker = created === null
    ? 'docker() { return 1; }'
    : `docker() { [[ "$1 $2" == "volume inspect" ]] || return 9; [[ "\${4:-}" == --format ]] && echo '${created}'; return 0; }`;
  const script = ['set -Eeuo pipefail', `source '${repo}/infra/ops/host_lib.sh'`, `ROOT_DIR='${s.dir}/repo'`, `HOST_ROLE='${opts.role ?? 'production'}'`,
    docker, fn('check_volume_stamp'),
    `check_volume_stamp hawa-production_postgres_data Postgres '${s.stamp}' '${s.legacy}' ${opts.record ?? 1}`, 'echo CONTINUED'].join('\n');
  const res = spawnSync(BASH, ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(s.dir, 'home') } });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}
const read = (f: string) => fs.readFileSync(f, 'utf8');
const mode = (f: string) => (fs.statSync(f).mode & 0o777).toString(8);

describe('host-local volume stamps (deploy.sh steps 1b/1c)', () => {
  it('a host whose stamp matches goes on and changes nothing', () => {
    const s = scene();
    fs.mkdirSync(path.dirname(s.stamp), { recursive: true });
    fs.writeFileSync(s.stamp, `${CREATED}\n`);
    const r = check(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`✓ postgres volume 'hawa-production_postgres_data' verified (created at ${CREATED})`);
    expect(r.out).toContain('CONTINUED');
    expect(read(s.stamp)).toBe(`${CREATED}\n`);
  });

  it('a recreated volume (a different creation time) is refused, as before', () => {
    const s = scene();
    fs.mkdirSync(path.dirname(s.stamp), { recursive: true });
    fs.writeFileSync(s.stamp, `${CREATED}\n`);
    const r = check(s, { created: '2026-10-01T09:00:00Z' });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`ERROR: Postgres volume creation timestamp changed! Expected: '${CREATED}', Got: '2026-10-01T09:00:00Z'. Refusing deployment to prevent data loss.`);
    expect(r.out).not.toContain('CONTINUED');
    expect(read(s.stamp)).toBe(`${CREATED}\n`);
  });

  it('adopts the old repository stamp once, into a private host-local file, then checks against it', () => {
    const s = scene();
    fs.mkdirSync(path.dirname(s.legacy), { recursive: true });
    fs.writeFileSync(s.legacy, `${CREATED}\n`);
    const r = check(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`✓ postgres volume stamp adopted once from infra/docker/.postgres_volume_created into ${s.stamp}`);
    expect(read(s.stamp)).toBe(`${CREATED}\n`);
    expect(mode(s.stamp)).toBe('600');
    expect(mode(path.dirname(s.stamp))).toBe('700');
    expect(read(s.legacy)).toBe(`${CREATED}\n`); // never deleted
    // The host-local stamp is what counts from now on.
    fs.writeFileSync(s.legacy, 'garbage\n');
    const again = check(s);
    expect(again.code, again.out).toBe(0);
    expect(again.out).not.toContain('adopted');
  });

  it('an adopted stamp that does not match the volume is kept, and the deploy refused', () => {
    const s = scene();
    fs.mkdirSync(path.dirname(s.legacy), { recursive: true });
    fs.writeFileSync(s.legacy, `${CREATED}\n`);
    const r = check(s, { created: '2026-10-01T09:00:00Z' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('adopted once');
    expect(r.out).toContain('creation timestamp changed');
    expect(read(s.stamp)).toBe(`${CREATED}\n`);
  });

  it('a brand-new host records the volume it has and goes on (today\'s behaviour for a missing stamp)', () => {
    const s = scene();
    const r = check(s, { created: '2026-10-02T08:00:00Z' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`✓ postgres volume stamp recorded for this host in ${s.stamp}`);
    expect(r.out).toContain('CONTINUED');
    expect(read(s.stamp)).toBe('2026-10-02T08:00:00Z\n');
    expect(mode(s.stamp)).toBe('600');
    // The next deploy checks against it.
    expect(check(s, { created: '2026-10-03T08:00:00Z' }).code).toBe(1);
  });

  it('a standby host records nothing (the rehearsal volumes are thrown away), but still compares what it has', () => {
    const s = scene();
    const r = check(s, { record: 0, role: 'standby' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('NOTE: no postgres volume stamp for this host, and none recorded (host role standby)');
    expect(fs.existsSync(path.dirname(s.stamp))).toBe(false);
    fs.mkdirSync(path.dirname(s.legacy), { recursive: true });
    fs.writeFileSync(s.legacy, '2026-01-01T00:00:00Z\n');
    expect(check(s, { record: 0, role: 'standby' }).code).toBe(1);
    expect(fs.existsSync(s.stamp)).toBe(false);
  });

  it('a missing volume is refused, as before', () => {
    const r = check(scene(), { created: null });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR: Postgres volume 'hawa-production_postgres_data' does not exist! Refusing to start or recreate.");
  });

  it('deploy.sh checks both volumes against host-local stamps and the stamps are no longer tracked', () => {
    expect(deploySh).toContain('VOLUME_STAMP_DIR="${HAWA_VOLUME_STAMP_DIR:-${HOME}/.hawa/volume-stamps}"');
    expect(deploySh).toContain('check_volume_stamp hawa-production_postgres_data Postgres "${VOLUME_STAMP_DIR}/hawa-production_postgres_data.created" "${SCRIPT_DIR}/.postgres_volume_created" "$RECORD_STAMPS"');
    expect(deploySh).toContain('check_volume_stamp hawa-production_restate_data Restate "${VOLUME_STAMP_DIR}/hawa-production_restate_data.created" "${SCRIPT_DIR}/.restate_volume_created" "$RECORD_STAMPS"');
    const tracked = execFileSync('git', ['-C', repo, 'ls-files', 'infra/docker'], { encoding: 'utf8' });
    expect(tracked).not.toMatch(/volume_created/);
    const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '-q', 'infra/docker/.postgres_volume_created']);
    expect(ignored.status).toBe(0);
  });
});

describe('the host role in deploy.sh', () => {
  function refuse(role: string, rc: number, apply: 0 | 1) {
    const script = ['set -Eeuo pipefail', `source '${repo}/infra/ops/host_lib.sh'`, `APPLY=${apply}`, fn('refuse_inactive_host'),
      `refuse_inactive_host '${role}' ${rc}`, 'echo CONTINUED'].join('\n');
    const res = spawnSync(BASH, ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, HAWA_HOST_ROLE: role } });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('production deploys as before, silently', () => {
    expect(refuse('production', 0, 1)).toEqual({ code: 0, out: 'CONTINUED\n' });
  });
  it('retired and standby refuse --apply', () => {
    for (const role of ['retired', 'standby']) {
      const r = refuse(role, 0, 1);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`ERROR: this host is marked ${role} (HAWA_HOST_ROLE): production runs on another host`);
    }
  });
  it('pre-flight still runs on a standby host, and says so', () => {
    const r = refuse('standby', 0, 0);
    expect(r.code).toBe(0);
    expect(r.out).toContain('NOTE: this host is marked standby (HAWA_HOST_ROLE): pre-flight only, and no volume stamp is recorded.');
  });
  it('an unknown role refuses both', () => {
    expect(refuse('retierd', 2, 0).code).toBe(1);
    expect(refuse('retierd', 2, 1).out).toContain("unrecognised host role 'retierd'");
  });

  // The whole script, up to its refusal: nothing may run before it. Docker is a stub that records calls.
  it('deploy.sh --apply on a retired host stops before its first docker, git-state or file change', () => {
    const bin = path.join(tmp, 'bin-deploy');
    fs.mkdirSync(bin, { recursive: true });
    const calls = path.join(tmp, 'deploy-calls');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "docker $*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
    const home = path.join(tmp, 'deploy-home');
    fs.mkdirSync(path.join(home, '.hawa'), { recursive: true });
    fs.writeFileSync(path.join(home, '.hawa', 'host-role'), 'retired\n');
    const res = spawnSync(BASH, [deployPath, '--apply'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, ALLOW_DIRTY_DEPLOY: '1' },
    });
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toContain(`ERROR: this host is marked retired (${path.join(home, '.hawa', 'host-role')})`);
    expect(fs.existsSync(calls)).toBe(false);
    expect(fs.existsSync(path.join(home, '.hawa', 'volume-stamps'))).toBe(false);
  });
});
