import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * infra/docker/nginx.conf's public listeners (ADR-294): 8081 for https://design-api.hawzhin.app (the
 * customer API only) and 8082 for https://desk.hawzhin.app (the Desk and its office API), which
 * cloudflared reaches on the host's loopback. The office listener (80, published as 127.0.0.1:8080)
 * must be unchanged.
 *
 * Read first, then served by the production image (nginx:1.27-alpine-slim, never pulled) with a stub
 * Core that echoes what it received, on a throwaway network, reached through a loopback-published
 * port exactly as cloudflared reaches it on the office Mac (the harness of
 * nginx-internal-boundary.test.ts). HAWA_NGINX_CONF points it at another copy of the file.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const confPath = process.env.HAWA_NGINX_CONF ? path.resolve(process.env.HAWA_NGINX_CONF) : path.join(repo, 'infra/docker/nginx.conf');
const conf = fs.readFileSync(confPath, 'utf8');
const compose = fs.readFileSync(path.join(repo, 'infra/docker/docker-compose.prod.yml'), 'utf8');

/** The body of the server block that listens on `port` and names `serverName`. */
function server(port: number, serverName: string): string {
  const re = new RegExp(`server \\{\\n\\s*listen ${port};\\n\\s*server_name ${serverName.replace(/\./g, '\\.')};`);
  const m = re.exec(conf);
  if (!m) return '';
  let depth = 0;
  for (let i = m.index + m[0].indexOf('{'); i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) return conf.slice(m.index, i + 1);
  }
  return '';
}

