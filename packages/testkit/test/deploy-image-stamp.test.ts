import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deploy = fs.readFileSync(path.join(root, 'infra/docker/deploy.sh'), 'utf8');
const commit = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;

function functionSource(name: string): string {
  const start = deploy.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing deploy function ${name}`);
  const end = deploy.indexOf('\n}\n', start);
  return deploy.slice(start + 1, end + 3);
}

function inspectWith(label: string, id = imageId, service = 'core') {
  const script = [
    'set -Eeuo pipefail',
    `BUILD_COMMIT=${commit}`,
    'INTERP_FILE=/dev/null',
    'COMPOSE=(compose)',
    'compose() { [[ " $* " == *" --profile worker "* ]] || return 3; printf \'%s\\n\' \'{"services":{"core":{"image":"hawa-core:test"},"worker-blue":{"image":"hawa-worker:test-blue"}}}\'; }',
    `docker() { if [[ "$4" == *'.Id'* ]]; then printf '%s\\n' '${id}'; else printf '%s\\n' '${label}'; fi; }`,
    functionSource('verify_built_image'),
    `verify_built_image ${service}`,
  ].join('\n');
  return spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8' });
}

describe('deployment image identity', () => {
  it('rejects a forged build stamp before contacting Docker or PostgreSQL', () => {
    const result = spawnSync('bash', ['infra/docker/deploy.sh'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HAWA_BUILD_COMMIT: 'f'.repeat(40) },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must equal this checkout's HEAD");
    expect(result.stdout).not.toContain('production deployment');
  });

  it('accepts a built image only when its immutable ID and OCI revision match', () => {
    expect(inspectWith(commit).status).toBe(0);
    expect(inspectWith(commit, imageId, 'worker-blue').status).toBe(0);
    expect(inspectWith('c'.repeat(40)).status).toBe(1);
    expect(inspectWith(commit, 'not-an-image-id').status).toBe(1);
  });

  it('passes the build stamp through Compose and labels each shipping image', () => {
    const compose = fs.readFileSync(path.join(root, 'infra/docker/docker-compose.prod.yml'), 'utf8');
    expect(compose.match(/HAWA_BUILD_COMMIT: \$\{HAWA_BUILD_COMMIT:-unknown\}/g)?.length).toBeGreaterThanOrEqual(4);
    for (const service of ['core', 'desk', 'worker']) {
      const dockerfile = fs.readFileSync(path.join(root, `infra/docker/Dockerfile.${service}`), 'utf8');
      expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$HAWA_BUILD_COMMIT');
    }
  });
});
