import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/docker/nginx.conf's rate limits (audit 2026-09-30 P2, ADR-158).
 *
 * Every caller reaches nginx through Docker's port forwarding from one address, so the zones keyed on
 * $binary_remote_addr were a single bucket for the whole office (sign-in at 10 a minute for everyone),
 * and a refusal answered 503. Now: 429; Core's health is never limited; callers are told apart by
 * their session cookie or Authorization header before their address; a per-address ceiling remains.
 *
 * The file is read, checked with `nginx -t` in the production image, and served by that image with a
 * stub Core on a throwaway network (the harness of nginx-internal-boundary.test.ts). HAWA_NGINX_CONF
 * points it at another copy of the file (the red run used the one at 6bd479c1).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const confPath = process.env.HAWA_NGINX_CONF ? path.resolve(process.env.HAWA_NGINX_CONF) : path.join(repo, 'infra/docker/nginx.conf');
const conf = fs.readFileSync(confPath, 'utf8');

describe('nginx.conf rate limits, read', () => {
  it('answers a refusal with 429 and keys the API and sign-in zones on the caller, with an address ceiling', () => {
    expect(conf).toMatch(/^\s*limit_req_status 429;/m);
    expect(conf).toMatch(/limit_req_zone \$hawa_rate_key zone=api_limit:/);
    expect(conf).toMatch(/limit_req_zone \$hawa_rate_key zone=login_limit:/);
    expect(conf).toMatch(/map \$cookie_hawa_session \$hawa_rate_session/);
    expect(conf).toMatch(/limit_req_zone \$binary_remote_addr zone=api_edge:/);
    // The caller key is never written to a log.
    expect(conf).not.toMatch(/log_format[^;]*\$(hawa_rate|cookie_hawa_session|http_authorization)/);
  });
});

const IMAGE = 'nginx:1.27-alpine-slim';
const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
const dockerReady = docker(['image', 'inspect', IMAGE]).status === 0;

describe.skipIf(!dockerReady)('nginx.conf rate limits, served by the production image', () => {
  const tag = `hawa-nginx-limits-test-${randomBytes(4).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-nginx-limits-'));
  let base = '';

  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'core.conf'), 'events {}\nhttp { server { listen 3001; location / { default_type text/plain; return 200 "core $request_uri"; } } }\n');
    fs.writeFileSync(path.join(dir, 'desk.conf'), 'events {}\nhttp { server { listen 80; location / { return 200 "desk"; } } }\n');
    fs.copyFileSync(confPath, path.join(dir, 'nginx.conf'));
    fs.mkdirSync(path.join(dir, 'blobs'));
    for (const f of ['core.conf', 'desk.conf', 'nginx.conf']) fs.chmodSync(path.join(dir, f), 0o644);
    const must = (args: string[]) => {
      const r = docker(args);
      if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    must(['network', 'create', tag]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-core`, '--network', tag, '--network-alias', 'core', '-v', `${dir}/core.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-desk`, '--network', tag, '--network-alias', 'desk', '-v', `${dir}/desk.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-edge`, '--network', tag, '-p', '127.0.0.1::80',
      '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${dir}/blobs:/srv/hawa-blobs:ro`, IMAGE]);
    base = `http://127.0.0.1:${must(['port', `${tag}-edge`, '80/tcp']).split('\n')[0].split(':').pop()}`;
  }, 120_000);

  afterAll(() => {
    docker(['rm', '-f', `${tag}-edge`, `${tag}-core`, `${tag}-desk`]);
    docker(['network', 'rm', tag]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function statuses(p: string, count: number, headers: Record<string, string> = {}): Promise<number[]> {
    // Wait until the edge answers, then send all at once.
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) }); break; } catch (err) { if (i > 40) throw err; await new Promise((r) => setTimeout(r, 250)); }
    }
    return Promise.all(Array.from({ length: count }, () => fetch(base + p, { headers, signal: AbortSignal.timeout(10_000) }).then(async (r) => { await r.text(); return r.status; })));
  }
  const tally = (s: number[]) => s.reduce<Record<number, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

  it('passes nginx -t in the production image', () => {
    const r = docker(['run', '--rm', '--pull=never', '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, IMAGE, 'nginx', '-t']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('test is successful');
  }, 60_000);

  it('never limits Core\'s health, under any prefix', async () => {
    for (const p of ['/v1/health', '/api/v1/health', '/api/health']) {
      expect(tally(await statuses(p, 80)), p).toEqual({ 200: 80 });
    }
  }, 60_000);

  it('refuses a burst with 429, not 503, and gives each signed-in caller its own bucket', async () => {
    const a = tally(await statuses('/v1/tasks', 80, { Cookie: 'hawa_session=hawa_sess_caller_a' }));
    expect(a[429], JSON.stringify(a)).toBeGreaterThan(0);
    expect(a[503]).toBeUndefined();
    // Another office member, the same address: not refused because the first one was.
    expect(tally(await statuses('/v1/tasks', 5, { Cookie: 'hawa_session=hawa_sess_caller_b' }))).toEqual({ 200: 5 });
    expect(tally(await statuses('/v1/tasks', 5, { Authorization: 'Bearer caller-c' }))).toEqual({ 200: 5 });
  }, 60_000);

  it('lets the Desk ask for its session more than ten times a minute', async () => {
    expect(tally(await statuses('/v1/auth/session', 15, { Cookie: 'hawa_session=hawa_sess_caller_d' }))).toEqual({ 200: 15 });
  }, 60_000);
});
