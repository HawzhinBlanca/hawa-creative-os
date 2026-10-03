/**
 * Checks the public gateway from outside (ADR-294, runbooks/GO_LIVE_WEBSITE.md): the customer API at
 * https://design-api.hawzhin.app and the Desk at https://desk.hawzhin.app, as Cloudflare serves them
 * through the office Mac's tunnel. Read-only: every request is a GET or a CORS preflight without a
 * credential, so nothing is created, paid for or changed (the forged office proof it sends is random).
 *
 *   tsx scripts/verify_public_gateway.ts https://design-api.hawzhin.app [--desk https://desk.hawzhin.app] [--no-desk]
 *   tsx scripts/verify_public_gateway.ts --local      # the loopback listeners, before the tunnel exists
 *
 * --local sends to http://127.0.0.1:8081 and :8082 (or HAWA_CUSTOMER_GATEWAY_PORT / HAWA_DESK_GATEWAY_PORT)
 * with the public host names, and skips the TLS checks. Exits 1 if any check fails, 2 on bad usage.
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

export const WEBSITE_ORIGIN = 'https://hawzhin.app';
export const FOREIGN_ORIGIN = 'https://evil.example';
export const DEFAULT_API = 'https://design-api.hawzhin.app';
export const DEFAULT_DESK = 'https://desk.hawzhin.app';

/** A listener to check: its base URL and, when it is reached by address, the host name to send. */
export interface GatewayTarget { base: string; host?: string }
export interface VerifyOptions {
  api: GatewayTarget;
  desk?: GatewayTarget;
  websiteOrigin?: string;
  /** http:// targets are accepted (TLS checks are reported as skipped). Only for --local and tests. */
  allowHttp?: boolean;
  timeoutMs?: number;
  /** Fewer days of certificate validity than this fails the TLS check. */
  minCertificateDays?: number;
}
export interface CheckResult { name: string; ok: boolean; skipped?: boolean; detail: string }
export interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request, exactly as given (no redirects followed, no credentials, certificate verified). */
export function request(target: GatewayTarget, path: string, init: { method?: string; headers?: Record<string, string> } = {},
  timeoutMs = 10_000): Promise<Reply> {
  const url = new URL(path, target.base);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: init.method ?? 'GET', timeout: timeoutMs, rejectUnauthorized: true,
      headers: { 'User-Agent': 'hawa-verify-public-gateway/1', Accept: 'application/json, text/html;q=0.9', ...(target.host ? { Host: target.host } : {}), ...init.headers } },
    (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size <= 1_000_000) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** The certificate a TLS client sees for the target's host name: verified chain, days left. */
export function tlsCheck(target: GatewayTarget, minDays: number, timeoutMs = 10_000): Promise<CheckResult> {
  const url = new URL(target.base);
  const name = `TLS ${url.host}`;
  return new Promise((resolve) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: target.host ?? url.hostname, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (r: CheckResult) => { socket.destroy(); resolve(r); };
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const days = cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : NaN;
      if (!socket.authorized) return done({ name, ok: false, detail: `certificate not trusted: ${socket.authorizationError}` });
      if (!(days >= minDays)) return done({ name, ok: false, detail: `certificate expires in ${days} day(s) (minimum ${minDays})` });
      done({ name, ok: true, detail: `trusted certificate for ${target.host ?? url.hostname}, ${days} days left, ${socket.getProtocol()}` });
    });
    socket.on('timeout', () => done({ name, ok: false, detail: `no TLS handshake within ${timeoutMs} ms` }));
    socket.on('error', (err) => done({ name, ok: false, detail: `TLS handshake failed: ${err.message}` }));
  });
}

