import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  API_NOT_SERVED, DEFAULT_DESK, DESK_NOT_SERVED, FOREIGN_ORIGIN, WEBSITE_ORIGIN, parseArgs, report, verifyPublicGateway, type CheckResult,
} from '../verify_public_gateway.js';

/**
 * scripts/verify_public_gateway.ts (ADR-294) against local fake listeners: one that behaves as nginx's
 * public servers in front of Core do, and the same with one fault at a time, each of which must fail
 * exactly the check that names it. The real nginx behaviour is tested in
 * packages/testkit/test/nginx-public-gateway.test.ts; this file tests the verifier's judgement.
 */
type Fault = 'health_public' | 'cors_wildcard' | 'cors_foreign' | 'trusted_office' | 'callback_to_page' | 'session_open' | 'no_google'
  | 'internal_public' | 'preflight_missing_header' | 'html_refusal';
const ALLOW_HEADERS = 'Content-Type,X-Hawa-Office-Request,Authorization,Idempotency-Key,X-Content-SHA256,X-Photo-Filename,If-Match-Version';

function fake(kind: 'api' | 'desk', faults: Set<Fault>, seenHosts: string[]) {
  return http.createServer((req, res) => {
    seenHosts.push(req.headers.host ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html>404 Not Found</html>'); };
    if (kind === 'api') {
      if (faults.has('health_public') && url.pathname === '/v1/health') return json(200, { status: 'ok' });
      if (faults.has('internal_public') && url.pathname.startsWith('/v1/internal/')) return json(401, { title: 'Unauthorized' });
      if (!/^\/v1\/customer(?:\/[A-Za-z0-9_-]+)+$/.test(url.pathname)) return notFound();
      const allowed = origin === WEBSITE_ORIGIN || (faults.has('cors_foreign') && origin === FOREIGN_ORIGIN);
      const cors: Record<string, string> = faults.has('cors_wildcard') ? { 'Access-Control-Allow-Origin': '*' }
        : allowed && origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,DELETE,PATCH',
          'Access-Control-Allow-Headers': faults.has('preflight_missing_header') ? 'Content-Type,Authorization' : ALLOW_HEADERS });
        return res.end();
      }
      if (origin && !allowed) return json(403, { code: 'DESIGN_ORIGIN_DENIED' }, cors);
      if (url.pathname === '/v1/customer/session') {
        if (faults.has('session_open')) return json(200, { generationEnabled: false }, cors);
        if (faults.has('html_refusal')) { res.writeHead(401, { 'Content-Type': 'text/html', ...cors }); return res.end('<html>401</html>'); }
        return json(401, { code: 'WORKSPACE_SIGN_IN_REQUIRED' }, cors);
      }
      return json(401, { code: 'WORKSPACE_SIGN_IN_REQUIRED' }, cors);
    }
    // Desk host
    if (/^\/(?:api\/)?(?:v1\/)?internal(?:\/|$)/.test(url.pathname)) {
      if (faults.has('internal_public')) return json(401, { title: 'Unauthorized' });
      return notFound();
    }
    if (url.pathname.startsWith('/api/')) return notFound();
    const trusted = faults.has('trusted_office') && req.headers['x-hawa-office-proof'];
    if (url.pathname === '/v1/auth/providers') return json(200, { googleWorkspace: !faults.has('no_google'), trustedOffice: Boolean(trusted) });
    if (url.pathname === '/auth/google/callback' && !faults.has('callback_to_page')) return json(403, { title: 'Sign-In State Mismatch', status: 403 });
    if (url.pathname.startsWith('/v1/')) {
      if (trusted) return json(200, { authenticated: true });
      return json(401, { type: 'https://hawa.design/errors/401', title: 'Unauthorized', status: 401 });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Hawa Desk — Private Creative OS</title><div id="root"></div>');
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function run(faults: Fault[] = []): Promise<{ results: CheckResult[]; failed: string[] }> {
  const set = new Set(faults), hosts: string[] = [];
  const api = fake('api', set, hosts), desk = fake('desk', set, hosts);
  try {
    const results = await verifyPublicGateway({ api: { base: await listen(api) }, desk: { base: await listen(desk) }, allowHttp: true, timeoutMs: 5000 });
    return { results, failed: results.filter((r) => !r.ok).map((r) => r.name) };
  } finally { api.close(); desk.close(); }
}

describe('verify_public_gateway against fake listeners', () => {
  it('passes a gateway that serves exactly the customer API and a signed-in-only Desk', async () => {
    const { results, failed } = await run();
    expect(failed).toEqual([]);
    expect(results.filter((r) => r.skipped).map((r) => r.name)).toHaveLength(2); // TLS, plain HTTP allowed here only
    expect(results.length).toBe(2 + 5 + API_NOT_SERVED.length + 6 + DESK_NOT_SERVED.length);
    expect(report(results)).toMatch(/all \d+ checks passed$/);
  });

  const cases: [Fault, RegExp][] = [
    ['health_public', /^customer API: \/v1\/health is not served/],
    ['cors_wildcard', /hawzhin\.app (may read the refusal|is allowed)|evil\.example (is not allowed|is refused)/],
    ['cors_foreign', /evil\.example (is not allowed|is refused)/],
    ['trusted_office', /^Desk: (Google sign-in is offered|\/v1\/auth\/session|\/v1\/clients|\/v1\/tasks)/],
    ['callback_to_page', /Google's return address reaches Core/],
    ['session_open', /session without a token is refused|may read the refusal/],
    ['no_google', /Google sign-in is offered/],
    ['internal_public', /internal\/telegram\/intake is not served/],
    ['preflight_missing_header', /preflight from https:\/\/hawzhin\.app is allowed/],
    ['html_refusal', /session without a token is refused by Core/],
  ];
  for (const [fault, expected] of cases) {
    it(`fails on ${fault}`, async () => {
      const { failed, results } = await run([fault]);
      expect(failed.length, fault).toBeGreaterThan(0);
      for (const name of failed) expect(name, fault).toMatch(expected);
      expect(report(results)).toMatch(/checks FAILED$/);
    });
  }

  it('fails the TLS check when the target speaks no TLS, and refuses http:// unless allowed', async () => {
    const hosts: string[] = [];
    const api = fake('api', new Set(), hosts);
    const base = await listen(api);
    try {
      const tlsFailed = await verifyPublicGateway({ api: { base: base.replace('http:', 'https:') }, timeoutMs: 3000 });
      expect(tlsFailed[0]).toMatchObject({ name: expect.stringMatching(/^TLS /), ok: false });
      expect(tlsFailed[0].detail).toMatch(/TLS handshake failed|no TLS handshake/);
      const plain = await verifyPublicGateway({ api: { base }, timeoutMs: 3000 });
      expect(plain[0]).toMatchObject({ ok: false, detail: `${base} is not https://` });
    } finally { api.close(); }
  });
});

describe('arguments', () => {
  it('takes the API origin, the Desk by default, --desk and --no-desk', () => {
    expect(parseArgs(['https://design-api.hawzhin.app'])).toEqual({ api: { base: 'https://design-api.hawzhin.app' }, desk: { base: DEFAULT_DESK } });
    expect(parseArgs(['https://a.example', '--desk', 'https://d.example']).desk).toEqual({ base: 'https://d.example' });
    expect(parseArgs(['https://a.example', '--no-desk']).desk).toBeUndefined();
    expect(() => parseArgs([])).toThrow(/customer API base URL/);
    expect(() => parseArgs(['https://a.example/v1'])).toThrow(/origin only/);
    expect(() => parseArgs(['https://a.example', '--bogus'])).toThrow(/unknown argument/);
  });

  it('--local checks the loopback listeners under the public host names', () => {
    expect(parseArgs(['--local'], { HAWA_DESK_GATEWAY_PORT: '9082' })).toEqual({ allowHttp: true,
      api: { base: 'http://127.0.0.1:8081', host: 'design-api.hawzhin.app' }, desk: { base: 'http://127.0.0.1:9082', host: 'desk.hawzhin.app' } });
  });
});

describe('the command', () => {
  const hosts: string[] = [];
  let good: http.Server[] = [], bad: http.Server[] = [];
  const ports: Record<string, string> = {};
  beforeAll(async () => {
    good = [fake('api', new Set(), hosts), fake('desk', new Set(), hosts)];
    bad = [fake('api', new Set<Fault>(['health_public']), hosts), fake('desk', new Set(), hosts)];
    for (const [name, s] of [['ga', good[0]], ['gd', good[1]], ['ba', bad[0]], ['bd', bad[1]]] as const) ports[name] = new URL(await listen(s)).port;
  });
  afterAll(() => { for (const s of [...good, ...bad]) s.close(); });

  const cli = (env: Record<string, string>, args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/verify_public_gateway.ts'), ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => done({ code, out }));
  });

  it('exits 0 when every check passes, sending the public host names in --local mode', async () => {
    const r = await cli({ HAWA_CUSTOMER_GATEWAY_PORT: ports.ga, HAWA_DESK_GATEWAY_PORT: ports.gd }, ['--local']);
    expect(r.out).toMatch(/all \d+ checks passed/);
    expect(r.code).toBe(0);
    expect(new Set(hosts)).toEqual(new Set(['design-api.hawzhin.app', 'desk.hawzhin.app']));
  }, 30_000);

  it('exits 1 on any failure and 2 on bad usage', async () => {
    const r = await cli({ HAWA_CUSTOMER_GATEWAY_PORT: ports.ba, HAWA_DESK_GATEWAY_PORT: ports.bd }, ['--local']);
    expect(r.out).toMatch(/FAIL {2}customer API: \/v1\/health is not served/);
    expect(r.code).toBe(1);
    expect((await cli({}, [])).code).toBe(2);
  }, 30_000);
});
