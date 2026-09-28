import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/docker/nginx.conf at the edge (ADR-128).
 *
 * - /v1/internal/* is the worker's address on the compose network (Core at http://core:3001). nginx
 *   proxied it from outside with the rest of /v1/ and /api/, so a mistake in the worker credential
 *   could be used from the public listener. nginx now answers 404 there itself.
 * - /_blobs/ is the file store nginx sends after Core's X-Accel-Redirect. A missing file was logged at
 *   error level with the original request line, which can carry a token in its query string, and the
 *   error log cannot mask it (the access log does). Missing files are no longer logged there.
 *
 * The first part reads the file. The second runs the production image (nginx:1.27-alpine-slim, already
 * on this machine; it is never pulled) with the file, a stub Core and a stub Desk on a throwaway
 * network, and sends real requests. HAWA_NGINX_CONF points it at another copy of the file (the red run
 * used the one at 7b8de71e).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const confPath = process.env.HAWA_NGINX_CONF ? path.resolve(process.env.HAWA_NGINX_CONF) : path.join(repo, 'infra/docker/nginx.conf');
const conf = fs.readFileSync(confPath, 'utf8');

/** The body of the first `location <selector> {` block, braces balanced. */
function block(selector: string): string {
  const start = conf.indexOf(`location ${selector} {`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) return conf.slice(start, i + 1);
  }
  return '';
}

describe('nginx.conf, read', () => {
  it('answers /v1/internal/, /api/v1/internal/ and /api/internal/ itself with 404', () => {
    const internal = block('~ ^/(?:api/)?(?:v1/)?internal(?:/|$)');
    expect(internal).toMatch(/return 404;/);
    expect(internal).not.toMatch(/proxy_pass/);
  });

  it('logs no missing stored file, and nothing below crit, in /_blobs/', () => {
    const blobs = block('/_blobs/');
    expect(blobs).toMatch(/\n\s*internal;/);
    expect(blobs).toMatch(/\n\s*log_not_found off;/);
    expect(blobs).toMatch(/\n\s*error_log \/var\/log\/nginx\/error\.log crit;/);
  });
});

/**
 * The worker never goes through nginx: every Core call it makes is built from HAWA_CORE_INTERNAL_URL,
 * whose default and documented value is Core's own address on the internal network.
 */
