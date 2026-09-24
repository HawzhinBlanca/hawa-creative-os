import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The file store steps of infra/docker/deploy.sh (ADR-035): the directory and its marker before any
 * container starts, and the smoke check afterwards that /_blobs/ is not reachable from outside and Core
 * sees the store. The functions are taken from the script itself and run in bash with curl and docker
 * stubbed, as packages/testkit/test/deploy-sh-worker-steps.test.ts does for the worker steps.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const deploySh = fs.readFileSync(path.resolve(here, '../../../infra/docker/deploy.sh'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-deploy-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fn(name: string): string {
  const start = deploySh.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no function ${name}`);
  const end = deploySh.indexOf('\n}\n', start);
  return deploySh.slice(start + 1, end + 3);
}

function run(body: string, stubs = '') {
  const script = ['set -Eeuo pipefail', 'exec 9>&2', 'CORE_CONTAINER=hawa-production-core-1; BLOBS_DIR=/somewhere', stubs, fn('ensure_blob_store'), fn('check_blob_store_private'), body].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
  return { code: res.status, out: res.stdout, calls: res.stderr.split('\n').filter((l) => l.startsWith('CALL ')) };
}

describe('ensure_blob_store', () => {
  it('creates the store, its shard and temporary directories 0755 and the marker, and runs twice', () => {
    const root = path.join(tmp, 'store');
    for (let i = 0; i < 2; i++) {
      const r = run(`ensure_blob_store ${JSON.stringify(root)}; echo DONE`);
      expect(r.out).toMatch(/DONE/);
      expect(r.code).toBe(0);
    }
    for (const d of ['', 'sha256', 'tmp']) expect(fs.statSync(path.join(root, d)).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(root, '.hawa-blob-store'), 'utf8')).toBe('sha256-v1\n');
    expect(fs.statSync(path.join(root, '.hawa-blob-store')).mode & 0o777).toBe(0o644);
  });

  it('refuses a directory whose marker is something else', () => {
    const root = path.join(tmp, 'other');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.hawa-blob-store'), 'something-else\n');
    const r = run(`ensure_blob_store ${JSON.stringify(root)} || echo REFUSED`);
    expect(r.out).toMatch(/is not a sha256-v1 store marker/);
    expect(r.out).toMatch(/REFUSED/);
  });
});

describe('check_blob_store_private', () => {
  const docker = (ok: boolean) => `docker() { echo "CALL docker $*" >&9; return ${ok ? 0 : 1}; }`;
  const curl = (code: string) => `curl() { echo "CALL curl $*" >&9; printf '%s' '${code}'; }`;

  it('passes when nginx answers 404 to a direct /_blobs/ request and Core sees the marker', () => {
    const r = run('check_blob_store_private; echo PASSED', `${curl('404')}\n${docker(true)}`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/✓ file store mounted in Core, and \/_blobs\/ is not reachable from outside/);
    expect(r.calls.some((c) => /curl .*http:\/\/127\.0\.0\.1:8080\/_blobs\/\.hawa-blob-store/.test(c))).toBe(true);
    expect(r.calls).toContain('CALL docker exec hawa-production-core-1 test -f /var/lib/hawa/blobs/.hawa-blob-store');
  });

  it('fails when /_blobs/ is served from outside', () => {
    for (const code of ['200', '403', '000']) {
      const r = run('check_blob_store_private || echo FAILED', `${curl(code)}\n${docker(true)}`);
      expect(r.out).toMatch(new RegExp(`/_blobs/ answered ${code} to a direct request`));
      expect(r.out).toMatch(/FAILED/);
    }
  });

  it('fails when Core does not see the store', () => {
    const r = run('check_blob_store_private || echo FAILED', `${curl('404')}\n${docker(false)}`);
    expect(r.out).toMatch(/Core does not see the file store/);
    expect(r.out).toMatch(/FAILED/);
  });

  it('runs both steps in the deploy: the store before the pre-deploy backup, the check after health', () => {
    const ensure = deploySh.indexOf('ensure_blob_store "$BLOBS_DIR" || exit 1');
    const backup = deploySh.indexOf('# 5. Backup before anything changes');
    const up = deploySh.indexOf('"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d\n');
    const check = deploySh.indexOf('check_blob_store_private || exit 1');
    const health = deploySh.indexOf('# 8. Verify health truthfully');
    expect(ensure).toBeGreaterThan(deploySh.indexOf('if [[ $APPLY == 0 ]]; then'));
    expect(ensure).toBeLessThan(backup);
    expect(ensure).toBeLessThan(up);
    expect(check).toBeGreaterThan(health);
  });
});
