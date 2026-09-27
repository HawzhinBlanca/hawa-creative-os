import { assert, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The file store behind nginx (ADR-035 section 2.4, FILESTORE_DESIGN.md sections 3 and 7):
 * infra/docker/nginx.conf passes `nginx -t`, its /_blobs/ location is internal, and a Core answer with
 * X-Accel-Redirect makes nginx send the file from the read-only mount with Core's headers and the
 * security headers. Runs the production image (nginx:1.27-alpine-slim) with a stub Core on this host;
 * only the two upstream addresses of a copy of the file are changed. Skips without Docker or the image.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const nginxConf = path.join(repo, 'infra/docker/nginx.conf');
const compose = fs.readFileSync(path.join(repo, 'infra/docker/docker-compose.prod.yml'), 'utf8');
const IMAGE = 'nginx:1.27-alpine-slim';

const docker = (args: string[], timeout = 60_000) => spawnSync('docker', args, { encoding: 'utf8', timeout });
const haveImage = docker(['image', 'inspect', IMAGE]).status === 0;

describe('nginx.conf and the compose mounts agree on the file store', () => {
  it('the internal location aliases the directory compose mounts read-only into nginx', () => {
    const conf = fs.readFileSync(nginxConf, 'utf8');
    const block = /location \/_blobs\/ \{([\s\S]*?)\n        \}/.exec(conf)?.[1] ?? '';
    expect(block).toMatch(/^\s*internal;$/m);
    const alias = /alias (\S+);/.exec(block)?.[1];
    expect(alias).toBe('/srv/hawa-blobs/'); assert(alias);
    expect(compose).toContain(`- \${HAWA_BLOBS_DIR:-\${HOME}/.hawa/blobs}:${alias.replace(/\/$/, '')}:ro`);
    // Core and both worker colours mount the same host directory read-write at HAWA_BLOB_DIR.
    expect(compose.match(/- \$\{HAWA_BLOBS_DIR:-\$\{HOME\}\/\.hawa\/blobs\}:\/var\/lib\/hawa\/blobs$/gm)?.length).toBe(2); // core + the x-worker anchor
    expect(compose.match(/^\s+HAWA_BLOB_DIR: \/var\/lib\/hawa\/blobs$/gm)?.length).toBe(2); // core + x-worker-environment
    expect(compose).toMatch(/HAWA_BLOB_ACCEL_PREFIX: \/_blobs\//);
  });

  it.skipIf(docker(['compose', 'version']).status !== 0)('docker compose config -q accepts the file (a copy beside an empty .env.production, placeholder interpolation values)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-compose-'));
    try {
      fs.writeFileSync(path.join(dir, 'docker-compose.prod.yml'), compose);
      fs.writeFileSync(path.join(dir, '.env.production'), '');
      const res = spawnSync('docker', ['compose', '-f', path.join(dir, 'docker-compose.prod.yml'), '--env-file', '/dev/null', '--profile', 'worker', 'config', '-q'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), DATABASE_URL: 'postgresql://placeholder@db/x', POSTGRES_PASSWORD: 'placeholder' },
      });
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveImage)(`the /_blobs/ location in ${IMAGE}`, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-nginx-'));
  const blobs = path.join(work, 'blobs');
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(20_000)]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rel = `sha256/${sha.slice(0, 2)}/${sha}.png`;
  let stub: http.Server;
  let container = '';
  let base = '';

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(path.join(blobs, rel)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(blobs, rel), bytes, { mode: 0o444 });
    for (const d of [work, blobs, path.join(blobs, 'sha256'), path.dirname(path.join(blobs, rel))]) fs.chmodSync(d, 0o755);
    // Core as the helper answers (apps/core/src/services/blob-response.ts): an empty 200 with the redirect.
    stub = http.createServer((req, res) => {
      if (req.url === '/v1/file') {
        res.writeHead(200, {
          'X-Accel-Redirect': `/_blobs/${rel}`,
          'Content-Type': 'image/png',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Disposition': 'inline; filename="design.png"',
          'X-Content-SHA256': sha,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
      } else if (req.url === '/v1/judge-file') {
        res.writeHead(200, { 'X-Accel-Redirect': `/_blobs/${rel}`, 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('desk');
      }
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;
    const conf = fs.readFileSync(nginxConf, 'utf8')
      .replace('server core:3001;', `server host.docker.internal:${port};`)
      .replace('server desk:80;', `server host.docker.internal:${port};`);
    fs.writeFileSync(path.join(work, 'nginx.conf'), conf, { mode: 0o644 });
    const run = docker(['run', '-d', '--rm', '-p', '127.0.0.1::80', '-v', `${path.join(work, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`, '-v', `${blobs}:/srv/hawa-blobs:ro`, IMAGE]);
    if (run.status !== 0) throw new Error(`nginx did not start: ${run.stderr}`);
    container = run.stdout.trim();
    const mapped = docker(['port', container, '80']).stdout.split('\n')[0].trim();
    base = `http://127.0.0.1:${mapped.split(':').pop()}`;
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${base}/`).then((r) => r.ok).catch(() => false);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`nginx did not answer: ${docker(['logs', container]).stderr}`);
  }, 90_000);

  afterAll(async () => {
    if (container) docker(['rm', '-f', container]);
    await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('passes nginx -t as committed (upstream names resolved to a stub address)', () => {
    const res = docker(['run', '--rm', '--add-host', 'core:127.0.0.1', '--add-host', 'desk:127.0.0.1', '-v', `${nginxConf}:/etc/nginx/nginx.conf:ro`, IMAGE, 'nginx', '-t']);
    expect(res.stderr).toMatch(/test is successful/);
    expect(res.status).toBe(0);
  });

  it("sends the file for Core's X-Accel-Redirect, with Core's headers and the security headers", async () => {
    const res = await fetch(`${base}/v1/file`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="design.png"');
    expect(res.headers.get('x-content-sha256')).toBe(sha);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    expect(res.headers.get('x-accel-redirect')).toBeNull();
  });

  it('omits the hash when Core leaves it out (a judge link)', async () => {
    const res = await fetch(`${base}/v1/judge-file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-sha256')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(bytes.length);
  });

  it('answers 404 to any direct request for /_blobs/', async () => {
    for (const p of [`/_blobs/${rel}`, '/_blobs/', '/_blobs/../_blobs/' + rel, `/_blobs/sha256/${sha.slice(0, 2)}/`]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.includes(bytes.subarray(0, 64)), p).toBe(false);
    }
    // A path that climbs out of /_blobs/ is normalised by nginx before matching, so it is an ordinary
    // request for the Desk (the stub answers 'desk'), never a read outside the store.
    const climb = await fetch(`${base}/_blobs/%2e%2e/etc/passwd`);
    expect(await climb.text()).toBe('desk');
  });
});