const header = (r: Reply, name: string): string => {
  const v = r.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v ?? '';
};
const listOf = (value: string) => value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const jsonOf = (r: Reply): Record<string, unknown> | null => {
  if (!/json/i.test(header(r, 'content-type'))) return null;
  try { const v = JSON.parse(r.body); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
/** A refusal Core wrote: JSON naming a code (customer API) or a problem title (office API). */
const isCoreRefusal = (r: Reply) => { const j = jsonOf(r); return Boolean(j && (typeof j.code === 'string' || typeof j.title === 'string')); };
const brief = (r: Reply) => `${r.status} ${header(r, 'content-type') || 'no content type'} ${r.body.slice(0, 120).replace(/\s+/g, ' ')}`;

/** Paths the customer host must answer 404 itself (nothing but /v1/customer/* is served there). */
export const API_NOT_SERVED = ['/', '/v1/health', '/api/v1/health', '/ready', '/v1/internal/telegram/intake', '/api/', '/api/webhooks/telegram',
  '/v1/tasks', '/v1/auth/session', '/v1/office/customer-accounts', '/v1/customer/%2e%2e/tasks'];
/** Paths the Desk host must answer 404 itself. */
export const DESK_NOT_SERVED = ['/v1/internal/telegram/intake', '/api/v1/internal/telegram/intake', '/api/webhooks/telegram', '/api/v1/health'];
/** Headers the website sends to the customer API (apps/core/src/app.ts CORS allowHeaders). */
export const WEBSITE_REQUEST_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'x-content-sha256', 'x-photo-filename'];

export async function verifyPublicGateway(options: VerifyOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const timeout = options.timeoutMs ?? 10_000;
  const website = options.websiteOrigin ?? WEBSITE_ORIGIN;
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try { results.push({ name, ...(await run()) }); }
    catch (err) { results.push({ name, ok: false, detail: `request failed: ${(err as Error).message}` }); }
  };
  const send = (t: GatewayTarget, p: string, init: { method?: string; headers?: Record<string, string> } = {}) => request(t, p, init, timeout);

  for (const target of [options.api, ...(options.desk ? [options.desk] : [])]) {
    const url = new URL(target.base);
    if (url.protocol === 'https:') results.push(await tlsCheck(target, options.minCertificateDays ?? 7, timeout));
    else if (options.allowHttp) results.push({ name: `TLS ${url.host}`, ok: true, skipped: true, detail: 'skipped: plain HTTP allowed for a local check' });
    else results.push({ name: `TLS ${url.host}`, ok: false, detail: `${target.base} is not https://` });
  }

  const api = options.api;
  await check('customer API: session without a token is refused by Core', async () => {
    const r = await send(api, '/v1/customer/session');
    return { ok: (r.status === 401 || r.status === 403) && isCoreRefusal(r), detail: brief(r) };
  });
  await check(`customer API: ${website} may read the refusal (CORS)`, async () => {
    const r = await send(api, '/v1/customer/session', { headers: { Origin: website } });
    const allow = header(r, 'access-control-allow-origin');
    return { ok: (r.status === 401 || r.status === 403) && allow === website, detail: `${r.status}, Access-Control-Allow-Origin: ${allow || '(none)'}` };
  });
  await check(`customer API: preflight from ${website} is allowed`, async () => {
    const r = await send(api, '/v1/customer/jobs', { method: 'OPTIONS', headers: { Origin: website,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': WEBSITE_REQUEST_HEADERS.join(',') } });
    const allow = header(r, 'access-control-allow-origin');
    const methods = listOf(header(r, 'access-control-allow-methods'));
    const headers = listOf(header(r, 'access-control-allow-headers'));
    const missing = WEBSITE_REQUEST_HEADERS.filter((h) => !headers.includes(h));
    const ok = r.status >= 200 && r.status < 300 && allow === website && methods.includes('post') && methods.includes('get') && !missing.length;
    return { ok, detail: `${r.status}, origin ${allow || '(none)'}, methods ${methods.join(' ') || '(none)'}${missing.length ? `, missing headers ${missing.join(' ')}` : ''}` };
  });
  await check(`customer API: preflight from ${FOREIGN_ORIGIN} is not allowed`, async () => {
    const r = await send(api, '/v1/customer/jobs', { method: 'OPTIONS', headers: { Origin: FOREIGN_ORIGIN,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    const allow = header(r, 'access-control-allow-origin');
    return { ok: allow !== FOREIGN_ORIGIN && allow !== '*' && header(r, 'access-control-allow-credentials') !== 'true',
      detail: `${r.status}, Access-Control-Allow-Origin: ${allow || '(none)'}` };
  });
  await check(`customer API: a request from ${FOREIGN_ORIGIN} is refused`, async () => {
    const r = await send(api, '/v1/customer/session', { headers: { Origin: FOREIGN_ORIGIN } });
    const allow = header(r, 'access-control-allow-origin');
    return { ok: r.status === 403 && allow !== FOREIGN_ORIGIN && allow !== '*', detail: brief(r) };
  });
  for (const p of API_NOT_SERVED) {
    await check(`customer API: ${p} is not served (404)`, async () => {
      const r = await send(api, p);
      return { ok: r.status === 404, detail: brief(r) };
    });
  }

  const desk = options.desk;
  if (desk) {
    const forged = { 'X-Hawa-Office-Proof': randomBytes(32).toString('hex'), 'X-Hawa-Office-Request': '1', Origin: new URL(desk.base).origin,
      'X-Forwarded-Host': '127.0.0.1:8080', 'X-Forwarded-For': '127.0.0.1' };
    await check('Desk: the page loads', async () => {
      const r = await send(desk, '/');
      return { ok: r.status === 200 && /text\/html/i.test(header(r, 'content-type')) && /Hawa Desk/.test(r.body), detail: `${r.status} ${header(r, 'content-type')}` };
    });
    await check('Desk: Google sign-in is offered and trusted-office access is not', async () => {
      const r = await send(desk, '/v1/auth/providers', { headers: forged });
      const j = jsonOf(r);
      return { ok: r.status === 200 && j?.trustedOffice === false && j?.googleWorkspace === true, detail: `${r.status} ${r.body.slice(0, 120)}` };
    });
    for (const p of ['/v1/auth/session', '/v1/clients', '/v1/tasks']) {
      await check(`Desk: ${p} with forged office headers needs sign-in (401)`, async () => {
        const r = await send(desk, p, { headers: forged });
        return { ok: r.status === 401 && isCoreRefusal(r), detail: brief(r) };
      });
    }
    await check('Desk: Google\'s return address reaches Core, not the page', async () => {
      // No state: Core refuses before reading anything (Sign-In State Mismatch) and changes nothing.
      const r = await send(desk, '/auth/google/callback');
      return { ok: r.status === 403 && isCoreRefusal(r), detail: brief(r) };
    });
    for (const p of DESK_NOT_SERVED) {
      await check(`Desk: ${p} is not served (404)`, async () => {
        const r = await send(desk, p);
        return { ok: r.status === 404, detail: brief(r) };
      });
    }
  }
  return results;
}

export function report(results: CheckResult[]): string {
  const lines = results.map((r) => `${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
  return lines.join('\n');
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): VerifyOptions {
  let api: GatewayTarget | undefined;
  let desk: GatewayTarget | undefined = { base: DEFAULT_DESK };
  let local = false, noDesk = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') local = true;
    else if (a === '--no-desk') noDesk = true;
    else if (a === '--desk') { const v = argv[++i]; if (!v) throw new Error('--desk needs a URL'); desk = { base: v }; }
    else if (!a.startsWith('--') && !api) api = { base: a };
    else throw new Error(`unknown argument ${a}`);
  }
  if (local) {
    const apiPort = env.HAWA_CUSTOMER_GATEWAY_PORT || '8081', deskPort = env.HAWA_DESK_GATEWAY_PORT || '8082';
    return { api: { base: `http://127.0.0.1:${apiPort}`, host: new URL(DEFAULT_API).host },
      desk: noDesk ? undefined : { base: `http://127.0.0.1:${deskPort}`, host: new URL(DEFAULT_DESK).host }, allowHttp: true };
  }
  if (!api) throw new Error('give the customer API base URL, e.g. https://design-api.hawzhin.app, or --local');
  for (const t of [api, ...(desk && !noDesk ? [desk] : [])]) {
    const u = new URL(t.base);
    if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${t.base}: give the origin only`);
  }
  return { api, desk: noDesk ? undefined : desk };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options: VerifyOptions;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`${(err as Error).message}\nusage: verify_public_gateway.ts <customer API origin> [--desk <origin>] [--no-desk] | --local`); process.exit(2); }
  const results = await verifyPublicGateway(options);
  console.log(report(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
