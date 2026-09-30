import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/ops/disk_cleanup.sh (audit 2026-09-30 P2, ADR-158). Every Docker call went to /dev/null, and
 * `docker builder prune --max-used-space 8GB` left 31.7 GB of build cache hour after hour: with the
 * containerd image store 23 GB of it is layers shared with images, which BuildKit's limit does not
 * count. Each step now says what it freed and why it failed, and while the cache is still over the
 * ceiling Hawa's own unused images older than a week are removed (never production's tags, never an
 * image a container uses, never another project's), and the cache is pruned again.
 *
 * docker is a stub whose answers come from files in the case directory.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../../infra/ops/disk_cleanup.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-disk-cleanup-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const old = '2026-09-01 10:00:00 +0300 +03';
const recent = new Date(Date.now() - 2 * 86400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC');
const IMAGES = [
  `hawa-core:canva-only-20260913|ccf5ceb23cb6|${old}|1.27GB`, // production's tag (the release override)
  `hawa-worker:canva-only-20260913-green|aaaaaaaaaaaa|${old}|660MB`, // production's idle colour: kept
  `hawa-chaos-core:local|bbbbbbbbbbbb|${old}|1.24GB`, // a stopped container uses it
  `hawa-core:verify-head|38b56998fb4a|${old}|701MB`,
  `hawa-core:verdana-check|bf907f88c231|${old}|704MB`,
  `hawa-fallback-measure-proof:local|cccccccccccc|${recent}|1.38GB`, // newer than a week
  `hawa-core:<none>|dddddddddddd|${old}|1GB`,
];

let n = 0;
function run(opts: { prune?: 'ok' | 'fail'; cacheAfter?: string } = {}) {
  const t = path.join(tmp, `case-${++n}`);
  const bin = path.join(t, 'bin'); const snaps = path.join(t, 'snapshots');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(snaps);
  const f = (name: string) => path.join(t, name);
  for (let i = 0; i < 12; i++) {
    const dump = path.join(snaps, `predeploy_202609${String(10 + i).padStart(2, '0')}T000000Z.dump`);
    fs.writeFileSync(dump, 'x'.repeat(2048)); fs.writeFileSync(`${dump}.sha256`, 'hash\n');
  }
  fs.writeFileSync(f('images'), `${IMAGES.join('\n')}\n`);
  fs.writeFileSync(f('df'), `Build Cache|31.73GB\nBuild Cache|${opts.cacheAfter ?? '31.73GB'}\n`);
  const prune = opts.prune === 'fail'
    ? 'echo "ERROR: failed to prune build cache: context deadline exceeded" >&2; exit 1'
    : 'printf "ID\\tRECLAIMABLE\\tSIZE\\nabc\\ttrue\\t1.2GB\\nTotal:\\t1.2GB\\n"';
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> '${f('calls')}'
case "$*" in
  "info"*) exit 0 ;;
  "builder prune"*) ${prune} ;;
  "image prune"*) echo "Total reclaimed space: 0B" ;;
  "system df --format {{.Type}}|{{.Size}}") n=$(( $(cat '${f('df.n')}' 2>/dev/null || echo 0) + 1 )); echo $n > '${f('df.n')}'; sed -n "\${n}p" '${f('df')}' | grep . || tail -1 '${f('df')}' ;;
  "system df"*) echo "Build Cache 9GB (1GB reclaimable)" ;;
  "ps -a --format {{.Image}}") printf 'hawa-core:canva-only-20260913\\nhawa-chaos-core:local\\nnginx:1.27-alpine-slim\\n' ;;
  "image ls --filter reference=hawa-*"*) cat '${f('images')}' ;;
  "image rm hawa-core:verdana-check") echo "Error response from daemon: conflict: unable to remove repository reference" >&2; exit 1 ;;
  "image rm "*) echo "Untagged: \${3}" ;;
esac
exit 0
`, { mode: 0o755 });
  const res = spawnSync(BASH, [script], { encoding: 'utf8', env: {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: path.join(t, 'home'),
    HAWA_BACKUP_SNAPSHOT_DIR: snaps, HAWA_BACKUP_ARCHIVE_DIR: path.join(t, 'archive'), HAWA_BLOBS_DIR: path.join(t, 'blobs'),
    HAWA_CONTAINER_LOGS_DIR: path.join(t, 'logs') } });
  const calls = fs.readFileSync(f('calls'), 'utf8');
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, calls, snaps };
}

describe('disk_cleanup.sh says what it freed and holds the build cache to its ceiling', () => {
  it('logs each removed dump and what the files freed', () => {
    const r = run({ cacheAfter: '7GB' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^removed predeploy_20260910T000000Z\.dump \(\d+ KB\): beyond the newest 10 pre-deploy dumps$/m);
    expect(r.stdout).toMatch(/^removed predeploy_20260911T000000Z\.dump\.sha256 \(\d+ KB\): beyond the newest 10 pre-deploy dumps$/m);
    expect(fs.readdirSync(r.snaps).filter((x) => x.endsWith('.dump'))).toHaveLength(10);
    expect(r.stdout).toMatch(/^files: freed \d+ MB$/m);
  });

  it('prunes the cache, then removes only Hawa\'s own old unused images while the cache is over the ceiling, and prunes again', () => {
    const r = run({ cacheAfter: '7GB' });
    expect(r.stdout).toContain('build cache over 8GB: freed 1.2GB');
    expect(r.stdout).toContain('dangling images: freed 0B');
    expect(r.stdout).toContain('build cache is 31.73GB, over 8GB: most of it is layers of images');
    const removed = r.calls.split('\n').filter((l) => l.startsWith('docker image rm')).sort();
    expect(removed).toEqual(['docker image rm hawa-core:verdana-check', 'docker image rm hawa-core:verify-head']);
    expect(r.stdout).toContain('removed image hawa-core:verify-head (701MB)');
    expect(r.stderr).toContain('ERROR: could not remove image hawa-core:verdana-check: Error response from daemon: conflict');
    expect(r.calls.match(/docker builder prune -f --max-used-space 8GB/g)).toHaveLength(2);
    expect(r.stderr).not.toContain('still');
  });

  it('says so when the cache is still over the ceiling after that', () => {
    const r = run();
    expect(r.stderr).toMatch(/WARNING: build cache is still 31\.73GB, over 8GB: the rest belongs to images in use, production's own tags/);
  });

  it('reports a failed prune with its reason instead of swallowing it, and goes on', () => {
    const r = run({ prune: 'fail', cacheAfter: '7GB' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('ERROR: build cache prune failed (exit 1): ERROR: failed to prune build cache: context deadline exceeded');
    expect(r.stdout).toContain('dangling images: freed 0B');
  });
});