describe('the worker reaches Core directly, not through nginx', () => {
  const workerSrc = path.join(repo, 'apps/worker/src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  const sources = files(workerSrc).map((f) => ({ f: path.relative(repo, f), text: fs.readFileSync(f, 'utf8') }));

  it('every Core base address in the worker defaults to http://core:3001', () => {
    const uses = sources.flatMap(({ f, text }) => [...text.matchAll(/process\.env\.HAWA_CORE_INTERNAL_URL\s*\|\|\s*'([^']*)'/g)].map((m) => ({ f, fallback: m[1] })));
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const use of uses) expect(use, use.f).toEqual({ f: use.f, fallback: 'http://core:3001' });
    // The lifecycle client (both /v1/internal/* callers) builds its URLs from that base only.
    const client = sources.find((s) => s.f.endsWith('lifecycle/core-client.ts'))!.text;
    expect(client).toMatch(/\$\{base\}\/v1\/internal\/telegram\/intake/);
    const delivery = sources.find((s) => s.f.endsWith('lifecycle/delivery.ts'))!.text;
    expect(delivery).toMatch(/fetcher\(`\$\{base\}\/v1\$\{path\}`/);
  });

  it('no worker source names nginx or the published edge port', () => {
    for (const { f, text } of sources) expect(text, f).not.toMatch(/nginx|:8080\/v1|HAWA_PUBLIC_URL/);
  });

  it('the production example and compose file give the worker Core\'s internal address', () => {
    const example = fs.readFileSync(path.join(repo, 'infra/docker/.env.production.example'), 'utf8');
    expect(example).toMatch(/^HAWA_CORE_INTERNAL_URL=http:\/\/core:3001$/m);
    const compose = fs.readFileSync(path.join(repo, 'infra/docker/docker-compose.prod.yml'), 'utf8');
    expect(compose).not.toMatch(/HAWA_CORE_INTERNAL_URL:\s*\S*nginx/);
  });
});

const IMAGE = 'nginx:1.27-alpine-slim';
const docker = (args: string[], input?: string) => spawnSync('docker', args, { encoding: 'utf8', input, timeout: 60_000 });
const dockerReady = docker(['image', 'inspect', IMAGE]).status === 0;

describe.skipIf(!dockerReady)('nginx.conf, served by the production image', () => {
  const tag = `hawa-nginx-edge-test-${randomBytes(4).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-nginx-edge-'));
  const SECRET = `sess_${randomBytes(12).toString('hex')}`;
  let base = '';

  const stubCore = `events {}
http {
  server {
    listen 3001;
    location ~ \\.png$ { add_header X-Accel-Redirect /_blobs/sha256/ab/missing-file always; return 200 ''; }
    location / { default_type text/plain; return 200 "core $request_uri"; }
  }
}
`;
  const stubDesk = `events {}
http { server { listen 80; location / { default_type text/plain; return 200 "desk"; } } }
`;

  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'core.conf'), stubCore);
    fs.writeFileSync(path.join(dir, 'desk.conf'), stubDesk);
    fs.copyFileSync(confPath, path.join(dir, 'nginx.conf'));
    fs.mkdirSync(path.join(dir, 'blobs'));
    for (const f of ['core.conf', 'desk.conf', 'nginx.conf']) fs.chmodSync(path.join(dir, f), 0o644);
    fs.chmodSync(path.join(dir, 'blobs'), 0o755);
    const must = (args: string[]) => {
      const r = docker(args);
      if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    must(['network', 'create', tag]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-core`, '--network', tag, '--network-alias', 'core',
      '-v', `${dir}/core.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-desk`, '--network', tag, '--network-alias', 'desk',
      '-v', `${dir}/desk.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-edge`, '--network', tag, '-p', '127.0.0.1::80',
      '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${dir}/blobs:/srv/hawa-blobs:ro`, IMAGE]);
    const port = must(['port', `${tag}-edge`, '80/tcp']).split('\n')[0].split(':').pop();
    base = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(() => {
    docker(['rm', '-f', `${tag}-edge`, `${tag}-core`, `${tag}-desk`]);
    docker(['network', 'rm', tag]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  /** One request through the published edge port; retried while nginx starts. */
  async function get(p: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(base + p, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        if (attempt >= 30) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  it('does not proxy the worker-only address from outside, under any prefix or spelling nginx normalises', async () => {
    for (const p of ['/v1/internal/telegram/intake', '/v1/internal/lifecycle/x/delivery-finished', '/api/v1/internal/telegram/intake',
      '/api/internal/telegram/intake', '/v1/internal', '/v1//internal/telegram/intake', '/v1/%69nternal/telegram/intake',
      '/v1/./internal/telegram/intake', '/v1/x/../internal/telegram/intake']) {
      for (const method of ['GET', 'POST']) {
        const res = await get(p, { method });
        expect({ p, method, status: res.status, core: res.body.startsWith('core ') }).toEqual({ p, method, status: 404, core: false });
      }
    }
  }, 60_000);

  it('still proxies the office\'s API, webhooks and event stream to Core', async () => {
    for (const p of ['/v1/tasks', '/api/v1/tasks', '/api/webhooks/telegram', '/v1/events/stream', '/v1/auth/session', '/v1/internalise']) {
      const res = await get(p);
      expect({ p, status: res.status, body: res.body }).toEqual({ p, status: 200, body: `core ${p}` });
    }
    expect((await get('/')).body).toBe('desk');
  }, 60_000);

  it('the worker\'s own route, http://core:3001 on the compose network, is unaffected', () => {
    const r = docker(['run', '--rm', '--pull=never', '--network', tag, IMAGE, 'wget', '-qO-', 'http://core:3001/v1/internal/telegram/intake']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('core /v1/internal/telegram/intake');
  }, 60_000);

  it('a missing stored file answers 404 and leaves no query-string token in the error log', async () => {
    const res = await get(`/v1/tasks/t/canva/studio/r/candidates/c/preview.png?access_token=${SECRET}`);
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 500));
    const logs = docker(['logs', `${tag}-edge`]);
    const all = `${logs.stdout}\n${logs.stderr}`;
    // The access log masks the token; the error log would carry it whole.
    expect(all).toMatch(/access_token=\*\*\*/);
    expect(all.includes(SECRET)).toBe(false);
    expect(all).not.toMatch(/missing-file/);
  }, 60_000);
});