describe('public listeners, read', () => {
  const customer = server(8081, 'design-api.hawzhin.app');
  const desk = server(8082, 'desk.hawzhin.app');

  it('compose publishes both only on the host loopback, configurable, beside the unchanged office port', () => {
    expect(compose).toContain('"${HAWA_BIND_IP:-127.0.0.1}:${HAWA_PORT:-8080}:80"');
    expect(compose).toContain('"127.0.0.1:${HAWA_CUSTOMER_GATEWAY_PORT:-8081}:8081"');
    expect(compose).toContain('"127.0.0.1:${HAWA_DESK_GATEWAY_PORT:-8082}:8082"');
  });

  it('each public port has a catch-all default server that answers 404', () => {
    for (const port of [8081, 8082]) {
      expect(conf).toMatch(new RegExp(`server \\{\\n\\s*listen ${port} default_server;\\n\\s*server_name _;\\n[^}]*return 404;\\n\\s*\\}`));
    }
  });

  it('neither public server includes the office proof; both mark requests as public and take the Cloudflare address', () => {
    for (const [name, block, value] of [['customer', customer, 'customer'], ['desk', desk, 'desk']] as const) {
      expect(block, name).not.toBe('');
      expect(block, name).not.toMatch(/hawa-office-proof/);
      expect(block, name).toMatch(new RegExp(`proxy_set_header X-Hawa-Public-Gateway "${value}";`));
      expect(block, name).toMatch(/real_ip_header CF-Connecting-IP;/);
      expect(block, name).toMatch(/set_real_ip_from 127\.0\.0\.1;/);
      expect(block, name).not.toMatch(/proxy_add_x_forwarded_for/);
      // Every proxy header is set at server level: no location re-declares one and so drops the rest.
      const locations = block.slice(block.indexOf('\n        location '));
      expect(locations, name).not.toMatch(/proxy_set_header/);
    }
    // real_ip is scoped to the public servers: nothing before the first public server sets it.
    expect(conf.slice(0, conf.indexOf('listen 8081'))).not.toMatch(/real_ip_header|set_real_ip_from/);
  });

  it('the customer server forwards an allowlist of headers and proxies only /v1/customer/', () => {
    expect(customer).toMatch(/proxy_pass_request_headers off;/);
    expect(customer).toMatch(/client_max_body_size 12m;/);
    expect(customer.match(/proxy_pass /g)).toHaveLength(1);
    expect(customer).toMatch(/location \^~ \/v1\/customer\/ \{\n\s*if \(\$hawa_customer_uri_ok = 0\) \{\n\s*return 404;/);
  });
});

const IMAGE = 'nginx:1.27-alpine-slim';
const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
const dockerReady = docker(['image', 'inspect', IMAGE]).status === 0;

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

describe.skipIf(!dockerReady)('public listeners, served by the production image', () => {
  const tag = `hawa-nginx-public-test-${randomBytes(4).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-nginx-public-'));
  const PROOF = 'a'.repeat(64);
  const ports: Record<number, number> = {};

  // Each line is one header Core received, so the tests can see what nginx forwarded and dropped.
  const echo = ['uri=$request_uri', 'host=$http_host', 'gateway=$http_x_hawa_public_gateway', 'proof=$http_x_hawa_office_proof',
    'office_request=$http_x_hawa_office_request', 'xff=$http_x_forwarded_for', 'real_ip=$http_x_real_ip', 'proto=$http_x_forwarded_proto',
    'xfh=$http_x_forwarded_host', 'forwarded=$http_forwarded', 'cookie=$http_cookie', 'auth=$http_authorization', 'role=$http_x_user_role',
    'lifecycle=$http_x_hawa_lifecycle_proof', 'cf=$http_cf_connecting_ip', 'length=$http_content_length', 'type=$http_content_type',
    'origin=$http_origin', 'acrm=$http_access_control_request_method', 'idem=$http_idempotency_key', 'sha=$http_x_content_sha256',
    'filename=$http_x_photo_filename', 'rid=$http_x_request_id', 'method=$request_method'].join('\\n');
  const stubCore = `events {}
http {
  server {
    listen 3001;
    client_max_body_size 100m;
    location / { default_type text/plain; return 200 "core\\n${echo}\\n"; }
  }
}
`;

  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'core.conf'), stubCore);
    fs.writeFileSync(path.join(dir, 'desk.conf'), 'events {}\nhttp { server { listen 80; location / { default_type text/html; return 200 "desk $request_uri"; } } }\n');
    fs.copyFileSync(confPath, path.join(dir, 'nginx.conf'));
    fs.writeFileSync(path.join(dir, 'office-proof.conf'), `proxy_set_header X-Hawa-Office-Proof "${PROOF}";\n`, { mode: 0o644 });
    fs.mkdirSync(path.join(dir, 'blobs'));
    for (const f of ['core.conf', 'desk.conf', 'nginx.conf']) fs.chmodSync(path.join(dir, f), 0o644);
    fs.chmodSync(path.join(dir, 'blobs'), 0o755);
    const must = (args: string[]) => {
      const r = docker(args);
      if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    must(['network', 'create', tag]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-core`, '--network', tag, '--network-alias', 'core', '-v', `${dir}/core.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-desk`, '--network', tag, '--network-alias', 'desk', '-v', `${dir}/desk.conf:/etc/nginx/nginx.conf:ro`, IMAGE]);
    must(['run', '-d', '--pull=never', '--name', `${tag}-edge`, '--network', tag, '-p', '127.0.0.1::80', '-p', '127.0.0.1::8081', '-p', '127.0.0.1::8082',
      '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${dir}/office-proof.conf:/etc/nginx/hawa-office-proof.conf:ro`, '-v', `${dir}/blobs:/srv/hawa-blobs:ro`, IMAGE]);
    for (const port of [80, 8081, 8082]) ports[port] = Number(must(['port', `${tag}-edge`, `${port}/tcp`]).split('\n')[0].split(':').pop());
  }, 120_000);

  afterAll(() => {
    docker(['rm', '-f', `${tag}-edge`, `${tag}-core`, `${tag}-desk`]);
    docker(['network', 'rm', tag]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  /** One raw request (the path is sent exactly as written) to a listener; retried while nginx starts. */
  async function send(listener: 80 | 8081 | 8082, host: string, p: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await new Promise<Reply>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: ports[listener], path: p, method: init.method ?? 'GET',
            headers: { Host: host, ...init.headers, ...(init.body ? { 'Content-Length': String(init.body.length) } : {}) }, timeout: 10_000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.end(init.body);
        });
      } catch (err) {
        if (attempt >= 40) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  const seen = (body: string): Record<string, string> => Object.fromEntries(body.split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const API = 'design-api.hawzhin.app';
  const DESK = 'desk.hawzhin.app';
  const JOB = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const forged = {
    'X-Hawa-Office-Proof': PROOF, 'X-Hawa-Office-Request': '1', 'X-Forwarded-For': '9.9.9.9', 'X-Forwarded-Host': '127.0.0.1:8080',
    'X-Forwarded-Proto': 'http', Forwarded: 'for=9.9.9.9;host=127.0.0.1:8080', 'X-Real-IP': '9.9.9.9', 'X-User-Role': 'administrator',
    'X-Hawa-Lifecycle-Proof': 'forged', 'X-Hawa-Public-Gateway': 'none',
  };

  it('design-api proxies the customer API with only the customer headers, as a public request from the Cloudflare address', async () => {
    const res = await send(8081, API, '/v1/customer/session', { headers: { ...forged, 'CF-Connecting-IP': '203.0.113.7',
      Authorization: 'Bearer customer-jwt', Cookie: 'hawa_session=office-session', Origin: 'https://hawzhin.app', 'X-Request-Id': 'rid-1' } });
    expect(res.status).toBe(200);
    expect(res.body.startsWith('core\n')).toBe(true);
    expect(seen(res.body)).toMatchObject({
      uri: '/v1/customer/session', host: API, gateway: 'customer', proof: '', office_request: '', xff: '203.0.113.7', real_ip: '203.0.113.7',
      proto: 'https', xfh: '', forwarded: '', cookie: '', auth: 'Bearer customer-jwt', role: '', lifecycle: '', cf: '', origin: 'https://hawzhin.app', rid: 'rid-1',
    });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  }, 60_000);

  it('design-api forwards preflights and the photo upload headers, and admits a 10 MB photo but not 13 MB', async () => {
    const pre = await send(8081, API, '/v1/customer/jobs', { method: 'OPTIONS', headers: { Origin: 'https://hawzhin.app',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
    expect(seen(pre.body)).toMatchObject({ method: 'OPTIONS', origin: 'https://hawzhin.app', acrm: 'POST' });
    const photo = Buffer.alloc(10 * 1024 * 1024 + 7, 1);
    const up = await send(8081, API, `/v1/customer/clients/${JOB}/photos`, { method: 'POST', body: photo, headers: {
      'CF-Connecting-IP': '203.0.113.8', Authorization: 'Bearer t', 'Content-Type': 'image/jpeg', 'Idempotency-Key': 'photo-key-1',
      'X-Content-SHA256': 'b'.repeat(64), 'X-Photo-Filename': 'portrait.jpg' } });
    expect(up.status).toBe(200);
    expect(seen(up.body)).toMatchObject({ method: 'POST', length: String(photo.length), type: 'image/jpeg', idem: 'photo-key-1', sha: 'b'.repeat(64), filename: 'portrait.jpg' });
    const big = await send(8081, API, `/v1/customer/clients/${JOB}/photos`, { method: 'POST', body: Buffer.alloc(13 * 1024 * 1024, 1),
      headers: { 'CF-Connecting-IP': '203.0.113.8', 'Content-Type': 'image/jpeg' } });
    expect(big.status).toBe(413);
    const preview = await send(8081, API, `/v1/customer/jobs/${JOB}/preview/${JOB}?version=3&sha256=${'c'.repeat(64)}`);
    expect(seen(preview.body).uri).toBe(`/v1/customer/jobs/${JOB}/preview/${JOB}?version=3&sha256=${'c'.repeat(64)}`);
  }, 60_000);

  it('design-api answers 404 itself for everything that is not a plain customer path', async () => {
    for (const p of ['/', '/v1/health', '/api/v1/health', '/health', '/ready', '/v1/internal/telegram/intake', '/api/', '/api/webhooks/telegram',
      '/v1/tasks', '/v1/auth/session', '/v1/office/customer-accounts', '/auth/google/callback', '/v1/customer', '/v1/customerx/session',
      '/v1/customer/%2e%2e/tasks', '/v1/customer/../tasks', '/v1/customer/./session', '/v1/customer//session', '/v1/customer/%73ession',
      '/v1/customer/session.json', '/V1/customer/session', '/_blobs/sha256/ab/x', '/studio']) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const res = await send(8081, API, p, { method });
        expect({ p, method, status: res.status, core: res.body.startsWith('core') }).toEqual({ p, method, status: 404, core: false });
      }
    }
  }, 120_000);

  it('neither public port answers for another host name, the office one included', async () => {
    for (const host of ['127.0.0.1:8080', 'localhost', 'hawzhin.app', 'evil.example', DESK]) {
      expect((await send(8081, host, '/v1/customer/session')).status, host).toBe(404);
    }
    for (const host of ['127.0.0.1:8080', 'localhost', API, 'evil.example']) {
      for (const p of ['/', '/v1/tasks']) expect((await send(8082, host, p)).status, `${host}${p}`).toBe(404);
    }
  }, 60_000);

  it('desk serves the Desk and its office API as public requests, without the office proof or office headers', async () => {
    const page = await send(8082, DESK, '/', { headers: { 'CF-Connecting-IP': '198.51.100.4' } });
    expect(page).toMatchObject({ status: 200, body: 'desk /' });
    const api = await send(8082, DESK, '/v1/tasks', { headers: { ...forged, 'CF-Connecting-IP': '198.51.100.4',
      Authorization: 'Bearer office', Cookie: 'hawa_session=s; hawa_csrf=c', 'X-Hawa-Csrf': 'c' } });
    expect(api.status).toBe(200);
    expect(seen(api.body)).toMatchObject({ uri: '/v1/tasks', host: DESK, gateway: 'desk', proof: '', office_request: '', xff: '198.51.100.4',
      real_ip: '198.51.100.4', proto: 'https', xfh: '', forwarded: '', role: '', lifecycle: '', cf: '', auth: 'Bearer office', cookie: 'hawa_session=s; hawa_csrf=c' });
    for (const p of ['/v1/health', '/v1/auth/session', '/v1/auth/providers', '/v1/auth/google/start', '/auth/google/callback?state=x&code=y',
      '/v1/events/stream?ticket=t', '/v1/integrations/canva/callback?state=s&code=c', '/v1/customer/session']) {
      const res = await send(8082, DESK, p, { headers: forged });
      expect({ p, status: res.status, core: res.body.startsWith('core\n'), gateway: seen(res.body).gateway, proof: seen(res.body).proof })
        .toEqual({ p, status: 200, core: true, gateway: 'desk', proof: '' });
    }
  }, 60_000);

  it('desk does not serve the worker address, webhooks, judge links or health under other prefixes', async () => {
    for (const p of ['/v1/internal/telegram/intake', '/api/v1/internal/x', '/v1/%69nternal/x', '/v1/x/../internal/x', '/api/webhooks/telegram',
      '/api/judge/abc', '/api/v1/health', '/api/health', '/api/v1/tasks', '/studio']) {
      for (const method of ['GET', 'POST']) {
        const res = await send(8082, DESK, p, { method });
        expect({ p, method, status: res.status, core: res.body.startsWith('core') }).toEqual({ p, method, status: 404, core: false });
      }
    }
  }, 60_000);

  it('the office listener is unchanged: it adds the office proof and no public-gateway header', async () => {
    const res = await send(80, '127.0.0.1:8080', '/v1/tasks', { headers: { 'X-Hawa-Office-Proof': 'forged' } });
    expect(seen(res.body)).toMatchObject({ host: '127.0.0.1:8080', proof: PROOF, gateway: '' });
    expect((await send(80, '127.0.0.1:8080', '/v1/health')).status).toBe(200);
  }, 60_000);

  it('rate limits count each Cloudflare address separately, never the X-Forwarded-For a caller sends', async () => {
    // api_limit (30 r/s, burst 20) is keyed on the address when no credential is sent.
    const burst = await Promise.all(Array.from({ length: 60 }, () => send(8081, API, '/v1/customer/session', { headers: { 'CF-Connecting-IP': '203.0.113.50' } })));
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    const other = await Promise.all(Array.from({ length: 5 }, () => send(8081, API, '/v1/customer/session', { headers: { 'CF-Connecting-IP': '203.0.113.51' } })));
    expect(other.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // Without CF-Connecting-IP a caller's own X-Forwarded-For is not taken as its address.
    const spoof = await send(8081, API, '/v1/customer/session', { headers: { 'X-Forwarded-For': '203.0.113.99', 'X-Real-IP': '203.0.113.99' } });
    expect(seen(spoof.body).real_ip).not.toBe('203.0.113.99');
    expect(seen(spoof.body).xff).toBe(seen(spoof.body).real_ip);
    await new Promise((r) => setTimeout(r, 300));
    const logs = docker(['logs', `${tag}-edge`]);
    expect(logs.stdout).toMatch(/^203\.0\.113\.51 - /m);
  }, 60_000);
});
