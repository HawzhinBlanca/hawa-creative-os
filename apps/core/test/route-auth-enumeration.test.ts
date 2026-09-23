import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';

/**
 * Auth used to be tested route by route, by hand. POST /api/waha/kill-switch was registered straight
 * on the Hono app, outside the deny-by-default registrar, and answered anyone: 1,568 tests were
 * green with it open, because no test knew the route existed.
 *
 * This test asks the router what it serves instead. Every registered route is called with no
 * credentials, and must refuse unless it is listed below with the reason it is public. A new public
 * route fails here until someone writes that reason down.
 */

const PREFIXES = ['/api/v1', '/v1', '/api'];
const bare = (path: string) => {
  for (const p of PREFIXES) if (path === p || path.startsWith(`${p}/`)) return path.slice(p.length) || '/';
  return path;
};

/** Public on purpose. `statuses` are the only answers an anonymous caller may get. */
const PUBLIC: Array<{ method: string; path: RegExp; statuses: number[]; why: string }> = [
  { method: 'GET', path: /^\/health$/, statuses: [200, 503], why: 'container and nginx liveness probe' },
  { method: 'GET', path: /^\/ready$/, statuses: [200, 503], why: 'readiness probe' },
  { method: 'GET', path: /^\/waha\/health$/, statuses: [200, 503], why: 'adapter liveness probe' },
  { method: 'GET', path: /^\/system\/(studio-status|cutover\/status|funnel\/health)$/, statuses: [200, 503], why: 'watchdog reads these without a session' },
  { method: 'GET', path: /^\/adapters\/telegram\/status$/, statuses: [200, 503], why: 'watchdog reads this without a session' },
  { method: 'GET', path: /^\/fonts\/cdn\//, statuses: [200, 404], why: 'open-licence font files for the Desk' },
  { method: 'GET', path: /^\/auth\/session$/, statuses: [200, 401], why: 'reports whether the caller has a session' },
  { method: 'POST', path: /^\/auth\/session$/, statuses: [400, 401, 429], why: 'login: must be reachable to obtain a session' },
  { method: 'DELETE', path: /^\/auth\/session$/, statuses: [200, 204, 401], why: 'logout is a no-op without a session' },
  { method: 'POST', path: /^\/auth\/telegram-miniapp$/, statuses: [400, 401, 403, 503], why: 'login by Telegram init data; refuses without it' },
  { method: 'GET', path: /^\/integrations\/canva\/callback$/, statuses: [400, 401, 403], why: 'OAuth redirect from Canva; bound to a hashed single-use state and a cookie' },
  // Links sent to a reviewer's chat carry their own HMAC; without one they must refuse.
  { method: 'GET', path: /^\/webhooks\/whatsapp\/actions$/, statuses: [400, 401, 403], why: 'signed action link' },
  { method: 'POST', path: /^\/webhooks\/whatsapp\/actions$/, statuses: [400, 401, 403], why: 'signed action callback' },
  // Provider webhooks authenticate by shared secret or signature, configured below.
  { method: 'POST', path: /^\/webhooks\/(telegram|whatsapp)$/, statuses: [401, 403], why: 'provider webhook; secret required' },
  // A blinded-comparison judge has no account: the random token in the link is the credential, and
  // an unknown or revoked token answers 404 exactly like a path that does not exist.
  { method: 'GET', path: /^\/judge\/[^/]+(\/next|\/image\/[^/]+\/[^/]+)?$/, statuses: [404], why: "judge's link; its path token is the credential" },
  { method: 'POST', path: /^\/judge\/[^/]+\/judgments$/, statuses: [404], why: "judge's pick; its path token is the credential" },
];

const FIGMA_GONE = /figma/;

describe('every registered route refuses an anonymous caller unless it is declared public', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    // A fixture, assembled so the secret scanner does not have to be told to ignore it.
    process.env.WAHA_WEBHOOK_SECRET = ['enumeration', 'waha', 'fixture'].join('_');
    process.env.WAHA_KILL_SWITCH = 'false';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('enumerates the router and calls each route with no credentials', async () => {
    const app: any = createApp();
    const routes: Array<{ method: string; path: string }> = app.routes.filter((r: any) => r.method !== 'ALL');
    const unique = [...new Map(routes.map(r => [`${r.method} ${r.path}`, r])).values()];
    // If the router stops exposing its table this test would pass on nothing.
    expect(unique.length).toBeGreaterThan(300);

    const violations: string[] = [];
    for (const r of unique) {
      const url = r.path
        .replace(/:[A-Za-z_]+\{[^}]*\}|:[A-Za-z_]+/g, '00000000-0000-4000-8000-000000000001')
        .replace(/\*/g, 'x');
      const res = await app.request(url, {
        method: r.method,
        // x-enforce-auth switches off the harness shortcut that authenticates every request in a
        // database-less test app, so this exercises the same gate production runs.
        headers: { 'x-enforce-auth': 'true', 'content-type': 'application/json' },
        body: r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}',
      });
      if (res.status === 401 || res.status === 403) continue;

      const path = bare(r.path);
      // Decommissioned Figma transport: every verb answers 410 Gone and does nothing.
      if (FIGMA_GONE.test(path) && res.status === 410) continue;
      const rule = PUBLIC.find(p => p.method === r.method && p.path.test(path));
      if (rule && rule.statuses.includes(res.status)) continue;
      violations.push(`${r.method} ${r.path} -> ${res.status}${rule ? ` (public, but only ${rule.statuses.join('/')} allowed)` : ' (not declared public)'}`);
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it('would have caught the kill switch: an anonymous caller cannot change it', async () => {
    const app: any = createApp();
    const before = process.env.WAHA_KILL_SWITCH;
    const res = await app.request('/api/waha/kill-switch', {
      method: 'POST',
      headers: { 'x-enforce-auth': 'true', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect([401, 403]).toContain(res.status);
    expect(process.env.WAHA_KILL_SWITCH).toBe(before);
  });
});
