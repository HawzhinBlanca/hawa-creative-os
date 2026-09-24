import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/backup/restate-restore.sh, the restore half of the Restate drill (architecture programme 2.6,
 * ADR-034), run as it is with the system bash and `docker` stubbed on PATH: it never restores into
 * production, refuses an archive whose node name the target does not run as (Restate would start
 * empty: it keeps its data under /restate-data/<node name>/), and otherwise stops the target, unpacks
 * the archive into its volume, starts it and waits until it serves the worker's services.
 * The whole drill against real containers is the chaos suite's RD1 (`run.ts --restore-drill`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const script = path.join(repo, 'infra/backup/restate-restore.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const DOCKER_STUB = `#!/bin/bash
S="$STUB_STATE"
echo "docker $*" >> "$S/calls"
case "$1" in
  inspect)
    if [[ "$2" != -f ]]; then exit 0; fi
    case "$3" in
      *Mounts*) echo drill_restate_data ;;
      *Config.Image*) echo stub/restate:1 ;;
      *Config.Env*) printf 'PATH=/usr/bin\\nRESTATE_NODE_NAME=%s\\n' "$STUB_NODE" ;;
      *Health*) if [[ "$(cat "$S/running")" == true ]]; then echo healthy; else echo exited; fi ;;
      *State.Running*) cat "$S/running"; echo ;;
    esac ;;
  stop) echo false > "$S/running" ;;
  start) echo true > "$S/running" ;;
  run) cat > "$S/unpacked.tar" ;;
  exec) exit 0 ;;
esac
`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function setup(archiveNode = 'hawa-restate-chaos-1') {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-restate-restore-'));
  temps.push(t);
  const bin = path.join(t, 'bin');
  const state = path.join(t, 'stub');
  const archive = path.join(t, 'archive');
  const volume = path.join(t, 'volume');
  for (const d of [bin, state, archive, path.join(volume, archiveNode, 'log-store')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'running'), 'true\n');
  fs.writeFileSync(path.join(state, 'calls'), '');
  fs.writeFileSync(path.join(volume, archiveNode, 'log-store', '000001.sst'), 'bytes');
  const keyfile = path.join(t, 'passphrase');
  fs.writeFileSync(keyfile, ['drill', String(Date.now())].join('-'), { mode: 0o600 });
  const file = path.join(archive, 'restate_20260925T013000Z.tar.enc');
  const made = spawnSync('bash', ['-c', `tar -cf - -C "${volume}" . | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -out "${file}" -pass "file:${keyfile}" && shasum -a 256 "${file}" | cut -d' ' -f1 > "${file}.sha256"`]);
  if (made.status !== 0) throw new Error('could not build the fixture archive');
  const run = (env: Record<string, string>, targetNode = 'hawa-restate-chaos-1') => {
    const res = spawnSync(BASH, [script], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: t, TMPDIR: t, STUB_STATE: state, STUB_NODE: targetNode, HAWA_BACKUP_ARCHIVE_DEST: archive, HAWA_BACKUP_ARCHIVE_KEYFILE: keyfile, HAWA_RESTATE_HEALTH_SECONDS: '3', ...env },
    });
    return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
  };
  const calls = () => fs.readFileSync(path.join(state, 'calls'), 'utf8').split('\n').filter(Boolean);
  return { t, state, file, run, calls };
}

describe('restate-restore.sh', () => {
  it('restores the newest archive into the drill stack: stop, unpack, start, serving', () => {
    const s = setup();
    const r = s.run({ HAWA_RESTATE_RESTORE_PROJECT: 'hawa-chaos' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/RESTORE OK archive=restate_20260925T013000Z\.tar\.enc bytes=\d+ restore_s=\d+ down_s=\d+ node=hawa-restate-chaos-1 target=hawa-chaos-restate-1/);
    const c = s.calls();
    const stop = c.findIndex((l) => l === 'docker stop -t 60 hawa-chaos-restate-1');
    const unpack = c.findIndex((l) => /^docker run --rm -i --pull never --network none -v drill_restate_data:\/data /.test(l));
    const start = c.findIndex((l) => l === 'docker start hawa-chaos-restate-1');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(unpack).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(unpack);
    expect(c.slice(start).some((l) => /curl .*\/services\/TaskWorkflow$/.test(l))).toBe(true);
    // What reached the helper container is the archive, decrypted.
    const listed = spawnSync('tar', ['-tf', path.join(s.state, 'unpacked.tar')], { encoding: 'utf8' }).stdout;
    expect(listed).toMatch(/hawa-restate-chaos-1\/log-store\/000001\.sst/);
  });

  it('never restores into production, and needs a named project', () => {
    const s = setup();
    for (const env of [{ HAWA_RESTATE_RESTORE_PROJECT: 'hawa-production' }, { HAWA_RESTATE_RESTORE_PROJECT: 'hawa-chaos', HAWA_RESTATE_RESTORE_CONTAINER: 'hawa-production-restate-1' }, {}]) {
      const r = s.run(env);
      expect(r.code).not.toBe(0);
    }
    expect(s.calls().filter((l) => /^docker (stop|run|start)/.test(l))).toEqual([]);
  });

  it('refuses, before stopping anything, an archive of a node the target does not run as', () => {
    const s = setup('hawa-restate-prod-1');
    const r = s.run({ HAWA_RESTATE_RESTORE_PROJECT: 'hawa-chaos' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/holds node hawa-restate-prod-1, but hawa-chaos-restate-1 runs as hawa-restate-chaos-1: Restate would start empty/);
    expect(s.calls().filter((l) => /^docker (stop|run|start)/.test(l))).toEqual([]);
  });

  it('refuses an archive that does not match its checksum', () => {
    const s = setup();
    fs.writeFileSync(`${s.file}.sha256`, `${'0'.repeat(64)}\n`);
    const r = s.run({ HAWA_RESTATE_RESTORE_PROJECT: 'hawa-chaos' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/does not match its checksum/);
    expect(s.calls().filter((l) => /^docker (stop|run|start)/.test(l))).toEqual([]);
  });
});
